#!/usr/bin/env node
/**
 * Record a real `Textlens.Capture` session into a fixture for the fake sidecar (M3-06).
 *
 * Drives the compiled `SidecarClient` (dist/, not src/ - this is a plain `node` script,
 * not something vitest transforms) with its `recordTo` hook pointed at the output file,
 * so the fixture is exactly what `SidecarClient` itself would have written: every raw
 * line off the wire, verbatim, timestamped relative to the first line. That is also why
 * this is the tool to use for a new fixture rather than hand-writing one - a hand-written
 * fixture cannot prove anything decoded through the real path.
 *
 * Build the app first: `npm run build:node` (dist/main/services/sidecar-client.js must
 * be up to date, or the recording will use stale record-hook behaviour).
 *
 * Usage:
 *   node tests/fake-sidecar/record.mjs error <out.jsonl> [--sidecar <exe>]
 *   node tests/fake-sidecar/record.mjs capture <out.jsonl> --region x,y,w,h --monitor id
 *       [--duration 4000] [--interval-active 300] [--interval-idle 1000]
 *       [--diff-threshold 0.02] [--ocr-language en-US] [--sidecar <exe>]
 *
 * `error` needs no capture region at all: it sends `start` before any `configure`, and
 * the sidecar's real `NOT_CONFIGURED` error is what lands in the fixture.
 *
 * `capture` sends `configure` then `start`, waits `--duration` ms, then `stop`. Point
 * `--region`/`--monitor` at deliberately harmless content - a text editor with placeholder
 * text for a fixture with OCR lines, an empty/minimized desktop for one that only produces
 * `nochange`. Never a real document or anything personal; see CLAUDE.md and the M3-06 task
 * brief on this. Run `node tests/fake-sidecar/record.mjs monitors` first to see device
 * names and bounds if you do not already know them.
 */

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SIDECAR = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'sidecar',
  'Textlens.Capture',
  'bin',
  'Debug',
  'net10.0-windows10.0.19041.0',
  'Textlens.Capture.exe',
);

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith('--')) {
      flags[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return flags;
}

async function loadSidecarClient() {
  const url = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'dist', 'main', 'services', 'sidecar-client.js'));
  try {
    return await import(url.href);
  } catch (error) {
    throw new Error(
      `could not load dist/main/services/sidecar-client.js (${error instanceof Error ? error.message : String(error)}). ` +
        'Run `npm run build:node` first.',
    );
  }
}

function consoleLogger() {
  const line = (level) => (message, fields) => {
    process.stderr.write(`[${level}] ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}\n`);
  };
  const logger = {
    error: line('error'),
    warn: line('warn'),
    info: line('info'),
    debug: line('debug'),
    sensitive: () => {}, // never echo screen text to this terminal's scrollback
    isDebugEnabled: false,
    level: 'info',
    child: () => logger,
  };
  return logger;
}

async function main() {
  const [scenario, outPath, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  const sidecarExe = flags.sidecar ?? DEFAULT_SIDECAR;

  if (scenario === undefined) {
    process.stderr.write('usage: record.mjs <error|capture|monitors> <out.jsonl> [options]\n');
    process.exitCode = 2;
    return;
  }

  const { SidecarClient } = await loadSidecarClient();
  const fs = await import('node:fs');

  // `monitors` has no fixture to produce - it exists to answer "what do I pass to
  // --region/--monitor". `SidecarClient` does not re-emit `ack` as a typed event (its
  // decode switch has no case for it), so the only way to read the reply is the same
  // raw-line record hook everything else here uses, pointed at a throwaway file.
  const recordTo = scenario === 'monitors' ? path.join(os.tmpdir(), `textlens-monitors-${Date.now()}.jsonl`) : path.resolve(outPath);

  const client = new SidecarClient({ exePath: sidecarExe, logger: consoleLogger(), recordTo });

  const ready = await client.start();
  process.stderr.write(`ready: version=${ready.version} ocrLanguages=${ready.ocrLanguages.join(',')}\n`);

  try {
    if (scenario === 'monitors') {
      client.send({ cmd: 'listMonitors' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await client.stop();
      const recorded = fs.readFileSync(recordTo, 'utf8').trim().split('\n');
      for (const row of recorded) process.stderr.write(`${JSON.parse(row).line}\n`);
      fs.rmSync(recordTo, { force: true });
      return;
    } else if (scenario === 'error') {
      client.send({ cmd: 'start' }); // before any configure - triggers NOT_CONFIGURED
      await new Promise((resolve) => {
        client.on('error', () => setTimeout(resolve, 200));
      });
    } else if (scenario === 'capture') {
      const region = (flags.region ?? '').split(',').map(Number);
      if (region.length !== 4 || region.some((n) => Number.isNaN(n))) {
        throw new Error('capture needs --region x,y,w,h');
      }
      if (flags.monitor === undefined) throw new Error('capture needs --monitor <deviceId>');

      client.send({
        cmd: 'configure',
        region,
        monitorId: flags.monitor,
        intervalActive: Number(flags['interval-active'] ?? 300),
        intervalIdle: Number(flags['interval-idle'] ?? 1000),
        diffThreshold: Number(flags['diff-threshold'] ?? 0.02),
        ocrLanguage: flags['ocr-language'] ?? 'en-US',
        debugFrameEnabled: false,
      });
      client.send({ cmd: 'start' });

      const duration = Number(flags.duration ?? 4000);
      let frameCount = 0;
      let nochangeCount = 0;
      client.on('frame', () => {
        frameCount += 1;
      });
      client.on('nochange', () => {
        nochangeCount += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, duration));
      client.send({ cmd: 'stop' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.stderr.write(`captured ${frameCount} frame(s), ${nochangeCount} nochange(s)\n`);
    } else {
      throw new Error(`unknown scenario "${scenario}" - expected error, capture, or monitors`);
    }
  } finally {
    await client.stop();
  }

  if (recordTo !== undefined) process.stderr.write(`wrote ${recordTo}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
