using Textlens.Capture.Protocol;

namespace Textlens.Capture.Services;

/// <summary>
/// The crop rectangle actually copied out of a captured surface, in physical px
/// relative to the surface's top-left.
/// </summary>
/// <param name="X">Left edge.</param>
/// <param name="Y">Top edge.</param>
/// <param name="Width">Width in px; always &gt; 0.</param>
/// <param name="Height">Height in px; always &gt; 0.</param>
public readonly record struct CropBox(int X, int Y, int Width, int Height)
{
    /// <summary>Exclusive right edge, as D3D11_BOX wants it.</summary>
    public int Right => X + Width;

    /// <summary>Exclusive bottom edge, as D3D11_BOX wants it.</summary>
    public int Bottom => Y + Height;

    /// <summary>Size of a tightly packed BGRA copy of this box.</summary>
    public int ByteCount => checked(Width * Height * 4);
}

/// <summary>
/// Turns a requested region into a crop the GPU will accept — pure arithmetic, no
/// Windows API, so the interesting cases (a region hanging off the edge of a portrait
/// display, a zero-height region, a region past the right edge) are unit tests rather
/// than something you discover by dragging a rectangle around a real screen.
///
/// <para>This is <b>not</b> a coordinate conversion. The region arrives in physical px
/// relative to the monitor's top-left and stays there; there is no scale arithmetic
/// anywhere in this file (CLAUDE.md invariant 3).</para>
/// </summary>
public static class CaptureGeometry
{
    /// <summary>
    /// Resolves <paramref name="region"/> against a surface of the given size.
    ///
    /// <para>Out-of-bounds is split into two outcomes on purpose:</para>
    /// <list type="bullet">
    ///   <item>A region whose <i>origin</i> is off the surface — negative, or past the
    ///   right/bottom edge — is rejected. There is no sane crop to fall back to, and
    ///   silently substituting one would hand OCR a rectangle the user never chose.</item>
    ///   <item>A region that <i>starts</i> on the surface but overhangs the right or
    ///   bottom edge is clamped. The origin is preserved, so every bbox the OCR engine
    ///   returns still means what the protocol says it means, and the user gets the
    ///   part of their selection that exists. This is the ordinary case when a display
    ///   is switched to a lower resolution while a region is configured.</item>
    /// </list>
    /// </summary>
    /// <param name="region">Requested region, physical px relative to the surface's top-left.</param>
    /// <param name="surfaceWidth">Captured surface width in physical px.</param>
    /// <param name="surfaceHeight">Captured surface height in physical px.</param>
    /// <param name="box">The crop to copy, when this returns <c>true</c>.</param>
    /// <param name="error">Why the region was rejected, when this returns <c>false</c>.</param>
    public static bool TryResolve(
        Rect region,
        int surfaceWidth,
        int surfaceHeight,
        out CropBox box,
        out string error)
    {
        box = default;

        if (surfaceWidth <= 0 || surfaceHeight <= 0)
        {
            error = $"the captured surface is {surfaceWidth}x{surfaceHeight}";
            return false;
        }

        if (region.Width <= 0 || region.Height <= 0)
        {
            error = $"region {Describe(region)} has no area";
            return false;
        }

        if (region.X < 0 || region.Y < 0)
        {
            // Region coordinates are monitor-relative, so a negative origin is not the
            // negative-x virtual-desktop case — it is a caller that forgot to subtract
            // the monitor origin.
            error = $"region {Describe(region)} starts outside the display "
                + $"(origin must be >= 0; coordinates are relative to the display, not the virtual desktop)";
            return false;
        }

        if (region.X >= surfaceWidth || region.Y >= surfaceHeight)
        {
            error = $"region {Describe(region)} starts past the edge of the {surfaceWidth}x{surfaceHeight} display";
            return false;
        }

        var width = Math.Min(region.Width, surfaceWidth - region.X);
        var height = Math.Min(region.Height, surfaceHeight - region.Y);

        box = new CropBox(region.X, region.Y, width, height);
        error = string.Empty;
        return true;
    }

    private static string Describe(Rect region)
        => $"[{region.X},{region.Y},{region.Width},{region.Height}]";
}
