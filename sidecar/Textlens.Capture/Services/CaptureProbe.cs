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
