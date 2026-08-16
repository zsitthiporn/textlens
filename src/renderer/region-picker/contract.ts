/**
 * The main <-> region-picker message contract (issue M6-02 / #29).
 *
 * Same shape and the same reasoning as `overlay/contract.ts`: this file is bundled into the
 * renderer by Vite, so it imports nothing from `main/`, and the main process annotates its own
 * literals with these types so a rename here becomes a compile error there rather than a
 * picker that listens on a channel nobody sends to.
 *
 * The picker is the overlay's opposite in every respect. It is focusable, it wants the mouse,
 * it wants the keyboard, and it is modal to the act of choosing a region. The one thing they
 * share is that neither is allowed to guess a coordinate.
 */

/** A rectangle in CSS px, relative to the picker window's top-left. */
export interface PickerRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What the picker needs to know before it can draw anything.
 *
 * `monitorLabel` and `monitorSize` exist only to be shown to the user - "you are drawing on
 * *this* screen" - because a fullscreen dark overlay on one of three monitors is otherwise
 * completely anonymous.
 *
 * `scaleFactor` is carried so the picker can show the size of the selection in the **physical
 * px the user's monitor actually has**, which is the number that matches what they know about
 * their screen and the number the sidecar will crop with. Showing CSS px would report a 1200px
 * subtitle bar as 800px on a 150% display. The picker does no coordinate conversion with it -
 * it multiplies for a read-out and nothing else, and the authoritative conversion happens in
 * `coordinates.ts` in the main process, per invariant 3.
 */
export interface PickerInit {
  readonly monitorId: string;
  readonly monitorLabel: string;
  /** Physical px `[width, height]`, for the read-out. */
  readonly monitorSize: readonly [number, number];
  readonly scaleFactor: number;
  /** Minimum accepted selection, in physical px. Used to warn *during* the drag. */
  readonly minimumPx: number;
  /** The previous selection in CSS px, if there is one, so it can be shown as a starting point. */
  readonly current: PickerRect | null;
}

/** The picker's answer. `null` means the user cancelled and the old region stands. */
export type PickerResult = { readonly rect: PickerRect } | null;

export type PickerInitChannel = 'textlens:region-picker-init';
export type PickerResultChannel = 'textlens:region-picker-result';

/** What the preload exposes on `window.textlensRegionPicker`. */
export interface RegionPickerBridge {
  /** Subscribe to the one init message. Returns an unsubscribe. */
  onInit(listener: (init: PickerInit) => void): () => void;
  /** Report the chosen rectangle, or `null` for cancelled. Ends the picker either way. */
  submit(result: PickerResult): void;
}

declare global {
  interface Window {
    readonly textlensRegionPicker: RegionPickerBridge;
  }
}
