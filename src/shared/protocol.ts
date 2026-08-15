/**
 * The Node <-> sidecar wire protocol (design doc section 3): JSON lines over stdio,
 * one message per line. Node writes commands to the sidecar's stdin; the sidecar
 * writes events to its stdout.
 *
 * This module is one half of a two-language contract. Its mirror image lives in
 * `sidecar/Textlens.Capture/Protocol/` and the two are pinned together by the golden
 * fixtures in `tests/fixtures/protocol/`, which both test suites read from disk.
 * Change a field name here and the C# side and the fixtures must change with it.
 *
 * Three rules this module exists to enforce:
 *
 *   1. **camelCase on the wire.** TypeScript property names *are* the wire names,
 *      so there is no naming policy to configure - only a naming policy to obey.
 *   2. **`scale` and `monitor.bounds` are mandatory** (design doc, "Coordinate
 *      contract"). Physical px are meaningless without them, so they are required
 *      in the type system *and* rejected at parse time - never silently `undefined`.
 *   3. **Decoding never throws.** An unrecognised or malformed line is a value the
 *      caller logs and skips, not an exception that kills the reader loop
 *      (CLAUDE.md invariant 4: no silent failure, but also no fatal one).
 *
 * Deliberately NOT here: process spawning and stream framing (SidecarClient, M1-04)
 * and coordinate conversion (single owner, M3-01). This module defines the fields the
 * converter will consume; it converts nothing.
 */

/**
 * A rectangle on the wire: `[x, y, width, height]`.
 *
 * Every rectangle in the protocol - `region`, `monitor.bounds`, `lines[].bbox` -
 * uses this one shape. The design doc's examples show `region` and `bbox` as
 * origin+size, so `bounds` is read the same way rather than as left/top/right/bottom;
 * a mixed convention is exactly the kind of thing that produces a monitor at
 * `[-1920, 0, 0, 1080]` and an overlay 1920px from where the user is looking.
 *
 * Units and origins are per field, and getting them wrong is the DPI bug the design
 * doc says the reference project shipped:
 *
 *   - `lines[].bbox`   - physical px, relative to the region's top-left
 *   - `region`         - physical px, relative to the monitor's top-left
 *   - `monitor.bounds` - physical px, absolute on the virtual desktop
 *
 * Every rectangle on the wire is physical px. The sidecar performs no scale
 * arithmetic at all (invariant #1), and all of it lives in `coordinates.ts`
 * (invariant #3).
 *
 * `bounds` being physical is precisely why M3-01 takes the logical origin from
 * Electron rather than from this field:
 *
 *     logicalX = (regionX + bboxX) / scale + display.bounds.x
 *
 * When monitors differ in DPI a logical origin cannot be derived from a physical
 * one at all, because Chromium lays displays out adjacent in DIP space instead of
 * dividing each physical rect by its own scale. A 4K display at 200% followed by a
 * 1080p display at 100% puts the second at DIP x=1920, while physical/scale says
 * 3840. See design doc section 3.
 */
export type Rect = readonly [x: number, y: number, width: number, height: number];

// ---------------------------------------------------------------------------
// Commands (Node -> sidecar)
// ---------------------------------------------------------------------------

export const COMMAND_KINDS = [
  'listMonitors',
  'configure',
  'start',
  'stop',
  'snapshot',
  'debugFrame',
] as const;

export type CommandKind = (typeof COMMAND_KINDS)[number];

export function isCommandKind(value: unknown): value is CommandKind {
  return typeof value === 'string' && (COMMAND_KINDS as readonly string[]).includes(value);
}

/** Enumerate monitors with their bounds and scale factor. */
export interface ListMonitorsCommand {
  readonly cmd: 'listMonitors';
}

/**
 * Push the full capture configuration. Every field is required: a partial update
 * would mean the sidecar and Node disagree about what the current settings are,
 * and the settings that matter most (`region`, `monitorId`) are the ones a merge
 * would silently get wrong.
 */
export interface ConfigureCommand {
  readonly cmd: 'configure';
  /** Capture region in physical px, relative to the monitor's top-left. */
  readonly region: Rect;
  /** Device name of the monitor to capture, as returned by `listMonitors`. */
  readonly monitorId: string;
  /** Poll interval in ms while text is changing. */
  readonly intervalActive: number;
  /** Poll interval in ms while the region looks idle. */
  readonly intervalIdle: number;
  /** Fraction of changed pixels (0..1) above which a frame counts as changed. */
  readonly diffThreshold: number;
  /** BCP-47 tag of the OCR recognizer to use, e.g. `en-US`. */
  readonly ocrLanguage: string;
  /**
   * Whether `debugFrame` is permitted to return pixels.
   *
   * Off is the safe value and there is no default. Pixels crossing IPC is the single
   * documented exception to architecture invariant 1, and the design doc says
   * `debugFrame` is off unless explicitly enabled - but `configure` had no field to
   * enable it with, so "off by default" was unimplementable. Required rather than
   * optional for the same reason every other field here is: an omitted flag that
   * defaults to `false` reads exactly like a flag the sender thought it had set.
   */
  readonly debugFrameEnabled: boolean;
}

/** Begin the capture loop. */
export interface StartCommand {
  readonly cmd: 'start';
}

/** Halt the capture loop. */
export interface StopCommand {
  readonly cmd: 'stop';
}

/** Emit exactly one `frame`, bypassing change detection. */
export interface SnapshotCommand {
  readonly cmd: 'snapshot';
}

/** Emit one `frame` carrying `imagePng`. Off unless explicitly enabled (design doc section 3). */
export interface DebugFrameCommand {
  readonly cmd: 'debugFrame';
}

export type SidecarCommand =
  | ListMonitorsCommand
  | ConfigureCommand
  | StartCommand
  | StopCommand
  | SnapshotCommand
  | DebugFrameCommand;

// ---------------------------------------------------------------------------
// Events (sidecar -> Node)
// ---------------------------------------------------------------------------

export const EVENT_KINDS = ['ready', 'frame', 'nochange', 'ack', 'error'] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * The sidecar's command state machine.
 *
 * `idle` is before any `configure`; `configured` means a region and monitor are known
 * but nothing is capturing; `running` means the capture loop is ticking; `stopped` means
 * it was running and was halted - kept distinct from `configured` so a `stop` before any
 * `start` is visibly different from one after it.
 *
 * Not a closed union on the wire: `AckEvent.state` is typed as a plain string for the
 * same forward-compatibility reason `ErrorEvent.code` is.
 */
export const SIDECAR_STATES = ['idle', 'configured', 'running', 'stopped'] as const;

export type SidecarState = (typeof SIDECAR_STATES)[number];

/**
 * First line the sidecar writes. `ocrLanguages` is the recognizer list actually
 * installed on this machine - it is what feature O8's preflight check reads, so it
 * must be enumerated at runtime and may legitimately be empty.
 */
export interface ReadyEvent {
  readonly ev: 'ready';
  readonly version: string;
  readonly ocrLanguages: readonly string[];
}

/**
 * Per-stage cost of one capture round, in **microseconds** (feature L3).
 *
 * These were milliseconds, which made the capture metric permanently useless: measured
 * capture is p50 `0.574ms`, and as an integer number of milliseconds that is `0` on every
 * frame forever. Design doc section 4 asks for these numbers so that "we are over budget"
 * can be answered with "here is which stage", and a field that cannot express its own
 * typical value answers nothing.
 *
 * Integers, not floats: all the protocol fixtures are re-encoded and compared byte for
 * byte by both suites, and C# and JavaScript do not format decimals identically
 * (`0.5` vs `0.50`). Microseconds keep the resolution *and* keep the values integral.
 * The unit is in the field names because a bare `capture` that quietly changed unit is
 * how a consumer ends up dividing by the wrong constant for a year.
 *
 * The budget table in design doc section 4 stays in milliseconds - it is the thing humans
 * read - so consumers convert at the point of use. `metrics.ts` divides by 1000 exactly
 * once, where it folds these into its ms-based budgets.
 */
export interface FrameTimings {
  /** Frame-in-hand to buffer-ready, in µs. Excludes waiting for the compositor. */
  readonly captureUs: number;
  /** Change detection, in µs. */
  readonly diffUs: number;
  /** Recognition, in µs. Zero when the frame was unchanged and OCR was skipped. */
  readonly ocrUs: number;
}

/**
 * The monitor the frame came from. `scale` and `bounds` are the two inputs the
 * coordinate converter (M3-01) cannot work without, which is why neither is optional.
 */
export interface MonitorInfo {
  /** Windows device name, e.g. `\\.\DISPLAY1`. */
  readonly id: string;
  /** DPI scale factor, e.g. 1.0 / 1.25 / 1.5. */
  readonly scale: number;
  /** Monitor rectangle in logical px, absolute on the virtual desktop. */
  readonly bounds: Rect;
}

/** One OCR line: text plus its box in physical px relative to the region's top-left. */
export interface OcrLine {
  readonly text: string;
  readonly bbox: Rect;
  /**
   * Recognizer confidence, 0..1 - **present only when the engine actually reports one**,
   * and therefore absent from the wire rather than sent as `null`.
   *
   * `Windows.Media.Ocr` reports none. Verified against the projection the sidecar builds
   * on: `OcrResult` exposes `Lines`/`Text`/`TextAngle`, `OcrLine` exposes `Text`/`Words`,
   * `OcrWord` exposes `Text`/`BoundingRect`. There is no confidence anywhere in that
   * namespace, which is why spike S1's harness recorded text and boxes only.
   *
   * Optional rather than a constant, because a constant would be *misinformation*: every
   * consumer would read `1.0` as "the recognizer is certain" when the truth is that it
   * never said. That is the same silent-default failure `scale` is required to prevent -
   * a field that is present, plausible and meaningless. Consumers that rank or filter on
   * confidence (features O4 and U4) must handle its absence rather than defaulting it.
   */
  readonly conf?: number;
}

export interface FrameEvent {
  readonly ev: 'frame';
  readonly seq: number;
  readonly timings: FrameTimings;
  readonly monitor: MonitorInfo;
  /** The captured region in physical px, relative to the monitor's top-left. */
  readonly region: Rect;
  readonly lines: readonly OcrLine[];
  /** base64 PNG of the captured region. Present only in reply to `debugFrame`. */
  readonly imagePng?: string;
}

/** The region did not change; no OCR was run. Carries `seq` so gaps are detectable. */
export interface NochangeEvent {
  readonly ev: 'nochange';
  readonly seq: number;
}

/**
 * The reply to a command that does not produce a `frame`.
 *
 * The design doc promises a reply to `listMonitors` and an ack to `configure`, `start`
 * and `stop`, and until now nothing on the wire could carry any of them. Four bespoke
 * reply events would be four decoder arms and four fixtures; one `ack` that names the
 * command it answers is the same information in one shape. `snapshot` and `debugFrame`
 * are unaffected - they already reply with a `frame`.
 *
 * **There is no correlation id.** Replies correlate by `cmd`, which is unambiguous only
 * while at most one command of a kind is outstanding. That holds for this state machine,
 * but anyone adding pipelined or concurrent commands has to add an id first.
 */
export interface AckEvent {
  readonly ev: 'ack';
  /** The `cmd` being acknowledged. An open string, like `ErrorEvent.code`. */
  readonly cmd: string;
  /** State *after* the command was applied. One of `SIDECAR_STATES`, but not pinned to it. */
  readonly state: string;
  /** Attached displays. Present only on the reply to `listMonitors`. */
  readonly monitors?: readonly MonitorInfo[];
}

/**
 * Something failed inside the sidecar. `code` is intentionally an open string:
 * pinning it to a closed union would make a sidecar that learns a new failure mode
 * unparseable by an older Node build, which is the opposite of what this field is for.
 */
export interface ErrorEvent {
  readonly ev: 'error';
  readonly code: string;
  readonly message: string;
}

export type SidecarEvent = ReadyEvent | FrameEvent | NochangeEvent | AckEvent | ErrorEvent;

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Why a line could not be turned into a message.
 *
 * `unknown-kind` is deliberately distinct from the rest: it is the benign,
 * forward-compatible case (a newer sidecar sent something this build predates) and
 * a caller may reasonably log it quietly. Everything else is a bug in one of the two
 * implementations and deserves a loud log line.
 */
export type DecodeFailure =
  | 'malformed-json'
  | 'not-an-object'
  | 'missing-discriminator'
  | 'unknown-kind'
  | 'invalid-shape';

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DecodeFailure; readonly detail: string };

function ok<T>(value: T): DecodeResult<T> {
  return { ok: true, value };
}

function fail<T>(reason: DecodeFailure, detail: string): DecodeResult<T> {
  return { ok: false, reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRect(value: unknown): value is Rect {
  return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber);
}

/** Copy into a fresh tuple so a decoded message never aliases the parsed JSON. */
function toRect(value: Rect): Rect {
  return [value[0], value[1], value[2], value[3]];
}

/**
 * Splits a raw line into `{ kind, body }` or explains why it cannot be one.
 * Shared by the event and command paths because both discriminate the same way,
 * just on a different property name.
 */
function readEnvelope(
  line: string,
  discriminator: 'ev' | 'cmd',
): DecodeResult<{ kind: string; body: Record<string, unknown> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return fail('malformed-json', error instanceof Error ? error.message : String(error));
  }

  if (!isRecord(parsed)) {
    return fail('not-an-object', `expected a JSON object, got ${describe(parsed)}`);
  }

  const kind = parsed[discriminator];
  if (typeof kind !== 'string') {
    return fail('missing-discriminator', `"${discriminator}" is absent or not a string`);
  }

  return ok({ kind, body: parsed });
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : typeof value;
}

/**
 * Decode one stdout line from the sidecar. Never throws - a caller reading a stream
 * gets a value it can log and skip.
 */
export function decodeEvent(line: string): DecodeResult<SidecarEvent> {
  const envelope = readEnvelope(line, 'ev');
  if (!envelope.ok) return envelope;

  const { kind, body } = envelope.value;
  switch (kind) {
    case 'ready':
      return decodeReady(body);
    case 'frame':
      return decodeFrame(body);
    case 'nochange':
      return decodeNochange(body);
    case 'ack':
      return decodeAck(body);
    case 'error':
      return decodeError(body);
    default:
      return fail('unknown-kind', `unknown event "${kind}"`);
  }
}

/**
 * Decode one stdin line inside the sidecar's Node-side twin (used by tests and by
 * the fake sidecar in M3-06). Never throws.
 */
export function decodeCommand(line: string): DecodeResult<SidecarCommand> {
  const envelope = readEnvelope(line, 'cmd');
  if (!envelope.ok) return envelope;

  const { kind, body } = envelope.value;
  switch (kind) {
    case 'listMonitors':
      return ok({ cmd: 'listMonitors' });
    case 'start':
      return ok({ cmd: 'start' });
    case 'stop':
      return ok({ cmd: 'stop' });
    case 'snapshot':
      return ok({ cmd: 'snapshot' });
    case 'debugFrame':
      return ok({ cmd: 'debugFrame' });
    case 'configure':
      return decodeConfigure(body);
    default:
      return fail('unknown-kind', `unknown command "${kind}"`);
  }
}

function decodeReady(body: Record<string, unknown>): DecodeResult<ReadyEvent> {
  const { version, ocrLanguages } = body;
  if (typeof version !== 'string') return fail('invalid-shape', 'ready.version must be a string');
  if (!Array.isArray(ocrLanguages) || !ocrLanguages.every((tag) => typeof tag === 'string')) {
    return fail('invalid-shape', 'ready.ocrLanguages must be an array of strings');
  }
  return ok({ ev: 'ready', version, ocrLanguages: [...ocrLanguages] });
}

function decodeFrame(body: Record<string, unknown>): DecodeResult<FrameEvent> {
  const { seq, timings, monitor, region, lines, imagePng } = body;

  if (!isFiniteNumber(seq)) return fail('invalid-shape', 'frame.seq must be a number');

  if (!isRecord(timings)) return fail('invalid-shape', 'frame.timings must be an object');
  if (
    !isFiniteNumber(timings['captureUs'])
    || !isFiniteNumber(timings['diffUs'])
    || !isFiniteNumber(timings['ocrUs'])
  ) {
    return fail('invalid-shape', 'frame.timings needs numeric captureUs, diffUs and ocrUs');
  }

  if (!isRecord(monitor)) return fail('invalid-shape', 'frame.monitor must be an object');
  if (typeof monitor['id'] !== 'string') return fail('invalid-shape', 'frame.monitor.id must be a string');
  // The coordinate contract lives or dies on these two. Missing means reject, not undefined.
  if (!isFiniteNumber(monitor['scale'])) return fail('invalid-shape', 'frame.monitor.scale is required');
  if (!isRect(monitor['bounds'])) return fail('invalid-shape', 'frame.monitor.bounds is required');

  if (!isRect(region)) return fail('invalid-shape', 'frame.region must be [x, y, width, height]');

  if (!Array.isArray(lines)) return fail('invalid-shape', 'frame.lines must be an array');
  const decodedLines: OcrLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw: unknown = lines[i];
    if (!isRecord(raw)) return fail('invalid-shape', `frame.lines[${i}] must be an object`);
    if (typeof raw['text'] !== 'string') return fail('invalid-shape', `frame.lines[${i}].text must be a string`);
    if (!isRect(raw['bbox'])) return fail('invalid-shape', `frame.lines[${i}].bbox must be [x, y, width, height]`);
    // Absent is the normal case - Windows.Media.Ocr reports no confidence at all. Present
    // but not a number is still a bug in the sender and is still rejected.
    const conf: unknown = raw['conf'];
    if (conf !== undefined && !isFiniteNumber(conf)) {
      return fail('invalid-shape', `frame.lines[${i}].conf must be a number when present`);
    }
    const decodedLine: OcrLine = { text: raw['text'], bbox: toRect(raw['bbox']) };
    decodedLines.push(conf === undefined ? decodedLine : { ...decodedLine, conf });
  }

  if (imagePng !== undefined && typeof imagePng !== 'string') {
    return fail('invalid-shape', 'frame.imagePng must be a base64 string when present');
  }

  const frame: FrameEvent = {
    ev: 'frame',
    seq,
    timings: { captureUs: timings['captureUs'], diffUs: timings['diffUs'], ocrUs: timings['ocrUs'] },
    monitor: { id: monitor['id'], scale: monitor['scale'], bounds: toRect(monitor['bounds']) },
    region: toRect(region),
    lines: decodedLines,
  };
  return ok(imagePng === undefined ? frame : { ...frame, imagePng });
}

function decodeNochange(body: Record<string, unknown>): DecodeResult<NochangeEvent> {
  const { seq } = body;
  if (!isFiniteNumber(seq)) return fail('invalid-shape', 'nochange.seq must be a number');
  return ok({ ev: 'nochange', seq });
}

function decodeAck(body: Record<string, unknown>): DecodeResult<AckEvent> {
  const { cmd, state, monitors } = body;
  if (typeof cmd !== 'string') return fail('invalid-shape', 'ack.cmd must be a string');
  if (typeof state !== 'string') return fail('invalid-shape', 'ack.state must be a string');

  if (monitors === undefined) return ok({ ev: 'ack', cmd, state });

  if (!Array.isArray(monitors)) return fail('invalid-shape', 'ack.monitors must be an array when present');
  const decoded: MonitorInfo[] = [];
  for (let i = 0; i < monitors.length; i += 1) {
    const raw: unknown = monitors[i];
    if (!isRecord(raw)) return fail('invalid-shape', `ack.monitors[${i}] must be an object`);
    if (typeof raw['id'] !== 'string') return fail('invalid-shape', `ack.monitors[${i}].id must be a string`);
    // Same coordinate contract as `frame.monitor`, and enforced the same way: the whole
    // point of listMonitors is to hand M6-01 something it can pick a display from.
    if (!isFiniteNumber(raw['scale'])) return fail('invalid-shape', `ack.monitors[${i}].scale is required`);
    if (!isRect(raw['bounds'])) return fail('invalid-shape', `ack.monitors[${i}].bounds is required`);
    decoded.push({ id: raw['id'], scale: raw['scale'], bounds: toRect(raw['bounds']) });
  }

  return ok({ ev: 'ack', cmd, state, monitors: decoded });
}

function decodeError(body: Record<string, unknown>): DecodeResult<ErrorEvent> {
  const { code, message } = body;
  if (typeof code !== 'string') return fail('invalid-shape', 'error.code must be a string');
  if (typeof message !== 'string') return fail('invalid-shape', 'error.message must be a string');
  return ok({ ev: 'error', code, message });
}

function decodeConfigure(body: Record<string, unknown>): DecodeResult<ConfigureCommand> {
  const { region, monitorId, intervalActive, intervalIdle, diffThreshold, ocrLanguage, debugFrameEnabled } = body;
  if (!isRect(region)) return fail('invalid-shape', 'configure.region must be [x, y, width, height]');
  if (typeof monitorId !== 'string') return fail('invalid-shape', 'configure.monitorId must be a string');
  if (!isFiniteNumber(intervalActive)) return fail('invalid-shape', 'configure.intervalActive must be a number');
  if (!isFiniteNumber(intervalIdle)) return fail('invalid-shape', 'configure.intervalIdle must be a number');
  if (!isFiniteNumber(diffThreshold)) return fail('invalid-shape', 'configure.diffThreshold must be a number');
  if (typeof ocrLanguage !== 'string') return fail('invalid-shape', 'configure.ocrLanguage must be a string');
  // Required, not defaulted to false: an omitted flag is indistinguishable from one the
  // sender believed it was setting, and this one gates pixels crossing IPC.
  if (typeof debugFrameEnabled !== 'boolean') {
    return fail('invalid-shape', 'configure.debugFrameEnabled must be a boolean');
  }
  return ok({
    cmd: 'configure',
    region: toRect(region),
    monitorId,
    intervalActive,
    intervalIdle,
    diffThreshold,
    ocrLanguage,
    debugFrameEnabled,
  });
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/*
 * The encoders rebuild each message in a fixed key order rather than handing the
 * caller's object to JSON.stringify. Two reasons: the discriminator is guaranteed to
 * come first (so a reader can cheaply peek at it), and the output is byte-comparable
 * against the golden fixtures - which is what turns "both sides emit camelCase" from
 * a claim into an assertion.
 */

/** Serialize one event to a single JSON line (no trailing newline). */
export function encodeEvent(event: SidecarEvent): string {
  switch (event.ev) {
    case 'ready':
      return JSON.stringify({
        ev: 'ready',
        version: event.version,
        ocrLanguages: [...event.ocrLanguages],
      });
    case 'frame': {
      const body: Record<string, unknown> = {
        ev: 'frame',
        seq: event.seq,
        timings: {
          captureUs: event.timings.captureUs,
          diffUs: event.timings.diffUs,
          ocrUs: event.timings.ocrUs,
        },
        monitor: { id: event.monitor.id, scale: event.monitor.scale, bounds: toRect(event.monitor.bounds) },
        region: toRect(event.region),
        lines: event.lines.map((line) => {
          const encoded: Record<string, unknown> = { text: line.text, bbox: toRect(line.bbox) };
          // Omitted, never `null` - matching `imagePng` and the C# side's
          // JsonIgnoreCondition.WhenWritingNull.
          if (line.conf !== undefined) encoded['conf'] = line.conf;
          return encoded;
        }),
      };
      if (event.imagePng !== undefined) body['imagePng'] = event.imagePng;
      return JSON.stringify(body);
    }
    case 'nochange':
      return JSON.stringify({ ev: 'nochange', seq: event.seq });
    case 'ack': {
      const body: Record<string, unknown> = { ev: 'ack', cmd: event.cmd, state: event.state };
      if (event.monitors !== undefined) {
        body['monitors'] = event.monitors.map((monitor) => ({
          id: monitor.id,
          scale: monitor.scale,
          bounds: toRect(monitor.bounds),
        }));
      }
      return JSON.stringify(body);
    }
    case 'error':
      return JSON.stringify({ ev: 'error', code: event.code, message: event.message });
  }
}

/** Serialize one command to a single JSON line (no trailing newline). */
export function encodeCommand(command: SidecarCommand): string {
  switch (command.cmd) {
    case 'configure':
      return JSON.stringify({
        cmd: 'configure',
        region: toRect(command.region),
        monitorId: command.monitorId,
        intervalActive: command.intervalActive,
        intervalIdle: command.intervalIdle,
        diffThreshold: command.diffThreshold,
        ocrLanguage: command.ocrLanguage,
        debugFrameEnabled: command.debugFrameEnabled,
      });
    case 'listMonitors':
    case 'start':
    case 'stop':
    case 'snapshot':
    case 'debugFrame':
      return JSON.stringify({ cmd: command.cmd });
  }
}
