/**
 * M3-06 acceptance criterion: at least 3 fixtures - with text, without text, sidecar
 * emits an error. This suite is the proof that the three committed fixtures
 * (tests/fixtures/sessions/*.jsonl) are what they claim to be, decoded through the
 * real wire-format decoder (`decodeEvent`, src/shared/protocol.ts) rather than
 * asserted from the recorder's own claims.
 *
 * All three were produced by `record.mjs` driving the real `Textlens.Capture.exe`
 * (README.md documents the exact commands) - not hand-written. `error.jsonl` in
 * particular needs no screen content at all: it is `start` sent before any
 * `configure`, which the real sidecar refuses with `NOT_CONFIGURED`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeEvent, type SidecarEvent } from '../../src/shared/protocol.js';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '..', 'fixtures', 'sessions');

interface Row {
  readonly atMs: number;
  readonly line: string;
}

function loadFixture(name: string): { rows: Row[]; events: SidecarEvent[] } {
  const filePath = path.join(FIXTURES_DIR, name);
  const rows: Row[] = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row);

  const events = rows.map((row, i) => {
    const decoded = decodeEvent(row.line);
    if (!decoded.ok) {
      throw new Error(`${name} row ${String(i)} does not decode as a protocol event: ${decoded.reason} - ${decoded.detail}`);
    }
    return decoded.value;
  });

  return { rows, events };
}

describe('fake-sidecar fixtures: real recordings, decoded through the real path', () => {
  it('every row of every fixture is LF-terminated JSON that decodeEvent accepts', () => {
    for (const name of ['error.jsonl', 'without-text.jsonl', 'with-text.jsonl']) {
      const filePath = path.join(FIXTURES_DIR, name);
      const raw = fs.readFileSync(filePath);
      expect(raw.includes(0x0d), `${name} must be LF-only per .gitattributes`).toBe(false);

      const { rows, events } = loadFixture(name);
      expect(rows.length, `${name} should not be empty`).toBeGreaterThan(0);
      expect(events).toHaveLength(rows.length);

      // atMs is non-decreasing and starts at 0 - the replay timing contract depends on it.
      expect(rows[0]!.atMs).toBe(0);
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]!.atMs, `${name} row ${String(i)} atMs must not go backwards`).toBeGreaterThanOrEqual(rows[i - 1]!.atMs);
      }

      // Every fixture opens with the sidecar's real first line.
      expect(events[0]).toMatchObject({ ev: 'ready' });
    }
  });

  it('error.jsonl: start before configure produced a real NOT_CONFIGURED error event', () => {
    const { events } = loadFixture('error.jsonl');
    const errors = events.filter((e) => e.ev === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ ev: 'error', code: 'NOT_CONFIGURED' });
    // No frame or nochange - this scenario never got past `start`.
    expect(events.some((e) => e.ev === 'frame' || e.ev === 'nochange')).toBe(false);
  });

  it('without-text.jsonl: a real frame with zero OCR lines, plus nochange gaps', () => {
    const { events } = loadFixture('without-text.jsonl');
    const frames = events.filter((e) => e.ev === 'frame');
    expect(frames.length).toBeGreaterThanOrEqual(1);
    for (const frame of frames) {
      if (frame.ev === 'frame') expect(frame.lines).toHaveLength(0);
    }
    expect(events.some((e) => e.ev === 'nochange')).toBe(true);
    expect(events.some((e) => e.ev === 'error')).toBe(false);
  });

  it('with-text.jsonl: a real frame carrying non-empty OCR lines', () => {
    const { events } = loadFixture('with-text.jsonl');
    const frames = events.filter((e) => e.ev === 'frame');
    expect(frames.length).toBeGreaterThanOrEqual(1);

    const withLines = frames.filter((f) => f.ev === 'frame' && f.lines.length > 0);
    expect(withLines.length).toBeGreaterThanOrEqual(1);

    for (const frame of withLines) {
      if (frame.ev !== 'frame') continue;
      for (const line of frame.lines) {
        expect(line.text.length).toBeGreaterThan(0);
        // Coordinate contract (protocol.ts): bbox is a 4-tuple, never partially present.
        expect(line.bbox).toHaveLength(4);
      }
    }
    expect(events.some((e) => e.ev === 'error')).toBe(false);
  });
});
