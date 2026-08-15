using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Textlens.Capture.Services;

/// <summary>
/// Encodes a captured region as a base64 PNG for the <c>debugFrame</c> command.
///
/// <para>This is the single sanctioned exception to "pixels never cross IPC"
/// (CLAUDE.md invariant 1), which is why it lives behind
/// <see cref="CaptureLoop.DebugFrameEnabled"/> and why that flag has no default — see
/// <c>ConfigureCommand.DebugFrameEnabled</c>. Nothing in the ordinary tick path
/// constructs one of these.</para>
///
/// <para>Uses the WinRT imaging encoder already projected for OCR rather than adding an
/// image library. Off the hot path entirely: <c>debugFrame</c> is a human typing a command,
/// not something the capture loop does.</para>
/// </summary>
public sealed class PngFrameEncoder : IFrameEncoder
{
    /// <summary>Encodes a tightly packed BGRA region. Alpha is ignored, not composited.</summary>
    public string ToBase64Png(ReadOnlySpan<byte> bgra, int width, int height)
    {
        if (width <= 0 || height <= 0)
        {
            throw new ArgumentException($"a region cannot be {width}x{height}", nameof(width));
        }

        var expected = checked(width * height * 4);
        if (bgra.Length != expected)
        {
            throw new ArgumentException(
                $"a {width}x{height} BGRA region is {expected} bytes, got {bgra.Length}",
                nameof(bgra));
        }

        // SetPixelData wants an array, and the caller's span is a view onto a buffer the
        // capture service reuses — so a copy is required here regardless.
        var pixels = bgra.ToArray();

        using var stream = new InMemoryRandomAccessStream();

        var encoder = BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream).GetAwaiter().GetResult();

        // BitmapAlphaMode.Ignore, deliberately: a Windows Graphics Capture surface's alpha
        // is not meaningfully defined for desktop content and is routinely zero. Treating
        // it as real would produce a debug image that is transparent where the screen was
        // perfectly opaque — a picture that misleads about the very thing it exists to
        // show. The same reasoning makes OcrService force alpha opaque before recognizing.
        encoder.SetPixelData(
            BitmapPixelFormat.Bgra8,
            BitmapAlphaMode.Ignore,
            (uint)width,
            (uint)height,
            96,
            96,
            pixels);

        encoder.FlushAsync().GetAwaiter().GetResult();

        var size = (uint)stream.Size;
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        reader.LoadAsync(size).GetAwaiter().GetResult();

        var encoded = new byte[size];
        reader.ReadBytes(encoded);

        return Convert.ToBase64String(encoded);
    }
}
