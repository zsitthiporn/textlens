using Textlens.Capture.Protocol;

namespace Textlens.Capture.Tests;

/// <summary>
/// The C# half of the cross-language contract: these read the same physical files in
/// <c>tests/fixtures/protocol/</c> that <c>tests/shared/protocol.test.ts</c> reads.
///
/// Parsing them proves the two sides agree on field names. Re-encoding them and
/// comparing byte for byte proves rather more: that camelCase, key order and number
/// formatting all match too — which is the part a pair of "symmetric-looking" type
/// declarations would never have caught.
/// </summary>
public class ProtocolGoldenFixtureTests
{
    [Theory]
    [InlineData("event-ready.json")]
    [InlineData("event-frame.json")]
    [InlineData("event-frame-debug.json")]
    [InlineData("event-nochange.json")]
    [InlineData("event-error.json")]
    public void EveryGoldenEvent_ParsesAndReEncodesByteForByte(string fileName)
    {
        var golden = ProtocolFixtures.Read(fileName);

        var decoded = ProtocolCodec.DecodeEvent(golden);

        Assert.True(decoded.Ok, $"{fileName} -> {decoded.Failure}: {decoded.Detail}");
        Assert.NotNull(decoded.Value);
        Assert.Equal(golden, ProtocolCodec.Encode(decoded.Value));
    }

    [Theory]
    [InlineData("command-list-monitors.json")]
    [InlineData("command-configure.json")]
    [InlineData("command-start.json")]
    [InlineData("command-stop.json")]
    [InlineData("command-snapshot.json")]
    [InlineData("command-debug-frame.json")]
    public void EveryGoldenCommand_ParsesAndReEncodesByteForByte(string fileName)
    {
        var golden = ProtocolFixtures.Read(fileName);

        var decoded = ProtocolCodec.DecodeCommand(golden);

        Assert.True(decoded.Ok, $"{fileName} -> {decoded.Failure}: {decoded.Detail}");
        Assert.NotNull(decoded.Value);
        Assert.Equal(golden, ProtocolCodec.Encode(decoded.Value));
    }

    [Fact]
    public void GoldenFrame_DecodesToTheValuesTheDesignDocShows()
    {
        var decoded = ProtocolCodec.DecodeEvent(ProtocolFixtures.Read("event-frame.json"));

        Assert.NotNull(decoded.Value);
        var frame = Assert.IsType<FrameEvent>(decoded.Value);
        Assert.Equal(42, frame.Seq);
        Assert.Equal(new FrameTimings { Capture = 12, Diff = 3, Ocr = 58 }, frame.Timings);
        Assert.Equal(@"\\.\DISPLAY1", frame.Monitor.Id);
        Assert.Equal(1.5, frame.Monitor.Scale);
        Assert.Equal(new Rect(0, 0, 3840, 2160), frame.Monitor.Bounds);
        Assert.Equal(new Rect(400, 1800, 1200, 150), frame.Region);
        var line = Assert.Single(frame.Lines);
        Assert.Equal("You must find the key", line.Text);
        Assert.Equal(new Rect(120, 80, 540, 32), line.Bbox);
        Assert.Equal(0.93, line.Conf);
    }

    [Fact]
    public void GoldenConfigure_DecodesToTheValuesOnTheWire()
    {
        var decoded = ProtocolCodec.DecodeCommand(ProtocolFixtures.Read("command-configure.json"));

        Assert.NotNull(decoded.Value);
        var configure = Assert.IsType<ConfigureCommand>(decoded.Value);
        Assert.Equal(new Rect(400, 1800, 1200, 150), configure.Region);
        Assert.Equal(@"\\.\DISPLAY1", configure.MonitorId);
        Assert.Equal(800, configure.IntervalActive);
        Assert.Equal(2000, configure.IntervalIdle);
        Assert.Equal(0.02, configure.DiffThreshold);
        Assert.Equal("en-US", configure.OcrLanguage);
    }

    /// <summary>
    /// The acceptance criterion is that <c>scale</c> and <c>monitor.bounds</c> are
    /// mandatory in the type system rather than merely documented. On this side
    /// <c>required</c> supplies both halves: the compiler refuses an object
    /// initializer that omits them, and the serializer refuses JSON that omits them.
    /// This test covers the second half; the first is enforced at build time.
    /// </summary>
    [Theory]
    [InlineData("invalid-frame-missing-scale.json")]
    [InlineData("invalid-frame-missing-bounds.json")]
    public void FrameWithoutTheCoordinateContract_FailsToParse_RatherThanDefaulting(string fileName)
    {
        var decoded = ProtocolCodec.DecodeEvent(ProtocolFixtures.Read(fileName));

        Assert.False(decoded.Ok);
        Assert.Equal(DecodeFailure.InvalidShape, decoded.Failure);
        Assert.Null(decoded.Value);
        // The message names the missing field, so the log says which half of the
        // coordinate contract the other side dropped.
        var missingField = fileName.Contains("scale", StringComparison.Ordinal) ? "scale" : "bounds";
        Assert.Contains(missingField, decoded.Detail, StringComparison.Ordinal);
    }
}
