/**
 * M1-04. Two halves, tested two ways.
 *
 * `LineDecoder` is fed a deliberately hostile byte stream - splits mid-token, splits
 * mid-character, several messages per chunk, chunks that end exactly on the newline -
 * because a framing bug produces no error, just events that quietly never arrive.
 *
 * `SidecarClient` is driven against a real child process (a small node script standing
 * in for the sidecar) rather than a hand-made fake object. Pipes, EOF and exit codes are
 * the parts most likely to behave differently from how a mock says they do.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { FrameEvent } from '../../src/shared/protocol.js';
import type { LogFields, LogLevel, Logger } from '../../src/main/services/logger.js';
import {
  LineDecoder,
  SIDECAR_EXECUTABLE,
  SIDECAR_PATH_ENV,
  SidecarClient,
  resolveSidecarPath,
} from '../../src/main/services/sidecar-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Recorded {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

/** A Logger that keeps every line, so tests can assert on what was reported. */
class RecordingLogger implements Logger {
  readonly lines: Recorded[] = [];

  constructor(
    readonly level: LogLevel = 'info',
    private readonly scope: string | undefined = undefined,
    lines?: Recorded[],
  ) {
    if (lines) this.lines = lines;
  }

  get isDebugEnabled(): boolean {
    return this.level === 'debug';
  }

  error(message: string, fields?: LogFields): void {
    this.push('error', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.push('warn', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.push('info', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.push('debug', message, fields);
  }
  sensitive(message: string, text: string, fields?: LogFields): void {
    if (!this.isDebugEnabled) return;
    this.push('debug', message, { ...fields, text });
  }
  child(scope: string): Logger {
    return new RecordingLogger(this.level, this.scope === undefined ? scope : `${this.scope}.${scope}`, this.lines);
  }

  private push(level: LogLevel, message: string, fields: LogFields | undefined): void {
    this.lines.push({ level, message, fields: this.scope === undefined ? fields : { scope: this.scope, ...fields } });
  }
}

const FRAME_TEXT = 'You must find the key';

/**
 * A stand-in sidecar. Speaks the real protocol, and can be told to misbehave:
 * `debugFrame` makes it emit a line that cannot be decoded before a good one, and
 * `stop` makes it write to stderr. Both are things the real sidecar can do to us.
 */
const FAKE_SIDECAR = `
import { createInterface } from 'node:readline';

const write = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const frame = (extra = {}) => ({
  ev: 'frame',
  seq: 1,
  timings: { captureUs: 11_000, diffUs: 2_000, ocrUs: 47_000 },
  monitor: { id: '\\\\\\\\.\\\\DISPLAY1', scale: 1, bounds: [0, 0, 3440, 1440] },
  region: [400, 1200, 1200, 150],
  lines: [{ text: ${JSON.stringify(FRAME_TEXT)}, bbox: [10, 20, 500, 30], conf: 0.94 }],
  ...extra,
});

write({ ev: 'ready', version: '9.9.9', ocrLanguages: ['en-US'] });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line).cmd;
  if (cmd === 'snapshot') write(frame());
  else if (cmd === 'debugFrame') {
    // One write on purpose: the bad line and the good one land in the same chunk, so a
    // reader that aborts on the bad line loses the good one too.
    process.stdout.write('this is not json\\n' + JSON.stringify(frame({ imagePng: 'iVBORw0KGgo=' })) + '\\n');
  } else if (cmd === 'stop') {
    process.stderr.write('WARN: pretend capture stopped\\n');
    write({ ev: 'nochange', seq: 2 });
  }
});
rl.on('close', () => process.exit(0));
`;

let tempDir: string;
let fakeSidecarJs: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-sidecar-'));
  fakeSidecarJs = path.join(tempDir, 'fake-sidecar.mjs');
  fs.writeFileSync(fakeSidecarJs, FAKE_SIDECAR, 'utf8');
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const clients: SidecarClient[] = [];

/** Every client this suite creates is stopped, whatever the test did or did not do. */
function track(client: SidecarClient): SidecarClient {
  clients.push(client);
  return client;
}

afterEach(async () => {
  while (clients.length > 0) {
    const client = clients.pop();
    if (client) await client.stop();
  }
});

function fakeClient(logger: Logger, overrides: { readyTimeoutMs?: number } = {}): SidecarClient {
  return track(
    new SidecarClient({
      exePath: process.execPath,
      args: [fakeSidecarJs],
      logger,
      readyTimeoutMs: overrides.readyTimeoutMs ?? 5_000,
    }),
  );
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function nextEvent<T>(subscribe: (handler: (payload: T) => void) => () => void, ms = 5_000): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no event within ${ms}ms`));
    }, ms);
    const off = subscribe((payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

describe('LineDecoder: a byte stream is not a message stream', () => {
  it('reassembles a JSON line split mid-token across two chunks', () => {
    const decoder = new LineDecoder();
    const line = '{"ev":"nochange","seq":43}';
    const split = line.indexOf('nocha') + 3; // mid-token, inside the event name

    expect(decoder.push(Buffer.from(line.slice(0, split), 'utf8'))).toEqual([]);
    expect(decoder.pendingBytes).toBe(split);
    expect(decoder.push(Buffer.from(`${line.slice(split)}\n`, 'utf8'))).toEqual([line]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('returns every message when several arrive in one chunk', () => {
    const decoder = new LineDecoder();
    const lines = ['{"ev":"nochange","seq":1}', '{"ev":"nochange","seq":2}', '{"ev":"nochange","seq":3}'];

    expect(decoder.push(Buffer.from(`${lines.join('\n')}\n`, 'utf8'))).toEqual(lines);
  });

  it('holds nothing back when a chunk ends exactly on the newline', () => {
    const decoder = new LineDecoder();

    expect(decoder.push(Buffer.from('{"ev":"nochange","seq":1}\n', 'utf8'))).toEqual(['{"ev":"nochange","seq":1}']);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(Buffer.from('{"ev":"nochange","seq":2}\n', 'utf8'))).toEqual(['{"ev":"nochange","seq":2}']);
  });

  it('survives a multi-byte character split across the boundary', () => {
    // Thai is three bytes per character. Decoding per chunk instead of per line turns
    // the straddling character into U+FFFD and corrupts the JSON around it - silently.
    const line = '{"ev":"error","code":"X","message":"ไม่พบข้อความ"}';
    const bytes = Buffer.from(`${line}\n`, 'utf8');
    const thaiStart = bytes.indexOf(Buffer.from('ไ', 'utf8'));

    const decoder = new LineDecoder();
    expect(decoder.push(bytes.subarray(0, thaiStart + 1))).toEqual([]);
    expect(decoder.push(bytes.subarray(thaiStart + 1))).toEqual([line]);
  });

  it('produces the same lines no matter where the chunks are cut', () => {
    const source = ['{"ev":"ready","version":"1.0.0","ocrLanguages":["en-US"]}', '{"ev":"nochange","seq":7}', '{"ev":"error","code":"E","message":"ครับ"}'];
    const bytes = Buffer.from(`${source.join('\n')}\n`, 'utf8');

    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const decoder = new LineDecoder();
      const got = [...decoder.push(bytes.subarray(0, cut)), ...decoder.push(bytes.subarray(cut))];
      expect(got, `cut at byte ${cut}`).toEqual(source);
    }
  });

  it('reassembles a stream delivered one byte at a time', () => {
    const source = ['{"ev":"nochange","seq":1}', '{"ev":"nochange","seq":2}'];
    const bytes = Buffer.from(`${source.join('\n')}\n`, 'utf8');

    const decoder = new LineDecoder();
    const got: string[] = [];
    for (const byte of bytes) got.push(...decoder.push(Buffer.from([byte])));

    expect(got).toEqual(source);
  });

  it('accepts CRLF and drops blank lines', () => {
    const decoder = new LineDecoder();

    expect(decoder.push(Buffer.from('{"a":1}\r\n\r\n{"b":2}\n\n', 'utf8'))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('hands back a trailing partial line only when the stream ends', () => {
    const decoder = new LineDecoder();

    expect(decoder.push(Buffer.from('{"ev":"nochange","seq":9}', 'utf8'))).toEqual([]);
    expect(decoder.flush()).toEqual(['{"ev":"nochange","seq":9}']);
    expect(decoder.flush()).toEqual([]);
  });

  it('discards an oversized line, says so, and resynchronises at the next newline', () => {
    const dropped: number[] = [];
    const decoder = new LineDecoder({ maxLineBytes: 32, onOverflow: (bytes) => dropped.push(bytes) });

    expect(decoder.push(Buffer.from('x'.repeat(100), 'utf8'))).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toBeGreaterThan(32);

    // The tail of the oversized line is still garbage and must not become a message.
    expect(decoder.push(Buffer.from('more garbage\n{"ev":"nochange","seq":1}\n', 'utf8'))).toEqual([
      '{"ev":"nochange","seq":1}',
    ]);
    expect(decoder.flush()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe('resolveSidecarPath', () => {
  const base = { isPackaged: false, resourcesPath: 'C:\\app\\resources', appPath: 'D:\\Project\\ME\\Textlens' };

  it('prefers the env override, in dev and when packaged alike', () => {
    const override = { [SIDECAR_PATH_ENV]: 'D:\\build\\Textlens.Capture.exe' };

    expect(resolveSidecarPath({ ...base, env: override })).toEqual({
      exePath: path.resolve('D:\\build\\Textlens.Capture.exe'),
      source: 'env-override',
    });
    expect(resolveSidecarPath({ ...base, isPackaged: true, env: override }).source).toBe('env-override');
  });

  it('ignores an override that is present but empty', () => {
    expect(resolveSidecarPath({ ...base, env: { [SIDECAR_PATH_ENV]: '  ' } }).source).toBe('dev-build');
  });

  it('looks beside the app when packaged and in the debug build tree in dev', () => {
    expect(resolveSidecarPath({ ...base, isPackaged: true, env: {} })).toEqual({
      exePath: path.join('C:\\app\\resources', 'sidecar', SIDECAR_EXECUTABLE),
      source: 'packaged',
    });

    const dev = resolveSidecarPath({ ...base, env: {} });
    expect(dev.source).toBe('dev-build');
    expect(dev.exePath.startsWith(base.appPath)).toBe(true);
    expect(dev.exePath.endsWith(SIDECAR_EXECUTABLE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Process lifecycle, against a real child
// ---------------------------------------------------------------------------

describe('SidecarClient against a live child process', () => {
  it('resolves start() with the ready event', async () => {
    const client = fakeClient(new RecordingLogger());

    const ready = await client.start();

    expect(ready).toEqual({ ev: 'ready', version: '9.9.9', ocrLanguages: ['en-US'] });
    expect(client.isRunning).toBe(true);
    expect(client.ready).toEqual(ready);
  });

  it('sends a command and receives the matching reply', async () => {
    const client = fakeClient(new RecordingLogger());
    await client.start();

    const frame = nextEvent<FrameEvent>((handler) => client.on('frame', handler));
    expect(client.send({ cmd: 'snapshot' })).toBe(true);

    const received = await frame;
    expect(received.seq).toBe(1);
    expect(received.lines[0]?.text).toBe(FRAME_TEXT);
    expect(received.timings).toEqual({ captureUs: 11000, diffUs: 2000, ocrUs: 47000 });
  });

  it('logs a warning for an undecodable line and keeps reading the stream', async () => {
    const logger = new RecordingLogger();
    const client = fakeClient(logger);
    await client.start();

    // The fake writes `this is not json` and then a valid frame, in that order.
    const frame = nextEvent<FrameEvent>((handler) => client.on('frame', handler));
    client.send({ cmd: 'debugFrame' });

    const received = await frame;
    expect(received.imagePng).toBe('iVBORw0KGgo=');

    const warning = logger.lines.find((line) => line.message.includes('undecodable'));
    expect(warning?.level).toBe('warn');
    expect(warning?.fields?.['reason']).toBe('malformed-json');
    // The line itself is never in the warning: it could have been a frame full of text.
    expect(JSON.stringify(warning)).not.toContain('this is not json');
  });

  it('logs sidecar stderr separately from the protocol stream', async () => {
    const logger = new RecordingLogger();
    const client = fakeClient(logger);
    await client.start();

    await nextEvent<unknown>((handler) => {
      client.send({ cmd: 'stop' });
      return client.on('nochange', handler);
    });
    // stderr is a different stream and arrives on its own schedule.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const stderrLine = logger.lines.find((line) => line.fields?.['stream'] === 'stderr');
    expect(stderrLine?.level).toBe('warn');
    expect(stderrLine?.message).toBe('WARN: pretend capture stopped');
    expect(stderrLine?.fields?.['scope']).toBe('sidecar.stderr');
  });

  it('leaves no process behind after stop()', async () => {
    const client = fakeClient(new RecordingLogger());
    await client.start();
    const pid = client.pid;
    expect(isAlive(pid)).toBe(true);

    const exit = nextEvent<{ expected: boolean; code: number | null }>((handler) => client.on('exit', handler));
    await client.stop();
    const seen = await exit;

    expect(seen.expected).toBe(true);
    expect(seen.code).toBe(0); // stdin EOF is the sidecar's clean shutdown path
    expect(client.isRunning).toBe(false);
    expect(isAlive(pid)).toBe(false);
  });

  it('reports a missing executable with the path and the override variable', async () => {
    const client = track(
      new SidecarClient({ exePath: path.join(tempDir, 'not-here.exe'), logger: new RecordingLogger() }),
    );

    await expect(client.start()).rejects.toThrow(new RegExp(`not-here\\.exe[\\s\\S]*${SIDECAR_PATH_ENV}`));
  });

  it('rejects instead of hanging when ready never arrives', async () => {
    // A child that produces no output at all: the exact shape of a wedged sidecar.
    const silent = path.join(tempDir, 'silent.mjs');
    fs.writeFileSync(silent, 'setTimeout(() => {}, 60_000);\n', 'utf8');
    const client = track(
      new SidecarClient({
        exePath: process.execPath,
        args: [silent],
        logger: new RecordingLogger(),
        readyTimeoutMs: 300,
        shutdownTimeoutMs: 500,
      }),
    );

    await expect(client.start()).rejects.toThrow(/did not send "ready" within 300ms/);
  });

  it('reports an unexpected exit as an error, not as a normal shutdown', async () => {
    const dies = path.join(tempDir, 'dies.mjs');
    fs.writeFileSync(
      dies,
      `process.stdout.write(JSON.stringify({ev:'ready',version:'0.0.1',ocrLanguages:[]}) + '\\n');\n` +
        `setTimeout(() => process.exit(3), 50);\n`,
      'utf8',
    );
    const logger = new RecordingLogger();
    const client = track(new SidecarClient({ exePath: process.execPath, args: [dies], logger }));
    await client.start();

    const exit = await nextEvent<{ expected: boolean; code: number | null }>((handler) => client.on('exit', handler));

    expect(exit).toMatchObject({ expected: false, code: 3 });
    expect(logger.lines.some((l) => l.level === 'error' && l.message.includes('exited unexpectedly'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real sidecar, when it has been built
// ---------------------------------------------------------------------------

const REAL_SIDECAR = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'sidecar',
  'Textlens.Capture',
  'bin',
  'Debug',
  'net10.0-windows10.0.19041.0',
  SIDECAR_EXECUTABLE,
);

describe.skipIf(!fs.existsSync(REAL_SIDECAR))('SidecarClient against the built sidecar', () => {
  it('gets ready within the 5 second budget and exits cleanly on stdin close', async () => {
    const client = track(new SidecarClient({ exePath: REAL_SIDECAR, logger: new RecordingLogger() }));

    const startedAt = Date.now();
    const ready = await client.start();
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(5_000);
    expect(ready.ev).toBe('ready');
    expect(ready.ocrLanguages).toContain('en-US');

    const pid = client.pid;
    await client.stop();
    expect(isAlive(pid)).toBe(false);

    // Belt and braces: ask Windows directly, not just this process's own bookkeeping.
    const tasklist = spawnSync('tasklist', ['/FI', `PID eq ${String(pid)}`], { encoding: 'utf8' });
    expect(tasklist.stdout).not.toContain(SIDECAR_EXECUTABLE);
  }, 20_000);
});
