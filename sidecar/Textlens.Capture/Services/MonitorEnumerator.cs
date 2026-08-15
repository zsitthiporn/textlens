using System.Runtime.InteropServices;
using Textlens.Capture.Interop;
using Textlens.Capture.Protocol;

namespace Textlens.Capture.Services;

/// <summary>
/// One display, as the sidecar sees it: the protocol payload plus the
/// <see cref="Handle"/> that <c>IGraphicsCaptureItemInterop.CreateForMonitor</c> needs.
///
/// The handle stays out of <see cref="MonitorInfo"/> deliberately — an HMONITOR is
/// process-lifetime-scoped and meaningless to Node, which addresses displays by the
/// device name in <see cref="MonitorInfo.Id"/>.
/// </summary>
/// <param name="Info">The wire payload for this display.</param>
/// <param name="Handle">HMONITOR, valid only inside this process.</param>
/// <param name="IsPrimary">Whether Windows considers this the primary display.</param>
public sealed record MonitorDescriptor(MonitorInfo Info, IntPtr Handle, bool IsPrimary);

/// <summary>
/// Enumerates displays for the <c>listMonitors</c> command (design doc section 3).
///
/// <para><b>Bounds are raw physical px from Win32 and are never divided by
/// <c>scale</c>.</b> This is the coordinate ruling of 2026-08-16 recorded in design doc
/// section 3: when displays differ in DPI, a display's logical origin cannot be derived
/// from its physical origin, because Chromium lays displays out adjacent in DIP space
/// rather than dividing each physical rect by that display's own scale. Node takes the
/// logical origin from Electron; the sidecar reports what Win32 says and does no scale
/// arithmetic at all (CLAUDE.md invariant 3).</para>
/// </summary>
public static class MonitorEnumerator
{
    /// <summary>
    /// Makes this process per-monitor DPI aware (V2).
    ///
    /// <para>Load-bearing, and invisible on a rig where every display sits at 100%: an
    /// unmanifested console exe is DPI-<i>unaware</i>, and Windows then hands a
    /// DPI-unaware process <i>virtualized</i> rectangles from
    /// <c>EnumDisplayMonitors</c> and the system DPI from <c>GetDpiForMonitor</c> for
    /// every display regardless of its real setting. At 100% the virtualization is the
    /// identity transform, so the bug is undetectable here and would ship broken to
    /// every 125%/150% user — exactly the DPI failure the design doc says the reference
    /// project shipped.</para>
    ///
    /// <para>Must run before the first monitor query or any window is created; the
    /// awareness context is latched at first use.</para>
    /// </summary>
    /// <returns><c>true</c> if the context was set by this call.</returns>
    public static bool EnsurePerMonitorDpiAwareness()
        => NativeMethods.SetProcessDpiAwarenessContext(NativeMethods.DpiAwarenessContextPerMonitorAwareV2);

    /// <summary>
    /// Whether this process is genuinely running as per-monitor DPI aware (V2).
    ///
    /// Separate from the setter's return value, which only reports whether <i>this
    /// call</i> latched the context — it returns false when something set it earlier,
    /// including when a host set it to something wrong. On a rig where every display is
    /// at 100% this is the only observable that distinguishes correct DPI handling from
    /// broken DPI handling, because the virtualization Windows applies to a
    /// DPI-unaware process is the identity transform at 100%.
    /// </summary>
    public static bool IsPerMonitorDpiAware()
        => NativeMethods.AreDpiAwarenessContextsEqual(
            NativeMethods.GetThreadDpiAwarenessContext(),
            NativeMethods.DpiAwarenessContextPerMonitorAwareV2);

    /// <summary>
    /// Every display currently attached, in Windows enumeration order.
    /// </summary>
    public static IReadOnlyList<MonitorDescriptor> List()
    {
        var handles = new List<IntPtr>();
        var gcHandle = GCHandle.Alloc(handles);

        try
        {
            unsafe
            {
                if (!NativeMethods.EnumDisplayMonitors(
                        IntPtr.Zero,
                        IntPtr.Zero,
                        &CollectHandle,
                        GCHandle.ToIntPtr(gcHandle)))
                {
                    throw new InvalidOperationException(
                        $"EnumDisplayMonitors failed with Win32 error {Marshal.GetLastWin32Error()}");
                }
            }
        }
        finally
        {
            gcHandle.Free();
        }

        var descriptors = new List<MonitorDescriptor>(handles.Count);
        foreach (var handle in handles)
        {
            descriptors.Add(Describe(handle));
        }

        return descriptors;
    }

    /// <summary>Finds a display by the device name Node sends in <c>configure.monitorId</c>.</summary>
    public static MonitorDescriptor? Find(string monitorId)
    {
        foreach (var descriptor in List())
        {
            if (string.Equals(descriptor.Info.Id, monitorId, StringComparison.OrdinalIgnoreCase))
            {
                return descriptor;
            }
        }

        return null;
    }

    /// <summary>The primary display, or the first one if Windows flags none.</summary>
    public static MonitorDescriptor Primary()
    {
        var all = List();
        if (all.Count == 0)
        {
            throw new InvalidOperationException("no displays are attached");
        }

        foreach (var descriptor in all)
        {
            if (descriptor.IsPrimary)
            {
                return descriptor;
            }
        }

        return all[0];
    }

    private static unsafe MonitorDescriptor Describe(IntPtr handle)
    {
        var info = new NativeMethods.MonitorInfoEx
        {
            CbSize = (uint)sizeof(NativeMethods.MonitorInfoEx),
        };

        if (!NativeMethods.GetMonitorInfo(handle, ref info))
        {
            throw new InvalidOperationException(
                $"GetMonitorInfoW failed with Win32 error {Marshal.GetLastWin32Error()}");
        }

        string deviceName;
        // szDevice is a fixed 32-wchar buffer, NUL-padded rather than NUL-guaranteed.
        var span = new ReadOnlySpan<char>(info.SzDevice, 32);
        var terminator = span.IndexOf('\0');
        deviceName = new string(terminator < 0 ? span : span[..terminator]);

        var hr = NativeMethods.GetDpiForMonitor(handle, NativeMethods.MdtEffectiveDpi, out var dpiX, out _);
        NativeMethods.ThrowIfFailed($"GetDpiForMonitor(\"{deviceName}\")", hr);

        // The one place `scale` is computed, and it is a report, not a conversion:
        // nothing downstream in the sidecar multiplies or divides by it.
        var scale = dpiX / 96.0;

        var bounds = new Rect(
            info.RcMonitor.Left,
            info.RcMonitor.Top,
            info.RcMonitor.Right - info.RcMonitor.Left,
            info.RcMonitor.Bottom - info.RcMonitor.Top);

        return new MonitorDescriptor(
            new MonitorInfo
            {
                Id = deviceName,
                Scale = scale,
                Bounds = bounds,
            },
            handle,
            (info.DwFlags & NativeMethods.MonitorInfoFlagPrimary) != 0);
    }

    /// <summary>
    /// EnumDisplayMonitors callback. <c>[UnmanagedCallersOnly]</c> plus a GCHandle in
    /// lParam rather than a managed delegate, so the call stays NativeAOT-safe and
    /// carries no reverse-P/Invoke marshalling stub.
    /// </summary>
    [UnmanagedCallersOnly(CallConvs = [typeof(System.Runtime.CompilerServices.CallConvStdcall)])]
    private static unsafe int CollectHandle(IntPtr monitor, IntPtr hdc, NativeMethods.Rect* clip, IntPtr data)
    {
        if (GCHandle.FromIntPtr(data).Target is List<IntPtr> handles)
        {
            handles.Add(monitor);
        }

        return 1; // keep enumerating
    }
}
