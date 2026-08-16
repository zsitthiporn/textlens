/**
 * Test doubles for the translator stage.
 *
 * Not a `.test.ts`, so vitest does not collect it; `tsconfig.test.json` still type-checks it.
 *
 * The engines here tag their output with their own name (`primary(hello)`), which is deliberate:
 * a fallback test where both engines return the same string cannot distinguish "the fallback
 * ran" from "the primary ran", so it proves nothing about the chain. Every assertion about
 * *which* engine answered is made against a tagged string, the outcome's `engine` field, and
 * the recorded call counts together.
 */

import type { HealthCheckResult, TranslationEngine } from '../../../src/main/services/translator/types.js';
import type { LogFields, Logger } from '../../../src/main/services/logger.js';

export interface RecordedCall {
  readonly texts: string[];
  readonly src: string;
  readonly tgt: string;
}

export type BatchHandler = (texts: string[], src: string, tgt: string) => string[] | Promise<string[]>;

export class FakeEngine implements TranslationEngine {
  readonly calls: RecordedCall[] = [];
  healthCalls = 0;
  health: HealthCheckResult = { ok: true };
  handler: BatchHandler;

  constructor(
    readonly name: string,
    handler?: BatchHandler,
  ) {
    this.handler = handler ?? ((texts) => texts.map((text) => `${name}(${text})`));
  }

  get callCount(): number {
    return this.calls.length;
  }

  async translateBatch(texts: string[], src: string, tgt: string): Promise<string[]> {
    this.calls.push({ texts: [...texts], src, tgt });
    return this.handler(texts, src, tgt);
  }

  async healthCheck(): Promise<HealthCheckResult> {
    this.healthCalls += 1;
    return this.health;
  }
}

export interface LoggedLine {
  readonly level: 'error' | 'warn' | 'info' | 'debug' | 'sensitive';
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * A logger that keeps everything, so a test can assert on what reached the log - including
 * asserting that screen text did *not*.
 */
export class RecordingLogger implements Logger {
  readonly lines: LoggedLine[] = [];
  readonly isDebugEnabled = false;
  readonly level = 'info' as const;

  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, fields: fields ?? {} });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, fields: fields ?? {} });
  }
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, fields: fields ?? {} });
  }
  debug(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', message, fields: fields ?? {} });
  }
  sensitive(message: string, text: string, fields?: LogFields): void {
    this.lines.push({ level: 'sensitive', message, fields: { ...fields, text } });
  }
  child(): Logger {
    // Same sink, so a test sees lines written through a child scope too.
    return this;
  }

  /** Everything written at a level that reaches disk by default, flattened for scanning. */
  defaultLevelText(): string {
    return this.lines
      .filter((line) => line.level !== 'debug' && line.level !== 'sensitive')
      .map((line) => `${line.message} ${JSON.stringify(line.fields)}`)
      .join('\n');
  }
}

/** A controllable clock plus a sleep that advances it. For the rate limiter's timing tests. */
export class FakeClock {
  #now: number;
  /** Every sleep the code under test asked for, in order. */
  readonly sleeps: number[] = [];

  constructor(start = 0) {
    this.#now = start;
  }

  now = (): number => this.#now;

  /** Injected as the limiter's `sleep`: records the request and moves the clock. */
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.#now += ms;
    await Promise.resolve();
  };

  /** Move time without anyone sleeping - simulates real time passing between frames. */
  advance(ms: number): void {
    this.#now += ms;
  }
}
