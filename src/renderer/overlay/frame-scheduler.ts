/**
 * Coalesce many updates into one render per animation frame (issue M5-01, feature U5).
 *
 * The pipeline emits up to twice per frame - once with the cache hits, once with everything
 * (`OverlayPayload.complete`) - and the sidecar can deliver frames faster than the compositor
 * paints. Rendering each arrival immediately would lay out the overlay two or three times for
 * one visible result, inside a 16ms budget.
 *
 * The rule is **last one wins**: whatever arrived most recently before the frame fires is what
 * gets drawn, and the earlier arrivals are dropped without being rendered. That is safe here for
 * a specific reason rather than by luck - `OverlayPayload` is documented as carrying the *whole*
 * set every time, not a delta, so a dropped payload leaves nothing unrendered. If that ever
 * changed to a delta, this scheduler would silently lose text, so the assumption is stated here
 * where the dropping happens.
 *
 * Separated from `overlay.ts` because that file reaches for `document` at module scope and so
 * cannot be imported by a Node-environment test at all, while this behaviour - "three updates in
 * one frame produce one render" - is exactly the kind of thing a test should pin.
 */

/** The `requestAnimationFrame` shape. The DOM global satisfies it. */
export type ScheduleFrame = (callback: () => void) => unknown;

export interface FrameScheduler<T> {
  /** Queue `value` for the next frame, replacing anything already queued. */
  submit(value: T): void;
  /** Whether a frame is already booked. */
  readonly pending: boolean;
  /** Renders (not submissions) performed so far. */
  readonly renders: number;
}

export function createFrameScheduler<T>(
  requestFrame: ScheduleFrame,
  render: (value: T) => void,
): FrameScheduler<T> {
  let queued: { value: T } | null = null;
  let booked = false;
  let renders = 0;

  const flush = (): void => {
    booked = false;
    const next = queued;
    queued = null;
    if (next === null) return;
    renders += 1;
    render(next.value);
  };

  return {
    submit(value: T): void {
      // Replace, never append: see "last one wins" above.
      queued = { value };
      if (booked) return;
      booked = true;
      requestFrame(flush);
    },
    get pending(): boolean {
      return booked;
    },
    get renders(): number {
      return renders;
    },
  };
}
