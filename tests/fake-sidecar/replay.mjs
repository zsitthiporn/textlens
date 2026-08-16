#!/usr/bin/env node
/**
 * The fake sidecar (issue M3-06, design doc section 8).
 *
 * Reads a recorded session - JSON lines of `{"atMs": <int>, "line": "<raw wire line>"}`,
 * produced by `SidecarClient`'s `recordTo` hook or by `record.mjs` - and writes the
 * `line` field to stdout at the recorded offsets, unmodified. It does not parse the
 * protocol, does not decode the lines, and does not react to commands: replaying is
 * "play these exact bytes back on this exact schedule," nothing more, which is what
 * makes it deterministic. A session that reproduces a real bug is reproduced exactly,
 * not as this build currently understands the protocol.
 *
 * stdin is drained and, on EOF, this process exits - the same shutdown contract the
 * real sidecar has (`docs/sidecar-protocol.md`: closing stdin is the clean-exit signal),
 * which is what lets `SidecarClient.stop()` behave identically against the fake.
 *
 * Usage: node replay.mjs <fixture.jsonl>
 */

import fs from 'node:fs';
import { createInterface } from 'node:readline';

const fixturePath = process.argv[2];
if (fixturePath === undefined) {
  process.stderr.write('usage: replay.mjs <fixture.jsonl>\n');
  process.exit(2);
}

/** @type {Array<{ atMs: number, line: string }>} */
const rows = fs
  .readFileSync(fixturePath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));

// Every write is scheduled from one t0, not chained setTimeouts - chaining accumulates
// the event loop's own scheduling slop on every hop; scheduling from a single anchor
// does not.
const timers = rows.map((row) =>
  setTimeout(() => {
    process.stdout.write(`${row.line}\n`);
  }, row.atMs),
);

const rl = createInterface({ input: process.stdin });
// Commands are received and discarded - replay does not answer them, it replays what
// was already recorded regardless of what is asked for.
rl.on('line', () => {});
rl.on('close', () => {
  for (const timer of timers) clearTimeout(timer);
  process.exit(0);
});
