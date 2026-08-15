import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COMMAND_KINDS,
  EVENT_KINDS,
  decodeCommand,
  decodeEvent,
  encodeCommand,
  encodeEvent,
  isCommandKind,
  isEventKind,
  type CommandKind,
  type DecodeFailure,
  type EventKind,
  type FrameEvent,
  type MonitorInfo,
  type SidecarEvent,
} from '../../src/shared/protocol.js';

/**
 * These are the same physical files the xunit suite reads (see
 * `sidecar/Textlens.Capture.Tests/ProtocolFixtures.cs`). Neither suite gets a copy —
 * a copy is how two implementations end up agreeing with two different fixtures.
 */
const FIXTURE_DIR = new URL('../fixtures/protocol/', import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8').trim();
}

function readFixtureLines(name: string): string[] {
  return readFileSync(new URL(name, FIXTURE_DIR), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

const EVENT_FIXTURES = [
  'event-ready.json',
  'event-frame.json',
  'event-frame-debug.json',
  'event-nochange.json',
  'event-error.json',
] as const;

const COMMAND_FIXTURES = [
  'command-list-monitors.json',
  'command-configure.json',
  'command-start.json',
  'command-stop.json',
  'command-snapshot.json',
  'command-debug-frame.json',
] as const;

describe('the kind tables cover their unions', () => {
  it('lists every command', () => {
    const exhaustive: Record<CommandKind, true> = {
      listMonitors: true,
      configure: true,
      start: true,
      stop: true,
      snapshot: true,
      debugFrame: true,
    };
    expect([...COMMAND_KINDS].sort()).toEqual(Object.keys(exhaustive).sort());
    expect(COMMAND_KINDS.every(isCommandKind)).toBe(true);
    expect(isCommandKind('teleport')).toBe(false);
  });

  it('lists every event', () => {
    const exhaustive: Record<EventKind, true> = {
      ready: true,
      frame: true,
      nochange: true,
      error: true,
    };
    expect([...EVENT_KINDS].sort()).toEqual(Object.keys(exhaustive).sort());
    expect(EVENT_KINDS.every(isEventKind)).toBe(true);
    expect(isEventKind('heartbeat')).toBe(false);
  });
});

describe('golden fixtures — the same files the xunit suite reads', () => {
  it.each(EVENT_FIXTURES)('%s parses and re-encodes byte for byte', (name) => {
    const golden = readFixture(name);

    const decoded = decodeEvent(golden);

    expect(decoded.ok ? null : decoded.detail).toBeNull();
    if (!decoded.ok) return;
    // Byte equality, not just parse success: this is what pins camelCase, key order
    // and number formatting to the C# side rather than merely to a similar-looking
    // interface declaration.
    expect(encodeEvent(decoded.value)).toBe(golden);
  });

  it.each(COMMAND_FIXTURES)('%s parses and re-encodes byte for byte', (name) => {
    const golden = readFixture(name);

    const decoded = decodeCommand(golden);

    expect(decoded.ok ? null : decoded.detail).toBeNull();
    if (!decoded.ok) return;
    expect(encodeCommand(decoded.value)).toBe(golden);
  });

  it('decodes the frame sample to the values the design doc shows', () => {
    const decoded = decodeEvent(readFixture('event-frame.json'));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual({
      ev: 'frame',
      seq: 42,
      timings: { capture: 12, diff: 3, ocr: 58 },
      monitor: { id: '\\\\.\\DISPLAY1', scale: 1.5, bounds: [0, 0, 3840, 2160] },
      region: [400, 1800, 1200, 150],
      lines: [{ text: 'You must find the key', bbox: [120, 80, 540, 32], conf: 0.93 }],
    } satisfies FrameEvent);
  });

  it('decodes the debug frame with its base64 payload', () => {
    const decoded = decodeEvent(readFixture('event-frame-debug.json'));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value.ev !== 'frame') throw new Error('expected a frame');
    expect(decoded.value.imagePng).toBe('iVBORw0KGgo=');
    // The secondary monitor sits left of primary, so its origin is negative — the
    // case the design doc calls out as the one the reference project got wrong.
    expect(decoded.value.monitor.bounds).toEqual([-1920, 0, 1920, 1080]);
    expect(decoded.value.monitor.scale).toBe(1.25);
  });

  it('decodes the configure sample to the values on the wire', () => {
    const decoded = decodeCommand(readFixture('command-configure.json'));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual({
      cmd: 'configure',
      region: [400, 1800, 1200, 150],
      monitorId: '\\\\.\\DISPLAY1',
      intervalActive: 800,
      intervalIdle: 2000,
      diffThreshold: 0.02,
      ocrLanguage: 'en-US',
    });
  });

  it('omits imagePng from an ordinary frame instead of writing null', () => {
    // Pixels crossing IPC is the one documented exception (CLAUDE.md invariant 1);
    // the field should not appear at all when it is not in play.
    expect(encodeEvent(decodeOrThrow(readFixture('event-frame.json')))).not.toContain('imagePng');
  });
});

describe('the coordinate contract is mandatory, not merely documented', () => {
  it('will not compile a monitor without scale', () => {
    const withoutScale: Omit<MonitorInfo, 'scale'> = { id: '\\\\.\\DISPLAY1', bounds: [0, 0, 3840, 2160] };

    // @ts-expect-error - `scale` is required: the coordinate converter (M3-01) cannot
    // turn physical px into logical px without it. If this directive ever becomes
    // unused, `npm run typecheck` fails - which is the point.
    const monitor: MonitorInfo = withoutScale;

    expect(monitor.id).toBe('\\\\.\\DISPLAY1');
  });

  it('will not compile a monitor without bounds', () => {
    const withoutBounds: Omit<MonitorInfo, 'bounds'> = { id: '\\\\.\\DISPLAY1', scale: 1.5 };

    // @ts-expect-error - `bounds` is required: without the monitor origin every
    // coordinate is relative to the wrong screen.
    const monitor: MonitorInfo = withoutBounds;

    expect(monitor.scale).toBe(1.5);
  });

  it.each(['invalid-frame-missing-scale.json', 'invalid-frame-missing-bounds.json'])(
    '%s is rejected at parse time rather than decoding to undefined',
    (name) => {
      const decoded = decodeEvent(readFixture(name));

      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.reason).toBe<DecodeFailure>('invalid-shape');
      expect(decoded.detail).toMatch(/scale|bounds/);
    },
  );
});

describe('nothing on the wire can crash the reader', () => {
  it('reports an unknown event and skips it', () => {
    const golden = readFixture('unknown-event.json');

    expect(() => decodeEvent(golden)).not.toThrow();
    const decoded = decodeEvent(golden);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toBe<DecodeFailure>('unknown-kind');
    // Naming the kind is the difference between a useful log line and "something
    // went wrong".
    expect(decoded.detail).toContain('heartbeat');
  });

  it('reports an unknown command and skips it', () => {
    const golden = readFixture('unknown-command.json');

    expect(() => decodeCommand(golden)).not.toThrow();
    const decoded = decodeCommand(golden);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toBe<DecodeFailure>('unknown-kind');
    expect(decoded.detail).toContain('recalibrate');
  });

  it.each<[string, DecodeFailure]>([
    ['', 'malformed-json'],
    ['   ', 'malformed-json'],
    ['{"ev":"nochange","seq":', 'malformed-json'],
    ['not json at all', 'malformed-json'],
    ['{}{}', 'malformed-json'],
    ['[1,2,3]', 'not-an-object'],
    ['"ready"', 'not-an-object'],
    ['null', 'not-an-object'],
    ['{"seq":1}', 'missing-discriminator'],
    ['{"ev":7}', 'missing-discriminator'],
    ['{"ev":"nochange"}', 'invalid-shape'],
    ['{"ev":"ready","version":"1.0.0","ocrLanguages":"en-US"}', 'invalid-shape'],
    [
      '{"ev":"frame","seq":1,"timings":{"capture":1,"diff":1,"ocr":1},'
        + '"monitor":{"id":"a","scale":1,"bounds":[0,0,10]},"region":[0,0,1,1],"lines":[]}',
      'invalid-shape',
    ],
  ])('turns %j into a value, never an exception', (line, expected) => {
    expect(() => decodeEvent(line)).not.toThrow();
    const decoded = decodeEvent(line);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toBe(expected);
    expect(decoded.detail.length).toBeGreaterThan(0);
  });

  it('keeps every good message in a stream that also contains bad ones', () => {
    const kept: SidecarEvent[] = [];
    const skipped: DecodeFailure[] = [];

    for (const line of readFixtureLines('stream-mixed.jsonl')) {
      const decoded = decodeEvent(line);
      if (decoded.ok) {
        kept.push(decoded.value);
      } else {
        expect(decoded.detail.length).toBeGreaterThan(0);
        skipped.push(decoded.reason);
      }
    }

    expect(kept).toEqual([
      { ev: 'ready', version: '1.0.0', ocrLanguages: ['en-US'] },
      { ev: 'nochange', seq: 46 },
    ]);
    expect(skipped).toEqual<DecodeFailure[]>(['unknown-kind', 'invalid-shape', 'malformed-json']);
  });
});

describe('encode then decode returns the same value', () => {
  it('round-trips a frame built from non-default values', () => {
    const original: FrameEvent = {
      ev: 'frame',
      seq: 4294967400,
      timings: { capture: 12, diff: 3, ocr: 58 },
      monitor: { id: '\\\\.\\DISPLAY2', scale: 1.25, bounds: [-1920, 0, 1920, 1080] },
      region: [400, 1800, 1200, 150],
      lines: [
        { text: 'You must find the key', bbox: [120, 80, 540, 32], conf: 0.93 },
        { text: 'before the gate closes', bbox: [118, 124, 561, 33], conf: 0.87 },
      ],
    };

    expect(decodeOrThrow(encodeEvent(original))).toEqual(original);
  });

  it('round-trips every command', () => {
    const commands = [
      { cmd: 'listMonitors' },
      { cmd: 'start' },
      { cmd: 'stop' },
      { cmd: 'snapshot' },
      { cmd: 'debugFrame' },
      {
        cmd: 'configure',
        region: [400, 1800, 1200, 150],
        monitorId: '\\\\.\\DISPLAY1',
        intervalActive: 800,
        intervalIdle: 2000,
        diffThreshold: 0.02,
        ocrLanguage: 'en-US',
      },
    ] as const;

    for (const command of commands) {
      const decoded = decodeCommand(encodeCommand(command));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value).toEqual(command);
    }
  });
});

function decodeOrThrow(line: string): SidecarEvent {
  const decoded = decodeEvent(line);
  if (!decoded.ok) throw new Error(`${decoded.reason}: ${decoded.detail}`);
  return decoded.value;
}
