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
];
export function isCommandKind(value) {
    return typeof value === 'string' && COMMAND_KINDS.includes(value);
}
// ---------------------------------------------------------------------------
// Events (sidecar -> Node)
// ---------------------------------------------------------------------------
export const EVENT_KINDS = ['ready', 'frame', 'nochange', 'ack', 'error'];
export function isEventKind(value) {
    return typeof value === 'string' && EVENT_KINDS.includes(value);
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
export const SIDECAR_STATES = ['idle', 'configured', 'running', 'stopped'];
function ok(value) {
    return { ok: true, value };
}
function fail(reason, detail) {
    return { ok: false, reason, detail };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isRect(value) {
    return Array.isArray(value) && value.length === 4 && value.every(isFiniteNumber);
}
/** Copy into a fresh tuple so a decoded message never aliases the parsed JSON. */
function toRect(value) {
    return [value[0], value[1], value[2], value[3]];
}
/**
 * Splits a raw line into `{ kind, body }` or explains why it cannot be one.
 * Shared by the event and command paths because both discriminate the same way,
 * just on a different property name.
 */
function readEnvelope(line, discriminator) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch (error) {
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
function describe(value) {
    if (value === null)
        return 'null';
    return Array.isArray(value) ? 'an array' : typeof value;
}
/**
 * Decode one stdout line from the sidecar. Never throws - a caller reading a stream
 * gets a value it can log and skip.
 */
export function decodeEvent(line) {
    const envelope = readEnvelope(line, 'ev');
    if (!envelope.ok)
        return envelope;
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
export function decodeCommand(line) {
    const envelope = readEnvelope(line, 'cmd');
    if (!envelope.ok)
        return envelope;
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
function decodeReady(body) {
    const { version, ocrLanguages } = body;
    if (typeof version !== 'string')
        return fail('invalid-shape', 'ready.version must be a string');
    if (!Array.isArray(ocrLanguages) || !ocrLanguages.every((tag) => typeof tag === 'string')) {
        return fail('invalid-shape', 'ready.ocrLanguages must be an array of strings');
    }
    return ok({ ev: 'ready', version, ocrLanguages: [...ocrLanguages] });
}
function decodeFrame(body) {
    const { seq, timings, monitor, region, lines, imagePng } = body;
    if (!isFiniteNumber(seq))
        return fail('invalid-shape', 'frame.seq must be a number');
    if (!isRecord(timings))
        return fail('invalid-shape', 'frame.timings must be an object');
    if (!isFiniteNumber(timings['captureUs'])
        || !isFiniteNumber(timings['diffUs'])
        || !isFiniteNumber(timings['ocrUs'])) {
        return fail('invalid-shape', 'frame.timings needs numeric captureUs, diffUs and ocrUs');
    }
    if (!isRecord(monitor))
        return fail('invalid-shape', 'frame.monitor must be an object');
    if (typeof monitor['id'] !== 'string')
        return fail('invalid-shape', 'frame.monitor.id must be a string');
    // The coordinate contract lives or dies on these two. Missing means reject, not undefined.
    if (!isFiniteNumber(monitor['scale']))
        return fail('invalid-shape', 'frame.monitor.scale is required');
    if (!isRect(monitor['bounds']))
        return fail('invalid-shape', 'frame.monitor.bounds is required');
    if (!isRect(region))
        return fail('invalid-shape', 'frame.region must be [x, y, width, height]');
    if (!Array.isArray(lines))
        return fail('invalid-shape', 'frame.lines must be an array');
    const decodedLines = [];
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i];
        if (!isRecord(raw))
            return fail('invalid-shape', `frame.lines[${i}] must be an object`);
        if (typeof raw['text'] !== 'string')
            return fail('invalid-shape', `frame.lines[${i}].text must be a string`);
        if (!isRect(raw['bbox']))
            return fail('invalid-shape', `frame.lines[${i}].bbox must be [x, y, width, height]`);
        // Absent is the normal case - Windows.Media.Ocr reports no confidence at all. Present
        // but not a number is still a bug in the sender and is still rejected.
        const conf = raw['conf'];
        if (conf !== undefined && !isFiniteNumber(conf)) {
            return fail('invalid-shape', `frame.lines[${i}].conf must be a number when present`);
        }
        const decodedLine = { text: raw['text'], bbox: toRect(raw['bbox']) };
        decodedLines.push(conf === undefined ? decodedLine : { ...decodedLine, conf });
    }
    if (imagePng !== undefined && typeof imagePng !== 'string') {
        return fail('invalid-shape', 'frame.imagePng must be a base64 string when present');
    }
    const frame = {
        ev: 'frame',
        seq,
        timings: { captureUs: timings['captureUs'], diffUs: timings['diffUs'], ocrUs: timings['ocrUs'] },
        monitor: { id: monitor['id'], scale: monitor['scale'], bounds: toRect(monitor['bounds']) },
        region: toRect(region),
        lines: decodedLines,
    };
    return ok(imagePng === undefined ? frame : { ...frame, imagePng });
}
function decodeNochange(body) {
    const { seq } = body;
    if (!isFiniteNumber(seq))
        return fail('invalid-shape', 'nochange.seq must be a number');
    return ok({ ev: 'nochange', seq });
}
function decodeAck(body) {
    const { cmd, state, monitors } = body;
    if (typeof cmd !== 'string')
        return fail('invalid-shape', 'ack.cmd must be a string');
    if (typeof state !== 'string')
        return fail('invalid-shape', 'ack.state must be a string');
    if (monitors === undefined)
        return ok({ ev: 'ack', cmd, state });
    if (!Array.isArray(monitors))
        return fail('invalid-shape', 'ack.monitors must be an array when present');
    const decoded = [];
    for (let i = 0; i < monitors.length; i += 1) {
        const raw = monitors[i];
        if (!isRecord(raw))
            return fail('invalid-shape', `ack.monitors[${i}] must be an object`);
        if (typeof raw['id'] !== 'string')
            return fail('invalid-shape', `ack.monitors[${i}].id must be a string`);
        // Same coordinate contract as `frame.monitor`, and enforced the same way: the whole
        // point of listMonitors is to hand M6-01 something it can pick a display from.
        if (!isFiniteNumber(raw['scale']))
            return fail('invalid-shape', `ack.monitors[${i}].scale is required`);
        if (!isRect(raw['bounds']))
            return fail('invalid-shape', `ack.monitors[${i}].bounds is required`);
        decoded.push({ id: raw['id'], scale: raw['scale'], bounds: toRect(raw['bounds']) });
    }
    return ok({ ev: 'ack', cmd, state, monitors: decoded });
}
function decodeError(body) {
    const { code, message } = body;
    if (typeof code !== 'string')
        return fail('invalid-shape', 'error.code must be a string');
    if (typeof message !== 'string')
        return fail('invalid-shape', 'error.message must be a string');
    return ok({ ev: 'error', code, message });
}
function decodeConfigure(body) {
    const { region, monitorId, intervalActive, intervalIdle, diffThreshold, ocrLanguage, debugFrameEnabled } = body;
    if (!isRect(region))
        return fail('invalid-shape', 'configure.region must be [x, y, width, height]');
    if (typeof monitorId !== 'string')
        return fail('invalid-shape', 'configure.monitorId must be a string');
    if (!isFiniteNumber(intervalActive))
        return fail('invalid-shape', 'configure.intervalActive must be a number');
    if (!isFiniteNumber(intervalIdle))
        return fail('invalid-shape', 'configure.intervalIdle must be a number');
    if (!isFiniteNumber(diffThreshold))
        return fail('invalid-shape', 'configure.diffThreshold must be a number');
    if (typeof ocrLanguage !== 'string')
        return fail('invalid-shape', 'configure.ocrLanguage must be a string');
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
export function encodeEvent(event) {
    switch (event.ev) {
        case 'ready':
            return JSON.stringify({
                ev: 'ready',
                version: event.version,
                ocrLanguages: [...event.ocrLanguages],
            });
        case 'frame': {
            const body = {
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
                    const encoded = { text: line.text, bbox: toRect(line.bbox) };
                    // Omitted, never `null` - matching `imagePng` and the C# side's
                    // JsonIgnoreCondition.WhenWritingNull.
                    if (line.conf !== undefined)
                        encoded['conf'] = line.conf;
                    return encoded;
                }),
            };
            if (event.imagePng !== undefined)
                body['imagePng'] = event.imagePng;
            return JSON.stringify(body);
        }
        case 'nochange':
            return JSON.stringify({ ev: 'nochange', seq: event.seq });
        case 'ack': {
            const body = { ev: 'ack', cmd: event.cmd, state: event.state };
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
export function encodeCommand(command) {
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
