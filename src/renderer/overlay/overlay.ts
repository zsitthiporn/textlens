/**
 * Overlay renderer entry point (issues M5-01 .. M5-04).
 *
 * Wiring only. Everything with a decision in it lives next door and is unit tested without a
 * DOM: the pool (`node-pool.ts`), the coalescing rule (`frame-scheduler.ts`), the two passes
 * (`layout.ts`) and the anti-overlap cascade (`placement.ts`). What is left here is the part
 * that genuinely needs a live document - creating the elements, subscribing to the bridge, and
 * the one coordinate conversion this side of the app owns.
 *
 * ## The conversion, and why it is subtraction and nothing else
 *
 * `OverlayRenderEntry.bbox` is in logical px, absolute on the virtual desktop.
 * `src/main/utils/coordinates.ts` names the renderer as the owner of the last hop, logical ->
 * CSS px, and for a window that covers exactly one display that hop is a translation by the
 * display's origin. No scaling: CSS px and Electron's logical px are the same unit, and
 * `devicePixelRatio` is Chromium's business, not ours. Any multiplication appearing here would
 * be the DPI bug the reference project shipped, reintroduced at the last possible step.
 *
 * ## Nothing clears the overlay on a quiet frame
 *
 * `TextPipeline` deliberately emits no payload when a frame produced nothing new - dedup
 * suppresses text that is still on screen unchanged, so "nothing new" is the steady state while
 * a subtitle is being read, not an empty screen. The boxes therefore stay exactly where they
 * are until a payload replaces them. Clearing on silence would make the overlay blink off
 * between every pair of frames.
 */

import type { OverlayBridge, OverlayRenderMessage } from './contract.js';
import { createFrameScheduler } from './frame-scheduler.js';
import { renderEntries, toLayoutEntries, type RenderStats } from './layout.js';
import { BoxPool, DEFAULT_POOL_CAPACITY } from './node-pool.js';

const CONTAINER_ID = 'boxes';

const container = document.getElementById(CONTAINER_ID);
if (container === null) {
  throw new Error(`overlay document is missing #${CONTAINER_ID}`);
}
const boxContainer = container;

/**
 * Every box the overlay will ever draw, created here and only here.
 *
 * `document.createDocumentFragment` is used so the pool's `capacity` appends cost one document
 * mutation rather than `capacity` of them - the pool calls `attach` once per box and has no
 * opinion about where they go.
 */
const fragment = document.createDocumentFragment();
const pool = new BoxPool({
  capacity: DEFAULT_POOL_CAPACITY,
  create: () => {
    const element = document.createElement('div');
    element.className = 'box';
    return element;
  },
  attach: (box) => {
    fragment.appendChild(box);
  },
});
boxContainer.appendChild(fragment);

let lastStats: RenderStats | null = null;
let lastSeq: number | null = null;
let lastMessage: OverlayRenderMessage | null = null;

function draw(message: OverlayRenderMessage): void {
  const entries = toLayoutEntries(message);
  lastSeq = message.payload.seq;
  lastMessage = message;
  lastStats = renderEntries(entries, pool, {
    screen: { width: window.innerWidth, height: window.innerHeight },
    marks: performance,
  });
}

const scheduler = createFrameScheduler<OverlayRenderMessage>(
  (callback) => window.requestAnimationFrame(callback),
  draw,
);

window.textlensOverlay?.onPayload((message) => {
  scheduler.submit(message);
});

/**
 * Redraw once the bundled face has actually loaded.
 *
 * M5-03 measures each box's real height, and a height is only real if it was measured in the
 * face the box will be painted in. A payload that arrives before the @font-face request finishes
 * would be measured against a fallback and placed against those metrics - Thai line counts
 * differ between faces, so that is not a rounding error, it is a box the wrong height.
 *
 * `font-display: block` means such a box is not *painted* in the fallback, so this is a
 * correction to geometry rather than to something the user saw. Failure to load is not fatal and
 * must not stop the overlay drawing: the box would simply be laid out in whatever face the
 * fallback chain supplies.
 */
void document.fonts.load('500 17px "Textlens Thai"').then(
  () => {
    if (lastMessage !== null) draw(lastMessage);
  },
  () => {
    /* the fallback chain in overlay.css takes over; nothing to redraw against */
  },
);

/**
 * Diagnostics seam.
 *
 * The overlay is transparent, click-through and excluded from screen capture, which makes it the
 * hardest surface in the app to inspect by looking at it. This exposes what the last render
 * actually did, and lets a driver push a payload in without a sidecar or a translation engine -
 * which is how `tests/main/overlay/` verifies Thai line breaking, box heights and Chromium's own
 * reflow count against the real rendering engine rather than against a DOM emulation.
 */
declare global {
  interface Window {
    /** Exposed by `src/preload/index.cts`. Absent in any window that is not the overlay. */
    readonly textlensOverlay?: OverlayBridge;
    readonly __textlensOverlay?: {
      readonly render: (message: OverlayRenderMessage) => void;
      readonly stats: () => RenderStats | null;
      readonly seq: () => number | null;
      readonly renders: () => number;
      readonly poolCreated: () => number;
      readonly poolCapacity: () => number;
      readonly childCount: () => number;
    };
  }
}

Object.defineProperty(window, '__textlensOverlay', {
  value: {
    // Bypasses the scheduler on purpose: a driver that awaits a result needs the render to have
    // happened by the time the call returns, and rAF coalescing is covered by its own unit test.
    render: draw,
    stats: () => lastStats,
    seq: () => lastSeq,
    renders: () => scheduler.renders,
    poolCreated: () => pool.created,
    poolCapacity: () => pool.capacity,
    childCount: () => boxContainer.childElementCount,
  },
  enumerable: false,
});
