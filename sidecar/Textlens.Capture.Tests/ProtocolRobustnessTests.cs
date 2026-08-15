using Textlens.Capture.Protocol;

namespace Textlens.Capture.Tests;

/// <summary>
/// The read loop must survive anything the other side puts on the wire. A sidecar
/// that dies on a message it does not recognise cannot be upgraded independently of
/// Node, and a sidecar that dies on a truncated line cannot be debugged by hand —
/// which the design doc names as the reason stdio was chosen in the first place.
/// </summary>
public class ProtocolRobustnessTests
{
    [Fact]
    public void UnknownEvent_IsReportedAndSkipped_NotThrown()
    {
        var golden = ProtocolFixtures.Read("unknown-event.json");

        var decoded = ProtocolCodec.DecodeEvent(golden);

        Assert.False(decoded.Ok);
        Assert.Equal(DecodeFailure.UnknownKind, decoded.Failure);
        Assert.Null(decoded.Value);
        // The detail is what the caller logs; naming the kind is the difference
        // between a useful log line and "something went wrong".
        Assert.Contains("heartbeat", decoded.Detail, StringComparison.Ordinal);
    }

    [Fact]
    public void UnknownCommand_IsReportedAndSkipped_NotThrown()
    {
        var golden = ProtocolFixtures.Read("unknown-command.json");

        var decoded = ProtocolCodec.DecodeCommand(golden);

        Assert.False(decoded.Ok);
        Assert.Equal(DecodeFailure.UnknownKind, decoded.Failure);
        Assert.Null(decoded.Value);
        Assert.Contains("recalibrate", decoded.Detail, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("", DecodeFailure.MalformedJson)]
    [InlineData("   ", DecodeFailure.MalformedJson)]
    [InlineData("{\"ev\":\"nochange\",\"seq\":", DecodeFailure.MalformedJson)]
    [InlineData("not json at all", DecodeFailure.MalformedJson)]
    [InlineData("{}{}", DecodeFailure.MalformedJson)]
    [InlineData("[1,2,3]", DecodeFailure.NotAnObject)]
    [InlineData("\"ready\"", DecodeFailure.NotAnObject)]
    [InlineData("null", DecodeFailure.NotAnObject)]
    [InlineData("{\"seq\":1}", DecodeFailure.MissingDiscriminator)]
    [InlineData("{\"ev\":7}", DecodeFailure.MissingDiscriminator)]
    [InlineData("{\"ev\":\"nochange\"}", DecodeFailure.InvalidShape)]
    [InlineData("{\"ev\":\"ready\",\"version\":\"1.0.0\",\"ocrLanguages\":\"en-US\"}", DecodeFailure.InvalidShape)]
    [InlineData("{\"ev\":\"frame\",\"seq\":1,\"timings\":{\"capture\":1,\"diff\":1,\"ocr\":1},"
        + "\"monitor\":{\"id\":\"a\",\"scale\":1,\"bounds\":[0,0,10]},\"region\":[0,0,1,1],\"lines\":[]}",
        DecodeFailure.InvalidShape)]
    public void GarbageOnTheWire_BecomesAValue_NeverAnException(string line, DecodeFailure expected)
    {
        var decoded = ProtocolCodec.DecodeEvent(line);

        Assert.False(decoded.Ok);
        Assert.Equal(expected, decoded.Failure);
        Assert.NotEmpty(decoded.Detail);
    }

    /// <summary>
    /// The acceptance criterion in full: a stream containing an unknown event, a
    /// malformed line and a structurally invalid frame still yields every good
    /// message, in order, and one loggable reason per bad line.
    /// </summary>
    [Fact]
    public void MixedStream_YieldsEveryGoodMessage_AndOneReasonPerBadLine()
    {
        var kept = new List<ISidecarEvent>();
        var skipped = new List<DecodeFailure>();

        foreach (var line in ProtocolFixtures.ReadLines("stream-mixed.jsonl"))
        {
            var decoded = ProtocolCodec.DecodeEvent(line);
            if (decoded.Ok)
            {
                kept.Add(decoded.Value);
            }
            else
            {
                Assert.NotEmpty(decoded.Detail);
                skipped.Add(decoded.Failure);
            }
        }

        Assert.Collection(
            kept,
            first => Assert.Equal(["en-US"], Assert.IsType<ReadyEvent>(first).OcrLanguages),
            last => Assert.Equal(46L, Assert.IsType<NoChangeEvent>(last).Seq));

        Assert.Equal(
            new[] { DecodeFailure.UnknownKind, DecodeFailure.InvalidShape, DecodeFailure.MalformedJson },
            skipped);
    }
}
