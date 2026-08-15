using System.Text;
using Textlens.Capture.Protocol;
using Textlens.Capture.Services;

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
    private static int Main(string[] args)
    {
        // Before any monitor is queried and before any WinRT capture object exists: the
        // process DPI awareness context is latched at first use, and getting it wrong
        // silently corrupts every rectangle the sidecar reports on a scaled display.
        // See MonitorEnumerator.EnsurePerMonitorDpiAwareness for why this cannot be
        // observed on an all-100% machine.
        if (!MonitorEnumerator.EnsurePerMonitorDpiAwareness())
        {
            Console.Error.WriteLine(
                "WARN: SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) failed; "
                + "monitor bounds on scaled displays may be virtualized");
        }

        // Diagnostic modes, used to drive real hardware while the command loop (M2-06)
        // does not exist yet. They never emit protocol events.
        //
        // Matched against a known list rather than "starts with --": switches that
        // modify normal protocol mode (--require-ocr-language) also start with two
        // dashes, and treating those as a probe silently swallows the run.
        if (args.Length > 0 && ProbeModes.Contains(args[0]))
        {
            return RunProbe(args);
        }

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

        var ocrLanguages = InstalledOcrLanguages();

        stdout.WriteLine(ProtocolCodec.Encode(new ReadyEvent
        {
            Version = Version,
            OcrLanguages = ocrLanguages,
        }));

        // Feature O8. Ordered after `ready` deliberately: `ready` is defined as the
        // first line on the stream (Events.cs), and a machine with no English pack
        // still has a valid — merely disappointing — language list to report. Node
        // therefore always gets the handshake before it gets the bad news.
        //
        // Emitting and continuing, rather than exiting, is the acceptance criterion:
        // the user installs the pack and retries against a process that is still here.
        var preflight = OcrPreflight.Check(ocrLanguages, RequiredOcrLanguage(args));
        if (preflight is not null)
        {
            stdout.WriteLine(ProtocolCodec.Encode(preflight));
        }

        // The command loop (M2-06). One line in, at least one event out, until the parent
        // closes the pipe — a null read is the shutdown signal.
        //
        // Every event in the process funnels through this one lambda and its lock. That is
        // not ceremony: capture ticks run on threadpool threads while acks are written from
        // this one, and two interleaved WriteLine calls would splice two JSON objects into
        // a line that neither side can parse. One writer, one lock, no exceptions.
        var writeGate = new object();
        void Emit(ISidecarEvent evt)
        {
            lock (writeGate)
            {
                stdout.WriteLine(ProtocolCodec.Encode(evt));
            }
        }

        using var dispatcher = new Dispatcher(new WindowsCaptureHost(), Emit);
        using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        while (stdin.ReadLine() is { } line)
        {
            // A blank line is what a human typing into the process produces by pressing
            // enter, and it is not worth an error event.
            if (line.Trim().Length == 0)
            {
                continue;
            }

            dispatcher.Execute(line);
        }

        return 0;
    }

    /// <summary>Arguments that select a diagnostic mode instead of the protocol stream.</summary>
    private static readonly string[] ProbeModes = ["--list-monitors", "--probe-capture", "--probe-colors", "--help"];

    /// <summary>
    /// Source language the start-up preflight asks about.
    ///
    /// <c>--require-ocr-language &lt;tag&gt;</c> overrides it. That switch exists so the
    /// missing-recognizer path can be exercised against the real binary on a machine
    /// that <i>has</i> the recognizer — every dev box does, which is precisely why the
    /// branch that matters to users would otherwise never be run outside a unit test.
    /// It is a diagnostic, not a setting: M2-06 takes the real value from
    /// <c>configure.ocrLanguage</c>.
    /// </summary>
    private static string RequiredOcrLanguage(string[] args)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--require-ocr-language")
            {
                return args[i + 1];
            }
        }

        return OcrPreflight.DefaultSourceLanguage;
    }

    /// <summary>
    /// Diagnostic entry points for M2-02. Output goes to stderr and consists of
    /// statistics only — never captured pixels.
    /// </summary>
    private static int RunProbe(string[] args)
    {
        var log = Console.Error;

        try
        {
            switch (args[0])
            {
                case "--list-monitors":
                    return CaptureProbe.ListMonitors(log);

                case "--probe-capture":
                    return CaptureProbe.Run(
                        log,
                        ArgValue(args, "--monitor") ?? MonitorEnumerator.Primary().Info.Id,
                        ParseRect(ArgValue(args, "--region") ?? "0,0,1200,200"),
                        int.Parse(ArgValue(args, "--frames") ?? "100", System.Globalization.CultureInfo.InvariantCulture));

                // Spike S2's instrument: does a value painted on the overlay survive into
                // what our own WGC path sees. Reports coverage of named colours only.
                case "--probe-colors":
                    return CaptureProbe.ProbeColors(
                        log,
                        ArgValue(args, "--monitor") ?? MonitorEnumerator.Primary().Info.Id,
                        ParseRect(ArgValue(args, "--region") ?? "0,0,1200,200"),
                        int.Parse(ArgValue(args, "--frames") ?? "20", System.Globalization.CultureInfo.InvariantCulture),
                        ParseColors(ArgValue(args, "--colors") ?? "000000"),
                        int.Parse(ArgValue(args, "--tolerance") ?? "4", System.Globalization.CultureInfo.InvariantCulture));

                default:
                    log.WriteLine("Textlens.Capture — sidecar. With no arguments it speaks the JSON-lines");
                    log.WriteLine("protocol on stdio. Diagnostic modes (stderr only, never pixels):");
                    log.WriteLine("  --list-monitors");
                    log.WriteLine("  --probe-capture [--monitor <id>] [--region x,y,w,h] [--frames n]");
                    log.WriteLine("  --probe-colors  [--monitor <id>] [--region x,y,w,h] [--frames n]");
                    log.WriteLine("                  [--colors RRGGBB,...] [--tolerance n]");
                    log.WriteLine("  --require-ocr-language <bcp47>   (applies to normal protocol mode)");
                    return 2;
            }
        }
        catch (Exception ex)
        {
            log.WriteLine($"probe failed: {ex.GetType().FullName}: {ex.Message}");
            return 1;
        }
    }

    private static string? ArgValue(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == name)
            {
                return args[i + 1];
            }
        }

        return null;
    }

    /// <summary>Comma-separated <c>RRGGBB</c> hex values for <c>--probe-colors</c>.</summary>
    private static uint[] ParseColors(string value)
        => value
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(part => uint.Parse(part.TrimStart('#'), System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture))
            .ToArray();

    private static Rect ParseRect(string value)
    {
        var parts = value.Split(',');
        if (parts.Length != 4)
        {
            throw new FormatException($"expected \"x,y,w,h\", got \"{value}\"");
        }

        return new Rect(
            int.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture),
            int.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture),
            int.Parse(parts[2], System.Globalization.CultureInfo.InvariantCulture),
            int.Parse(parts[3], System.Globalization.CultureInfo.InvariantCulture));
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
