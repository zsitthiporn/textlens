using System.Runtime.InteropServices;

namespace Textlens.Capture.Services;

/// <summary>Why <see cref="ChangeDetector"/> reached the verdict it did.</summary>
public enum DiffReason
{
    /// <summary>Nothing to compare against yet. Always counts as changed.</summary>
    FirstFrame,

    /// <summary>The region changed size, so a pixel comparison is meaningless. Layer 1.</summary>
    DimensionChanged,

    /// <summary>Every byte matched. Layer 2, the fast path. Unchanged.</summary>
    ByteIdentical,

    /// <summary>Sampling completed and too few pixels moved. Layer 3. Unchanged.</summary>
    BelowThreshold,

    /// <summary>Sampling stopped early — enough pixels had already moved. Layer 3. Changed.</summary>
    AboveThreshold,
}

/// <summary>
/// The outcome of one comparison.
///
/// <para><see cref="SamplesExamined"/> against <see cref="SamplesPlanned"/> is what makes
/// the early exit an observable fact rather than a claim about a <c>break</c> statement:
/// on a wholly different frame the first is a small fraction of the second.</para>
/// </summary>
/// <param name="Changed">Whether the caller should run OCR.</param>
/// <param name="Reason">Which of the three layers decided, and how.</param>
/// <param name="SamplesExamined">Sampled pixels actually read. 0 when layers 1-2 decided.</param>
/// <param name="SamplesPlanned">Sampled pixels a full scan would have read.</param>
/// <param name="SamplesChanged">Sampled pixels whose colour moved past the tolerance.</param>
public readonly record struct DiffResult(
    bool Changed,
    DiffReason Reason,
    int SamplesExamined,
    int SamplesPlanned,
    int SamplesChanged);

/// <summary>
/// Feature C3 — decides whether a freshly captured region differs enough from the
/// previous one to be worth an OCR pass. This is the component that lets auto mode idle
/// without burning a core: OCR is 22-36ms (spike S1) and everything below is microseconds.
///
/// <para><b>Three layers, cheapest first</b> (design doc section 4, issue M2-03):</para>
/// <list type="number">
///   <item><b>Dimension.</b> A different width or height means the buffers are not
///   comparable at all. Decided before a single byte is read.</item>
///   <item><b>Byte equality.</b> <see cref="MemoryExtensions.SequenceEqual{T}(ReadOnlySpan{T}, ReadOnlySpan{T})"/>
///   is vectorised, so proving a ~1MB region identical costs tens of microseconds. This
///   is the common case on a static screen and it is the one that has to be nearly free.</item>
///   <item><b>Sampled RGB delta.</b> Every Nth pixel, per-channel tolerance, and an early
///   return the moment enough pixels have moved.</item>
/// </list>
///
/// <para><b>Why the detector keeps its own copy of the previous frame.</b>
/// <see cref="CapturedRegion.Pixels"/> is documented as a slice of a buffer
/// <see cref="CaptureService"/> reuses — valid only until the next capture. Holding that
/// span would mean comparing a frame against itself and reporting "unchanged" forever,
/// which is a bug that looks exactly like working software. The copy costs one memcpy
/// per frame against a 15ms budget.</para>
///
/// <para><b>No Windows API, no WinRT, no GPU.</b> Deliberately: every acceptance
/// criterion here is about arithmetic on a byte array, so all of it is reachable from a
/// unit test with synthetic buffers instead of from a screen someone has to arrange.</para>
/// </summary>
public sealed class ChangeDetector
{
    /// <summary>
    /// Fraction of sampled pixels that must move before a frame counts as changed.
    /// Matches the <c>diffThreshold</c> in the protocol's own <c>configure</c> sample.
    /// </summary>
    public const double DefaultThreshold = 0.02;

    /// <summary>
    /// Per-channel delta a pixel must exceed to count as moved, 0-255.
    ///
    /// <para>Not zero, because a frame can differ by ±1 per channel without anything
    /// having happened that OCR would read differently: video decode, GPU dither and
    /// subpixel antialiasing all wobble at that amplitude. Counting those would keep the
    /// pipeline permanently "active" on a paused video, which is precisely the CPU cost
    /// feature C3 exists to avoid. Small enough that real text appearing — near-full-range
    /// contrast — clears it by an order of magnitude.</para>
    /// </summary>
    public const int DefaultChannelTolerance = 8;

    /// <summary>
    /// Sampled pixels a full scan aims for, regardless of how large the region is.
    ///
    /// <para>A fixed stride would make the diff cost scale with area: a full 3440x1440
    /// display at every 4th pixel is 1.2M samples, which starts to matter against a 15ms
    /// budget shared with capture. Capping the sample count instead keeps layer 3 flat,
    /// and 65,536 samples estimate a 2% threshold with a sampling error well under a
    /// tenth of that.</para>
    /// </summary>
    public const int TargetSampleCount = 65536;

    /// <summary>
    /// Floor on the stride, so a small region still skips most of its pixels.
    /// A region below <c>MinimumStride * TargetSampleCount</c> pixels is cheap either way.
    /// </summary>
    public const int MinimumStride = 4;

    private byte[] previous = [];
    private int previousLength;
    private int previousWidth;
    private int previousHeight;
    private bool hasPrevious;

    private double threshold = DefaultThreshold;
    private int channelTolerance = DefaultChannelTolerance;

    /// <summary>
    /// Fraction of sampled pixels (0..1) above which a frame counts as changed. Settable
    /// at any time from <c>configure</c>; M8 tightens it while the region is unlocked.
    /// </summary>
    /// <exception cref="ArgumentOutOfRangeException">Outside 0..1, or not a number.</exception>
    public double Threshold
    {
        get => threshold;
        set
        {
            if (double.IsNaN(value) || value < 0 || value > 1)
            {
                throw new ArgumentOutOfRangeException(
                    nameof(value),
                    value,
                    "diffThreshold is a fraction of pixels and must be within 0..1");
            }

            threshold = value;
        }
    }

    /// <summary>Per-channel delta a pixel must exceed to count as moved, 0-255.</summary>
    /// <exception cref="ArgumentOutOfRangeException">Outside 0..255.</exception>
    public int ChannelTolerance
    {
        get => channelTolerance;
        set
        {
            if (value < 0 || value > 255)
            {
                throw new ArgumentOutOfRangeException(nameof(value), value, "a channel delta is 0..255");
            }

            channelTolerance = value;
        }
    }

    /// <summary>Whether a previous frame is being held to compare against.</summary>
    public bool HasPrevious => hasPrevious;

    /// <summary>
    /// The most recently compared frame, still in the buffer this detector retains as its
    /// diff baseline. Empty until the first <see cref="Compare"/>.
    ///
    /// <para>Exposed because it is also <i>the newest pixels anyone has</i>, and
    /// <c>snapshot</c> needs them: on a static display Windows Graphics Capture stops
    /// delivering frames entirely (spike S2 measured 3 frames in 13 seconds), so a
    /// snapshot arriving during a quiet stretch has nothing fresh to work with and must
    /// fall back to this. The alternative — a second full copy kept by the capture loop —
    /// is another megabyte and another memcpy per tick for a buffer that already exists.</para>
    ///
    /// <para>Valid until the next <see cref="Compare"/>, like every other buffer on this
    /// path.</para>
    /// </summary>
    public ReadOnlySpan<byte> Previous => previous.AsSpan(0, previousLength);

    /// <summary>Width of <see cref="Previous"/> in physical px; 0 when there is none.</summary>
    public int PreviousWidth => previousWidth;

    /// <summary>Height of <see cref="Previous"/> in physical px; 0 when there is none.</summary>
    public int PreviousHeight => previousHeight;

    /// <summary>
    /// Forgets the previous frame, so the next comparison reports
    /// <see cref="DiffReason.FirstFrame"/>.
    ///
    /// Called when the region or monitor changes: the old frame is not merely stale, it is
    /// a picture of somewhere else, and comparing against it would report "unchanged" for
    /// a region the user just moved.
    /// </summary>
    public void Reset()
    {
        hasPrevious = false;
        previousLength = 0;
        previousWidth = 0;
        previousHeight = 0;
    }

    /// <summary>
    /// Compares <paramref name="current"/> against the previously supplied frame and then
    /// retains it as the new baseline.
    ///
    /// <para>The baseline is updated on every call including the unchanged ones. That
    /// matters: retaining only on change would compare each frame against an ever older
    /// one, so a slow fade would accumulate until it tripped the threshold in a single
    /// step — the detector would report a sudden change to something that never suddenly
    /// changed.</para>
    /// </summary>
    /// <param name="current">BGRA8, tightly packed, <c>width * height * 4</c> bytes.</param>
    /// <param name="width">Region width in physical px.</param>
    /// <param name="height">Region height in physical px.</param>
    /// <exception cref="ArgumentException">The buffer length does not match the dimensions.</exception>
    public DiffResult Compare(ReadOnlySpan<byte> current, int width, int height)
    {
        if (width <= 0 || height <= 0)
        {
            throw new ArgumentException($"a frame cannot be {width}x{height}", nameof(width));
        }

        var expected = checked(width * height * 4);
        if (current.Length != expected)
        {
            throw new ArgumentException(
                $"a {width}x{height} BGRA frame is {expected} bytes, got {current.Length}",
                nameof(current));
        }

        var result = Classify(current, width, height);
        Retain(current, width, height);
        return result;
    }

    private DiffResult Classify(ReadOnlySpan<byte> current, int width, int height)
    {
        if (!hasPrevious)
        {
            return new DiffResult(true, DiffReason.FirstFrame, 0, 0, 0);
        }

        // Layer 1. Deliberately before any read of either buffer: this is the branch the
        // acceptance criterion calls out as "true immediately without scanning".
        if (width != previousWidth || height != previousHeight)
        {
            return new DiffResult(true, DiffReason.DimensionChanged, 0, 0, 0);
        }

        var earlier = previous.AsSpan(0, previousLength);

        // Layer 2. Vectorised, and it also short-circuits on the first differing vector,
        // so it is cheap for both of its outcomes rather than only for the equal one.
        if (current.SequenceEqual(earlier))
        {
            return new DiffResult(false, DiffReason.ByteIdentical, 0, 0, 0);
        }

        return SampledDiff(current, earlier, width, height);
    }

    /// <summary>Layer 3: every Nth pixel, per-channel delta, early return once over budget.</summary>
    private DiffResult SampledDiff(ReadOnlySpan<byte> current, ReadOnlySpan<byte> earlier, int width, int height)
    {
        var pixelCount = width * height;
        var stride = StrideFor(pixelCount, width);

        // Ceiling division: index 0 is sampled, so a run of `stride` pixels yields one.
        var planned = ((pixelCount - 1) / stride) + 1;

        // Strictly "above the threshold", matching the field's own wording. With a
        // threshold of 0 that makes a single moved pixel enough, which is the sensible
        // reading of "changed at all".
        var budget = (int)(threshold * planned);

        var now = MemoryMarshal.Cast<byte, uint>(current);
        var before = MemoryMarshal.Cast<byte, uint>(earlier);

        var tolerance = channelTolerance;
        var changed = 0;
        var examined = 0;

        for (var i = 0; i < pixelCount; i += stride)
        {
            examined++;

            var a = now[i];
            var b = before[i];

            // The overwhelmingly common case on a mostly-static region, and it skips the
            // three channel subtractions entirely.
            if (a == b)
            {
                continue;
            }

            if (ExceedsTolerance(a, b, tolerance))
            {
                changed++;
                if (changed > budget)
                {
                    // The early exit. On a wholly different frame this fires after roughly
                    // `budget` samples out of `planned` — for the default 2% threshold,
                    // one sample in fifty.
                    return new DiffResult(true, DiffReason.AboveThreshold, examined, planned, changed);
                }
            }
        }

        return new DiffResult(false, DiffReason.BelowThreshold, examined, planned, changed);
    }

    /// <summary>
    /// Whether two BGRA pixels differ by more than <paramref name="tolerance"/> on any
    /// colour channel.
    ///
    /// <para>Alpha is excluded on purpose. A WGC surface's alpha channel is not
    /// meaningfully defined for a desktop capture — it varies with what composited the
    /// pixel — and it is invisible to the recognizer, so letting it drive the diff would
    /// wake the pipeline for something OCR cannot see.</para>
    /// </summary>
    private static bool ExceedsTolerance(uint a, uint b, int tolerance)
    {
        // BGRA in memory is little-endian 0xAARRGGBB once read as a uint.
        var deltaB = Math.Abs((int)(a & 0xFF) - (int)(b & 0xFF));
        var deltaG = Math.Abs((int)((a >> 8) & 0xFF) - (int)((b >> 8) & 0xFF));
        var deltaR = Math.Abs((int)((a >> 16) & 0xFF) - (int)((b >> 16) & 0xFF));

        return deltaB > tolerance || deltaG > tolerance || deltaR > tolerance;
    }

    /// <summary>
    /// Picks the sampling stride: large enough to hit the sample budget, and coprime with
    /// the row width.
    ///
    /// <para><b>The coprime part is load-bearing and is not a micro-optimisation.</b>
    /// Sampling walks a linear pixel index, so if <c>gcd(stride, width) = g</c> the walk
    /// only ever visits <c>width / g</c> distinct columns — the same ones on every row.
    /// The obvious stride of 4 against a 1200px-wide region shares a factor of 4, so three
    /// columns in every four would never be looked at, and a subtitle that happened to
    /// land on them would read as "no change" forever. Stepping the stride up until it is
    /// coprime makes the walk cover a full residue system, so every column is reachable.
    /// This is what <c>DetectsAChangeConfinedToColumnsAStridedScanWouldMiss</c> pins.</para>
    /// </summary>
    public static int StrideFor(int pixelCount, int width)
    {
        if (pixelCount <= TargetSampleCount)
        {
            // Small enough that sampling would save nothing worth the aliasing risk.
            return 1;
        }

        var stride = Math.Max(MinimumStride, pixelCount / TargetSampleCount);

        // Bounded: consecutive integers cannot share a factor, so this runs at most twice
        // for any width, and never past the point where sampling stops being sampling.
        while (stride < pixelCount && GreatestCommonDivisor(stride, width) != 1)
        {
            stride++;
        }

        return stride;
    }

    private static int GreatestCommonDivisor(int a, int b)
    {
        while (b != 0)
        {
            (a, b) = (b, a % b);
        }

        return a;
    }

    /// <summary>
    /// Copies the frame in as the new baseline, reusing the array whenever it already
    /// fits — which is every frame once the region settles.
    /// </summary>
    private void Retain(ReadOnlySpan<byte> current, int width, int height)
    {
        if (previous.Length < current.Length)
        {
            previous = new byte[current.Length];
        }

        current.CopyTo(previous);
        previousLength = current.Length;
        previousWidth = width;
        previousHeight = height;
        hasPrevious = true;
    }
}
