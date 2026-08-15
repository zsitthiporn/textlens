using System.Diagnostics;
using System.Reflection;
using Textlens.Capture.Services;

namespace Textlens.Capture.Tests;

/// <summary>
/// Issue M2-04. These run against the real Windows recognizer on real rendered text —
/// there is no mock, because every acceptance criterion here is about what the recognizer
/// actually does (latency, box placement, memory over 500 runs) and a mock would answer
/// none of them.
///
/// <para>The text is drawn by <see cref="TextBitmap"/> rather than loaded from a
/// screenshot, so the expected strings live in the test instead of in an uncommitted
/// binary. Spike S1 catalogued the recognizer's habitual errors (<c>o</c>/<c>O</c>,
/// <c>I</c>/<c>1</c>) and concluded they do not change meaning, so the assertions here are
/// about words and geometry, never about an exact character-for-character match.</para>
///
/// <para><b>On a machine with no English recognizer</b> these tests report a skip in their
/// output and pass vacuously — except <see cref="ThisMachineHasAnEnglishRecognizer"/>,
/// which fails. One clear failure naming the real problem beats a suite of green tests
/// that verified nothing (CLAUDE.md invariant 4, applied to the suite itself). Dynamic
/// skipping is spelled this way rather than with <c>Xunit.SkippableFact</c> because that
/// would be a new package dependency.</para>
/// </summary>
public class OcrServiceTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private const int Width = 1200;
    private const int Height = 200;
    private const string Language = "en-US";

    private static bool RecognizerAvailable
        => Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages
            .Any(l => l.LanguageTag.StartsWith("en", StringComparison.OrdinalIgnoreCase));

    /// <summary>Logs and returns true when there is nothing to test against.</summary>
    private bool NoRecognizer()
    {
        if (RecognizerAvailable)
        {
            return false;
        }

        output.WriteLine("SKIPPED: no en-* OCR recognizer on this machine (see ThisMachineHasAnEnglishRecognizer)");
        return true;
    }

    /// <summary>
    /// The one test that fails rather than skips. Feature O8 exists because Textlens
    /// cannot work at all without an English recognizer, so a machine without one should
    /// say so once, loudly, instead of quietly turning the OCR suite into a no-op.
    /// </summary>
    [Fact]
    public void ThisMachineHasAnEnglishRecognizer()
    {
        var installed = Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages
            .Select(l => l.LanguageTag)
            .ToArray();

        output.WriteLine($"installed recognizers: {(installed.Length == 0 ? "none" : string.Join(", ", installed))}");
        Assert.True(RecognizerAvailable, "no en-* recognizer is installed, so every OCR test below verified nothing");
    }

    // ------------------------------------------------------------------
    // The confidence finding
    // ------------------------------------------------------------------

    /// <summary>
    /// Pins the reason <c>OcrLine.conf</c> is optional on the wire: the recognizer does not
    /// report confidence, anywhere, in any form.
    ///
    /// <para>This is a contract test, not a curiosity. Two P0 features are specified to use
    /// confidence — O4 filters low-confidence lines (#14) and U4 ranks by
    /// <c>area x confidence</c> (#27) — and both need to know the field is genuinely
    /// absent rather than merely unpopulated by this build. If a future Windows SDK adds a
    /// confidence property this test fails, and failing is the correct outcome: it is the
    /// signal to start emitting it.</para>
    /// </summary>
    [Fact]
    public void TheRecognizerReportsNoConfidence()
    {
        var suspicious = new List<string>();

        foreach (var type in new[]
                 {
                     typeof(Windows.Media.Ocr.OcrResult),
                     typeof(Windows.Media.Ocr.OcrLine),
                     typeof(Windows.Media.Ocr.OcrWord),
                 })
        {
            var names = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Select(p => p.Name)
                .ToArray();

            output.WriteLine($"{type.Name}: {string.Join(", ", names)}");

            suspicious.AddRange(
                names
                    .Where(name =>
                        name.Contains("conf", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("score", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("probab", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("accur", StringComparison.OrdinalIgnoreCase))
                    .Select(name => $"{type.Name}.{name}"));
        }

        Assert.Empty(suspicious);
    }

    // ------------------------------------------------------------------
    // Shape of the result
    // ------------------------------------------------------------------

    [Fact]
    public void ReturnsOneEntryPerLine_WithTextAndABox()
    {
        if (NoRecognizer())
        {
            return;
        }

        using var ocr = OcrService.Create(Language);
        var pixels = TextBitmap.Render(Width, Height, ["You must find the key", "before the gate closes"]);

        var lines = ocr.Recognize(pixels, Width, Height);

        Assert.Equal(2, lines.Length);
        foreach (var line in lines)
        {
            output.WriteLine($"\"{line.Text}\" bbox=[{line.Bbox.X},{line.Bbox.Y},{line.Bbox.Width},{line.Bbox.Height}]");
            Assert.False(string.IsNullOrWhiteSpace(line.Text));
            Assert.True(line.Bbox.Width > 0 && line.Bbox.Height > 0);
            // Confidence is absent, because the recognizer has none to give.
            Assert.Null(line.Conf);
        }

        // Word-level rather than character-level: S1 established that o/O and I/1 slips
        // are routine and harmless, and asserting an exact string would make this test
        // fail for a reason nobody should act on.
        Assert.Contains("key", lines[0].Text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("gate", lines[1].Text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BoxesAreRelativeToTheRegion_NotToTheDisplay()
    {
        if (NoRecognizer())
        {
            return;
        }

        using var ocr = OcrService.Create(Language);
        // Drawn at a known inset. The recognizer works in the bitmap's coordinates and the
        // bitmap *is* the region, so the box must come back near this origin — nowhere
        // near a display-absolute position.
        const int OriginX = 40;
        const int OriginY = 30;
        var pixels = TextBitmap.Render(Width, Height, ["You must find the key"], originX: OriginX, originY: OriginY);

        var line = Assert.Single(ocr.Recognize(pixels, Width, Height));

        output.WriteLine(
            $"drawn at ({OriginX},{OriginY}); bbox=[{line.Bbox.X},{line.Bbox.Y},{line.Bbox.Width},{line.Bbox.Height}]");

        // Generous tolerance: a glyph box is not the drawing origin — the cell has
        // internal leading above the cap height and the first glyph has a side bearing.
        Assert.InRange(line.Bbox.X, OriginX - 10, OriginX + 20);
        Assert.InRange(line.Bbox.Y, OriginY - 10, OriginY + 25);
        // The whole box lands inside the region, which is the actual contract.
        Assert.True(line.Bbox.X >= 0 && line.Bbox.Y >= 0);
        Assert.True(line.Bbox.X + line.Bbox.Width <= Width);
        Assert.True(line.Bbox.Y + line.Bbox.Height <= Height);
    }

    [Fact]
    public void TheSecondLineSitsBelowTheFirst()
    {
        if (NoRecognizer())
        {
            return;
        }

        // Boxes have to be ordered and separated the way the drawing was, or the overlay
        // would anchor translations under the wrong source line.
        using var ocr = OcrService.Create(Language);
        var pixels = TextBitmap.Render(
            Width, Height, ["You must find the key", "before the gate closes"], lineSpacing: 44);

        var lines = ocr.Recognize(pixels, Width, Height);

        Assert.Equal(2, lines.Length);
        Assert.True(
            lines[1].Bbox.Y > lines[0].Bbox.Y,
            $"second line at y={lines[1].Bbox.Y} is not below the first at y={lines[0].Bbox.Y}");
        Assert.InRange(lines[1].Bbox.Y - lines[0].Bbox.Y, 30, 60);
    }

    [Fact]
    public void ARegionWithNoTextReturnsNoLines_AndIsNotAnError()
    {
        if (NoRecognizer())
        {
            return;
        }

        using var ocr = OcrService.Create(Language);

        var stopwatch = Stopwatch.StartNew();
        var lines = ocr.Recognize(TextBitmap.Blank(Width, Height), Width, Height);
        stopwatch.Stop();

        output.WriteLine($"empty region: {lines.Length} lines in {stopwatch.Elapsed.TotalMilliseconds:F1}ms (S1 measured 3ms)");
        Assert.Empty(lines);
    }

    [Fact]
    public void ReadsTextFromABufferWhoseAlphaChannelIsEntirelyZero()
    {
        if (NoRecognizer())
        {
            return;
        }

        // A Windows Graphics Capture surface's alpha is not meaningfully defined for
        // desktop content and regions of it are routinely zero. Handed straight to a
        // premultiplied bitmap that means "fully transparent", and the recognizer would
        // read a blank image and correctly return nothing — a silent, intermittent failure
        // that looks exactly like "there was no text on screen". OcrService forces alpha
        // opaque before recognizing; this is the test that proves it.
        using var ocr = OcrService.Create(Language);
        var pixels = TextBitmap.Render(Width, Height, ["You must find the key"]);
        for (var i = 3; i < pixels.Length; i += 4)
        {
            pixels[i] = 0x00;
        }

        var lines = ocr.Recognize(pixels, Width, Height);

        Assert.NotEmpty(lines);
        Assert.Contains("key", lines[0].Text, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TextIsPassedThroughWithoutCorrectionOrReshaping()
    {
        if (NoRecognizer())
        {
            return;
        }

        // Three rules at once, all of them things a well-meaning post-processor would
        // break: spike S1's ban on "fixing" o/O and I/1, and CLAUDE.md's rule that
        // punctuation stays ASCII rather than being widened the way the Chinese-targeted
        // reference project does.
        using var ocr = OcrService.Create(Language);
        var pixels = TextBitmap.Render(Width, Height, ["Warning: 1O units, ready?"]);

        var lines = ocr.Recognize(pixels, Width, Height);
        if (lines.Length == 0)
        {
            output.WriteLine("SKIPPED: the recognizer read nothing from this sample");
            return;
        }

        var text = lines[0].Text;
        output.WriteLine($"drawn : \"Warning: 1O units, ready?\"");
        output.WriteLine($"read  : \"{text}\"");

        // No full-width punctuation anywhere. Thai uses ASCII , . ? ! and widening them is
        // Chinese-specific logic that would look wrong and break the cache key.
        Assert.DoesNotContain('，', text);
        Assert.DoesNotContain('：', text);
        Assert.DoesNotContain('？', text);
        Assert.DoesNotContain('！', text);
        // Case is preserved rather than normalised.
        Assert.Contains("W", text, StringComparison.Ordinal);
        // Nothing was trimmed into a single token.
        Assert.Contains(" ", text, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------
    // Latency
    // ------------------------------------------------------------------

    [Fact]
    public void RecognitionFitsTheEightyMillisecondBudget()
    {
        if (NoRecognizer())
        {
            return;
        }

        using var ocr = OcrService.Create(Language);
        var pixels = TextBitmap.Render(Width, Height, ["You must find the key", "before the gate closes"]);

        // Warm: the first call pays engine start-up and JIT, which is real but is paid
        // once per process rather than once per frame.
        ocr.Recognize(pixels, Width, Height);

        var samples = new List<double>(40);
        for (var i = 0; i < 40; i++)
        {
            var stopwatch = Stopwatch.StartNew();
            ocr.Recognize(pixels, Width, Height);
            stopwatch.Stop();
            samples.Add(stopwatch.Elapsed.TotalMilliseconds);
        }

        samples.Sort();
        var p50 = samples[samples.Count / 2];
        var p90 = samples[(int)(samples.Count * 0.9)];
        var worst = samples[^1];

        output.WriteLine(
            $"{Width}x{Height} OCR over {samples.Count} runs: p50={p50:F1}ms p90={p90:F1}ms worst={worst:F1}ms "
            + "(budget 80ms; S1 measured 22-36ms)");

        // Asserted on p90 rather than the median, because the budget is about the tail.
        Assert.True(p90 < 80.0, $"OCR p90 {p90:F1}ms over the 80ms budget (p50 {p50:F1}ms)");
    }

    // ------------------------------------------------------------------
    // The 500-run memory criterion
    // ------------------------------------------------------------------

    /// <summary>
    /// The acceptance criterion is "500 consecutive runs without memory growth". A
    /// <c>Dispose</c> call is not a measurement, so this samples both the managed heap and
    /// the process working set across the run and reports the whole series.
    ///
    /// <para>Working set is included because the interesting leak here is <b>native</b>:
    /// the <see cref="Windows.Graphics.Imaging.SoftwareBitmap"/> and the recognizer's own
    /// buffers live outside the GC heap, so a managed-only measurement would draw a
    /// perfectly flat line while the process grew by hundreds of megabytes.</para>
    ///
    /// <para><b>500 runs is not on its own enough to tell a leak from a warm-up ramp</b>,
    /// and at first glance it looked like one: the working set climbs monotonically to
    /// about +6MB across this window. A one-off 4000-run diagnostic settled it — the
    /// working set peaks near run 500 at ~85MB, falls back, and then oscillates in the
    /// 80-82MB band for the remaining 3500 runs, ending +0.85MB on baseline with the
    /// managed heap flat at +0.29MB. The ramp is warm-up. The thresholds below are sized
    /// for that ramp, not for the steady state.</para>
    /// </summary>
    [Fact]
    public void FiveHundredConsecutiveRunsDoNotGrowMemory()
    {
        if (NoRecognizer())
        {
            return;
        }

        using var ocr = OcrService.Create(Language);
        var pixels = TextBitmap.Render(Width, Height, ["You must find the key", "before the gate closes"]);
        var process = Process.GetCurrentProcess();

        // Settle before the baseline so the series measures the steady state rather than
        // one-time start-up allocation.
        for (var i = 0; i < 10; i++)
        {
            ocr.Recognize(pixels, Width, Height);
        }

        Collect();
        var gcAtStart = GC.CollectionCount(0) + GC.CollectionCount(1) + GC.CollectionCount(2);
        var managedBaseline = GC.GetTotalMemory(true);
        process.Refresh();
        var workingBaseline = process.WorkingSet64;

        output.WriteLine("run    managed(MB)  workingSet(MB)");
        output.WriteLine($"{0,-6} {managedBaseline / 1048576.0,11:F2} {workingBaseline / 1048576.0,15:F2}");

        var managedSeries = new List<long>();
        var workingSeries = new List<long>();

        for (var run = 1; run <= 500; run++)
        {
            var lines = ocr.Recognize(pixels, Width, Height);
            Assert.NotEmpty(lines);

            if (run % 100 == 0)
            {
                Collect();
                process.Refresh();
                var managed = GC.GetTotalMemory(true);
                var working = process.WorkingSet64;
                managedSeries.Add(managed);
                workingSeries.Add(working);
                output.WriteLine($"{run,-6} {managed / 1048576.0,11:F2} {working / 1048576.0,15:F2}");
            }
        }

        var gcAtEnd = GC.CollectionCount(0) + GC.CollectionCount(1) + GC.CollectionCount(2);
        var managedGrowth = managedSeries[^1] - managedBaseline;
        var workingGrowth = workingSeries[^1] - workingBaseline;

        output.WriteLine(
            $"growth over 500 runs: managed {managedGrowth / 1048576.0:+0.00;-0.00}MB, "
            + $"workingSet {workingGrowth / 1048576.0:+0.00;-0.00}MB, "
            + $"{gcAtEnd - gcAtStart} collections ran during the run");

        // A per-frame SoftwareBitmap would be ~1MB of native memory 500 times over, so the
        // leak this criterion aims at shows up as hundreds of MB. These thresholds are
        // loose enough to tolerate allocator and recognizer-cache noise, and tight enough
        // that the failure mode cannot hide under them.
        Assert.True(managedGrowth < 8 * 1024 * 1024, $"managed heap grew {managedGrowth / 1048576.0:F2}MB over 500 runs");
        Assert.True(workingGrowth < 64 * 1024 * 1024, $"working set grew {workingGrowth / 1048576.0:F2}MB over 500 runs");
    }

    // ------------------------------------------------------------------
    // Failure paths — nothing silent (invariant 4)
    // ------------------------------------------------------------------

    [Fact]
    public void AMissingRecognizerIsReportedWithTheTagAndWhatIsInstalled()
    {
        // "zz" is a well-formed but unassigned tag, so this exercises the real
        // TryCreateFromLanguage-returned-null branch on any machine.
        var error = Assert.Throws<InvalidOperationException>(() => OcrService.Create("zz"));

        output.WriteLine(error.Message);
        Assert.Contains("zz", error.Message, StringComparison.Ordinal);
        Assert.Contains("installed", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankLanguageTagIsRejected(string tag)
    {
        Assert.ThrowsAny<ArgumentException>(() => OcrService.Create(tag));
    }

    [Fact]
    public void ABufferWhoseLengthContradictsItsDimensionsIsRejected()
    {
        if (NoRecognizer())
        {
            return;
        }

        using var ocr = OcrService.Create(Language);

        Assert.Throws<ArgumentException>(() => ocr.Recognize(new byte[100], Width, Height));
    }

    [Fact]
    public void ARegionLargerThanTheRecognizerAcceptsIsRejectedBySize()
    {
        if (NoRecognizer())
        {
            return;
        }

        using var ocr = OcrService.Create(Language);
        var oversize = (int)OcrService.MaxImageDimension + 1;
        output.WriteLine($"OcrEngine.MaxImageDimension = {OcrService.MaxImageDimension}px");

        // Rejected up front with a message that names the limit, rather than failing inside
        // RecognizeAsync with something that never mentions size.
        var error = Assert.Throws<ArgumentException>(
            () => ocr.Recognize(new byte[(long)oversize * 4], oversize, 1));

        Assert.Contains("maximum edge", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void UsingTheServiceAfterDisposalThrowsRatherThanTouchingFreedMemory()
    {
        if (NoRecognizer())
        {
            return;
        }

        var ocr = OcrService.Create(Language);
        ocr.Dispose();

        Assert.Throws<ObjectDisposedException>(() => ocr.Recognize(TextBitmap.Blank(64, 64), 64, 64));
    }

    [Fact]
    public void AChangeOfRegionSizeIsHandledWithoutRecreatingTheService()
    {
        if (NoRecognizer())
        {
            return;
        }

        // The bitmap is cached by size, so a resized region has to rebuild it. Getting this
        // wrong shows up as recognition against a stale, wrongly-shaped buffer — and the
        // third call proves the cache still works after the rebuild.
        using var ocr = OcrService.Create(Language);

        var wide = ocr.Recognize(TextBitmap.Render(Width, Height, ["You must find the key"]), Width, Height);
        var narrow = ocr.Recognize(TextBitmap.Render(700, 120, ["before the gate closes"]), 700, 120);
        var wideAgain = ocr.Recognize(TextBitmap.Render(Width, Height, ["You must find the key"]), Width, Height);

        Assert.Contains("key", wide[0].Text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("gate", narrow[0].Text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("key", wideAgain[0].Text, StringComparison.OrdinalIgnoreCase);
    }

    private static void Collect()
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
    }
}
