/**
 * The settings window's main-process half (issue M9-02 / #39).
 *
 * These assert the decisions, not the plumbing: which senders are honoured, what a rebind does
 * before it writes anything, what changing the monitor does to a region drawn on the old one, and
 * that every route which can change the answer republishes it. The window itself is exercised in a
 * real Electron run - what is only testable here is the reasoning.
 */

import { describe, expect, it, vi } from 'vitest';

import { SettingsIpc, type IpcHost, type SettingsIpcOptions } from '../../src/main/ipc-handlers.js';
import type { AppStatus } from '../../src/main/services/app-orchestrator.js';
import type { ConfigIssue, ConfigSetResult } from '../../src/main/services/config.js';
import type { Alert } from '../../src/main/services/error-reporter.js';
import type { HotkeyProbe, HotkeyRegistration } from '../../src/main/services/hotkey-service.js';
import type { MonitorChoice } from '../../src/main/services/monitor-service.js';
import type { SettingsState } from '../../src/renderer/settings/contract.js';
import {
  DEFAULT_CONFIG,
  configSchema,
  type Config,
  type ConfigOverride,
} from '../../src/shared/config-schema.js';

const SETTINGS_SENDER = 7;
const OVERLAY_SENDER = 9;

interface Rig {
  /** Assigned immediately after construction - the fakes below close over the rig itself. */
  ipc: SettingsIpc;
  readonly handlers: Map<string, (senderId: number, payload: unknown) => Promise<unknown>>;
  readonly pushed: SettingsState[];
  readonly writes: ConfigOverride[];
  readonly probed: string[];
  readonly commands: string[];
  config: Config;
  issues: readonly ConfigIssue[];
  registrations: readonly HotkeyRegistration[];
  probeResult: HotkeyProbe;
  monitors: readonly MonitorChoice[];
  status: AppStatus;
  alert: Alert | null;
  /** Set by `set` to refuse a write, standing in for a value that fails the schema. */
  reject: ConfigSetResult | null;
}

function rig(overrides: Partial<SettingsIpcOptions> = {}): Rig {
  const handlers = new Map<string, (senderId: number, payload: unknown) => Promise<unknown>>();
  const pushed: SettingsState[] = [];
  const writes: ConfigOverride[] = [];
  const probed: string[] = [];
  const commands: string[] = [];

  const host: IpcHost = {
    handle: (channel, handler) => {
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
    send: (_channel, message) => {
      pushed.push(message);
      return true;
    },
  };

  const state: Rig = {
    ipc: undefined as unknown as SettingsIpc,
    handlers,
    pushed,
    writes,
    probed,
    commands,
    config: DEFAULT_CONFIG,
    issues: [],
    registrations: [],
    probeResult: { ok: true },
    monitors: [],
    status: { mode: 'idle', overlayVisible: true, error: null, warning: null },
    alert: null,
    reject: null,
  };

  const ipc = new SettingsIpc({
    host,
    config: {
      get current() {
        return state.config;
      },
      filePath: 'C:\\users\\test\\config.json',
      get issues() {
        return state.issues;
      },
      set: async (change) => {
        writes.push(change);
        if (state.reject !== null) return await Promise.resolve(state.reject);
        // Behaves like the real service: merge, validate, adopt.
        const merged = configSchema.safeParse({
          ...state.config,
          capture: { ...state.config.capture, ...change.capture },
          hotkeys: { ...state.config.hotkeys, ...change.hotkeys },
          render: { ...state.config.render, ...change.render },
          stability: { ...state.config.stability, ...change.stability },
        });
        if (!merged.success) return { applied: false, persisted: false, errors: [] };
        state.config = merged.data;
        return await Promise.resolve({ applied: true, persisted: true, errors: [] });
      },
      reload: async () => {
        commands.push('reload');
        await Promise.resolve();
      },
    },
    modes: {
      get status() {
        return state.status;
      },
      selectRegion: async () => {
        commands.push('selectRegion');
        await Promise.resolve();
      },
      toggleAuto: () => commands.push('toggleAuto'),
      snapshot: () => commands.push('snapshot'),
      toggleOverlay: () => commands.push('toggleOverlay'),
    },
    hotkeys: {
      get registrations() {
        return state.registrations;
      },
      probe: (accelerator) => {
        probed.push(accelerator);
        return state.probeResult;
      },
    },
    monitors: {
      get choices() {
        return state.monitors;
      },
    },
    sidecar: {
      get status() {
        return { state: 'running', reason: 'initial', retryAtMs: null };
      },
      retry: () => commands.push('restartSidecar'),
    },
    alert: () => state.alert,
    engines: ['google'],
    srcLang: 'en',
    tgtLang: 'th',
    versions: { electron: '43.4.0', chrome: '000', node: '24.18.1' },
    isTrustedSender: (senderId) => senderId === SETTINGS_SENDER,
    ...overrides,
  });

  state.ipc = ipc;
  ipc.register();
  return state;
}

// ---------------------------------------------------------------------------

describe('SettingsIpc: who is allowed to speak', () => {
  it('refuses every channel from a window that is not the settings window', async () => {
    // Every window in this app loads one preload, so a key on `window` proves only which script
    // ran. These channels write config and open windows; the sender check is the authorisation.
    const r = rig();

    for (const [channel, payload] of [
      ['textlens:settings-request', undefined],
      ['textlens:settings-config', { render: { fontSize: 40 } }],
      ['textlens:settings-hotkey', { action: 'snapshot', accelerator: 'Control+Alt+J' }],
      ['textlens:settings-command', 'selectRegion'],
    ] as const) {
      const handler = r.handlers.get(channel);
      expect(handler).toBeDefined();
      await handler?.(OVERLAY_SENDER, payload);
    }

    expect(r.writes).toEqual([]);
    expect(r.commands).toEqual([]);
    expect(r.config.render.fontSize).toBe(DEFAULT_CONFIG.render.fontSize);
  });

  it('honours the same messages from the settings window', async () => {
    const r = rig();
    const handler = r.handlers.get('textlens:settings-config');
    await handler?.(SETTINGS_SENDER, { render: { fontSize: 40 } });

    expect(r.config.render.fontSize).toBe(40);
  });

  it('re-reads the sender each time, so a reopened window is judged on what is true now', async () => {
    // A captured id keeps authorising a `webContents` that no longer exists - or one whose id has
    // been reused by something else.
    let trusted = 99;
    const r = rig({ isTrustedSender: (senderId) => senderId === trusted });
    const handler = r.handlers.get('textlens:settings-config');

    await handler?.(SETTINGS_SENDER, { render: { fontSize: 40 } });
    expect(r.config.render.fontSize).toBe(DEFAULT_CONFIG.render.fontSize);

    trusted = SETTINGS_SENDER;
    await handler?.(SETTINGS_SENDER, { render: { fontSize: 40 } });
    expect(r.config.render.fontSize).toBe(40);
  });

  it('drops its handlers on dispose, so a relaunch does not find the channel taken', () => {
    const r = rig();
    expect(r.handlers.size).toBe(4);
    r.ipc.dispose();
    expect(r.handlers.size).toBe(0);
  });
});

describe('SettingsIpc: the state the window renders', () => {
  it('carries the config, the file path and the issues that stopped it applying', () => {
    const r = rig();
    r.issues = [
      { kind: 'invalid', message: 'config file has invalid values', fields: [{ path: 'capture.intervalActive', message: 'too small' }] },
    ];

    const state = r.ipc.state;
    expect(state.configPath).toBe('C:\\users\\test\\config.json');
    expect(state.issues[0]?.kind).toBe('invalid');
    // The field path is what turns "check your config" into a line to go and fix - #38's stated
    // reopen signal was that this reached the log and a getter only.
    expect(state.issues[0]?.fields[0]?.path).toBe('capture.intervalActive');
  });

  it('lists every monitor the app can actually place boxes on', () => {
    const r = rig();
    r.monitors = [
      { id: '\\\\.\\DISPLAY1', label: 'Acme 24', width: 1920, height: 1080, scaleFactor: 1, primary: true },
      { id: '\\\\.\\DISPLAY2', label: 'Dell', width: 3440, height: 1440, scaleFactor: 1.25, primary: false },
    ];

    expect(r.ipc.state.monitors.map((monitor) => monitor.id)).toEqual(['\\\\.\\DISPLAY1', '\\\\.\\DISPLAY2']);
    expect(r.ipc.state.monitors[1]?.scaleFactor).toBe(1.25);
  });

  it('shows a row for every action even before the hotkey service has registered anything', () => {
    // A row that disappears reads as a feature that does not exist. Before `startHotkeys` has run
    // there are no registrations, and the honest thing to show is the key config holds, unbound.
    const r = rig();
    const rows = r.ipc.state.hotkeys;

    expect(rows.map((row) => row.action)).toEqual([
      'toggleAuto',
      'snapshot',
      'selectRegion',
      'toggleOverlay',
      'dismiss',
    ]);
    expect(rows.every((row) => !row.ok)).toBe(true);
    expect(rows[2]?.accelerator).toBe('Control+Alt+R');
  });

  it('carries the real registration outcome once there is one, conflict reason included', () => {
    const r = rig();
    r.registrations = [
      { action: 'toggleAuto', accelerator: 'Control+Alt+A', ok: true },
      { action: 'snapshot', accelerator: 'Control+Alt+S', ok: true },
      // The one that has failed on this project's development machine every run.
      { action: 'selectRegion', accelerator: 'Control+Alt+R', ok: false, reason: 'conflict' },
      { action: 'toggleOverlay', accelerator: null, ok: false, reason: 'disabled' },
    ];

    const rows = r.ipc.state.hotkeys;
    expect(rows[2]).toMatchObject({ accelerator: 'Control+Alt+R', ok: false, reason: 'conflict' });
    expect(rows[3]).toMatchObject({ accelerator: null, reason: 'disabled' });
  });

  it('reports whether a region has been chosen, which is what drives the first-run prompt', () => {
    const r = rig();
    expect(r.ipc.state.hasRegion).toBe(false);

    r.config = {
      ...DEFAULT_CONFIG,
      capture: {
        ...DEFAULT_CONFIG.capture,
        region: { rect: [10, 10, 800, 200], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] },
      },
    };
    expect(r.ipc.state.hasRegion).toBe(true);
  });

  it('reads the alert at publish time rather than caching it', () => {
    // `ErrorReporter` only notifies when the *top* alert changes, so a cached copy is wrong for
    // every alert that arrives underneath an existing one - the bug `renderStatus` records.
    const r = rig();
    expect(r.ipc.state.alert).toBeNull();

    r.alert = { source: 'ocr', severity: 'fatal', cause: 'no recognizer', remedy: 'install it' };
    expect(r.ipc.state.alert).toEqual({ severity: 'fatal', cause: 'no recognizer', remedy: 'install it' });
  });
});

describe('SettingsIpc: changing a value', () => {
  it('applies a change and pushes the new state so the window cannot show a stale value', async () => {
    const r = rig();
    const result = await r.ipc.setConfig({ render: { fontSize: 32 } });

    expect(result).toMatchObject({ applied: true, persisted: true });
    expect(r.config.render.fontSize).toBe(32);
    expect(r.pushed.at(-1)?.config.render.fontSize).toBe(32);
  });

  it('returns the offending field path when a value is refused, and changes nothing', async () => {
    // One validator, not two: the window puts this message beside the control rather than
    // re-implementing the schema.
    const r = rig();
    r.reject = {
      applied: false,
      persisted: false,
      errors: [{ path: 'capture.intervalActive', message: 'Too small: expected number to be >0' }],
    };

    const result = await r.ipc.setConfig({ capture: { intervalActive: -5 } });

    expect(result.applied).toBe(false);
    expect(result.errors[0]?.path).toBe('capture.intervalActive');
    expect(r.config.capture.intervalActive).toBe(DEFAULT_CONFIG.capture.intervalActive);
  });

  it('reports a change that is live but was not written to disk', async () => {
    const r = rig();
    r.reject = { applied: true, persisted: false, errors: [] };

    const result = await r.ipc.setConfig({ render: { opacity: 0.5 } });

    expect(result).toMatchObject({ applied: true, persisted: false });
  });
});

describe('SettingsIpc: choosing a monitor', () => {
  it('drops the saved region with the monitor it was drawn on', async () => {
    // The mutation this guards: keep the region, and `AppOrchestrator` sees a region naming a
    // different monitor, logs it, and captures the *whole* target screen - which is the #51 state
    // arriving by the back door with nothing on screen to say so.
    const r = rig();
    r.config = {
      ...DEFAULT_CONFIG,
      capture: {
        ...DEFAULT_CONFIG.capture,
        monitorId: '\\\\.\\DISPLAY1',
        region: { rect: [10, 10, 800, 200], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] },
      },
    };

    await r.ipc.setConfig({ capture: { monitorId: '\\\\.\\DISPLAY2', region: null } });

    expect(r.config.capture.monitorId).toBe('\\\\.\\DISPLAY2');
    expect(r.config.capture.region).toBeNull();
    expect(r.ipc.state.hasRegion).toBe(false);
  });

  it('clearRegion is a config write, so everything that depends on having none follows', async () => {
    const r = rig();
    r.config = {
      ...DEFAULT_CONFIG,
      capture: {
        ...DEFAULT_CONFIG.capture,
        region: { rect: [10, 10, 800, 200], monitorId: '\\\\.\\DISPLAY1', monitorSize: [1920, 1080] },
      },
    };

    await r.ipc.command('clearRegion');

    expect(r.writes).toEqual([{ capture: { region: null } }]);
    expect(r.config.capture.region).toBeNull();
  });
});

describe('SettingsIpc: rebinding a hotkey', () => {
  it('probes the accelerator before anything is written', async () => {
    const r = rig();
    const result = await r.ipc.setHotkey({ action: 'selectRegion', accelerator: 'Control+Alt+G' });

    expect(result).toEqual({ ok: true });
    expect(r.probed).toEqual(['Control+Alt+G']);
    expect(r.config.hotkeys.selectRegion).toBe('Control+Alt+G');
  });

  it('refuses a key another program owns and leaves config untouched', async () => {
    // The whole reason the probe exists. Persisting a dead key would leave the window agreeing
    // with the user about a shortcut that does nothing - and their only remedy back to
    // hand-editing JSON, which is what this issue exists to end.
    const r = rig();
    r.probeResult = { ok: false, reason: 'conflict' };

    const result = await r.ipc.setHotkey({ action: 'selectRegion', accelerator: 'Control+Alt+R' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('another program');
    expect(r.writes).toEqual([]);
    expect(r.config.hotkeys.selectRegion).toBe('Control+Alt+R');
  });

  it('tells a Textlens duplicate apart from a foreign conflict, without asking Windows', async () => {
    // Electron returns `false` for both, so "another program owns it" would send the user hunting
    // for a program that does not exist. The comparison is config's, and it happens first.
    const r = rig();

    const result = await r.ipc.setHotkey({ action: 'selectRegion', accelerator: 'Control+Alt+A' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('toggleAuto');
    expect(r.probed).toEqual([]);
    expect(r.writes).toEqual([]);
  });

  it('lets an action keep its own key without calling that a duplicate', async () => {
    const r = rig();
    const result = await r.ipc.setHotkey({ action: 'snapshot', accelerator: 'Control+Alt+S' });
    expect(result.ok).toBe(true);
  });

  it('unbinds without probing, because releasing a key cannot fail usefully', async () => {
    // #32 requires unbinding to exist precisely as the way out of a conflict.
    const r = rig();
    const result = await r.ipc.setHotkey({ action: 'selectRegion', accelerator: null });

    expect(result).toEqual({ ok: true });
    expect(r.probed).toEqual([]);
    expect(r.config.hotkeys.selectRegion).toBeNull();
  });

  it('refuses an action name it does not know', async () => {
    const r = rig();
    const result = await r.ipc.setHotkey({ action: 'quit' as never, accelerator: 'Control+Alt+Q' });
    expect(result.ok).toBe(false);
    expect(r.writes).toEqual([]);
  });

  it('reports an unregisterable accelerator with what Windows said', async () => {
    const r = rig();
    r.probeResult = { ok: false, reason: 'invalid', detail: 'Invalid accelerator' };

    const result = await r.ipc.setHotkey({ action: 'snapshot', accelerator: 'Control+Alt+Nope' });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid accelerator');
    expect(r.writes).toEqual([]);
  });
});

describe('SettingsIpc: commands', () => {
  it.each([
    ['selectRegion', 'selectRegion'],
    ['toggleAuto', 'toggleAuto'],
    ['snapshot', 'snapshot'],
    ['toggleOverlay', 'toggleOverlay'],
    ['restartSidecar', 'restartSidecar'],
    ['reloadConfig', 'reload'],
  ] as const)('routes %s', async (command, expected) => {
    const r = rig();
    await r.ipc.command(command);
    expect(r.commands).toContain(expected);
  });

  it('pushes a fresh state after every command', async () => {
    const r = rig();
    await r.ipc.command('snapshot');
    expect(r.pushed).toHaveLength(1);
  });

  it('publishes without a window without throwing', () => {
    const send = vi.fn(() => false);
    const r = rig({
      host: {
        handle: () => undefined,
        removeHandler: () => undefined,
        send,
      },
    });
    expect(() => {
      r.ipc.publish();
    }).not.toThrow();
    expect(send).toHaveBeenCalled();
  });
});
