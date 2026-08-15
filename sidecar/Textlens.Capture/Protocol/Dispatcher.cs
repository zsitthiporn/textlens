using Textlens.Capture.Services;

namespace Textlens.Capture.Protocol;

/// <summary>
/// The machine-specific resources the <see cref="Dispatcher"/> needs, behind an interface
/// so the command state machine can be tested without a display or a recognizer.
/// </summary>
public interface ICaptureHost
{
    /// <summary>Every attached display, as <c>listMonitors</c> reports them.</summary>
    MonitorInfo[] ListMonitors();

    /// <summary>
    /// Opens a capture session on the named display.
    /// </summary>
    /// <exception cref="Exception">No such display, or capture is unavailable.</exception>
    IRegionSource OpenSource(string monitorId);

    /// <summary>
    /// Creates a recognizer for a BCP-47 tag.
    /// </summary>
    /// <exception cref="Exception">No recognizer for that language.</exception>
    IRecognizer CreateRecognizer(string languageTag);

    /// <summary>The PNG encoder for <c>debugFrame</c>, or <c>null</c> if unavailable.</summary>
    IFrameEncoder? CreateEncoder();
}

/// <summary>
/// Issue M2-06 — turns a line of stdin into an action and an event on stdout.
///
/// <para><b>State machine</b> (<see cref="SidecarState"/>): <c>idle</c> until a
/// <c>configure</c> lands, then <c>configured</c>; <c>start</c> moves to <c>running</c>
/// and <c>stop</c> to <c>stopped</c>. Every command that changes state replies with an
/// <c>ack</c> carrying the state it produced, so the machine is legible from a terminal
/// transcript — which is the reason design doc section 3 chose stdio over a named pipe.</para>
///
/// <para><b>Nothing here throws at the caller.</b> <see cref="Execute"/> converts every
/// failure into an <c>error</c> event and returns, because the caller is a read loop and
/// one bad line must cost one event, not the process (invariant 4).</para>
/// </summary>
public sealed class Dispatcher : IDisposable
{
    /// <summary><c>error.code</c> for a line that is not a command this build knows.</summary>
    public const string UnknownCommandCode = "UNKNOWN_COMMAND";

    /// <summary><c>error.code</c> for a command that arrived in the wrong state.</summary>
    public const string NotConfiguredCode = "NOT_CONFIGURED";

    /// <summary><c>error.code</c> for a <c>configure</c> the sidecar could not act on.</summary>
    public const string ConfigureFailedCode = "CONFIGURE_FAILED";

    private readonly ICaptureHost host;
    private readonly Action<ISidecarEvent> emit;

    private IRegionSource? source;
    private IRecognizer? recognizer;
    private CaptureLoop? loop;
    private string? openMonitorId;
    private string? openLanguage;
    private bool disposed;

    public Dispatcher(ICaptureHost host, Action<ISidecarEvent> emit)
    {
        this.host = host ?? throw new ArgumentNullException(nameof(host));
        this.emit = emit ?? throw new ArgumentNullException(nameof(emit));
    }

    /// <summary>Where the state machine currently is.</summary>
    public string State { get; private set; } = SidecarState.Idle;

    /// <summary>The running loop, or <c>null</c> before the first <c>configure</c>.</summary>
    public CaptureLoop? Loop => loop;

    /// <summary>
    /// Decodes one stdin line and acts on it. Never throws.
    /// </summary>
    public void Execute(string line)
    {
        var decoded = ProtocolCodec.DecodeCommand(line);

        if (!decoded.Ok)
        {
            // Every rejection is reported with the reason, so a mis-encoded command from
            // Node is diagnosable from the stream rather than from a debugger.
            emit(new ErrorEvent
            {
                Code = UnknownCommandCode,
                Message = $"{decoded.Failure}: {decoded.Detail}",
            });
            return;
        }

        try
        {
            Dispatch(decoded.Value);
        }
        catch (Exception ex)
        {
            emit(new ErrorEvent { Code = ConfigureFailedCode, Message = $"{ex.GetType().Name}: {ex.Message}" });
        }
    }

    private void Dispatch(ISidecarCommand command)
    {
        switch (command)
        {
            case ListMonitorsCommand:
                // Answerable in any state, including idle: it is how Node discovers what
                // to put in `configure` in the first place.
                emit(new AckEvent
                {
                    Cmd = CommandKind.ListMonitors,
                    State = State,
                    Monitors = host.ListMonitors(),
                });
                break;

            case ConfigureCommand configure:
                Configure(configure);
                break;

            case StartCommand:
                Start();
                break;

            case StopCommand:
                Stop();
                break;

            case SnapshotCommand:
                if (RequireConfigured(CommandKind.Snapshot))
                {
                    loop!.Snapshot();
                }

                break;

            case DebugFrameCommand:
                if (RequireConfigured(CommandKind.DebugFrame))
                {
                    loop!.Snapshot(includeImage: true);
                }

                break;

            default:
                emit(new ErrorEvent
                {
                    Code = UnknownCommandCode,
                    Message = $"no handler for command \"{command.Cmd}\"",
                });
                break;
        }
    }

    /// <summary>
    /// Applies a full configuration, rebuilding only what actually changed.
    ///
    /// <para>Reopening the capture session or the recognizer costs tens of milliseconds, so
    /// a <c>configure</c> that only moves the region or retunes the threshold — the common
    /// case while the user drags a selection — keeps both. That is also what makes
    /// "configure while running takes effect without a restart" true rather than merely
    /// technically true.</para>
    /// </summary>
    private void Configure(ConfigureCommand configure)
    {
        var wasRunning = State == SidecarState.Running;

        var monitorChanged = !string.Equals(openMonitorId, configure.MonitorId, StringComparison.OrdinalIgnoreCase);
        var languageChanged = !string.Equals(openLanguage, configure.OcrLanguage, StringComparison.OrdinalIgnoreCase);

        // Tear the loop down FIRST, and only then the things it is holding.
        //
        // Order is the whole point. The loop owns a live timer whose callback captures
        // `source` and `recognizer`; disposing either of those while the loop still exists
        // leaves a timer firing against disposed objects, which is an ObjectDisposedException
        // per tick — a stream of CAPTURE_FAILED at the old interval, from a loop nobody
        // holds a reference to any more, until the GC happens to finalize its timer.
        // Nondeterministic, unbounded, and interleaved with the new loop's events.
        var carriedSeq = loop?.LastSeq ?? 0;

        if (monitorChanged || languageChanged)
        {
            loop?.Dispose();
            loop = null;
        }

        if (monitorChanged)
        {
            (source as IDisposable)?.Dispose();
            source = host.OpenSource(configure.MonitorId);
            openMonitorId = configure.MonitorId;
        }

        if (languageChanged)
        {
            (recognizer as IDisposable)?.Dispose();
            recognizer = host.CreateRecognizer(configure.OcrLanguage);
            openLanguage = configure.OcrLanguage;
        }

        // Resuming the counter rather than restarting it: the protocol says a gap in `seq`
        // means an event was lost, so a reconfigure that reset it to 1 would be a false
        // report of exactly that.
        loop ??= new CaptureLoop(source!, recognizer!, emit, encoder: host.CreateEncoder(), initialSeq: carriedSeq);

        loop.ApplyConfiguration(
            configure.Region,
            configure.DiffThreshold,
            configure.IntervalActive,
            configure.IntervalIdle,
            configure.DebugFrameEnabled);

        if (wasRunning)
        {
            // Rebuilt the loop underneath a running capture? Then restart it, so `running`
            // keeps meaning "frames are coming".
            if (!loop.IsRunning)
            {
                loop.Start();
            }
            else
            {
                loop.ApplySchedule();
            }

            State = SidecarState.Running;
        }
        else
        {
            State = SidecarState.Configured;
        }

        emit(new AckEvent { Cmd = CommandKind.Configure, State = State });
    }

    private void Start()
    {
        if (!RequireConfigured(CommandKind.Start))
        {
            return;
        }

        loop!.Start();
        State = SidecarState.Running;
        emit(new AckEvent { Cmd = CommandKind.Start, State = State });
    }

    private void Stop()
    {
        // Deliberately not an error when nothing is running: `stop` means "be stopped",
        // and making Node track whether it already sent one buys nothing.
        loop?.Stop();
        State = loop is null ? SidecarState.Idle : SidecarState.Stopped;
        emit(new AckEvent { Cmd = CommandKind.Stop, State = State });
    }

    /// <summary>
    /// Emits an error and returns false when a command needs a configuration and there
    /// is none. Naming the command is what turns "it did nothing" into "you skipped a step".
    /// </summary>
    private bool RequireConfigured(string commandKind)
    {
        if (loop is not null)
        {
            return true;
        }

        emit(new ErrorEvent
        {
            Code = NotConfiguredCode,
            Message = $"\"{commandKind}\" needs a region: send \"configure\" first",
        });
        return false;
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        loop?.Dispose();
        (recognizer as IDisposable)?.Dispose();
        (source as IDisposable)?.Dispose();
    }
}
