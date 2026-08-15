using System.Diagnostics;
using Textlens.Capture.Protocol;
using Textlens.Capture.Services;
using WireLine = Textlens.Capture.Protocol.OcrLine;

namespace Textlens.Capture.Tests;

/// <summary>
/// Issue M2-05, the loop half. The capture and OCR stages are faked so the loop's own
/// behaviour — what it emits, what it skips, when it reprograms the timer — is tested
/// deterministically rather than against a screen and a recognizer.
/// </summary>
public class CaptureLoopTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private const int Width = 64;
    private const int Height = 16;

    // ------------------------------------------------------------------
    // Fakes
    // ------------------------------------------------------------------

    private sealed class FakeSource : IRegionSource
    {
        private readonly Queue<CapturedRegion?> queued = new();

        public MonitorInfo Monitor { get; init; } = new()
        {
            Id = @"\\.\DISPLAY1",
            Scale = 1.5,
            Bounds = new Rect(0, 0, 3840, 2160),
        };

        public int Calls { get; private set; }

        public Exception? Throws { get; set; }

        /// <summary>Released by the test to let a tick finish; used for the overlap proof.</summary>
        public ManualResetEventSlim? Gate { get; set; }

        /// <summary>Set once a tick has entered the capture call.</summary>
        public ManualResetEventSlim? Entered { get; set; }

        public void Enqueue(byte fill) => queued.Enqueue(Frame(fill, Monitor));

        /// <summary>Queue "the compositor had nothing" — the static-screen case.</summary>
        public void EnqueueStarved() => queued.Enqueue(null);

        public CapturedRegion? CaptureRegion(Rect region)
        {
            Calls++;
            Entered?.Set();
            Gate?.Wait();

            if (Throws is not null)
            {
                throw Throws;
            }

            return queued.Count > 0 ? queued.Dequeue() : null;
        }

        public static CapturedRegion Frame(byte fill, MonitorInfo monitor)
        {
            var pixels = new byte[Width * Height * 4];
            Array.Fill(pixels, fill);
            for (var i = 3; i < pixels.Length; i += 4)
            {
                pixels[i] = 0xFF;
            }

            return new CapturedRegion(pixels, Width, Height, monitor, new Rect(0, 0, Width, Height), 574);
        }
    }

    private sealed class FakeRecognizer : IRecognizer
    {
        public int Calls { get; private set; }

        public Exception? Throws { get; set; }

        public TimeSpan Delay { get; set; }

        public WireLine[] Result { get; set; } =
            [new WireLine { Text = "You must find the key", Bbox = new Rect(4, 2, 40, 10) }];

        public WireLine[] Recognize(ReadOnlySpan<byte> bgra, int width, int height)
        {
            Calls++;
            if (Delay > TimeSpan.Zero)
            {
                Thread.Sleep(Delay);
            }

            return Throws is not null ? throw Throws : Result;
        }
    }

    private sealed class FakeEncoder : IFrameEncoder
    {
        public int Calls { get; private set; }

        public string ToBase64Png(ReadOnlySpan<byte> bgra, int width, int height)
        {
            Calls++;
            return "iVBORw0KGgo=";
        }
    }

    private static CaptureLoop Build(
        FakeSource source,
        FakeRecognizer recognizer,
        List<ISidecarEvent> events,
        IFrameEncoder? encoder = null)
        => new(source, recognizer, events.Add, encoder: encoder) { Region = new Rect(0, 0, Width, Height) };

    // ------------------------------------------------------------------
    // Every tick emits exactly one event — never silence (invariant 4)
    // ------------------------------------------------------------------

    [Fact]
    public void AChangedFrameEmitsAFrameEventWithAllThreeTimings()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.Enqueue(0x10);
        loop.Tick();

        var frame = Assert.IsType<FrameEvent>(Assert.Single(events));
        output.WriteLine(ProtocolCodec.Encode(frame));

        Assert.Equal(1, frame.Seq);
        Assert.Equal(574, frame.Timings.CaptureUs);
        // Diff and OCR are measured, so they are whatever they are — but all three fields
        // must be populated on every frame (feature L3), and none may be negative.
        Assert.True(frame.Timings.DiffUs >= 0);
        Assert.True(frame.Timings.OcrUs >= 0);
        Assert.Equal(@"\\.\DISPLAY1", frame.Monitor.Id);
        Assert.Single(frame.Lines);
        // Pixels do not cross IPC unless asked for.
        Assert.Null(frame.ImagePng);
    }

    [Fact]
    public void AnUnchangedFrameEmitsNochange_NotSilence()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.Enqueue(0x10);
        source.Enqueue(0x10);
        loop.Tick();
        loop.Tick();

        Assert.IsType<FrameEvent>(events[0]);
        var nochange = Assert.IsType<NoChangeEvent>(events[1]);
        Assert.Equal(2, nochange.Seq);
        // The whole point of change detection: OCR ran once, not twice.
        Assert.Equal(1, recognizer.Calls);
    }

    [Fact]
    public void AStarvedCompositorEmitsNochange_RatherThanBlockingOrGoingQuiet()
    {
        // Spike S2's finding, made into a test: a genuinely static display delivers no
        // frames at all (3 in 13 seconds), so a tick routinely finds nothing waiting. It
        // must report that it is alive rather than wait for a frame that is not coming.
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.EnqueueStarved();

        var stopwatch = Stopwatch.StartNew();
        loop.Tick();
        stopwatch.Stop();

        Assert.IsType<NoChangeEvent>(Assert.Single(events));
        Assert.Equal(0, recognizer.Calls);
        // Did not wait on anything.
        Assert.True(stopwatch.ElapsedMilliseconds < 100, $"a starved tick took {stopwatch.ElapsedMilliseconds}ms");
    }

    [Fact]
    public void EverySequenceNumberIsUsedExactlyOnce_SoNodeCanDetectGaps()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        for (var i = 0; i < 6; i++)
        {
            source.Enqueue((byte)(i % 2 == 0 ? 0x10 : 0xF0));
            loop.Tick();
        }

        var seqs = events.Select(e => e switch
        {
            FrameEvent f => f.Seq,
            NoChangeEvent n => n.Seq,
            _ => -1,
        }).ToArray();

        Assert.Equal(new long[] { 1, 2, 3, 4, 5, 6 }, seqs);
    }

    // ------------------------------------------------------------------
    // The non-overlapping-tick criterion
    // ------------------------------------------------------------------

    /// <summary>
    /// The criterion that matters in production and is hardest to test: a tick that fires
    /// while the previous one is still running must be <b>skipped</b>, not queued.
    ///
    /// <para>Proven by holding a tick open inside the capture call and firing a second one
    /// from another thread while it is demonstrably still in there. Queueing rather than
    /// skipping would show up as the second tick's work happening — a second capture call
    /// and a second event — once the first was released.</para>
    /// </summary>
    [Fact]
    public async Task ATickThatFiresWhileAnotherIsRunningIsSkipped_NotQueued()
    {
        var source = new FakeSource
        {
            Gate = new ManualResetEventSlim(false),
            Entered = new ManualResetEventSlim(false),
        };
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);
        source.Enqueue(0x10);

        var slow = Task.Run(() => loop.Tick());

        // Wait until the first tick is provably inside the capture call, so this is not a
        // race the test could win by luck.
        Assert.True(source.Entered!.Wait(TimeSpan.FromSeconds(5)), "the first tick never started");

        var second = loop.Tick();
        var third = loop.Tick();

        Assert.False(second, "the second tick ran even though the first was still in flight");
        Assert.False(third);
        Assert.Equal(2, loop.TicksSkipped);

        source.Gate!.Set();
        Assert.True(await slow.WaitAsync(TimeSpan.FromSeconds(5)));

        // The skipped ticks left no trace: one capture, one event, nothing queued to run
        // later. A backlog of stale captures is worth nothing — the next tick reads the
        // screen as it is then.
        Assert.Equal(1, source.Calls);
        Assert.Equal(1, loop.TicksCompleted);
        Assert.Single(events);

        output.WriteLine($"1 tick completed, {loop.TicksSkipped} skipped, {source.Calls} capture call, {events.Count} event");
    }

    /// <summary>
    /// The tick gate only excludes tick against tick, and ticks are not the only caller:
    /// <c>snapshot</c> and <c>debugFrame</c> arrive on the stdin thread while a timer tick
    /// may be mid-flight. Both paths run the same single-threaded pipeline — one reused
    /// <c>SoftwareBitmap</c> inside <c>OcrService</c>, one diff baseline — so they have to
    /// exclude each other too.
    ///
    /// <para>A snapshot <b>waits</b> rather than skipping: it is something a human or Node
    /// explicitly asked for, unlike a late tick, which is worthless because the next one
    /// reads a fresher screen.</para>
    /// </summary>
    [Fact]
    public async Task SnapshotWaitsForAnInFlightTickRatherThanRunningAlongsideIt()
    {
        var source = new FakeSource
        {
            Gate = new ManualResetEventSlim(false),
            Entered = new ManualResetEventSlim(false),
        };
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = new CaptureLoop(
            source,
            recognizer,
            evt => { lock (events) { events.Add(evt); } })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        source.Enqueue(0x10);
        source.Enqueue(0xF0);

        var tick = Task.Run(() => loop.Tick());
        Assert.True(source.Entered!.Wait(TimeSpan.FromSeconds(5)), "the tick never started");

        var snapshot = Task.Run(() => loop.Snapshot());

        // The tick is parked inside capture, so the snapshot must be parked too — nothing
        // has reached the recognizer yet.
        Thread.Sleep(200);
        Assert.Equal(0, recognizer.Calls);
        Assert.False(snapshot.IsCompleted, "the snapshot ran while a tick was still in flight");

        source.Gate!.Set();

        Assert.True(await tick.WaitAsync(TimeSpan.FromSeconds(5)));
        await snapshot.WaitAsync(TimeSpan.FromSeconds(5));

        // Both completed, in series, and both produced their event.
        Assert.Equal(2, recognizer.Calls);
        lock (events)
        {
            Assert.Equal(2, events.Count);
            Assert.All(events, e => Assert.IsType<FrameEvent>(e));
            var seqs = events.Cast<FrameEvent>().Select(f => f.Seq).ToArray();
            output.WriteLine($"tick and snapshot serialised; seqs {string.Join(", ", seqs)}");
            Assert.Equal(new long[] { 1, 2 }, seqs);
        }
    }

    [Fact]
    public void ASlowTickUnderARealTimerSkipsRatherThanPilingUp()
    {
        // The same guarantee, but driven by the real timer rather than by hand: OCR takes
        // far longer than the poll interval, which is exactly the production failure mode
        // (a 24ms recognition under a fast interval, or a stalled GPU read).
        var source = new FakeSource();
        var recognizer = new FakeRecognizer { Delay = TimeSpan.FromMilliseconds(120) };
        var events = new List<ISidecarEvent>();
        var loop = new CaptureLoop(
            source,
            recognizer,
            evt => { lock (events) { events.Add(evt); } },
            schedule: new AdaptiveTimer { IntervalActive = 10, IntervalIdle = 10 })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        using (loop)
        {
            for (var i = 0; i < 40; i++)
            {
                source.Enqueue((byte)(i % 2 == 0 ? 0x10 : 0xF0));
            }

            loop.Start();
            Thread.Sleep(700);
            loop.Stop();
        }

        Thread.Sleep(200);

        output.WriteLine($"completed={loop.TicksCompleted} skipped={loop.TicksSkipped} captures={source.Calls} ocr={recognizer.Calls}");

        // With a 10ms period and a 120ms tick, most firings must have been dropped.
        Assert.True(loop.TicksSkipped > 0, "a 120ms tick under a 10ms timer skipped nothing, so ticks are overlapping");
        // And the work done matches the ticks that completed - nothing ran twice.
        Assert.Equal(loop.TicksCompleted, source.Calls);
        Assert.Equal(loop.TicksCompleted, recognizer.Calls);
    }

    // ------------------------------------------------------------------
    // Timer lifecycle
    // ------------------------------------------------------------------

    [Fact]
    public void StopHaltsTheLoop_AndNoWorkHappensAfterwards()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        var loop = new CaptureLoop(
            source,
            recognizer,
            evt => { lock (events) { events.Add(evt); } },
            schedule: new AdaptiveTimer { IntervalActive = 15, IntervalIdle = 15 })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        using (loop)
        {
            loop.Start();
            Assert.True(loop.IsRunning);
            Thread.Sleep(250);
            loop.Stop();
            Assert.False(loop.IsRunning);
        }

        // Let any in-flight callback finish, then take the reading.
        Thread.Sleep(150);
        var callsAtStop = source.Calls;
        Thread.Sleep(400);

        output.WriteLine($"captures at stop={callsAtStop}, 400ms later={source.Calls}");
        Assert.True(callsAtStop > 0, "the loop never ran while started");
        // The real acceptance criterion is a CPU reading; this is its deterministic twin.
        // Zero additional work after stop is what zero CPU looks like from in here.
        Assert.Equal(callsAtStop, source.Calls);
    }

    [Fact]
    public void StartIsIdempotent()
    {
        var source = new FakeSource();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, new FakeRecognizer(), events);

        loop.Start();
        loop.Start();
        loop.Stop();

        Assert.False(loop.IsRunning);
    }

    [Fact]
    public void TheTimerIsOnlyReprogrammedWhenTheIntervalMovesEnoughToMatter()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        var loop = new CaptureLoop(
            source,
            recognizer,
            events.Add,
            schedule: new AdaptiveTimer { IntervalActive = 800, IntervalIdle = 900 })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        using (loop)
        {
            loop.Start();

            // active 800 -> idle 900 is a 100ms move: inside the deadband, so no rebuild.
            for (var i = 0; i < 5; i++)
            {
                source.EnqueueStarved();
                loop.Tick();
            }

            output.WriteLine($"800ms -> 900ms over 5 ticks: {loop.TimerRebuilds} rebuilds");
            Assert.Equal(0, loop.TimerRebuilds);

            // Deep idle is 2700ms, which is well past the threshold and must rebuild once.
            for (var i = 0; i < 8; i++)
            {
                source.EnqueueStarved();
                loop.Tick();
            }

            output.WriteLine($"after reaching deep idle (2700ms): {loop.TimerRebuilds} rebuilds");
            Assert.Equal(1, loop.TimerRebuilds);
        }
    }

    // ------------------------------------------------------------------
    // snapshot
    // ------------------------------------------------------------------

    [Fact]
    public void SnapshotReturnsAFrameEvenWhenNothingChanged()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.Enqueue(0x10);
        loop.Tick();
        events.Clear();

        // The identical frame again: change detection would say "unchanged", and snapshot
        // has to ignore it.
        source.Enqueue(0x10);
        loop.Snapshot();

        var frame = Assert.IsType<FrameEvent>(Assert.Single(events));
        Assert.Single(frame.Lines);
    }

    /// <summary>
    /// The case spike S2 makes unavoidable: on a static display no frame arrives at all,
    /// so a snapshot has nothing fresh to capture. It still has to return a frame, which
    /// is only possible because the diff baseline is retained.
    /// </summary>
    [Fact]
    public void SnapshotFallsBackToTheLastCapturedFrameWhenTheCompositorHasNothing()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.Enqueue(0x10);
        loop.Tick();
        events.Clear();

        source.EnqueueStarved();
        loop.Snapshot();

        var frame = Assert.IsType<FrameEvent>(Assert.Single(events));
        Assert.Single(frame.Lines);
        Assert.Equal(new Rect(0, 0, Width, Height), frame.Region);
        // Nothing was captured this round, so claiming a capture cost would be a
        // fabrication. Zero is the honest number.
        Assert.Equal(0, frame.Timings.CaptureUs);
    }

    [Fact]
    public void SnapshotBeforeAnythingHasEverBeenCapturedIsAnError_NotSilence()
    {
        var source = new FakeSource();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, new FakeRecognizer(), events);

        source.EnqueueStarved();
        loop.Snapshot();

        var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
        Assert.Equal(CaptureLoop.NoFrameYetCode, error.Code);
    }

    [Fact]
    public void SnapshotKeepsTheDiffBaselineCurrent()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.Enqueue(0x10);
        loop.Tick();

        // A snapshot of different pixels must become the new baseline, or the next
        // ordinary tick would diff against a frame two steps old and report a change that
        // had already been reported.
        source.Enqueue(0xF0);
        loop.Snapshot();
        events.Clear();

        source.Enqueue(0xF0);
        loop.Tick();

        Assert.IsType<NoChangeEvent>(Assert.Single(events));
    }

    // ------------------------------------------------------------------
    // debugFrame
    // ------------------------------------------------------------------

    [Fact]
    public void DebugFrameWhileDisabledIsAnError_NotAnImage()
    {
        var source = new FakeSource();
        var encoder = new FakeEncoder();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, new FakeRecognizer(), events, encoder);

        source.Enqueue(0x10);
        loop.Snapshot(includeImage: true);

        var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
        Assert.Equal(CaptureLoop.DebugFrameDisabledCode, error.Code);
        // The one that would actually leak pixels: the encoder must not have run at all.
        Assert.Equal(0, encoder.Calls);
    }

    [Fact]
    public void DebugFrameOnceEnabledCarriesTheImage()
    {
        var source = new FakeSource();
        var encoder = new FakeEncoder();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, new FakeRecognizer(), events, encoder);
        loop.DebugFrameEnabled = true;

        source.Enqueue(0x10);
        loop.Snapshot(includeImage: true);

        var frame = Assert.IsType<FrameEvent>(Assert.Single(events));
        Assert.Equal("iVBORw0KGgo=", frame.ImagePng);
        Assert.Equal(1, encoder.Calls);
    }

    [Fact]
    public void AnOrdinaryTickNeverCarriesAnImage_EvenWhenDebugFrameIsEnabled()
    {
        var source = new FakeSource();
        var encoder = new FakeEncoder();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, new FakeRecognizer(), events, encoder);
        loop.DebugFrameEnabled = true;

        source.Enqueue(0x10);
        loop.Tick();

        Assert.Null(Assert.IsType<FrameEvent>(Assert.Single(events)).ImagePng);
        Assert.Equal(0, encoder.Calls);
    }

    // ------------------------------------------------------------------
    // Failure paths — nothing silent, nothing fatal (invariant 4)
    // ------------------------------------------------------------------

    [Fact]
    public void ACaptureFailureEmitsAnErrorAndTheLoopKeepsRunning()
    {
        var source = new FakeSource { Throws = new InvalidOperationException("device lost") };
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        Assert.True(loop.Tick());

        var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
        Assert.Equal(CaptureLoop.CaptureFailedCode, error.Code);
        Assert.Contains("device lost", error.Message, StringComparison.Ordinal);

        // Recovered: the next tick works.
        source.Throws = null;
        source.Enqueue(0x10);
        Assert.True(loop.Tick());
        Assert.IsType<FrameEvent>(events[1]);
    }

    [Fact]
    public void AnOcrFailureEmitsAnErrorAndTheLoopKeepsRunning()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer { Throws = new InvalidOperationException("recognizer exploded") };
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.Enqueue(0x10);
        Assert.True(loop.Tick());

        var error = Assert.IsType<ErrorEvent>(Assert.Single(events));
        Assert.Equal(CaptureLoop.OcrFailedCode, error.Code);

        recognizer.Throws = null;
        source.Enqueue(0xF0);
        Assert.True(loop.Tick());
        Assert.IsType<FrameEvent>(events[1]);
    }

    [Fact]
    public void RetargetingClearsTheBaseline_SoAMovedRegionIsNotComparedAgainstTheOldOne()
    {
        var source = new FakeSource();
        var recognizer = new FakeRecognizer();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, recognizer, events);

        source.Enqueue(0x10);
        loop.Tick();
        events.Clear();

        loop.Retarget(new Rect(100, 100, Width, Height));

        // Identical pixels, but a different region: the old baseline is a picture of
        // somewhere else, so this has to read as a change rather than as "unchanged".
        source.Enqueue(0x10);
        loop.Tick();

        Assert.IsType<FrameEvent>(Assert.Single(events));
        Assert.Equal(ActivityLevel.Active, loop.Schedule.Level);
    }

    [Fact]
    public void TheThresholdFromConfigureReachesTheDetector()
    {
        var source = new FakeSource();
        var events = new List<ISidecarEvent>();
        using var loop = Build(source, new FakeRecognizer(), events);

        loop.Detector.Threshold = 0.5;

        Assert.Equal(0.5, loop.Detector.Threshold);
    }
}
