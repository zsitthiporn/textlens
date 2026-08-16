/**
 * Overlay renderer entry point (issues M5-01 .. M5-04, M8-01 / #35, M8-03 / #37).
 *
 * Wiring only. Everything with a decision in it lives next door and is unit tested without a
 * DOM: the pool (`node-pool.ts`), the coalescing rule (`frame-scheduler.ts`), the two passes
 * (`layout.ts`), the anti-overlap cascade (`placement.ts`), sticky anchors (`anchor.ts`) and the
 * three between-frames rules (`transitions.ts`). What is left here is the part that genuinely
 * needs a live document - creating the elements, subscribing to the bridge, and the one
 * coordinate conversion this side of the app owns.
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
 *
 * ## The order of the two gates, and why it is this way round
 *
 *     bridge -> MinDisplayGate -> FrameScheduler -> requestAnimationFrame -> draw
 *
 * The scheduler has to be the *inner* one. Its whole job is that a draw happens inside a rAF
 * callback, which is what makes M5-03's hidden measurement pass unobservable - the browser cannot
 * paint in the middle of a task, so the `visibility: hidden` state of phase 1 is never presented.
 * Put the gate inside it and a deferred payload would be drawn from a `setTimeout`, outside any
 * frame callback, and that guarantee would quietly stop holding for exactly the payloads M8-03
 * introduced.
 */

import type {
  OverlayBridge,
  OverlayRenderConfig,
  OverlayRenderMessage,
  OverlayStatusMessage,
} from './contract.js';
import { createFrameScheduler } from './frame-scheduler.js';
import { renderEntries, RenderSession, toLayoutEntries, type RenderStats } from './layout.js';
import { BoxPool, DEFAULT_POOL_CAPACITY, type PooledBox } from './node-pool.js';
import { toBannerView, type BannerView } from './status.js';
import { MinDisplayGate } from './transitions.js';

const CONTAINER_ID = 'boxes';

const container = document.getElementById(CONTAINER_ID);
if (container === null) {
  throw new Error(`overlay document is missing #${CONTAINER_ID}`);
}
const boxContainer = container;

/**
 * The status banner's elements (#41).
 *
 * Looked up once and asserted, like `#boxes` above: a renderer that silently fails to find the
 * element it warns through is the exact failure invariant 4 forbids, wearing the costume of a
 * healthy session.
 */
const statusElement = requireElement('status');
const statusCause = requireElement('status-cause');
const statusRemedy = requireElement('status-remedy');

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`overlay document is missing #${id}`);
  return element;
}

/**
 * The fallback tuning, used only until the first payload arrives.
 *
 * It never governs anything the user sees: `OverlayRenderMessage` carries the real values on
 * every payload precisely so that no frame is ever laid out against defaults the user did not
 * choose. These exist so the module has a defined state before its first message.
 */
const FALLBACK_CONFIG: OverlayRenderConfig = {
  anchorGrid: 8,
  anchorTolerance: 6,
  stickyMaxEntries: 128,
  minDisplayMs: 400,
  fadeMs: 120,
};

/**
 * One box, as two stacked text layers (issue #37, feature A9).
 *
 * A single element cannot crossfade to itself - to dissolve one string into another both have to
 * be painted at once. So each box owns two spans:
 *
 *   - **incoming**, in normal flow. It is what the box's height is measured from, which keeps
 *     M5-03's measurement honest: the box is exactly as tall as the text it is about to show,
 *     never as tall as the taller of two.
 *   - **outgoing**, absolutely positioned over it and `aria-hidden`. It holds the string being
 *     replaced while it fades away, and contributes nothing to layout.
 *
 * Both spans are created with the box, once, so the pool's "no DOM nodes after init" guarantee
 * still holds with two layers instead of one.
 */
interface DomBox extends PooledBox {
  readonly element: HTMLElement;
}

function createBox(): DomBox {
  const element = document.createElement('div');
  element.className = 'box';

  const incoming = document.createElement('span');
  incoming.className = 'box-layer box-in';
  const outgoing = document.createElement('span');
  outgoing.className = 'box-layer box-out';
  outgoing.setAttribute('aria-hidden', 'true');

  element.append(incoming, outgoing);

  let current = '';

  return {
    element,
    style: element.style,
    get text(): string {
      return current;
    },
    setText(text: string, fade: boolean): void {
      if (fade && current !== '') {
        outgoing.textContent = current;
        // Restart, rather than let a half-finished fade continue from wherever it got to. The
        // class is removed and re-added around a forced reflow because re-adding it in the same
        // task is a no-op to the transition engine - the computed value never changed.
        outgoing.classList.remove('fading');
        void outgoing.offsetWidth;
        outgoing.classList.add('fading');
      } else {
        outgoing.textContent = '';
        outgoing.classList.remove('fading');
      }
      incoming.textContent = text;
      current = text;
    },
    setAttribute(name: string, value: string): void {
      element.setAttribute(name, value);
    },
    getBoundingClientRect(): { readonly width: number; readonly height: number } {
      return element.getBoundingClientRect();
    },
  };
}

/**
 * Every box the overlay will ever draw, created here and only here.
 *
 * `document.createDocumentFragment` is used so the pool's `capacity` appends cost one document
 * mutation rather than `capacity` of them - the pool calls `attach` once per box and has no
 * opinion about where they go.
 */
const fragment = document.createDocumentFragment();
const pool = new BoxPool<DomBox>({
  capacity: DEFAULT_POOL_CAPACITY,
  create: createBox,
  attach: (box) => {
    fragment.appendChild(box.element);
  },
});
boxContainer.appendChild(fragment);

let config: OverlayRenderConfig = FALLBACK_CONFIG;
let epoch: number | null = null;
let session = newSession(config);
let lastStats: RenderStats | null = null;
let lastSeq: number | null = null;
/** The last id reported back to the main process (#52). Readable through the diagnostics seam. */
let lastDrawn: number | null = null;
let lastMessage: OverlayRenderMessage | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
let draws = 0;
let repaints = 0;

function newSession(current: OverlayRenderConfig): RenderSession {
  return new RenderSession({
    capacity: pool.capacity,
    grid: current.anchorGrid,
    tolerance: current.anchorTolerance,
    maxEntries: current.stickyMaxEntries,
  });
}

/**
 * Apply the message's tuning, and forget everything positional if the epoch moved.
 *
 * The two are one function because they are one decision. A changed grid or tolerance means every
 * remembered anchor was computed under different rules, so keeping them would leave boxes held at
 * positions the new settings would never produce - stale in a way nothing else would report.
 */
function adopt(message: OverlayRenderMessage): void {
  const next = message.config;
  const rebuilt =
    next.anchorGrid !== config.anchorGrid ||
    next.anchorTolerance !== config.anchorTolerance ||
    next.stickyMaxEntries !== config.stickyMaxEntries;

  config = next;
  boxContainer.style.setProperty('--textlens-fade', `${String(next.fadeMs)}ms`);

  if (epoch !== message.epoch) {
    // #35: a new region, monitor or display. Every remembered position describes a screen that
    // no longer exists, and a box held at one of them would sit under nothing.
    epoch = message.epoch;
    session = newSession(config);
    gate.reset();
    pool.hideAll();
    return;
  }

  if (rebuilt) session = newSession(config);
}

function draw(message: OverlayRenderMessage): void {
  adopt(message);

  const entries = toLayoutEntries(message);
  lastSeq = message.payload.seq;
  lastMessage = message;
  draws += 1;

  // #52. Here rather than in the bridge subscription, and that is the whole point: everything
  // between the two - the minimum-display hold, the frame scheduler's coalescing - exists to
  // *not* draw some of the payloads that arrive, and the main process has no way to know which.
  // Reported for an A6 skip too: a skipped render means this payload's picture is already on
  // screen, which is the same claim.
  lastDrawn = message.id;
  window.textlensOverlay?.reportDrawn(message.id);

  const stats = renderEntries(
    entries,
    pool,
    {
      screen: { width: window.innerWidth, height: window.innerHeight },
      marks: performance,
      fadeMs: config.fadeMs,
      now: () => performance.now(),
    },
    session,
  );
  lastStats = stats;

  if (!stats.unchanged) {
    repaints += 1;
    // A4's clock starts here and only here: a render that A6 skipped painted nothing, so it
    // cannot have restarted the time the user has had to read what is on screen.
    gate.markShown();
  }

  scheduleSweep();
}

/**
 * Reclaim boxes once their fade-out has finished.
 *
 * `renderEntries` sweeps at the start of every render, which covers the case where another
 * payload arrives. This covers the other one: the last payload of a scene removes a box and
 * nothing follows it for a minute. Without this the box would sit at `opacity: 0` with
 * `display: block`, invisible but still measured by every later render.
 */
function scheduleSweep(): void {
  if (sweepTimer !== null) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
  if (!session.slots.fading) return;

  const current = session;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    // A new epoch replaces the session wholesale; sweeping the old one would hide boxes the new
    // session has since handed out.
    if (current !== session) return;
    for (const index of current.slots.sweep(performance.now(), config.fadeMs)) {
      const box = pool.boxes[index];
      if (box === undefined) continue;
      box.style.display = 'none';
      box.style.visibility = 'hidden';
      box.setText('', false);
    }
  }, config.fadeMs + 20);
}

const scheduler = createFrameScheduler<OverlayRenderMessage>(
  (callback) => window.requestAnimationFrame(callback),
  draw,
);

/**
 * A4 - the minimum display time (issue #37).
 *
 * Outside the frame scheduler; see the module comment on why that order is the load-bearing one.
 * `performance.now()` rather than `Date.now()`: this is a duration between two things that
 * happened in this process, and a wall clock that steps backwards over an NTP correction would
 * turn a 400ms hold into a hold with no end.
 */
const gate = new MinDisplayGate<OverlayRenderMessage>({
  minDisplayMs: () => config.minDisplayMs,
  now: () => performance.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  apply: (message) => {
    scheduler.submit(message);
  },
});

window.textlensOverlay?.onPayload((message) => {
  gate.submit(message);
});

/**
 * The status banner (#41).
 *
 * Deliberately outside both gates. `MinDisplayGate` and `FrameScheduler` exist to stop *boxes*
 * from flickering as text is replaced; a banner changes when the app's health changes, which is
 * measured in seconds, and holding "the capture engine died" behind a 400ms minimum-display timer
 * intended for subtitles would be delay bought for nothing.
 */
function applyStatus(message: OverlayStatusMessage | null): void {
  const view: BannerView = toBannerView(message);

  if (!view.visible) {
    statusElement.hidden = true;
    statusElement.removeAttribute('data-severity');
    // Cleared as well as hidden. A hidden element that still holds last hour's failure is a
    // string an accessibility tree will happily read out, and it would reappear intact the moment
    // anything set `hidden = false`.
    statusCause.textContent = '';
    statusRemedy.textContent = '';
    return;
  }

  statusCause.textContent = view.cause;
  statusRemedy.textContent = view.remedy;
  if (view.severity !== null) statusElement.setAttribute('data-severity', view.severity);
  statusElement.hidden = false;
}

window.textlensOverlay?.onStatus(applyStatus);

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
    if (lastMessage === null) return;
    // A6 would otherwise skip this: the signature is unchanged, and the whole point is that the
    // *measurements* behind it were taken in the wrong face.
    session.signature = null;
    draw(lastMessage);
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
 * which is how the anti-flicker work is measured at all: `renders` against `repaints` is the
 * A6 skip, `stats().signature` is what "the same picture" means, and `gate()` shows that a
 * deferred payload was applied late rather than dropped.
 */
declare global {
  interface Window {
    /** Exposed by `src/preload/index.cts`. Absent in any window that is not the overlay. */
    readonly textlensOverlay?: OverlayBridge;
    readonly __textlensOverlay?: {
      readonly render: (message: OverlayRenderMessage) => void;
      readonly submit: (message: OverlayRenderMessage) => void;
      /** Push a status message in without a main process, for the CDP driver (#41). */
      readonly status: (message: OverlayStatusMessage | null) => void;
      /** What the banner is showing, read back off the live DOM rather than off `banner`. */
      readonly banner: () => {
        visible: boolean;
        severity: string | null;
        cause: string;
        remedy: string;
        top: number;
      };
      readonly stats: () => RenderStats | null;
      readonly seq: () => number | null;
      /** The id of the last message that reached `draw` and was acked to main (#52). */
      readonly drawn: () => number | null;
      readonly renders: () => number;
      readonly draws: () => number;
      readonly repaints: () => number;
      readonly gate: () => { applied: number; deferred: number; superseded: number; pending: boolean };
      readonly epoch: () => number | null;
      readonly texts: () => string[];
      readonly poolCreated: () => number;
      readonly poolCapacity: () => number;
      readonly childCount: () => number;
    };
  }
}

Object.defineProperty(window, '__textlensOverlay', {
  value: {
    // Bypasses both gates on purpose: a driver that awaits a result needs the render to have
    // happened by the time the call returns, and each gate is covered by its own unit test.
    render: draw,
    // The full path, for a driver measuring the gates themselves rather than the render.
    submit: (message: OverlayRenderMessage) => {
      gate.submit(message);
    },
    status: applyStatus,
    // Read off the document, not off `banner`. A driver asserting the value the module computed
    // would pass even if nothing had been written to the DOM - which is the only claim worth
    // making here, since #41's requirement is that the user sees it.
    banner: () => ({
      visible: !statusElement.hidden,
      severity: statusElement.getAttribute('data-severity'),
      cause: statusCause.textContent ?? '',
      remedy: statusRemedy.textContent ?? '',
      top: statusElement.getBoundingClientRect().top,
    }),
    stats: () => lastStats,
    seq: () => lastSeq,
    drawn: () => lastDrawn,
    renders: () => scheduler.renders,
    draws: () => draws,
    repaints: () => repaints,
    gate: () => gate.stats,
    epoch: () => epoch,
    texts: () =>
      pool.boxes.filter((box) => box.style.display !== 'none' && box.text !== '').map((box) => box.text),
    poolCreated: () => pool.created,
    poolCapacity: () => pool.capacity,
    childCount: () => boxContainer.childElementCount,
  },
  enumerable: false,
});
