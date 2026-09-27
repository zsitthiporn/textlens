using System.Diagnostics;
using System.Globalization;
using Textlens.Capture.Protocol;
using Textlens.Capture.Services;
using WireLine = Textlens.Capture.Protocol.OcrLine;

namespace Textlens.Capture.Tests;

/// <summary>
/// Issue M2-06, the state machine. The host is faked so the transitions, the acks and the
/// refusals are tested without a display; the same commands are then driven through the
/// real process by <see cref="SidecarProcessTests"/>.
/// </summary>
public class DispatcherTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private const int Width = 64;
    private const int Height = 16;

    private sealed class FakeHost : ICaptureHost
    {
        private readonly List<FakeSource> sources = [];
        private readonly List<FakeRecognizer> recognizers = [];

        public int SourcesOpened => sources.Count;

        public int RecognizersCreated => recognizers.Count;

        /// <summary>Every source opened, oldest first, so a test can ask what happened to one.</summary>
        public IReadOnlyList<FakeSource> Sources => sources;

        /// <summary>Every recognizer created, oldest first.</summary>
        public IReadOnlyList<FakeRecognizer> Recognizers => recognizers;

        public string? LastMonitorId { get; private set; }

        public Exception? OpenThrows { get; set; }

        /// <summary>A language with no recognizer installed — what an uninstalled pack looks like.</summary>
        public string? UninstalledLanguage { get; set; }

        /// <summary>When set, the next source opened parks every capture on this gate.</summary>
        public ManualResetEventSlim? GateNextSource { get; set; }

        /// <summary>Set by that gated source once a capture is parked inside it.</summary>
        public ManualResetEventSlim? NextSourceEntered { get; set; }

        public MonitorInfo[] ListMonitors() =>
        [
            new() { Id = @"\\.\DISPLAY1", Scale = 1.5, Bounds = new Rect(0, 0, 3840, 2160) },
            new() { Id = @"\\.\DISPLAY2", Scale = 1.25, Bounds = new Rect(-1920, 0, 1920, 1080) },
        ];

        public IRegionSource OpenSource(string monitorId)
        {
            if (OpenThrows is not null)
            {
                throw OpenThrows;
            }

            LastMonitorId = monitorId;
            var source = new FakeSource(monitorId) { Gate = GateNextSource, Entered = NextSourceEntered };
            GateNextSource = null;
            NextSourceEntered = null;
            sources.Add(source);
            return source;
        }

        public IRecognizer CreateRecognizer(string languageTag)
        {
            if (string.Equals(languageTag, UninstalledLanguage, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"no OCR recognizer for \"{languageTag}\" (installed: en-US)");
            }

            var recognizer = new FakeRecognizer();
            recognizers.Add(recognizer);
            return recognizer;
        }

        public IFrameEncoder? CreateEncoder() => new FakeEncoder();
    }

    /// <summary>
    /// Disposable and strict about it. The real <see cref="CaptureService"/> throws
    /// <see cref="ObjectDisposedException"/> once disposed, and a fake that quietly kept
    /// working would hide the exact bug
    /// <see cref="ReconfiguringOnANewMonitorDoesNotLeaveTheOldLoopFiring"/> exists to catch.
    ///
    /// <para>It also records whether it was disposed while a capture was inside it — which
    /// for the real service means releasing the D3D context under a copy in progress.</para>
    /// </summary>
    private sealed class FakeSource(string monitorId) : IRegionSource, IDisposable
    {
        private int fill = 0x10;
        private int inside;
        private volatile bool disposed;

        public MonitorInfo Monitor { get; } = new()
        {
            Id = monitorId,
            Scale = 1.5,
            Bounds = new Rect(0, 0, 3840, 2160),
        };

        public ManualResetEventSlim? Gate { get; init; }

        public ManualResetEventSlim? Entered { get; init; }

        public bool Disposed => disposed;

        public bool DisposedWhileInside { get; private set; }

        public CapturedRegion? CaptureRegion(Rect region)
        {
            ObjectDisposedException.ThrowIf(disposed, this);

            Interlocked.Increment(ref inside);
            try
            {
                Entered?.Set();
                Gate?.Wait();

                var pixels = new byte[Width * Height * 4];
                Array.Fill(pixels, (byte)Interlocked.Exchange(ref fill, fill == 0x10 ? 0xF0 : 0x10));
                return new CapturedRegion(pixels, Width, Height, Monitor, new Rect(0, 0, Width, Height), 574);
            }
            finally
            {
                Interlocked.Decrement(ref inside);
            }
        }

        public void Dispose()
        {
            if (Volatile.Read(ref inside) > 0)
            {
                DisposedWhileInside = true;
            }

            disposed = true;
        }
    }

    /// <summary>
    /// Throws once disposed, like the real <see cref="OcrService"/>. A recognizer that kept
    /// working after Dispose is exactly what let a failed <c>configure</c> hide the disposed
    /// recognizer it left behind.
    /// </summary>
    private sealed class FakeRecognizer : IRecognizer, IDisposable
    {
        private volatile bool disposed;

        public bool Disposed => disposed;

        public WireLine[] Recognize(ReadOnlySpan<byte> bgra, int width, int height)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return [new WireLine { Text = "You must find the key", Bbox = new Rect(4, 2, 40, 10) }];
        }

        public void Dispose() => disposed = true;
    }

    private sealed class FakeEncoder : IFrameEncoder
    {
        public string ToBase64Png(ReadOnlySpan<byte> bgra, int width, int height) => "iVBORw0KGgo=";
    }

    /// <summary>
    /// A <c>configure</c> line. The defaults are the protocol's own sample values, which is
    /// precisely why a test that means to prove a value arrives must not rely on them: a
    /// dropped assignment leaves the default in place and the assertion passes anyway.
    /// </summary>
    private static string ConfigureLine(
        string monitorId = @"\\\\.\\DISPLAY1",
        int intervalActive = 800,
        bool debugFrameEnabled = false,
        int intervalIdle = 2000,
        double diffThreshold = 0.02,
        string ocrLanguage = "en-US",
        string region = "0,0,64,16")
        => $$"""
             {"cmd":"configure","region":[{{region}}],"monitorId":"{{monitorId}}","intervalActive":{{intervalActive}},"intervalIdle":{{intervalIdle}},"diffThreshold":{{diffThreshold.ToString(CultureInfo.InvariantCulture)}},"ocrLanguage":"{{ocrLanguage}}","debugFrameEnabled":{{(debugFrameEnabled ? "true" : "false")}}}
             """;

    /// <summary>Every event carrying a <c>seq</c>, in the order it reached stdout.</summary>
    private static long[] Seqs(IEnumerable<ISidecarEvent> events)
        => [.. events.Select(e => e switch
        {
            FrameEvent f => f.Seq,
            NoChangeEvent n => n.Seq,
            _ => 0,
        }).Where(s => s != 0)];

    private static bool WaitUntil(Func<bool> condition, TimeSpan timeout)
    {
        var stopwatch = Stopwatch.StartNew();
        while (!condition())
        {
            if (stopwatch.Elapsed > timeout)
            {
                return false;
            }

            Thread.Sleep(5);
        }

        return true;
    }

    private static (Dispatcher Dispatcher, List<ISidecarEvent> Events, FakeHost Host) Build()
    {
        var events = new List<ISidecarEvent>();
        var host = new FakeHost();
        // Locked: some of these tests start a real timer, so ticks land on threadpool
        // threads while the test reads the list.
        void Emit(ISidecarEvent evt)
        {
            lock (events)
            {
                events.Add(evt);
            }
        }

        return (new Dispatcher(host, Emit), events, host);
    }

    // ------------------------------------------------------------------
    // The state machine
    // ------------------------------------------------------------------

    [Fact]
    public void TheHappyPathWalksIdleToConfiguredToRunningToStopped()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            Assert.Equal(SidecarState.Idle, dispatcher.State);

            dispatcher.Execute(ConfigureLine());
            Assert.Equal(SidecarState.Configured, dispatcher.State);

            dispatcher.Execute("""{"cmd":"start"}""");
            Assert.Equal(SidecarState.Running, dispatcher.State);

            dispatcher.Execute("""{"cmd":"stop"}""");
            Assert.Equal(SidecarState.Stopped, dispatcher.State);
        }

        var acks = events.OfType<AckEvent>().ToArray();
        foreach (var ack in acks)
        {
            output.WriteLine(ProtocolCodec.Encode(ack));
        }

        Assert.Equal(3, acks.Length);
        Assert.Equal((CommandKind.Configure, SidecarState.Configured), (acks[0].Cmd, acks[0].State));
        Assert.Equal((CommandKind.Start, SidecarState.Running), (acks[1].Cmd, acks[1].State));
        Assert.Equal((CommandKind.Stop, SidecarState.Stopped), (acks[2].Cmd, acks[2].State));
    }

    [Fact]
    public void ListMonitorsAnswersFromIdle_BecauseItIsHowNodeLearnsWhatToConfigure()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute("""{"cmd":"listMonitors"}""");
        }

        var ack = Assert.IsType<AckEvent>(Assert.Single(events));
        output.WriteLine(ProtocolCodec.Encode(ack));

        Assert.Equal(CommandKind.ListMonitors, ack.Cmd);
        Assert.Equal(SidecarState.Idle, ack.State);
        Assert.NotNull(ack.Monitors);
        Assert.Equal(2, ack.Monitors.Length);
        // The coordinate contract survives the reply: physical bounds, real scale, and the
        // negative origin of a display left of primary.
        Assert.Equal(new Rect(-1920, 0, 1920, 1080), ack.Monitors[1].Bounds);
        Assert.Equal(1.25, ack.Monitors[1].Scale);
    }

    [Fact]
    public void StartBeforeConfigureIsAnErrorThatNamesTheMissingStep()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute("""{"cmd":"start"}""");
        }

        var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
        Assert.Equal(Dispatcher.NotConfiguredCode, error.Code);
        Assert.Contains("configure", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("snapshot")]
    [InlineData("debugFrame")]
    public void CommandsNeedingARegionRefuseBeforeConfigure(string command)
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute($$"""{"cmd":"{{command}}"}""");
        }

        Assert.Equal(Dispatcher.NotConfiguredCode, Assert.IsType<ErrorEvent>(Assert.Single(events)).Code);
    }

    [Fact]
    public void StopWithoutHavingStartedIsNotAnError()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute("""{"cmd":"stop"}""");
        }

        // "stop" means "be stopped". Making Node track whether it already sent one buys
        // nothing, and an error here would be noise in every shutdown path.
        var ack = Assert.IsType<AckEvent>(Assert.Single(events));
        Assert.Equal(SidecarState.Idle, ack.State);
    }

    // ------------------------------------------------------------------
    // configure while running
    // ------------------------------------------------------------------

    [Fact]
    public void ConfigureWhileRunningTakesEffectAndStaysRunning()
    {
        var (dispatcher, events, host) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine());
            dispatcher.Execute("""{"cmd":"start"}""");
            events.Clear();

            dispatcher.Execute(ConfigureLine(intervalActive: 250));

            var ack = Assert.IsType<AckEvent>(events.First(e => e is AckEvent));
            Assert.Equal(SidecarState.Running, ack.State);
            Assert.Equal(SidecarState.Running, dispatcher.State);
            Assert.True(dispatcher.Loop!.IsRunning);
            Assert.Equal(250, dispatcher.Loop.Schedule.IntervalActive);

            // The expensive resources were not rebuilt for a change that did not need it —
            // the point of "without a restart".
            Assert.Equal(1, host.SourcesOpened);
            Assert.Equal(1, host.RecognizersCreated);
        }
    }

    [Fact]
    public void ConfigureOnADifferentMonitorReopensTheCaptureSession()
    {
        var (dispatcher, _, host) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine());
            dispatcher.Execute("""{"cmd":"start"}""");

            dispatcher.Execute(ConfigureLine(monitorId: @"\\\\.\\DISPLAY2"));

            Assert.Equal(2, host.SourcesOpened);
            Assert.Equal(@"\\.\DISPLAY2", host.LastMonitorId);
            // Rebuilt underneath a running capture, so it has to still be running.
            Assert.Equal(SidecarState.Running, dispatcher.State);
            Assert.True(dispatcher.Loop!.IsRunning);
            // The recognizer did not change, so it was not rebuilt.
            Assert.Equal(1, host.RecognizersCreated);
        }
    }

    /// <summary>
    /// Reconfiguring onto a new monitor while running replaces the capture session, and
    /// the loop that was driving the old one has to be torn down <b>first</b>.
    ///
    /// <para>Otherwise the old loop's timer keeps firing against a source that was just
    /// disposed — an <see cref="ObjectDisposedException"/> per tick, so a stream of
    /// <c>CAPTURE_FAILED</c> at the old interval, emitted by a loop nobody holds a
    /// reference to, until the GC happens to finalize its timer. Nondeterministic,
    /// unbounded, and interleaved with the new loop's perfectly good events.</para>
    /// </summary>
    [Fact]
    public void ReconfiguringOnANewMonitorDoesNotLeaveTheOldLoopFiring()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            // Fast interval, so an abandoned timer would fire many times in the window.
            dispatcher.Execute(ConfigureLine(intervalActive: 15));
            dispatcher.Execute("""{"cmd":"start"}""");

            dispatcher.Execute(ConfigureLine(monitorId: @"\\\\.\\DISPLAY2", intervalActive: 15));

            lock (events)
            {
                events.Clear();
            }

            Thread.Sleep(400);

            ErrorEvent[] errors;
            lock (events)
            {
                errors = [.. events.OfType<ErrorEvent>()];
            }

            foreach (var error in errors.Take(3))
            {
                output.WriteLine($"{error.Code}: {error.Message}");
            }

            Assert.Empty(errors);
        }
    }

    [Fact]
    public void ReconfiguringCarriesTheSequenceCounterForward()
    {
        // The protocol says a gap in `seq` means an event was lost. A rebuilt loop that
        // restarted at 1 would be a false report of exactly that — and worse, seq would go
        // backwards, which nothing downstream expects.
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine());
            dispatcher.Execute("""{"cmd":"snapshot"}""");
            dispatcher.Execute("""{"cmd":"snapshot"}""");

            var beforeRebuild = dispatcher.Loop!.LastSeq;
            Assert.Equal(2, beforeRebuild);

            dispatcher.Execute(ConfigureLine(monitorId: @"\\\\.\\DISPLAY2"));
            dispatcher.Execute("""{"cmd":"snapshot"}""");

            var seqs = events.OfType<FrameEvent>().Select(f => f.Seq).ToArray();
            output.WriteLine($"seq across a monitor change: {string.Join(", ", seqs)}");

            Assert.Equal(new long[] { 1, 2, 3 }, seqs);
        }
    }

    /// <summary>
    /// Every value in the payload reaches the loop. Deliberately <b>none</b> of them is the
    /// default: this test used to send 0.02 / 800 / 2000 / false, which are exactly what a
    /// fresh detector and timer already hold, so deleting the assignments outright left it
    /// green (82 of 82 still passing, run by the reviewer).
    /// </summary>
    [Fact]
    public void ConfigureCarriesTheThresholdAndIntervalsThrough()
    {
        var (dispatcher, _, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(
                intervalActive: 345,
                intervalIdle: 1234,
                diffThreshold: 0.037,
                debugFrameEnabled: true,
                region: "10,20,64,16"));

            AssertCarried(dispatcher.Loop!);
        }
    }

    /// <summary>
    /// The same, for a <c>configure</c> that lands on a loop that is already running — the
    /// path that retunes in place rather than building a new loop.
    /// </summary>
    [Fact]
    public void ConfigureWhileRunningCarriesTheThresholdAndIntervalsThrough()
    {
        var (dispatcher, _, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(intervalActive: 60_000));
            dispatcher.Execute("""{"cmd":"start"}""");
            var loop = dispatcher.Loop!;

            dispatcher.Execute(ConfigureLine(
                intervalActive: 345,
                intervalIdle: 1234,
                diffThreshold: 0.037,
                debugFrameEnabled: true,
                region: "10,20,64,16"));

            Assert.Same(loop, dispatcher.Loop);
            AssertCarried(loop);
            Assert.Equal(345, loop.Schedule.CurrentIntervalMs);
        }
    }

    private static void AssertCarried(CaptureLoop loop)
    {
        Assert.Equal(0.037, loop.Detector.Threshold);
        Assert.Equal(345, loop.Schedule.IntervalActive);
        Assert.Equal(1234, loop.Schedule.IntervalIdle);
        Assert.True(loop.DebugFrameEnabled);
        Assert.Equal(new Rect(10, 20, 64, 16), loop.Region);
    }

    // ------------------------------------------------------------------
    // A configure that fails changes nothing (F1, #83)
    // ------------------------------------------------------------------

    /// <summary>
    /// The user picks an OCR language whose pack is not installed, gets an error, and picks
    /// English again. That must put them back where they were.
    ///
    /// <para>It did not: the old recognizer was disposed <i>before</i> the new one was
    /// asked for, so the failure left a disposed recognizer wired in — and reverting the
    /// setting matched the name still on record, reused it, acked <c>running</c>, and
    /// failed every OCR with <see cref="ObjectDisposedException"/> until a restart.</para>
    /// </summary>
    [Fact]
    public void AConfigureNamingAnUninstalledLanguageChangesNothing()
    {
        var (dispatcher, events, host) = Build();
        using (dispatcher)
        {
            host.UninstalledLanguage = "ja";
            // A long interval so only the snapshots below produce frames.
            dispatcher.Execute(ConfigureLine(intervalActive: 60_000));
            dispatcher.Execute("""{"cmd":"start"}""");
            var loop = dispatcher.Loop!;

            dispatcher.Execute(ConfigureLine(ocrLanguage: "ja", intervalActive: 345));
            var failure = Assert.IsType<ErrorEvent>(events[^1]);
            var stateAfterFailure = dispatcher.State;
            var loopAfterFailure = dispatcher.Loop;

            // Back to English, and ask for a frame.
            events.Clear();
            dispatcher.Execute(ConfigureLine(intervalActive: 60_000));
            dispatcher.Execute("""{"cmd":"snapshot"}""");

            foreach (var evt in events)
            {
                output.WriteLine(ProtocolCodec.Encode(evt));
            }

            // The user-visible half: after reverting, OCR works.
            Assert.Empty(events.OfType<ErrorEvent>().Select(e => $"{e.Code}: {e.Message}"));
            Assert.Single(events.OfType<FrameEvent>());

            // And the reason it does: the refused configure touched nothing.
            Assert.Equal(Dispatcher.ConfigureFailedCode, failure.Code);
            Assert.Contains("ja", failure.Message, StringComparison.Ordinal);
            Assert.Equal(SidecarState.Running, stateAfterFailure);
            Assert.Same(loop, loopAfterFailure);
            Assert.True(loop.IsRunning);
            Assert.Equal(60_000, loop.Schedule.IntervalActive);
            Assert.False(Assert.Single(host.Recognizers).Disposed);
        }
    }

    /// <summary>The same for a <c>monitorId</c> that names no attached display.</summary>
    [Fact]
    public void AConfigureNamingAnUnknownMonitorChangesNothing()
    {
        var (dispatcher, events, host) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(intervalActive: 60_000));
            dispatcher.Execute("""{"cmd":"start"}""");
            var loop = dispatcher.Loop!;

            host.OpenThrows = new InvalidOperationException("no display named \\\\.\\DISPLAY9");
            dispatcher.Execute(ConfigureLine(monitorId: @"\\\\.\\DISPLAY9", intervalActive: 345));
            host.OpenThrows = null;
            var failure = Assert.IsType<ErrorEvent>(events[^1]);
            var stateAfterFailure = dispatcher.State;
            var loopAfterFailure = dispatcher.Loop;

            events.Clear();
            dispatcher.Execute(ConfigureLine(intervalActive: 60_000));
            dispatcher.Execute("""{"cmd":"snapshot"}""");

            foreach (var evt in events)
            {
                output.WriteLine(ProtocolCodec.Encode(evt));
            }

            Assert.Empty(events.OfType<ErrorEvent>().Select(e => $"{e.Code}: {e.Message}"));
            Assert.Single(events.OfType<FrameEvent>());

            Assert.Equal(Dispatcher.ConfigureFailedCode, failure.Code);
            Assert.Equal(SidecarState.Running, stateAfterFailure);
            Assert.Same(loop, loopAfterFailure);
            Assert.True(loop.IsRunning);
            Assert.Equal(60_000, loop.Schedule.IntervalActive);
            Assert.False(Assert.Single(host.Sources).Disposed);
        }
    }

    /// <summary>
    /// A value out of range is refused before anything is touched, including the values
    /// that were fine. Applied one at a time, a bad <c>intervalIdle</c> used to land the
    /// threshold and <c>intervalActive</c> ahead of it and then report the whole payload
    /// as refused.
    /// </summary>
    [Fact]
    public void AConfigureWithAnInvalidIntervalAppliesNoneOfIt()
    {
        var (dispatcher, events, host) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(intervalActive: 60_000));
            dispatcher.Execute("""{"cmd":"start"}""");
            var loop = dispatcher.Loop!;

            // Includes a monitor change, so a half-applied configure would also have opened
            // (and leaked) a capture session for a payload it then refused.
            dispatcher.Execute(ConfigureLine(
                monitorId: @"\\\\.\\DISPLAY2",
                intervalActive: 345,
                intervalIdle: 0,
                diffThreshold: 0.5));

            var error = Assert.IsType<ErrorEvent>(events[^1]);
            output.WriteLine(ProtocolCodec.Encode(error));
            Assert.Equal(Dispatcher.ConfigureFailedCode, error.Code);

            Assert.Equal(1, host.SourcesOpened);
            Assert.Same(loop, dispatcher.Loop);
            Assert.True(loop.IsRunning);
            Assert.Equal(SidecarState.Running, dispatcher.State);
            Assert.Equal(ChangeDetector.DefaultThreshold, loop.Detector.Threshold);
            Assert.Equal(60_000, loop.Schedule.IntervalActive);

            // Named, so the user can tell which setting to fix.
            Assert.Contains("intervalIdle", error.Message, StringComparison.Ordinal);
        }
    }

    // ------------------------------------------------------------------
    // Teardown waits for the tick in flight (F2, #83)
    // ------------------------------------------------------------------

    /// <summary>
    /// <c>ack stopped</c> is a barrier: nothing the loop does lands on stdout after it.
    ///
    /// <para>Proven with a tick parked inside the capture call when <c>stop</c> arrives.
    /// Before the fix the ack went out straight away and the parked tick's frame followed
    /// it once released — the reviewer measured a frame 72ms after the ack. That breaks
    /// #60 in particular, which sends <c>stop</c> then <c>snapshot</c> and holds the
    /// snapshot's frame: a late tick overwrites it.</para>
    /// </summary>
    [Fact]
    public void StopIsABarrier_NothingFromTheLoopFollowsItsAck()
    {
        var (dispatcher, events, host) = Build();
        using (dispatcher)
        {
            using var gate = new ManualResetEventSlim(false);
            using var entered = new ManualResetEventSlim(false);
            host.GateNextSource = gate;
            host.NextSourceEntered = entered;

            dispatcher.Execute(ConfigureLine(intervalActive: 20));
            dispatcher.Execute("""{"cmd":"start"}""");
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)), "the first tick never reached the capture call");

            // A dedicated thread rather than Task.Run: this must not depend on the pool.
            var stopper = new Thread(() => dispatcher.Execute("""{"cmd":"stop"}"""));
            stopper.Start();

            // Long enough for a stop that does not wait to have acked already.
            Thread.Sleep(100);
            gate.Set();
            Assert.True(stopper.Join(TimeSpan.FromSeconds(10)), "stop never returned");

            // Give a stale timer callback every chance to show itself: 10 periods.
            Thread.Sleep(200);

            ISidecarEvent[] transcript;
            lock (events)
            {
                transcript = [.. events];
            }

            foreach (var evt in transcript)
            {
                output.WriteLine(ProtocolCodec.Encode(evt));
            }

            var ack = Array.FindIndex(transcript, e => e is AckEvent { Cmd: CommandKind.Stop });
            Assert.True(ack >= 0, "no stop ack");
            Assert.Empty(transcript[(ack + 1)..].Select(ProtocolCodec.Encode));

            // Positive control: the parked tick did produce its frame — before the ack.
            Assert.Contains(transcript[..ack], e => e is FrameEvent);
        }
    }

    /// <summary>
    /// A <c>configure</c> that moves to another monitor while a tick is inside the old
    /// capture session: the old session must not be disposed under that tick, the tick's
    /// frame must land <i>before</i> the ack, and <c>seq</c> must carry on from it.
    ///
    /// <para>All three failed before the fix, executed by the reviewer: the old source was
    /// disposed with a tick inside it, the old loop's <c>frame seq=1 DISPLAY1</c> arrived
    /// 75ms after the DISPLAY2 ack, and the new loop's first frame was <c>seq=1</c> as
    /// well, because the counter was copied before the in-flight tick took its number.</para>
    /// </summary>
    [Fact]
    public void ReconfiguringOntoANewMonitorDrainsTheOldLoopFirst()
    {
        var (dispatcher, events, host) = Build();
        using (dispatcher)
        {
            using var gate = new ManualResetEventSlim(false);
            using var entered = new ManualResetEventSlim(false);
            host.GateNextSource = gate;
            host.NextSourceEntered = entered;

            dispatcher.Execute(ConfigureLine(intervalActive: 20));
            dispatcher.Execute("""{"cmd":"start"}""");
            Assert.True(entered.Wait(TimeSpan.FromSeconds(10)), "the first tick never reached the capture call");

            var reconfigure = new Thread(() =>
                dispatcher.Execute(ConfigureLine(monitorId: @"\\\\.\\DISPLAY2", intervalActive: 20)));
            reconfigure.Start();

            Thread.Sleep(100);
            gate.Set();
            Assert.True(reconfigure.Join(TimeSpan.FromSeconds(10)), "configure never returned");

            // Let the new loop run a few ticks, so seq has something to continue into.
            Assert.True(
                WaitUntil(
                    () =>
                    {
                        lock (events)
                        {
                            return events.OfType<FrameEvent>().Count(f => f.Monitor.Id == @"\\.\DISPLAY2") >= 3;
                        }
                    },
                    TimeSpan.FromSeconds(10)),
                "the new loop never produced frames");

            dispatcher.Execute("""{"cmd":"stop"}""");

            ISidecarEvent[] transcript;
            lock (events)
            {
                transcript = [.. events];
            }

            foreach (var evt in transcript)
            {
                output.WriteLine(ProtocolCodec.Encode(evt));
            }

            var old = host.Sources[0];
            Assert.True(old.Disposed, "the old capture session was never released");
            Assert.False(old.DisposedWhileInside, "the old capture session was disposed with a tick still inside it");

            var ack = Array.FindIndex(transcript, e => e is AckEvent { Cmd: CommandKind.Configure, State: SidecarState.Running });
            Assert.True(ack >= 0, "no configure ack");
            Assert.Contains(transcript[..ack], e => e is FrameEvent { Monitor.Id: @"\\.\DISPLAY1" });
            Assert.DoesNotContain(transcript[(ack + 1)..], e => e is FrameEvent { Monitor.Id: @"\\.\DISPLAY1" });

            // Monotonic, gap-free, no repeats — across the rebuild (sidecar-protocol.md §3).
            var seqs = Seqs(transcript);
            output.WriteLine($"seq: {string.Join(", ", seqs)}");
            Assert.Equal(Enumerable.Range(1, seqs.Length).Select(i => (long)i), seqs);
        }
    }

    [Fact]
    public void AConfigureThatCannotBeAppliedIsAnErrorAndTheDispatcherSurvives()
    {
        var (dispatcher, events, host) = Build();
        using (dispatcher)
        {
            host.OpenThrows = new InvalidOperationException("no display named \\\\.\\DISPLAY9");

            dispatcher.Execute(ConfigureLine(monitorId: @"\\\\.\\DISPLAY9"));

            var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
            Assert.Equal(Dispatcher.ConfigureFailedCode, error.Code);
            Assert.Equal(SidecarState.Idle, dispatcher.State);

            // Still usable afterwards.
            host.OpenThrows = null;
            dispatcher.Execute(ConfigureLine());
            Assert.Equal(SidecarState.Configured, dispatcher.State);
        }
    }

    // ------------------------------------------------------------------
    // debugFrame
    // ------------------------------------------------------------------

    [Fact]
    public void DebugFrameIsRefusedUnlessConfigureEnabledIt()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(debugFrameEnabled: false));
            events.Clear();

            dispatcher.Execute("""{"cmd":"debugFrame"}""");

            var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
            Assert.Equal(CaptureLoop.DebugFrameDisabledCode, error.Code);
        }
    }

    [Fact]
    public void DebugFrameReturnsAnImageOnceConfigureEnabledIt()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(debugFrameEnabled: true));
            events.Clear();

            dispatcher.Execute("""{"cmd":"debugFrame"}""");

            var frame = Assert.IsType<FrameEvent>(Assert.Single(events));
            Assert.Equal("iVBORw0KGgo=", frame.ImagePng);
        }
    }

    [Fact]
    public void EnablingAndDisablingDebugFrameIsJustAnotherConfigure()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(debugFrameEnabled: true));
            dispatcher.Execute(ConfigureLine(debugFrameEnabled: false));
            events.Clear();

            dispatcher.Execute("""{"cmd":"debugFrame"}""");

            Assert.Equal(
                CaptureLoop.DebugFrameDisabledCode,
                Assert.IsType<ErrorEvent>(Assert.Single(events)).Code);
        }
    }

    [Fact]
    public void SnapshotReturnsAFrameWithoutAnImage()
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine(debugFrameEnabled: true));
            events.Clear();

            dispatcher.Execute("""{"cmd":"snapshot"}""");

            var frame = Assert.IsType<FrameEvent>(Assert.Single(events));
            // Even with debugFrame enabled, `snapshot` is not `debugFrame`.
            Assert.Null(frame.ImagePng);
            Assert.Single(frame.Lines);
        }
    }

    // ------------------------------------------------------------------
    // Bad input never ends the process (invariant 4)
    // ------------------------------------------------------------------

    [Theory]
    [InlineData("""{"cmd":"recalibrate","passes":3}""")]
    [InlineData("""{"cmd":"start""")]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    [InlineData("null")]
    [InlineData("""{"seq":1}""")]
    [InlineData("""{"cmd":"configure","region":[0,0,64,16]}""")]
    public void AnUnusableLineIsAnErrorAndTheDispatcherKeepsWorking(string line)
    {
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(line);

            var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
            Assert.Equal(Dispatcher.UnknownCommandCode, error.Code);
            Assert.NotEmpty(error.Message);

            // The whole point: the next good command still works.
            dispatcher.Execute(ConfigureLine());
            Assert.Equal(SidecarState.Configured, dispatcher.State);
        }
    }

    [Fact]
    public void AConfigureMissingDebugFrameEnabledIsRejectedRatherThanDefaultedToFalse()
    {
        // The flag gates pixels crossing IPC. An omitted flag that silently became `false`
        // would read exactly like a flag the sender believed it had set.
        var (dispatcher, events, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(
                """{"cmd":"configure","region":[0,0,64,16],"monitorId":"\\\\.\\DISPLAY1","intervalActive":800,"intervalIdle":2000,"diffThreshold":0.02,"ocrLanguage":"en-US"}""");

            Assert.Equal(Dispatcher.UnknownCommandCode, Assert.IsType<ErrorEvent>(Assert.Single(events)).Code);
            Assert.Equal(SidecarState.Idle, dispatcher.State);
        }
    }
}
