// CommonJS on purpose: a sandboxed Electron preload cannot be an ES module.
// The .cts extension is what makes tsc emit dist/preload/index.cjs.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { TextlensBridge } from '../shared/types.js';
import type {
  OverlayBridge,
  OverlayPayloadChannel,
  OverlayRenderMessage,
} from '../renderer/overlay/contract.js';
import type {
  PickerInit,
  PickerInitChannel,
  PickerResult,
  PickerResultChannel,
  RegionPickerBridge,
} from '../renderer/region-picker/contract.js';

const bridge: TextlensBridge = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },
};

contextBridge.exposeInMainWorld('textlens', bridge);

/**
 * The channel name, written out rather than imported (issue M5-01).
 *
 * `contract.ts` lives in the renderer tree, which Vite bundles; this file compiles to
 * CommonJS in `dist/preload/`. A `require` across that boundary would resolve to nothing at
 * runtime. The **type** crosses fine, and annotating the literal with it means renaming the
 * channel in `contract.ts` breaks this line at compile time instead of producing an overlay
 * that listens on a channel nobody sends to - the failure invariant 4 forbids, in its quietest
 * possible form.
 */
const OVERLAY_PAYLOAD_CHANNEL: OverlayPayloadChannel = 'textlens:overlay-payload';

/**
 * The overlay half of the bridge, on its own key.
 *
 * A second `exposeInMainWorld` rather than a field on `textlens`: `TextlensBridge` and the
 * `Window` augmentation that types it live in `src/shared/types.ts`, which this issue does not
 * own. It also means the settings window - which loads this same preload - is never handed a
 * subscription it has no use for.
 *
 * Only the payload crosses, never the `IpcRendererEvent`. That object carries `sender` and the
 * ports collection; handing it to the renderer would put a live handle to the main process
 * behind the context bridge and undo the point of `contextIsolation`.
 */
const overlayBridge: OverlayBridge = {
  onPayload(listener: (message: OverlayRenderMessage) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, message: OverlayRenderMessage): void => {
      listener(message);
    };
    ipcRenderer.on(OVERLAY_PAYLOAD_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(OVERLAY_PAYLOAD_CHANNEL, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('textlensOverlay', overlayBridge);

/**
 * The region picker's bridge (issue M6-02 / #29).
 *
 * A third `exposeInMainWorld` for the same reason the overlay got a second one: every window in
 * this app loads this one preload, and a surface should not be handed a capability it has no
 * use for. The overlay must never be able to submit a region.
 *
 * `submit` is `send`, not `invoke`: the picker is telling the main process what the user chose
 * and has nothing to wait for. The window is closed by the main process as a result, so a
 * pending promise in a renderer that is about to be destroyed would be a promise nobody can
 * ever settle.
 */
const PICKER_INIT_CHANNEL: PickerInitChannel = 'textlens:region-picker-init';
const PICKER_RESULT_CHANNEL: PickerResultChannel = 'textlens:region-picker-result';

const regionPickerBridge: RegionPickerBridge = {
  onInit(listener: (init: PickerInit) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, message: PickerInit): void => {
      listener(message);
    };
    ipcRenderer.on(PICKER_INIT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(PICKER_INIT_CHANNEL, wrapped);
    };
  },
  submit(result: PickerResult): void {
    ipcRenderer.send(PICKER_RESULT_CHANNEL, result);
  },
};

contextBridge.exposeInMainWorld('textlensRegionPicker', regionPickerBridge);
