using Textlens.Capture.Interop;
using Textlens.Capture.Protocol;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using WireLine = Textlens.Capture.Protocol.OcrLine;

namespace Textlens.Capture.Services;

/// <summary>
/// Feature O1 — turns a captured BGRA region into line-level text with boxes.
///
/// <para>Spike S1 settled the engine: Windows.Media.Ocr is ~6x faster than PaddleOCR on
/// this workload (22-36ms on a ~1200x200 region) and more accurate on game text. This
/// class is the whole of the OCR stage; grouping lines into blocks and filtering noise
/// are Node-side by architecture invariant 2 and are not done here.</para>
///
/// <para><b>Everything expensive is created once.</b> The <see cref="OcrEngine"/>, the
/// <see cref="SoftwareBitmap"/> and the interop plumbing all live for the lifetime of the
/// service and are reused frame to frame; only the pixel copy and the recognition itself
/// happen per call. Allocating a bitmap per frame would be ~1MB of native memory per
/// tick, which is exactly the growth the 500-run acceptance criterion looks for.</para>
///
/// <para><b>Single-threaded by contract.</b> One <see cref="OcrEngine"/> is reused and
/// <see cref="Recognize"/> blocks on the async call, so two concurrent callers would
/// share one bitmap and race on its pixels. The capture loop's non-overlapping-tick
/// guarantee (<see cref="AdaptiveTimer"/>) is what makes that safe. Do not "parallelise"
/// this without giving each worker its own engine and bitmap.</para>
///
/// <para><b>No post-processing.</b> Spike S1 catalogued the recognizer's habitual
/// mistakes — <c>o</c>/<c>O</c>, <c>I</c>/<c>1</c>, dropped list numbers — and concluded
/// none of them change meaning. Nothing here tries to correct them: a guess that fires on
/// correct output corrupts it, and the translation stage is far more robust to a wrong
/// letter than to a wrong word.</para>
/// </summary>
public sealed class OcrService : IRecognizer, IDisposable
{
    /// <summary><c>error.code</c> when the requested recognizer cannot be created.</summary>
    public const string EngineUnavailableCode = "OCR_ENGINE_UNAVAILABLE";

    /// <summary><c>error.code</c> when a region is too large for the recognizer.</summary>
    public const string RegionTooLargeCode = "OCR_REGION_TOO_LARGE";

    private readonly OcrEngine engine;

    private SoftwareBitmap? bitmap;
    private int bitmapWidth;
    private int bitmapHeight;
    private bool disposed;

    private OcrService(OcrEngine engine, string languageTag)
    {
        this.engine = engine;
        LanguageTag = languageTag;
    }

    /// <summary>BCP-47 tag of the recognizer actually in use.</summary>
    public string LanguageTag { get; }

    /// <summary>
    /// Largest edge the recognizer accepts. A region past this is rejected up front rather
    /// than failing inside <c>RecognizeAsync</c> with a message that does not mention size.
    /// </summary>
    public static uint MaxImageDimension => OcrEngine.MaxImageDimension;

    /// <summary>
    /// Creates a recognizer for <paramref name="languageTag"/>.
    ///
    /// <para>Throws rather than returning null, and the message names the tag: reaching
    /// here with a missing recognizer means feature O8's preflight
    /// (<see cref="OcrPreflight"/>) either was not run or was satisfied by a primary-subtag
    /// match that the engine then refused. Both are worth saying out loud (invariant 4).</para>
    /// </summary>
    /// <exception cref="InvalidOperationException">No engine exists for that tag.</exception>
    public static OcrService Create(string languageTag)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(languageTag);

        OcrEngine? created;
        try
        {
            created = OcrEngine.TryCreateFromLanguage(new Language(languageTag));
        }
        catch (Exception ex)
        {
            // An unparseable BCP-47 tag throws out of the Language constructor rather
            // than returning null from TryCreate.
            throw new InvalidOperationException(
                $"\"{languageTag}\" is not a usable language tag: {ex.Message}", ex);
        }

        if (created is null)
        {
            var installed = string.Join(", ", OcrEngine.AvailableRecognizerLanguages.Select(l => l.LanguageTag));
            throw new InvalidOperationException(
                $"no OCR recognizer for \"{languageTag}\" (installed: {(installed.Length == 0 ? "none" : installed)})");
        }

        return new OcrService(created, created.RecognizerLanguage.LanguageTag);
    }

    /// <summary>
    /// Recognizes one captured region.
    /// </summary>
    /// <param name="bgra">BGRA8, tightly packed, <c>width * height * 4</c> bytes.</param>
    /// <param name="width">Region width in physical px.</param>
    /// <param name="height">Region height in physical px.</param>
    /// <returns>
    /// One entry per recognized line, in the recognizer's order. Empty when the region
    /// holds no text — which is a normal outcome, not an error (design doc section 7).
    /// Every <c>bbox</c> is physical px <b>relative to the region's top-left</b>: the
    /// recognizer works in the bitmap's own coordinates and the bitmap is the region, so
    /// there is no offset to add and no scale arithmetic anywhere (invariants 1 and 3).
    /// </returns>
    public WireLine[] Recognize(ReadOnlySpan<byte> bgra, int width, int height)
    {
        ObjectDisposedException.ThrowIf(disposed, this);

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

        var max = OcrEngine.MaxImageDimension;
        if (width > max || height > max)
        {
            throw new ArgumentException(
                $"region {width}x{height} exceeds the recognizer's maximum edge of {max}px",
                nameof(bgra));
        }

        var target = EnsureBitmap(width, height);
        CopyIntoBitmap(target, bgra);

        // Blocking on purpose. The caller is one tick of the capture loop, ticks never
        // overlap, and the alternative — an async pipeline through a timer callback —
        // buys nothing when the work is a single 22-36ms call that the tick has to wait
        // for regardless.
        var result = engine.RecognizeAsync(target).GetAwaiter().GetResult();

        return Project(result);
    }

    /// <summary>
    /// Converts the recognizer's output to the wire shape: one entry per line, its box the
    /// union of its word boxes.
    /// </summary>
    private static WireLine[] Project(OcrResult result)
    {
        var lines = new List<WireLine>(result.Lines.Count);

        foreach (var line in result.Lines)
        {
            if (line.Words.Count == 0)
            {
                // No words means no box, and a line that cannot be placed cannot be drawn
                // under anything. Dropping it is not noise filtering (that is Node's job,
                // M3-03) — it is declining to invent a position.
                continue;
            }

            lines.Add(new WireLine
            {
                Text = line.Text,
                Bbox = Union(line.Words),

                // Conf is deliberately left unset. Windows.Media.Ocr exposes no confidence
                // value on OcrResult, OcrLine or OcrWord — verified by reflection against
                // the projection this project builds on, and consistent with spike S1's
                // harness, which recorded text and bbox only. Emitting a constant here
                // would look like information and be read as "high confidence" by the two
                // features that consume it. An absent field is honest; see
                // OcrServiceTests.TheRecognizerReportsNoConfidence.
            });
        }

        return [.. lines];
    }

    /// <summary>
    /// The smallest integer rectangle containing every word box.
    ///
    /// <para>Word boxes come back as floating-point <see cref="Windows.Foundation.Rect"/>.
    /// The edges are rounded <b>outward</b> — floor the origin, ceil the far edge — so the
    /// box never crops a glyph it was supposed to contain. Rounding to nearest would shave
    /// up to half a pixel off each side, and the overlay anchors to these boxes.</para>
    /// </summary>
    private static Rect Union(IReadOnlyList<OcrWord> words)
    {
        var left = double.MaxValue;
        var top = double.MaxValue;
        var right = double.MinValue;
        var bottom = double.MinValue;

        foreach (var word in words)
        {
            var box = word.BoundingRect;
            left = Math.Min(left, box.X);
            top = Math.Min(top, box.Y);
            right = Math.Max(right, box.X + box.Width);
            bottom = Math.Max(bottom, box.Y + box.Height);
        }

        var x = (int)Math.Floor(left);
        var y = (int)Math.Floor(top);
        return new Rect(x, y, (int)Math.Ceiling(right) - x, (int)Math.Ceiling(bottom) - y);
    }

    /// <summary>
    /// Returns the reusable bitmap, rebuilding it only when the region changes size.
    /// </summary>
    private SoftwareBitmap EnsureBitmap(int width, int height)
    {
        if (bitmap is not null && bitmapWidth == width && bitmapHeight == height)
        {
            return bitmap;
        }

        bitmap?.Dispose();

        // Premultiplied rather than Ignore because it is the alpha mode the imaging stack
        // accepts everywhere without conversion. CopyIntoBitmap forces every alpha byte to
        // 255, which makes premultiplied and straight alpha identical, so the choice costs
        // nothing and avoids a format negotiation that can fail at runtime.
        bitmap = new SoftwareBitmap(BitmapPixelFormat.Bgra8, width, height, BitmapAlphaMode.Premultiplied);
        bitmapWidth = width;
        bitmapHeight = height;
        return bitmap;
    }

    /// <summary>
    /// Copies the captured pixels into the bitmap, forcing every alpha byte opaque.
    ///
    /// <para><b>The alpha forcing is load-bearing, not tidiness.</b> A Windows Graphics
    /// Capture surface's alpha channel is not meaningfully defined for desktop content — it
    /// reflects whatever composited the pixel — and regions of it are routinely zero.
    /// Handed to a premultiplied bitmap, a zero alpha means "fully transparent", and the
    /// recognizer would be asked to read a blank image and would correctly return nothing.
    /// That failure is silent, intermittent and looks exactly like "OCR found no text".</para>
    /// </summary>
    private static unsafe void CopyIntoBitmap(SoftwareBitmap target, ReadOnlySpan<byte> bgra)
    {
        using var buffer = target.LockBuffer(BitmapBufferAccessMode.Write);
        using var reference = buffer.CreateReference();

        var unknown = WinRT.MarshalInterface<Windows.Foundation.IMemoryBufferReference>.FromManaged(reference);
        try
        {
            var iid = NativeMethods.IidMemoryBufferByteAccess;
            NativeMethods.ThrowIfFailed(
                "QueryInterface(IMemoryBufferByteAccess)",
                NativeMethods.QueryInterface(unknown, ref iid, out var access));

            try
            {
                NativeMethods.ThrowIfFailed(
                    "IMemoryBufferByteAccess::GetBuffer",
                    NativeMethods.GetBuffer(access, out var destination, out var capacity));

                var plane = buffer.GetPlaneDescription(0);

                // Stride is the imaging stack's row pitch and is >= width * 4. Assuming
                // tight packing is the same shearing bug CaptureService guards against on
                // the D3D staging texture, with the same symptom: text that OCRs as
                // gibberish on some machines and fine on others.
                var rowBytes = plane.Width * 4;
                if (capacity < (uint)(plane.StartIndex + (plane.Stride * (plane.Height - 1)) + rowBytes))
                {
                    throw new InvalidOperationException(
                        $"SoftwareBitmap buffer is {capacity} bytes, too small for "
                        + $"{plane.Width}x{plane.Height} at stride {plane.Stride}");
                }

                for (var y = 0; y < plane.Height; y++)
                {
                    var source = bgra.Slice(y * rowBytes, rowBytes);
                    var row = new Span<byte>(destination + plane.StartIndex + ((long)y * plane.Stride), rowBytes);
                    source.CopyTo(row);

                    for (var x = 3; x < rowBytes; x += 4)
                    {
                        row[x] = 0xFF;
                    }
                }
            }
            finally
            {
                NativeMethods.Release(access);
            }
        }
        finally
        {
            NativeMethods.Release(unknown);
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        bitmap?.Dispose();
        bitmap = null;
    }
}
