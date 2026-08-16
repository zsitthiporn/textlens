/**
 * A fixed pool of pre-created overlay boxes (issue M5-01, feature U5).
 *
 * The overlay redraws whenever the sidecar reports a changed frame - for subtitles, every two or
 * three seconds, indefinitely, in a process the user leaves running for hours. Creating and
 * destroying elements on that schedule hands the garbage collector a steady drip of DOM nodes
 * and hands the style engine a fresh subtree to resolve every time. Both cost happen inside the
 * 16ms render budget.
 *
 * So every box this overlay will ever draw is created **once**, at construction, and after that
 * the render loop only ever writes text and styles into elements that already exist. The
 * acceptance criterion is stated as "no DOM nodes created after init, count children", and
 * {@link BoxPool.created} is the counter that makes it checkable from a test rather than from
 * reading the code and believing it.
 *
 * ## Why `create` and `attach` are injected
 *
 * The pool never names `document`. It is handed two closures and calls them exactly `capacity`
 * times between them. That has one practical consequence and one honest one:
 *
 *   - the pool's behaviour is testable under plain `vitest` in a Node environment, with no jsdom
 *     dependency, because the test supplies its own factory and counts the calls;
 *   - a test that counts calls to an injected factory cannot be fooled by an implementation that
 *     reaches for a global `document` instead - in the Node test environment there is no global
 *     `document`, so that implementation throws rather than passing quietly.
 *
 * jsdom would not have helped here anyway: it has no layout engine, so it cannot answer any of
 * the questions M5-02 and M5-03 actually ask (does Thai wrap mid-word, is a stacked tone mark
 * clipped, how tall did this box really come out). Those are verified against real Chromium in
 * `tests/main/overlay/`.
 *
 * ## Exhaustion is truncation, in payload order
 *
 * More blocks than the pool holds is a normal screen, not an error: the acceptance criterion is
 * "render what fits, no crash". The extra blocks are dropped from the **end** of the payload,
 * because deciding *which* translations deserve the space when the screen is full is the area
 * budget - feature U4, issue #27 - and inventing a ranking here would be a second, quieter
 * implementation of it that #27 would then have to find and remove.
 */

/** The subset of `CSSStyleDeclaration` the overlay writes. A real one satisfies this. */
export interface BoxStyle {
  /** Position is set through `transform` only - never `left`/`top`. See {@link BoxPool}. */
  transform: string;
  visibility: string;
  width: string;
  display: string;
  opacity: string;
}

/** The subset of `HTMLElement` the overlay uses. A real one satisfies this structurally. */
export interface PooledBox {
  readonly style: BoxStyle;
  textContent: string | null;
  /** Carries `lang` (which drives Thai line breaking, H3) and `data-origin`. */
  setAttribute(name: string, value: string): void;
  getBoundingClientRect(): { readonly width: number; readonly height: number };
}

export interface BoxPoolOptions<E extends PooledBox> {
  /** How many boxes exist for the lifetime of the overlay. */
  readonly capacity: number;
  /** Called exactly `capacity` times, all of them during construction. */
  readonly create: () => E;
  /** Called once per created box, to put it in the document. */
  readonly attach: (box: E) => void;
}

export const DEFAULT_POOL_CAPACITY = 48;

export class BoxPool<E extends PooledBox> {
  readonly #boxes: readonly E[];
  #created = 0;
  #active = 0;

  constructor(options: BoxPoolOptions<E>) {
    const { capacity, create, attach } = options;
    if (!Number.isInteger(capacity) || capacity < 1) {
      // Invariant 4: capacity 0 would make every render a no-op - an overlay that draws nothing,
      // reports nothing, and looks exactly like a translation engine that is down.
      throw new RangeError(`capacity must be a positive integer, got ${String(capacity)}`);
    }

    const boxes: E[] = [];
    for (let index = 0; index < capacity; index += 1) {
      const box = create();
      this.#created += 1;
      box.style.display = 'none';
      box.style.visibility = 'hidden';
      attach(box);
      boxes.push(box);
    }
    this.#boxes = boxes;
  }

  get capacity(): number {
    return this.#boxes.length;
  }

  /**
   * How many times the element factory has been called, ever.
   *
   * Equal to `capacity` immediately after construction and never rises again. A test asserts
   * that across many renders; that assertion is the acceptance criterion.
   */
  get created(): number {
    return this.#created;
  }

  /** How many boxes the last {@link take} handed out. */
  get activeCount(): number {
    return this.#active;
  }

  /** Every box, active or not. For tests and for the whole-pool reset paths. */
  get boxes(): readonly E[] {
    return this.#boxes;
  }

  /**
   * Claim the first `count` boxes for this render and retire the rest.
   *
   * Retired boxes go to `display: none` rather than `visibility: hidden`: a hidden box still
   * takes part in layout, so a pool of 48 mostly-unused boxes would otherwise contribute 48
   * boxes' worth of work to every measurement pass M5-03 performs.
   *
   * @returns the claimed boxes, at most `capacity` of them.
   */
  take(count: number): readonly E[] {
    const wanted = Number.isFinite(count) ? Math.max(Math.trunc(count), 0) : 0;
    const granted = Math.min(wanted, this.#boxes.length);

    for (let index = granted; index < this.#boxes.length; index += 1) {
      const box = this.#boxes[index];
      if (box === undefined) continue;
      box.style.display = 'none';
      box.style.visibility = 'hidden';
      box.textContent = '';
    }

    this.#active = granted;
    return this.#boxes.slice(0, granted);
  }

  /** Retire every box. Used when a frame produced nothing to draw. */
  hideAll(): void {
    this.take(0);
  }
}
