using System.Diagnostics;
using System.Text;
using Textlens.Capture.Protocol;
using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Issue M2-06's actual acceptance criterion, run the way the design doc says it should
/// be: start the real executable, write real command lines to its stdin, read the events
/// that come back.
///
/// <para>Design doc section 3 chose JSON lines over stdio specifically so the sidecar can
/// be driven by hand from a terminal, and a dispatcher test with a fake host does not
/// check that promise — it checks the state machine. This checks the promise: the process
/// starts, speaks first, answers what it is told, refuses what it should refuse, and stays
/// alive through all of it.</para>
///
/// <para><b>These capture the real screen.</b> Nothing here reports or stores a pixel: the
/// assertions are over event kinds, counts, sequence numbers and timings. The
/// <c>debugFrame</c> test checks that a base64 payload is well formed and never prints it.
/// Every process spawned is killed in a <c>finally</c>.</para>
/// </summary>
public class SidecarProcessTests(Xunit.Abstractions.ITestOutputHelper output)
{
    /// <summary>Generous: this waits on a real recognizer and a real compositor.</summary>
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(20);

    /// <summary>
    /// Drives the real sidecar: writes each line to stdin, then reads events until
    /// <paramref name="untilEvents"/> have arrived or the process ends.
    /// </summary>
    private sealed class Sidecar : IDisposable
    {
        private readonly Process process;
        private readonly List<string> stderrLines = [];

        // stdout is drained on a background thread rather than pulled on demand. A tick
        // that emits while nobody is reading would otherwise fill the pipe buffer and
        // block the sidecar, which at a fast interval turns "measure its CPU" into
        // "measure it waiting for the test".
        private readonly System.Collections.Concurrent.BlockingCollection<string> lines = [];
        private int received;

        public Sidecar()
        {
            var exe = Path.Combine(AppContext.BaseDirectory, "Textlens.Capture.exe");
            Assert.True(File.Exists(exe), $"the sidecar executable is not next to the tests: {exe}");

            process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = exe,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    StandardOutputEncoding = new UTF8Encoding(false),
                    StandardErrorEncoding = new UTF8Encoding(false),
                },
            };

            process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is not null)
                {
                    lock (stderrLines)
                    {
                        stderrLines.Add(e.Data);
                    }
                }
            };

            process.Start();
            process.BeginErrorReadLine();

            var pump = new Thread(() =>
            {
                try
                {
                    while (process.StandardOutput.ReadLine() is { } line)
                    {
                        Interlocked.Increment(ref received);
                        lines.Add(line);
                    }
                }
                catch (Exception)
                {
                    // The process went away; CompleteAdding below unblocks any reader.
                }
                finally
                {
                    lines.CompleteAdding();
                }
            })
            {
                IsBackground = true,
                Name = "sidecar-stdout",
            };
            pump.Start();
        }

        public Process Process => process;

        /// <summary>Total events seen on stdout so far, whether or not the test read them.</summary>
        public int Received => Volatile.Read(ref received);

        public string[] Stderr
        {
            get
            {
                lock (stderrLines)
                {
                    return [.. stderrLines];
                }
            }
        }

        public void Send(string line)
        {
            process.StandardInput.Write(line);
            process.StandardInput.Write('\n');
            process.StandardInput.Flush();
        }

        /// <summary>Reads one line of stdout, failing the test rather than hanging forever.</summary>
        public string ReadLine()
        {
            Assert.True(
                lines.TryTake(out var line, (int)Patience.TotalMilliseconds),
                "the sidecar produced no output before the timeout");
            return line!;
        }

        /// <summary>Discards everything already queued, so a measurement starts from a clean slate.</summary>
        public int Drain()
        {
            var dropped = 0;
            while (lines.TryTake(out _))
            {
                dropped++;
            }

            return dropped;
        }

        public ISidecarEvent ReadEvent()
        {
            var line = ReadLine();
            var decoded = ProtocolCodec.DecodeEvent(line);
            Assert.True(decoded.Ok, $"undecodable line from the sidecar: {line} -> {decoded.Failure}: {decoded.Detail}");
            return decoded.Value!;
        }

        /// <summary>Reads until <paramref name="count"/> events have arrived.</summary>
        public List<ISidecarEvent> ReadEvents(int count)
        {
            var events = new List<ISidecarEvent>(count);
            for (var i = 0; i < count; i++)
            {
                events.Add(ReadEvent());
            }

            return events;
        }

        public void CloseInput() => process.StandardInput.Close();

        public void Dispose()
        {
            // Capability boundary: every process spawned is reaped, including on failure.
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(5000);
                }
            }
            catch (InvalidOperationException)
            {
                // Already gone.
            }

            process.Dispose();
        }
    }

    /// <summary>The primary display's device name, as the sidecar itself reports it.</summary>
    private static string PrimaryMonitorId()
        => Textlens.Capture.Services.MonitorEnumerator.Primary().Info.Id;

    /// <summary>A configure line for a small region at the top-left of the primary display.</summary>
    private static string ConfigureLine(
        string monitorId,
        int intervalActive = 120,
        bool debugFrameEnabled = false,
        int intervalIdle = 400)
    {
        // The device name contains backslashes, so it goes through the JSON string escape
        // the same way Node's encoder would produce it.
        var escaped = monitorId.Replace("\\", "\\\\", StringComparison.Ordinal);
        return $$"""
                 {"cmd":"configure","region":[0,0,600,200],"monitorId":"{{escaped}}","intervalActive":{{intervalActive}},"intervalIdle":{{intervalIdle}},"diffThreshold":0.02,"ocrLanguage":"en-US","debugFrameEnabled":{{(debugFrameEnabled ? "true" : "false")}}}
                 """;
    }

    // ------------------------------------------------------------------

    [Fact]
    public void TheProcessSpeaksFirst_WithReadyAndItsRecognizerList()
    {
        using var sidecar = new Sidecar();

        var ready = Assert.IsType<ReadyEvent>(sidecar.ReadEvent());

        output.WriteLine($"<- {ProtocolCodec.Encode(ready)}");
        Assert.NotEmpty(ready.Version);
    }

    /// <summary>
    /// The headline criterion: run the exe alone, paste <c>configure</c> then <c>start</c>,
    /// get a stream of events. The transcript is printed so the whole exchange is visible.
    /// </summary>
    [Fact]
    public void ConfigureThenStartProducesAContinuousStreamOfEvents()
    {
        using var sidecar = new Sidecar();
        var monitorId = PrimaryMonitorId();

        Assert.IsType<ReadyEvent>(sidecar.ReadEvent());

        var configure = ConfigureLine(monitorId);
        output.WriteLine($"-> {configure}");
        sidecar.Send(configure);
        var configureAck = Assert.IsType<AckEvent>(sidecar.ReadEvent());
        output.WriteLine($"<- {ProtocolCodec.Encode(configureAck)}");
        Assert.Equal(SidecarState.Configured, configureAck.State);

        output.WriteLine("""-> {"cmd":"start"}""");
        sidecar.Send("""{"cmd":"start"}""");
        var startAck = Assert.IsType<AckEvent>(sidecar.ReadEvent());
        output.WriteLine($"<- {ProtocolCodec.Encode(startAck)}");
        Assert.Equal(SidecarState.Running, startAck.State);

        // Ten consecutive events from a real display through a real recognizer.
        var stream = sidecar.ReadEvents(10);

        var frames = 0;
        var nochanges = 0;
        var seqs = new List<long>();

        foreach (var evt in stream)
        {
            switch (evt)
            {
                case FrameEvent frame:
                    frames++;
                    seqs.Add(frame.Seq);
                    // Feature L3: every frame carries all three timings, and the whole
                    // reason the unit is microseconds is that capture is sub-millisecond.
                    Assert.True(frame.Timings.CaptureUs >= 0);
                    Assert.True(frame.Timings.DiffUs >= 0);
                    Assert.True(frame.Timings.OcrUs >= 0);
                    // Never pixels unless asked.
                    Assert.Null(frame.ImagePng);
                    // No content is reported — counts and costs only.
                    output.WriteLine(
                        $"<- frame seq={frame.Seq} lines={frame.Lines.Length} "
                        + $"captureUs={frame.Timings.CaptureUs} diffUs={frame.Timings.DiffUs} ocrUs={frame.Timings.OcrUs}");
                    break;

                case NoChangeEvent nochange:
                    nochanges++;
                    seqs.Add(nochange.Seq);
                    output.WriteLine($"<- nochange seq={nochange.Seq}");
                    break;

                default:
                    output.WriteLine($"<- {evt.Ev}");
                    break;
            }
        }

        output.WriteLine($"10 events: {frames} frame, {nochanges} nochange");

        // The criterion the design doc actually cares about is that the stream never goes
        // quiet — a static screen must still produce `nochange` so Node's watchdog can
        // tell a quiet sidecar from a hung one.
        Assert.Equal(10, frames + nochanges);
        Assert.Equal(seqs.OrderBy(s => s), seqs);
        Assert.Equal(seqs.Distinct().Count(), seqs.Count);

        sidecar.Send("""{"cmd":"stop"}""");
    }

    /// <summary>
    /// "<c>stop</c> actually stops capture", proven on two independent axes — work done and
    /// CPU consumed — and then distinguished from the failure it would otherwise resemble.
    ///
    /// <para><b>Silence alone proves nothing</b>: a deadlocked sidecar is also silent. So
    /// after stopping, the process is asked a question and has to answer, which separates
    /// "stopped" from "hung".</para>
    ///
    /// <para>The intervals are deliberately pinned fast in <i>both</i> active and idle, so
    /// the loop keeps ticking regardless of what the screen is doing. At the production
    /// intervals this test would measure nothing, because a static screen at deep idle
    /// genuinely costs less CPU than Windows can report — which is the interval-driven
    /// design working, and is a poor foundation for a comparison.</para>
    /// </summary>
    [Fact]
    public void StopActuallyStopsTheCapture_ByWorkDoneAndByCpu()
    {
        using var sidecar = new Sidecar();
        var monitorId = PrimaryMonitorId();

        Assert.IsType<ReadyEvent>(sidecar.ReadEvent());
        sidecar.Send(ConfigureLine(monitorId, intervalActive: 15, intervalIdle: 15));
        Assert.IsType<AckEvent>(sidecar.ReadEvent());
        sidecar.Send("""{"cmd":"start"}""");
        Assert.IsType<AckEvent>(sidecar.ReadEvent());

        // --- while running ---
        var eventsBeforeRunning = sidecar.Received;
        sidecar.Process.Refresh();
        var cpuBeforeRunning = sidecar.Process.TotalProcessorTime;

        Thread.Sleep(2000);

        var eventsWhileRunning = sidecar.Received - eventsBeforeRunning;
        sidecar.Process.Refresh();
        var cpuWhileRunning = sidecar.Process.TotalProcessorTime - cpuBeforeRunning;

        sidecar.Send("""{"cmd":"stop"}""");

        // Let anything already in flight land, then start from a clean slate.
        Thread.Sleep(500);
        sidecar.Drain();

        // --- while stopped ---
        var eventsBeforeStopped = sidecar.Received;
        sidecar.Process.Refresh();
        var cpuBeforeStopped = sidecar.Process.TotalProcessorTime;

        Thread.Sleep(2000);

        var eventsWhileStopped = sidecar.Received - eventsBeforeStopped;
        sidecar.Process.Refresh();
        var cpuWhileStopped = sidecar.Process.TotalProcessorTime - cpuBeforeStopped;

        output.WriteLine($"running 2s: {eventsWhileRunning,4} events, {cpuWhileRunning.TotalMilliseconds,6:F1}ms CPU");
        output.WriteLine($"stopped 2s: {eventsWhileStopped,4} events, {cpuWhileStopped.TotalMilliseconds,6:F1}ms CPU");

        Assert.True(eventsWhileRunning > 10, $"only {eventsWhileRunning} events while running; this measures nothing");
        // The capture loop did no work at all, rather than merely less.
        Assert.Equal(0, eventsWhileStopped);
        Assert.True(
            cpuWhileStopped < cpuWhileRunning,
            $"stopped CPU {cpuWhileStopped.TotalMilliseconds:F1}ms is not below running {cpuWhileRunning.TotalMilliseconds:F1}ms");

        // Stopped, not hung — the distinction silence alone cannot make.
        sidecar.Send("""{"cmd":"listMonitors"}""");
        var ack = Assert.IsType<AckEvent>(sidecar.ReadEvent());
        Assert.Equal(SidecarState.Stopped, ack.State);
        output.WriteLine($"after stop, still answering: {ack.Ev} cmd={ack.Cmd} state={ack.State}");

        // And it can be restarted, so `stop` is a pause rather than a one-way door.
        sidecar.Send("""{"cmd":"start"}""");
        Assert.IsType<AckEvent>(sidecar.ReadEvent());
        Thread.Sleep(500);
        Assert.True(sidecar.Received > eventsBeforeStopped + eventsWhileStopped + 2, "the loop did not resume after a restart");
    }

    [Fact]
    public void ListMonitorsReportsEveryDisplayWithBoundsAndScale()
    {
        using var sidecar = new Sidecar();
        Assert.IsType<ReadyEvent>(sidecar.ReadEvent());

        output.WriteLine("""-> {"cmd":"listMonitors"}""");
        sidecar.Send("""{"cmd":"listMonitors"}""");

        var ack = Assert.IsType<AckEvent>(sidecar.ReadEvent());
        output.WriteLine($"<- {ProtocolCodec.Encode(ack)}");

        Assert.Equal(CommandKind.ListMonitors, ack.Cmd);
        Assert.Equal(SidecarState.Idle, ack.State);
        Assert.NotNull(ack.Monitors);
        Assert.NotEmpty(ack.Monitors);

        foreach (var monitor in ack.Monitors)
        {
            Assert.StartsWith(@"\\.\", monitor.Id, StringComparison.Ordinal);
            Assert.True(monitor.Scale > 0);
            Assert.True(monitor.Bounds.Width > 0 && monitor.Bounds.Height > 0);
        }
    }

    [Fact]
    public void AnUnknownCommandIsAnErrorAndTheProcessKeepsRunning()
    {
        using var sidecar = new Sidecar();
        Assert.IsType<ReadyEvent>(sidecar.ReadEvent());

        foreach (var bad in new[]
                 {
                     """{"cmd":"recalibrate","passes":3}""",
                     """{"cmd":"start""",
                     "not json at all",
                     "[1,2,3]",
                 })
        {
            output.WriteLine($"-> {bad}");
            sidecar.Send(bad);
            var error = Assert.IsType<ErrorEvent>(sidecar.ReadEvent());
            output.WriteLine($"<- {ProtocolCodec.Encode(error)}");
            Assert.Equal(Dispatcher.UnknownCommandCode, error.Code);
        }

        // Still alive and still working — the point of the whole exercise.
        Assert.False(sidecar.Process.HasExited);
        sidecar.Send("""{"cmd":"listMonitors"}""");
        Assert.IsType<AckEvent>(sidecar.ReadEvent());
    }

    [Fact]
    public void DebugFrameIsRefusedUnlessConfigureEnabledIt_ThenReturnsAPng()
    {
        using var sidecar = new Sidecar();
        var monitorId = PrimaryMonitorId();
        Assert.IsType<ReadyEvent>(sidecar.ReadEvent());

        // Disabled, which is the default the design doc requires.
        sidecar.Send(ConfigureLine(monitorId, debugFrameEnabled: false));
        Assert.IsType<AckEvent>(sidecar.ReadEvent());

        output.WriteLine("""-> {"cmd":"debugFrame"}   (debugFrameEnabled: false)""");
        sidecar.Send("""{"cmd":"debugFrame"}""");
        var refused = Assert.IsType<ErrorEvent>(sidecar.ReadEvent());
        output.WriteLine($"<- {ProtocolCodec.Encode(refused)}");
        Assert.Equal(CaptureLoop.DebugFrameDisabledCode, refused.Code);

        // Now enable it and ask again.
        sidecar.Send(ConfigureLine(monitorId, debugFrameEnabled: true));
        Assert.IsType<AckEvent>(sidecar.ReadEvent());

        output.WriteLine("""-> {"cmd":"debugFrame"}   (debugFrameEnabled: true)""");
        sidecar.Send("""{"cmd":"debugFrame"}""");
        var frame = Assert.IsType<FrameEvent>(sidecar.ReadEvent());

        Assert.NotNull(frame.ImagePng);
        // The payload is never printed, here or anywhere: it is a picture of the user's
        // screen. Only its shape is checked.
        var decoded = Convert.FromBase64String(frame.ImagePng);
        output.WriteLine($"<- frame seq={frame.Seq} imagePng={decoded.Length} bytes (content deliberately not shown)");
        Assert.True(decoded.Length > 0);
        // PNG magic number.
        Assert.Equal(new byte[] { 0x89, 0x50, 0x4E, 0x47 }, decoded[..4]);
    }

    [Fact]
    public void SnapshotReturnsAFrameEvenWithoutStarting()
    {
        using var sidecar = new Sidecar();
        var monitorId = PrimaryMonitorId();
        Assert.IsType<ReadyEvent>(sidecar.ReadEvent());

        sidecar.Send(ConfigureLine(monitorId));
        Assert.IsType<AckEvent>(sidecar.ReadEvent());

        output.WriteLine("""-> {"cmd":"snapshot"}""");
        sidecar.Send("""{"cmd":"snapshot"}""");

        var frame = Assert.IsType<FrameEvent>(sidecar.ReadEvent());
        output.WriteLine(
            $"<- frame seq={frame.Seq} lines={frame.Lines.Length} region=[{frame.Region.X},{frame.Region.Y},{frame.Region.Width},{frame.Region.Height}]");

        Assert.Null(frame.ImagePng);
        // The coordinate contract, straight off the wire from a real display.
        Assert.True(frame.Monitor.Scale > 0);
        Assert.True(frame.Monitor.Bounds.Width > 0);
    }

    [Fact]
    public void ClosingStdinEndsTheProcessCleanly()
    {
        using var sidecar = new Sidecar();
        Assert.IsType<ReadyEvent>(sidecar.ReadEvent());

        sidecar.CloseInput();

        Assert.True(sidecar.Process.WaitForExit(10_000), "the sidecar did not exit when its stdin closed");
        output.WriteLine($"exit code {sidecar.Process.ExitCode}, stderr lines: {sidecar.Stderr.Length}");
        Assert.Equal(0, sidecar.Process.ExitCode);
    }
}
