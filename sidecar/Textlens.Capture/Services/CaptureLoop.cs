using System.Diagnostics;
using Textlens.Capture.Protocol;
using WireLine = Textlens.Capture.Protocol.OcrLine;

namespace Textlens.Capture.Services;

/// <summary>
/// The pixel source a <see cref="CaptureLoop"/> polls. Implemented by
/// <see cref="CaptureService"/>; existing as an interface so the loop's timing, skipping
/// and error behaviour can be tested without a display.
/// </summary>
public interface IRegionSource
{
    /// <summary>The display these frames come from.</summary>
    MonitorInfo Monitor { get; }

    /// <summary>
    /// The newest queued frame cropped to <paramref name="region"/>, or <c>null</c> when
    /// the compositor has not delivered anything since the last call — the ordinary
    /// outcome on a static screen, not an error.
    /// </summary>
    CapturedRegion? CaptureRegion(Rect region);
}

/// <summary>The recognizer a <see cref="CaptureLoop"/> uses. Implemented by <see cref="OcrService"/>.</summary>
public interface IRecognizer
{
    /// <summary>Recognizes a BGRA region; boxes come back relative to the region's top-left.</summary>
    WireLine[] Recognize(ReadOnlySpan<byte> bgra, int width, int height);
}

/// <summary>Encodes a captured region as a PNG for <c>debugFrame</c>.</summary>
public interface IFrameEncoder
{
    /// <summary>Base64 PNG of a BGRA region.</summary>
    string ToBase64Png(ReadOnlySpan<byte> bgra, int width, int height);
}

/// <summary>
/// Issue M2-05 — the loop that drives capture, change detection and OCR, and emits one
/// event per tick.
///
/// <para><b>Interval-driven, never frame-driven, and this is the load-bearing design
/// decision.</b> The shape <see cref="CaptureService"/> invites — <c>WaitForFrame()</c>
/// then diff then OCR — is wrong here, and spike S2 measured why. With the overlay
/// excluded from capture but <i>animating</i>, Windows Graphics Capture delivered 120
/// frames in 2.6 seconds (~46fps) whose contents were byte-identical; with the overlay
/// static it delivered 3 frames in 13 seconds. In other words our own overlay's repaints
/// drive frame delivery. Once M5 lands its crossfades, a frame-driven loop would run
/// capture and diff at 60fps forever on a screen where nothing is changing — not a
/// feedback loop, since the overlay's pixels genuinely are not in the image, but a busy
/// loop that quietly eats a core and destroys the "static screen costs nothing"
/// assumption the latency budget rests on.</para>
///
/// <para><b>A tick therefore never waits for a frame.</b> It asks for the newest one and
/// takes <c>null</c> for an answer, because on a genuinely static display frames simply do
/// not arrive. That case emits <c>nochange</c> rather than nothing at all, so Node's
/// watchdog (design doc section 7) can tell a quiet sidecar from a hung one.</para>
///
/// <para><b>Ticks never overlap.</b> A tick that outruns its interval — a slow OCR pass,
/// a stalled GPU read — would otherwise have the next one start underneath it, and both
/// would share one <see cref="OcrEngine"/> and one bitmap. The gate skips instead of
/// queueing: a backlog of stale captures is worth nothing, since the next tick will read
/// the screen as it is then.</para>
/// </summary>
public sealed class CaptureLoop : IDisposable
{
    /// <summary><c>error.code</c> for a capture that threw.</summary>
    public const string CaptureFailedCode = "CAPTURE_FAILED";

    /// <summary><c>error.code</c> for a recognition that threw.</summary>
    public const string OcrFailedCode = "OCR_FAILED";

    /// <summary><c>error.code</c> when a snapshot is asked for before anything was captured.</summary>
    public const string NoFrameYetCode = "NO_FRAME_YET";

    /// <summary><c>error.code</c> when <c>debugFrame</c> is used without being enabled.</summary>
    public const string DebugFrameDisabledCode = "DEBUG_FRAME_DISABLED";

    private readonly IRegionSource source;
    private readonly IRecognizer recognizer;
    private readonly IFrameEncoder? encoder;
    private readonly Action<ISidecarEvent> emit;
    private readonly ChangeDetector detector;
    private readonly AdaptiveTimer schedule;

    // 0 = idle, 1 = a tick is running. The whole non-overlap guarantee is this int.
    private int ticking;

    // Guards the capture/diff/OCR pipeline itself, which the tick gate above does not:
    // `ticking` only excludes tick-against-tick, and ticks are not the only caller.
    // `snapshot`, `debugFrame` and `configure` all arrive on the stdin thread while a
    // timer tick may be mid-flight on a threadpool thread, and all three touch state that
    // is single-threaded by contract — one reused SoftwareBitmap inside OcrService, and
    // the ChangeDetector's baseline buffer, which Retarget can reallocate underneath a
    // Compare that is halfway through reading it.
    //
    // Ticks skip when they cannot get in; commands wait. That asymmetry is deliberate: a
    // late tick is worthless because the next one reads a fresher screen, whereas a
    // command a human just typed has to happen.
    private readonly object workGate = new();

    private Timer? timer;
    private int timerIntervalMs;
    private long seq;
    private bool disposed;

    /// <param name="initialSeq">
    /// Where to resume the <c>seq</c> counter. Non-zero when a <c>configure</c> rebuilt the
    /// loop mid-session: the protocol says a gap in <c>seq</c> means an event was lost, so
    /// restarting at 1 after a reconfigure would be a false report of exactly that.
    /// </param>
    public CaptureLoop(
        IRegionSource source,
        IRecognizer recognizer,
        Action<ISidecarEvent> emit,
        ChangeDetector? detector = null,
        AdaptiveTimer? schedule = null,
        IFrameEncoder? encoder = null,
        long initialSeq = 0)
    {
        seq = initialSeq;
        this.source = source ?? throw new ArgumentNullException(nameof(source));
        this.recognizer = recognizer ?? throw new ArgumentNullException(nameof(recognizer));
        this.emit = emit ?? throw new ArgumentNullException(nameof(emit));
        this.detector = detector ?? new ChangeDetector();
        this.schedule = schedule ?? new AdaptiveTimer();
        this.encoder = encoder;
    }

    /// <summary>The region being captured, physical px relative to the monitor's top-left.</summary>
    public Rect Region { get; set; }

    /// <summary>Whether <c>debugFrame</c> may return pixels. Off unless <c>configure</c> says otherwise.</summary>
    public bool DebugFrameEnabled { get; set; }

    /// <summary>Whether the timer is running.</summary>
    public bool IsRunning => timer is not null;

    /// <summary>Ticks that fired while the previous one was still running, and were dropped.</summary>
    public int TicksSkipped { get; private set; }

    /// <summary>Ticks that ran to completion.</summary>
    public int TicksCompleted { get; private set; }

    /// <summary>Times the timer's period was reprogrammed. Kept low by the 200ms deadband.</summary>
    public int TimerRebuilds { get; private set; }

    /// <summary>
    /// The last <c>seq</c> emitted. Read by the dispatcher so a loop rebuilt by
    /// <c>configure</c> carries the counter forward instead of restarting at 1.
    /// </summary>
    public long LastSeq => Interlocked.Read(ref seq);

    /// <summary>The change detector, so <c>configure</c> can retune its threshold.</summary>
    public ChangeDetector Detector => detector;

    /// <summary>The interval state machine, so <c>configure</c> can retune its intervals.</summary>
    public AdaptiveTimer Schedule => schedule;

    /// <summary>
    /// Starts polling. Idempotent — a second <c>start</c> is not an error, it just does
    /// nothing, which is friendlier than making Node track whether it already sent one.
    /// </summary>
    public void Start()
    {
        ObjectDisposedException.ThrowIf(disposed, this);

        if (timer is not null)
        {
            return;
        }

        timerIntervalMs = schedule.CurrentIntervalMs;
        // Periodic rather than one-shot-per-tick so that the "do not rebuild for a small
        // change" rule has something to not rebuild. The overlap gate is what makes a
        // periodic timer safe when a tick runs long.
        timer = new Timer(_ => Tick(), null, timerIntervalMs, timerIntervalMs);
    }

    /// <summary>
    /// Stops polling. The timer is disposed rather than merely paused, so a stopped
    /// sidecar genuinely costs nothing — which is what the acceptance criterion measures
    /// with a CPU reading.
    /// </summary>
    public void Stop()
    {
        var stopping = timer;
        timer = null;
        stopping?.Dispose();
    }

    /// <summary>
    /// Picks up an interval that changed outside a tick — that is, a <c>configure</c>
    /// arriving while the loop is running. Without this the new interval would not take
    /// hold until the next tick, which at deep idle can be six seconds away.
    /// </summary>
    public void ApplySchedule() => Reschedule(schedule.CurrentIntervalMs);

    /// <summary>
    /// Applies a new region. Clears the diff baseline and the interval history, because
    /// both describe the <i>old</i> region: keeping them would compare a freshly-moved
    /// region against a picture of somewhere else and report "unchanged".
    /// </summary>
    public void Retarget(Rect region)
    {
        lock (workGate)
        {
            Region = region;
            detector.Reset();
            schedule.Reset();
        }
    }

    /// <summary>
    /// Applies a whole <c>configure</c> payload as one atomic change.
    ///
    /// <para>Atomic because a tick may be mid-flight: applying these one at a time would
    /// let a tick run against the new threshold but the old region, and
    /// <see cref="Retarget"/> in particular reallocates the diff baseline that a
    /// concurrent <c>Compare</c> is reading.</para>
    /// </summary>
    public void ApplyConfiguration(
        Rect region,
        double diffThreshold,
        int intervalActive,
        int intervalIdle,
        bool debugFrameEnabled)
    {
        lock (workGate)
        {
            detector.Threshold = diffThreshold;
            schedule.IntervalActive = intervalActive;
            schedule.IntervalIdle = intervalIdle;
            DebugFrameEnabled = debugFrameEnabled;
            Retarget(region);
        }
    }

    /// <summary>
    /// Runs one round: capture, diff, and OCR when the region changed. Always emits
    /// exactly one event.
    ///
    /// <para>Public so tests can drive the loop deterministically instead of waiting on a
    /// real timer.</para>
    /// </summary>
    /// <returns><c>false</c> when the tick was skipped because another was already running.</returns>
    public bool Tick()
    {
        // The non-overlap gate. CompareExchange rather than a lock: a tick that arrives
        // while one is running must be *dropped*, and a lock would queue it instead —
        // turning a slow tick into a growing backlog of captures that are stale by the
        // time they run.
        if (Interlocked.CompareExchange(ref ticking, 1, 0) != 0)
        {
            TicksSkipped++;
            return false;
        }

        try
        {
            lock (workGate)
            {
                RunOnce();
            }

            TicksCompleted++;
            return true;
        }
        finally
        {
            Volatile.Write(ref ticking, 0);
        }
    }

    private void RunOnce()
    {
        CapturedRegion? captured;
        try
        {
            captured = source.CaptureRegion(Region);
        }
        catch (Exception ex)
        {
            // Invariant 4: the loop keeps running and the user is told. A display that was
            // unplugged, or a device lost to a driver update, must not end the process.
            Emit(new ErrorEvent { Code = CaptureFailedCode, Message = Describe(ex) });
            Reschedule(schedule.OnResult(false));
            return;
        }

        if (captured is null)
        {
            // No new frame. On a static screen this is the normal case — see the class
            // remarks — and it is reported rather than passed over in silence.
            Emit(new NoChangeEvent { Seq = NextSeq() });
            Reschedule(schedule.OnResult(false));
            return;
        }

        var frame = captured.Value;

        var diffStopwatch = Stopwatch.StartNew();
        DiffResult diff;
        try
        {
            diff = detector.Compare(frame.Pixels.Span, frame.Width, frame.Height);
        }
        catch (Exception ex)
        {
            Emit(new ErrorEvent { Code = CaptureFailedCode, Message = Describe(ex) });
            Reschedule(schedule.OnResult(false));
            return;
        }

        diffStopwatch.Stop();
        var diffUs = Microseconds(diffStopwatch);

        if (!diff.Changed)
        {
            Emit(new NoChangeEvent { Seq = NextSeq() });
            Reschedule(schedule.OnResult(false));
            return;
        }

        try
        {
            EmitFrame(frame, frame.CaptureMicroseconds, diffUs, includeImage: false);
        }
        catch (Exception ex)
        {
            Emit(new ErrorEvent { Code = OcrFailedCode, Message = Describe(ex) });
        }

        Reschedule(schedule.OnResult(true));
    }

    /// <summary>
    /// Captures and emits exactly one <c>frame</c>, bypassing change detection.
    ///
    /// <para>Falls back to the diff baseline when the compositor has nothing new, which is
    /// the common case precisely when a user reaches for this: a static screen delivers no
    /// frames at all (spike S2), so "snapshot always returns a frame" is only true if the
    /// last one is kept. Emits an error only when nothing has ever been captured.</para>
    /// </summary>
    /// <param name="includeImage">Attach <c>imagePng</c>; requires <see cref="DebugFrameEnabled"/>.</param>
    public void Snapshot(bool includeImage = false)
    {
        ObjectDisposedException.ThrowIf(disposed, this);

        if (includeImage && !DebugFrameEnabled)
        {
            // Pixels crossing IPC is the one documented exception to invariant 1 and is
            // opt-in. Refusing loudly beats quietly returning a frame without the image,
            // which would look like the encoder failed.
            Emit(new ErrorEvent
            {
                Code = DebugFrameDisabledCode,
                // Quotes are spelled out rather than punctuated: the protocol serializer
                // uses the HTML-safe encoder, so a literal quote arrives as " and is
                // unreadable to someone running the sidecar by hand — which is the very
                // situation this message exists for. Same reasoning as OcrPreflight.
                Message = "debugFrame is disabled. Set debugFrameEnabled to true in configure to enable it.",
            });
            return;
        }

        if (includeImage && encoder is null)
        {
            Emit(new ErrorEvent
            {
                Code = DebugFrameDisabledCode,
                Message = "this build has no PNG encoder wired up, so debugFrame cannot return an image",
            });
            return;
        }

        // Waits for an in-flight tick rather than skipping: a snapshot is something a
        // human or Node explicitly asked for, and the pipeline underneath is
        // single-threaded by contract — one reused OCR bitmap, one diff baseline.
        lock (workGate)
        {
            CapturedRegion? captured;
            try
            {
                captured = source.CaptureRegion(Region);
            }
            catch (Exception ex)
            {
                Emit(new ErrorEvent { Code = CaptureFailedCode, Message = Describe(ex) });
                return;
            }

            try
            {
                if (captured is not null)
                {
                    var fresh = captured.Value;
                    // Keep the baseline current even though the verdict is discarded: a
                    // snapshot that did not update it would leave the next ordinary tick
                    // diffing against a frame two steps old.
                    detector.Compare(fresh.Pixels.Span, fresh.Width, fresh.Height);
                    EmitFrame(fresh, fresh.CaptureMicroseconds, 0, includeImage);
                    return;
                }

                if (!detector.HasPrevious)
                {
                    Emit(new ErrorEvent
                    {
                        Code = NoFrameYetCode,
                        Message = "no frame has been captured yet, so there is nothing to snapshot",
                    });
                    return;
                }

                EmitRetained(includeImage);
            }
            catch (Exception ex)
            {
                Emit(new ErrorEvent { Code = OcrFailedCode, Message = Describe(ex) });
            }
        }
    }

    private void EmitFrame(CapturedRegion frame, long captureUs, long diffUs, bool includeImage)
        => EmitRecognized(frame.Pixels.Span, frame.Width, frame.Height, frame.Monitor, frame.Region, captureUs, diffUs, includeImage);

    /// <summary>Emits a frame built from the retained baseline, when nothing fresh arrived.</summary>
    private void EmitRetained(bool includeImage)
        => EmitRecognized(
            detector.Previous,
            detector.PreviousWidth,
            detector.PreviousHeight,
            source.Monitor,
            new Rect(Region.X, Region.Y, detector.PreviousWidth, detector.PreviousHeight),
            // Nothing was captured this round, so reporting a capture cost would be a
            // fabrication. Zero is the honest number.
            0,
            0,
            includeImage);

    private void EmitRecognized(
        ReadOnlySpan<byte> pixels,
        int width,
        int height,
        MonitorInfo monitor,
        Rect region,
        long captureUs,
        long diffUs,
        bool includeImage)
    {
        var ocrStopwatch = Stopwatch.StartNew();
        var lines = recognizer.Recognize(pixels, width, height);
        ocrStopwatch.Stop();

        var image = includeImage && encoder is not null
            ? encoder.ToBase64Png(pixels, width, height)
            : null;

        Emit(new FrameEvent
        {
            Seq = NextSeq(),
            Timings = new FrameTimings
            {
                CaptureUs = ToInt(captureUs),
                DiffUs = ToInt(diffUs),
                OcrUs = ToInt(Microseconds(ocrStopwatch)),
            },
            Monitor = monitor,
            Region = region,
            Lines = lines,
            ImagePng = image,
        });
    }

    /// <summary>
    /// Applies the interval the state machine asked for, reprogramming the timer only when
    /// the change is worth it (<see cref="AdaptiveTimer.RebuildThresholdMs"/>).
    /// </summary>
    private void Reschedule(int desiredMs)
    {
        var running = timer;
        if (running is null || !AdaptiveTimer.ShouldRebuild(timerIntervalMs, desiredMs))
        {
            return;
        }

        timerIntervalMs = desiredMs;
        TimerRebuilds++;
        running.Change(desiredMs, desiredMs);
    }

    private long NextSeq() => Interlocked.Increment(ref seq);

    private void Emit(ISidecarEvent evt) => emit(evt);

    private static long Microseconds(Stopwatch stopwatch)
        => stopwatch.Elapsed.Ticks / (TimeSpan.TicksPerMillisecond / 1000);

    /// <summary>
    /// Saturates rather than overflowing. A stage that somehow took 36 minutes is a bug
    /// worth seeing as <see cref="int.MaxValue"/>, not as a negative number.
    /// </summary>
    private static int ToInt(long microseconds)
        => microseconds > int.MaxValue ? int.MaxValue : (int)Math.Max(0, microseconds);

    private static string Describe(Exception ex) => $"{ex.GetType().Name}: {ex.Message}";

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        Stop();
    }
}
