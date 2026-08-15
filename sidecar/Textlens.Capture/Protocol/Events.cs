using System.Text.Json.Serialization;

namespace Textlens.Capture.Protocol;

/// <summary>Wire values of the <c>ev</c> discriminator.</summary>
public static class EventKind
{
    public const string Ready = "ready";
    public const string Frame = "frame";
    public const string NoChange = "nochange";
    public const string Error = "error";
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

/// <summary>Per-stage cost of one capture round, in ms (feature L3).</summary>
public sealed record FrameTimings
{
    public required int Capture { get; init; }
    public required int Diff { get; init; }
    public required int Ocr { get; init; }
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

    /// <summary>Recognizer confidence, 0..1.</summary>
    public required double Conf { get; init; }
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
