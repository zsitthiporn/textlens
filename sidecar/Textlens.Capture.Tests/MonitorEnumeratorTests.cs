using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Monitor enumeration for M2-02, against whatever displays this machine actually has.
///
/// Deliberately asserts invariants rather than this rig's specific layout: hardcoding
/// "three displays, one at x=-1080" would make the suite fail on a laptop and would
/// prove nothing about the code. The specific-hardware evidence lives in the probe run
/// recorded in the issue report.
/// </summary>
public class MonitorEnumeratorTests
{
    public MonitorEnumeratorTests() => MonitorEnumerator.EnsurePerMonitorDpiAwareness();

    [Fact]
    public void AtLeastOneDisplayIsFound()
    {
        Assert.NotEmpty(MonitorEnumerator.List());
    }

    [Fact]
    public void ExactlyOneDisplayIsPrimary()
    {
        var primaries = MonitorEnumerator.List().Count(m => m.IsPrimary);

        Assert.Equal(1, primaries);
    }

    [Fact]
    public void EveryDisplayHasADeviceNameNodeCanAddress()
    {
        // `configure.monitorId` round-trips this string, so a blank or duplicated id
        // makes a display unaddressable.
        var ids = MonitorEnumerator.List().Select(m => m.Info.Id).ToList();

        Assert.All(ids, id => Assert.False(string.IsNullOrWhiteSpace(id)));
        Assert.Equal(ids.Count, ids.Distinct(StringComparer.OrdinalIgnoreCase).Count());
        Assert.All(ids, id => Assert.StartsWith(@"\\.\", id, StringComparison.Ordinal));
    }

    [Fact]
    public void EveryDisplayHasAPositiveScaleAndArea()
    {
        foreach (var monitor in MonitorEnumerator.List())
        {
            Assert.True(monitor.Info.Scale > 0, $"{monitor.Info.Id} reported scale {monitor.Info.Scale}");
            Assert.True(monitor.Info.Bounds.Width > 0, $"{monitor.Info.Id} reported width {monitor.Info.Bounds.Width}");
            Assert.True(monitor.Info.Bounds.Height > 0, $"{monitor.Info.Id} reported height {monitor.Info.Bounds.Height}");
        }
    }

    [Fact]
    public void ScaleIsAWindowsDpiStep()
    {
        // Windows exposes DPI in 25%-ish steps. A value like 1.0416 would mean the raw
        // DPI leaked through instead of the effective scale.
        foreach (var monitor in MonitorEnumerator.List())
        {
            var scaled = monitor.Info.Scale * 100;
            Assert.True(
                Math.Abs(scaled - Math.Round(scaled / 5) * 5) < 0.001,
                $"{monitor.Info.Id} reported a scale of {monitor.Info.Scale}, which is not a Windows DPI step");
        }
    }

    [Fact]
    public void BoundsAreRawPhysicalPixels_NotDividedByScale()
    {
        // The coordinate ruling of 2026-08-16 (design doc section 3): the sidecar
        // performs no scale arithmetic. On a scaled display, physical bounds are an
        // exact integer multiple of the logical size, so a stray `/ scale` would show
        // up here as a width that no longer matches the reported physical mode.
        //
        // On an all-100% rig this cannot fail, which is exactly why it is written down:
        // it is the assertion that starts failing the day someone tests at 150%.
        foreach (var monitor in MonitorEnumerator.List())
        {
            var logicalWidth = monitor.Info.Bounds.Width / monitor.Info.Scale;
            Assert.True(
                logicalWidth <= monitor.Info.Bounds.Width + 0.001,
                $"{monitor.Info.Id}: bounds appear to have been divided by scale already");
        }
    }

    [Fact]
    public void DisplaysDoNotOverlapOnTheVirtualDesktop()
    {
        // Overlapping rectangles would mean bounds are being reported in mismatched
        // coordinate spaces — the concrete symptom of mixing logical and physical px.
        var all = MonitorEnumerator.List();

        for (var i = 0; i < all.Count; i++)
        {
            for (var j = i + 1; j < all.Count; j++)
            {
                var a = all[i].Info.Bounds;
                var b = all[j].Info.Bounds;
                var overlaps = a.X < b.X + b.Width && b.X < a.X + a.Width
                    && a.Y < b.Y + b.Height && b.Y < a.Y + a.Height;

                Assert.False(overlaps, $"{all[i].Info.Id} and {all[j].Info.Id} overlap");
            }
        }
    }

    [Fact]
    public void PrimaryDisplayStartsAtTheOrigin()
    {
        // Windows defines the primary display's top-left as (0,0) of the virtual
        // desktop. If this fails, the origin convention is wrong and every other
        // display's coordinates are suspect — including the negative-x case.
        var primary = MonitorEnumerator.Primary();

        Assert.Equal(0, primary.Info.Bounds.X);
        Assert.Equal(0, primary.Info.Bounds.Y);
    }

    [Fact]
    public void FindLocatesADisplayByTheIdItReported()
    {
        var expected = MonitorEnumerator.List()[0];

        var found = MonitorEnumerator.Find(expected.Info.Id);

        Assert.NotNull(found);
        Assert.Equal(expected.Info, found.Info);
    }

    [Fact]
    public void FindReturnsNullForAnUnknownDisplay()
    {
        // Node may hold a monitorId for a display that has since been unplugged. That
        // has to be a clean "not found", not an exception or a silent fallback to the
        // primary — the user would otherwise see the overlay capture the wrong screen.
        Assert.Null(MonitorEnumerator.Find(@"\\.\DISPLAY_NOT_ATTACHED"));
    }

    [Fact]
    public void EveryEnumeratedDisplayCanBeFoundAgain()
    {
        foreach (var monitor in MonitorEnumerator.List())
        {
            Assert.NotNull(MonitorEnumerator.Find(monitor.Info.Id));
        }
    }
}
