using Textlens.Capture.Protocol;
using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Crop arithmetic for M2-02. Pure, so the cases that are awkward to stage on real
/// hardware — a display that shrank under a configured region, a zero-height selection,
/// a region dragged past the edge — are ordinary tests.
///
/// These do not substitute for capturing from a real display; they cover the branches a
/// real capture would only reach by accident.
/// </summary>
public class CaptureGeometryTests
{
    [Fact]
    public void RegionInsideTheSurface_IsUnchanged()
    {
        Assert.True(CaptureGeometry.TryResolve(new Rect(400, 1100, 1200, 200), 3440, 1440, out var box, out _));

        Assert.Equal(new CropBox(400, 1100, 1200, 200), box);
    }

    [Fact]
    public void RegionFillingTheSurface_IsUnchanged()
    {
        Assert.True(CaptureGeometry.TryResolve(new Rect(0, 0, 1080, 1920), 1080, 1920, out var box, out _));

        Assert.Equal(new CropBox(0, 0, 1080, 1920), box);
    }

    [Fact]
    public void ByteCountIsBgra()
    {
        Assert.True(CaptureGeometry.TryResolve(new Rect(0, 0, 1200, 200), 3440, 1440, out var box, out _));

        Assert.Equal(1200 * 200 * 4, box.ByteCount);
    }

    [Fact]
    public void ExclusiveEdgesMatchWhatD3DWants()
    {
        // D3D11_BOX right/bottom are exclusive. Off-by-one here is a one-pixel column
        // of garbage down the edge of every OCR crop.
        Assert.True(CaptureGeometry.TryResolve(new Rect(10, 20, 30, 40), 100, 100, out var box, out _));

        Assert.Equal(40, box.Right);
        Assert.Equal(60, box.Bottom);
    }

    [Fact]
    public void OverhangingTheRightEdge_IsClamped()
    {
        // The display shrank, or the user dragged past the edge. Keep the origin, keep
        // what exists.
        Assert.True(CaptureGeometry.TryResolve(new Rect(3000, 100, 1200, 200), 3440, 1440, out var box, out _));

        Assert.Equal(new CropBox(3000, 100, 440, 200), box);
    }

    [Fact]
    public void OverhangingTheBottomEdge_IsClamped()
    {
        Assert.True(CaptureGeometry.TryResolve(new Rect(0, 1850, 900, 200), 1080, 1920, out var box, out _));

        Assert.Equal(new CropBox(0, 1850, 900, 70), box);
    }

    [Fact]
    public void ClampingNeverMovesTheOrigin()
    {
        // Load-bearing for the coordinate contract: every OCR bbox is relative to the
        // region's top-left, so shifting the origin to "make it fit" would silently
        // displace every translated box on screen.
        var region = new Rect(3400, 1430, 500, 500);
        Assert.True(CaptureGeometry.TryResolve(region, 3440, 1440, out var box, out _));

        Assert.Equal(region.X, box.X);
        Assert.Equal(region.Y, box.Y);
    }

    [Theory]
    [InlineData(-1, 0)]
    [InlineData(0, -1)]
    public void NegativeOrigin_IsRejected(int x, int y)
    {
        // Region coordinates are display-relative. A negative origin is not the
        // negative-x virtual-desktop case (that lives in monitor.bounds) — it means the
        // caller forgot to subtract the display origin, and clamping it to zero would
        // hide the bug behind a plausible-looking crop.
        Assert.False(CaptureGeometry.TryResolve(new Rect(x, y, 100, 100), 3440, 1440, out _, out var error));

        Assert.Contains("outside the display", error, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(3440, 0)]
    [InlineData(0, 1440)]
    [InlineData(9999, 9999)]
    public void OriginPastTheEdge_IsRejected(int x, int y)
    {
        Assert.False(CaptureGeometry.TryResolve(new Rect(x, y, 100, 100), 3440, 1440, out _, out var error));

        Assert.Contains("past the edge", error, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public void EmptyOrNegativeExtent_IsRejected(int extent)
    {
        Assert.False(CaptureGeometry.TryResolve(new Rect(0, 0, extent, 100), 3440, 1440, out _, out var widthError));
        Assert.False(CaptureGeometry.TryResolve(new Rect(0, 0, 100, extent), 3440, 1440, out _, out var heightError));

        Assert.Contains("no area", widthError, StringComparison.Ordinal);
        Assert.Contains("no area", heightError, StringComparison.Ordinal);
    }

    [Fact]
    public void DegenerateSurface_IsRejected()
    {
        // A capture item can legitimately report 0x0 while a display is being
        // reconfigured. Better a named error than a division-by-zero further down.
        Assert.False(CaptureGeometry.TryResolve(new Rect(0, 0, 100, 100), 0, 0, out _, out var error));

        Assert.Contains("surface", error, StringComparison.Ordinal);
    }

    [Fact]
    public void RejectionAlwaysExplainsItself()
    {
        // Invariant 4: no silent failures. An empty reason string would reach the user
        // as an error dialog with nothing in it.
        Assert.False(CaptureGeometry.TryResolve(new Rect(-1, 0, 10, 10), 100, 100, out _, out var error));

        Assert.NotEmpty(error);
    }

    [Fact]
    public void NoScaleArithmeticHappensHere()
    {
        // CLAUDE.md invariant 3 / the coordinate ruling of 2026-08-16. If someone ever
        // "helpfully" divides by a scale factor in this file, a 1200-wide region on a
        // 150% display would come back 800 wide. The resolver has no scale parameter at
        // all, which is the real guard; this pins the consequence.
        Assert.True(CaptureGeometry.TryResolve(new Rect(0, 0, 1200, 200), 3840, 2160, out var box, out _));

        Assert.Equal(1200, box.Width);
        Assert.Equal(200, box.Height);
    }
}
