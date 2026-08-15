namespace Textlens.Capture.Services;

/// <summary>How busy the region has looked recently.</summary>
public enum ActivityLevel
{
    /// <summary>Something changed on the most recent tick.</summary>
    Active,

    /// <summary>Several ticks with no change. Poll more slowly.</summary>
    Idle,

    /// <summary>A long run of no change. Poll much more slowly.</summary>
    DeepIdle,

    /// <summary>
    /// Something changed after a long quiet stretch. Poll faster than <see cref="Active"/>
    /// for a few ticks, then settle back.
    /// </summary>
    Accelerated,
}

/// <summary>
/// Feature C2 — decides how long to wait before the next capture, from nothing but the
/// recent history of "did it change".
///
/// <para><b>Pure logic with an injected clock.</b> No timer, no thread, no screen: the
/// whole state machine is <see cref="OnResult"/> returning an interval, so every
/// acceptance criterion is a unit test over a sequence of booleans. The thing that owns a
/// real timer is <see cref="CaptureLoop"/>, and it owns nothing else.</para>
///
/// <para><b>Why acceleration exists.</b> A region that has been static for a minute is
/// almost certainly a paused video or a menu, and the tick that finally sees a change is
/// the first frame of new dialogue — probably mid-fade. Dropping straight to the active
/// interval means the next sample lands a whole interval later, by which point the text
/// has settled but the user has been waiting. A few fast ticks catch the settled frame
/// sooner and cost a few tens of milliseconds of CPU, once.</para>
/// </summary>
public sealed class AdaptiveTimer
{
    /// <summary>Unchanged ticks before dropping to the idle interval.</summary>
    public const int TicksToIdle = 3;

    /// <summary>Unchanged ticks before dropping to the deep-idle interval.</summary>
    public const int TicksToDeepIdle = 10;

    /// <summary>
    /// How much slower deep idle is than idle. Multiplier rather than another
    /// <c>configure</c> field: the protocol carries <c>intervalActive</c> and
    /// <c>intervalIdle</c> only, and inventing a third wire field to express "even
    /// slower" would be a contract change for a constant.
    /// </summary>
    public const int DeepIdleMultiplier = 3;

    /// <summary>Divisor applied to the active interval while accelerating.</summary>
    public const int AccelerationDivisor = 2;

    /// <summary>Ticks spent accelerated before settling back to the active interval.</summary>
    public const int AcceleratedTicks = 3;

    /// <summary>
    /// A change arriving after at least this many unchanged ticks counts as "sudden" and
    /// triggers acceleration. Set at the deep-idle boundary so an ordinary pause between
    /// subtitles does not trigger it — only a genuinely quiet stretch does.
    /// </summary>
    public const int SuddenChangeAfter = TicksToDeepIdle;

    /// <summary>
    /// Interval changes smaller than this reuse the existing timer.
    ///
    /// <para>Rebuilding a <see cref="System.Threading.Timer"/> per tick to shave 40ms off a
    /// poll allocates a timer and its callback state on every round of a loop that runs
    /// for hours. The deadband makes rebuilds rare and the arithmetic stable.</para>
    /// </summary>
    public const int RebuildThresholdMs = 200;

    private int intervalActive = 800;
    private int intervalIdle = 2000;

    private int consecutiveUnchanged;
    private int acceleratedRemaining;

    /// <summary>
    /// Poll interval in ms while text is changing.
    ///
    /// <para>Assigning recomputes <see cref="CurrentIntervalMs"/> straight away rather than
    /// waiting for the next tick. That is what makes "<c>configure</c> while running takes
    /// effect without a restart" true: at deep idle the next tick can be six seconds away,
    /// and a user who has just turned the interval down would sit through it wondering
    /// whether the setting did anything.</para>
    /// </summary>
    /// <exception cref="ArgumentOutOfRangeException">Not positive.</exception>
    public int IntervalActive
    {
        get => intervalActive;
        set
        {
            intervalActive = Positive(value, nameof(value));
            CurrentIntervalMs = IntervalFor(Level);
        }
    }

    /// <summary>Poll interval in ms while the region looks idle. Applies immediately, as above.</summary>
    /// <exception cref="ArgumentOutOfRangeException">Not positive.</exception>
    public int IntervalIdle
    {
        get => intervalIdle;
        set
        {
            intervalIdle = Positive(value, nameof(value));
            CurrentIntervalMs = IntervalFor(Level);
        }
    }

    /// <summary>How busy the region looked as of the last <see cref="OnResult"/>.</summary>
    public ActivityLevel Level { get; private set; } = ActivityLevel.Active;

    /// <summary>Consecutive ticks that reported no change.</summary>
    public int ConsecutiveUnchanged => consecutiveUnchanged;

    /// <summary>The interval the loop should currently be waiting, in ms.</summary>
    public int CurrentIntervalMs { get; private set; } = 800;

    /// <summary>
    /// Folds one tick's verdict into the state machine.
    /// </summary>
    /// <param name="changed">Whether the change detector saw a difference.</param>
    /// <returns>The interval to wait before the next tick, in ms.</returns>
    public int OnResult(bool changed)
    {
        if (changed)
        {
            // Read the run length *before* resetting it: whether this counts as a sudden
            // change is a question about how long it was quiet, and clearing the counter
            // first would make the answer always "no".
            var quietFor = consecutiveUnchanged;
            consecutiveUnchanged = 0;

            if (quietFor >= SuddenChangeAfter)
            {
                acceleratedRemaining = AcceleratedTicks;
            }
        }
        else
        {
            consecutiveUnchanged++;

            // Acceleration is for catching the rest of a burst. Once the screen has gone
            // quiet again there is nothing left to catch, so stop paying for it.
            acceleratedRemaining = 0;
        }

        Level = Classify();
        CurrentIntervalMs = IntervalFor(Level);

        if (acceleratedRemaining > 0)
        {
            acceleratedRemaining--;
        }

        return CurrentIntervalMs;
    }

    /// <summary>
    /// Returns the state machine to "just saw a change".
    ///
    /// Called when the region or monitor is reconfigured: the unchanged run counted so far
    /// describes somewhere else, and carrying it over would leave a freshly-pointed region
    /// polling at the deep-idle interval.
    /// </summary>
    public void Reset()
    {
        consecutiveUnchanged = 0;
        acceleratedRemaining = 0;
        Level = ActivityLevel.Active;
        CurrentIntervalMs = intervalActive;
    }

    /// <summary>
    /// Whether moving from <paramref name="currentMs"/> to <paramref name="desiredMs"/> is
    /// worth rebuilding the timer for. Static and pure so the deadband is testable on its
    /// own rather than only through a running loop.
    /// </summary>
    public static bool ShouldRebuild(int currentMs, int desiredMs)
        => Math.Abs(desiredMs - currentMs) >= RebuildThresholdMs;

    private ActivityLevel Classify()
    {
        if (acceleratedRemaining > 0)
        {
            return ActivityLevel.Accelerated;
        }

        if (consecutiveUnchanged >= TicksToDeepIdle)
        {
            return ActivityLevel.DeepIdle;
        }

        return consecutiveUnchanged >= TicksToIdle ? ActivityLevel.Idle : ActivityLevel.Active;
    }

    private int IntervalFor(ActivityLevel level) => level switch
    {
        ActivityLevel.Accelerated => Math.Max(1, intervalActive / AccelerationDivisor),
        ActivityLevel.Idle => intervalIdle,
        ActivityLevel.DeepIdle => intervalIdle * DeepIdleMultiplier,
        _ => intervalActive,
    };

    private static int Positive(int value, string parameterName)
        => value > 0
            ? value
            : throw new ArgumentOutOfRangeException(parameterName, value, "a poll interval must be at least 1ms");
}
