/**
 * The one place scale arithmetic is allowed to exist (issue M3-01, CLAUDE.md invariant 3).
 *
 * The reference project shipped a DPI bug by using physical px straight as CSS px. On a
 * 100% display that is invisible - which is the whole problem, and why this module exists
 * as a separately testable unit rather than as three lines inside the frame handler.
 *
 * The pipeline has three coordinate spaces (design doc section 3):
 *
 *   - **physical px**, region-relative - what the sidecar puts in `OcrLine.bbox`
 *   - **logical px**, virtual-desktop-relative - what this module produces
 *   - **CSS px**, overlay-window-relative - the renderer's job, not this module's
 *
 * ## Where the logical origin comes from, and why not from the wire
 *
 *     logicalX = (regionX + bboxX) / scaleFactor + display.bounds.x
 *
 * `display` is the Electron `Display`, and **`frame.monitor.bounds` is deliberately not an
 * input here.** That field is raw physical px from Win32, and when displays differ in DPI a
 * logical origin cannot be derived from a physical one at all: Chromium lays displays out
 * adjacent in DIP space rather than dividing each physical rect by its own scale.
 *
 * > Display A 3840x2160 @200% at physical (0,0); display B 1920x1080 @100% at physical
 * > (3840,0). Electron reports B at DIP x=**1920**, while `3840 / 1.0` says **3840**.
 *
 * So the wire's `monitor.bounds` is diagnostic only, and this module cannot use it even by
 * accident - it is not in any signature. Ruled 2026-08-16, design doc section 3.
 *
 * The scale comes from the same place for the same reason: the target space *is* Chromium's
 * DIP layout, so it is Chromium's `scaleFactor` that defines it. `frame.monitor.scale` is
 * Win32's opinion of the same number and should agree - asserting that they do is pairing
 * logic, and belongs where the display is paired to the monitor (M6-01 / issue #28).
 *
 * ## No rounding
 *
 * Output is exact fractional logical px. Quantization already has a downstream owner - the
 * renderer's anchor snapping (design doc section 5) - and rounding here would be the wrong
 * layer twice over: it discards precision the CSS layer can use, and independently rounding
 * each rect's origin and size lets adjacent boxes drift apart. Three physically adjacent
 * 13px boxes at scale 1.25 come out of a rounding implementation with a 1px gap between the
 * second and the third; converted exactly, they still touch.
 *
 * Deliberately not here: anything that reads `OcrLine`. This module converts rectangles.
 */

import type { Rect } from '../../shared/protocol.js';

/**
 * The part of an Electron `Display` this module needs.
 *
 * Structural rather than imported so that both the converter and its tests run in plain
 * Node without Electron: an `Electron.Display` satisfies this shape as-is, and a test can
 * fabricate a 200% display that no attached monitor could provide. Only `bounds.x`/`bounds.y`
 * and `scaleFactor` are declared, because those are the only fields the maths touches.
 *
 * `bounds` is in **logical px** (DIP), absolute on the virtual desktop - Electron's own
 * units. `bounds.x` is legitimately negative for a display left of primary.
 */
export interface DisplayGeometry {
  readonly bounds: {
    readonly x: number;
    readonly y: number;
  };
  /** Chromium's DIP scale for this display: 1.0 / 1.25 / 1.5 / 2.0. Must be > 0. */
  readonly scaleFactor: number;
}

/**
 * A rectangle in logical px, absolute on the virtual desktop.
 *
 * An object rather than the wire's `Rect` tuple, on purpose: the two are structurally
 * incompatible, so a physical rect cannot be passed where a logical one is expected and a
 * logical one cannot be written back onto the wire. The type system carries the unit.
 */
export interface LogicalRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Convert one OCR bounding box from physical px (region-relative) to logical px
 * (virtual-desktop-relative).
 *
 * @param bbox    `OcrLine.bbox` - physical px, relative to the region's top-left.
 * @param region  `FrameEvent.region` - physical px, relative to the monitor's top-left.
 * @param display The Electron `Display` the region was captured from. Supplies both the
 *                logical origin and the scale; see the module comment for why neither may
 *                come from `frame.monitor`.
 */
export function toLogicalRect(bbox: Rect, region: Rect, display: DisplayGeometry): LogicalRect {
  const { scaleFactor } = display;
  // Invariant 4: a scale of 0 or NaN would yield Infinity/NaN coordinates and place every
  // translation box nowhere, silently. Refuse loudly instead.
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new RangeError(`display.scaleFactor must be a positive finite number, got ${String(scaleFactor)}`);
  }

  const [regionX, regionY] = region;
  const [bboxX, bboxY, bboxWidth, bboxHeight] = bbox;

  // Region offset is applied in physical px - both are physical, and both are relative to
  // the same monitor - and only the sum is scaled. Scaling them separately would round
  // twice even in an implementation that rounds.
  return {
    x: (regionX + bboxX) / scaleFactor + display.bounds.x,
    y: (regionY + bboxY) / scaleFactor + display.bounds.y,
    width: bboxWidth / scaleFactor,
    height: bboxHeight / scaleFactor,
  };
}

/**
 * A rectangle in CSS px, relative to the top-left of the window that reported it.
 *
 * Distinct from {@link LogicalRect} on purpose, even though a CSS px and a logical px are the
 * same size: they are measured from different origins. Conflating them is how a region picked
 * on the left-hand monitor ends up applied to the primary one, and on a single-display machine
 * that mistake is invisible because the origin it forgets to add is `(0, 0)`.
 */
export interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The inverse of {@link toLogicalRect}: a rectangle the user dragged in a window, expressed as
 * the physical-px region the sidecar will crop with (issue M6-02 / #29).
 *
 *     physicalX = (cssX + windowOrigin.x - display.bounds.x) * scaleFactor
 *
 * It lives here for the same reason the forward conversion does - invariant 3 says scale
 * arithmetic has exactly one owner - and it takes `windowOrigin` rather than assuming the
 * picker covers the display, so a picker that is inset, or one that failed to get the bounds it
 * asked for, produces a correct region instead of a plausible one. On this project's hardware
 * that parameter is always the display origin and always cancels out; on a machine where the
 * window manager shaved 48px off the window it does not, and that is a case the ground truth
 * says actually happens on secondary displays.
 *
 * ## Rounding outward, not to nearest
 *
 * The result is integers, because {@link import('../../shared/config-schema.js').regionSchema}
 * requires them and the sidecar crops with them. The origin is floored and the far edge ceiled,
 * so the returned rect always **contains** the rectangle the user drew rather than
 * approximating it. That asymmetry is deliberate: spike S1 measured that a crop whose edge
 * cuts through a letter does not degrade OCR, it breaks it - `Logician` came back as
 * `ogician`. Rounding to nearest would shave up to half a physical pixel off an edge the user
 * placed deliberately, and at scale 2.0 that is a whole pixel of glyph. Growing by at most one
 * pixel per edge costs nothing; shrinking by one can cost a word.
 *
 * This deliberately does **not** clamp to the monitor. Clamping needs the monitor's size, which
 * is `region-guard.ts`'s input, not this module's - and this module converts rectangles.
 */
export function toPhysicalRegion(
  selection: CssRect,
  windowOrigin: { readonly x: number; readonly y: number },
  display: DisplayGeometry,
): Rect {
  const { scaleFactor } = display;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new RangeError(`display.scaleFactor must be a positive finite number, got ${String(scaleFactor)}`);
  }

  // Offsets are applied in logical px - all three are logical - and only the total is scaled,
  // matching `toLogicalRect` so the two are exact inverses up to the outward rounding.
  const left = Math.floor((selection.x + windowOrigin.x - display.bounds.x) * scaleFactor);
  const top = Math.floor((selection.y + windowOrigin.y - display.bounds.y) * scaleFactor);
  const right = Math.ceil((selection.x + selection.width + windowOrigin.x - display.bounds.x) * scaleFactor);
  const bottom = Math.ceil((selection.y + selection.height + windowOrigin.y - display.bounds.y) * scaleFactor);

  return [left, top, right - left, bottom - top];
}

/** The smallest logical rect containing all of `rects`. Returns `undefined` for an empty list. */
export function unionRects(rects: readonly LogicalRect[]): LogicalRect | undefined {
  const first = rects[0];
  if (first === undefined) return undefined;

  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;

  for (let i = 1; i < rects.length; i += 1) {
    const rect = rects[i];
    if (rect === undefined) continue;
    if (rect.x < left) left = rect.x;
    if (rect.y < top) top = rect.y;
    if (rect.x + rect.width > right) right = rect.x + rect.width;
    if (rect.y + rect.height > bottom) bottom = rect.y + rect.height;
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}
