/**
 * The drag arithmetic, on its own so it can be tested without a DOM (issue M6-02 / #29).
 *
 * Separate from `region-picker.ts` because that module wires up event listeners the moment it
 * is imported. A test that wants to assert what a right-to-left drag produces should not have
 * to stand up a document to find out.
 */

import type { PickerRect } from './contract.js';

export interface DragPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Turn two corners into a rectangle with a non-negative size.
 *
 * The reason this is a named function and not two subtractions at the call site is the
 * acceptance criterion that a drag which runs right-to-left or bottom-to-top produces a correct
 * rectangle. Written inline, that case comes out as a negative width, which CSS refuses to draw
 * and `regionSchema` refuses to validate - so the bug shows up as a picker that appears to do
 * nothing when dragged in one of the two diagonal directions, which is easy to never try.
 */
export function normalizeDrag(anchor: DragPoint, cursor: DragPoint): PickerRect {
  const x = Math.min(anchor.x, cursor.x);
  const y = Math.min(anchor.y, cursor.y);
  return {
    x,
    y,
    width: Math.abs(cursor.x - anchor.x),
    height: Math.abs(cursor.y - anchor.y),
  };
}

/**
 * Keep a point inside the picker window.
 *
 * The pointer can leave the window - a fast drag outruns the compositor, and on a multi-monitor
 * desktop it can genuinely cross onto the next screen. Without this the selection extends past
 * the display it belongs to and converts to a region the monitor does not contain.
 */
export function clampToWindow(point: DragPoint, width: number, height: number): DragPoint {
  return {
    x: Math.min(Math.max(point.x, 0), width),
    y: Math.min(Math.max(point.y, 0), height),
  };
}

/**
 * The selection's size in physical px - what the sidecar will crop and what the user's monitor
 * actually has.
 *
 * Rounded outward to match `toPhysicalRegion`, so the number shown during the drag is the
 * number the region ends up being rather than one pixel less. This is a read-out only; the
 * authoritative conversion happens in the main process (invariant 3).
 */
export function physicalSize(rect: PickerRect, scaleFactor: number): readonly [number, number] {
  return [Math.ceil(rect.width * scaleFactor), Math.ceil(rect.height * scaleFactor)];
}
