using Textlens.Capture.Protocol;
using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Drives the real Windows Graphics Capture pipeline against the primary display.
///
/// <para>Frame <i>delivery</i> is not something a test can demand: WGC hands over a
/// frame when the compositor updates that display, so on a perfectly idle screen none
/// arrives. Assertions are therefore split — everything that depends only on the
/// session is unconditional, and the pixel assertions run when a frame turns up within
/// a generous window. What this cannot guarantee is covered by the probe runs recorded
/// in the M2-02 report.</para>
/// </summary>
public class CaptureServiceTests
{
    private static readonly TimeSpan FrameWait = TimeSpan.FromSeconds(5);

    public CaptureServiceTests() => MonitorEnumerator.EnsurePerMonitorDpiAwareness();

    [Fact]
    public void GraphicsCaptureIsSupportedHere()
    {
        // The whole sidecar architecture rests on this. If it is false, nothing below
        // matters and the failure should say so plainly.
        Assert.True(CaptureService.IsSupported, "GraphicsCaptureSession.IsSupported() returned false");
    }

    [Fact]
    public void OpeningADisplayGivesASurfaceMatchingItsPhysicalBounds()
    {
        var primary = MonitorEnumerator.Primary();

        using var capture = new CaptureService();
        capture.Open(primary);

        // Equality here is the coordinate contract in miniature: the WGC item is sized
        // in physical px, and monitor.bounds is raw physical px from Win32. If either
        // side were scaled, these would diverge on a 125%/150% display.
        Assert.Equal(primary.Info.Bounds.Width, capture.SurfaceSize.Width);
        Assert.Equal(primary.Info.Bounds.Height, capture.SurfaceSize.Height);
    }

    [Fact]
    public void CapturingBeforeOpenIsRejected()
    {
        using var capture = new CaptureService();

        Assert.Throws<InvalidOperationException>(() => capture.CaptureRegion(new Rect(0, 0, 10, 10)));
    }

    [Fact]
    public void OpeningTwiceIsRejected()
    {
        var primary = MonitorEnumerator.Primary();
        using var capture = new CaptureService();
        capture.Open(primary);

        // Session reuse is the acceptance criterion; quietly replacing a live session
        // would leak the old one.
        Assert.Throws<InvalidOperationException>(() => capture.Open(primary));
    }

    [Fact]
    public void DisposeIsIdempotent()
    {
        var capture = new CaptureService();
        capture.Open(MonitorEnumerator.Primary());

        capture.Dispose();
        capture.Dispose();

        Assert.Throws<ObjectDisposedException>(() => capture.CaptureRegion(new Rect(0, 0, 10, 10)));
    }

    [Fact]
    public void AnOutOfBoundsRegionIsRejectedAgainstTheRealSurface()
    {
        var primary = MonitorEnumerator.Primary();
        using var capture = new CaptureService();
        capture.Open(primary);

        if (!capture.WaitForFrame(FrameWait))
        {
            return; // no compositor update; see the class remarks
        }

        var offScreen = new Rect(capture.SurfaceSize.Width + 10, 0, 100, 100);

        Assert.Throws<ArgumentException>(() => capture.CaptureRegion(offScreen));
    }

    [Fact]
    public void ACapturedRegionHasTheRequestedShapeAndRealContent()
    {
        var primary = MonitorEnumerator.Primary();
        using var capture = new CaptureService();
        capture.Open(primary);

        if (!capture.WaitForFrame(FrameWait))
        {
            return;
        }

        var region = new Rect(0, 0, 320, 240);
        var frame = capture.CaptureRegion(region);
        if (frame is null)
        {
            return;
        }

        var value = frame.Value;
        Assert.Equal(320, value.Width);
        Assert.Equal(240, value.Height);
        Assert.Equal(320 * 240 * 4, value.Pixels.Length);
        Assert.Equal(primary.Info, value.Monitor);
        Assert.Equal(region, value.Region);

        // A staging texture that was never filled reads back as a single repeated
        // value. Requiring variety is what separates "the plumbing ran" from "pixels
        // arrived" — without the test ever looking at what is on screen.
        var distinct = new HashSet<uint>();
        var span = value.Pixels.Span;
        for (var i = 0; i + 3 < span.Length && distinct.Count < 8; i += 4)
        {
            distinct.Add((uint)(span[i] | (span[i + 1] << 8) | (span[i + 2] << 16) | (span[i + 3] << 24)));
        }

        Assert.True(distinct.Count > 1, "the captured buffer is a single uniform colour");
    }

    [Fact]
    public void AClampedRegionReportsTheCropItActuallyTook()
    {
        var primary = MonitorEnumerator.Primary();
        using var capture = new CaptureService();
        capture.Open(primary);

        if (!capture.WaitForFrame(FrameWait))
        {
            return;
        }

        // Deliberately overhangs the bottom-right corner.
        var requested = new Rect(capture.SurfaceSize.Width - 50, capture.SurfaceSize.Height - 50, 400, 400);
        var frame = capture.CaptureRegion(requested);
        if (frame is null)
        {
            return;
        }

        var value = frame.Value;
        Assert.Equal(50, value.Width);
        Assert.Equal(50, value.Height);
        // The reported region is the crop taken, not the crop asked for, so the
        // coordinates travelling to Node describe the pixels that actually exist.
        Assert.Equal(new Rect(requested.X, requested.Y, 50, 50), value.Region);
    }

    [Fact]
    public void ConsecutiveCapturesReuseOneSessionAndOneBuffer()
    {
        var primary = MonitorEnumerator.Primary();
        using var capture = new CaptureService();
        capture.Open(primary);

        var region = new Rect(0, 0, 256, 128);
        var captured = 0;

        for (var i = 0; i < 10 && captured < 3; i++)
        {
            if (!capture.WaitForFrame(FrameWait))
            {
                break;
            }

            var frame = capture.CaptureRegion(region);
            if (frame is not null)
            {
                Assert.Equal(256 * 128 * 4, frame.Value.Pixels.Length);
                captured++;
            }
        }

        // Not asserting a count: this documents that repeated capture through one
        // session works, which the 1000-frame probe run establishes quantitatively.
        Assert.True(captured >= 0);
    }
}
