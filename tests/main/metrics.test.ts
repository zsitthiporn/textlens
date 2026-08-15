/**
 * M10-03, feature L3. The budget in design doc section 4 is only meaningful if the
 * numbers next to it are computed the way we say they are, so the percentile maths gets
 * checked against hand-worked values rather than against itself.
 */

import { describe, expect, it, vi } from 'vitest';

import type { LogFields, Logger } from '../../src/main/services/logger.js';
import {
  MetricsRecorder,
  PIPELINE_STAGES,
  STAGE_BUDGETS,
  percentile,
  startMetricsSummary,
} from '../../src/main/services/metrics.js';

function collectingLogger(): { logger: Logger; lines: Array<{ message: string; fields?: LogFields }> } {
  const lines: Array<{ message: string; fields?: LogFields }> = [];
  const logger: Logger = {
    error(message, fields) {
      lines.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    warn(message, fields) {
      lines.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    info(message, fields) {
      lines.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    debug(message, fields) {
      lines.push({ message, ...(fields === undefined ? {} : { fields }) });
    },
    sensitive() {},
    isDebugEnabled: false,
    level: 'info',
    child: () => logger,
  };
  return { logger, lines };
}

describe('percentile', () => {
  it('takes the nearest rank rather than interpolating', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(percentile(samples, 0.5)).toBe(5);
    expect(percentile(samples, 0.9)).toBe(9);
    expect(percentile(samples, 1)).toBe(10);
    // Every value it returns is a value some frame actually took.
    expect(samples).toContain(percentile(samples, 0.75));
  });

  it('is defined on the awkward inputs', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.9)).toBe(42);
    expect(percentile([1, 2], 0)).toBe(1);
  });
});

describe('MetricsRecorder', () => {
  it('folds the sidecar timings into the three stages it measured', () => {
    const recorder = new MetricsRecorder();

    // The wire is microseconds; the budgets are milliseconds. These are 12ms / 3ms / 58ms.
    recorder.recordFrameTimings({ captureUs: 12_000, diffUs: 3_000, ocrUs: 58_000 });
    recorder.recordFrameTimings({ captureUs: 14_000, diffUs: 4_000, ocrUs: 62_000 });

    const byStage = new Map(recorder.snapshot().map((s) => [s.stage, s]));
    expect([...byStage.keys()]).toEqual(['capture', 'diff', 'ocr']);
    expect(byStage.get('ocr')).toMatchObject({ count: 2, p50: 58, p90: 62, max: 62 });
  });

  it('keeps sub-millisecond stages visible instead of rounding them to zero', () => {
    // The defect the unit change exists to fix. Measured capture is p50 574µs; as an
    // integer number of milliseconds on the wire that was 0 on every frame forever, so
    // the capture row of the design doc section 4 budget could never be checked.
    const recorder = new MetricsRecorder();

    recorder.recordFrameTimings({ captureUs: 574, diffUs: 159, ocrUs: 24_680 });

    const byStage = new Map(recorder.snapshot().map((s) => [s.stage, s]));
    // `snapshot` reports to one decimal, so 0.574ms surfaces as 0.6 - the point is that it
    // is no longer 0, which is what an integer-millisecond wire made it.
    expect(byStage.get('capture')?.p50).toBeGreaterThan(0);
    expect(byStage.get('capture')?.p50).toBeCloseTo(0.6, 5);
    expect(byStage.get('diff')?.p50).toBeCloseTo(0.2, 5);
    expect(byStage.get('ocr')?.p50).toBeCloseTo(24.7, 5);
  });

  it('omits stages nothing has measured yet', () => {
    const recorder = new MetricsRecorder();
    recorder.record('translate', 320);

    expect(recorder.snapshot().map((s) => s.stage)).toEqual(['translate']);
  });

  it('reports stages in pipeline order, not in the order they were first seen', () => {
    const recorder = new MetricsRecorder();
    recorder.record('render', 8);
    recorder.record('capture', 8);
    recorder.record('translate', 8);

    expect(recorder.snapshot().map((s) => s.stage)).toEqual(['capture', 'translate', 'render']);
  });

  it('keeps memory bounded while still counting everything', () => {
    const recorder = new MetricsRecorder({ sampleCap: 10 });
    for (let i = 1; i <= 1000; i += 1) recorder.record('ocr', i);

    const [stats] = recorder.snapshot();
    expect(stats?.count).toBe(1000); // every sample counted
    expect(stats?.p50).toBe(995); // only the last 10 retained: 991..1000
    expect(stats?.max).toBe(1000);
  });

  it('flags a stage whose tail is over the design doc budget', () => {
    const recorder = new MetricsRecorder();
    // Nearest-rank p90 of ten samples is the 9th, so this lands on 120ms - well past
    // the 80ms OCR row, while the p50 of 62ms is comfortably inside it.
    for (const ms of [40, 45, 50, 55, 60, 65, 70, 75, 120, 130]) recorder.record('ocr', ms);
    for (const ms of [2, 2, 3, 3, 4]) recorder.record('diff', ms);

    const byStage = new Map(recorder.snapshot().map((s) => [s.stage, s]));
    expect(byStage.get('ocr')?.overBudget).toBe(true);
    expect(byStage.get('ocr')?.budgetMs).toBe(STAGE_BUDGETS.ocr.budgetMs);
    expect(byStage.get('diff')?.overBudget).toBe(false);
  });

  it('ignores samples that are not durations', () => {
    const recorder = new MetricsRecorder();
    recorder.record('ocr', Number.NaN);
    recorder.record('ocr', -1);
    recorder.record('ocr', Number.POSITIVE_INFINITY);

    expect(recorder.snapshot()).toEqual([]);
  });

  it('times a stage with the clock it was given', () => {
    let now = 1_000;
    const recorder = new MetricsRecorder({ now: () => now });

    const stop = recorder.start('group');
    now = 1_007;
    expect(stop()).toBe(7);

    now = 2_000;
    recorder.measure('render', () => {
      now = 2_012;
    });

    const byStage = new Map(recorder.snapshot().map((s) => [s.stage, s]));
    expect(byStage.get('group')?.p50).toBe(7);
    expect(byStage.get('render')?.p50).toBe(12);
  });

  it('records an async stage even when it rejects', async () => {
    let now = 0;
    const recorder = new MetricsRecorder({ now: () => now });

    await expect(
      recorder.measureAsync('translate', async () => {
        now = 480;
        throw new Error('engine down');
      }),
    ).rejects.toThrow('engine down');

    expect(recorder.snapshot()[0]).toMatchObject({ stage: 'translate', p50: 480 });
  });

  it('formats a summary that can be read against the budget table', () => {
    const recorder = new MetricsRecorder();
    for (let i = 0; i < 10; i += 1)
      recorder.recordFrameTimings({ captureUs: 12_000, diffUs: 3_000, ocrUs: (58 + i * 6) * 1000 });

    const text = recorder.format();

    expect(text).toContain('design doc section 4');
    expect(text).toContain('budget');
    for (const stage of ['capture', 'diff', 'ocr']) expect(text).toContain(stage);
    expect(text).toContain('OVER (OCR)'); // p90 = 112ms against an 80ms row
    // Every stage has a budget on record, so the table can never have a blank column.
    for (const stage of PIPELINE_STAGES) expect(STAGE_BUDGETS[stage].budgetMs).toBeGreaterThan(0);
  });

  it('says so plainly when there is nothing to report', () => {
    expect(new MetricsRecorder().format()).toBe('latency: no samples yet');
  });

  it('drops every sample on reset', () => {
    const recorder = new MetricsRecorder();
    recorder.record('ocr', 50);
    recorder.reset();

    expect(recorder.snapshot()).toEqual([]);
  });
});

describe('startMetricsSummary', () => {
  it('logs a summary on a timer and stops when told', () => {
    vi.useFakeTimers();
    try {
      const recorder = new MetricsRecorder();
      const { logger, lines } = collectingLogger();
      const stop = startMetricsSummary(recorder, logger, 1_000);

      // Nothing measured yet: a summary of nothing is noise, so none is written.
      vi.advanceTimersByTime(1_000);
      expect(lines).toHaveLength(0);

      recorder.recordFrameTimings({ captureUs: 12_000, diffUs: 3_000, ocrUs: 58_000 });
      vi.advanceTimersByTime(1_000);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.message).toContain('capture');
      expect(lines[0]?.fields?.['metrics']).toHaveLength(3);

      stop();
      vi.advanceTimersByTime(5_000);
      expect(lines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
