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
 */
export interface OverlayRenderMessage {
  readonly payload: OverlayRenderPayload;
  readonly origin: { readonly x: number; readonly y: number };
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
}
