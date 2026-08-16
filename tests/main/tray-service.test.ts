/**
 * Issue M7-02 / #33, feature G6 - the system tray.
 *
 * ## What these tests do and do not reach
 *
 * The fake below stands in for `Tray`, `Menu` and `nativeImage`. It models the one behaviour
 * of Electron's real `nativeImage.createFromPath` that the service depends on and that a
 * naive fake would get wrong: **a missing or corrupt file does not throw, it returns an empty
 * image**. A fake that threw instead would let a service with no `isEmpty()` check pass this
 * whole file, and the acceptance criterion is precisely that a bad icon is survived rather
 * than crashed on - the reference project's tray bug.
 *
 * So: the menu's shape, the state-to-icon mapping, the tooltip, and every fallback are proved
 * here. That Windows actually draws a tray icon, that the OS accepts an empty image, and that
 * the Quit item ends the process are proved only by a real run, and are reported separately.
 */

import { describe, expect, it } from 'vitest';

import type { AppMode } from '../../src/main/services/app-orchestrator.js';
import type { LogFields, Logger } from '../../src/main/services/logger.js';
import {
  TRAY_ICON_FILES,
  TrayService,
  describeState,
  resolveTrayIconDir,
  type TrayActions,
  type TrayHandle,
  type TrayImage,
  type TrayMenu,
  type TrayMenuItem,
  type TrayPlatform,
  type TrayState,
} from '../../src/main/services/tray-service.js';

function collectingLogger(): {
  logger: Logger;
  lines: Array<{ level: string; message: string; fields?: LogFields }>;
} {
  const lines: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    };
  const logger: Logger = {
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    sensitive() {},
    isDebugEnabled: false,
    level: 'info',
    child: () => logger,
  };
  return { logger, lines };
}

interface FakeTray extends TrayPlatform {
  readonly handle: FakeHandle | null;
  /** Fire the tray's left click, as Windows would. */
  click(): void;
  /** Every menu Electron was asked to build, newest last. */
  readonly menus: Array<readonly TrayMenuItem[]>;
  /** Paths handed to `createImage`, in order. */
  readonly loaded: string[];
}

interface FakeHandle extends TrayHandle {
  tooltip: string | null;
  image: string | null;
  destroyed: boolean;
  clickListener: (() => void) | null;
}

interface FakeTrayOptions {
  /** Icon filenames that cannot be read - `createImage` returns an *empty* image, as Electron does. */
  readonly unreadable?: readonly string[];
  /** Icon filenames whose load throws outright. */
  readonly throwing?: readonly string[];
  /** Make `new Tray(...)` throw, as it would if the OS refused. */
  readonly trayThrows?: boolean;
}

function fakeTray(options: FakeTrayOptions = {}): FakeTray {
  const menus: Array<readonly TrayMenuItem[]> = [];
  const loaded: string[] = [];
  let handle: FakeHandle | null = null;

  const image = (name: string, empty: boolean): TrayImage & { name: string } => ({
    name,
    isEmpty: () => empty,
  });

  const platform: FakeTray = {
    get handle() {
      return handle;
    },
    menus,
    loaded,
    click() {
      handle?.clickListener?.();
    },
    createImage(filePath) {
      loaded.push(filePath);
      const base = filePath.split(/[\\/]/).pop() ?? filePath;
      if (options.throwing?.includes(base) === true) throw new Error(`cannot read ${base}`);
      return image(base, options.unreadable?.includes(base) === true);
    },
    createEmptyImage() {
      return image('(empty)', true);
    },
    buildMenu(template) {
      menus.push(template);
      return { template } satisfies TrayMenu;
    },
    createTray(initial) {
      if (options.trayThrows === true) throw new Error('the OS refused to create a tray');
      handle = {
        tooltip: null,
        image: (initial as { name?: string }).name ?? null,
        destroyed: false,
        clickListener: null,
        setToolTip(tooltip) {
          this.tooltip = tooltip;
        },
        setContextMenu() {},
        setImage(next) {
          this.image = (next as { name?: string }).name ?? null;
        },
        on(_event, listener) {
          this.clickListener = listener;
        },
        destroy() {
          this.destroyed = true;
        },
        isDestroyed() {
          return this.destroyed;
        },
      };
      return handle;
    },
  };
  return platform;
}

function recordingActions(): { actions: TrayActions; fired: string[] } {
  const fired: string[] = [];
  const push =
    (name: string) =>
    (): void => {
      fired.push(name);
    };
  return {
    fired,
    actions: {
      onSelectRegion: push('selectRegion'),
      onSnapshot: push('snapshot'),
      onToggleAuto: push('toggleAuto'),
      onPause: push('pause'),
      onToggleOverlay: push('toggleOverlay'),
      onOpenSettings: push('openSettings'),
      onQuit: push('quit'),
      onRestartSidecar: push('restartSidecar'),
    },
  };
}

function state(overrides: Partial<TrayState> = {}): TrayState {
  return { mode: 'idle', overlayVisible: true, error: null, ...overrides };
}

function item(menu: readonly TrayMenuItem[], label: string): TrayMenuItem {
  const found = menu.find((entry) => entry.label === label);
  if (found === undefined) throw new Error(`no menu item labelled "${label}" in ${JSON.stringify(menu)}`);
  return found;
}

function build(options: FakeTrayOptions = {}): {
  platform: FakeTray;
  service: TrayService;
  fired: string[];
  lines: Array<{ level: string; message: string; fields?: LogFields }>;
} {
  const platform = fakeTray(options);
  const { actions, fired } = recordingActions();
  const { logger, lines } = collectingLogger();
  const service = new TrayService({ platform, iconDir: 'C:\\icons', actions, logger });
  return { platform, service, fired, lines };
}

describe('resolveTrayIconDir', () => {
  it('reads from build/icons in a dev tree', () => {
    expect(
      resolveTrayIconDir({ isPackaged: false, resourcesPath: 'C:\\res', appPath: 'D:\\repo' }),
    ).toBe('D:\\repo\\build\\icons');
  });

  it('reads from resources/icons when packaged', () => {
    expect(
      resolveTrayIconDir({ isPackaged: true, resourcesPath: 'C:\\res', appPath: 'D:\\repo' }),
    ).toBe('C:\\res\\icons');
  });
});

describe('TrayService.create', () => {
  it('creates the tray and installs a menu and a tooltip', () => {
    const { platform, service } = build();

    expect(service.create()).toBe(true);
    expect(platform.handle?.tooltip).toBe('Textlens — idle');
    expect(platform.menus).toHaveLength(1);
  });

  it('is idempotent', () => {
    const { platform, service } = build();
    service.create();
    const first = platform.handle;
    service.create();
    expect(platform.handle).toBe(first);
  });

  it('routes a left click to the overlay toggle', () => {
    const { platform, service, fired } = build();
    service.create();
    platform.click();
    expect(fired).toEqual(['toggleOverlay']);
  });

  it('reports a tray the OS refused, and does not throw', () => {
    const { service, lines } = build({ trayThrows: true });

    expect(service.create()).toBe(false);
    expect(service.handle).toBeNull();
    expect(lines.some((line) => line.level === 'error' && line.message.includes('could not create the tray'))).toBe(
      true,
    );
  });
});

describe('TrayService icons', () => {
  it('loads the icon for the current state', () => {
    const { platform, service } = build();
    service.create();
    expect(platform.loaded).toEqual(['C:\\icons\\idle.png']);
    expect(platform.handle?.image).toBe('idle.png');
  });

  it('changes the icon when the mode changes', () => {
    const { platform, service } = build();
    service.create();

    for (const mode of ['auto', 'paused', 'snapshot'] as const) {
      service.update(state({ mode }));
      expect(platform.handle?.image).toBe(TRAY_ICON_FILES[mode]);
    }
  });

  it('shows the error icon whatever the mode is', () => {
    const { platform, service } = build();
    service.create();
    service.update(state({ mode: 'auto' }));
    expect(platform.handle?.image).toBe('auto.png');

    service.update(state({ mode: 'auto', error: 'the engine is down' }));
    expect(platform.handle?.image).toBe('error.png');

    service.update(state({ mode: 'auto' }));
    expect(platform.handle?.image).toBe('auto.png');
  });

  it('loads each icon once, not on every update', () => {
    const { platform, service } = build();
    service.create();
    service.update(state({ mode: 'auto' }));
    service.update(state({ mode: 'auto', overlayVisible: false }));
    service.update(state({ mode: 'auto' }));

    expect(platform.loaded).toEqual(['C:\\icons\\idle.png', 'C:\\icons\\auto.png']);
  });

  it('carries on with a blank icon when the file cannot be read, and says so', () => {
    // Electron returns an *empty* image here rather than throwing, which is why the service
    // has to check `isEmpty()` - and why this is the case the reference project crashed on.
    const { platform, service, lines } = build({ unreadable: ['idle.png'] });

    expect(service.create()).toBe(true);
    expect(platform.handle).not.toBeNull();
    expect(lines.some((line) => line.level === 'error' && line.message.includes('missing or unreadable'))).toBe(true);
  });

  it('carries on when loading the icon throws', () => {
    const { platform, service, lines } = build({ throwing: ['idle.png'] });

    expect(service.create()).toBe(true);
    expect(platform.handle?.image).toBe('(empty)');
    expect(lines.some((line) => line.level === 'error' && line.message.includes('could not be read'))).toBe(true);
  });

  it('still builds a tray when every single icon is unreadable', () => {
    // The tray is the only quit path, so "no icons" must never mean "no way out".
    const { platform, service } = build({ unreadable: Object.values(TRAY_ICON_FILES) });

    expect(service.create()).toBe(true);
    service.update(state({ mode: 'auto' }));
    service.update(state({ mode: 'auto', error: 'boom' }));
    expect(platform.handle?.destroyed).toBe(false);
  });
});

describe('TrayService menu', () => {
  function latest(platform: FakeTray): readonly TrayMenuItem[] {
    const menu = platform.menus.at(-1);
    if (menu === undefined) throw new Error('no menu was built');
    return menu;
  }

  it('offers every action the issue names', () => {
    const { platform, service } = build();
    service.create();
    const labels = latest(platform)
      .map((entry) => entry.label)
      .filter((label): label is string => label !== undefined);

    expect(labels).toEqual([
      'Select Region…',
      'Snapshot',
      'Auto',
      'Pause',
      'Show overlay',
      // #40/#41. The way back out of the supervisor's give-up state, and the only one: the alert
      // that reports it names this item as the remedy.
      'Restart capture engine',
      'Settings…',
      'Quit',
    ]);
  });

  it('leaves the restart item out when nothing supervises the sidecar', () => {
    const platform = fakeTray();
    const { actions } = recordingActions();
    const { onRestartSidecar: _omitted, ...withoutSupervisor } = actions;
    const service = new TrayService({ platform, iconDir: 'C:\\icons', actions: withoutSupervisor });
    service.create();

    expect(latest(platform).map((entry) => entry.label)).not.toContain('Restart capture engine');
  });

  /**
   * The three standing conditions - #30's edge report, #31's stale region, #50's idle detection -
   * all published onto `AppStatus.warning` and reached the tooltip only, which needs the user to
   * already suspect something and go hovering. This is the menu they open when they do.
   */
  it('shows a standing warning in the menu, one rank below an error', () => {
    const { platform, service } = build();
    service.create();

    service.update(state({ warning: 'text is touching the left edge of the region; widen it' }));
    expect(latest(platform)[0]?.label).toContain('text is touching');
    expect(latest(platform)[0]?.enabled).toBe(false);

    // An error outranks it: a broken engine matters more than a result that is merely wrong.
    service.update(state({ warning: 'text is touching the left edge', error: 'the engine is down' }));
    expect(latest(platform)[0]?.label).toContain('the engine is down');
  });

  it('fires the matching action for every item', () => {
    const { platform, service, fired } = build();
    service.create();
    const menu = latest(platform);

    for (const label of ['Select Region…', 'Snapshot', 'Auto', 'Pause', 'Show overlay', 'Settings…', 'Quit']) {
      item(menu, label).click?.();
    }

    expect(fired).toEqual([
      'selectRegion',
      'snapshot',
      'toggleAuto',
      'pause',
      'toggleOverlay',
      'openSettings',
      'quit',
    ]);
  });

  it('checks Auto only in auto mode', () => {
    const { platform, service } = build();
    service.create();

    const checked = (mode: AppMode): boolean | undefined => {
      service.update(state({ mode }));
      return item(latest(platform), 'Auto').checked;
    };

    expect(checked('auto')).toBe(true);
    expect(checked('paused')).toBe(false);
    expect(checked('snapshot')).toBe(false);
    expect(checked('idle')).toBe(false);
  });

  it('enables Pause only when something is capturing', () => {
    const { platform, service } = build();
    service.create();

    service.update(state({ mode: 'auto' }));
    expect(item(latest(platform), 'Pause').enabled).toBe(true);

    service.update(state({ mode: 'paused' }));
    expect(item(latest(platform), 'Pause').enabled).toBe(false);
  });

  it('mirrors overlay visibility in the Show overlay checkbox', () => {
    const { platform, service } = build();
    service.create();

    service.update(state({ overlayVisible: false }));
    expect(item(latest(platform), 'Show overlay').checked).toBe(false);

    service.update(state({ overlayVisible: true }));
    expect(item(latest(platform), 'Show overlay').checked).toBe(true);
  });

  it('puts the error at the top of the menu, disabled', () => {
    const { platform, service } = build();
    service.create();
    service.update(state({ error: 'the sidecar stopped unexpectedly' }));

    const first = latest(platform)[0];
    expect(first?.label).toBe('! the sidecar stopped unexpectedly');
    expect(first?.enabled).toBe(false);
  });

  it('does not let a throwing action escape into Electron', () => {
    const platform = fakeTray();
    const { logger, lines } = collectingLogger();
    const service = new TrayService({
      platform,
      iconDir: 'C:\\icons',
      logger,
      actions: {
        ...recordingActions().actions,
        onQuit: () => {
          throw new Error('quit blew up');
        },
      },
    });
    service.create();

    expect(() => item(latest(platform), 'Quit').click?.()).not.toThrow();
    expect(lines.some((line) => line.level === 'error' && line.message.includes('tray action threw'))).toBe(true);
  });
});

describe('describeState', () => {
  it('names the mode', () => {
    expect(describeState(state({ mode: 'auto' }))).toBe('Textlens — auto');
  });

  it('distinguishes a hidden overlay from a paused pipeline', () => {
    // The pair users confuse, and the reason both are in the tooltip: without the suffix,
    // auto-with-the-overlay-hidden would read exactly like paused.
    expect(describeState(state({ mode: 'auto', overlayVisible: false }))).toBe('Textlens — auto, overlay hidden');
    expect(describeState(state({ mode: 'paused' }))).toBe('Textlens — paused');
  });

  it('reports an error instead of the mode', () => {
    expect(describeState(state({ mode: 'auto', error: 'no recognizer' }))).toBe('Textlens — error: no recognizer');
  });

  it('keeps the tooltip inside the Windows limit', () => {
    // Windows truncates a tray tooltip past 127 characters, so a long error must be cut
    // where we choose rather than wherever the shell decides.
    const tooltip = describeState(state({ error: 'x'.repeat(500) }));
    expect(tooltip.length).toBeLessThanOrEqual(127);
  });
});

describe('TrayService.update', () => {
  it('does nothing before the tray exists', () => {
    const { platform, service } = build();
    service.update(state({ mode: 'auto' }));
    expect(platform.menus).toHaveLength(0);
    expect(service.state.mode).toBe('auto');
  });

  it('rebuilds the menu only when the state actually changed', () => {
    const { platform, service } = build();
    service.create();
    const built = platform.menus.length;

    service.update(state());
    expect(platform.menus).toHaveLength(built);

    service.update(state({ mode: 'auto' }));
    expect(platform.menus).toHaveLength(built + 1);
  });

  it('destroy is safe to call twice', () => {
    const { platform, service } = build();
    service.create();
    const handle = platform.handle;
    service.destroy();
    service.destroy();
    expect(handle?.destroyed).toBe(true);
    expect(service.handle).toBeNull();
  });
});
