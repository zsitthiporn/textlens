/**
 * Test doubles for the overlay renderer (issues M5-01 .. M5-04).
 *
 * ## Why a hand-written fake and not jsdom
 *
 * jsdom is installed in this repo but is deliberately not used here, and the reason matters more
 * than the dependency does: **jsdom has no layout engine**. `getBoundingClientRect` returns zeros
 * for everything, there is no ICU line breaker, and no font is ever resolved. A jsdom test of
 * "the box is three lines tall" or "Thai did not break mid-word" passes without discriminating
 * between a correct implementation and one that does nothing - the exact tautology this suite is
 * supposed to rule out. Those questions are answered against real Chromium in
 * `tests/main/overlay/chromium.test.ts`.
 *
 * What *is* answerable without a layout engine is everything that is bookkeeping: does the pool
 * ever create a second batch of nodes, does the renderer read geometry exactly once per render,
 * does placement produce identical output for identical input. That is what these fakes serve.
 *
 * ## The operation log is the point
 *
 * {@link FakeBox} records every style write and every geometry read into a shared array, in the
 * order they happen. `RenderStats.phaseLog` reports the same thing, but it is written by the code
 * under test and would keep agreeing with itself if the phases were interleaved tomorrow. This
 * log is written by the *fake*, from the outside, so it can contradict the implementation.
 */

import type { BoxStyle, PooledBox } from '../../../src/renderer/overlay/node-pool.js';

export type Op = 'write' | 'read';

/** Collapses a raw operation log to its phase transitions: the shape a render should have. */
export function phases(log: readonly Op[]): Op[] {
  const collapsed: Op[] = [];
  for (const op of log) {
    if (collapsed[collapsed.length - 1] !== op) collapsed.push(op);
  }
  return collapsed;
}

class FakeStyle implements BoxStyle {
  #transform = '';
  #visibility = '';
  #width = '';
  #display = '';
  #opacity = '';

  constructor(private readonly log: Op[]) {}

  get transform(): string {
    return this.#transform;
  }
  set transform(value: string) {
    this.log.push('write');
    this.#transform = value;
  }

  get visibility(): string {
    return this.#visibility;
  }
  set visibility(value: string) {
    this.log.push('write');
    this.#visibility = value;
  }

  get width(): string {
    return this.#width;
  }
  set width(value: string) {
    this.log.push('write');
    this.#width = value;
  }

  get display(): string {
    return this.#display;
  }
  set display(value: string) {
    this.log.push('write');
    this.#display = value;
  }

  get opacity(): string {
    return this.#opacity;
  }
  set opacity(value: string) {
    this.log.push('write');
    this.#opacity = value;
  }
}

/**
 * How tall a box comes out.
 *
 * Supplied per test rather than modelled, because any model here would be the very
 * character-count guess M5-03 exists to replace - and a test built on it could not tell a
 * correct implementation from one that made the same guess.
 */
export type HeightModel = (text: string, width: number) => number;

export class FakeBox implements PooledBox {
  readonly style: BoxStyle;
  readonly attributes = new Map<string, string>();
  #text: string | null = null;
  /** Geometry reads performed on this box. */
  reads = 0;

  constructor(
    private readonly log: Op[],
    private readonly heightOf: HeightModel,
  ) {
    this.style = new FakeStyle(log);
  }

  get textContent(): string | null {
    return this.#text;
  }
  set textContent(value: string | null) {
    this.log.push('write');
    this.#text = value;
  }

  setAttribute(name: string, value: string): void {
    this.log.push('write');
    this.attributes.set(name, value);
  }

  getBoundingClientRect(): { readonly width: number; readonly height: number } {
    this.log.push('read');
    this.reads += 1;
    const width = Number.parseFloat(this.style.width) || 0;
    return { width, height: this.heightOf(this.#text ?? '', width) };
  }

  /** The `translate3d(Xpx, Ypx, 0)` the renderer wrote, parsed back. `null` if never positioned. */
  position(): { x: number; y: number } | null {
    const match = /^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\)$/.exec(this.style.transform);
    if (match === null) return null;
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  get visible(): boolean {
    return this.style.display !== 'none' && this.style.visibility === 'visible';
  }
}

export interface FakePool {
  readonly log: Op[];
  readonly boxes: readonly FakeBox[];
  /** Calls to the element factory. The "no DOM nodes after init" counter. */
  readonly createCalls: () => number;
  readonly attachCalls: () => number;
}

/** Builds the `create`/`attach` closures a `BoxPool` needs, plus the counters a test asserts on. */
export function fakeFactory(heightOf: HeightModel): {
  readonly log: Op[];
  readonly boxes: FakeBox[];
  create: () => FakeBox;
  attach: (box: FakeBox) => void;
  createCalls: () => number;
  attachCalls: () => number;
} {
  const log: Op[] = [];
  const boxes: FakeBox[] = [];
  let creates = 0;
  let attaches = 0;

  return {
    log,
    boxes,
    create: () => {
      creates += 1;
      const box = new FakeBox(log, heightOf);
      boxes.push(box);
      return box;
    },
    attach: () => {
      attaches += 1;
    },
    createCalls: () => creates,
    attachCalls: () => attaches,
  };
}
