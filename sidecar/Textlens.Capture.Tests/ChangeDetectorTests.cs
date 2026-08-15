using System.Diagnostics;
using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Issue M2-03. Everything here runs on synthetic BGRA buffers — the detector touches no
/// Windows API — so the acceptance criteria are pinned by arithmetic rather than by
/// arranging a screen.
///
/// <para>Two of the criteria are worded in a way that is trivially satisfiable without
/// testing anything real, and both are handled deliberately:</para>
/// <list type="bullet">
///   <item><b>"early exit, not a full scan"</b> is proven by <i>measurement</i>, twice
///   over — by sample count and by wall clock — never by pointing at the <c>return</c>
///   inside the loop. See <see cref="EarlyExit"/>.</item>
///   <item><b>"1% changed → false"</b> passes just as well against a detector that always
///   answers false. <see cref="OnePercentChanged_IsBelowTheDefaultThreshold_AndAboveATighterOne"/>
///   runs the identical buffer at two thresholds and demands the verdict flip, so the
///   assertion cannot be satisfied by a constant.</item>
/// </list>
/// </summary>
public class ChangeDetectorTests(Xunit.Abstractions.ITestOutputHelper output)
{
    /// <summary>The region the latency budget in design doc section 4 is quoted for.</summary>
    private const int Width = 1200;
    private const int Height = 200;

    // ------------------------------------------------------------------
    // Layer 1 — dimensions
    // ------------------------------------------------------------------

    [Fact]
    public void FirstFrame_IsAlwaysChanged_BecauseThereIsNothingToCompareAgainst()
    {
        var detector = new ChangeDetector();

        var result = detector.Compare(SolidFrame(Width, Height, 0x20), Width, Height);

        Assert.True(result.Changed);
        Assert.Equal(DiffReason.FirstFrame, result.Reason);
        Assert.True(detector.HasPrevious);
    }

    [Fact]
    public void DifferentBufferSize_IsChangedImmediately_WithoutScanning()
    {
        var detector = new ChangeDetector();
        detector.Compare(SolidFrame(Width, Height, 0x20), Width, Height);

        // Same total byte count, different shape: proves the check is on the dimensions
        // and not merely on the buffer length, which would let a region rotated from
        // 1200x200 to 200x1200 compare pixel-for-pixel against nonsense.
        var result = detector.Compare(SolidFrame(Height, Width, 0x20), Height, Width);

        Assert.True(result.Changed);
        Assert.Equal(DiffReason.DimensionChanged, result.Reason);
        // The acceptance criterion is "without scanning", so the sample counter must be
        // untouched — not merely small.
        Assert.Equal(0, result.SamplesExamined);
        Assert.Equal(0, result.SamplesPlanned);
    }

    [Fact]
    public void ResetForgetsThePreviousFrame_SoAMovedRegionIsNotComparedAgainstTheOldOne()
    {
        var detector = new ChangeDetector();
        var frame = SolidFrame(Width, Height, 0x20);
        detector.Compare(frame, Width, Height);

        detector.Reset();

        Assert.False(detector.HasPrevious);
        Assert.Equal(DiffReason.FirstFrame, detector.Compare(frame, Width, Height).Reason);
    }

    // ------------------------------------------------------------------
    // Layer 2 — byte equality, and the 2ms criterion
    // ------------------------------------------------------------------

    [Fact]
    public void IdenticalFrame_IsUnchanged_AndTakesUnderTwoMilliseconds()
    {
        var detector = new ChangeDetector();
        var frame = NoisyFrame(Width, Height, seed: 7);
        detector.Compare(frame, Width, Height);

        // Warm the code paths so the measurement is of the comparison rather than of
        // the JIT compiling it.
        for (var i = 0; i < 20; i++)
        {
            detector.Compare(frame, Width, Height);
        }

        var samples = new List<double>(50);
        for (var i = 0; i < 50; i++)
        {
            var stopwatch = Stopwatch.StartNew();
            var result = detector.Compare(frame, Width, Height);
            stopwatch.Stop();

            Assert.False(result.Changed);
            Assert.Equal(DiffReason.ByteIdentical, result.Reason);
            samples.Add(stopwatch.Elapsed.TotalMilliseconds);
        }

        samples.Sort();
        var p50 = samples[samples.Count / 2];
        var worst = samples[^1];

        output.WriteLine($"identical {Width}x{Height} frame: p50={p50:F4}ms worst={worst:F4}ms of a 2ms budget");

        // The criterion is < 2ms. Asserted on the worst of 50 rather than the median:
        // a detector that is usually fast and occasionally 5ms would blow the budget in
        // production while passing a median-based test.
        Assert.True(worst < 2.0, $"identical-frame diff p50={p50:F3}ms worst={worst:F3}ms, budget 2ms");
    }

    [Fact]
    public void AnUnchangedFrameStaysUnchangedAcrossManyRounds()
    {
        var detector = new ChangeDetector();
        var frame = NoisyFrame(Width, Height, seed: 11);

        detector.Compare(frame, Width, Height);
        for (var i = 0; i < 200; i++)
        {
            Assert.False(detector.Compare(frame, Width, Height).Changed);
        }
    }

    // ------------------------------------------------------------------
    // Layer 3 — threshold
    // ------------------------------------------------------------------

    /// <summary>
    /// The tautology check the "1% changed" criterion needs. One buffer, two thresholds,
    /// opposite verdicts: a detector hardcoded to <c>false</c> fails the second half, and
    /// one hardcoded to <c>true</c> fails the first.
    /// </summary>
    [Fact]
    public void OnePercentChanged_IsBelowTheDefaultThreshold_AndAboveATighterOne()
    {
        var baseline = NoisyFrame(Width, Height, seed: 3);
        var mutated = WithChangedFraction(baseline, Width, Height, 0.01);

        var lenient = new ChangeDetector { Threshold = 0.02 };
        lenient.Compare(baseline, Width, Height);
        var lenientResult = lenient.Compare(mutated, Width, Height);

        var strict = new ChangeDetector { Threshold = 0.005 };
        strict.Compare(baseline, Width, Height);
        var strictResult = strict.Compare(mutated, Width, Height);

        Assert.False(lenientResult.Changed);
        Assert.Equal(DiffReason.BelowThreshold, lenientResult.Reason);

        Assert.True(strictResult.Changed);
        Assert.Equal(DiffReason.AboveThreshold, strictResult.Reason);

        // And the sampled estimate actually resembles the 1% that was planted, rather
        // than the test passing on a stride that happened to miss everything.
        var estimated = (double)lenientResult.SamplesChanged / lenientResult.SamplesPlanned;
        Assert.InRange(estimated, 0.004, 0.02);
    }

    [Fact]
    public void HalfTheFrameChanged_IsChanged()
    {
        var baseline = NoisyFrame(Width, Height, seed: 5);
        var mutated = WithChangedFraction(baseline, Width, Height, 0.5);

        var detector = new ChangeDetector();
        detector.Compare(baseline, Width, Height);

        var result = detector.Compare(mutated, Width, Height);

        Assert.True(result.Changed);
        Assert.Equal(DiffReason.AboveThreshold, result.Reason);
    }

    [Theory]
    [InlineData(0.0, true)]     // "any movement at all counts"
    [InlineData(0.005, true)]
    [InlineData(0.02, false)]   // the protocol's own sample value
    [InlineData(1.0, false)]    // "nothing short of the whole frame counts"
    public void ThresholdIsSettable_AndDecidesTheSameBufferDifferently(double threshold, bool expected)
    {
        var baseline = NoisyFrame(Width, Height, seed: 13);
        var mutated = WithChangedFraction(baseline, Width, Height, 0.01);

        var detector = new ChangeDetector { Threshold = threshold };
        detector.Compare(baseline, Width, Height);

        Assert.Equal(expected, detector.Compare(mutated, Width, Height).Changed);
    }

    [Theory]
    [InlineData(-0.001)]
    [InlineData(1.001)]
    [InlineData(double.NaN)]
    public void AnImpossibleThresholdIsRejectedLoudly_RatherThanClamped(double threshold)
    {
        // Invariant 4: a `configure` carrying nonsense must be visible, not quietly
        // rounded into something that looks like it worked.
        Assert.Throws<ArgumentOutOfRangeException>(() => new ChangeDetector { Threshold = threshold });
    }

    [Fact]
    public void ABufferWhoseLengthContradictsItsDimensionsIsRejected()
    {
        var detector = new ChangeDetector();

        Assert.Throws<ArgumentException>(() => detector.Compare(new byte[100], Width, Height));
    }

    // ------------------------------------------------------------------
    // Tolerance
    // ------------------------------------------------------------------

    [Fact]
    public void PixelNoiseBelowTheChannelToleranceIsNotAChange()
    {
        var baseline = SolidFrame(Width, Height, 0x80);
        // Every single pixel moves, but only by ±1 per channel — decode and dither noise.
        var jittered = new byte[baseline.Length];
        for (var i = 0; i < baseline.Length; i++)
        {
            jittered[i] = (byte)(baseline[i] + (i % 2 == 0 ? 1 : -1));
        }

        var detector = new ChangeDetector();
        detector.Compare(baseline, Width, Height);

        var result = detector.Compare(jittered, Width, Height);

        // Not the byte-equal fast path — the buffers genuinely differ. Layer 3 has to be
        // the one that decides this, which is what makes the tolerance observable.
        Assert.Equal(DiffReason.BelowThreshold, result.Reason);
        Assert.False(result.Changed);
        Assert.Equal(0, result.SamplesChanged);
    }

    [Fact]
    public void AlphaOnlyMovementIsNotAChange_BecauseTheRecognizerCannotSeeIt()
    {
        var baseline = SolidFrame(Width, Height, 0x40);
        var alphaShifted = (byte[])baseline.Clone();
        for (var i = 3; i < alphaShifted.Length; i += 4)
        {
            alphaShifted[i] = 0x00;
        }

        var detector = new ChangeDetector();
        detector.Compare(baseline, Width, Height);

        var result = detector.Compare(alphaShifted, Width, Height);

        Assert.False(result.Changed);
        Assert.Equal(0, result.SamplesChanged);
    }

    // ------------------------------------------------------------------
    // Sampling — the aliasing trap
    // ------------------------------------------------------------------

    [Fact]
    public void StrideIsAlwaysCoprimeWithTheRowWidth()
    {
        // 1200 and 1920 are the widths this project actually captures at, and both are
        // rich in small factors — exactly the case a round stride aliases against.
        foreach (var width in new[] { 1200, 1920, 1080, 3440, 1366, 800 })
        {
            foreach (var height in new[] { 150, 200, 1080, 1440 })
            {
                var stride = ChangeDetector.StrideFor(width * height, width);
                Assert.True(
                    Gcd(stride, width) == 1,
                    $"stride {stride} shares a factor with width {width}: entire columns would never be sampled");
            }
        }
    }

    [Fact]
    public void DetectsAChangeConfinedToColumnsAStridedScanWouldMiss()
    {
        // The bug this pins: with width 1200 and the obvious stride of 4, sampling only
        // ever lands on columns 0, 4, 8, ... A subtitle occupying the other three columns
        // in four would be invisible and the region would read "static" forever.
        var baseline = SolidFrame(Width, Height, 0x10);
        var mutated = (byte[])baseline.Clone();

        var painted = 0;
        for (var y = 0; y < Height; y++)
        {
            for (var x = 1; x < Width; x += 4)
            {
                var offset = ((y * Width) + x) * 4;
                mutated[offset] = 0xF0;
                mutated[offset + 1] = 0xF0;
                mutated[offset + 2] = 0xF0;
                painted++;
            }
        }

        // A quarter of the frame, far above any sane threshold — if this reads as
        // unchanged it is the aliasing bug and nothing else.
        Assert.Equal(Width * Height / 4, painted);

        var detector = new ChangeDetector();
        detector.Compare(baseline, Width, Height);

        Assert.True(detector.Compare(mutated, Width, Height).Changed);
    }

    [Fact]
    public void SamplingCostIsFlatInRegionArea()
    {
        // The reason the stride is capped rather than fixed: layer 3 on a full display
        // must not cost proportionally more than layer 3 on a subtitle strip.
        var small = ChangeDetector.StrideFor(1200 * 200, 1200);
        var full = ChangeDetector.StrideFor(3440 * 1440, 3440);

        var smallSamples = ((1200 * 200) - 1) / small;
        var fullSamples = ((3440 * 1440) - 1) / full;

        Assert.True(fullSamples <= ChangeDetector.TargetSampleCount * 1.1, $"full-display scan plans {fullSamples} samples");
        Assert.True(smallSamples <= ChangeDetector.TargetSampleCount * 1.1, $"strip scan plans {smallSamples} samples");
    }

    // ------------------------------------------------------------------
    // Early exit — measured, not asserted from the source
    // ------------------------------------------------------------------

    /// <summary>
    /// The criterion is "true with early exit, not a full scan". A <c>break</c> in the
    /// source proves nothing, so this compares a wholly different frame against the case
    /// that is <i>forced</i> to scan everything: a frame changed by just under the
    /// threshold, which can never trip the early return.
    ///
    /// <para>The signature of a working early exit is that the comparison gets
    /// <b>faster as the frame gets more different</b> — the opposite of how a full scan
    /// behaves. Both the sample counter and the wall clock have to show it.</para>
    /// </summary>
    [Fact]
    public void EarlyExit()
    {
        var baseline = NoisyFrame(Width, Height, seed: 17);
        var whollyDifferent = NoisyFrame(Width, Height, seed: 18);
        // 1.5% against a 2% threshold: every sample gets read, and the verdict is still
        // "unchanged", so this is the full-scan cost with nothing else added.
        var justUnderThreshold = WithChangedFraction(baseline, Width, Height, 0.015);

        var detector = new ChangeDetector { Threshold = 0.02 };

        var fullScan = MeasureAgainst(detector, baseline, justUnderThreshold, out var fullScanResult);
        var earlyExit = MeasureAgainst(detector, baseline, whollyDifferent, out var earlyExitResult);

        Assert.Equal(DiffReason.BelowThreshold, fullScanResult.Reason);
        Assert.False(fullScanResult.Changed);
        Assert.Equal(DiffReason.AboveThreshold, earlyExitResult.Reason);
        Assert.True(earlyExitResult.Changed);

        output.WriteLine(
            $"forced full scan : {fullScan:F4}ms  {fullScanResult.SamplesExamined}/{fullScanResult.SamplesPlanned} samples read");
        output.WriteLine(
            $"early exit       : {earlyExit:F4}ms  {earlyExitResult.SamplesExamined}/{earlyExitResult.SamplesPlanned} samples read");
        output.WriteLine($"speedup          : {fullScan / earlyExit:F1}x on the more-different frame");

        // 1. By sample count. The full scan reads every planned sample; the early exit
        //    must stop at a small fraction of them.
        Assert.Equal(fullScanResult.SamplesPlanned, fullScanResult.SamplesExamined);
        Assert.True(
            earlyExitResult.SamplesExamined < fullScanResult.SamplesPlanned / 10,
            $"early exit read {earlyExitResult.SamplesExamined} of {fullScanResult.SamplesPlanned} planned samples");

        // 2. By wall clock. This is the half a `break` cannot fake: the more-different
        //    frame is the faster one.
        Assert.True(
            earlyExit < fullScan / 2,
            $"early exit {earlyExit:F4}ms vs forced full scan {fullScan:F4}ms "
            + $"({earlyExitResult.SamplesExamined} vs {fullScanResult.SamplesExamined} samples)");
    }

    /// <summary>
    /// Median wall-clock cost of comparing <paramref name="candidate"/> against
    /// <paramref name="baseline"/>, with the baseline re-established before each round so
    /// every measurement is of the same comparison.
    /// </summary>
    private static double MeasureAgainst(
        ChangeDetector detector,
        byte[] baseline,
        byte[] candidate,
        out DiffResult result)
    {
        for (var i = 0; i < 20; i++)
        {
            detector.Compare(baseline, Width, Height);
            detector.Compare(candidate, Width, Height);
        }

        var samples = new List<double>(60);
        result = default;
        for (var i = 0; i < 60; i++)
        {
            detector.Compare(baseline, Width, Height);

            var stopwatch = Stopwatch.StartNew();
            result = detector.Compare(candidate, Width, Height);
            stopwatch.Stop();

            samples.Add(stopwatch.Elapsed.TotalMilliseconds);
        }

        samples.Sort();
        return samples[samples.Count / 2];
    }

    /// <summary>
    /// The half of "capture + diff under 15ms" this component owns. The capture half is
    /// measured against real hardware by <c>--probe-capture</c> (p50 0.574ms).
    /// </summary>
    [Fact]
    public void WorstCaseDiffLeavesRoomInTheFifteenMillisecondBudget()
    {
        var baseline = NoisyFrame(Width, Height, seed: 23);
        // The most expensive input there is: differs from the baseline, so layer 2 cannot
        // decide it, and stays under the threshold, so layer 3 has to read every sample.
        var worstCase = WithChangedFraction(baseline, Width, Height, 0.015);

        var detector = new ChangeDetector();
        var median = MeasureAgainst(detector, baseline, worstCase, out var result);

        Assert.Equal(DiffReason.BelowThreshold, result.Reason);
        output.WriteLine(
            $"worst-case diff (every sample read, verdict unchanged): {median:F4}ms "
            + $"+ measured capture 0.574ms = {median + 0.574:F4}ms of the 15ms row");

        // 5ms of the shared 15ms row, leaving the measured 0.574ms capture and ample
        // headroom. This is a regression guard, not the budget itself.
        Assert.True(median < 5.0, $"worst-case diff {median:F3}ms of the 15ms capture+diff row");
    }

    // ------------------------------------------------------------------
    // Buffer helpers
    // ------------------------------------------------------------------

    private static byte[] SolidFrame(int width, int height, byte value)
    {
        var frame = new byte[width * height * 4];
        Array.Fill(frame, value);
        for (var i = 3; i < frame.Length; i += 4)
        {
            frame[i] = 0xFF;
        }

        return frame;
    }

    /// <summary>
    /// A frame of deterministic pseudo-random pixels. Noise rather than a flat colour so
    /// the byte-equality fast path is measured against realistic entropy, and seeded so a
    /// failure is reproducible.
    /// </summary>
    private static byte[] NoisyFrame(int width, int height, int seed)
    {
        var frame = new byte[width * height * 4];
        var random = new Random(seed);
        random.NextBytes(frame);
        for (var i = 3; i < frame.Length; i += 4)
        {
            frame[i] = 0xFF;
        }

        return frame;
    }

    /// <summary>
    /// Copies <paramref name="source"/> and moves exactly <paramref name="fraction"/> of
    /// its pixels well past the channel tolerance.
    ///
    /// <para>The changed pixels are spread evenly across the frame rather than clustered.
    /// A cluster would make the result depend on whether the stride happened to land in
    /// it, so the test would be measuring the placement rather than the threshold.</para>
    /// </summary>
    private static byte[] WithChangedFraction(byte[] source, int width, int height, double fraction)
    {
        var mutated = (byte[])source.Clone();
        var pixelCount = width * height;
        var toChange = (int)(pixelCount * fraction);
        if (toChange == 0)
        {
            return mutated;
        }

        var step = (double)pixelCount / toChange;
        for (var n = 0; n < toChange; n++)
        {
            var pixel = (int)(n * step);
            if (pixel >= pixelCount)
            {
                break;
            }

            var offset = pixel * 4;
            // XOR the high bit of each colour channel: a guaranteed delta of 128, far
            // above any tolerance, so the test is about the count and never about whether
            // an individual pixel registered.
            mutated[offset] ^= 0x80;
            mutated[offset + 1] ^= 0x80;
            mutated[offset + 2] ^= 0x80;
        }

        return mutated;
    }

    private static int Gcd(int a, int b)
    {
        while (b != 0)
        {
            (a, b) = (b, a % b);
        }

        return a;
    }
}
