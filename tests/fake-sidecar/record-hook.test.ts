/**
 * M3-06 acceptance criterion: "SidecarClient writes every event to a JSON-lines file."
 *
 * Drives `SidecarClient`'s `recordTo` option against a small scripted stand-in process
 * (same style as tests/main/sidecar-client.test.ts's FAKE_SIDECAR - a real child
 * process, not a hand-built mock, so pipe/EOF timing is real) and checks the file it
 * produced: every raw line the sidecar wrote, in order, each with a non-decreasing
 * millisecond offset from the first line, decodable through the real protocol decoder -
 * including the one line that is deliberately not valid JSON, because a recording that
 * only kept the lines it understood would be useless for reproducing the sessions where
 * something actually went wrong.
 *
 * This is the one test in this suite that exercises code inside `sidecar-client.ts`
 * itself rather than the replay side - see CLAUDE.md task M3-06 on why that hook is the
 * risky part: it touches a stream ("A byte stream is not a message stream") the existing
 * 21-test suite in tests/main/sidecar-client.test.ts already covers in detail, and that
 * suite must stay green, which npm test confirms independently of this file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { decodeEvent } from '../../src/shared/protocol.js';
import { SidecarClient } from '../../src/main/services/sidecar-client.js';

const SCRIPT_SOURCE = `
const write = (s) => process.stdout.write(s + '\\n');

write(JSON.stringify({ ev: 'ready', version: 'record-hook-fixture', ocrLanguages: ['en-US'] }));
setTimeout(() => write(JSON.stringify({ ev: 'nochange', seq: 1 })), 40);
// Deliberately malformed - the record hook must keep this verbatim even though
// decodeEvent will reject it.
setTimeout(() => process.stdout.write('this is not json\\n'), 80);
setTimeout(() => write(JSON.stringify({ ev: 'nochange', seq: 2 })), 120);

const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('close', () => process.exit(0));
`;

const tempDirs: string[] = [];

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const clients: SidecarClient[] = [];
afterEach(async () => {
  while (clients.length > 0) {
    const client = clients.pop();
    if (client) await client.stop();
  }
});

describe('SidecarClient.recordTo', () => {
  it('appends every raw stdout line, verbatim, with a monotonic ms offset from the first', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-record-hook-'));
    tempDirs.push(tempDir);
    const scriptPath = path.join(tempDir, 'fake.cjs');
    fs.writeFileSync(scriptPath, SCRIPT_SOURCE, 'utf8');
    const recordTo = path.join(tempDir, 'session.jsonl');

    const client = new SidecarClient({ exePath: process.execPath, args: [scriptPath], recordTo });
    clients.push(client);

    await client.start();
    // Wait for both nochange events (seq 1 and 2) plus the undecodable line in between.
    await new Promise<void>((resolve) => {
      let count = 0;
      client.on('nochange', () => {
        count += 1;
        if (count >= 2) resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 50)); // let the undecodable line settle too

    await client.stop();

    // The whole point of awaiting stop() rather than reading immediately: the file must
    // already be flushed and closed by the time this line runs.
    const rows = fs
      .readFileSync(recordTo, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { atMs: number; line: string });

    expect(rows).toHaveLength(4);
    expect(rows[0]!.line).toContain('"ev":"ready"');
    expect(rows[1]!.line).toContain('"nochange"');
    expect(rows[2]!.line).toBe('this is not json');
    expect(rows[3]!.line).toContain('"nochange"');

    expect(rows[0]!.atMs).toBe(0);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.atMs).toBeGreaterThanOrEqual(rows[i - 1]!.atMs);
    }
    // Roughly matches the script's own 40/80/120ms schedule - generous tolerance, this
    // is a sanity check that offsets are real elapsed time, not e.g. all zero.
    expect(rows[3]!.atMs).toBeGreaterThan(60);

    // Every row decodes through the real path exactly as the live stream did: the good
    // lines succeed, the bad one fails the same way `decodeEvent` fails it live.
    expect(decodeEvent(rows[0]!.line)).toMatchObject({ ok: true, value: { ev: 'ready' } });
    expect(decodeEvent(rows[1]!.line)).toMatchObject({ ok: true, value: { ev: 'nochange', seq: 1 } });
    expect(decodeEvent(rows[2]!.line)).toMatchObject({ ok: false, reason: 'malformed-json' });
    expect(decodeEvent(rows[3]!.line)).toMatchObject({ ok: true, value: { ev: 'nochange', seq: 2 } });
  });

  it('does nothing when recordTo is not set - the shipped app never turns this on for itself', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-record-hook-off-'));
    tempDirs.push(tempDir);
    const scriptPath = path.join(tempDir, 'fake.cjs');
    fs.writeFileSync(scriptPath, SCRIPT_SOURCE, 'utf8');

    const client = new SidecarClient({ exePath: process.execPath, args: [scriptPath] });
    clients.push(client);

    await client.start();
    await client.stop();

    expect(fs.readdirSync(tempDir)).toEqual(['fake.cjs']);
  });
});
