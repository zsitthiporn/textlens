/**
 * M3-06 acceptance criterion: "Set the env var and the app runs against the fake with
 * no code change." Proven at the level `src/main/index.ts` actually operates at -
 * `resolveSidecarPath` reading `TEXTLENS_SIDECAR_PATH`, then `new SidecarClient({
 * exePath, logger })` with no `args` - because that is the exact shape `startSidecar`
 * uses (index.ts is out of scope for this issue and is not touched or imported here).
 *
 * The "fake" the env var points at is one of the real, committed fixtures replayed
 * through the compiled launcher (stub-builder.ts) - so this test also doubles as an
 * end-to-end proof that a fixture recorded from the real sidecar reproduces, byte for
 * byte, the same decoded events when replayed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { decodeEvent, type SidecarEvent } from '../../src/shared/protocol.js';
import { resolveSidecarPath, SidecarClient, SIDECAR_PATH_ENV } from '../../src/main/services/sidecar-client.js';
import { buildFakeSidecarStub } from './stub-builder.js';

const REPLAY_SCRIPT = path.resolve(import.meta.dirname, 'replay.mjs');
const FIXTURE = path.resolve(import.meta.dirname, '..', 'fixtures', 'sessions', 'with-text.jsonl');

const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

describe('fake sidecar: TEXTLENS_SIDECAR_PATH end to end', () => {
  it('resolveSidecarPath + SidecarClient (index.ts shape, no args) consumes the replayed fixture', async () => {
    const stub = buildFakeSidecarStub(REPLAY_SCRIPT, [FIXTURE]);
    cleanups.push(stub.cleanup);

    // Exactly what src/main/index.ts does with process.env, minus the Electron bits.
    const resolved = resolveSidecarPath({
      env: { [SIDECAR_PATH_ENV]: stub.exePath },
      isPackaged: false,
      resourcesPath: 'unused-in-env-override',
      appPath: 'unused-in-env-override',
    });
    expect(resolved.source).toBe('env-override');

    // Exactly the constructor call in startSidecar(): exePath and logger, no args.
    const client = new SidecarClient({ exePath: resolved.exePath });
    cleanups.push(() => client.stop());

    const ready = await client.start();
    expect(ready.ev).toBe('ready');
    expect(ready.ocrLanguages).toContain('en-US');

    const frame = await new Promise((resolve) => client.once('frame', resolve));
    expect((frame as { lines: readonly unknown[] }).lines.length).toBeGreaterThan(0);

    await client.stop();
    expect(client.isRunning).toBe(false);
  }, 15_000);

  it('replaying a fixture reproduces the same decoded events the fixture itself decodes to', async () => {
    const rows = fs
      .readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { line: string });

    const expected: SidecarEvent[] = rows.map((row) => {
      const decoded = decodeEvent(row.line);
      if (!decoded.ok) throw new Error(`fixture row failed to decode: ${decoded.reason}`);
      return decoded.value;
    });

    const stub = buildFakeSidecarStub(REPLAY_SCRIPT, [FIXTURE]);
    cleanups.push(stub.cleanup);

    const client = new SidecarClient({ exePath: stub.exePath });
    cleanups.push(() => client.stop());

    const received: SidecarEvent[] = [];
    for (const kind of ['ready', 'frame', 'nochange', 'error'] as const) {
      client.on(kind, (event) => received.push(event as SidecarEvent));
    }

    await client.start();

    const expectedNonAck = expected.filter((e) => e.ev !== 'ack');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('did not receive all replayed events in time')), 5_000);
      const off = client.on('nochange', () => {
        if (received.length >= expectedNonAck.length) {
          clearTimeout(timeout);
          off();
          resolve();
        }
      });
      if (received.length >= expectedNonAck.length) {
        clearTimeout(timeout);
        off();
        resolve();
      }
    });

    expect(received).toEqual(expectedNonAck);
  }, 15_000);
});
