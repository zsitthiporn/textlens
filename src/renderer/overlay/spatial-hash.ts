/**
 * A uniform-grid spatial index over axis-aligned rectangles (issue M5-04, feature U3).
 *
 * Placement asks "does this candidate position hit anything already placed?" once per candidate,
 * and there are up to `1 + 1 + 1 + nudges` candidates per box. Comparing every candidate against
 * every placed box is O(n^2) in the box count *multiplied* by the candidate count, and the
 * candidate count is the part that is easy to forget - a screen of 30 boxes that each try eight
 * positions is 30 * 8 * 30 = 7200 rectangle tests in the naive form, inside a 16ms frame that
 * also has to do layout.
 *
 * The grid turns that into "look only at boxes that share a cell with the candidate". It is a
 * broad-phase filter, not an answer: {@link SpatialHash.intersects} still runs an exact overlap
 * test on every candidate the grid returns. The grid can only ever produce false *positives*
 * (same cell, no overlap), never false negatives, so correctness does not depend on the cell
 * size and only speed does.
 *
 * ## Determinism
 *
 * M8's sticky placement reuses positions across frames, which is only stable if identical input
 * produces identical output every time (issue M5-04's last acceptance criterion). Nothing here
 * may leak container ordering into a result, so this class exposes exactly one query and it
 * returns a **boolean**. There is no `query()` that hands back a list whose order would come
 * from `Map` iteration and quietly become part of the placement algorithm's behaviour.
 *
 * `#comparisons` is the evidence for the O(n) claim rather than a decoration: a test can place
 * 30 boxes and assert the exact-test count stays far below the quadratic figure, which is a
 * measurement a wall-clock benchmark on a fast machine would not catch.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Roughly the height of a two-line translation box at the default size. Cells much smaller than
 * the objects they index cost more bucket writes than they save comparisons; much larger and
 * every box shares a cell with every neighbour and the grid degenerates to a linear scan.
 */
export const DEFAULT_CELL_SIZE = 128;

/** True when two rectangles share any interior area. Touching edges do not count as overlap. */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export class SpatialHash {
  readonly #cellSize: number;
  /** `"cx:cy"` -> the rectangles overlapping that cell. A rectangle appears in every cell it spans. */
  readonly #buckets = new Map<string, Rect[]>();
  #comparisons = 0;

  constructor(cellSize: number = DEFAULT_CELL_SIZE) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      // Invariant 4: a cell size of 0 makes every index NaN or Infinity, every bucket key the
      // same string, and the whole grid silently degrade into "everything collides with
      // everything" - which reads as "anti-overlap is very aggressive today", not as a bug.
      throw new RangeError(`cellSize must be a positive finite number, got ${String(cellSize)}`);
    }
    this.#cellSize = cellSize;
  }

  /** Exact rectangle-vs-rectangle tests performed so far. The O(n) claim's evidence. */
  get comparisons(): number {
    return this.#comparisons;
  }

  /** Distinct occupied cells. Diagnostics only - never an input to placement. */
  get cellCount(): number {
    return this.#buckets.size;
  }

  insert(rect: Rect): void {
    for (const key of this.#keysFor(rect)) {
      const bucket = this.#buckets.get(key);
      if (bucket === undefined) this.#buckets.set(key, [rect]);
      else bucket.push(rect);
    }
  }

  /**
   * True when `rect` overlaps anything already inserted.
   *
   * A rectangle spanning several cells can be reached through more than one of them, so each
   * candidate is exact-tested at most once per cell it shares. That is a constant factor, not a
   * correctness problem - the first `true` returns immediately.
   */
  intersects(rect: Rect): boolean {
    for (const key of this.#keysFor(rect)) {
      const bucket = this.#buckets.get(key);
      if (bucket === undefined) continue;
      for (const other of bucket) {
        this.#comparisons += 1;
        if (overlaps(rect, other)) return true;
      }
    }
    return false;
  }

  clear(): void {
    this.#buckets.clear();
    this.#comparisons = 0;
  }

  /**
   * Every cell key `rect` touches.
   *
   * A zero-width or zero-height rectangle still occupies its origin cell. It can never overlap
   * anything (`overlaps` requires interior area), so including it costs one wasted comparison
   * and excluding it would make `insert` silently drop a box that placement believes it placed.
   */
  *#keysFor(rect: Rect): Generator<string> {
    const size = this.#cellSize;
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return;

    const width = Number.isFinite(rect.width) ? Math.max(rect.width, 0) : 0;
    const height = Number.isFinite(rect.height) ? Math.max(rect.height, 0) : 0;

    const minX = Math.floor(rect.x / size);
    const minY = Math.floor(rect.y / size);
    // The far edge is exclusive: a rectangle ending exactly on a cell boundary does not enter
    // the next cell, matching `overlaps` treating touching edges as not overlapping.
    const maxX = Math.floor((rect.x + Math.max(width - Number.EPSILON, 0)) / size);
    const maxY = Math.floor((rect.y + Math.max(height - Number.EPSILON, 0)) / size);

    for (let cy = minY; cy <= maxY; cy += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        yield `${String(cx)}:${String(cy)}`;
      }
    }
  }
}
