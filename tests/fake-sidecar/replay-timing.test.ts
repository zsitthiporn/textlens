/**
 * M3-06, acceptance criterion: "Replay preserves event order and the gaps between
 * events." That is a measurement claim, not a `setTimeout` claim (see the task's "what
 * counts as proof") - this file records a fixture with known gaps, replays it through
 * the real `TEXTLENS_SIDECAR_PATH` launch path (the compiled stub, see stub-builder.ts),
 * and times when each event actually arrives at `SidecarClient`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { NochangeEvent } from '../../src/shared/protocol.js';
import { SidecarClient } from '../../src/main/services/sidecar-client.js';
import { buildFakeSidecarStub } from './stub-builder.js';

const REPLAY_SCRIPT = path.resolve(import.meta.dirname, 'replay.mjs');

// Two process hops (the compiled launcher's byte pump, then Node's own setTimeout
// scheduling) add real jitter on top of Windows' timer resolution. Loose enough not to
// flake under CI load, tight enough that a broken scheduler (e.g. one that fires
// everything at once, or replays with no timing at all) would still fail it.
const TOLERANCE_MS = 100;

const cleanups: Array<() => void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

describe('fake sidecar: replay timing', () => {
  it('reproduces recorded inter-event gaps, in order, within tolerance', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-replay-timing-'));
    cleanups.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    // Deliberately uneven gaps - a scheduler that just fires everything back-to-back,
    // or one that fires at a constant interval regardless of what was recorded, would
    // both be caught by these not all being equal.
    const recordedAtMs = [0, 130, 260, 610];
    const rows = recordedAtMs.map((atMs, i) => {
      const line =
        i === 0
          ? JSON.stringify({ ev: 'ready', version: 'timing-fixture', ocrLanguages: [] })
          : JSON.stringify({ ev: 'nochange', seq: i });
      return JSON.stringify({ atMs, line });
    });
    const fixturePath = path.join(tempDir, 'timing.jsonl');
    fs.writeFileSync(fixturePath, `${rows.join('\n')}\n`, 'utf8');

    const stub = buildFakeSidecarStub(REPLAY_SCRIPT, [fixturePath]);
    cleanups.push(stub.cleanup);

    const client = new SidecarClient({ exePath: stub.exePath, readyTimeoutMs: 10_000 });
    cleanups.push(() => client.stop());

    const nochangeArrivals: Array<{ atMs: number; seq: number }> = [];
    client.on('nochange', (event: NochangeEvent) => {
      nochangeArrivals.push({ atMs: performance.now(), seq: event.seq });
    });

    const readyArrivedAt = await client.start().then(() => performance.now());

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('nochange events did not all arrive in time')), 5_000);
      const off = client.on('nochange', () => {
        if (nochangeArrivals.length >= 3) {
          clearTimeout(timeout);
          off();
          resolve();
        }
      });
    });

    // Order first: seq must arrive 1, 2, 3 - a decoder that reordered or dropped
    // anything would fail this before timing is even considered.
    expect(nochangeArrivals.map((a) => a.seq)).toEqual([1, 2, 3]);

    const arrivals = [readyArrivedAt, ...nochangeArrivals.map((a) => a.atMs)];
    const observedGaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
    const expectedGaps = recordedAtMs.slice(1).map((t, i) => t - recordedAtMs[i]!);

    expect(observedGaps).toHaveLength(expectedGaps.length);
    for (const [i, expectedGap] of expectedGaps.entries()) {
      const observedGap = observedGaps[i]!;
      expect(
        Math.abs(observedGap - expectedGap),
        `gap ${String(i)}: recorded ${String(expectedGap)}ms, observed ${observedGap.toFixed(1)}ms`,
      ).toBeLessThan(TOLERANCE_MS);
    }
  }, 15_000);
});
