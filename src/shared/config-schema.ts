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
   * Capture region, or `null` for the whole monitor.
   *
   * `null` is the default and is not a placeholder: until the region picker lands (#30 / R7)
   * the whole display *is* the region, and #30 records that a region whose edge cuts through
   * a letter breaks OCR outright - so a hardcoded guess would be worse than no choice at all.
   */
  region: regionSchema.nullable(),

  /** Poll interval in ms while text is changing. */
  intervalActive: z.number().int().positive(),
  /** Poll interval in ms once the region looks idle. */
  intervalIdle: z.number().int().positive(),
  /** Fraction of changed pixels (0..1) above which a frame counts as changed. */
  diffThreshold: z.number().min(0).max(1),
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
// Root
// ---------------------------------------------------------------------------

const configShape = {
  capture: captureConfigSchema,
  hotkeys: hotkeyConfigSchema,
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
  })
  .readonly();

export type Region = z.infer<typeof regionSchema>;
export type CaptureConfig = z.infer<typeof captureConfigSchema>;
export type HotkeyConfig = z.infer<typeof hotkeyConfigSchema>;
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
    intervalActive: 800,
    intervalIdle: 2_000,
    diffThreshold: 0.02,
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
