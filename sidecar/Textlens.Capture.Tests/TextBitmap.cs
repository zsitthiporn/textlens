using System.Runtime.InteropServices;

namespace Textlens.Capture.Tests;

/// <summary>
/// Renders known text into a BGRA buffer shaped exactly like one
/// <see cref="Textlens.Capture.Services.CaptureService"/> produces, so
/// <see cref="Textlens.Capture.Services.OcrService"/> can be tested against text whose
/// content and position are known in advance.
///
/// <para><b>Why GDI and not a stored image.</b> The issue suggests golden images of real
/// game dialogue, but those are copyrighted and explicitly not committed. Rendering the
/// text here instead makes the expected output part of the test rather than part of a
/// binary someone has to have — and it is deterministic, so a failure is reproducible on
/// any machine rather than "works on the box with the screenshots".</para>
///
/// <para>Test-only scaffolding, which is why plain <c>[DllImport]</c> is fine here: the
/// test assembly is never published with NativeAOT, unlike the sidecar, whose interop
/// goes through raw vtable calls in <c>Interop/NativeMethods.cs</c>.</para>
/// </summary>
internal static class TextBitmap
{
    private const int BiRgb = 0;
    private const uint DibRgbColors = 0;
    private const int WhiteBrush = 0;
    private const int Opaque = 2;
    private const int AntialiasedQuality = 4;
    private const int DefaultCharset = 1;
    private const int FwNormal = 400;

    /// <summary>
    /// Draws <paramref name="lines"/> as black text on white, one line per entry.
    /// </summary>
    /// <param name="width">Buffer width in px.</param>
    /// <param name="height">Buffer height in px.</param>
    /// <param name="lines">Text to draw, top to bottom.</param>
    /// <param name="fontSize">Cell height in px. ~28 is a typical subtitle at 1080p.</param>
    /// <param name="originX">Left inset of the text, in px.</param>
    /// <param name="originY">Top inset of the first line, in px.</param>
    /// <param name="lineSpacing">Baseline-to-baseline distance, in px.</param>
    /// <returns>BGRA8, tightly packed, alpha forced opaque.</returns>
    public static byte[] Render(
        int width,
        int height,
        string[] lines,
        int fontSize = 28,
        int originX = 40,
        int originY = 30,
        int lineSpacing = 44)
    {
        var pixels = Blank(width, height);

        var hdc = CreateCompatibleDC(IntPtr.Zero);
        if (hdc == IntPtr.Zero)
        {
            throw new InvalidOperationException("CreateCompatibleDC failed");
        }

        var header = new BitmapInfoHeader
        {
            BiSize = (uint)Marshal.SizeOf<BitmapInfoHeader>(),
            BiWidth = width,
            // Negative height selects a top-down DIB, so row 0 is the top row and the
            // buffer matches the capture path's layout without a vertical flip.
            BiHeight = -height,
            BiPlanes = 1,
            BiBitCount = 32,
            BiCompression = BiRgb,
        };

        var bitmap = CreateDIBSection(hdc, ref header, DibRgbColors, out var bits, IntPtr.Zero, 0);
        if (bitmap == IntPtr.Zero || bits == IntPtr.Zero)
        {
            DeleteDC(hdc);
            throw new InvalidOperationException("CreateDIBSection failed");
        }

        var previousBitmap = SelectObject(hdc, bitmap);
        var font = IntPtr.Zero;
        var previousFont = IntPtr.Zero;

        try
        {
            var full = new Rect { Left = 0, Top = 0, Right = width, Bottom = height };
            FillRect(hdc, ref full, GetStockObject(WhiteBrush));

            font = CreateFontW(
                -fontSize, 0, 0, 0, FwNormal, 0, 0, 0,
                DefaultCharset, 0, 0, AntialiasedQuality, 0, "Segoe UI");
            if (font == IntPtr.Zero)
            {
                throw new InvalidOperationException("CreateFontW failed");
            }

            previousFont = SelectObject(hdc, font);

            SetBkMode(hdc, Opaque);
            SetBkColor(hdc, 0x00FFFFFF);
            SetTextColor(hdc, 0x00000000);

            for (var i = 0; i < lines.Length; i++)
            {
                var text = lines[i];
                if (!TextOutW(hdc, originX, originY + (i * lineSpacing), text, text.Length))
                {
                    throw new InvalidOperationException($"TextOutW failed on line {i}");
                }
            }

            GdiFlush();

            // A 32bpp DIB's stride is always width * 4 — 32-bit rows are inherently
            // 4-byte aligned — so a single copy is correct here, unlike the D3D staging
            // texture where RowPitch has to be honoured.
            Marshal.Copy(bits, pixels, 0, pixels.Length);

            // GDI leaves the alpha byte at 0. A capture buffer is not transparent, so
            // force it opaque; the OCR path's own alpha handling is covered separately by
            // OcrServiceTests.ReadsTextFromABufferWhoseAlphaChannelIsEntirelyZero.
            for (var i = 3; i < pixels.Length; i += 4)
            {
                pixels[i] = 0xFF;
            }

            return pixels;
        }
        finally
        {
            if (previousFont != IntPtr.Zero)
            {
                SelectObject(hdc, previousFont);
            }

            if (font != IntPtr.Zero)
            {
                DeleteObject(font);
            }

            SelectObject(hdc, previousBitmap);
            DeleteObject(bitmap);
            DeleteDC(hdc);
        }
    }

    /// <summary>A uniform white buffer — the "region with no text" case.</summary>
    public static byte[] Blank(int width, int height)
    {
        var pixels = new byte[width * height * 4];
        Array.Fill(pixels, (byte)0xFF);
        return pixels;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public uint BiSize;
        public int BiWidth;
        public int BiHeight;
        public ushort BiPlanes;
        public ushort BiBitCount;
        public uint BiCompression;
        public uint BiSizeImage;
        public int BiXPelsPerMeter;
        public int BiYPelsPerMeter;
        public uint BiClrUsed;
        public uint BiClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateDIBSection(
        IntPtr hdc,
        ref BitmapInfoHeader header,
        uint usage,
        out IntPtr bits,
        IntPtr section,
        uint offset);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFontW(
        int height,
        int width,
        int escapement,
        int orientation,
        int weight,
        uint italic,
        uint underline,
        uint strikeOut,
        uint charSet,
        uint outPrecision,
        uint clipPrecision,
        uint quality,
        uint pitchAndFamily,
        string faceName);

    [DllImport("gdi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool TextOutW(IntPtr hdc, int x, int y, string text, int length);

    [DllImport("gdi32.dll")]
    private static extern uint SetTextColor(IntPtr hdc, uint color);

    [DllImport("gdi32.dll")]
    private static extern uint SetBkColor(IntPtr hdc, uint color);

    [DllImport("gdi32.dll")]
    private static extern int SetBkMode(IntPtr hdc, int mode);

    [DllImport("gdi32.dll")]
    private static extern IntPtr GetStockObject(int object_);

    [DllImport("gdi32.dll")]
    private static extern bool GdiFlush();

    [DllImport("user32.dll")]
    private static extern int FillRect(IntPtr hdc, ref Rect rect, IntPtr brush);
}
