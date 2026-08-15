using System.Text.Json;
using System.Text.Json.Serialization;

namespace Textlens.Capture.Protocol;

/// <summary>
/// A rectangle on the wire, serialized as <c>[x, y, width, height]</c>.
///
/// Every rectangle in the protocol — <c>region</c>, <c>monitor.bounds</c> and
/// <c>lines[].bbox</c> — uses this one shape. The design doc's examples show
/// <c>region</c> and <c>bbox</c> as origin+size, so <c>bounds</c> is read the same
/// way rather than as left/top/right/bottom: a mixed convention is how a monitor at
/// <c>[-1920, 0, 1920, 1080]</c> silently becomes <c>[-1920, 0, 0, 1080]</c>.
///
/// Units and origins are per field, and getting them wrong is the DPI bug the design
/// doc says the reference project shipped:
/// <list type="bullet">
///   <item><c>lines[].bbox</c> — physical px, relative to the region's top-left</item>
///   <item><c>region</c> — physical px, relative to the monitor's top-left</item>
///   <item><c>monitor.bounds</c> — physical px, absolute on the virtual desktop</item>
/// </list>
/// Every rectangle on the wire is physical px; the sidecar performs no scale
/// arithmetic at all (coordinate ruling of 2026-08-16, design doc section 3).
///
/// <c>bounds</c> being physical is why M3-01 takes the logical origin from Electron
/// rather than from this field — <c>logicalX = (regionX + bboxX) / scale +
/// display.bounds.x</c>, where <c>display</c> is the Electron Display. When monitors
/// differ in DPI a logical origin simply cannot be derived from a physical one, because
/// Chromium lays displays out adjacent in DIP space instead of dividing each physical
/// rect by that display's own scale. <c>monitor.bounds</c> is carried for
/// identification and diagnostics.
///
/// A named 4-tuple rather than an <c>int[]</c> for two concrete reasons: the arity
/// becomes a compile-time fact, and value equality makes the round-trip test compare
/// contents instead of array references.
/// </summary>
/// <param name="X">Left edge.</param>
/// <param name="Y">Top edge.</param>
/// <param name="Width">Width, not the right edge.</param>
/// <param name="Height">Height, not the bottom edge.</param>
[JsonConverter(typeof(RectJsonConverter))]
public readonly record struct Rect(int X, int Y, int Width, int Height);

/// <summary>
/// Maps <see cref="Rect"/> to and from a 4-element JSON array. Hand-written rather
/// than reflected so it stays NativeAOT-safe, and strict about arity so a truncated
/// or over-long rectangle is a parse error rather than three good numbers and a guess.
/// </summary>
public sealed class RectJsonConverter : JsonConverter<Rect>
{
    public override Rect Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.StartArray)
        {
            throw new JsonException($"expected a rectangle array [x, y, width, height], got {reader.TokenType}");
        }

        Span<int> values = stackalloc int[4];
        for (var i = 0; i < values.Length; i++)
        {
            if (!reader.Read() || reader.TokenType != JsonTokenType.Number || !reader.TryGetInt32(out var value))
            {
                throw new JsonException($"rectangle element {i} is missing or is not a 32-bit integer");
            }

            values[i] = value;
        }

        if (!reader.Read() || reader.TokenType != JsonTokenType.EndArray)
        {
            throw new JsonException("a rectangle must have exactly 4 elements [x, y, width, height]");
        }

        return new Rect(values[0], values[1], values[2], values[3]);
    }

    public override void Write(Utf8JsonWriter writer, Rect value, JsonSerializerOptions options)
    {
        writer.WriteStartArray();
        writer.WriteNumberValue(value.X);
        writer.WriteNumberValue(value.Y);
        writer.WriteNumberValue(value.Width);
        writer.WriteNumberValue(value.Height);
        writer.WriteEndArray();
    }
}
