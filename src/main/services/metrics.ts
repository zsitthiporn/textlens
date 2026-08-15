/**
 * Per-stage timing metrics (issue M10-03, feature L3).
 *
 * Design doc section 4 states the latency budget as numbers, which is only useful if the
 * real numbers are collected the same way. This module is that collection: one bounded
 * sample ring per stage, percentiles on demand, and a periodic summary laid out against
 * the budget so "we are over" comes with "here is which stage".
 *
 * It records durations and nothing else. No text, no bboxes, no ids that could identify
 * what was on screen - which is why the summary is safe to log at the default level
 * (PR3), and why this module never needs the `sensitive` channel.
 */

import type { FrameTimings } from '../../shared/protocol.js';
import type { Logger } from './logger.js';

/**
 * Every stage in the pipeline as designed. Stages that do not exist yet are listed
 * anyway: a stage with no samples is simply absent from the summary, and having the
 * name here means the module that eventually implements it has nothing to add.
 */
export const PIPELINE_STAGES = [
  'capture',
  'diff',
  'ocr',
  'ipc',
  'group',
  'translate',
  'render',
  'total',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * The budget from design doc section 4, upper bound of each row.
 *
 * `capture` and `diff` share one 15ms row, so comparing each against 15 is lenient by
 * construction - a stage that breaches it individually is unambiguously over.
 */
export const STAGE_BUDGETS: Readonly<Record<PipelineStage, { readonly budgetMs: number; readonly row: string }>> = {
  capture: { budgetMs: 15, row: 'capture + diff' },
  diff: { budgetMs: 15, row: 'capture + diff' },
  ocr: { budgetMs: 80, row: 'OCR' },
  ipc: { budgetMs: 5, row: 'IPC -> Node' },
  group: { budgetMs: 5, row: 'group + filter + dedup' },
  translate: { budgetMs: 500, row: 'translate (cache miss)' },
  render: { budgetMs: 16, row: 'render' },
  total: { budgetMs: 600, row: 'total' },
};

export interface StageStats {
  readonly stage: PipelineStage;
  /** Samples observed since the last reset - may exceed the number retained. */
  readonly count: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
  readonly budgetMs: number;
  /** True when p90 is over budget. p90 rather than p50: the budget is about the tail. */
  readonly overBudget: boolean;
}

export interface MetricsRecorderOptions {
  /** Samples retained per stage. Bounded so a long session cannot grow without limit. */
  readonly sampleCap?: number;
  /** Injected in tests. Defaults to a monotonic clock, never `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_SAMPLE_CAP = 512;

/** A fixed-size ring. Overwrites oldest; never allocates after construction. */
class SampleRing {
  readonly #values: Float64Array;
  #next = 0;
  #filled = 0;
  #total = 0;

  constructor(capacity: number) {
    this.#values = new Float64Array(capacity);
  }

  add(value: number): void {
    this.#values[this.#next] = value;
    this.#next = (this.#next + 1) % this.#values.length;
    if (this.#filled < this.#values.length) this.#filled += 1;
    this.#total += 1;
  }

  /** How many samples were ever added, including those already overwritten. */
  get total(): number {
    return this.#total;
  }

  get retained(): number {
    return this.#filled;
  }

  sorted(): number[] {
    return [...this.#values.subarray(0, this.#filled)].sort((a, b) => a - b);
  }
}

/**
 * Nearest-rank percentile: the smallest sample at or above the requested fraction.
 * No interpolation - an interpolated p90 is a number no single frame ever took, which
 * is unhelpful when the question is "did any frame blow the budget".
 */
export function percentile(sortedAscending: readonly number[], fraction: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

export class MetricsRecorder {
  readonly #rings = new Map<PipelineStage, SampleRing>();
  readonly #cap: number;
  readonly #now: () => number;

  constructor(options: MetricsRecorderOptions = {}) {
    this.#cap = options.sampleCap ?? DEFAULT_SAMPLE_CAP;
    this.#now = options.now ?? (() => performance.now());
  }

  record(stage: PipelineStage, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let ring = this.#rings.get(stage);
    if (ring === undefined) {
      ring = new SampleRing(this.#cap);
      this.#rings.set(stage, ring);
    }
    ring.add(ms);
  }

  /**
   * Fold in the three stages the sidecar measured for us (`FrameEvent.timings`).
   *
   * The wire carries microseconds and this module works in milliseconds, so the
   * conversion happens here and only here. The wire is µs because capture is p50 ~0.574ms
   * and an integer millisecond would report it as 0 forever; the budgets stay ms because
   * design doc section 4 is written in ms and that table is the thing people read.
   */
  recordFrameTimings(timings: FrameTimings): void {
    this.record('capture', timings.captureUs / 1000);
    this.record('diff', timings.diffUs / 1000);
    this.record('ocr', timings.ocrUs / 1000);
  }

  /**
   * Start timing a Node-side stage. The returned function stops it, records it and
   * hands back the elapsed ms - so a caller can log the one-off value as well.
   */
  start(stage: PipelineStage): () => number {
    const startedAt = this.#now();
    return () => {
      const elapsed = this.#now() - startedAt;
      this.record(stage, elapsed);
      return elapsed;
    };
  }

  /** Time a synchronous stage. */
  measure<T>(stage: PipelineStage, work: () => T): T {
    const stop = this.start(stage);
    try {
      return work();
    } finally {
      stop();
    }
  }

  /** Time an asynchronous stage. */
  async measureAsync<T>(stage: PipelineStage, work: () => Promise<T>): Promise<T> {
    const stop = this.start(stage);
    try {
      return await work();
    } finally {
      stop();
    }
  }

  /** Stats for every stage that has at least one sample, in pipeline order. */
  snapshot(): StageStats[] {
    const stats: StageStats[] = [];
    for (const stage of PIPELINE_STAGES) {
      const ring = this.#rings.get(stage);
      if (ring === undefined || ring.retained === 0) continue;

      const sorted = ring.sorted();
      const p50 = percentile(sorted, 0.5);
      const p90 = percentile(sorted, 0.9);
      const budgetMs = STAGE_BUDGETS[stage].budgetMs;

      stats.push({
        stage,
        count: ring.total,
        p50: round1(p50),
        p90: round1(p90),
        max: round1(sorted[sorted.length - 1] ?? 0),
        budgetMs,
        overBudget: p90 > budgetMs,
      });
    }
    return stats;
  }

  /** Drop every sample. Used when the pipeline restarts and old numbers stop meaning anything. */
  reset(): void {
    this.#rings.clear();
  }

  /**
   * A fixed-width table, budget column included, so the summary can be read against
   * design doc section 4 without going and looking the numbers up.
   */
  format(): string {
    const stats = this.snapshot();
    if (stats.length === 0) return 'latency: no samples yet';

    const header = ['stage', 'n', 'p50', 'p90', 'max', 'budget', ''].map((h, i) => h.padEnd(COLUMNS[i] ?? 0));
    const rows = stats.map((s) =>
      [
        s.stage,
        String(s.count),
        s.p50.toFixed(1),
        s.p90.toFixed(1),
        s.max.toFixed(1),
        String(s.budgetMs),
        s.overBudget ? `OVER (${STAGE_BUDGETS[s.stage].row})` : 'ok',
      ]
        .map((cell, i) => cell.padEnd(COLUMNS[i] ?? 0))
        .join('')
        .trimEnd(),
    );

    return ['latency vs design doc section 4 budget (ms)', header.join('').trimEnd(), ...rows].join('\n');
  }
}

const COLUMNS = [11, 7, 8, 8, 8, 8, 0];

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Log a summary every `intervalMs`. Returns the stopper.
 *
 * The timer is unref'd: metrics must never be the reason the process stays alive.
 * The table goes in the message and the same numbers go in the fields, so the file is
 * both readable by a person and parseable by a script.
 */
export function startMetricsSummary(
  recorder: MetricsRecorder,
  logger: Logger,
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    const stats = recorder.snapshot();
    if (stats.length === 0) return;
    logger.info(recorder.format(), { metrics: stats });
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
