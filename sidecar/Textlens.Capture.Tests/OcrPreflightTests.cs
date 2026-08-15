using Textlens.Capture.Protocol;
using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Feature O8. Every case here is a machine configuration this dev box does not have:
/// the rig carries exactly one recognizer (en-US), so the branch that actually matters
/// to users — no English pack at all — is only ever exercised here.
/// </summary>
public class OcrPreflightTests
{
    [Fact]
    public void NoLanguagesAtAll_ReportsMissing()
    {
        var error = OcrPreflight.Check([], "en-US");

        Assert.NotNull(error);
        Assert.Equal(OcrPreflight.LanguageMissingCode, error.Code);
    }

    [Fact]
    public void OnlyUnrelatedLanguages_ReportsMissing()
    {
        var error = OcrPreflight.Check(["ja-JP", "zh-Hans-CN"], "en-US");

        Assert.NotNull(error);
        Assert.Equal(OcrPreflight.LanguageMissingCode, error.Code);
    }

    [Fact]
    public void ExactMatch_IsSatisfied()
    {
        Assert.Null(OcrPreflight.Check(["ja-JP", "en-US"], "en-US"));
    }

    [Fact]
    public void MatchIsCaseInsensitive()
    {
        // Windows reports "en-US"; a config file or a hand-typed command may not.
        // Rejecting on casing would be a maddening false alarm.
        Assert.Null(OcrPreflight.Check(["EN-us"], "en-US"));
    }

    [Fact]
    public void RegionalVariantSatisfiesTheRequest()
    {
        // en-GB is an English recognizer. Telling a user who has one to go install one
        // is a dead end; see the reasoning on OcrPreflight.IsSatisfied.
        Assert.Null(OcrPreflight.Check(["en-GB"], "en-US"));
    }

    [Fact]
    public void NeutralTagSatisfiesARegionalRequest()
    {
        Assert.Null(OcrPreflight.Check(["en"], "en-US"));
    }

    [Fact]
    public void BlankRequiredTag_ReportsMissing()
    {
        // A blank tag is a misconfiguration upstream. It must not silently match the
        // first installed recognizer via an empty primary subtag.
        var error = OcrPreflight.Check(["en-US"], "   ");

        Assert.NotNull(error);
        Assert.Equal(OcrPreflight.LanguageMissingCode, error.Code);
    }

    [Fact]
    public void Message_CarriesTheInstallPathAndTheRequestedTag()
    {
        var error = OcrPreflight.Check([], "en-US");

        Assert.NotNull(error);
        Assert.Contains("en-US", error.Message, StringComparison.Ordinal);
        Assert.Contains("Settings", error.Message, StringComparison.Ordinal);
        Assert.Contains("Optical character recognition", error.Message, StringComparison.Ordinal);
        Assert.All(error.Message, c => Assert.InRange(c, ' ', '~'));
    }

    [Fact]
    public void Message_SurvivesJsonEncodingWithoutEscapeSoup()
    {
        // The protocol serializer uses the HTML-safe encoder, which mangles > & " into
        // > & ". That is valid JSON and Node parses it fine, but the
        // design doc's stated reason for choosing stdio is that a human can run the
        // sidecar standalone and read stdout. An install path rendered as escape codes
        // defeats exactly that.
        var error = OcrPreflight.Check([], "en-US");
        Assert.NotNull(error);

        var line = ProtocolCodec.Encode(error);

        Assert.DoesNotContain("\\u", line, StringComparison.Ordinal);
    }

    [Fact]
    public void Message_NamesWhatIsActuallyInstalled()
    {
        // Support starts from facts. "none" is the distinct, meaningful empty case.
        var withSome = OcrPreflight.Check(["ja-JP"], "en-US");
        var withNone = OcrPreflight.Check([], "en-US");

        Assert.NotNull(withSome);
        Assert.NotNull(withNone);
        Assert.Contains("ja-JP", withSome.Message, StringComparison.Ordinal);
        Assert.Contains("none", withNone.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheErrorIsAnOrdinaryProtocolEvent()
    {
        // It has to survive the codec unchanged — an O8 failure that Node cannot parse
        // is the silent failure this whole feature exists to prevent.
        var error = OcrPreflight.Check([], "en-US");
        Assert.NotNull(error);

        var decoded = ProtocolCodec.DecodeEvent(ProtocolCodec.Encode(error));

        Assert.True(decoded.Ok, decoded.Detail);
        var roundTripped = Assert.IsType<ErrorEvent>(decoded.Value);
        Assert.Equal(error, roundTripped);
    }

    [Fact]
    public void ThisMachineHasARecognizerForTheDefaultSourceLanguage()
    {
        // Not a duplicate of the pure cases above: this asserts the real WinRT query
        // feeds the real check. If a dev box loses its en-US pack, this is the test
        // that says so rather than every capture test failing obscurely later.
        var installed = Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages
            .Select(language => language.LanguageTag)
            .ToArray();

        Assert.Null(OcrPreflight.Check(installed, OcrPreflight.DefaultSourceLanguage));
    }
}
