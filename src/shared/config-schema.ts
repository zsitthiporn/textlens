/**
 * The config contract: bundled defaults, the schema that validates a user's overrides, and
 * the types both are inferred from (issue M9-01 / #38, features ST1-ST3).
 *
 * ## Why a schema library rather than hand-written checks
 *
 * The reference project validates config with a chain of per-field `if` statements, and
 * `docs/reference-analysis.md` records that as a mistake worth not repeating (ST2): every new
 * field needs a new `if`, the one that is forgotten fails silently, and the error message has
 * to be written by hand for each. One declaration here yields three things that cannot drift
 * apart - the runtime check, the TypeScript type, and an error carrying the *path* of the
 * offending field, which is what #38's "แจ้งว่า field ไหนผิด" criterion actually needs.
 *
 * ## Why the object schemas are strict
 *
 * An unrecognised key is an error, not something to drop quietly. A user who writes
 * `intervalActiveMs` instead of `intervalActive` has expressed an intention; stripping the key
 * and carrying on means the app ignores it and never says so - CLAUDE.md invariant 4 exactly.
 * The cost is that a config written by a *newer* build is rejected wholesale by an older one,
 * which is the right way round: refusing loudly beats applying half of it.
 *
 * ## Two schemas per section, from one shape
 *
 * `*ConfigSchema` describes a complete section and validates the merged result.
 * `*OverrideSchema` is the same shape with every field optional, and validates what the user
 * actually wrote. Both come from a single `shape` constant, so a field can never exist in one
 * and not the other.
 *
 * This module is in `shared/` because the settings renderer will need the same schema to
 * validate a form before sending it (issue #39). It therefore imports nothing from `main/`
 * and touches no filesystem.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * A rectangle, matching the wire's {@link import('./protocol.js').Rect}: `[x, y, w, h]` in
 * **physical px, relative to the monitor's top-left**.
 *
 * Integers, because it is a pixel rectangle and the sidecar crops with it. Width and height
 * must be positive - a zero-width region is a region that can never produce a frame, and
 * silently capturing nothing is the failure mode this whole file exists to prevent.
 */
export const regionSchema = z
  .tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().positive(),
    z.number().int().positive(),
  ])
  .readonly();

/**
 * A saved region, together with everything needed to decide whether it still means anything
 * (issue M6-04 / #31, feature R2).
 *
 * The three fields travel as one object rather than as three nullable siblings, and that is the
 * whole design: a region, the monitor it was drawn on, and that monitor's size at the time are
 * only meaningful together. Three independent nullable fields admit states that cannot be
 * interpreted - a region with no monitor, a monitor size with no region - and every consumer
 * would have to re-derive which combinations are real.
 *
 * #31's headline requirement is that a region restored onto a different display layout is
 * *worse* than no region, because it looks like it worked. Carrying `monitorSize` is what makes
 * that detectable: a monitor whose resolution changed is still the same device name, so `id`
 * alone cannot tell a valid saved region from one that now points at the wrong part of the
 * screen.
 */
export const savedRegionSchema = z
  .strictObject({
    /**
     * The rectangle the user actually dragged, in **physical px relative to the monitor's
     * top-left** - the same space as `ConfigureCommand.region`.
     *
     * Physical, not CSS: #31 is explicit about this, and the reason is that a CSS rectangle
     * changes meaning when the user changes their scaling setting, so a region saved at 100%
     * would silently address a different part of the screen at 150%.
     *
     * **Unpadded.** The margin from #30 is applied when the region is sent to the sidecar, not
     * when it is stored. Storing the padded rectangle would re-pad it on every load, growing
     * the region without bound, and would make the configurable margin unchangeable after the
     * fact - the stored value would already have the old one baked in.
     */
    rect: regionSchema,
    /** Windows device name the rectangle was drawn on, e.g. `\\.\DISPLAY1`. */
    monitorId: z.string().min(1),
    /** That monitor's physical size when the region was chosen: `[width, height]`. */
    monitorSize: z.tuple([z.number().int().positive(), z.number().int().positive()]).readonly(),
  })
  .readonly();

const captureShape = {
  /**
   * Windows device name of the monitor to capture, e.g. `\\.\DISPLAY1`.
   *
   * `null` means "whichever monitor is primary", resolved at start against the live
   * `listMonitors` reply. A default cannot name a device that may not exist on this machine,
   * and issue #35 (R2) is emphatic that a stale monitor id must never be applied silently -
   * so the absence of a choice is modelled, rather than guessed at with a plausible string.
   */
  monitorId: z.string().min(1).nullable(),

  /**
   * Capture region bound to the monitor it was drawn on, or `null` for the whole monitor.
   *
   * `null` is the default and is not a placeholder: with no region chosen the whole display
   * *is* the region.
   */
  region: savedRegionSchema.nullable(),

  /**
   * Physical px of margin added around the user's region before it reaches the sidecar
   * (issue M6-03 / #30, feature R7).
   *
   * **Not cosmetic.** Spike S1 measured that a crop whose edge cuts through a letter does not
   * degrade OCR, it breaks it: `Logician` came back as `ogician` and `arithmetic` as
   * `cithmetic`. A user dragging a box around a subtitle will clip the glyphs they are aiming
   * at, every time, because the box they draw is the box they *see* - and the antialiased edge
   * of a letter extends past what they see.
   *
   * Physical px so the margin means the same thing at every scale factor: this is padding
   * measured against glyphs, and glyphs are rendered in physical pixels. 8 is roughly a
   * quarter of the stroke-to-stroke height of subtitle text at 1080p, which is enough to clear
   * antialiasing and accents without meaningfully enlarging the area OCR has to scan.
   *
   * Zero is permitted, because a user who has deliberately drawn a region with room to spare
   * should be able to say so, and because #30's regression test needs to compare a padded crop
   * against an unpadded one.
   */
  regionPadding: z.number().int().nonnegative(),

  /** Poll interval in ms while text is changing. */
  intervalActive: z.number().int().positive(),
  /** Poll interval in ms once the region looks idle. */
  intervalIdle: z.number().int().positive(),
  /**
   * Fraction of changed pixels (0..1) above which a frame counts as changed.
   *
   * **0.005, lowered from 0.02 after measuring** (issue #50). The old value was never measured
   * and it broke the project's primary use case silently: a subtitle changing on an otherwise
   * still screen changed too few pixels to clear 2% of a large region, so every tick came back
   * `nochange` and nothing ever reached the screen - while the tray said `auto` and the sidecar
   * genuinely burned CPU capturing.
   *
   * Measured on this machine (3440x1440, 40px white text on black replaced every 700ms, 800ms
   * poll, 8s per cell, counting the sidecar's own `frame` vs `nochange` lines). Changing text:
   *
   * | region             | pixels | 0.02     | 0.01 | 0.005 | 0.002 | 0.001 |
   * |--------------------|--------|----------|------|-------|-------|-------|
   * | 1200x220 cropped   | 264k   | 8 frames | 8    | 8     | 8     | 8     |
   * | 1600x460 loose     | 736k   | **1**    | 8    | 8     | 8     | 8     |
   * | 3440x1440 full     | 4.95M  | **3**    | 8    | 8     | 8     | 8     |
   *
   * And the control - the same screen with nothing changing - stayed at zero frames (beyond the
   * unavoidable first capture) for **every** threshold down to 0.001 on both the cropped and the
   * loose region. So the margin below the failure point costs nothing on a region a user would
   * actually pick, which is why this is 0.005 and not 0.01: 0.01 is the boundary itself, and the
   * test text was large, high-contrast and full-width. Real subtitles are smaller.
   *
   * The full-screen row does not behave and no value here fixes it - see
   * {@link diffMinChangedPx}.
   */
  diffThreshold: z.number().min(0).max(1),

  /**
   * Changed physical px that must always be enough to count as a change, whatever the region's
   * size (issue #50).
   *
   * The issue identifies a pure fraction as the root cause, and the measurements agree: the
   * *same* text change was detected on a 1200x220 region and discarded on a 1600x460 one at the
   * same threshold. Nothing about the content differed - only the denominator. A subtitle is the
   * same number of pixels however big a box the user drew around it, so the quantity that should
   * stay fixed is a pixel count.
   *
   * `region-guard.ts`'s `effectiveDiffThreshold` combines the two as
   * `min(diffThreshold, diffMinChangedPx / area)`, so the fraction governs small regions and this
   * floor governs large ones.
   *
   * 4000 comes from the same run. On the 1600x460 region 0.01 detected and 0.02 did not, which
   * brackets one line of that text between ~7,400 and ~14,700 changed px; 4000 sits below that
   * with room for text smaller and lower-contrast than the test's.
   */
  diffMinChangedPx: z.number().int().nonnegative(),
  /** BCP-47 tag of the OCR recognizer. The sidecar reports which are installed (feature O8). */
  ocrLanguage: z.string().min(1),
  /**
   * Whether the sidecar may return pixels in reply to `debugFrame`.
   *
   * The single documented exception to architecture invariant 1, and off by default. It is
   * here so a user can turn it on to diagnose a capture problem without a rebuild - the
   * protocol's own `configure.debugFrameEnabled` has no default for the same reason.
   */
  debugFrameEnabled: z.boolean(),
} as const;

export const captureConfigSchema = z.strictObject(captureShape).readonly();
export const captureOverrideSchema = z.strictObject(captureShape).partial().readonly();

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

/**
 * The four actions that must be reachable without switching windows (issue #32 / M7-01,
 * feature G1).
 *
 * The reference project has no global hotkey at all - `grep globalShortcut` returns nothing -
 * in a tool whose main use case is a game running borderless fullscreen, where alt-tabbing to
 * click something is exactly what the user cannot do.
 */
export const HOTKEY_ACTIONS = ['toggleAuto', 'snapshot', 'selectRegion', 'toggleOverlay'] as const;

export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];

/**
 * An Electron accelerator, or `null` to leave the action unbound.
 *
 * `null` is not decoration: #32 requires that a hotkey which collides with another program is
 * reported, and a user who hits that needs somewhere to go. Without a way to unbind, their only
 * options would be to accept a key that does not work or to edit the source.
 */
const acceleratorSchema = z.string().min(1).nullable();

const hotkeyShape = {
  /** Start/stop the capture loop - the mode machine's main switch (#34). */
  toggleAuto: acceleratorSchema,
  /** Translate once and leave it on screen. */
  snapshot: acceleratorSchema,
  /** Re-run the region picker (#30). */
  selectRegion: acceleratorSchema,
  /** Hide/show the boxes **without** stopping capture - #34 is emphatic these differ. */
  toggleOverlay: acceleratorSchema,
} as const;

export const hotkeyConfigSchema = z.strictObject(hotkeyShape).readonly();
export const hotkeyOverrideSchema = z.strictObject(hotkeyShape).partial().readonly();

// ---------------------------------------------------------------------------
// Render — the renderer's anti-flicker numbers (issues M8-01 / #35, M8-03 / #37)
// ---------------------------------------------------------------------------

/**
 * Every knob the overlay renderer needs, and the only config that crosses to it.
 *
 * It travels on {@link import('../renderer/overlay/contract.js').OverlayRenderMessage} rather
 * than on a channel of its own. That is one fewer IPC surface, and - more usefully - it removes
 * an ordering hazard that would be invisible when it bit: a renderer that receives config on a
 * separate channel can draw its first payload before the config arrives, so the first subtitle
 * of every session would be laid out against defaults that are not the user's. Carried on the
 * payload, the numbers cannot be later than the frame they govern.
 *
 * The units are **CSS px and ms** throughout - renderer space. Nothing here is physical px.
 */
const renderShape = {
  /**
   * Grid resolution the OCR anchor is snapped to before placement, in CSS px (#35).
   *
   * Snapping alone does not stop jitter and is not what does the work here - see
   * {@link anchorTolerance}. What the grid buys is that two anchors a pixel apart resolve to
   * one position, and that a recomputed anchor lands on a round number rather than on whatever
   * the recognizer happened to report that frame.
   */
  anchorGrid: z.number().int().positive(),

  /**
   * How far the true OCR anchor may drift from the one currently in use before the box is
   * allowed to move, in CSS px (#35). **This is the hysteresis, and it is the part that works.**
   *
   * Grid snapping on its own fails the issue's own acceptance criterion: an anchor sitting near
   * a cell boundary flips between two cells under +-3px jitter, so the box moves a whole grid
   * cell - further than it would have moved with no snapping at all, and on roughly 3 frames in
   * 8. Comparing against the anchor **in use** rather than against the previous raw reading is
   * also what bounds cumulative drift: a recogniser walking 3px per frame in one direction
   * exceeds this on the second frame and the anchor is recomputed, so a box can never trail its
   * text by more than this value.
   *
   * 6 sits above the +-3px jitter design doc section 5 describes and well below a line height,
   * so a box is never held over the line above or below its own.
   */
  anchorTolerance: z.number().nonnegative(),

  /**
   * Hard cap on remembered anchors (#35, "sticky cache ไม่โตไม่จำกัด").
   *
   * Bounded by eviction rather than by time: a subtitle that returns after a minute should get
   * its old position back, so a TTL would throw away exactly the entries worth keeping. 128 is
   * comfortably above the pool's 48 boxes, so every box on the busiest possible screen has an
   * entry with room for the recent past as well.
   */
  stickyMaxEntries: z.number().int().positive(),

  /**
   * How long a box is guaranteed to stay before different content may replace it, in ms (#37).
   *
   * Deliberately **well under the measured translate latency** (p50 897ms under real pipeline
   * load). The pipeline emits twice per frame - cache hits first, the full set when the engine
   * answers - and a minimum longer than that round trip would delay every completed frame
   * behind its own progressive half, turning an optimisation into a stall. 400ms is long enough
   * that a replaced box was readable and short enough to disappear inside a gap the user is
   * already waiting through.
   *
   * 0 disables the gate.
   */
  minDisplayMs: z.number().int().nonnegative(),

  /**
   * Crossfade duration in ms (#37). 0 disables the transition and swaps instantly.
   *
   * A compositor-driven opacity transition, so its cost is not paid in the 16ms render budget -
   * but it is still an animation on an always-on-top window, and spike S2 is the reason that
   * sentence needs evidence rather than confidence. See `tests`/report.
   */
  fadeMs: z.number().int().nonnegative(),

  /**
   * Translation text size in CSS px (#39, feature ST4's "font").
   *
   * 17 is the value `overlay.css` shipped as a literal, kept so this field changes nothing until
   * a user moves it. Bounded at both ends rather than left open: below about 10px Thai stacked
   * marks stop being separable at all - H2's whole subject - and above 48 a two-line subtitle
   * covers enough of the screen that U4's area budget would suppress most of the frame, which
   * looks like the app losing text rather than like a font size that was set too large.
   *
   * Reaches the renderer on every payload as part of {@link renderConfigSchema}, so a change takes
   * effect on the next frame with no restart - which is #39's acceptance criterion, and the reason
   * this is in `render` rather than anywhere else.
   */
  fontSize: z.number().int().min(10).max(48),

  /**
   * Opacity of a translation box's **background plate**, 0..1 (#39, feature ST4's "opacity").
   *
   * The plate, deliberately, and not the box element. `.box` already animates `opacity` for A9's
   * crossfade: a user-set opacity written to the same property would either be overwritten by the
   * transition's end state or would cap the fade, and the two would fight on every frame that
   * replaces a string. Writing it into the plate's `rgb(... / <alpha>)` instead leaves the
   * crossfade the sole owner of element opacity.
   *
   * Floored at 0.2 rather than 0. A fully transparent plate leaves white text with only its
   * shadow over an arbitrary screen, which reads as the overlay being broken; a user who wants no
   * boxes has `toggleOverlay`, which is a mode rather than a setting that looks like a fault.
   */
  opacity: z.number().min(0.2).max(1),
} as const;

export const renderConfigSchema = z.strictObject(renderShape).readonly();
export const renderOverrideSchema = z.strictObject(renderShape).partial().readonly();

// ---------------------------------------------------------------------------
// Stability — content tracking and dynamic suppression (issue M8-02 / #36)
// ---------------------------------------------------------------------------

const stabilityShape = {
  /**
   * Whether an unchanged screen may suppress an overlay payload at all.
   *
   * A switch exists because this is the one anti-flicker rule whose failure mode is a caption
   * that never appears. Everything else in M8 can only make a box late or make it move; this can
   * make it absent, so there has to be a way to turn it off without a rebuild.
   */
  enabled: z.boolean(),

  /**
   * Minimum similarity for two strings to count as the same line, 0..1.
   *
   * 0.95, matching `dedup.ts`, and for the reason argued at length there: `...secure the
   * evacuation` against `...the extraction` scores 0.90, and anything that swallows that pair
   * suppresses a different instruction silently. 0.95 covers about one changed character in
   * twenty, which is the size of the error spike S1 measured.
   */
  similarityThreshold: z.number().min(0).max(1),

  /**
   * Minimum set similarity for a frame to count as unchanged, 0..1.
   *
   * A fuzzy Jaccard over the frame's lines. A two-line subtitle with one line replaced scores
   * 1/3, and a three-line one scores 1/2, so 0.9 keeps "some of it changed" firmly on the emit
   * side - which is the direction the acceptance criteria push: a suppression that is too eager
   * loses a sentence, a suppression that is too shy costs one redundant render.
   */
  setThreshold: z.number().min(0).max(1),

  /**
   * Lines a frame may hold that the baseline does not, and still count as unchanged.
   *
   * **0, and this field exists because the ratio above is not sufficient - measured, not
   * reasoned about.** A real run over a full-screen capture produced 70 blocks; one line changing
   * out of 70 scores 0.97, clearing any usable ratio. Since the baseline only advances when
   * something is drawn, that frame would be suppressed and so would every frame after it, and the
   * changed line would never be translated - permanently, with nothing reported.
   *
   * Structurally the same bug as #50 (a fraction whose meaning changes with its denominator) and
   * it takes the same fix: an absolute floor beside the fraction. The ratio still earns its place
   * in the other direction - lines *disappearing* add nothing new, and only the ratio sees them.
   */
  maxNewLines: z.number().int().nonnegative(),

  /**
   * Consecutive unchanged frames required before suppression starts.
   *
   * 2, not 1. The first repeat still emits, which costs one redundant payload per subtitle and
   * buys a full capture interval of margin against a single mis-scored frame silencing new text.
   */
  frames: z.number().int().positive(),
} as const;

export const stabilityConfigSchema = z.strictObject(stabilityShape).readonly();
export const stabilityOverrideSchema = z.strictObject(stabilityShape).partial().readonly();

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

const configShape = {
  capture: captureConfigSchema,
  hotkeys: hotkeyConfigSchema,
  render: renderConfigSchema,
  stability: stabilityConfigSchema,
} as const;

/** Validates a complete config - the result of merging an override over the defaults. */
export const configSchema = z.strictObject(configShape).readonly();

/**
 * Validates what the user wrote, which may set any subset of any section.
 *
 * Only two levels deep, spelled out rather than derived: zod 4 has no `deepPartial`, and
 * writing the recursion by hand would be more machinery than this config will ever need.
 */
export const configOverrideSchema = z
  .strictObject({
    capture: captureOverrideSchema.optional(),
    hotkeys: hotkeyOverrideSchema.optional(),
    render: renderOverrideSchema.optional(),
    stability: stabilityOverrideSchema.optional(),
  })
  .readonly();

export type Region = z.infer<typeof regionSchema>;
export type SavedRegion = z.infer<typeof savedRegionSchema>;
export type CaptureConfig = z.infer<typeof captureConfigSchema>;
export type HotkeyConfig = z.infer<typeof hotkeyConfigSchema>;
export type RenderConfig = z.infer<typeof renderConfigSchema>;
export type StabilityConfig = z.infer<typeof stabilityConfigSchema>;
export type Config = z.infer<typeof configSchema>;
export type ConfigOverride = z.infer<typeof configOverrideSchema>;

/**
 * Layer 1: the defaults that ship with the app (ST1). Read-only at runtime, and the value the
 * app falls back to whenever the user's layer cannot be used.
 *
 * The capture numbers are the sidecar's own defaults (`Services/AdaptiveTimer.cs`) and the
 * values in every `configure` sample in `docs/sidecar-protocol.md`. They fit the latency
 * budget in CLAUDE.md: the primary use case is a subtitle that changes every 2-3s, so an 800ms
 * active poll catches each new line with room left for the rest of the pipeline, while the
 * idle interval backs off rather than burning a core on a screen that is not changing.
 *
 * Frozen, so a consumer that mutates what it was handed fails where it does it rather than
 * quietly corrupting the fallback every later load depends on.
 */
export const DEFAULT_CONFIG: Config = configSchema.parse({
  capture: {
    monitorId: null,
    region: null,
    regionPadding: 8,
    intervalActive: 800,
    intervalIdle: 2_000,
    diffThreshold: 0.005,
    diffMinChangedPx: 4_000,
    ocrLanguage: 'en-US',
    debugFrameEnabled: false,
  },
  // `Control+Alt+<letter>`: mnemonic, and the modifier pair Windows itself and most games
  // leave alone. A global shortcut is registered process-wide, so a common combination would
  // be taken from whatever the user is running - which is the collision #32 asks us to report.
  hotkeys: {
    toggleAuto: 'Control+Alt+A',
    snapshot: 'Control+Alt+S',
    selectRegion: 'Control+Alt+R',
    toggleOverlay: 'Control+Alt+H',
  },
  render: {
    anchorGrid: 8,
    anchorTolerance: 6,
    stickyMaxEntries: 128,
    minDisplayMs: 400,
    fadeMs: 120,
    // Both are the literals `overlay.css` already had, so making them configurable changes
    // nothing about how the app looks until somebody moves a slider.
    fontSize: 17,
    opacity: 0.82,
  },
  stability: {
    enabled: true,
    similarityThreshold: 0.95,
    setThreshold: 0.9,
    maxNewLines: 0,
    frames: 2,
  },
});

// ---------------------------------------------------------------------------
// Error reporting
// ---------------------------------------------------------------------------

/**
 * One schema failure, flattened into the two things a human needs: which field, and why.
 *
 * `path` is dotted (`capture.intervalActive`) rather than zod's array, because it exists to be
 * put in a log line and, later, next to a field in the settings window (#39).
 */
export interface ConfigFieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * Flatten a `ZodError` into field errors.
 *
 * Unrecognised keys need their own arm: zod reports them against the *parent* object, so the
 * issue's own `path` is the container and the offending key names live in `issue.keys`. Left
 * unhandled, the single most likely user mistake - a typo'd field name - would be reported as
 * an error on the whole section with no field named at all.
 */
export function toFieldErrors(error: z.ZodError): ConfigFieldError[] {
  const errors: ConfigFieldError[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map((segment) => String(segment));
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors.push({ path: [...base, key].join('.'), message: 'unrecognized field' });
      }
      continue;
    }
    errors.push({ path: base.join('.') || '(root)', message: issue.message });
  }
  return errors;
}
