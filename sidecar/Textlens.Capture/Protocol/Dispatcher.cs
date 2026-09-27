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
    ///
    /// <para><b>All or nothing.</b> <c>CONFIGURE_FAILED</c> means nothing changed: the
    /// pipeline that was running keeps running, on its old settings. Everything that can
    /// fail — the values, the new capture session, the new recognizer — is done before
    /// anything is torn down. The old order disposed first and opened second, so an
    /// uninstalled <c>ocrLanguage</c> or an unknown <c>monitorId</c> left a disposed
    /// recognizer or source wired in; reverting the setting then acked <c>running</c> over
    /// a pipeline that failed every tick until the sidecar restarted.</para>
    /// </summary>
    private void Configure(ConfigureCommand configure)
    {
        var wasRunning = State == SidecarState.Running;

        // Phase 1 — everything that can fail. Nothing the running loop uses is touched here.
        CaptureLoop.ValidateConfiguration(configure.DiffThreshold, configure.IntervalActive, configure.IntervalIdle);

        var monitorChanged = !string.Equals(openMonitorId, configure.MonitorId, StringComparison.OrdinalIgnoreCase);
        var languageChanged = !string.Equals(openLanguage, configure.OcrLanguage, StringComparison.OrdinalIgnoreCase);

        IRegionSource? newSource = null;
        IRecognizer? newRecognizer = null;
        IFrameEncoder? newEncoder = null;
        try
        {
            if (monitorChanged)
            {
                newSource = host.OpenSource(configure.MonitorId);
            }

            if (languageChanged)
            {
                newRecognizer = host.CreateRecognizer(configure.OcrLanguage);
            }

            if (monitorChanged || languageChanged)
            {
                newEncoder = host.CreateEncoder();
            }
        }
        catch
        {
            // Whatever did open is ours to close; nothing else was touched.
            (newRecognizer as IDisposable)?.Dispose();
            (newSource as IDisposable)?.Dispose();
            throw;
        }

        // Phase 2 — commit. Nothing below is expected to throw.
        if (monitorChanged || languageChanged)
        {
            // The loop goes FIRST, and only then the things it is holding — and "goes"
            // means drained, not merely told to stop. Dispose returns once the tick in
            // flight, if any, has finished and no later one can start, so the source and
            // recognizer below are disposed with nobody inside them, and nothing the old
            // loop emits can land after this configure's ack.
            var retiring = loop;
            retiring?.Dispose();

            // Read after the drain, never before: read first, the in-flight tick took the
            // next number after we had copied it, and the new loop handed out the same one
            // again. The protocol says a gap in `seq` means an event was lost, which is why
            // the counter carries over at all rather than restarting at 1.
            var carriedSeq = retiring?.LastSeq ?? 0;

            if (monitorChanged)
            {
                (source as IDisposable)?.Dispose();
                source = newSource;
                openMonitorId = configure.MonitorId;
            }

            if (languageChanged)
            {
                (recognizer as IDisposable)?.Dispose();
                recognizer = newRecognizer;
                openLanguage = configure.OcrLanguage;
            }

            loop = new CaptureLoop(source!, recognizer!, emit, encoder: newEncoder, initialSeq: carriedSeq);
        }

        loop!.ApplyConfiguration(
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
        //
        // Stop is a barrier (it waits out the tick in flight), so the ack below is the last
        // thing on stdout until the next start. #60's "stop, then snapshot" relies on that:
        // a tick landing after the snapshot would overwrite the frame the user asked to hold.
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

        // Drains the tick in flight before returning (CaptureLoop.Stop), which matters twice
        // at shutdown: the source and recognizer below are released with nobody inside them,
        // and Program disposes stdout only after this — so no tick can write to a closed
        // stream and turn a clean exit 0 into a crash.
        loop?.Dispose();
        (recognizer as IDisposable)?.Dispose();
        (source as IDisposable)?.Dispose();
    }
}
