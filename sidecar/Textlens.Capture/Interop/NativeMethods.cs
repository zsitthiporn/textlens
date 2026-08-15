using System.Runtime.InteropServices;

namespace Textlens.Capture.Interop;

/// <summary>
/// The raw Win32/D3D11/WinRT-activation surface the capture path needs.
///
/// Hand-rolled rather than taken from Vortice/SharpDX: the sidecar needs six D3D11
/// entry points, and a NuGet dependency for six entry points is not a trade worth
/// making against a NativeAOT binary we are keeping at ~1.6MB.
///
/// Every vtable index and GUID below was read out of the 10.0.26100.0 SDK headers
/// (<c>d3d11.h</c>, <c>dxgi.h</c>, <c>windows.graphics.capture.interop.h</c>,
/// <c>windows.graphics.directx.direct3d11.interop.h</c>) rather than from memory — a
/// wrong index here is not a compile error, it is a crash or, worse, silence.
/// </summary>
internal static unsafe class NativeMethods
{
    // ---- COM / vtable indices (verified against the SDK headers) ----

    /// <summary>ID3D11Device::CreateTexture2D — QI/AddRef/Release/CreateBuffer/CreateTexture1D precede it.</summary>
    private const int VtblCreateTexture2D = 5;

    /// <summary>ID3D11DeviceContext::Map.</summary>
    private const int VtblMap = 14;

    /// <summary>ID3D11DeviceContext::Unmap.</summary>
    private const int VtblUnmap = 15;

    /// <summary>ID3D11DeviceContext::CopySubresourceRegion.</summary>
    private const int VtblCopySubresourceRegion = 46;

    /// <summary>IGraphicsCaptureItemInterop::CreateForMonitor — CreateForWindow is 3.</summary>
    private const int VtblCreateForMonitor = 4;

    /// <summary>IDirect3DDxgiInterfaceAccess::GetInterface — the only method past IUnknown.</summary>
    private const int VtblGetInterface = 3;

    // ---- GUIDs ----

    internal static readonly Guid IidDxgiDevice = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    internal static readonly Guid IidD3D11Texture2D = new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
    internal static readonly Guid IidGraphicsCaptureItemInterop = new("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");
    internal static readonly Guid IidDirect3DDxgiInterfaceAccess = new("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1");

    /// <summary>IID of the projected Windows.Graphics.Capture.IGraphicsCaptureItem.</summary>
    internal static readonly Guid IidGraphicsCaptureItem = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    // ---- D3D11 constants ----

    internal const int D3D11SdkVersion = 7;
    internal const int D3D11DriverTypeHardware = 1;
    internal const int D3D11DriverTypeWarp = 5;
    internal const uint D3D11CreateDeviceBgraSupport = 0x20;
    internal const int D3D11UsageStaging = 3;
    internal const uint D3D11CpuAccessRead = 0x20000;
    internal const uint D3D11MapRead = 1;
    internal const int DxgiFormatB8G8R8A8Unorm = 87;

    // ---- DPI ----

    /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, i.e. (HANDLE)-4.</summary>
    internal static readonly IntPtr DpiAwarenessContextPerMonitorAwareV2 = new(-4);

    /// <summary>MDT_EFFECTIVE_DPI — the scale the user actually picked in Settings.</summary>
    internal const int MdtEffectiveDpi = 0;

    internal const uint MonitorInfoFlagPrimary = 1;

    // ---- structs ----

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    /// <summary>MONITORINFOEXW. <see cref="SzDevice"/> is a fixed 32-char buffer (CCHDEVICENAME).</summary>
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal unsafe struct MonitorInfoEx
    {
        public uint CbSize;
        public Rect RcMonitor;
        public Rect RcWork;
        public uint DwFlags;
        public fixed char SzDevice[32];
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct Texture2DDesc
    {
        public uint Width;
        public uint Height;
        public uint MipLevels;
        public uint ArraySize;
        public int Format;
        public uint SampleCount;
        public uint SampleQuality;
        public int Usage;
        public uint BindFlags;
        public uint CpuAccessFlags;
        public uint MiscFlags;
    }

    /// <summary>D3D11_BOX. Right/Bottom/Back are exclusive.</summary>
    [StructLayout(LayoutKind.Sequential)]
    internal struct Box
    {
        public uint Left;
        public uint Top;
        public uint Front;
        public uint Right;
        public uint Bottom;
        public uint Back;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MappedSubresource
    {
        public IntPtr PData;
        public uint RowPitch;
        public uint DepthPitch;
    }

    // ---- P/Invoke ----

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetThreadDpiAwarenessContext();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumDisplayMonitors(
        IntPtr hdc,
        IntPtr clipRect,
        delegate* unmanaged[Stdcall]<IntPtr, IntPtr, Rect*, IntPtr, int> callback,
        IntPtr data);

    [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetMonitorInfoW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfoEx info);

    [DllImport("Shcore.dll")]
    internal static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);

    [DllImport("d3d11.dll")]
    internal static extern int D3D11CreateDevice(
        IntPtr adapter,
        int driverType,
        IntPtr software,
        uint flags,
        IntPtr featureLevels,
        uint featureLevelCount,
        uint sdkVersion,
        out IntPtr device,
        out int featureLevel,
        out IntPtr immediateContext);

    [DllImport("d3d11.dll")]
    internal static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [DllImport("combase.dll")]
    internal static extern int WindowsCreateString(
        [MarshalAs(UnmanagedType.LPWStr)] string sourceString,
        int length,
        out IntPtr hstring);

    [DllImport("combase.dll")]
    internal static extern int WindowsDeleteString(IntPtr hstring);

    [DllImport("combase.dll")]
    internal static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);

    // ---- vtable call helpers ----

    internal static int QueryInterface(IntPtr unknown, ref Guid iid, out IntPtr result)
    {
        var vtbl = *(void***)unknown;
        fixed (Guid* pIid = &iid)
        fixed (IntPtr* pResult = &result)
        {
            result = IntPtr.Zero;
            return ((delegate* unmanaged[Stdcall]<IntPtr, Guid*, IntPtr*, int>)vtbl[0])(unknown, pIid, pResult);
        }
    }

    internal static uint Release(IntPtr unknown)
    {
        if (unknown == IntPtr.Zero)
        {
            return 0;
        }

        var vtbl = *(void***)unknown;
        return ((delegate* unmanaged[Stdcall]<IntPtr, uint>)vtbl[2])(unknown);
    }

    internal static int CreateTexture2D(IntPtr device, ref Texture2DDesc desc, out IntPtr texture)
    {
        var vtbl = *(void***)device;
        fixed (Texture2DDesc* pDesc = &desc)
        fixed (IntPtr* pTexture = &texture)
        {
            texture = IntPtr.Zero;
            return ((delegate* unmanaged[Stdcall]<IntPtr, Texture2DDesc*, IntPtr, IntPtr*, int>)vtbl[VtblCreateTexture2D])(
                device, pDesc, IntPtr.Zero, pTexture);
        }
    }

    internal static void CopySubresourceRegion(
        IntPtr context,
        IntPtr destination,
        IntPtr source,
        ref Box sourceBox)
    {
        var vtbl = *(void***)context;
        fixed (Box* pBox = &sourceBox)
        {
            ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, uint, uint, uint, IntPtr, uint, Box*, void>)
                vtbl[VtblCopySubresourceRegion])(context, destination, 0, 0, 0, 0, source, 0, pBox);
        }
    }

    internal static int Map(IntPtr context, IntPtr resource, out MappedSubresource mapped)
    {
        var vtbl = *(void***)context;
        fixed (MappedSubresource* pMapped = &mapped)
        {
            mapped = default;
            return ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, uint, uint, MappedSubresource*, int>)vtbl[VtblMap])(
                context, resource, 0, D3D11MapRead, 0, pMapped);
        }
    }

    internal static void Unmap(IntPtr context, IntPtr resource)
    {
        var vtbl = *(void***)context;
        ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, uint, void>)vtbl[VtblUnmap])(context, resource, 0);
    }

    /// <summary>IGraphicsCaptureItemInterop::CreateForMonitor — the only way to target a
    /// specific display without the system capture picker (see the note in CaptureService).</summary>
    internal static int CreateForMonitor(IntPtr interop, IntPtr monitor, ref Guid iid, out IntPtr item)
    {
        var vtbl = *(void***)interop;
        fixed (Guid* pIid = &iid)
        fixed (IntPtr* pItem = &item)
        {
            item = IntPtr.Zero;
            return ((delegate* unmanaged[Stdcall]<IntPtr, IntPtr, Guid*, IntPtr*, int>)vtbl[VtblCreateForMonitor])(
                interop, monitor, pIid, pItem);
        }
    }

    /// <summary>IDirect3DDxgiInterfaceAccess::GetInterface — unwraps a WinRT surface to its DXGI/D3D11 original.</summary>
    internal static int GetInterface(IntPtr access, ref Guid iid, out IntPtr result)
    {
        var vtbl = *(void***)access;
        fixed (Guid* pIid = &iid)
        fixed (IntPtr* pResult = &result)
        {
            result = IntPtr.Zero;
            return ((delegate* unmanaged[Stdcall]<IntPtr, Guid*, IntPtr*, int>)vtbl[VtblGetInterface])(access, pIid, pResult);
        }
    }

    /// <summary>
    /// Fetches a WinRT activation factory by class name and IID.
    ///
    /// Explicit <c>RoGetActivationFactory</c> rather than CsWinRT's factory cache
    /// because the interface we want (<c>IGraphicsCaptureItemInterop</c>) is a classic
    /// COM interop interface with no projection — there is nothing for CsWinRT to hand
    /// back, and the <c>[ComImport]</c> route it would otherwise need is not
    /// NativeAOT-safe.
    /// </summary>
    internal static IntPtr GetActivationFactory(string runtimeClassName, ref Guid iid)
    {
        var hr = WindowsCreateString(runtimeClassName, runtimeClassName.Length, out var hstring);
        if (hr < 0)
        {
            throw Failure($"WindowsCreateString(\"{runtimeClassName}\")", hr);
        }

        try
        {
            hr = RoGetActivationFactory(hstring, ref iid, out var factory);
            if (hr < 0)
            {
                throw Failure($"RoGetActivationFactory(\"{runtimeClassName}\")", hr);
            }

            return factory;
        }
        finally
        {
            _ = WindowsDeleteString(hstring);
        }
    }

    /// <summary>
    /// Turns an HRESULT into an exception whose message names the call that produced it.
    /// The HRESULT alone is a hex number nobody can act on (CLAUDE.md invariant 4).
    /// </summary>
    internal static InvalidOperationException Failure(string what, int hr)
        => new($"{what} failed with HRESULT 0x{hr:X8}");

    internal static void ThrowIfFailed(string what, int hr)
    {
        if (hr < 0)
        {
            throw Failure(what, hr);
        }
    }
}
