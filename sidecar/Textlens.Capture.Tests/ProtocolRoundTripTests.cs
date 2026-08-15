using Textlens.Capture.Protocol;

namespace Textlens.Capture.Tests;

/// <summary>
/// encode → decode → the same value back, for every message in the protocol.
///
/// Every sample below is deliberately built from non-default values — non-zero
/// timings, a fractional scale, a negative monitor origin, a confidence that is not
/// 1.0. A round trip of all-zero records proves only that zeroes survive.
/// </summary>
public class ProtocolRoundTripTests
{
    private static FrameEvent SampleFrame() => new()
    {
        Seq = 42,
        Timings = new FrameTimings { CaptureUs = 574, DiffUs = 159, OcrUs = 24680 },
        Monitor = new MonitorInfo
        {
            Id = @"\\.\DISPLAY1",
            Scale = 1.5,
            Bounds = new Rect(0, 0, 3840, 2160),
        },
        Region = new Rect(400, 1800, 1200, 150),
        Lines =
        [
            // One line each way across the optional `conf`: present, and absent — which is
            // what the current recognizer actually produces.
            new OcrLine { Text = "You must find the key", Bbox = new Rect(120, 80, 540, 32), Conf = 0.93 },
            new OcrLine { Text = "before the gate closes", Bbox = new Rect(118, 124, 561, 33) },
        ],
    };

    private static T RoundTrip<T>(T original)
        where T : class, ISidecarEvent
    {
        var line = ProtocolCodec.Encode(original);
        var decoded = ProtocolCodec.DecodeEvent(line);

        Assert.True(decoded.Ok, $"{line} -> {decoded.Failure}: {decoded.Detail}");
        Assert.NotNull(decoded.Value);
        return Assert.IsType<T>(decoded.Value);
    }

    private static T RoundTripCommand<T>(T original)
        where T : class, ISidecarCommand
    {
        var line = ProtocolCodec.Encode(original);
        var decoded = ProtocolCodec.DecodeCommand(line);

        Assert.True(decoded.Ok, $"{line} -> {decoded.Failure}: {decoded.Detail}");
        Assert.NotNull(decoded.Value);
        return Assert.IsType<T>(decoded.Value);
    }

    [Fact]
    public void ReadyEvent_SurvivesTheRoundTrip()
    {
        var original = new ReadyEvent { Version = "0.4.2", OcrLanguages = ["en-US", "th-TH"] };

        var result = RoundTrip(original);

        Assert.Equal("ready", result.Ev);
        Assert.Equal(original.Version, result.Version);
        // Arrays compare by reference under record equality, so compare the contents.
        Assert.Equal(original.OcrLanguages, result.OcrLanguages);
    }

    [Fact]
    public void ReadyEvent_WithNoRecognizersInstalled_RoundTripsAsAnEmptyList()
    {
        // The honest answer on a machine with no language pack — and the input feature
        // O8's preflight has to act on. It must not decode as null.
        var result = RoundTrip(new ReadyEvent { Version = "0.4.2", OcrLanguages = [] });

        Assert.Empty(result.OcrLanguages);
    }

    [Fact]
    public void FrameEvent_SurvivesTheRoundTrip_FieldForField()
    {
        var original = SampleFrame();

        var result = RoundTrip(original);

        Assert.Equal("frame", result.Ev);
        Assert.Equal(original.Seq, result.Seq);
        Assert.Equal(original.Timings, result.Timings);
        Assert.Equal(original.Monitor, result.Monitor);
        Assert.Equal(original.Region, result.Region);
        Assert.Equal(original.Lines, result.Lines);
        Assert.Null(result.ImagePng);

        // Strongest single statement of "the same value came back": the two encode
        // to the identical byte sequence.
        Assert.Equal(ProtocolCodec.Encode(original), ProtocolCodec.Encode(result));
    }

    [Fact]
    public void FrameEvent_KeepsTheCoordinateContractIntact()
    {
        // A secondary monitor left of primary at 125% — the exact case the design doc
        // says the reference project got wrong. If scale or bounds were lost in
        // transit the overlay would land on the wrong screen, not merely a few px off.
        var original = SampleFrame() with
        {
            Monitor = new MonitorInfo { Id = @"\\.\DISPLAY2", Scale = 1.25, Bounds = new Rect(-1920, 0, 1920, 1080) },
        };

        var result = RoundTrip(original);

        Assert.Equal(1.25, result.Monitor.Scale);
        Assert.Equal(new Rect(-1920, 0, 1920, 1080), result.Monitor.Bounds);
    }

    [Fact]
    public void FrameEvent_CarriesImagePngOnlyWhenSet()
    {
        var withImage = SampleFrame() with { ImagePng = "iVBORw0KGgoAAAANSUhEUg" };

        var result = RoundTrip(withImage);

        Assert.Equal("iVBORw0KGgoAAAANSUhEUg", result.ImagePng);
        // Absent, not null: pixels crossing IPC is the documented exception, so the
        // field should not even appear on an ordinary frame.
        Assert.DoesNotContain("imagePng", ProtocolCodec.Encode(SampleFrame()), StringComparison.Ordinal);
    }

    [Fact]
    public void NoChangeEvent_SurvivesTheRoundTrip()
    {
        var original = new NoChangeEvent { Seq = 4_294_967_400 };

        // No arrays on this record, so full value equality is available.
        Assert.Equal(original, RoundTrip(original));
    }

    [Fact]
    public void ErrorEvent_SurvivesTheRoundTrip()
    {
        var original = new ErrorEvent
        {
            Code = "CAPTURE_FAILED",
            Message = @"Direct3D device lost while capturing \\.\DISPLAY1",
        };

        Assert.Equal(original, RoundTrip(original));
    }

    [Fact]
    public void ConfigureCommand_SurvivesTheRoundTrip()
    {
        var original = new ConfigureCommand
        {
            Region = new Rect(400, 1800, 1200, 150),
            MonitorId = @"\\.\DISPLAY1",
            IntervalActive = 800,
            IntervalIdle = 2000,
            DiffThreshold = 0.02,
            OcrLanguage = "en-US",
            DebugFrameEnabled = true,
        };

        Assert.Equal(original, RoundTripCommand(original));
    }

    [Fact]
    public void AckEvent_SurvivesTheRoundTrip_WithAndWithoutMonitors()
    {
        var plain = new AckEvent { Cmd = CommandKind.Stop, State = SidecarState.Stopped };

        Assert.Equal(plain, RoundTrip(plain));
        // Absent, not null — the same treatment `imagePng` gets, so an ack to a command
        // that has nothing to list stays three fields wide.
        Assert.DoesNotContain("monitors", ProtocolCodec.Encode(plain), StringComparison.Ordinal);

        var listing = new AckEvent
        {
            Cmd = CommandKind.ListMonitors,
            State = SidecarState.Configured,
            Monitors =
            [
                new MonitorInfo { Id = @"\\.\DISPLAY1", Scale = 1.5, Bounds = new Rect(0, 0, 3840, 2160) },
                new MonitorInfo { Id = @"\\.\DISPLAY2", Scale = 1.25, Bounds = new Rect(-1920, 0, 1920, 1080) },
            ],
        };

        var result = RoundTrip(listing);

        // Arrays compare by reference under record equality, so compare the encoded form.
        Assert.Equal(ProtocolCodec.Encode(listing), ProtocolCodec.Encode(result));
        Assert.NotNull(result.Monitors);
        Assert.Equal(new Rect(-1920, 0, 1920, 1080), result.Monitors[1].Bounds);
    }

    [Fact]
    public void OcrLine_WithoutConfidence_OmitsTheFieldRatherThanWritingNull()
    {
        // What this sidecar actually emits: Windows.Media.Ocr reports no confidence, and a
        // `"conf":null` on the wire would be a third state for every consumer to handle.
        var frame = SampleFrame() with
        {
            Lines = [new OcrLine { Text = "You must find the key", Bbox = new Rect(120, 80, 540, 32) }],
        };

        var encoded = ProtocolCodec.Encode(frame);

        Assert.DoesNotContain("conf", encoded, StringComparison.Ordinal);
        Assert.Null(Assert.Single(RoundTrip(frame).Lines).Conf);
    }

    [Theory]
    [InlineData("listMonitors")]
    [InlineData("start")]
    [InlineData("stop")]
    [InlineData("snapshot")]
    [InlineData("debugFrame")]
    public void PayloadFreeCommands_SurviveTheRoundTrip(string kind)
    {
        ISidecarCommand original = kind switch
        {
            CommandKind.ListMonitors => new ListMonitorsCommand(),
            CommandKind.Start => new StartCommand(),
            CommandKind.Stop => new StopCommand(),
            CommandKind.Snapshot => new SnapshotCommand(),
            CommandKind.DebugFrame => new DebugFrameCommand(),
            _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "unhandled command kind"),
        };

        var line = ProtocolCodec.Encode(original);
        var decoded = ProtocolCodec.DecodeCommand(line);

        Assert.Equal($"{{\"cmd\":\"{kind}\"}}", line);
        Assert.True(decoded.Ok, decoded.Detail);
        Assert.NotNull(decoded.Value);
        Assert.Equal(original.GetType(), decoded.Value.GetType());
        Assert.Equal(kind, decoded.Value.Cmd);
    }
}
