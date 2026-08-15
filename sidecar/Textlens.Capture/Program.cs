using System.Text;
using Textlens.Capture.Protocol;

namespace Textlens.Capture;

/// <summary>
/// Sidecar entry point.
///
/// Scaffold only (issue M1-02). The real capture/diff/OCR pipeline lands in M2 and
/// the stdin command dispatcher lands in M2-06 — this file deliberately implements
/// neither. It does exactly three things:
///
///   1. proves WinRT is reachable from the published (NativeAOT) binary,
///   2. emits the <c>ready</c> event on stdout,
///   3. blocks on stdin so the Node side can hold the process open.
/// </summary>
internal static class Program
{
    private static int Main()
    {
        // stdout carries the JSON-lines protocol and nothing else. UTF-8 without a
        // BOM, '\n' line endings, autoflush — a stray BOM or '\r' would corrupt the
        // first frame for the Node-side line reader.
        using var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))
        {
            AutoFlush = true,
            NewLine = "\n",
        };

        // Touch a WinRT API before announcing readiness. This is what makes the
        // NativeAOT publish actually compile and activate WinRT interop rather than
        // merely reference it — and it fails loudly here instead of deep in the
        // capture loop (CLAUDE.md invariant 4: no silent failures).
        //
        // MaxImageDimension is a static on the OcrEngine runtime class, so it proves
        // real cross-COM activation without depending on which language packs are
        // installed. The en-US recognizer preflight is feature O8, a separate issue.
        try
        {
            _ = Windows.Media.Ocr.OcrEngine.MaxImageDimension;
        }
        catch (Exception ex)
        {
            // Diagnostics go to stderr so the protocol stream on stdout stays clean.
            // A non-zero exit lets the Node supervisor distinguish this from a crash.
            Console.Error.WriteLine($"FATAL: WinRT unavailable: {ex.GetType().FullName}: {ex.Message}");
            return 1;
        }

        stdout.WriteLine(ProtocolCodec.Encode(new ReadyEvent
        {
            Version = Version,
            OcrLanguages = InstalledOcrLanguages(),
        }));

        // Hold the process open on stdin. M2-06 replaces this with the command
        // dispatcher; for now every line is consumed and ignored. A null read means
        // the parent closed the pipe, which is our shutdown signal.
        using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        while (stdin.ReadLine() is not null)
        {
            // Intentionally empty — see M2-06.
        }

        return 0;
    }

    /// <summary>Assembly version as "major.minor.patch".</summary>
    private static string Version
    {
        get
        {
            var v = typeof(Program).Assembly.GetName().Version;
            return v is null ? "0.0.0" : $"{v.Major}.{v.Minor}.{v.Build}";
        }
    }

    /// <summary>
    /// BCP-47 tags of the OCR recognizers installed on this machine.
    ///
    /// Enumerated at runtime, never hardcoded: the design doc's example lists
    /// <c>["en-US","th-TH"]</c> but that is an illustration, and the whole point of
    /// shipping this list is that feature O8 can tell the user which recognizer is
    /// missing. An empty array is a legitimate answer and a meaningful one.
    /// </summary>
    private static string[] InstalledOcrLanguages()
    {
        try
        {
            return Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages
                .Select(language => language.LanguageTag)
                .ToArray();
        }
        catch (Exception ex)
        {
            // Distinguish "the query failed" from "nothing is installed" in the log,
            // since both end up as an empty array on the wire. Not fatal: the
            // preflight check that acts on this is feature O8.
            Console.Error.WriteLine(
                $"WARN: could not enumerate OCR recognizers: {ex.GetType().FullName}: {ex.Message}");
            return [];
        }
    }
}
