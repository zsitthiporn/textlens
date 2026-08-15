using System.Text.Json.Serialization;

namespace Textlens.Capture.Protocol;

/// <summary>
/// Wire values of the <c>cmd</c> discriminator. Constants rather than an enum so the
/// exact strings on the wire are greppable and so <c>switch</c> arms in the codec can
/// use them as case labels.
/// </summary>
public static class CommandKind
{
    public const string ListMonitors = "listMonitors";
    public const string Configure = "configure";
    public const string Start = "start";
    public const string Stop = "stop";
    public const string Snapshot = "snapshot";
    public const string DebugFrame = "debugFrame";
}

/// <summary>A message Node sends to the sidecar's stdin, one per line.</summary>
public interface ISidecarCommand
{
    /// <summary>The <c>cmd</c> discriminator; always the first property on the wire.</summary>
    string Cmd { get; }
}

/// <summary>Enumerate monitors with their bounds and scale factor.</summary>
public sealed record ListMonitorsCommand : ISidecarCommand
{
    [JsonPropertyOrder(-1)]
    public string Cmd { get; init; } = CommandKind.ListMonitors;
}

/// <summary>
/// Push the full capture configuration. Every field is <c>required</c>: a partial
/// update would leave Node and the sidecar disagreeing about the current settings,
/// and the two that matter most (<c>region</c>, <c>monitorId</c>) are exactly the
/// ones a merge would get silently wrong.
/// </summary>
public sealed record ConfigureCommand : ISidecarCommand
{
    [JsonPropertyOrder(-1)]
    public string Cmd { get; init; } = CommandKind.Configure;

    /// <summary>Capture region in physical px, relative to the monitor's top-left.</summary>
    public required Rect Region { get; init; }

    /// <summary>Device name of the monitor to capture, as returned by <c>listMonitors</c>.</summary>
    public required string MonitorId { get; init; }

    /// <summary>Poll interval in ms while text is changing.</summary>
    public required int IntervalActive { get; init; }

    /// <summary>Poll interval in ms while the region looks idle.</summary>
    public required int IntervalIdle { get; init; }

    /// <summary>Fraction of changed pixels (0..1) above which a frame counts as changed.</summary>
    public required double DiffThreshold { get; init; }

    /// <summary>BCP-47 tag of the OCR recognizer to use, e.g. <c>en-US</c>.</summary>
    public required string OcrLanguage { get; init; }
}

/// <summary>Begin the capture loop.</summary>
public sealed record StartCommand : ISidecarCommand
{
    [JsonPropertyOrder(-1)]
    public string Cmd { get; init; } = CommandKind.Start;
}

/// <summary>Halt the capture loop.</summary>
public sealed record StopCommand : ISidecarCommand
{
    [JsonPropertyOrder(-1)]
    public string Cmd { get; init; } = CommandKind.Stop;
}

/// <summary>Emit exactly one <c>frame</c>, bypassing change detection.</summary>
public sealed record SnapshotCommand : ISidecarCommand
{
    [JsonPropertyOrder(-1)]
    public string Cmd { get; init; } = CommandKind.Snapshot;
}

/// <summary>
/// Emit one <c>frame</c> carrying <c>imagePng</c>. This is the single exception to
/// "pixels never cross IPC" (CLAUDE.md invariant 1) and is off unless explicitly
/// enabled.
/// </summary>
public sealed record DebugFrameCommand : ISidecarCommand
{
    [JsonPropertyOrder(-1)]
    public string Cmd { get; init; } = CommandKind.DebugFrame;
}
