using System.Diagnostics;
using Textlens.Capture.Interop;
using Textlens.Capture.Protocol;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;

namespace Textlens.Capture.Services;

/// <summary>
/// One captured region: a tightly packed BGRA buffer plus what it cost.
///
/// <see cref="Pixels"/> is a slice of a buffer the <see cref="CaptureService"/> reuses
/// across frames — <b>valid only until the next capture</b>. That is the point: a fresh
/// array per frame is ~700KB of garbage 60 times a second, which is exactly the growth
/// the 1000-frame acceptance criterion is looking for.
/// </summary>
/// <param name="Pixels">BGRA8, tightly packed, <c>Width * Height * 4</c> bytes.</param>
/// <param name="Width">Region width in physical px.</param>
/// <param name="Height">Region height in physical px.</param>
/// <param name="Monitor">The display this came from, including its raw physical bounds and scale.</param>
/// <param name="Region">The crop actually taken, physical px relative to the display's top-left.</param>
/// <param name="CaptureMicroseconds">Frame-in-hand to buffer-ready, excluding the wait for the next frame.</param>
public readonly record struct CapturedRegion(
    ReadOnlyMemory<byte> Pixels,
    int Width,
    int Height,
    MonitorInfo Monitor,
    Rect Region,
    long CaptureMicroseconds);

/// <summary>
/// Feature C1 — Windows Graphics Capture of one display, cropped to one region.
///
/// <para><b>Why a region and not the full screen:</b> spike S1 measured region crop as
/// ~4x faster than full-frame OCR <i>and</i> more accurate, because a tight crop
/// removes the surrounding UI the recognizer would otherwise try to read.</para>
///
/// <para><b>Session reuse.</b> The D3D11 device, the WGC item, the frame pool, the
/// session and the staging texture are all created once in <see cref="Open"/> and live
/// until <see cref="Dispose"/>. Only the per-frame
/// <see cref="Direct3D11CaptureFrame"/> is transient, and it is disposed the moment its
/// pixels are copied. Recreating the session per tick would cost tens of ms and leak
/// GPU memory under a 60Hz loop.</para>
///
/// <para><b>Targeting a specific display.</b> <c>GraphicsCaptureItem</c> normally comes
/// from <c>GraphicsCapturePicker</c>, which is a user-visible UI and unusable for an
/// unattended overlay. <c>IGraphicsCaptureItemInterop.CreateForMonitor</c> is the
/// documented interop path that takes an HMONITOR directly: no picker, no consent
/// dialog. (<c>GraphicsCaptureItem.TryCreateFromDisplayId</c> would be tidier but is a
/// 22621+ projection, and the sidecar TFM is pinned at 19041.)</para>
///
/// <para><b>No scale arithmetic.</b> The region is physical px in, physical px out.
/// <c>scale</c> is carried through to the wire as a number and never applied
/// (CLAUDE.md invariant 3, design doc section 3).</para>
/// </summary>
public sealed class CaptureService : IRegionSource, IDisposable
{
    private const int FramePoolBufferCount = 2;

    private readonly object gate = new();

    // Frame arrival is a signal, not a queue: the pool already buffers, and we only
    // ever want the newest frame. A ManualResetEventSlim that we reset before draining
    // gives "wait until something is available" without allocating per frame.
    private readonly ManualResetEventSlim frameAvailable = new(false);

    private IntPtr d3dDevice;
    private IntPtr d3dContext;
    private IntPtr stagingTexture;
    private int stagingWidth;
    private int stagingHeight;

    private IDirect3DDevice? winrtDevice;
    private GraphicsCaptureItem? item;
    private Direct3D11CaptureFramePool? framePool;
    private GraphicsCaptureSession? session;

    private byte[] buffer = [];
    private MonitorDescriptor? monitor;
    private bool disposed;

    /// <summary>Whether this Windows build supports Windows Graphics Capture at all.</summary>
    public static bool IsSupported => GraphicsCaptureSession.IsSupported();

    /// <summary>The display this service is bound to, once <see cref="Open"/> has run.</summary>
    public MonitorInfo Monitor
        => monitor?.Info ?? throw new InvalidOperationException("Open has not been called");

    /// <summary>Size of the captured display surface in physical px.</summary>
    public SizeInt32 SurfaceSize { get; private set; }

    /// <summary>
    /// Binds to a display and starts a capture session that stays alive until disposal.
    /// </summary>
    public void Open(MonitorDescriptor target)
    {
        ArgumentNullException.ThrowIfNull(target);
        ObjectDisposedException.ThrowIf(disposed, this);

        if (session is not null)
        {
            throw new InvalidOperationException("this CaptureService is already open");
        }

        if (!IsSupported)
        {
            throw new InvalidOperationException(
                "Windows Graphics Capture is not available on this system");
        }

        monitor = target;

        CreateD3DDevice();
        item = CreateItemForMonitor(target.Handle);
        SurfaceSize = item.Size;

        // CreateFreeThreaded, not Create: the sidecar is a console process with no
        // DispatcherQueue, and the plain overload requires one on the calling thread.
        framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            winrtDevice,
            DirectXPixelFormat.B8G8R8A8UIntNormalized,
            FramePoolBufferCount,
            SurfaceSize);

        framePool.FrameArrived += OnFrameArrived;

        session = framePool.CreateCaptureSession(item);

        // Deliberately NOT touching GraphicsCaptureSession.IsBorderRequired or
        // GraphicsCaptureAccess.RequestAccessAsync: on current Windows builds the
        // borderless path can raise a system consent dialog, and a consent dialog is a
        // UX decision that is not this issue's to make.
        session.StartCapture();
    }

    /// <summary>
    /// Blocks until the compositor delivers a frame, so that
    /// <see cref="CaptureRegion"/> measures the copy rather than the wait for vblank.
    /// </summary>
    /// <returns><c>false</c> on timeout.</returns>
    public bool WaitForFrame(TimeSpan timeout)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        return frameAvailable.Wait(timeout);
    }

    /// <summary>
    /// Copies <paramref name="region"/> out of the most recent frame.
    ///
    /// <para>Returns <c>null</c> when no frame is queued — a normal outcome on a static
    /// screen, where the compositor has nothing new to hand over, not an error.</para>
    /// </summary>
    /// <exception cref="ArgumentException">The region does not fit the display.</exception>
    public CapturedRegion? CaptureRegion(Rect region)
    {
        ObjectDisposedException.ThrowIf(disposed, this);

        if (framePool is null || monitor is null)
        {
            throw new InvalidOperationException("Open has not been called");
        }

        // Reset before draining, never after: a frame that arrives during the copy must
        // leave the event set, or the next Wait blocks until the frame after that.
        frameAvailable.Reset();

        using var frame = framePool.TryGetNextFrame();
        if (frame is null)
        {
            return null;
        }

        var stopwatch = Stopwatch.StartNew();

        var surfaceSize = frame.ContentSize;
        if (!CaptureGeometry.TryResolve(region, surfaceSize.Width, surfaceSize.Height, out var box, out var error))
        {
            throw new ArgumentException(error, nameof(region));
        }

        lock (gate)
        {
            CopyToBuffer(frame, box);
        }

        stopwatch.Stop();

        return new CapturedRegion(
            buffer.AsMemory(0, box.ByteCount),
            box.Width,
            box.Height,
            monitor.Info,
            new Rect(box.X, box.Y, box.Width, box.Height),
            stopwatch.Elapsed.Ticks / (TimeSpan.TicksPerMillisecond / 1000));
    }

    private unsafe void CopyToBuffer(Direct3D11CaptureFrame frame, CropBox box)
    {
        EnsureStaging(box.Width, box.Height);
        EnsureBuffer(box.ByteCount);

        var sourceTexture = GetTexture(frame.Surface);
        try
        {
            var sourceBox = new NativeMethods.Box
            {
                Left = (uint)box.X,
                Top = (uint)box.Y,
                Front = 0,
                Right = (uint)box.Right,
                Bottom = (uint)box.Bottom,
                Back = 1,
            };

            // The whole reason this is fast: only the region crosses the GPU→CPU
            // boundary, not the whole 3440x1440 desktop.
            NativeMethods.CopySubresourceRegion(d3dContext, stagingTexture, sourceTexture, ref sourceBox);

            NativeMethods.ThrowIfFailed(
                "ID3D11DeviceContext::Map(staging)",
                NativeMethods.Map(d3dContext, stagingTexture, out var mapped));

            try
            {
                var rowBytes = box.Width * 4;

                // RowPitch is the driver's stride and is >= rowBytes, often rounded up
                // for alignment. Treating the mapped memory as tightly packed is the
                // classic silent-corruption bug here: it would shear the image and hand
                // OCR garbage on some GPUs and not others.
                if (mapped.RowPitch == (uint)rowBytes)
                {
                    new ReadOnlySpan<byte>((void*)mapped.PData, box.ByteCount).CopyTo(buffer);
                }
                else
                {
                    var source = (byte*)mapped.PData;
                    for (var y = 0; y < box.Height; y++)
                    {
                        new ReadOnlySpan<byte>(source + ((long)y * mapped.RowPitch), rowBytes)
                            .CopyTo(buffer.AsSpan(y * rowBytes, rowBytes));
                    }
                }
            }
            finally
            {
                NativeMethods.Unmap(d3dContext, stagingTexture);
            }
        }
        finally
        {
            NativeMethods.Release(sourceTexture);
        }
    }

    /// <summary>
    /// Unwraps the WinRT surface to the underlying ID3D11Texture2D. The caller owns the
    /// returned pointer and must Release it.
    /// </summary>
    private static IntPtr GetTexture(IDirect3DSurface surface)
    {
        var unknown = WinRT.MarshalInterface<IDirect3DSurface>.FromManaged(surface);
        try
        {
            var accessIid = NativeMethods.IidDirect3DDxgiInterfaceAccess;
            NativeMethods.ThrowIfFailed(
                "QueryInterface(IDirect3DDxgiInterfaceAccess)",
                NativeMethods.QueryInterface(unknown, ref accessIid, out var access));

            try
            {
                var textureIid = NativeMethods.IidD3D11Texture2D;
                NativeMethods.ThrowIfFailed(
                    "IDirect3DDxgiInterfaceAccess::GetInterface(ID3D11Texture2D)",
                    NativeMethods.GetInterface(access, ref textureIid, out var texture));

                return texture;
            }
            finally
            {
                NativeMethods.Release(access);
            }
        }
        finally
        {
            NativeMethods.Release(unknown);
        }
    }

    /// <summary>
    /// Allocates the CPU-readable staging texture, reusing it whenever the crop size is
    /// unchanged — which is every frame in steady state.
    /// </summary>
    private void EnsureStaging(int width, int height)
    {
        if (stagingTexture != IntPtr.Zero && stagingWidth == width && stagingHeight == height)
        {
            return;
        }

        NativeMethods.Release(stagingTexture);
        stagingTexture = IntPtr.Zero;

        var desc = new NativeMethods.Texture2DDesc
        {
            Width = (uint)width,
            Height = (uint)height,
            MipLevels = 1,
            ArraySize = 1,
            Format = NativeMethods.DxgiFormatB8G8R8A8Unorm,
            SampleCount = 1,
            SampleQuality = 0,
            Usage = NativeMethods.D3D11UsageStaging,
            BindFlags = 0,
            CpuAccessFlags = NativeMethods.D3D11CpuAccessRead,
            MiscFlags = 0,
        };

        NativeMethods.ThrowIfFailed(
            $"ID3D11Device::CreateTexture2D(staging {width}x{height})",
            NativeMethods.CreateTexture2D(d3dDevice, ref desc, out stagingTexture));

        stagingWidth = width;
        stagingHeight = height;
    }

    private void EnsureBuffer(int byteCount)
    {
        if (buffer.Length < byteCount)
        {
            buffer = new byte[byteCount];
        }
    }

    private void CreateD3DDevice()
    {
        var hr = NativeMethods.D3D11CreateDevice(
            IntPtr.Zero,
            NativeMethods.D3D11DriverTypeHardware,
            IntPtr.Zero,
            NativeMethods.D3D11CreateDeviceBgraSupport,
            IntPtr.Zero,
            0,
            NativeMethods.D3D11SdkVersion,
            out d3dDevice,
            out _,
            out d3dContext);

        if (hr < 0)
        {
            // WARP keeps the sidecar alive in a VM or on a machine whose GPU driver is
            // mid-update. Slower, but a slow overlay beats a dead one (invariant 4).
            hr = NativeMethods.D3D11CreateDevice(
                IntPtr.Zero,
                NativeMethods.D3D11DriverTypeWarp,
                IntPtr.Zero,
                NativeMethods.D3D11CreateDeviceBgraSupport,
                IntPtr.Zero,
                0,
                NativeMethods.D3D11SdkVersion,
                out d3dDevice,
                out _,
                out d3dContext);

            NativeMethods.ThrowIfFailed("D3D11CreateDevice (hardware, then WARP)", hr);
        }

        var dxgiIid = NativeMethods.IidDxgiDevice;
        NativeMethods.ThrowIfFailed(
            "QueryInterface(IDXGIDevice)",
            NativeMethods.QueryInterface(d3dDevice, ref dxgiIid, out var dxgiDevice));

        try
        {
            NativeMethods.ThrowIfFailed(
                "CreateDirect3D11DeviceFromDXGIDevice",
                NativeMethods.CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out var inspectable));

            try
            {
                winrtDevice = WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
            }
            finally
            {
                NativeMethods.Release(inspectable);
            }
        }
        finally
        {
            NativeMethods.Release(dxgiDevice);
        }
    }

    private static GraphicsCaptureItem CreateItemForMonitor(IntPtr hmonitor)
    {
        var interopIid = NativeMethods.IidGraphicsCaptureItemInterop;
        var factory = NativeMethods.GetActivationFactory(
            "Windows.Graphics.Capture.GraphicsCaptureItem",
            ref interopIid);

        try
        {
            var itemIid = NativeMethods.IidGraphicsCaptureItem;
            NativeMethods.ThrowIfFailed(
                "IGraphicsCaptureItemInterop::CreateForMonitor",
                NativeMethods.CreateForMonitor(factory, hmonitor, ref itemIid, out var abi));

            try
            {
                return WinRT.MarshalInterface<GraphicsCaptureItem>.FromAbi(abi);
            }
            finally
            {
                NativeMethods.Release(abi);
            }
        }
        finally
        {
            NativeMethods.Release(factory);
        }
    }

    private void OnFrameArrived(Direct3D11CaptureFramePool sender, object args) => frameAvailable.Set();

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;

        if (framePool is not null)
        {
            framePool.FrameArrived -= OnFrameArrived;
        }

        session?.Dispose();
        framePool?.Dispose();
        session = null;
        framePool = null;
        item = null;
        winrtDevice = null;

        NativeMethods.Release(stagingTexture);
        NativeMethods.Release(d3dContext);
        NativeMethods.Release(d3dDevice);
        stagingTexture = IntPtr.Zero;
        d3dContext = IntPtr.Zero;
        d3dDevice = IntPtr.Zero;

        frameAvailable.Dispose();
        buffer = [];
    }
}
