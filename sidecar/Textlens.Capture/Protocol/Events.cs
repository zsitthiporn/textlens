using System.Text.Json.Serialization;

namespace Textlens.Capture.Protocol;

/// <summary>Wire values of the <c>ev</c> discriminator.</summary>
public static class EventKind
{
    public const string Ready = "ready";
    public const string Frame = "frame";
    public const string NoChange = "nochange";
    public const string Ack = "ack";
    public const string Error = "error";
}

/// <summary>
/// Wire values of <see cref="AckEvent.State"/> — the sidecar's command state machine
/// (issue M2-06).
///
/// <para><c>idle</c> is the state before any <c>configure</c>; <c>configured</c> means a
/// region and monitor are known but no capture is running; <c>running</c> means the
/// capture loop is ticking; <c>stopped</c> is the result of a <c>stop</c> once a
/// configuration exists.</para>
///
/// <para><c>stopped</c> and <c>configured</c> both describe "configured but not
/// capturing" and differ only in how they were reached — a <c>stop</c> sent after
/// <c>configure</c> but before any <c>start</c> reports <c>stopped</c>, not
/// <c>configured</c>. <c>start</c> is valid from either.</para>
/// </summary>
public static class SidecarState
{
    public const string Idle = "idle";
    public const string Configured = "configured";
    public const string Running = "running";
    public const string Stopped = "stopped";
}

/// <summary>A message the sidecar writes to stdout, one per line.</summary>
public interface ISidecarEvent
{
    /// <summary>The <c>ev</c> discriminator; always the first property on the wire.</summary>
    string Ev { get; }
}

/// <summary>
/// First line the sidecar writes. <see cref="OcrLanguages"/> is the recognizer list
/// actually installed on this machine — it is what feature O8's preflight reads, so
/// it is enumerated at runtime and may legitimately be empty.
/// </summary>
public sealed record ReadyEvent : ISidecarEvent
{
    [JsonPropertyOrder(-1)]
    public string Ev { get; init; } = EventKind.Ready;

    public required string Version { get; init; }

    /// <summary>BCP-47 tags of the installed OCR recognizers, e.g. <c>en-US</c>.</summary>
    public required string[] OcrLanguages { get; init; }
}

/// <summary>
/// Per-stage cost of one capture round, in <b>microseconds</b> (feature L3).
///
/// <para><b>Why microseconds, and why the field names carry the unit.</b> These were
/// milliseconds, and that made the capture metric permanently useless: measured capture
/// is p50 <c>0.574ms</c>, which as an <c>int</c> of milliseconds is <c>0</c> on every
/// frame forever. A metric that cannot express its own typical value does not measure
/// anything, and design doc section 4 asks for these numbers precisely so that "we are
/// over budget" can be answered with "here is which stage".</para>
///
/// <para><b>Integer, not floating point.</b> All sixteen protocol fixtures are re-encoded
/// and compared byte for byte by both the xunit and the vitest suite. C# and JavaScript
/// do not format decimals identically (<c>0.5</c> against <c>0.50</c>), so a fractional
/// millisecond would turn a rounding difference into a cross-language contract failure
/// that is miserable to attribute. Microseconds keep the resolution and keep the values
/// integral: the 15ms capture+diff row is 15000µs.</para>
///
/// <para>The <c>Us</c> suffix is on the wire names too. A bare <c>capture</c> that
/// silently changed unit is exactly the sort of thing a consumer keeps dividing by the
/// wrong constant for a year; <c>captureUs</c> cannot be misread.</para>
/// </summary>
public sealed record FrameTimings
{
    /// <summary>Frame-in-hand to buffer-ready, in µs. Excludes waiting for the compositor.</summary>
    public required int CaptureUs { get; init; }

    /// <summary>Change detection, in µs.</summary>
    public required int DiffUs { get; init; }

    /// <summary>Recognition, in µs. Zero when the frame was unchanged and OCR was skipped.</summary>
    public required int OcrUs { get; init; }
}

/// <summary>
/// The monitor a frame came from. <see cref="Scale"/> and <see cref="Bounds"/> are
/// the two inputs the coordinate converter (M3-01) cannot work without, which is why
/// both are <c>required</c> — missing means a parse error, never a default.
/// </summary>
public sealed record MonitorInfo
{
    /// <summary>Windows device name, e.g. <c>\\.\DISPLAY1</c>.</summary>
    public required string Id { get; init; }

    /// <summary>DPI scale factor, e.g. 1.0 / 1.25 / 1.5.</summary>
    public required double Scale { get; init; }

    /// <summary>
    /// Monitor rectangle in <b>raw physical px straight from Win32</b>, absolute on the
    /// virtual desktop. Never divided by <see cref="Scale"/> — see <see cref="Rect"/>.
    /// </summary>
    public required Rect Bounds { get; init; }
}

/// <summary>One OCR line: text plus its box in physical px relative to the region's top-left.</summary>
public sealed record OcrLine
{
    public required string Text { get; init; }
    public required Rect Bbox { get; init; }

    /// <summary>
    /// Recognizer confidence, 0..1 — <b>present only when the engine actually reports
    /// one</b>, and therefore omitted from the wire rather than written as <c>null</c>.
    ///
    /// <para><b>Windows.Media.Ocr reports none.</b> Verified against the projection this
    /// project builds on: <c>OcrResult</c> exposes <c>Lines</c>, <c>Text</c> and
    /// <c>TextAngle</c>; <c>OcrLine</c> exposes <c>Text</c> and <c>Words</c>;
    /// <c>OcrWord</c> exposes <c>Text</c> and <c>BoundingRect</c>. There is no confidence
    /// anywhere in the namespace, which is why spike S1's harness recorded text and boxes
    /// only.</para>
    ///
    /// <para>Optional rather than a constant, because a constant would be
    /// <i>misinformation</i>: every consumer would read <c>1.0</c> as "the recognizer is
    /// certain" when the truth is that it never said. That is the same silent-default
    /// failure the coordinate contract makes <c>scale</c> required to prevent — a field
    /// that is present, plausible and meaningless. It is also the swap the architecture is
    /// built for: PaddleOCR does report confidence, so "present when the engine provides
    /// it" survives an engine change that "we made a number up once" would not.</para>
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public double? Conf { get; init; }
}

/// <summary>
/// A completed capture round: what was read, from where, and what it cost.
///
/// Note that <see cref="Lines"/> is an array, so the compiler-generated record
/// equality compares it by reference. Compare frames field by field (or by their
/// encoded form) rather than with <c>==</c>.
/// </summary>
public sealed record FrameEvent : ISidecarEvent
{
    [JsonPropertyOrder(-1)]
    public string Ev { get; init; } = EventKind.Frame;

    public required long Seq { get; init; }
    public required FrameTimings Timings { get; init; }
    public required MonitorInfo Monitor { get; init; }

    /// <summary>The captured region in physical px, relative to the monitor's top-left.</summary>
    public required Rect Region { get; init; }

    public required OcrLine[] Lines { get; init; }

    /// <summary>
    /// base64 PNG of the captured region. Emitted only in reply to <c>debugFrame</c>,
    /// so it is omitted from the wire rather than written as <c>null</c>.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ImagePng { get; init; }
}

/// <summary>
/// The reply to a command that does not produce a <c>frame</c>.
///
/// <para><b>Why one event kind for four commands.</b> Design doc section 3 promises a
/// reply to <c>listMonitors</c> ("รายการจอ + bounds + scale") and an ack to
/// <c>configure</c>, <c>start</c> and <c>stop</c>, and until now nothing on the wire could
/// carry any of them. Four bespoke reply events would be four things to learn, four
/// decoder arms and four fixtures; one <c>ack</c> that names the command it answers is
/// the same information with one shape. <c>snapshot</c> and <c>debugFrame</c> are
/// unaffected — they already reply with a <c>frame</c>.</para>
///
/// <para><b>There is no correlation id.</b> Replies correlate by <see cref="Cmd"/>, which
/// is unambiguous only while at most one command of a given kind is outstanding. That
/// holds for this state machine — Node sends a command and waits — but anyone adding
/// pipelined or concurrent commands has to add an id first.</para>
/// </summary>
public sealed record AckEvent : ISidecarEvent
{
    [JsonPropertyOrder(-1)]
    public string Ev { get; init; } = EventKind.Ack;

    /// <summary>
    /// The <c>cmd</c> being acknowledged. An open string for the same reason
    /// <see cref="ErrorEvent.Code"/> is: a closed enum would make a sidecar that learns a
    /// new command unparseable by an older Node build.
    /// </summary>
    public required string Cmd { get; init; }

    /// <summary>
    /// The state machine's state <i>after</i> the command was applied — see
    /// <see cref="SidecarState"/>. Carried on every ack rather than only on
    /// <c>start</c>/<c>stop</c> so that the sidecar's state is readable straight off a
    /// stdin transcript, which is the debugging story stdio was chosen for.
    /// </summary>
    public required string State { get; init; }

    /// <summary>
    /// Attached displays. Present only on the reply to <c>listMonitors</c>, so it is
    /// omitted from the wire rather than written as <c>null</c> — the same treatment
    /// <see cref="FrameEvent.ImagePng"/> gets.
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MonitorInfo[]? Monitors { get; init; }
}

/// <summary>The region did not change; no OCR was run. Carries <c>seq</c> so gaps are detectable.</summary>
public sealed record NoChangeEvent : ISidecarEvent
{
    [JsonPropertyOrder(-1)]
    public string Ev { get; init; } = EventKind.NoChange;

    public required long Seq { get; init; }
}

/// <summary>
/// Something failed inside the sidecar. <see cref="Code"/> is deliberately an open
/// string: a closed enum would make a sidecar that learns a new failure mode
/// unparseable by an older Node build, which is the opposite of the point.
/// </summary>
public sealed record ErrorEvent : ISidecarEvent
{
    [JsonPropertyOrder(-1)]
    public string Ev { get; init; } = EventKind.Error;

    public required string Code { get; init; }
    public required string Message { get; init; }
}
