using System.Diagnostics.CodeAnalysis;
using System.Text.Json;

namespace Textlens.Capture.Protocol;

/// <summary>
/// Why a line could not be turned into a message.
///
/// <see cref="UnknownKind"/> is deliberately separate from the rest: it is the benign,
/// forward-compatible case (a newer peer sent something this build predates) and a
/// caller may reasonably log it quietly. Every other value means one of the two
/// implementations has a bug and deserves a loud log line.
/// </summary>
public enum DecodeFailure
{
    /// <summary>No failure — <see cref="DecodeResult{T}.Value"/> is populated.</summary>
    None = 0,
    MalformedJson,
    NotAnObject,
    MissingDiscriminator,
    UnknownKind,
    InvalidShape,
}

/// <summary>
/// The outcome of decoding one line. A value rather than an exception, because the
/// caller is a read loop: one bad line must cost one log entry, not the connection
/// (CLAUDE.md invariant 4 — nothing fails silently, but nothing fails fatally either).
/// </summary>
public sealed class DecodeResult<T>
    where T : class
{
    private DecodeResult(T? value, DecodeFailure failure, string detail)
    {
        Value = value;
        Failure = failure;
        Detail = detail;
    }

    public T? Value { get; }

    public DecodeFailure Failure { get; }

    /// <summary>Human-readable reason, intended for the caller's log line. Empty on success.</summary>
    public string Detail { get; }

    [MemberNotNullWhen(true, nameof(Value))]
    public bool Ok => Failure == DecodeFailure.None;

    public static DecodeResult<T> Success(T value) => new(value, DecodeFailure.None, string.Empty);

    public static DecodeResult<T> Failed(DecodeFailure failure, string detail) => new(null, failure, detail);
}

/// <summary>
/// Encodes and decodes the JSON-lines protocol (design doc section 3).
///
/// Decoding discriminates by hand — read <c>ev</c>/<c>cmd</c> out of a
/// <see cref="JsonDocument"/>, then deserialize the concrete type — rather than using
/// <c>[JsonPolymorphic]</c>. That costs one extra pass over a message that arrives at
/// most a few times a second, and buys two things worth more than the pass: an
/// unknown discriminator is a normal return value instead of an exception, and it is
/// distinguishable from malformed JSON in the log.
/// </summary>
public static class ProtocolCodec
{
    /// <summary>Serialize one event to a single JSON line (no trailing newline).</summary>
    public static string Encode(ISidecarEvent evt) => evt switch
    {
        ReadyEvent e => JsonSerializer.Serialize(e, ProtocolJsonContext.Default.ReadyEvent),
        FrameEvent e => JsonSerializer.Serialize(e, ProtocolJsonContext.Default.FrameEvent),
        NoChangeEvent e => JsonSerializer.Serialize(e, ProtocolJsonContext.Default.NoChangeEvent),
        ErrorEvent e => JsonSerializer.Serialize(e, ProtocolJsonContext.Default.ErrorEvent),
        _ => throw new ArgumentOutOfRangeException(nameof(evt), evt.GetType().FullName, "no encoder for this event type"),
    };

    /// <summary>Serialize one command to a single JSON line (no trailing newline).</summary>
    public static string Encode(ISidecarCommand command) => command switch
    {
        ListMonitorsCommand c => JsonSerializer.Serialize(c, ProtocolJsonContext.Default.ListMonitorsCommand),
        ConfigureCommand c => JsonSerializer.Serialize(c, ProtocolJsonContext.Default.ConfigureCommand),
        StartCommand c => JsonSerializer.Serialize(c, ProtocolJsonContext.Default.StartCommand),
        StopCommand c => JsonSerializer.Serialize(c, ProtocolJsonContext.Default.StopCommand),
        SnapshotCommand c => JsonSerializer.Serialize(c, ProtocolJsonContext.Default.SnapshotCommand),
        DebugFrameCommand c => JsonSerializer.Serialize(c, ProtocolJsonContext.Default.DebugFrameCommand),
        _ => throw new ArgumentOutOfRangeException(nameof(command), command.GetType().FullName, "no encoder for this command type"),
    };

    /// <summary>Decode one line the sidecar would write to stdout. Never throws.</summary>
    public static DecodeResult<ISidecarEvent> DecodeEvent(string line)
    {
        if (!TryOpen<ISidecarEvent>(line, "ev", out var doc, out var root, out var kind, out var failure))
        {
            return failure;
        }

        using (doc)
        {
            try
            {
                return kind switch
                {
                    EventKind.Ready => Ok<ISidecarEvent>(root.Deserialize(ProtocolJsonContext.Default.ReadyEvent)),
                    EventKind.Frame => Ok<ISidecarEvent>(root.Deserialize(ProtocolJsonContext.Default.FrameEvent)),
                    EventKind.NoChange => Ok<ISidecarEvent>(root.Deserialize(ProtocolJsonContext.Default.NoChangeEvent)),
                    EventKind.Error => Ok<ISidecarEvent>(root.Deserialize(ProtocolJsonContext.Default.ErrorEvent)),
                    _ => DecodeResult<ISidecarEvent>.Failed(DecodeFailure.UnknownKind, $"unknown event \"{kind}\""),
                };
            }
            catch (JsonException ex)
            {
                return DecodeResult<ISidecarEvent>.Failed(DecodeFailure.InvalidShape, ex.Message);
            }
        }
    }

    /// <summary>Decode one line Node would write to the sidecar's stdin. Never throws.</summary>
    public static DecodeResult<ISidecarCommand> DecodeCommand(string line)
    {
        if (!TryOpen<ISidecarCommand>(line, "cmd", out var doc, out var root, out var kind, out var failure))
        {
            return failure;
        }

        using (doc)
        {
            try
            {
                return kind switch
                {
                    CommandKind.ListMonitors => Ok<ISidecarCommand>(root.Deserialize(ProtocolJsonContext.Default.ListMonitorsCommand)),
                    CommandKind.Configure => Ok<ISidecarCommand>(root.Deserialize(ProtocolJsonContext.Default.ConfigureCommand)),
                    CommandKind.Start => Ok<ISidecarCommand>(root.Deserialize(ProtocolJsonContext.Default.StartCommand)),
                    CommandKind.Stop => Ok<ISidecarCommand>(root.Deserialize(ProtocolJsonContext.Default.StopCommand)),
                    CommandKind.Snapshot => Ok<ISidecarCommand>(root.Deserialize(ProtocolJsonContext.Default.SnapshotCommand)),
                    CommandKind.DebugFrame => Ok<ISidecarCommand>(root.Deserialize(ProtocolJsonContext.Default.DebugFrameCommand)),
                    _ => DecodeResult<ISidecarCommand>.Failed(DecodeFailure.UnknownKind, $"unknown command \"{kind}\""),
                };
            }
            catch (JsonException ex)
            {
                return DecodeResult<ISidecarCommand>.Failed(DecodeFailure.InvalidShape, ex.Message);
            }
        }
    }

    /// <summary>
    /// Parses the line and pulls out the discriminator. Shared by both directions
    /// because they differ only in the property name they look for.
    /// </summary>
    private static bool TryOpen<T>(
        string line,
        string discriminator,
        [NotNullWhen(true)] out JsonDocument? doc,
        out JsonElement root,
        out string kind,
        [NotNullWhen(false)] out DecodeResult<T>? failure)
        where T : class
    {
        doc = null;
        root = default;
        kind = string.Empty;

        JsonDocument parsed;
        try
        {
            parsed = JsonDocument.Parse(line);
        }
        catch (JsonException ex)
        {
            failure = DecodeResult<T>.Failed(DecodeFailure.MalformedJson, ex.Message);
            return false;
        }

        if (parsed.RootElement.ValueKind != JsonValueKind.Object)
        {
            var kindName = parsed.RootElement.ValueKind;
            parsed.Dispose();
            failure = DecodeResult<T>.Failed(DecodeFailure.NotAnObject, $"expected a JSON object, got {kindName}");
            return false;
        }

        if (!parsed.RootElement.TryGetProperty(discriminator, out var discriminatorElement)
            || discriminatorElement.ValueKind != JsonValueKind.String)
        {
            parsed.Dispose();
            failure = DecodeResult<T>.Failed(
                DecodeFailure.MissingDiscriminator,
                $"\"{discriminator}\" is absent or not a string");
            return false;
        }

        doc = parsed;
        root = parsed.RootElement;
        kind = discriminatorElement.GetString() ?? string.Empty;
        failure = null;
        return true;
    }

    /// <summary>
    /// Wraps a deserialized message. The null check is not ceremony: a bare
    /// <c>null</c> literal is valid JSON and would otherwise become a
    /// <see cref="DecodeResult{T}"/> that claims success and carries nothing.
    /// </summary>
    private static DecodeResult<T> Ok<T>(T? value)
        where T : class
        => value is null
            ? DecodeResult<T>.Failed(DecodeFailure.InvalidShape, "the message body deserialized to null")
            : DecodeResult<T>.Success(value);
}
