/**
 * The main -> overlay-renderer message contract (issue M5-01).
 *
 * ## Why this type exists at all, next to `OverlayPayload`
 *
 * `text-pipeline.ts` already defines `OverlayPayload`, and this file deliberately does **not**
 * import it. The renderer bundle is built by Vite from `src/renderer` with no Node types and no
 * access to `electron`; pulling `text-pipeline.ts` in would drag the translator chain, the SQLite
 * cache and `node:` imports across that boundary for the sake of four field names.
 *
 * A duplicated shape is a drift risk, so the drift is made into a compile error rather than left
 * to vigilance: `WindowManager.sendOverlayPayload` takes {@link OverlayRenderPayload}, and
 * `src/main/index.ts` hands it the pipeline's `OverlayPayload` directly. If the pipeline ever
 * renames a field or narrows a type, that call stops type-checking. `tests/main/overlay/`
 * pins the same assignability explicitly, so the guarantee survives a refactor of the call site.
 *
 * This type is a **subset**. `engine`, `failures`, `cacheStatus` and `stats` are all in the
 * payload and none of them are here, because M5 draws boxes and nothing else - the degraded
 * warning banner is M10-02 (#41). `degraded` itself is carried because a renderer that fades
 * boxes in and out has to know that a box holds untranslated English before #41 exists.
 */

/** A rectangle in the renderer's own space. Units depend on the field that holds it. */
export interface OverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Mirrors `EntryOrigin` in `text-pipeline.ts`. */
export type OverlayEntryOrigin = 'cache' | 'engine' | 'degraded';

export interface OverlayRenderEntry {
  /** What to draw. The untranslated original when `origin` is `degraded`. */
  readonly text: string;
  /** The OCR text this came from. M8's sticky placement compares on it. */
  readonly sourceText: string;
  /** **Logical px, absolute on the virtual desktop.** Converted to CSS px by the renderer. */
  readonly bbox: OverlayRect;
  readonly origin: OverlayEntryOrigin;
}

export interface OverlayRenderPayload {
  readonly seq: number;
  readonly complete: boolean;
  readonly entries: readonly OverlayRenderEntry[];
  readonly degraded: boolean;
}

/**
 * The renderer's own tuning numbers, in **CSS px and ms** (issues #35, #37).
 *
 * A structural subset of `RenderConfig` in `src/shared/config-schema.ts`, duplicated here for
 * exactly the reason {@link OverlayRenderPayload} is: the renderer bundle cannot import zod or
 * anything under `main/`. The drift is a compile error rather than a matter of vigilance -
 * `WindowManager.setOverlayRender` takes this type and `src/main/index.ts` hands it the parsed
 * config directly, so a renamed field stops type-checking at that call.
 *
 * Every field's meaning, and the argument for its default, is documented on the schema.
 */
export interface OverlayRenderConfig {
  readonly anchorGrid: number;
  readonly anchorTolerance: number;
  readonly stickyMaxEntries: number;
  readonly minDisplayMs: number;
  readonly fadeMs: number;
  /** Translation text size in CSS px (#39). Written to a custom property, not to each box. */
  readonly fontSize: number;
  /** Opacity of a box's background plate, 0..1 (#39). Never the element's own `opacity` - A9. */
  readonly opacity: number;
}

/**
 * What actually crosses the IPC boundary.
 *
 * `origin` is the top-left of the display the overlay covers, in **logical px**, and it is sent
 * rather than derived because it is the one number the renderer cannot know for itself without
 * guessing. `window.screenX` looks like the answer and is a second source of truth for a value
 * the main process already owns - and the two disagree the moment the overlay is moved to
 * another display (`WindowManager.moveOverlayTo`) or a display's metrics change under it.
 *
 * Subtracting it is the logical-px -> CSS-px step of the three-space contract in
 * `src/main/utils/coordinates.ts`, which names the renderer as that step's owner (invariant 3).
 *
 * `config` and `epoch` ride along on every payload rather than arriving on a channel of their
 * own; see {@link OverlayRenderConfig} and {@link epoch}.
 */
export interface OverlayRenderMessage {
  /**
   * Monotonic per message, so the renderer can say *which* one it drew (#52).
   *
   * Not `payload.seq`: a frame emits up to two payloads under one seq - the cache hits, then the
   * whole set - and the main process has to tell those apart. What it does with the answer is
   * record the text as displayed, and recording the second one's entries because the first one
   * was drawn would be the bug this exists to remove, in a smaller form.
   *
   * Assigned by `WindowManager`, which is also the only thing that reads the reply.
   */
  readonly id: number;
  readonly payload: OverlayRenderPayload;
  readonly origin: { readonly x: number; readonly y: number };
  /** The tuning numbers in force for this payload. */
  readonly config: OverlayRenderConfig;
  /**
   * Bumped by the main process whenever everything the renderer remembers about *where* things
   * were has stopped being true - a new region, a different monitor, the overlay moved to
   * another display (#35's "เปลี่ยน region → cache ถูกล้าง").
   *
   * A counter rather than a `clearCache` message because it cannot arrive out of order with
   * respect to the payload it applies to: the payload carries the epoch it belongs to, so a
   * renderer comparing it against the last one it drew can never apply new boxes with stale
   * remembered positions, however the two were scheduled.
   */
  readonly epoch: number;
}

/** IPC channel for {@link OverlayRenderMessage}. */
export const OVERLAY_PAYLOAD_CHANNEL = 'textlens:overlay-payload';

/**
 * The renderer confirming what it actually put on screen (issue #52).
 *
 * The only message that travels renderer -> main on the overlay's behalf, and it exists because
 * the main process cannot know this on its own. Two things between `sendOverlayPayload` and a
 * painted box can decide a payload never becomes a picture:
 *
 *   - `MinDisplayGate` holds a payload that arrived too soon and drops the held one when a newer
 *     payload replaces it (#37);
 *   - `FrameScheduler` coalesces several payloads that arrived inside one frame into the last.
 *
 * Both are correct and both mean the same thing here: the entries that were superseded were never
 * seen. `RecentOutputs` has no TTL by design, so recording one string that was never displayed
 * filters it out of translation for the rest of the session, silently.
 *
 * It carries the id and nothing else. The renderer does not decide *what* is remembered - the
 * degraded exclusion and the hidden-overlay rule live in the main process, where the rest of F2
 * lives - so this cannot become a second place that has an opinion about the feedback filter.
 */
export interface OverlayDrawnMessage {
  /** The {@link OverlayRenderMessage.id} that reached the document. */
  readonly id: number;
}

/**
 * The tuning on its own, pushed the moment it changes (issue #39).
 *
 * ## Why this exists next to the copy that rides on every payload
 *
 * {@link OverlayRenderMessage.config} is still the authority, and the ordering argument for it is
 * unchanged: a payload must never be laid out against numbers that arrived separately, so the
 * numbers travel with the frame they govern.
 *
 * But #39 requires that changing the text size or the opacity is visible **immediately**, and a
 * payload only exists when there is text to draw. Measured in a real run: a font size changed from
 * the settings window reached config, reached the main process and stopped there, because the
 * screen was not producing frames - so the user drags a slider and nothing happens until the next
 * subtitle. On a paused app, or a still screen, that is never.
 *
 * This channel closes that gap without weakening the invariant, because the two do not overlap:
 * the push updates the CSS custom properties that decide how a box *looks*, and every payload still
 * carries the full config that decides where a box *goes*.
 */
export interface OverlayRenderConfigMessage {
  readonly config: OverlayRenderConfig;
}

/** IPC channel for {@link OverlayRenderConfigMessage}. */
export const OVERLAY_RENDER_CHANNEL = 'textlens:overlay-render';

/** Same compile-time drift guard as {@link OverlayPayloadChannel}; see its comment. */
export type OverlayRenderChannel = typeof OVERLAY_RENDER_CHANNEL;

/** IPC channel for {@link OverlayDrawnMessage}. */
export const OVERLAY_DRAWN_CHANNEL = 'textlens:overlay-drawn';

/** Same compile-time drift guard as {@link OverlayPayloadChannel}; see its comment. */
export type OverlayDrawnChannel = typeof OVERLAY_DRAWN_CHANNEL;

/**
 * The channel name as a type, so the two files that cannot import the *value* still cannot drift
 * from it.
 *
 * `src/preload/index.cts` compiles to CommonJS and `src/main/services/window-manager.ts` compiles
 * to `dist/main/`; neither can `require`/`import` a module that only exists inside Vite's
 * renderer bundle. Both therefore write the literal out - and annotate it with this type, so a
 * rename here is a compile error there rather than a listener that is never called.
 */
export type OverlayPayloadChannel = typeof OVERLAY_PAYLOAD_CHANNEL;

// ---------------------------------------------------------------------------
// The status banner (issue M10-02 / #41)
// ---------------------------------------------------------------------------

/** Mirrors `AlertSeverity` in `src/main/services/error-reporter.ts`. */
export type OverlayAlertSeverity = 'fatal' | 'error' | 'warning' | 'info';

/**
 * One condition the user needs to know about, already reduced to text.
 *
 * Cause and remedy stay two fields across the boundary rather than being joined in the main
 * process, so the renderer can weight them differently - the cause is what catches the eye, the
 * remedy is what the user acts on, and a single pre-joined string forces them to look identical.
 */
export interface OverlayAlert {
  readonly severity: OverlayAlertSeverity;
  readonly cause: string;
  readonly remedy: string;
}

/**
 * What the overlay is told about the app's health.
 *
 * `null` means all clear, and it is sent explicitly rather than by omission: a banner that is
 * only ever *added* is a banner that outlives the problem, which is the failure mode #41 names in
 * "error ชั่วคราว (backoff) หายเองเมื่อกลับมาปกติ".
 */
export interface OverlayStatusMessage {
  readonly alert: OverlayAlert | null;
}

/** IPC channel for {@link OverlayStatusMessage}. */
export const OVERLAY_STATUS_CHANNEL = 'textlens:overlay-status';

/** Same compile-time drift guard as {@link OverlayPayloadChannel}; see its comment. */
export type OverlayStatusChannel = typeof OVERLAY_STATUS_CHANNEL;

/**
 * The overlay half of the preload bridge, exposed as `window.textlensOverlay`.
 *
 * A second `contextBridge` key rather than a field on `TextlensBridge`: that interface lives in
 * `src/shared/types.ts` along with the `Window` augmentation that types `window.textlens`, and
 * this issue does not own that file. Two keys also means the settings window - which loads the
 * same preload - is never handed an overlay subscription it has no use for.
 */
export interface OverlayBridge {
  /** Registers `listener` for every payload. Returns a function that unsubscribes. */
  onPayload(listener: (message: OverlayRenderMessage) => void): () => void;
  /** Registers `listener` for every status change (#41). Returns a function that unsubscribes. */
  onStatus(listener: (message: OverlayStatusMessage) => void): () => void;
  /** Registers `listener` for tuning changes that must show before the next payload (#39). */
  onRenderConfig(listener: (message: OverlayRenderConfigMessage) => void): () => void;
  /** Report that a payload reached the document and was drawn (#52). Fire and forget. */
  reportDrawn(id: number): void;
}
