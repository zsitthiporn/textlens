/**
 * The mode machine (issue M7-03 / #34, features G3, G4, G5).
 *
 * One object decides what mode the app is in and, from that, whether the sidecar should be
 * capturing. Nothing else in the app may send `start`, `stop`, `configure` or `snapshot`:
 * `docs/reference-analysis.md` records that the reference project's "pause" only hides the
 * overlay while its pipeline keeps running, and two independent things driving the capture
 * loop is how a codebase ends up in that state without anyone deciding to.
 *
 * ## Four modes here, two in front of the user
 *
 * | mode       | capture loop | the user calls it | what they see                          |
 * |------------|--------------|-------------------|-----------------------------------------|
 * | `idle`     | stopped      | *not started*     | nothing; no region chosen, or pre-configure |
 * | `auto`     | **running**  | Auto              | boxes refreshed on the adaptive interval (G3) |
 * | `paused`   | stopped      | Auto (paused)     | the last boxes, frozen (G5)             |
 * | `snapshot` | stopped      | Translate once    | one frame captured on demand, held (G4) |
 *
 * The right-hand column is not decoration and it is not written here: `shared/mode-presentation.ts`
 * owns it, because the tray and the settings window both draw it and #60 was filed after they
 * drifted into calling the same thing different names. **`auto` and `paused` are one choice** -
 * Auto on and Auto off - and `idle` is offered as no choice at all, since its only meaning is "not
 * set up yet". The union stayed four because the tray's icon files, {@link AppOrchestrator.#apply}
 * and `SidecarSupervisor`'s "the user paused, leave it dead" rule all key on it; none of those are
 * naming questions.
 *
 * **`paused` really stops the sidecar.** `stop` disposes the loop's timer
 * (`CaptureLoop.Stop`), so a paused Textlens costs approximately nothing - which is what
 * #34's acceptance criterion measures with a CPU reading, and what distinguishes this from
 * hiding the overlay.
 *
 * **Hiding the overlay is not pausing**, and the two are kept apart by construction:
 * {@link AppOrchestrator.toggleOverlay} touches only the window and never the sidecar, so
 * capture, OCR and translation all carry on while the boxes are hidden.
 *
 * ## `snapshot` is a mode, entered from anywhere - and that reverses #34
 *
 * {@link AppOrchestrator.snapshot} sets the mode to `snapshot` whatever it was. Because
 * {@link AppOrchestrator.#apply} stops the loop before it fires the held command, the frame that
 * comes back is the last one the sidecar produces until the user asks for `auto` again. That is
 * G4's "จับครั้งเดียว ค้างไว้จน dismiss", and "held" now means held.
 *
 * **This section used to say the opposite, and the reversal is deliberate (#60).** The rule was:
 * a snapshot taken during `auto` ends back in `auto`, one taken during `paused` stays `paused`,
 * and only from `idle` does it become a resting mode - a snapshot was an *action* everywhere else.
 * #34 asked for that and the argument for it was that a snapshot should not disturb the mode the
 * user chose.
 *
 * What overturned it was using the app. Leaving `auto` alone leaves the **loop** alone, so the
 * tick 800ms later overwrote the frame the user had just pressed a key to hold. "Translate once"
 * therefore held nothing from the mode users are in essentially all the time; it worked only from
 * `idle`, a state they are almost never in. The old rule was self-consistent and it contradicted
 * both the user's mental model and G4, which had said "ค้างไว้จน dismiss" since before #34.
 *
 * Worth being precise about what was lost, because it is a real cost rather than none: a snapshot
 * can no longer be taken *without* leaving Auto. Pressing Translate once during Auto now stops
 * capture, and getting back is one more press of `Control+Alt+A` or one click on the tray's Auto
 * item. That is the trade #60 made knowingly - a mode you can leave by accident is worth less than
 * a frame that stays on screen.
 *
 * ## `dismiss` ends a hold; it does not undo it (#61)
 *
 * #60 built "held", and left "จน dismiss" unbuilt - there was no way to end a hold except leaving
 * `snapshot` entirely. {@link AppOrchestrator.dismiss} closes that: it clears whatever the overlay
 * is showing and leaves `#mode` exactly where it was, so a dismissed Translate once is still
 * Translate once, ready to be pressed again - never `paused` (that would misreport which mode was
 * chosen, since #60 made `paused` Auto's own state) and never `idle` (that means no sidecar is
 * configured, which dismissing does not change).
 *
 * `modes.snapshotHoldMs` is the same ending on a timer: non-zero, {@link #scheduleSnapshotHold}
 * arms a countdown the moment the `snapshot` command actually goes out, and its expiry calls
 * `dismiss()` - not a copy of what it does. One path, so a hand-pressed dismiss and an expired
 * hold can never drift apart about what "cleared" means.
 *
 * ## Why rapid mode switching cannot corrupt anything
 *
 * Every transition updates {@link AppOrchestrator.mode} **synchronously** and then runs
 * {@link AppOrchestrator.#apply}, which is also synchronous: it compares the mode against
 * what this object believes the sidecar is doing and sends at most one `start` or one `stop`.
 * Nothing is queued and nothing is scheduled, so a burst of presses is just a sequence of
 * assignments, and the sidecar receives one command per actual change of intent rather than
 * one per keypress. The sidecar's own `start`/`stop` are idempotent as well
 * (`CaptureLoop.Start` returns early when the timer exists), so even a redundant one is safe.
 *
 * The one genuinely async step is the `listMonitors` round trip during {@link initialize},
 * and it is why {@link AppOrchestrator.#configured} exists: before the `configure` is
 * acknowledged there is nothing legal to send - the sidecar answers `start` with
 * `NOT_CONFIGURED` - so transitions during startup only set the desired mode, and the
 * reconcile that runs after `configure` applies whichever one the user landed on. Hammering
 * the hotkey while the app is starting is therefore uninteresting rather than a race.
 *
 * ## No `electron` import
 *
 * The overlay is reached through {@link OverlayWindows}, the structural slice of
 * `WindowManager` this needs. Same technique, and the same reason, as `ShortcutRegistrar`
 * in `hotkey-service.ts`: these tests run in plain Node.
 */

import type { CaptureConfig, Config, ConfigOverride } from '../../shared/config-schema.js';
import type { PresentableMode } from '../../shared/mode-presentation.js';
import type { AckEvent, MonitorInfo, Rect, SidecarCommand } from '../../shared/protocol.js';
import { toPhysicalRegion } from '../utils/coordinates.js';
// Type-only, and one direction: this file names the conditions, `error-reporter.ts` decides how
// one of them is shown. Importing the value would be a cycle waiting to happen. `CancelTimer` /
// `ScheduleTimer` are the injectable-timer shape that file introduced for the banner timeout
// (#59); the hold timer below (#61) reuses the same two types rather than declaring a second,
// identical pair.
import type { Alert, CancelTimer, ScheduleTimer } from './error-reporter.js';
import { nullLogger, type Logger } from './logger.js';
import type { PairableDisplay } from './monitor-service.js';
import {
  EdgeWarningThrottle,
  MIN_REGION_PX,
  checkRegionSize,
  checkSavedRegion,
  clampRegion,
  decideDiffThreshold,
  findEdgeContact,
  padRegion,
} from './region-guard.js';
import type { SidecarClientEvents } from './sidecar-client.js';
import type { RegionPickOutcome, RegionPickRequest } from './window-manager.js';

/**
 * The internal modes. **Four, and the user sees two** - `shared/mode-presentation.ts` owns that
 * mapping, and the `satisfies` below is the drift guard: a fifth mode added here fails to compile
 * until somebody has decided what a user would call it.
 *
 * The union stayed four after #60 on purpose. It is load-bearing for the tray's icon files, for
 * the sidecar reconcile in {@link AppOrchestrator.#apply} and for `SidecarSupervisor`'s
 * "the user paused, leave it dead" rule - none of which are naming questions.
 */
export const APP_MODES = ['idle', 'auto', 'paused', 'snapshot'] as const satisfies readonly PresentableMode[];

export type AppMode = (typeof APP_MODES)[number];

/**
 * The sidecar events the mode machine reacts to.
 *
 * `nochange` joined the list for #50. It is the only positive evidence that the capture loop is
 * alive and *finding nothing* - which is a completely different situation from a dead sidecar,
 * and until now the two were indistinguishable from outside.
 */
export type CaptureSidecarEvent = 'ack' | 'error' | 'frame' | 'nochange' | 'exit';

/**
 * The part of `SidecarClient` the mode machine drives.
 *
 * The payload types come from `SidecarClientEvents` rather than being restated here, so a
 * change to the wire shape fails this file at compile time instead of at runtime. The
 * *methods* are still declared structurally, which is what keeps `SidecarClient` itself out
 * of these tests.
 */
export interface CaptureSidecar {
  send(command: SidecarCommand): boolean;
  on<K extends CaptureSidecarEvent>(event: K, listener: (payload: SidecarClientEvents[K]) => void): () => void;
}

/** The part of `WindowManager` the mode machine touches. */
export interface OverlayWindows {
  /** @returns whether the overlay's visibility is now what was asked for. */
  setOverlayVisible(visible: boolean): boolean;
  openSettings(): unknown;
  /**
   * Tell the renderer to forget every position it remembers (#35).
   *
   * Called from here rather than from `WindowManager`'s own config listener because this class is
   * the one that knows a capture change has been *applied*: a region the user picked and a region
   * the sidecar accepted are not the same event, and clearing on the former would discard the
   * cache while the old region's frames were still arriving.
   */
  bumpOverlayEpoch(reason: string): void;
  /**
   * Blank whatever the overlay is showing, right now (#61).
   *
   * Not the same thing as {@link bumpOverlayEpoch}: bumping the epoch only changes how the *next*
   * payload is interpreted, and in `snapshot` mode - the case this exists for - the capture loop
   * is stopped, so there may never be a next payload to carry it. This has to make the screen
   * empty on its own. See `AppOrchestrator.dismiss` and `WindowManager.clearOverlay`.
   */
  clearOverlay(reason: string): void;
}

/** The part of `ConfigService` the mode machine reads and, since #29, writes. */
export interface CaptureConfigSource {
  readonly current: Config;
  subscribe(listener: (current: Config, previous: Config) => void): () => void;
  /**
   * Persist a change. The region picker's write path (#29/#31).
   *
   * Writing rather than pushing `configure` directly is deliberate - see
   * {@link AppOrchestrator.selectRegion}.
   */
  set(change: ConfigOverride): Promise<{
    readonly applied: boolean;
    readonly persisted: boolean;
    readonly errors: readonly { readonly path: string; readonly message: string }[];
  }>;
}

/** The part of `WindowManager` that opens a region picker (#29). */
export interface RegionPickerWindows {
  pickRegion(request: RegionPickRequest): Promise<RegionPickOutcome>;
}

/**
 * The part of `MonitorService` the mode machine uses.
 *
 * Structural, like everything else this class depends on, so the orchestrator's tests never
 * need Electron or a real display list.
 */
export interface MonitorRegistry {
  readonly monitors: readonly MonitorInfo[];
  setMonitors(monitors: readonly MonitorInfo[]): void;
  displayFor(monitorId: string): PairableDisplay | undefined;
}

/** Everything a listener needs to render the app's state - the tray's `TrayState`, plus nothing. */
export interface AppStatus {
  readonly mode: AppMode;
  readonly overlayVisible: boolean;
  readonly error: string | null;
  /**
   * A standing condition the user should act on. Four of them ride this one channel now: #30's
   * "text is touching the edge of your region", #31's "your saved region no longer applies", #50's
   * "auto mode has found nothing for a while", and #51's "no region has been chosen at all". See
   * {@link describeAppWarning} for how they differ once they reach the user - since #59 they do
   * not all behave the same way on the banner, and that file is where the distinction is made.
   *
   * Separate from `error` because they behave in opposite ways. An error is cleared by the next
   * frame that arrives, on the reasoning that a frame is evidence the failure is over. This is
   * the reverse: it is *produced* by frames arriving, and a run of healthy frames is exactly
   * when it is most true. Folded into `error`, it would be set and cleared by the same event.
   */
  readonly warning: string | null;
}

export interface AppOrchestratorOptions {
  readonly sidecar: CaptureSidecar;
  readonly config: CaptureConfigSource;
  readonly windows: OverlayWindows;
  readonly logger?: Logger;
  /** How long to wait for a `listMonitors` reply before giving up loudly (invariant 4). */
  readonly listMonitorsTimeoutMs?: number;
  /**
   * Where `listMonitors` replies are published, and where a monitor is turned into a display.
   *
   * Optional so the existing tests, which care only about mode transitions, need not supply
   * one. Without it {@link AppOrchestrator.selectRegion} has no way to pick a target and says
   * so rather than guessing at the primary.
   */
  readonly monitors?: MonitorRegistry;
  /** Opens the crosshair picker. Absent in tests that do not exercise region selection. */
  readonly picker?: RegionPickerWindows;
  /** How long auto mode may find nothing before the user is told (#50). */
  readonly idleWarningMs?: number;
  /** Injectable clock, so the idle warning is testable without waiting out a real interval. */
  readonly now?: () => number;
  /**
   * Injectable timer behind `modes.snapshotHoldMs` (#61), the same shape `error-reporter.ts` uses
   * for its banner timeout. Tests pass one they can fire by hand rather than waiting out a real
   * hold.
   */
  readonly schedule?: ScheduleTimer;
  /**
   * Told immediately after {@link AppOrchestrator.dismiss} actually clears the screen - by the
   * user, or by an expired hold (#61).
   *
   * Optional so the many tests here that do not care about it need not supply one. `index.ts`
   * wires it to `TextPipeline.resetScene`: the clear this class issues goes straight to the
   * window and never through the pipeline, so without this hook the pipeline's own memory of
   * what is on screen - `#displayed`, and #36's stability baseline - would survive a dismiss.
   * Left alone that is a real bug, not a cosmetic one: on a screen that has not changed, a second
   * dismiss-then-snapshot inside #36's `frames` window would be read as "nothing changed" and
   * suppressed, leaving Translate once pressed twice in a row showing nothing on an empty screen -
   * invariant 4 broken inside the very feature that exists to keep it.
   */
  readonly onDismissed?: () => void;
}

const DEFAULT_LIST_MONITORS_TIMEOUT_MS = 2_000;

/**
 * The real-timer default behind `modes.snapshotHoldMs` (#61), the same shape as
 * `error-reporter.ts`'s own default for its banner timeout - `setTimeout` plus `unref()`, for the
 * same reason that file gives: a pending hold timer must never be the reason `app.quit()` waits
 * around for a cosmetic countdown to finish. Not imported from there because that function is not
 * exported - the two files each own a private default behind the same public `ScheduleTimer` shape.
 */
function scheduleWithTimeout(handler: () => void, delayMs: number): CancelTimer {
  const timer = setTimeout(handler, delayMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

/**
 * What {@link AppStatus.error} says when the sidecar died on its own.
 *
 * Exported so `index.ts` can recognise it rather than match on the text. The supervisor (#40) tells
 * a much more useful version of the same story - "restarting, about 2s" or "gave up, here is how to
 * retry" - and the two must not both be shown, because the one that wins on severity would be the
 * one that says least (#41: "error หลายตัวพร้อมกัน → แสดงตัวที่ร้ายแรงที่สุด ไม่ซ้อนกันรก").
 */
export const SIDECAR_EXIT_ERROR = 'the capture sidecar stopped unexpectedly';

/**
 * How long auto mode may run without a single frame before the user is told (#50).
 *
 * The failure this exists for: with a full-screen region and the default threshold, a subtitle
 * changing on an otherwise still screen changes well under 2% of the pixels, so every tick is
 * `nochange` and **nothing at all reaches the screen**. The app looks healthy from every angle -
 * the tray says `auto`, the sidecar is genuinely capturing and genuinely burning CPU - and the
 * user concludes that OCR or translation is broken, when neither was ever called. That is
 * invariant 4 violated as directly as it can be.
 *
 * 25 seconds is long enough not to fire during an ordinary pause between subtitles (the design
 * doc's use case is text changing every 2-3s, so this is roughly ten missed lines) and short
 * enough that a user who has just picked a bad region finds out while they still remember doing
 * it.
 */
const DEFAULT_IDLE_WARNING_MS = 25_000;

/**
 * What the user is told while no capture region has been chosen (#51).
 *
 * The condition it names is a real one and it is not a matter of taste. With `region: null` the
 * region is the whole display, and `decideDiffThreshold` turns the default 0.005 fraction into
 * 0.0008 on a 3440x1440 screen because `diffMaxRequiredPx` is the smaller of the two there (#54).
 * A live desktop is never still - a clock, a caret, a notification - so a fresh install pressing
 * auto captures, OCRs and translates on nearly every tick, on content nobody asked about.
 *
 * #51 is explicit that retuning the numbers is not the answer: the value that makes a subtitle
 * detectable and the value that makes a desktop quiet are on opposite sides of each other, and
 * three regression tests hold the current ones shut precisely so that #50 cannot come back.
 */
export const NO_REGION_WARNING =
  'no capture region has been chosen, so Textlens would translate the whole screen';

/**
 * {@link AppStatus.warning} as the alert the user-facing surfaces show (#41, #59).
 *
 * Here rather than in `index.ts` for two reasons. It has to be testable without Electron, and it
 * belongs next to the text it keys on: four separate conditions arrive on this one channel - text
 * clipping the region (#30), a saved region that no longer applies (#31), auto mode finding
 * nothing (#50), and no region chosen at all (#51) - and only this file knows which is which.
 *
 * **Three of the four should stop covering the screen after a while; the fourth must not.** #51's
 * warning is not an event that happened, it is the state the app is deliberately resting in: it
 * sits in `idle` translating nothing, and this sentence is the only thing on screen explaining
 * why. Timing it out would leave a first run looking like an app that simply does nothing, which
 * is the silence #51 was filed to end. The other three describe something that is going wrong
 * while the app runs, the tray keeps the text either way, and the region is still being captured
 * whether or not the banner is up.
 *
 * Keyed on the exported constant by identity, not on a substring or a severity or the source -
 * the same reason `SIDECAR_EXIT_ERROR` is exported rather than matched on. A future warning
 * cannot acquire the exemption by wording itself similarly, and a reworded {@link
 * NO_REGION_WARNING} cannot silently lose it, because both sides move together in one file.
 *
 * **The remedy has the same first-run problem the timeout did (#64).** All four used to share one
 * sentence ending "...to **change** what is being captured", which is fine advice for #30, #31 and
 * #50 - something was chosen, and this is how to choose differently - and wrong for #51: nothing
 * has been chosen yet, so "change" names an act with no object. `firstRun` below is the same
 * identity check `sticky` already uses, read once and spent on both, so the remedy and the timeout
 * exemption cannot disagree about which case a given warning is.
 */
export function describeAppWarning(warning: string | null): Omit<Alert, 'source'> | null {
  if (warning === null) return null;
  const firstRun = warning === NO_REGION_WARNING;
  return {
    severity: 'warning',
    cause: warning,
    remedy: firstRun
      ? 'use the tray menu → "Select Region…" to choose what Textlens should capture'
      : 'use the tray menu → "Select Region…" to change what is being captured',
    sticky: firstRun,
  };
}

export class AppOrchestrator {
  readonly #sidecar: CaptureSidecar;
  readonly #config: CaptureConfigSource;
  readonly #windows: OverlayWindows;
  readonly #log: Logger;
  readonly #listMonitorsTimeoutMs: number;
  readonly #monitors: MonitorRegistry | null;
  readonly #picker: RegionPickerWindows | null;

  readonly #unsubscribes: Array<() => void> = [];
  readonly #listeners = new Set<(status: AppStatus) => void>();

  /** The desired mode. Assigned synchronously by every transition; the single source of truth. */
  #mode: AppMode = 'idle';
  /** A `configure` has been acknowledged, so `start`/`stop`/`snapshot` are legal to send. */
  #configured = false;
  /** What this object believes the sidecar's capture loop is doing. */
  #capturing = false;
  /** The `state` from the sidecar's most recent `ack` - *its* view, for divergence checks. */
  #sidecarState: string | null = null;
  #overlayVisible = true;
  #lastError: string | null = null;
  /** Standing "your region is clipping text" condition (#30). Not an error - see `AppStatus`. */
  #regionWarning: string | null = null;
  readonly #edgeThrottle = new EdgeWarningThrottle();
  /** Standing "auto mode is finding nothing at all" condition (#50). */
  #idleWarning: string | null = null;
  /**
   * Which change-detection rule was in force at the last `configure` (#54).
   *
   * Held rather than recomputed because {@link #checkIdle} runs off `nochange` events and has no
   * region to hand. It exists so the idle warning can stop recommending a knob that cannot move:
   * on a large region `diffThreshold` is inert, and that is precisely the region a user staring at
   * a dry spell is most likely to have drawn.
   */
  #diffGovernedBy: 'fraction' | 'maxRequiredPx' = 'fraction';
  /**
   * Standing "your saved region no longer applies" condition (#31).
   *
   * Standing rather than an error, because the fallback - capturing the whole monitor - starts
   * producing frames immediately, and frames clear errors. See {@link #resolveRegion}.
   */
  #regionBindingWarning: string | null = null;
  /** Standing "you have not chosen a region yet" condition (#51). See {@link NO_REGION_WARNING}. */
  #noRegionWarning: string | null = null;
  /** When the last `frame` arrived. `null` means none has since capture started. */
  #lastFrameAt: number | null = null;
  readonly #idleWarningMs: number;
  readonly #now: () => number;
  /** A snapshot was asked for and has not been sent yet - only possible before `configure`. */
  #pendingSnapshot = false;
  /** Serialises the async configure path so two config changes cannot interleave. */
  #configuring: Promise<void> = Promise.resolve();
  /** A region picker is open. Guards against a second hotkey press opening a second one. */
  #picking = false;
  #disposed = false;
  readonly #schedule: ScheduleTimer;
  readonly #onDismissed: (() => void) | null;
  /**
   * Cancels the pending `modes.snapshotHoldMs` timer, or `null` when nothing is counting down
   * (#61). Never left dangling: every place the countdown could stop meaning what it meant when it
   * was started - a fresh snapshot, leaving `snapshot` mode, a dismiss, disposal - cancels this
   * first. See {@link #cancelHold}.
   */
  #holdCancel: CancelTimer | null = null;

  constructor(options: AppOrchestratorOptions) {
    this.#sidecar = options.sidecar;
    this.#config = options.config;
    this.#windows = options.windows;
    this.#log = (options.logger ?? nullLogger()).child('mode');
    this.#listMonitorsTimeoutMs = options.listMonitorsTimeoutMs ?? DEFAULT_LIST_MONITORS_TIMEOUT_MS;
    this.#monitors = options.monitors ?? null;
    this.#picker = options.picker ?? null;
    this.#idleWarningMs = options.idleWarningMs ?? DEFAULT_IDLE_WARNING_MS;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? scheduleWithTimeout;
    this.#onDismissed = options.onDismissed ?? null;

    this.#unsubscribes.push(
      this.#sidecar.on('ack', (ack) => {
        this.#sidecarState = ack.state;
      }),
      this.#sidecar.on('error', (error) => {
        this.#fail(`${error.code}: ${error.message}`);
      }),
      this.#sidecar.on('frame', (frame) => {
        // A frame arriving is the only evidence that whatever failed is over. Clearing on
        // anything less would leave the tray red for the rest of the session.
        let changed = false;
        if (this.#lastError !== null) {
          this.#lastError = null;
          changed = true;
        }
        // The edge check lives here, inside the listener that clears the error, because the two
        // interact: registered in `index.ts` instead, it would run *before* this one and its
        // report would be wiped by the very same frame that produced it.
        if (this.#checkRegionEdges(frame)) changed = true;
        // A frame is the end of any dry spell, by definition.
        this.#lastFrameAt = this.#now();
        if (this.#idleWarning !== null) {
          this.#idleWarning = null;
          changed = true;
        }
        if (changed) this.#notify();
      }),
      this.#sidecar.on('nochange', () => {
        if (this.#checkIdle()) this.#notify();
      }),
      this.#sidecar.on('exit', (exit) => {
        // Nothing can be sent to a process that is gone, and pretending otherwise would
        // leave `#capturing` true so the next `start` was skipped as redundant.
        this.#configured = false;
        this.#capturing = false;
        this.#pendingSnapshot = false;
        this.#lastFrameAt = null;
        this.#idleWarning = null;
        // The **mode is kept**, and that changed with #40. It used to drop to `idle`, which was
        // right while nothing restarted the sidecar and is wrong now that something does:
        //
        //   - `SidecarSupervisor` refuses to restart a sidecar that died while the user had
        //     deliberately paused, and the only record of that intent is this field. Reset to
        //     `idle` here, "paused" would be indistinguishable from "never started" and the
        //     supervisor would restart a process the user asked to stop.
        //   - A restart re-runs {@link initialize}, which resumes whatever mode this holds. A
        //     reset would have every crash silently promote `paused` to `auto`.
        //
        // `#configured` is what actually gates sending, so keeping the mode cannot make anything
        // be sent at a process that is gone.
        if (!exit.expected) this.#lastError = SIDECAR_EXIT_ERROR;
        this.#notify();
      }),
      this.#config.subscribe((current, previous) => {
        this.#onConfigChanged(current, previous);
      }),
    );
  }

  get mode(): AppMode {
    return this.#mode;
  }

  get overlayVisible(): boolean {
    return this.#overlayVisible;
  }

  /** Whether the sidecar has an applied configuration. False until {@link initialize} finishes. */
  get configured(): boolean {
    return this.#configured;
  }

  /** What this object believes the sidecar's loop is doing. */
  get capturing(): boolean {
    return this.#capturing;
  }

  /** The sidecar's own last-reported state, for asserting the two have not diverged. */
  get sidecarState(): string | null {
    return this.#sidecarState;
  }

  get status(): AppStatus {
    return {
      mode: this.#mode,
      overlayVisible: this.#overlayVisible,
      error: this.#lastError,
      // Ranked by how badly the user is being misled, most first:
      //   idle     - nothing is reaching the screen at all
      //   binding  - something is, but it is the whole monitor rather than the region they chose
      //   noRegion - nothing has been chosen at all, so the whole screen is the region (#51)
      //   region   - the right region, but it is clipping text
      // In practice they rarely coexist: the frame that raises an edge warning is the frame that
      // ends a dry spell, and a dropped region means there is no region to clip against.
      //
      // `noRegion` sits below `binding` because they describe the same symptom from different
      // causes and `binding` is the more specific: a saved region that stopped applying tells the
      // user something changed under them, which "you have not picked one" would not.
      warning:
        this.#idleWarning ?? this.#regionBindingWarning ?? this.#noRegionWarning ?? this.#regionWarning,
    };
  }

  /** Subscribe to status changes. Returns an unsubscribe, matching `ConfigService.subscribe`. */
  subscribe(listener: (status: AppStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Discover the monitors, configure the sidecar, and enter `auto`.
   *
   * **This is the only place capture is ever started.** Called after the sidecar reports
   * `ready`. Entering `auto` rather than waiting for a keypress is feature G3's "โหมดหลัก": the
   * app exists to translate what is on screen, and a launch that produces nothing until a
   * shortcut is found is a launch the user reads as broken.
   *
   * **Called again after every supervised restart** (#40), which is why it is written to be
   * re-entrant rather than once-only: `#reconfigure` chains onto `#configuring` so a restart
   * arriving mid-config cannot interleave two `listMonitors` round trips, and the `if (mode ===
   * 'idle')` below is what makes a restart resume the mode the user was actually in instead of
   * promoting `paused` to `auto`. A restart that skipped this would leave a live sidecar that was
   * never told what to capture - which looks exactly like success in the log until somebody
   * notices no frames arrived.
   */
  async initialize(): Promise<void> {
    await this.#reconfigure(this.#config.current.capture, 'startup');
    if (!this.#configured) return;

    // Not an unconditional assignment: a user who hit the hotkey during startup has already
    // expressed a preference, and overwriting it here is the race this ordering avoids.
    //
    // **And not unconditional in the other direction either, since #51.** With no region chosen
    // the region is the whole display, and auto on a whole display translates a live desktop on
    // nearly every tick - see {@link NO_REGION_WARNING}. So a first run rests in `idle` with a
    // standing warning, and the way in is picking a region: `toggleAuto` and `resume` both route
    // to the picker while there is none, and {@link selectRegion} enters `auto` itself once one
    // exists.
    //
    // The gate is **here**, not only on those two transitions, and that placement is the whole of
    // it: this method re-runs after every supervised restart (`SidecarSupervisor.onStarted`), so a
    // gate that lived only in `toggleAuto` would have any sidecar crash silently promote a
    // first-run `idle` to `auto` - the #51 behaviour arriving by a route nobody chose.
    if (this.#mode === 'idle' && this.#hasRegion) this.#mode = 'auto';
    this.#refreshNoRegionWarning();
    this.#apply();
    this.#notify();
  }

  /** Whether the user has ever chosen a capture region (#51). */
  get #hasRegion(): boolean {
    return this.#config.current.capture.region !== null;
  }

  /**
   * Keep {@link #noRegionWarning} in step with config.
   *
   * @returns whether it changed and subscribers need telling.
   */
  #refreshNoRegionWarning(): boolean {
    const message = this.#hasRegion ? null : NO_REGION_WARNING;
    if (this.#noRegionWarning === message) return false;
    this.#noRegionWarning = message;
    return true;
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /** The main switch: `auto` stops, anything else starts. Bound to `Control+Alt+A`. */
  toggleAuto(): void {
    if (this.#mode === 'auto') {
      this.#transition('paused', 'toggleAuto');
      return;
    }
    if (this.#routeToPickerIfNoRegion('toggleAuto')) return;
    this.#transition('auto', 'toggleAuto');
  }

  /** Enter `auto` regardless of where we were. */
  resume(): void {
    if (this.#routeToPickerIfNoRegion('resume')) return;
    this.#transition('auto', 'resume');
  }

  /**
   * #51's flow, in one place: asking for `auto` with no region opens the picker instead.
   *
   * The issue's first option, and the reason it is the right one is that the region picker already
   * exists (#29). Full-screen auto was a shortcut worth having while there was no other way to
   * start; now that there is, defaulting to "translate the entire desktop" is not a shortcut, it is
   * a setting nobody would choose. It is also **not** a number to retune - see
   * {@link NO_REGION_WARNING}.
   *
   * Cancelling the picker leaves the app exactly where it was, in `idle` with the standing warning
   * still up, which is the honest outcome: the user was asked and declined, and nothing should
   * start behind that. {@link selectRegion} is what turns a completed pick into `auto`.
   *
   * @returns whether the caller should stop, because the picker was opened instead.
   */
  #routeToPickerIfNoRegion(reason: string): boolean {
    if (this.#hasRegion) return false;
    this.#log.info('no capture region has been chosen; opening the picker instead of starting auto', {
      reason,
      mode: this.#mode,
    });
    if (this.#refreshNoRegionWarning()) this.#notify();
    // Fire and forget, like every other caller of this method - it never rejects.
    void this.selectRegion();
    return true;
  }

  /**
   * Stop capturing for real (G5).
   *
   * Only meaningful from `auto` - the other three modes are already stopped, and moving
   * `snapshot` to `paused` would throw away the held frame the user asked for.
   */
  pause(): void {
    if (this.#mode !== 'auto') {
      this.#log.debug('pause ignored; nothing is capturing', { mode: this.#mode });
      return;
    }
    this.#transition('paused', 'pause');
  }

  /**
   * Capture one frame now and hold it - "Translate once" (G4).
   *
   * **A mode, entered from wherever the user was, including `auto`.** That last word is #60's
   * reversal of #34; the module doc records the rule it replaces and the evidence that moved it.
   * The mechanism is entirely in {@link #apply}'s ordering: the mode is no longer `auto`, so the
   * loop is stopped first and the `snapshot` command is sent last, leaving no tick to overwrite
   * the frame. Returning to `auto` - the tray's Auto item, `Control+Alt+A`, {@link toggleAuto} or
   * {@link resume} - starts it again.
   *
   * Still synchronous, and that is not incidental: the assignment and the `#apply` below are the
   * whole transition, so hammering the key is a sequence of assignments rather than a race (see
   * the module doc's "Why rapid mode switching cannot corrupt anything").
   *
   * A press that arrives before the sidecar is configured is **held**, not dropped:
   * {@link #apply} fires it as soon as `configure` lands. Dropping it would leave the app
   * sitting in `snapshot` mode having captured nothing, which is the state a user reads as
   * "the button does not work". A burst of presses collapses to one, because a flag is not
   * a queue - and replaying four snapshots of the same screen is not what the fourth press
   * meant.
   */
  snapshot(): void {
    const previous = this.#mode;
    this.#mode = 'snapshot';
    this.#pendingSnapshot = true;

    this.#log.info('snapshot requested', { mode: this.#mode, from: previous });
    this.#apply();
    if (previous !== this.#mode) this.#notify();
  }

  /**
   * Clear whatever the overlay is showing, **without** touching the mode (#61).
   *
   * Not `toggleOverlay`, which #34 is emphatic only hides the *window*: capture, OCR and
   * translation carry on underneath it. This does the opposite - it never touches visibility and
   * never sends anything to the sidecar - it empties the picture the window is drawing. After it
   * runs the user is exactly where they were: still Translate once (or Auto, or wherever they
   * were), with nothing on screen, free to press the same action again.
   *
   * **The one path both a hand-pressed dismiss and an expired `modes.snapshotHoldMs` use.** Every
   * caller - the hotkey, the tray, {@link #scheduleSnapshotHold}'s own timeout - reaches the
   * screen through this single method, so there is exactly one way it goes empty on its own
   * rather than two implementations that have to be kept agreeing forever.
   *
   * Harmless with nothing displayed: this never reads or writes `#mode`, and it never calls
   * `#apply` or touches `#sidecar`, so a dismiss on an empty screen sends nothing anywhere - it is
   * simply a clear that had nothing to clear.
   */
  dismiss(): void {
    this.#cancelHold();
    this.#windows.clearOverlay('dismiss');
    this.#onDismissed?.();
    this.#log.info('dismissed', { mode: this.#mode });
  }

  /**
   * Show or hide the boxes **without** touching the pipeline (#34: "ซ่อน overlay ≠ pause").
   *
   * Nothing in this method reaches the sidecar, which is the entire point: capture, OCR and
   * translation carry on, so unhiding shows what is on screen now rather than what was there
   * when it was hidden.
   */
  toggleOverlay(): void {
    this.setOverlayVisible(!this.#overlayVisible);
  }

  setOverlayVisible(visible: boolean): void {
    if (this.#overlayVisible === visible) return;
    const ok = this.#windows.setOverlayVisible(visible);
    if (!ok) {
      this.#log.warn('could not change overlay visibility', { visible });
      return;
    }
    this.#overlayVisible = visible;
    this.#log.info('overlay visibility changed', { visible, mode: this.#mode });
    this.#notify();
  }

  /**
   * Run the region picker and adopt whatever the user draws (M6-02 / #29).
   *
   * ## The write goes through `ConfigService.set`, not straight to `configure`
   *
   * That is what makes the region persist (#31) and what keeps this class the only sender of
   * `configure`: `set` commits, notifies, and {@link #onConfigChanged} pushes the new capture
   * settings to the sidecar by the path that already existed. Sending `configure` from here
   * *and* writing config would be two routes to the same state, which is the exact shape of
   * the bug this class was created to prevent.
   *
   * ## Coordinates
   *
   * The picker reports CSS px in its own window. {@link toPhysicalRegion} turns that into the
   * physical, monitor-relative rectangle the sidecar crops with, using the window origin the
   * picker actually got and the paired display's scale factor. No arithmetic happens in this
   * file - invariant 3.
   *
   * Fire-and-forget from the tray and the hotkey, so nothing here may reject.
   */
  async selectRegion(): Promise<void> {
    const picker = this.#picker;
    if (picker === null) {
      this.#fail('the region picker is unavailable in this build');
      return;
    }
    if (this.#picking) {
      this.#log.info('a region picker is already open; ignoring the second request');
      return;
    }

    const target = this.#pickTarget();
    if (target === null) return;

    this.#picking = true;
    try {
      const outcome = await picker.pickRegion({
        displayId: target.display.id,
        monitorId: target.monitor.id,
        monitorLabel: target.display.label,
        monitorSize: [target.monitor.bounds[2], target.monitor.bounds[3]],
        minimumPx: MIN_REGION_PX,
        current: null,
      });

      if (outcome === null) {
        // #29: "Esc ยกเลิกแล้วกลับไปใช้กรอบเดิม". Nothing is written, so the old region stands
        // by virtue of never having been touched.
        this.#log.info('region selection cancelled; the previous region still applies');
        return;
      }

      const rect = toPhysicalRegion(outcome.rect, outcome.origin, target.display);
      const size = checkRegionSize(rect);
      if (!size.ok) {
        // The picker refuses these before submitting, so reaching here means the two disagree
        // about the minimum - worth saying rather than silently widening it.
        this.#fail(size.message);
        return;
      }

      const monitorSize: readonly [number, number] = [target.monitor.bounds[2], target.monitor.bounds[3]];
      // Clamped, not padded. The stored region is the raw drag; the margin (#30) is applied when
      // it is turned into a `configure`, so that changing the margin later changes the result.
      const clamped = clampRegion(rect, monitorSize);

      const result = await this.#config.set({
        capture: {
          monitorId: target.monitor.id,
          region: { rect: clamped, monitorId: target.monitor.id, monitorSize },
        },
      });

      if (!result.applied) {
        this.#fail(`the selected region was rejected: ${result.errors.map((e) => e.path).join(', ')}`);
        return;
      }
      if (!result.persisted) {
        // Live for this session but not remembered - the user needs to know before they restart
        // and find themselves drawing it again.
        this.#log.warn('the region is active but could not be saved; it will be lost on restart');
      }

      this.#log.info('region selected', {
        monitorId: target.monitor.id,
        region: clamped,
        persisted: result.persisted,
      });

      // #51's other half. The warning is cleared and, if this is the first region the app has ever
      // had, capture starts - because the user who just drew a box around a subtitle has said what
      // they want at least as clearly as pressing the hotkey would.
      const warningChanged = this.#refreshNoRegionWarning();

      if (this.#mode === 'idle') {
        // The write above notified `#onConfigChanged`, which started a `configure` for the new
        // region. Waiting for it means the `start` below cannot be sent against the region being
        // replaced - which on a first run is the whole display, i.e. exactly one tick of the
        // behaviour this issue exists to remove. Resolved already when nothing changed.
        await this.#configuring;
        this.#transition('auto', 'first region selected');
      } else if (warningChanged) {
        this.#notify();
      }
    } finally {
      this.#picking = false;
    }
  }

  /**
   * Which monitor and display the picker should open on.
   *
   * `null` means it cannot be answered, and every route to that has already reported itself.
   * Notably it does **not** fall back to the primary display: opening the picker on a screen
   * the user did not choose would have them draw a region against the wrong content, and the
   * result would look completely successful.
   */
  #pickTarget(): { monitor: MonitorInfo; display: PairableDisplay } | null {
    const monitors = this.#monitors;
    if (monitors === null) {
      this.#fail('monitors have not been enumerated yet, so there is nothing to pick a region on');
      return null;
    }

    const monitor = this.#chooseMonitor(monitors.monitors, this.#config.current.capture);
    if (monitor === undefined) {
      this.#fail('no monitors are available to pick a region on');
      return null;
    }

    const display = monitors.displayFor(monitor.id);
    if (display === undefined) {
      this.#fail(
        `${monitor.id} could not be matched to a display, so a region picked on it could not be `
          + 'converted; see the monitor pairing warnings in the log',
      );
      return null;
    }

    return { monitor, display };
  }

  openSettings(): void {
    this.#windows.openSettings();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // A pending hold has nothing left to time once this object stops reacting to anything (#61,
    // case 4 of "the timer must never outlive what it was timing").
    this.#cancelHold();
    for (const off of this.#unsubscribes) off();
    this.#unsubscribes.length = 0;
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #transition(next: AppMode, reason: string): void {
    if (this.#mode === next) return;
    // Leaving `snapshot` for anything else (#61, case 2 of "the timer must never outlive what it
    // was timing" - "the user switches to Auto"). A hold timer counting down against a frame that
    // is no longer the held snapshot must not fire later and blank whatever this mode is showing
    // instead - `paused`'s frozen boxes included, which this also protects even though only Auto
    // is named in the issue.
    if (this.#mode === 'snapshot') this.#cancelHold();
    const previous = this.#mode;
    this.#mode = next;
    this.#log.info('mode changed', { from: previous, to: next, reason });
    this.#apply();
    this.#notify();
  }

  /**
   * Make the sidecar match {@link #mode}. Synchronous, idempotent, and the only place a
   * `start` or a `stop` is sent.
   *
   * Reading `#mode` here rather than taking it as a parameter is what collapses a burst of
   * transitions into the commands the *final* mode needs: whatever order the presses arrived
   * in, this always compares the mode that is current now against the sidecar's actual state.
   */
  #apply(): void {
    if (!this.#configured) {
      // The desired mode - and a pending snapshot - are still recorded; the reconcile that
      // runs once `configure` lands applies whatever the user settled on.
      this.#log.debug('deferring; the sidecar is not configured yet', {
        mode: this.#mode,
        pendingSnapshot: this.#pendingSnapshot,
      });
      return;
    }

    const shouldCapture = this.#mode === 'auto';
    if (shouldCapture !== this.#capturing) {
      // Any change of intent restarts the dry-spell clock and drops a stale idle warning (#50).
      // Without this, pausing for a minute and resuming would warn on the first `nochange`
      // after resuming, blaming the region for time the app spent deliberately stopped.
      this.#lastFrameAt = null;
      this.#idleWarning = null;
      if (shouldCapture) {
        // Only believed once the write succeeded. A dropped `start` that still flipped this
        // would make the next one look redundant and be skipped - a permanently stopped app
        // reporting `auto`.
        this.#capturing = this.#sidecar.send({ cmd: 'start' });
        if (!this.#capturing) this.#log.error('could not start capture: the sidecar took no command');
      } else {
        this.#sidecar.send({ cmd: 'stop' });
        // Unconditionally false: a `stop` that could not be sent means there is no sidecar
        // to be capturing.
        this.#capturing = false;
      }
    }

    // Last, and since #60 this ordering is the whole of "Translate once holds". `snapshot()` sets
    // the mode to `snapshot` from anywhere, so the block above has already sent `stop` by the time
    // this runs; the frame that comes back is the last one the sidecar will produce until the user
    // asks for `auto` again. Sent first instead, the tick 800ms later would replace it - which is
    // precisely what the app did before, from the mode users spend all their time in.
    if (this.#pendingSnapshot) {
      this.#pendingSnapshot = false;
      this.#sidecar.send({ cmd: 'snapshot' });
      // #61: arm (or re-arm) the automatic clear for the frame this command is about to produce.
      this.#scheduleSnapshotHold();
    }
  }

  /**
   * (Re)start the countdown to an automatic {@link dismiss}, if `modes.snapshotHoldMs` asks for
   * one (#61).
   *
   * Called from exactly one place: the line in {@link #apply} that just sent the `snapshot`
   * command this timer is timing. That is deliberate and it is what makes case 1 of "the timer
   * must never outlive what it was timing" - pressing Translate once again while a hold is already
   * counting down - correct for free: every `snapshot()` press re-enters this method through
   * `#apply`, which cancels whatever was running and starts a fresh `snapshotHoldMs` from zero for
   * the new frame, rather than letting the old countdown reach the new one.
   *
   * **Gated on `#mode` at the moment the command is actually sent, not at the moment `snapshot()`
   * was called.** `#pendingSnapshot` can survive a mode change while the sidecar was not yet
   * configured - `snapshot()` can be pressed, then `toggleAuto()`, before `configure` ever lands -
   * and when the deferred `snapshot` command finally goes out here the mode may already be `auto`.
   * Arming a timer in that case would leave it counting down against `auto`'s live content and
   * blank a frame the user never asked to hold, which is exactly the failure case 1 exists to
   * name from a different angle.
   */
  #scheduleSnapshotHold(): void {
    this.#cancelHold();
    if (this.#mode !== 'snapshot') return;
    const holdMs = this.#config.current.modes.snapshotHoldMs;
    if (holdMs <= 0) return;
    this.#holdCancel = this.#schedule(() => {
      this.#holdCancel = null;
      this.#log.info('snapshot hold expired; clearing it the same way a dismiss would', { holdMs });
      this.dismiss();
    }, holdMs);
  }

  /** Cancel the pending hold timer, if any. Calling it with nothing pending is harmless. */
  #cancelHold(): void {
    this.#holdCancel?.();
    this.#holdCancel = null;
  }

  /**
   * `listMonitors`, then `configure`. Resolves once the configure is acknowledged, or once
   * it is clear no reply is coming.
   *
   * Chained onto {@link #configuring} so a config change arriving mid-startup cannot
   * interleave two `listMonitors` round trips - the protocol correlates replies by `cmd`
   * alone (`AckEvent`), so two outstanding `listMonitors` would be genuinely ambiguous.
   */
  async #reconfigure(capture: CaptureConfig, reason: string): Promise<void> {
    const run = this.#configuring.then(async () => {
      await this.#configureOnce(capture, reason);
    });
    // Kept as the tail even if it rejected, so one failure does not wedge the chain.
    this.#configuring = run.catch(() => undefined);
    await run;
  }

  async #configureOnce(capture: CaptureConfig, reason: string): Promise<void> {
    const monitors = await this.#listMonitors();
    if (monitors === null) return;

    const monitor = this.#chooseMonitor(monitors, capture);
    if (monitor === undefined) {
      this.#fail('the sidecar reported no monitors, so capture cannot start');
      return;
    }

    const bindingWarningBefore = this.#regionBindingWarning;
    const region = this.#resolveRegion(capture, monitor, monitors);
    const bindingWarningChanged = this.#regionBindingWarning !== bindingWarningBefore;

    const decision = decideDiffThreshold(region, capture.diffThreshold, capture.diffMaxRequiredPx);
    this.#diffGovernedBy = decision.governedBy;
    // #54, invariant 4. A `diffThreshold` that is not in force is a knob the user can turn all
    // day for no effect, and the only thing worse than a setting that does nothing is one that
    // does nothing quietly. Logged on every configure rather than only when it changes: the
    // region is what decides this, so the same configured number flips between live and inert as
    // the user redraws their box, and the line has to be findable next to the region that caused
    // it. Both numbers are named because the point is the comparison between them.
    if (decision.governedBy === 'maxRequiredPx') {
      this.#log.warn(
        'the configured diffThreshold has no effect on a region this large; '
          + 'capture.diffMaxRequiredPx is the smaller of the two rules and decides instead (#54)',
        {
          region,
          regionPx: region[2] * region[3],
          configuredDiffThreshold: capture.diffThreshold,
          diffMaxRequiredPx: capture.diffMaxRequiredPx,
          effectiveDiffThreshold: decision.effective,
          // What the two settings mean in the unit a human can picture, side by side.
          requiredPx: Math.round(decision.requiredPx),
          requiredPxIfFractionGoverned: Math.round(capture.diffThreshold * region[2] * region[3]),
        },
      );
    }

    const acked = await this.#send(
      {
        cmd: 'configure',
        region,
        monitorId: monitor.id,
        intervalActive: capture.intervalActive,
        intervalIdle: capture.intervalIdle,
        // Not `capture.diffThreshold` directly (#50). The wire carries a fraction, and a
        // fraction means different things at different region sizes - which is the root cause
        // the issue names. This is where the configured fraction and the pixel ceiling are
        // reconciled, because it is the first point at which the region's size is known.
        diffThreshold: decision.effective,
        ocrLanguage: capture.ocrLanguage,
        debugFrameEnabled: capture.debugFrameEnabled,
      },
      'configure',
    );

    if (!acked) {
      this.#fail('the sidecar did not acknowledge configure; capture is unavailable');
      return;
    }

    this.#configured = true;
    this.#log.info('capture configured', {
      reason,
      monitorId: monitor.id,
      scale: monitor.scale,
      region,
      intervalActive: capture.intervalActive,
      intervalIdle: capture.intervalIdle,
      // Both numbers, because the difference between them is the whole of #50 and a log that
      // showed only the configured fraction would not explain the loop's actual behaviour. Since
      // #54, which of the two rules produced it as well - the pair alone leaves the reader to
      // work out which one won, and that is the fact they came for.
      diffThreshold: capture.diffThreshold,
      effectiveDiffThreshold: decision.effective,
      diffGovernedBy: decision.governedBy,
      diffRequiredPx: Math.round(decision.requiredPx),
      ocrLanguage: capture.ocrLanguage,
      debugFrameEnabled: capture.debugFrameEnabled,
    });

    // A `configure` while the loop was running leaves it running (`Dispatcher.Configure`),
    // so `#capturing` is still correct. This re-asserts the mode for the other direction:
    // a configure sent while paused must not have quietly resumed anything.
    this.#apply();
    // Only when `#resolveRegion` actually changed the stale-region warning. Notifying
    // unconditionally would emit an extra status on every startup, before `initialize` has set
    // the mode - a spurious `idle` that subscribers would render.
    if (bindingWarningChanged) this.#notify();
  }

  /**
   * Turn the saved region into the rectangle that goes on the wire (#30, #31).
   *
   * Three things happen here and the order matters:
   *
   *   1. **Validate the binding.** A saved region names the monitor it was drawn on and that
   *      monitor's size at the time. If either has changed, the region is dropped and the
   *      whole monitor is captured instead - loudly. #31 is explicit that a stale region must
   *      never be applied silently, and the reason is that a wrong region looks exactly like a
   *      right one: the app runs, the boxes appear, and they are over the wrong content.
   *      Rescaling the old rectangle to the new resolution is deliberately *not* done, because
   *      a region is chosen by pointing at content and content does not move proportionally.
   *   2. **Pad it** by `regionPadding` (#30). Spike S1 measured that a crop through a glyph
   *      breaks OCR outright, and the box a user drags is the box they see, which is tighter
   *      than the glyphs actually are.
   *   3. **Clamp to the monitor**, so padding a subtitle region at the bottom of the screen -
   *      the normal case - cannot produce a rectangle that runs off it.
   *
   * `null` region means the whole display, and that path is unchanged: the size comes straight
   * from the sidecar's own reply, so no conversion happens in Node.
   */
  #resolveRegion(capture: CaptureConfig, monitor: MonitorInfo, monitors: readonly MonitorInfo[]): Rect {
    const monitorSize: readonly [number, number] = [monitor.bounds[2], monitor.bounds[3]];
    const whole: Rect = [0, 0, monitorSize[0], monitorSize[1]];

    const saved = capture.region;
    if (saved === null) {
      this.#regionBindingWarning = null;
      return whole;
    }

    const verdict = checkSavedRegion(saved, monitors);
    if (!verdict.ok) {
      // The **standing warning** channel, not `#fail`.
      //
      // `#fail` sets `#lastError`, and `#lastError` is cleared by the next frame that arrives -
      // deliberately, because a frame is evidence a failure is over. But the fallback here is to
      // capture the whole monitor, which starts producing frames within about a second. Routed
      // through `#fail`, #31's "your saved region is stale, pick a new one" would light the tray
      // red for under a second and then vanish, and the user would never read it. That is the
      // same clear-on-frame interaction the edge warning is structured around, and #31's promise
      // - a stale region is never dropped silently - is only kept if the report outlives the
      // recovery.
      const message = `${verdict.message} - capturing the whole monitor until a new region is picked`;
      this.#regionBindingWarning = message;
      this.#log.warn(message, { reason: verdict.reason, monitorId: saved.monitorId });
      return whole;
    }

    this.#regionBindingWarning = null;

    if (verdict.monitor.id !== monitor.id) {
      // The region is valid for the monitor it names, but a different one is being captured.
      // Capturing the whole target monitor beats applying another screen's rectangle to it.
      this.#log.warn('the saved region belongs to a different monitor than the one being captured', {
        regionMonitorId: saved.monitorId,
        capturingMonitorId: monitor.id,
      });
      return whole;
    }

    const padded = padRegion(saved.rect, capture.regionPadding, monitorSize);
    this.#log.info('region resolved', {
      monitorId: monitor.id,
      saved: saved.rect,
      padding: capture.regionPadding,
      applied: padded,
    });
    return padded;
  }

  /**
   * Which display to capture.
   *
   * A configured monitor that is no longer attached falls back to the primary, and says so:
   * issue #35 (R2) is explicit that a stale monitor id must never be substituted silently.
   */
  #chooseMonitor(monitors: readonly MonitorInfo[], capture: CaptureConfig): MonitorInfo | undefined {
    // Win32 defines the primary monitor as the one at physical origin (0,0), which is the
    // same monitor Electron reports as primary - and matching on it needs no scale
    // arithmetic, so invariant 3 is untouched.
    const primary = monitors.find((entry) => entry.bounds[0] === 0 && entry.bounds[1] === 0);
    const configured =
      capture.monitorId === null ? undefined : monitors.find((entry) => entry.id === capture.monitorId);

    if (capture.monitorId !== null && configured === undefined) {
      this.#log.warn('the configured monitor is not attached; falling back to the primary display', {
        monitorId: capture.monitorId,
        attached: monitors.map((entry) => entry.id),
      });
    }

    // No warning for a non-primary monitor any more. That warning existed because `index.ts`
    // paired every frame to `screen.getPrimaryDisplay()`; #28 replaced that with a real
    // pairing, so capturing a secondary display is now an ordinary thing to do.
    return configured ?? primary ?? monitors[0];
  }

  async #listMonitors(): Promise<readonly MonitorInfo[] | null> {
    const ack = await this.#send({ cmd: 'listMonitors' }, 'listMonitors');
    if (ack === null) {
      this.#fail('the sidecar never answered listMonitors; capture is unavailable');
      return null;
    }
    // `monitors` is present only on this reply; an empty list is a real answer on a machine
    // with no attached display, and is not the same thing as a malformed one.
    const monitors = ack.monitors ?? [];
    // Published here because this is the app's only `listMonitors` caller - `AckEvent` has no
    // correlation id, so a second asker would make the two replies genuinely ambiguous
    // (`monitor-service.ts` says the same thing from the other side).
    this.#monitors?.setMonitors(monitors);
    return monitors;
  }

  /**
   * Send a command and wait for the `ack` naming it.
   *
   * The listener is attached **before** the command is written: the reply is a line on a
   * pipe that is already flowing, so subscribing afterwards is a race that only loses on a
   * machine faster than the one it was written on.
   */
  async #send(command: SidecarCommand, cmd: string): Promise<AckEvent | null> {
    return await new Promise<AckEvent | null>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const off = this.#sidecar.on('ack', (ack) => {
        if (ack.cmd !== cmd) return;
        clearTimeout(timer);
        off();
        resolve(ack);
      });

      timer = setTimeout(() => {
        off();
        this.#log.error('no reply from the sidecar', { cmd, timeoutMs: this.#listMonitorsTimeoutMs });
        resolve(null);
      }, this.#listMonitorsTimeoutMs);
      timer.unref?.();

      if (!this.#sidecar.send(command)) {
        clearTimeout(timer);
        off();
        resolve(null);
      }
    });
  }

  /**
   * Re-push `configure` when the capture settings change (ST3).
   *
   * The bootstrap this replaced deliberately did *not* do this, and said so: re-sending
   * `configure` belongs to whatever owns the sidecar's state, which is now this. Inert until
   * the settings window can write config (#39), but the alternative was letting a documented
   * requirement disappear along with the comment describing it.
   */
  #onConfigChanged(current: Config, previous: Config): void {
    // Before both early returns. The region can be cleared from the settings window (#39) as well
    // as set from the picker, and a config that is not yet `#configured` can still have been
    // reloaded from disk - so this is the one place that sees every route by which a region starts
    // or stops existing (#51).
    if (this.#refreshNoRegionWarning()) this.#notify();

    if (JSON.stringify(current.capture) === JSON.stringify(previous.capture)) return;
    if (!this.#configured) return;

    // #35's "เปลี่ยน region → cache ถูกล้าง". Only these two fields: a changed poll interval or
    // diff threshold leaves every box exactly where it was, and discarding the sticky anchors for
    // them would reintroduce the jitter the cache exists to absorb, on a settings change that has
    // nothing to do with position.
    const moved =
      JSON.stringify(current.capture.region) !== JSON.stringify(previous.capture.region) ||
      current.capture.monitorId !== previous.capture.monitorId;
    if (moved) this.#windows.bumpOverlayEpoch('capture region or monitor changed');

    this.#log.info('capture settings changed; reconfiguring the sidecar');
    void this.#reconfigure(current.capture, 'config-change');
  }

  /**
   * Notice recognised text pressed against the region's edge and tell the user (#30).
   *
   * Padding (see {@link #resolveRegion}) handles the user being a pixel or two tight. It cannot
   * handle the text genuinely being wider than the region - a longer subtitle line than the one
   * on screen when they drew the box - and that case is invisible from the output: the words
   * that fell outside simply are not there, and what remains reads perfectly.
   *
   * Only meaningful with a chosen region. Capturing a whole monitor puts text against the edge
   * constantly and legitimately, and warning about it would be pure noise.
   *
   * @returns whether the status changed and subscribers need telling.
   */
  #checkRegionEdges(frame: SidecarClientEvents['frame']): boolean {
    if (this.#config.current.capture.region === null) {
      return this.#setRegionWarning(null);
    }

    // The monitor's own size, straight off the frame that carried the region. Both are physical
    // px in the same space - `frame.region` is relative to this monitor's top-left and
    // `frame.monitor.bounds` is this monitor's rect - so they compare directly and invariant 3's
    // one-converter rule is not engaged. Taking it from the frame rather than from
    // `MonitorRegistry` also means the two numbers always describe the same capture (#59).
    const monitorSize: readonly [number, number] = [frame.monitor.bounds[2], frame.monitor.bounds[3]];
    const report = findEdgeContact(frame.lines, frame.region, monitorSize);
    if (report.edges.length === 0) {
      // Cleared as soon as a frame comes back clean, so a warning cannot outlive the problem.
      this.#edgeThrottle.shouldReport(report);
      return this.#setRegionWarning(null);
    }

    const message = `text is touching the ${report.edges.join('/')} edge of the region; widen it`;
    if (this.#edgeThrottle.shouldReport(report)) {
      this.#log.warn('recognised text is against the edge of the capture region', {
        edges: report.edges,
        lines: report.lines,
        region: frame.region,
      });
    }
    return this.#setRegionWarning(message);
  }

  #setRegionWarning(message: string | null): boolean {
    if (this.#regionWarning === message) return false;
    this.#regionWarning = message;
    return true;
  }

  /**
   * Notice that auto mode has been running and finding nothing, and say so (#50).
   *
   * Driven by `nochange` rather than by a timer, and that is the point: a `nochange` is proof
   * the capture loop is alive and looking. A timer would fire identically for a dead sidecar,
   * which is a different problem with a different fix - and the sidecar dying already has its
   * own report on the `exit` arm.
   *
   * Only in `auto`. `paused` and `snapshot` are *supposed* to produce nothing, and warning about
   * a working feature is how a warning gets ignored when it means something.
   *
   * @returns whether the status changed.
   */
  #checkIdle(): boolean {
    if (this.#mode !== 'auto') return false;

    const now = this.#now();
    // The first `nochange` after starting establishes the baseline; without this the clock would
    // run from process start and a slow launch would trip the warning immediately.
    if (this.#lastFrameAt === null) {
      this.#lastFrameAt = now;
      return false;
    }
    if (now - this.#lastFrameAt < this.#idleWarningMs) return false;

    // The threshold, **not** the live elapsed time. An earlier version interpolated the actual
    // seconds, which made the message different on every tick (25s, 27s, 29s...) so the
    // `===` below never matched and this warned, notified and rewrote the tray tooltip on every
    // idle tick forever. A still screen in auto is an ordinary state, not a pathological one,
    // and that is exactly the noise that trains a user to ignore warnings - the same reason
    // #30's edge report is throttled.
    const seconds = Math.round(this.#idleWarningMs / 1000);
    // #54. This used to say "lower diffThreshold" unconditionally, which is advice that does
    // nothing on exactly the regions that produce this warning: past ~800k px the pixel ceiling
    // is the smaller rule and the fraction is inert, so the user would turn that knob, see no
    // change, and reasonably conclude the app is broken. Name the knob that is actually in force.
    const remedy =
      this.#diffGovernedBy === 'maxRequiredPx'
        ? 'try a smaller region, or lower diffMaxRequiredPx - on a region this large '
          + 'diffThreshold has no effect'
        : 'try a smaller region, or lower diffThreshold';
    const message = `no change detected in the capture region for over ${seconds}s - ${remedy}`;
    if (this.#idleWarning === message) return false;

    this.#idleWarning = message;
    this.#log.warn(
      'auto mode has produced no frames for an extended period; change detection is rejecting '
        + 'every tick. On a large region a subtitle-sized change can fall under diffThreshold '
        + 'entirely (#50)',
      {
        idleForMs: now - this.#lastFrameAt,
        diffThreshold: this.#config.current.capture.diffThreshold,
        diffMaxRequiredPx: this.#config.current.capture.diffMaxRequiredPx,
        // Which of the two the message just told them to reach for (#54).
        diffGovernedBy: this.#diffGovernedBy,
      },
    );
    return true;
  }

  /** Record something the user has to know about, and light the tray up (invariant 4). */
  #fail(message: string): void {
    this.#log.error(message);
    if (this.#lastError === message) return;
    this.#lastError = message;
    this.#notify();
  }

  #notify(): void {
    const status = this.status;
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch (error) {
        // One bad subscriber must not stop the others, exactly as in `ConfigService.#commit`.
        this.#log.error('a status listener threw', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
