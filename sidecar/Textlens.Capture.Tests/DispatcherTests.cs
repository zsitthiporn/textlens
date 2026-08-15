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
        public int SourcesOpened { get; private set; }

        public int RecognizersCreated { get; private set; }

        public string? LastMonitorId { get; private set; }

        public Exception? OpenThrows { get; set; }

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

            SourcesOpened++;
            LastMonitorId = monitorId;
            return new FakeSource();
        }

        public IRecognizer CreateRecognizer(string languageTag)
        {
            RecognizersCreated++;
            return new FakeRecognizer();
        }

        public IFrameEncoder? CreateEncoder() => new FakeEncoder();
    }

    /// <summary>
    /// Disposable and strict about it. The real <see cref="CaptureService"/> throws
    /// <see cref="ObjectDisposedException"/> once disposed, and a fake that quietly kept
    /// working would hide the exact bug
    /// <see cref="ReconfiguringOnANewMonitorDoesNotLeaveTheOldLoopFiring"/> exists to catch.
    /// </summary>
    private sealed class FakeSource : IRegionSource, IDisposable
    {
        public MonitorInfo Monitor { get; } = new()
        {
            Id = @"\\.\DISPLAY1",
            Scale = 1.5,
            Bounds = new Rect(0, 0, 3840, 2160),
        };

        private byte fill = 0x10;
        private bool disposed;

        public CapturedRegion? CaptureRegion(Rect region)
        {
            ObjectDisposedException.ThrowIf(disposed, this);

            var pixels = new byte[Width * Height * 4];
            Array.Fill(pixels, fill);
            fill = (byte)(fill == 0x10 ? 0xF0 : 0x10);
            return new CapturedRegion(pixels, Width, Height, Monitor, new Rect(0, 0, Width, Height), 574);
        }

        public void Dispose() => disposed = true;
    }

    private sealed class FakeRecognizer : IRecognizer
    {
        public WireLine[] Recognize(ReadOnlySpan<byte> bgra, int width, int height)
            => [new WireLine { Text = "You must find the key", Bbox = new Rect(4, 2, 40, 10) }];
    }

    private sealed class FakeEncoder : IFrameEncoder
    {
        public string ToBase64Png(ReadOnlySpan<byte> bgra, int width, int height) => "iVBORw0KGgo=";
    }

    private static string ConfigureLine(
        string monitorId = @"\\\\.\\DISPLAY1",
        int intervalActive = 800,
        bool debugFrameEnabled = false)
        => $$"""
             {"cmd":"configure","region":[0,0,64,16],"monitorId":"{{monitorId}}","intervalActive":{{intervalActive}},"intervalIdle":2000,"diffThreshold":0.02,"ocrLanguage":"en-US","debugFrameEnabled":{{(debugFrameEnabled ? "true" : "false")}}}
             """;

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

    [Fact]
    public void ConfigureCarriesTheThresholdAndIntervalsThrough()
    {
        var (dispatcher, _, _) = Build();
        using (dispatcher)
        {
            dispatcher.Execute(ConfigureLine());

            Assert.Equal(0.02, dispatcher.Loop!.Detector.Threshold);
            Assert.Equal(800, dispatcher.Loop.Schedule.IntervalActive);
            Assert.Equal(2000, dispatcher.Loop.Schedule.IntervalIdle);
            Assert.False(dispatcher.Loop.DebugFrameEnabled);
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
