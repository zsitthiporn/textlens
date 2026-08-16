// CommonJS on purpose: a sandboxed Electron preload cannot be an ES module.
// The .cts extension is what makes tsc emit dist/preload/index.cjs.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type { TextlensBridge } from '../shared/types.js';
import type {
  OverlayBridge,
  OverlayDrawnChannel,
  OverlayDrawnMessage,
  OverlayPayloadChannel,
  OverlayRenderChannel,
  OverlayRenderConfigMessage,
  OverlayRenderMessage,
  OverlayStatusChannel,
  OverlayStatusMessage,
} from '../renderer/overlay/contract.js';
import type {
  PickerInit,
  PickerInitChannel,
  PickerResult,
  PickerResultChannel,
  RegionPickerBridge,
} from '../renderer/region-picker/contract.js';
import type {
  SettingsBridge,
  SettingsCommand,
  SettingsCommandChannel,
  SettingsConfigChannel,
  SettingsHotkeyChannel,
  SettingsHotkeyRequest,
  SettingsHotkeyResult,
  SettingsRequestChannel,
  SettingsState,
  SettingsStateChannel,
  SettingsWriteResult,
} from '../renderer/settings/contract.js';
import type { ConfigOverride } from '../shared/config-schema.js';

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
const OVERLAY_STATUS_CHANNEL: OverlayStatusChannel = 'textlens:overlay-status';
const OVERLAY_DRAWN_CHANNEL: OverlayDrawnChannel = 'textlens:overlay-drawn';
const OVERLAY_RENDER_CHANNEL: OverlayRenderChannel = 'textlens:overlay-render';

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
  // A channel of its own rather than a field on the payload (#41). A payload only exists when
  // there is text to draw, and every condition worth a banner - no sidecar, no engine, no region -
  // is a condition in which no payload is being produced at all. Riding along on one would be a
  // warning that can only appear when it is least needed.
  onStatus(listener: (message: OverlayStatusMessage) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, message: OverlayStatusMessage): void => {
      listener(message);
    };
    ipcRenderer.on(OVERLAY_STATUS_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(OVERLAY_STATUS_CHANNEL, wrapped);
    };
  },
  // #39. The tuning also rides on every payload, and that copy is still the authority for layout;
  // this one exists because a payload only happens when there is text to draw, so a font size
  // changed while the screen is still would otherwise not be visible until the next subtitle.
  onRenderConfig(listener: (message: OverlayRenderConfigMessage) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, message: OverlayRenderConfigMessage): void => {
      listener(message);
    };
    ipcRenderer.on(OVERLAY_RENDER_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(OVERLAY_RENDER_CHANNEL, wrapped);
    };
  },
  // `send`, not `invoke`, for the same reason the region picker's `submit` is (#52): the renderer
  // is reporting something that has already happened and has nothing to wait for. The id is
  // narrowed here rather than trusted, because the diagnostics seam lets a CDP driver push a
  // message in that never came from the main process and so has no id at all.
  reportDrawn(id: number): void {
    if (typeof id !== 'number' || !Number.isFinite(id)) return;
    ipcRenderer.send(OVERLAY_DRAWN_CHANNEL, { id } satisfies OverlayDrawnMessage);
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

/**
 * The settings window's bridge (issue M9-02 / #39).
 *
 * A fourth key, for the reason each of the others got its own: one preload serves every window in
 * this app, and the overlay must never hold a capability that writes config. That separation is
 * defence in depth rather than the defence itself - the main process filters every one of these
 * channels by sender (`ipc-handlers.ts`), because a key on `window` proves only which script ran.
 *
 * `invoke`, not `send`, and that differs from the picker and the overlay on purpose: each of these
 * has an answer the window has to render. A rebind that was refused, a value that failed
 * validation, a write that did not reach the disk - all three are the point of the call, and a
 * fire-and-forget channel would make them arrive as a state push the window could not attribute to
 * the control the user just touched.
 */
const SETTINGS_STATE_CHANNEL: SettingsStateChannel = 'textlens:settings-state';
const SETTINGS_REQUEST_CHANNEL: SettingsRequestChannel = 'textlens:settings-request';
const SETTINGS_CONFIG_CHANNEL: SettingsConfigChannel = 'textlens:settings-config';
const SETTINGS_HOTKEY_CHANNEL: SettingsHotkeyChannel = 'textlens:settings-hotkey';
const SETTINGS_COMMAND_CHANNEL: SettingsCommandChannel = 'textlens:settings-command';

const settingsBridge: SettingsBridge = {
  onState(listener: (state: SettingsState) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, state: SettingsState): void => {
      listener(state);
    };
    ipcRenderer.on(SETTINGS_STATE_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(SETTINGS_STATE_CHANNEL, wrapped);
    };
  },
  async request(): Promise<SettingsState> {
    return (await ipcRenderer.invoke(SETTINGS_REQUEST_CHANNEL)) as SettingsState;
  },
  async setConfig(change: ConfigOverride): Promise<SettingsWriteResult> {
    return (await ipcRenderer.invoke(SETTINGS_CONFIG_CHANNEL, change)) as SettingsWriteResult;
  },
  async setHotkey(request: SettingsHotkeyRequest): Promise<SettingsHotkeyResult> {
    return (await ipcRenderer.invoke(SETTINGS_HOTKEY_CHANNEL, request)) as SettingsHotkeyResult;
  },
  async command(command: SettingsCommand): Promise<void> {
    await ipcRenderer.invoke(SETTINGS_COMMAND_CHANNEL, command);
  },
};

contextBridge.exposeInMainWorld('textlensSettings', settingsBridge);
