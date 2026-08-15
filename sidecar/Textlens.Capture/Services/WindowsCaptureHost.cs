using Textlens.Capture.Protocol;

namespace Textlens.Capture.Services;

/// <summary>
/// The real <see cref="ICaptureHost"/>: Windows Graphics Capture, Windows.Media.Ocr and
/// the WinRT PNG encoder.
///
/// <para>Thin on purpose. Every decision worth testing lives in <see cref="Dispatcher"/>
/// or <see cref="CaptureLoop"/>, and this is the seam that keeps those two testable
/// without a display attached — which matters because a screen is exactly what a test
/// cannot arrange.</para>
/// </summary>
public sealed class WindowsCaptureHost : ICaptureHost
{
    public MonitorInfo[] ListMonitors()
        => [.. MonitorEnumerator.List().Select(descriptor => descriptor.Info)];

    public IRegionSource OpenSource(string monitorId)
    {
        var target = MonitorEnumerator.Find(monitorId);
        if (target is null)
        {
            // Naming the displays that do exist turns a typo into a one-step fix, and
            // device names are not guessable (invariant 4).
            var known = string.Join(", ", MonitorEnumerator.List().Select(d => d.Info.Id));
            throw new InvalidOperationException($"no display named \"{monitorId}\" (attached: {known})");
        }

        if (!CaptureService.IsSupported)
        {
            throw new InvalidOperationException(
                "Windows Graphics Capture is unavailable on this system; Textlens needs Windows 10 2004 or newer");
        }

        var service = new CaptureService();
        try
        {
            service.Open(target);
            return service;
        }
        catch
        {
            service.Dispose();
            throw;
        }
    }

    public IRecognizer CreateRecognizer(string languageTag) => OcrService.Create(languageTag);

    public IFrameEncoder? CreateEncoder() => new PngFrameEncoder();
}
