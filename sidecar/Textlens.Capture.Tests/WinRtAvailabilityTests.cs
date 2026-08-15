using Windows.Media.Ocr;

namespace Textlens.Capture.Tests;

/// <summary>
/// Guards the single assumption the whole sidecar rests on: that WinRT types are
/// genuinely reachable from managed code on this TFM. If these fail, the .NET
/// sidecar architecture (design doc section 2) does not hold and no amount of
/// capture/OCR code above it will work.
/// </summary>
public class WinRtAvailabilityTests
{
    [Fact]
    public void OcrEngine_TypeResolves()
    {
        // Compile-time reference plus runtime type identity: proves the WinRT
        // projection assembly loads, not merely that the name was known to the
        // compiler.
        var type = typeof(OcrEngine);

        Assert.Equal("Windows.Media.Ocr.OcrEngine", type.FullName);
    }

    [Fact]
    public void OcrEngine_StaticPropertyActivatesAcrossTheComBoundary()
    {
        // Reading a static on a WinRT runtime class forces real activation through
        // the COM boundary — a stronger claim than type resolution alone, and
        // independent of which OCR language packs are installed on the machine.
        var maxDimension = OcrEngine.MaxImageDimension;

        Assert.True(maxDimension > 0, $"expected a positive max image dimension, got {maxDimension}");
    }
}
