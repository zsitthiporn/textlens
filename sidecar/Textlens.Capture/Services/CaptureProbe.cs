using System.Diagnostics;
using Textlens.Capture.Protocol;

namespace Textlens.Capture.Services;

/// <summary>
/// A diagnostic driver for the capture path, reachable from the command line.
///
/// <para>This exists because the acceptance criteria for M2-02 are empirical — a
/// latency distribution, a memory curve over 1000 frames, a capture from the display at
/// x = -1080 — and none of them can be established by a unit test on crop arithmetic.
/// The production command loop is M2-06 and is deliberately not built here; this is the
/// smallest thing that can drive real hardware.</para>
///
/// <para>Everything it prints goes to <b>stderr</b>, so stdout stays a clean protocol
/// stream, and it prints statistics only — never pixels. Whatever is on the user's
/// screen stays on the user's screen.</para>
/// </summary>
internal static class CaptureProbe
{
    /// <summary>Prints every display the way <c>listMonitors</c> will report it.</summary>
    public static int ListMonitors(TextWriter log)
    {
        // Reported first because every bounds line below is only trustworthy if this
        // says true: a DPI-unaware process is handed virtualized rectangles.
        log.WriteLine($"perMonitorDpiAwareV2={MonitorEnumerator.IsPerMonitorDpiAware()}");

        foreach (var descriptor in MonitorEnumerator.List())
        {
            var info = descriptor.Info;
            log.WriteLine(
                $"{info.Id,-16} bounds=[{info.Bounds.X},{info.Bounds.Y},{info.Bounds.Width},{info.Bounds.Height}] "
                + $"scale={info.Scale:0.##}{(descriptor.IsPrimary ? "  (primary)" : string.Empty)}");
        }

        return 0;
    }

    /// <summary>
    /// Captures <paramref name="frameCount"/> frames of <paramref name="region"/> from
    /// <paramref name="monitorId"/> and reports timings, memory and a content sanity
    /// check.
    /// </summary>
    public static int Run(TextWriter log, string monitorId, Rect region, int frameCount)
    {
        var target = MonitorEnumerator.Find(monitorId);
        if (target is null)
        {
            log.WriteLine($"no display named \"{monitorId}\". Known displays:");
            return ListMonitors(log) is 0 ? 2 : 2;
        }

        if (!CaptureService.IsSupported)
        {
            log.WriteLine("GraphicsCaptureSession.IsSupported() == false on this system");
            return 3;
        }

        using var capture = new CaptureService();
        capture.Open(target);

        log.WriteLine(
            $"display {target.Info.Id} surface={capture.SurfaceSize.Width}x{capture.SurfaceSize.Height} "
            + $"bounds=[{target.Info.Bounds.X},{target.Info.Bounds.Y},{target.Info.Bounds.Width},{target.Info.Bounds.Height}] "
            + $"scale={target.Info.Scale:0.##}");
        log.WriteLine($"region [{region.X},{region.Y},{region.Width},{region.Height}] frames={frameCount}");

        var timings = new List<long>(frameCount);
        var captured = 0;
        var starved = 0;
        var distinctPixelsFirst = 0;
        var wall = Stopwatch.StartNew();

        // Baseline after the session is up, so the sample series measures the steady
        // state rather than one-time start-up allocations.
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        SampleMemory(log, "start", 0);

        while (captured < frameCount)
        {
            if (!capture.WaitForFrame(TimeSpan.FromSeconds(2)))
            {
                starved++;
                if (starved > 10)
                {
                    log.WriteLine($"gave up after {captured} frames: no frame for 2s, 10 times over");
                    break;
                }

                continue;
            }

            var frame = capture.CaptureRegion(region);
            if (frame is null)
            {
                continue;
            }

            var value = frame.Value;
            timings.Add(value.CaptureMicroseconds);
            captured++;

            if (captured == 1)
            {
                // A solid black buffer would satisfy every timing and memory criterion
                // while proving nothing was captured. Counting distinct pixel values is
                // a cheap way to show real screen content arrived, without reporting or
                // storing any of it.
                distinctPixelsFirst = CountDistinctPixels(value.Pixels.Span);
                log.WriteLine(
                    $"first frame {value.Width}x{value.Height} bytes={value.Pixels.Length} "
                    + $"distinctPixelValues={distinctPixelsFirst}");
            }

            if (captured % 100 == 0)
            {
                SampleMemory(log, "frame", captured);
            }
        }

        wall.Stop();

        if (timings.Count == 0)
        {
            log.WriteLine("no frames captured");
            return 4;
        }

        SampleMemory(log, "end", captured);

        // The series above cannot by itself tell a leak from ordinary garbage: the Gen0
        // budget is large enough that a 17-second run may never trigger a collection, so
        // uncollected garbage looks exactly like a leak on the managed line. Collecting
        // and re-sampling separates them — if the managed number returns to its
        // baseline, nothing was retained.
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        SampleMemory(log, "afterGC", captured);

        timings.Sort();
        log.WriteLine(
            $"captured={captured} in {wall.ElapsedMilliseconds}ms "
            + $"({captured * 1000.0 / Math.Max(1, wall.ElapsedMilliseconds):0.0} fps, "
            + $"frame supply not capture cost)");
        log.WriteLine(
            $"capture+crop us: p50={Percentile(timings, 0.50)} p95={Percentile(timings, 0.95)} "
            + $"p99={Percentile(timings, 0.99)} min={timings[0]} max={timings[^1]}");
        log.WriteLine(
            $"capture+crop ms: p50={Percentile(timings, 0.50) / 1000.0:0.000} "
            + $"p95={Percentile(timings, 0.95) / 1000.0:0.000}");

        return 0;
    }

    /// <summary>
    /// Spike S2 instrument. Captures <paramref name="frameCount"/> frames of
    /// <paramref name="region"/> and reports, for each colour the caller names, how much
    /// of the region that colour covers.
    ///
    /// <para><b>Why only named colours.</b> The question S2 asks is "is the exact value we
    /// painted on the overlay present in what WGC hands us". Counting arbitrary colours
    /// would mean reporting the user's screen; counting only the values the experiment
    /// itself painted keeps the rule that no screen content leaves this process.
    /// <c>dominant</c> is the one exception and is a diagnostic: it is printed only when a
    /// single value covers most of the region, which under this experiment's construction
    /// is a value we painted.</para>
    ///
    /// <para><b>Why a series and not one frame.</b> A single frame cannot be told apart
    /// from a stale one. Reporting min/max/last across N frames, plus how many frames the
    /// colour dominated, makes a "the overlay was simply never there" explanation visible
    /// instead of indistinguishable from success.</para>
    /// </summary>
    /// <param name="colors">0xRRGGBB values; alpha is ignored, WGC's alpha channel is not meaningful here.</param>
    /// <param name="tolerance">Per-channel slack for the "near" counts, absorbing any colour management on the way to the screen.</param>
    public static int ProbeColors(
        TextWriter log,
        string monitorId,
        Rect region,
        int frameCount,
        uint[] colors,
        int tolerance)
    {
        var target = MonitorEnumerator.Find(monitorId);
        if (target is null)
        {
            log.WriteLine($"no display named \"{monitorId}\". Known displays:");
            ListMonitors(log);
            return 2;
        }

        if (!CaptureService.IsSupported)
        {
            log.WriteLine("GraphicsCaptureSession.IsSupported() == false on this system");
            return 3;
        }

        using var capture = new CaptureService();
        capture.Open(target);

        log.WriteLine(
            $"probe-colors monitor={target.Info.Id} region=[{region.X},{region.Y},{region.Width},{region.Height}] "
            + $"frames={frameCount} tolerance={tolerance} surface={capture.SurfaceSize.Width}x{capture.SurfaceSize.Height}");

        var exact = new double[colors.Length];
        var near = new double[colors.Length];
        var exactMin = new double[colors.Length];
        var exactMax = new double[colors.Length];
        var nearMin = new double[colors.Length];
        var nearMax = new double[colors.Length];
        var framesOverHalf = new int[colors.Length];
        Array.Fill(exactMin, 1.0);
        Array.Fill(nearMin, 1.0);

        var captured = 0;
        var starved = 0;
        uint dominantValue = 0;
        var dominantShare = 0.0;

        while (captured < frameCount)
        {
            if (!capture.WaitForFrame(TimeSpan.FromSeconds(2)))
            {
                starved++;
                if (starved > 5)
                {
                    log.WriteLine($"starved: only {captured} frames; the screen is not changing");
                    break;
                }

                continue;
            }

            var frame = capture.CaptureRegion(region);
            if (frame is null)
            {
                continue;
            }

            var value = frame.Value;
            var pixels = value.Width * (long)value.Height;
            if (pixels == 0)
            {
                continue;
            }

            var span = value.Pixels.Span;
            for (var c = 0; c < colors.Length; c++)
            {
                Count(span, colors[c], tolerance, out var exactHits, out var nearHits);
                exact[c] = exactHits / (double)pixels;
                near[c] = nearHits / (double)pixels;
                exactMin[c] = Math.Min(exactMin[c], exact[c]);
                exactMax[c] = Math.Max(exactMax[c], exact[c]);
                nearMin[c] = Math.Min(nearMin[c], near[c]);
                nearMax[c] = Math.Max(nearMax[c], near[c]);
                if (near[c] > 0.5)
                {
                    framesOverHalf[c]++;
                }
            }

            (dominantValue, dominantShare) = Dominant(span, pixels);
            captured++;
        }

        if (captured == 0)
        {
            log.WriteLine("no frames captured");
            return 4;
        }

        log.WriteLine($"frames captured={captured} starved={starved}");
        for (var c = 0; c < colors.Length; c++)
        {
            log.WriteLine(
                $"color {colors[c]:X6} exact last={exact[c]:0.0000} min={exactMin[c]:0.0000} max={exactMax[c]:0.0000}"
                + $" | near last={near[c]:0.0000} min={nearMin[c]:0.0000} max={nearMax[c]:0.0000}"
                + $" | framesOver50={framesOverHalf[c]}/{captured}");
        }

        // Only when one value owns the region, which by this experiment's construction is
        // a value the experiment painted. Below that it stays unreported.
        log.WriteLine(dominantShare >= 0.80
            ? $"dominant {dominantValue:X6} share={dominantShare:0.0000}"
            : $"dominant (region is not uniform; share={dominantShare:0.0000}, value withheld)");

        return 0;
    }

    /// <summary>Exact and within-tolerance hits for one 0xRRGGBB value over a BGRA buffer.</summary>
    private static void Count(ReadOnlySpan<byte> bgra, uint rgb, int tolerance, out long exact, out long near)
    {
        var r = (byte)(rgb >> 16);
        var g = (byte)(rgb >> 8);
        var b = (byte)rgb;

        exact = 0;
        near = 0;

        for (var i = 0; i + 3 < bgra.Length; i += 4)
        {
            var pb = bgra[i];
            var pg = bgra[i + 1];
            var pr = bgra[i + 2];

            if (pb == b && pg == g && pr == r)
            {
                exact++;
                near++;
                continue;
            }

            if (Math.Abs(pb - b) <= tolerance && Math.Abs(pg - g) <= tolerance && Math.Abs(pr - r) <= tolerance)
            {
                near++;
            }
        }
    }

    /// <summary>Most common 0xRRGGBB value in the buffer and the share of the region it covers.</summary>
    private static (uint Value, double Share) Dominant(ReadOnlySpan<byte> bgra, long pixels)
    {
        var counts = new Dictionary<uint, int>(1024);
        for (var i = 0; i + 3 < bgra.Length; i += 4)
        {
            var rgb = (uint)((bgra[i + 2] << 16) | (bgra[i + 1] << 8) | bgra[i]);
            counts.TryGetValue(rgb, out var n);
            counts[rgb] = n + 1;
            if (counts.Count > 200_000)
            {
                break;
            }
        }

        uint best = 0;
        var bestCount = 0;
        foreach (var pair in counts)
        {
            if (pair.Value > bestCount)
            {
                best = pair.Key;
                bestCount = pair.Value;
            }
        }

        return (best, bestCount / (double)pixels);
    }

    private static long Percentile(List<long> sorted, double q)
    {
        var index = (int)Math.Ceiling(q * sorted.Count) - 1;
        return sorted[Math.Clamp(index, 0, sorted.Count - 1)];
    }

    private static void SampleMemory(TextWriter log, string label, int frame)
    {
        using var process = Process.GetCurrentProcess();
        log.WriteLine(
            $"mem {label,-6} frame={frame,5} managed={GC.GetTotalMemory(false) / 1024,7}KB "
            + $"workingSet={process.WorkingSet64 / 1024,8}KB "
            + $"gc0={GC.CollectionCount(0)} gc1={GC.CollectionCount(1)} gc2={GC.CollectionCount(2)}");
    }

    /// <summary>
    /// Number of distinct BGRA values in the buffer, capped so a large region does not
    /// turn the sanity check into the slowest part of the probe.
    /// </summary>
    private static int CountDistinctPixels(ReadOnlySpan<byte> bgra)
    {
        var seen = new HashSet<uint>();
        for (var i = 0; i + 3 < bgra.Length && seen.Count < 4096; i += 4)
        {
            seen.Add((uint)(bgra[i] | (bgra[i + 1] << 8) | (bgra[i + 2] << 16) | (bgra[i + 3] << 24)));
        }

        return seen.Count;
    }
}
