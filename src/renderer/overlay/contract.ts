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
}
