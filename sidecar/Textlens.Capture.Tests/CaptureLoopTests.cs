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

    /// <summary>
    /// How many pipeline calls — captures and recognitions together — are running at once.
    ///
    /// <para>The non-overlap guarantee, measured where it matters rather than inferred from
    /// a skip counter: if two ticks ever ran together, one of them would enter the source or
    /// the recognizer while the other was still inside, and <see cref="Max"/> would read 2.
    /// That holds however the pool schedules the timer — which is what the old
    /// <c>TicksSkipped &gt; 0</c> assertion did not (#72).</para>
    /// </summary>
    internal sealed class Occupancy
    {
        private int inside;
        private int max;

        public int Max => Volatile.Read(ref max);

        public void Enter()
        {
            var now = Interlocked.Increment(ref inside);
            int seen;
            while (now > (seen = Volatile.Read(ref max)) && Interlocked.CompareExchange(ref max, now, seen) != seen)
            {
            }
        }

        public void Leave() => Interlocked.Decrement(ref inside);
    }

    private sealed class FakeSource : IRegionSource
    {
        private readonly Queue<CapturedRegion?> queued = new();
        private int calls;
        private int alternate;

        public MonitorInfo Monitor { get; init; } = new()
        {
            Id = @"\\.\DISPLAY1",
            Scale = 1.5,
            Bounds = new Rect(0, 0, 3840, 2160),
        };

        public int Calls => Volatile.Read(ref calls);

        public Exception? Throws { get; set; }

        /// <summary>Released by the test to let a tick finish; used for the overlap proof.</summary>
        public ManualResetEventSlim? Gate { get; set; }

        /// <summary>Set once a tick has entered the capture call.</summary>
        public ManualResetEventSlim? Entered { get; set; }

        /// <summary>Shared with the recognizer to measure overlap.</summary>
        public Occupancy? Pipeline { get; init; }

        /// <summary>
        /// Once the queue is empty, keep delivering frames that differ from the last one,
        /// so a real-timer test can run as many ticks as it waits for.
        /// </summary>
        public bool EndlesslyChanging { get; init; }

        public void Enqueue(byte fill)
        {
            lock (queued)
            {
                queued.Enqueue(Frame(fill, Monitor));
            }
        }

        /// <summary>Queue "the compositor had nothing" — the static-screen case.</summary>
        public void EnqueueStarved()
        {
            lock (queued)
            {
                queued.Enqueue(null);
            }
        }

        /// <summary>Managed thread id of the first caller, or 0 before any call.</summary>
        public int FirstCallerThreadId => Volatile.Read(ref firstCaller);

        /// <summary>
        /// Runs once, on the first caller's thread, inside the capture call — and so while
        /// that caller holds the loop's work lock.
        /// </summary>
        public Action? OnFirstEnter
        {
            get => onFirstEnter;
            init => onFirstEnter = value;
        }

        private int firstCaller;
        private Action? onFirstEnter;

        public CapturedRegion? CaptureRegion(Rect region)
        {
            Pipeline?.Enter();
            try
            {
                Interlocked.CompareExchange(ref firstCaller, Environment.CurrentManagedThreadId, 0);
                Interlocked.Increment(ref calls);
                Interlocked.Exchange(ref onFirstEnter, null)?.Invoke();
                Entered?.Set();
                Gate?.Wait();

                if (Throws is not null)
                {
                    throw Throws;
                }

                lock (queued)
                {
                    if (queued.Count > 0)
                    {
                        return queued.Dequeue();
                    }
                }

                return EndlesslyChanging
                    ? Frame((byte)(Interlocked.Increment(ref alternate) % 2 == 0 ? 0x10 : 0xF0), Monitor)
                    : null;
            }
            finally
            {
                Pipeline?.Leave();
            }
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
        private int calls;

        public int Calls => Volatile.Read(ref calls);

        public Exception? Throws { get; set; }

        public TimeSpan Delay { get; set; }

        /// <summary>Shared with the source to measure overlap.</summary>
        public Occupancy? Pipeline { get; init; }

        public WireLine[] Result { get; set; } =
            [new WireLine { Text = "You must find the key", Bbox = new Rect(4, 2, 40, 10) }];

        public WireLine[] Recognize(ReadOnlySpan<byte> bgra, int width, int height)
        {
            Pipeline?.Enter();
            try
            {
                Interlocked.Increment(ref calls);
                if (Delay > TimeSpan.Zero)
                {
                    Thread.Sleep(Delay);
                }

                return Throws is not null ? throw Throws : Result;
            }
            finally
            {
                Pipeline?.Leave();
            }
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

        // On their own thread, with a deadline, and the first tick released whatever happens:
        // a tick that queued behind the parked one instead of being skipped would otherwise
        // hang this test — and then its Dispose — forever rather than fail it, which is how
        // removing the skip gate first showed up in #83's mutation run.
        try
        {
            var second = true;
            var third = true;
            var firing = new Thread(() =>
            {
                second = loop.Tick();
                third = loop.Tick();
            });
            firing.Start();
            Assert.True(
                firing.Join(TimeSpan.FromSeconds(5)),
                "the second tick waited for the first to finish instead of being skipped");

            Assert.False(second, "the second tick ran even though the first was still in flight");
            Assert.False(third);
            Assert.Equal(2, loop.TicksSkipped);
        }
        finally
        {
            source.Gate!.Set();
        }

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

        // Released whatever happens: since #83, Dispose waits for the tick in flight, so a
        // failed assertion that left this tick parked would hang the test instead of
        // failing it.
        try
        {
            // The tick is parked inside capture, so the snapshot must be parked too —
            // nothing has reached the recognizer yet.
            Thread.Sleep(200);
            Assert.Equal(0, recognizer.Calls);
            Assert.False(snapshot.IsCompleted, "the snapshot ran while a tick was still in flight");
        }
        finally
        {
            source.Gate!.Set();
        }

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

    /// <summary>
    /// The same guarantee driven by the real timer rather than by hand: OCR takes far longer
    /// than the poll interval, which is exactly the production failure mode (a slow
    /// recognition under a fast interval, or a stalled GPU read).
    ///
    /// <para><b>What this asserts, and what it no longer does (#72).</b> It used to assert
    /// <c>TicksSkipped &gt; 0</c> after a fixed 700ms, and failed on CI 2 runs of 2 with
    /// <c>skipped=0</c>. The reviewer reproduced that shape by starving the thread pool: a
    /// timer callback is a pool work item, and a starved pool runs them one after another,
    /// so no firing ever finds another tick in flight and there is nothing to skip. A skip
    /// needs two pool threads at once — it measures pool availability, not overlap. The
    /// property that matters is the one measured here directly: never more than one
    /// pipeline call at a time, nothing run twice, and nothing left to run after stop. The
    /// skip itself is proven deterministically by
    /// <see cref="ATickThatFiresWhileAnotherIsRunningIsSkipped_NotQueued"/>.</para>
    /// </summary>
    [Fact]
    public void ASlowTickUnderARealTimerNeverOverlapsAndLeavesNoBacklog()
    {
        var outcome = RunSlowTickUnderARealTimer(target: 4, timeout: TimeSpan.FromSeconds(15));
        output.WriteLine(outcome.ToString());
        AssertSlowTickHeld(outcome);
    }

    internal readonly record struct SlowTickOutcome(
        bool ReachedTarget,
        TimeSpan FirstWorkAfter,
        TimeSpan Elapsed,
        int Completed,
        int Skipped,
        int Captures,
        int Recognitions,
        int MaxInside,
        int CapturesAfterStop);

    /// <summary>
    /// Runs a 120ms tick under a 10ms timer until <paramref name="target"/> recognitions
    /// have happened or <paramref name="timeout"/> passes. Waits for work rather than for a
    /// fixed time, so a pool that is slow to run the timer costs time, not the verdict.
    /// </summary>
    internal static SlowTickOutcome RunSlowTickUnderARealTimer(int target, TimeSpan timeout)
    {
        var pipeline = new Occupancy();
        var source = new FakeSource { Pipeline = pipeline, EndlesslyChanging = true };
        var recognizer = new FakeRecognizer { Pipeline = pipeline, Delay = TimeSpan.FromMilliseconds(120) };
        var loop = new CaptureLoop(
            source,
            recognizer,
            _ => { },
            schedule: new AdaptiveTimer { IntervalActive = 10, IntervalIdle = 10 })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        var stopwatch = Stopwatch.StartNew();
        bool reached;
        TimeSpan firstWork;
        using (loop)
        {
            loop.Start();
            WaitUntil(() => source.Calls >= 1, timeout);
            firstWork = stopwatch.Elapsed;
            reached = WaitUntil(() => recognizer.Calls >= target, timeout);
            loop.Stop();
        }

        stopwatch.Stop();
        var captures = source.Calls;

        // Not a settling delay — Stop is a barrier, so nothing is left to settle. This is
        // the window in which a backlog of queued ticks would show itself if there were one.
        Thread.Sleep(100);

        return new SlowTickOutcome(
            reached,
            firstWork,
            stopwatch.Elapsed,
            loop.TicksCompleted,
            loop.TicksSkipped,
            captures,
            recognizer.Calls,
            pipeline.Max,
            source.Calls - captures);
    }

    internal static void AssertSlowTickHeld(SlowTickOutcome outcome)
    {
        Assert.True(outcome.ReachedTarget, $"the loop never got through its ticks: {outcome}");
        Assert.True(outcome.MaxInside == 1, $"two ticks ran at once: {outcome}");
        // Every tick that ran did its capture and its recognition exactly once.
        Assert.Equal(outcome.Completed, outcome.Captures);
        Assert.Equal(outcome.Completed, outcome.Recognitions);
        Assert.Equal(0, outcome.CapturesAfterStop);
    }

    // ------------------------------------------------------------------
    // Timer lifecycle
    // ------------------------------------------------------------------

    /// <summary>
    /// <para>Rewritten for #72. It used to sleep 250ms, stop, sleep 150ms "to let any
    /// in-flight callback finish", and assert the capture count was above zero — which CI
    /// failed with <c>captures at stop=0</c>: on a starved pool the timer's first callback
    /// had not run within 250ms. It now waits for the loop to have run, however long the
    /// pool takes, and needs no settling sleep, because <see cref="CaptureLoop.Stop"/> no
    /// longer returns until the tick in flight has finished.</para>
    /// </summary>
    [Fact]
    public void StopHaltsTheLoop_AndNoWorkHappensAfterwards()
    {
        var outcome = RunStopHaltsTheLoop(target: 3, timeout: TimeSpan.FromSeconds(15));
        output.WriteLine(outcome.ToString());
        AssertStopHeld(outcome);
    }

    internal readonly record struct StopOutcome(
        bool ReachedTarget,
        TimeSpan FirstWorkAfter,
        bool RunningBeforeStop,
        bool RunningAfterStop,
        int CapturesAtStop,
        int CapturesLater);

    internal static StopOutcome RunStopHaltsTheLoop(int target, TimeSpan timeout)
    {
        var source = new FakeSource();
        var loop = new CaptureLoop(
            source,
            new FakeRecognizer(),
            _ => { },
            schedule: new AdaptiveTimer { IntervalActive = 15, IntervalIdle = 15 })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        bool reached;
        bool runningBefore;
        bool runningAfter;
        int atStop;
        TimeSpan firstWork;
        var stopwatch = Stopwatch.StartNew();
        using (loop)
        {
            loop.Start();
            runningBefore = loop.IsRunning;
            WaitUntil(() => source.Calls >= 1, timeout);
            firstWork = stopwatch.Elapsed;
            reached = WaitUntil(() => source.Calls >= target, timeout);
            loop.Stop();
            atStop = source.Calls;
            runningAfter = loop.IsRunning;
        }

        // 26 periods of the old timer: long enough for any callback it had already handed
        // the pool to run, and do nothing.
        Thread.Sleep(400);
        return new StopOutcome(reached, firstWork, runningBefore, runningAfter, atStop, source.Calls);
    }

    internal static void AssertStopHeld(StopOutcome outcome)
    {
        Assert.True(outcome.RunningBeforeStop);
        Assert.True(outcome.ReachedTarget, $"the loop never ran while started: {outcome}");
        Assert.False(outcome.RunningAfterStop);
        // The real acceptance criterion is a CPU reading; this is its deterministic twin.
        // Zero additional work after stop is what zero CPU looks like from in here.
        Assert.Equal(outcome.CapturesAtStop, outcome.CapturesLater);
    }

    internal static bool WaitUntil(Func<bool> condition, TimeSpan timeout)
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

    /// <summary>
    /// <see cref="CaptureLoop.Stop"/> is a barrier: it returns only after the tick in flight
    /// has finished, so its event lands before Stop returns and nothing lands after.
    ///
    /// <para>Before #83 Stop disposed the timer and returned at once. A tick parked inside
    /// the capture call went on to emit after Stop had returned — after <c>ack stopped</c>
    /// had gone out — and the dispatcher went on to dispose the source it was inside.</para>
    /// </summary>
    [Fact]
    public void StopWaitsForTheTickInFlight_AndNothingRunsAfterIt()
    {
        using var gate = new ManualResetEventSlim(false);
        using var entered = new ManualResetEventSlim(false);
        var source = new FakeSource { Gate = gate, Entered = entered, EndlesslyChanging = true };
        var events = new List<ISidecarEvent>();
        using var loop = new CaptureLoop(
            source,
            new FakeRecognizer(),
            evt => { lock (events) { events.Add(evt); } },
            schedule: new AdaptiveTimer { IntervalActive = 10, IntervalIdle = 10 })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        loop.Start();
        Assert.True(entered.Wait(TimeSpan.FromSeconds(10)), "the first tick never reached the capture call");

        var eventsWhenStopReturned = -1;
        var stopper = new Thread(() =>
        {
            loop.Stop();
            lock (events)
            {
                eventsWhenStopReturned = events.Count;
            }
        });
        stopper.Start();

        // Long enough for a Stop that does not wait to have returned already.
        Thread.Sleep(100);
        gate.Set();
        Assert.True(stopper.Join(TimeSpan.FromSeconds(10)), "Stop never returned");

        var capturesAtStop = source.Calls;
        Thread.Sleep(200);

        output.WriteLine($"events when Stop returned={eventsWhenStopReturned}, events now={events.Count}, captures at stop={capturesAtStop}, now={source.Calls}");

        // The parked tick's frame is in before Stop returned — not after.
        Assert.True(eventsWhenStopReturned >= 1, "Stop returned before the tick in flight had emitted");
        Assert.Equal(eventsWhenStopReturned, events.Count);
        Assert.Equal(capturesAtStop, source.Calls);
    }

    /// <summary>
    /// A timer callback the pool delivers after Stop — dispatched before the timer was
    /// disposed, but not yet through the lock — must do nothing.
    ///
    /// <para><see cref="Timer.Dispose()"/> cannot promise that; it stops future firings but
    /// does not recall one already queued. The loop tags each callback with the generation
    /// of the timer that fired it and turns away stale ones under the lock.</para>
    ///
    /// <para>Made deterministic by parking a <b>snapshot</b> in the capture call: snapshots
    /// hold the work lock without taking the tick gate, so the next timer callback gets
    /// through the gate and queues on the lock behind it (visible as the firings after it
    /// being skipped). The timer is started from inside that capture call, on the thread
    /// holding the lock, so no tick can have got there first. Stop is then called from
    /// inside the snapshot's own emit — the same thread, still holding the lock — so it is
    /// guaranteed to complete before the queued callback gets in. Without the generation
    /// check that callback runs a full tick after Stop.</para>
    /// </summary>
    [Fact]
    public void ACallbackQueuedBeforeStopDoesNothingAfterIt()
    {
        using var gate = new ManualResetEventSlim(false);
        using var entered = new ManualResetEventSlim(false);
        CaptureLoop? loop = null;
        var source = new FakeSource
        {
            Gate = gate,
            Entered = entered,
            EndlesslyChanging = true,
            // Re-entrant: this thread already holds the work lock that Start takes.
            OnFirstEnter = () => loop!.Start(),
        };
        var capturesAtStop = -1;

        void Emit(ISidecarEvent evt)
        {
            if (evt is FrameEvent && capturesAtStop < 0)
            {
                loop!.Stop();
                capturesAtStop = source.Calls;
            }
        }

        loop = new CaptureLoop(
            source,
            new FakeRecognizer(),
            Emit,
            schedule: new AdaptiveTimer { IntervalActive = 10, IntervalIdle = 10 })
        {
            Region = new Rect(0, 0, Width, Height),
        };

        using (loop)
        {
            var snapshot = new Thread(() => loop.Snapshot());
            snapshot.Start();

            // Released whatever happens: a failed assertion here must not leave the snapshot
            // parked holding the lock that Dispose is about to wait on.
            try
            {
                Assert.True(entered.Wait(TimeSpan.FromSeconds(10)), "the snapshot never reached the capture call");
                Assert.True(
                    source.FirstCallerThreadId == snapshot.ManagedThreadId,
                    "a tick reached the capture call before the snapshot did; the premise of this test did not hold");

                // Positive control: a callback got through the tick gate and is waiting on
                // the lock — that is the only way later firings are counted as skipped.
                Assert.True(
                    WaitUntil(() => loop.TicksSkipped > 0, TimeSpan.FromSeconds(10)),
                    "no timer callback ever queued behind the snapshot");
            }
            finally
            {
                gate.Set();
            }

            Assert.True(snapshot.Join(TimeSpan.FromSeconds(10)), "the snapshot never finished");

            Thread.Sleep(200);
        }

        output.WriteLine($"captures at stop={capturesAtStop}, now={source.Calls}, completed ticks={loop.TicksCompleted}");

        Assert.Equal(1, capturesAtStop);
        Assert.Equal(capturesAtStop, source.Calls);
        Assert.Equal(0, loop.TicksCompleted);
    }

    /// <summary>
    /// An <c>emit</c> that throws on a timer tick must not take the process down.
    ///
    /// <para>Every other failure in a tick is already caught and reported as an error event;
    /// <c>emit</c> itself is the one call that was outside every try. It throws when stdout
    /// is gone — disposed during shutdown, or a pipe broken because Node went away — and an
    /// exception escaping a timer callback terminates the process: exit -1 where the
    /// protocol promises 0 (the reviewer executed it at shutdown).</para>
    ///
    /// <para><b>Why this watches the UnhandledException event rather than "did we survive".</b>
    /// Measured on .NET 10: the event fires ~60ms after the throw, but the process only dies
    /// ~3.9s later — the crash path stalls first. A test that finishes inside that window
    /// passes on the broken code, and this one did, until it was changed to look at the
    /// event. If this regresses, expect the assertion below to fail and then the test host
    /// to die a few seconds later, aborting the run — loud, which is the point.</para>
    /// </summary>
    [Fact]
    public void AnEmitThatThrowsOnATimerTickDoesNotEndTheProcess()
    {
        var marker = $"stdout is gone ({Guid.NewGuid():N})";
        var attempts = 0;
        var escaped = 0;

        void OnUnhandled(object sender, UnhandledExceptionEventArgs e)
        {
            if (e.ExceptionObject is Exception ex && ex.Message.Contains(marker, StringComparison.Ordinal))
            {
                Interlocked.Increment(ref escaped);
            }
        }

        AppDomain.CurrentDomain.UnhandledException += OnUnhandled;
        try
        {
            var source = new FakeSource();
            using var loop = new CaptureLoop(
                source,
                new FakeRecognizer(),
                _ =>
                {
                    Interlocked.Increment(ref attempts);
                    throw new ObjectDisposedException(marker);
                },
                schedule: new AdaptiveTimer { IntervalActive = 10, IntervalIdle = 10 })
            {
                Region = new Rect(0, 0, Width, Height),
            };

            loop.Start();
            var fired = WaitUntil(() => Volatile.Read(ref attempts) >= 3, TimeSpan.FromSeconds(15));
            loop.Stop();

            // The event is raised on the throwing thread as the exception leaves the
            // callback, so by now it has had several periods to show up.
            Thread.Sleep(100);

            output.WriteLine($"emit threw {attempts} times on timer threads; escaped the callback {escaped} times; captures={source.Calls}");
            Assert.True(fired, "the timer never got to emit");
            Assert.Equal(0, Volatile.Read(ref escaped));
        }
        finally
        {
            AppDomain.CurrentDomain.UnhandledException -= OnUnhandled;
        }
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

    // ------------------------------------------------------------------
    // ApplyConfiguration — the configure payload, all or nothing
    // ------------------------------------------------------------------

    /// <summary>
    /// Replaces a test that set <c>Detector.Threshold</c> directly and read it back — it
    /// never went through configure at all, so it could not notice configure dropping the
    /// value. Every value here differs from its default, so a dropped assignment fails.
    /// </summary>
    [Fact]
    public void ApplyConfigurationLandsEveryValue()
    {
        var events = new List<ISidecarEvent>();
        using var loop = Build(new FakeSource(), new FakeRecognizer(), events);

        loop.ApplyConfiguration(new Rect(10, 20, Width, Height), 0.037, 345, 1234, debugFrameEnabled: true);

        Assert.Equal(0.037, loop.Detector.Threshold);
        Assert.Equal(345, loop.Schedule.IntervalActive);
        Assert.Equal(1234, loop.Schedule.IntervalIdle);
        Assert.True(loop.DebugFrameEnabled);
        Assert.Equal(new Rect(10, 20, Width, Height), loop.Region);
    }

    [Theory]
    [InlineData(0.5, 345, 0, "intervalIdle")]
    [InlineData(0.5, 0, 1234, "intervalActive")]
    [InlineData(1.5, 345, 1234, "value")]
    [InlineData(double.NaN, 345, 1234, "value")]
    public void ApplyConfigurationThatFailsValidationAppliesNothing(
        double threshold,
        int intervalActive,
        int intervalIdle,
        string rejected)
    {
        var events = new List<ISidecarEvent>();
        using var loop = Build(new FakeSource(), new FakeRecognizer(), events);
        loop.ApplyConfiguration(new Rect(0, 0, Width, Height), 0.02, 800, 2000, debugFrameEnabled: false);

        var error = Assert.Throws<ArgumentOutOfRangeException>(() =>
            loop.ApplyConfiguration(new Rect(10, 20, Width, Height), threshold, intervalActive, intervalIdle, debugFrameEnabled: true));

        output.WriteLine(error.Message);

        // Not one of the values that were fine landed either.
        Assert.Equal(0.02, loop.Detector.Threshold);
        Assert.Equal(800, loop.Schedule.IntervalActive);
        Assert.Equal(2000, loop.Schedule.IntervalIdle);
        Assert.False(loop.DebugFrameEnabled);
        Assert.Equal(new Rect(0, 0, Width, Height), loop.Region);

        // And the refusal names the field, not the setter's "value".
        Assert.Equal(rejected, error.ParamName);
    }
}

/// <summary>
/// The thread-pool starvation that #72's CI failures came from, reproduced on purpose.
///
/// <para>A <see cref="Timer"/> callback is a pool work item. On a machine where every pool
/// thread is busy — a small shared CI VM running the other test classes in parallel, or a
/// user's machine mid-game — the timer's callbacks wait in the queue and then run one
/// after another. The old real-timer tests assumed a fixed window was enough for the loop
/// to run (<c>captures at stop=0</c>) and that firings would overlap often enough to be
/// skipped (<c>skipped=0</c>); neither holds on a starved pool, and neither says anything
/// about whether the loop is correct. The reviewer reproduced both shapes by blocking the
/// pool's workers. This runs the rewritten tests under that same starvation.</para>
///
/// <para>Its own collection with parallelisation off, so xunit runs it after, and never
/// alongside, every other class: blocking the pool here must not starve their timers.</para>
/// </summary>
[Collection(ThreadPoolStarvationCollection.Name)]
public class CaptureLoopUnderAStarvedThreadPoolTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private static readonly TimeSpan Hold = TimeSpan.FromMilliseconds(1500);

    [Fact]
    public void ASlowTickStillNeverOverlaps_WhenThePoolIsStarved()
    {
        using var starvation = PoolStarvation.Begin(Hold);
        output.WriteLine(starvation.ToString());

        var outcome = CaptureLoopTests.RunSlowTickUnderARealTimer(target: 4, timeout: TimeSpan.FromSeconds(30));
        output.WriteLine(outcome.ToString());

        CaptureLoopTests.AssertSlowTickHeld(outcome);
    }

    [Fact]
    public void StopStillHaltsTheLoop_WhenThePoolIsStarved()
    {
        using var starvation = PoolStarvation.Begin(Hold);
        output.WriteLine(starvation.ToString());

        var outcome = CaptureLoopTests.RunStopHaltsTheLoop(target: 3, timeout: TimeSpan.FromSeconds(30));
        output.WriteLine(outcome.ToString());

        CaptureLoopTests.AssertStopHeld(outcome);
    }

    /// <summary>
    /// Occupies every thread the pool is willing to hand out, then holds them for <c>hold</c>.
    ///
    /// <para><b>Adaptive, because a fixed count does not work inside a test host.</b> The
    /// first version queued <c>max(minWorkers, ThreadCount)</c> blockers — the reviewer's
    /// recipe, which starves a fresh process — and inside the test host the timer ran
    /// unimpeded anyway (skipped=29, identical to the unstarved run): after the parallel
    /// classes, the pool will create threads beyond the ones that exist without waiting for
    /// its starvation heuristic. So blockers go in two at a time until a pair does not get
    /// threads promptly. That refusal is the evidence the pool is saturated, and it is
    /// observed, not assumed.</para>
    ///
    /// <para>How long the pool then takes to run the caller's timer is left to the runtime
    /// and only reported: asserting on it would be exactly the timing-dependence #72 is
    /// about.</para>
    /// </summary>
    private sealed class PoolStarvation : IDisposable
    {
        private const int Batch = 2;
        private const int MaxBlockers = 512;
        private static readonly TimeSpan Prompt = TimeSpan.FromMilliseconds(250);

        private readonly ManualResetEventSlim released = new(false);
        private readonly TimeSpan hold;
        private readonly int minWorkers;
        private readonly int threadsAtStart;
        private int queued;
        private int started;
        private int finished;
        private long holdUntilTicks;

        private PoolStarvation(TimeSpan hold)
        {
            this.hold = hold;
            ThreadPool.GetMinThreads(out minWorkers, out _);
            threadsAtStart = ThreadPool.ThreadCount;

            var setup = Stopwatch.StartNew();
            while (queued < MaxBlockers)
            {
                var target = queued + Batch;
                for (; queued < target; queued++)
                {
                    ThreadPool.UnsafeQueueUserWorkItem(_ => Block(), null);
                }

                if (!CaptureLoopTests.WaitUntil(() => Volatile.Read(ref started) >= target, Prompt))
                {
                    Saturated = true;
                    break;
                }
            }

            SetupTook = setup.Elapsed;
            ThreadsWhenSaturated = ThreadPool.ThreadCount;
            PendingWhenSaturated = ThreadPool.PendingWorkItemCount;

            // The hold runs from here, not from each blocker's start, so the ones queued
            // first do not wander off while the rest are still being placed.
            Volatile.Write(ref holdUntilTicks, Stopwatch.GetTimestamp() + (long)(hold.TotalSeconds * Stopwatch.Frequency));
        }

        /// <summary>The pool stopped handing out threads promptly before <see cref="MaxBlockers"/> was reached.</summary>
        public bool Saturated { get; }

        public TimeSpan SetupTook { get; }

        public int ThreadsWhenSaturated { get; }

        public long PendingWhenSaturated { get; }

        public static PoolStarvation Begin(TimeSpan hold)
        {
            var starvation = new PoolStarvation(hold);
            if (!starvation.Saturated)
            {
                var description = starvation.ToString();
                starvation.Dispose();
                Assert.Fail($"the pool never stopped handing out threads: {description}");
            }

            return starvation;
        }

        private void Block()
        {
            Interlocked.Increment(ref started);

            // A polled sleep rather than a wait on a handle: the runtime has heuristics that
            // inject threads early for some blocking waits (Task.Wait on a pool thread, for
            // one), and the point is that the pool gets no such help.
            while (!released.IsSet)
            {
                var until = Volatile.Read(ref holdUntilTicks);
                if (until != 0 && Stopwatch.GetTimestamp() >= until)
                {
                    break;
                }

                Thread.Sleep(10);
            }

            Interlocked.Increment(ref finished);
        }

        public override string ToString()
            => $"starved for {hold.TotalMilliseconds}ms: {queued} blockers queued, {Volatile.Read(ref started)} running, "
               + $"saturated={Saturated} after {SetupTook.TotalMilliseconds:F0}ms (pool threads {threadsAtStart} -> "
               + $"{ThreadsWhenSaturated}, pending work items {PendingWhenSaturated}, min workers {minWorkers}, "
               + $"processors {Environment.ProcessorCount})";

        public void Dispose()
        {
            released.Set();

            // Leave nothing behind for the next test: every blocker, including any still
            // queued when saturation was declared, has run and returned before this does.
            CaptureLoopTests.WaitUntil(() => Volatile.Read(ref finished) >= queued, TimeSpan.FromSeconds(30));
        }
    }
}

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ThreadPoolStarvationCollection
{
    public const string Name = "thread-pool starvation";
}
