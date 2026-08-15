using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Issue M2-05, the state machine half. <see cref="AdaptiveTimer"/> owns no clock and no
/// thread — it is a fold over a sequence of "did it change" — so the whole of feature C2's
/// behaviour is testable here, deterministically, without a screen or a sleep.
/// </summary>
public class AdaptiveTimerTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private static AdaptiveTimer Timer() => new() { IntervalActive = 800, IntervalIdle = 2000 };

    /// <summary>Feeds a run of unchanged ticks and returns the interval trace.</summary>
    private static List<int> Quiet(AdaptiveTimer timer, int ticks)
    {
        var trace = new List<int>(ticks);
        for (var i = 0; i < ticks; i++)
        {
            trace.Add(timer.OnResult(false));
        }

        return trace;
    }

    [Fact]
    public void AStaticRegionClimbsFromActiveToIdleToDeepIdle()
    {
        var timer = Timer();
        var trace = new List<(int Tick, ActivityLevel Level, int Interval)>();

        for (var tick = 1; tick <= 12; tick++)
        {
            var interval = timer.OnResult(false);
            trace.Add((tick, timer.Level, interval));
        }

        foreach (var (tick, level, interval) in trace)
        {
            output.WriteLine($"tick {tick,2}: {level,-11} {interval}ms");
        }

        // Ticks 1-2 are still active: two unchanged rounds is an ordinary gap between
        // subtitles, not an idle screen.
        Assert.Equal(ActivityLevel.Active, trace[0].Level);
        Assert.Equal(800, trace[0].Interval);
        Assert.Equal(ActivityLevel.Active, trace[1].Level);

        // The 3rd unchanged tick crosses into idle.
        Assert.Equal(ActivityLevel.Idle, trace[2].Level);
        Assert.Equal(2000, trace[2].Interval);

        // ...and the 10th into deep idle.
        Assert.Equal(ActivityLevel.Idle, trace[8].Level);
        Assert.Equal(ActivityLevel.DeepIdle, trace[9].Level);
        Assert.Equal(6000, trace[9].Interval);

        // And it stays there rather than climbing without bound.
        Assert.Equal(ActivityLevel.DeepIdle, trace[11].Level);
        Assert.Equal(6000, trace[11].Interval);
    }

    [Fact]
    public void AChangeReturnsToTheActiveIntervalImmediately()
    {
        var timer = Timer();
        Quiet(timer, 5);
        Assert.Equal(ActivityLevel.Idle, timer.Level);

        var interval = timer.OnResult(true);

        // Immediately, not gradually: the user is reading now.
        Assert.Equal(ActivityLevel.Active, timer.Level);
        Assert.Equal(800, interval);
        Assert.Equal(0, timer.ConsecutiveUnchanged);
    }

    [Fact]
    public void AChangeAfterALongQuietStretchAcceleratesThenSettlesBack()
    {
        var timer = Timer();
        Quiet(timer, AdaptiveTimer.SuddenChangeAfter);
        Assert.Equal(ActivityLevel.DeepIdle, timer.Level);

        var trace = new List<(ActivityLevel Level, int Interval)>();

        // The sudden change, then three more changing ticks.
        for (var i = 0; i < 5; i++)
        {
            var interval = timer.OnResult(true);
            trace.Add((timer.Level, interval));
            output.WriteLine($"change {i + 1}: {timer.Level,-11} {interval}ms");
        }

        // Accelerated for exactly AcceleratedTicks rounds...
        Assert.Equal(ActivityLevel.Accelerated, trace[0].Level);
        Assert.Equal(400, trace[0].Interval);
        Assert.Equal(ActivityLevel.Accelerated, trace[2].Level);

        // ...then back to the ordinary active interval on its own, with nothing having
        // told it to stop.
        Assert.Equal(ActivityLevel.Active, trace[3].Level);
        Assert.Equal(800, trace[3].Interval);
        Assert.Equal(ActivityLevel.Active, trace[4].Level);
    }

    [Fact]
    public void AnOrdinaryPauseBetweenSubtitlesDoesNotTriggerAcceleration()
    {
        // The distinguishing case. Two unchanged ticks then a change is the normal rhythm
        // of dialogue; accelerating for it would mean running at double rate most of the
        // time, which is the CPU cost feature C2 exists to avoid.
        var timer = Timer();
        Quiet(timer, 2);

        timer.OnResult(true);

        Assert.Equal(ActivityLevel.Active, timer.Level);
        Assert.Equal(800, timer.CurrentIntervalMs);
    }

    [Fact]
    public void AccelerationStopsEarlyIfTheScreenGoesQuietAgain()
    {
        var timer = Timer();
        Quiet(timer, AdaptiveTimer.SuddenChangeAfter);
        timer.OnResult(true);
        Assert.Equal(ActivityLevel.Accelerated, timer.Level);

        // One flash of change and then nothing: there is no burst left to catch, so the
        // fast polling should stop rather than run out its budget.
        var interval = timer.OnResult(false);

        Assert.Equal(ActivityLevel.Active, timer.Level);
        Assert.Equal(800, interval);
    }

    [Fact]
    public void ResetReturnsToActive_SoARetargetedRegionIsNotPolledAtDeepIdle()
    {
        var timer = Timer();
        Quiet(timer, 15);
        Assert.Equal(ActivityLevel.DeepIdle, timer.Level);

        timer.Reset();

        Assert.Equal(ActivityLevel.Active, timer.Level);
        Assert.Equal(800, timer.CurrentIntervalMs);
        Assert.Equal(0, timer.ConsecutiveUnchanged);
    }

    [Fact]
    public void ConfiguredIntervalsAreHonoured()
    {
        var timer = new AdaptiveTimer { IntervalActive = 250, IntervalIdle = 1200 };

        Assert.Equal(250, timer.OnResult(true));
        Quiet(timer, AdaptiveTimer.TicksToIdle);
        Assert.Equal(1200, timer.CurrentIntervalMs);
        Quiet(timer, AdaptiveTimer.TicksToDeepIdle - AdaptiveTimer.TicksToIdle);
        Assert.Equal(3600, timer.CurrentIntervalMs);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public void AnImpossibleIntervalIsRejectedLoudly(int interval)
    {
        // Invariant 4 again: a `configure` carrying 0 would otherwise become a timer that
        // fires continuously, which looks like a hang rather than a bad setting.
        Assert.Throws<ArgumentOutOfRangeException>(() => new AdaptiveTimer { IntervalActive = interval });
        Assert.Throws<ArgumentOutOfRangeException>(() => new AdaptiveTimer { IntervalIdle = interval });
    }

    // ------------------------------------------------------------------
    // The 200ms deadband
    // ------------------------------------------------------------------

    [Theory]
    [InlineData(800, 800, false)]    // no change at all
    [InlineData(800, 900, false)]    // 100ms — not worth a rebuild
    [InlineData(800, 999, false)]    // 199ms — still inside the band
    [InlineData(800, 1000, true)]    // exactly 200ms — the boundary counts
    [InlineData(2000, 800, true)]    // a big drop, in the other direction
    [InlineData(2000, 6000, true)]
    public void OnlyAnIntervalMoveOfAtLeast200msIsWorthANewTimer(int current, int desired, bool expected)
    {
        Assert.Equal(expected, AdaptiveTimer.ShouldRebuild(current, desired));
    }

    [Fact]
    public void TheDeadbandIsSymmetric()
    {
        // Speeding up and slowing down by the same amount must cost the same decision,
        // or the loop would ratchet in one direction.
        Assert.Equal(AdaptiveTimer.ShouldRebuild(800, 1000), AdaptiveTimer.ShouldRebuild(1000, 800));
        Assert.Equal(AdaptiveTimer.ShouldRebuild(800, 950), AdaptiveTimer.ShouldRebuild(950, 800));
    }
}
