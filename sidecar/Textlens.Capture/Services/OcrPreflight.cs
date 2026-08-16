using Textlens.Capture.Protocol;

namespace Textlens.Capture.Services;

/// <summary>
/// Feature O8 — decides whether this machine has an OCR recognizer for the source
/// language, and produces the user-facing failure if it does not.
///
/// Spike S1 found the test machine carried exactly one recognizer (<c>en-US</c>).
/// A machine without an English language pack cannot run Textlens at all, so the
/// condition has to be reported rather than discovered halfway down the pipeline
/// (CLAUDE.md invariant 4).
///
/// Deliberately a pure function over a list of tags rather than a wrapper around
/// <c>OcrEngine.AvailableRecognizerLanguages</c>: the interesting case is the machine
/// this code is *not* running on, and the only way to test that without WinRT mocking
/// is to keep the WinRT query at the call site and the decision here.
/// </summary>
public static class OcrPreflight
{
    /// <summary>The <c>error.code</c> emitted when no recognizer matches.</summary>
    public const string LanguageMissingCode = "OCR_LANGUAGE_MISSING";

    /// <summary>
    /// Source language assumed before Node sends <c>configure</c>. MVP translates
    /// en→th, so English is what the start-up preflight asks about; the check is
    /// re-run against <c>configure.ocrLanguage</c> once that command exists (M2-06).
    /// </summary>
    public const string DefaultSourceLanguage = "en-US";

    /// <summary>
    /// Returns the error to emit, or <c>null</c> when a usable recognizer is present.
    ///
    /// Returning the event rather than throwing is the point: the caller emits it and
    /// keeps running, so the user can install the pack and retry without the process
    /// having died underneath them.
    /// </summary>
    /// <param name="installedLanguages">
    /// BCP-47 tags from <c>OcrEngine.AvailableRecognizerLanguages</c>. May be empty —
    /// that is the exact case this check exists for.
    /// </param>
    /// <param name="requiredLanguage">BCP-47 tag of the source language, e.g. <c>en-US</c>.</param>
    public static ErrorEvent? Check(IReadOnlyList<string> installedLanguages, string requiredLanguage)
    {
        ArgumentNullException.ThrowIfNull(installedLanguages);
        ArgumentNullException.ThrowIfNull(requiredLanguage);

        if (IsSatisfied(installedLanguages, requiredLanguage))
        {
            return null;
        }

        return new ErrorEvent
        {
            Code = LanguageMissingCode,
            Message = BuildMessage(installedLanguages, requiredLanguage),
        };
    }

    /// <summary>
    /// Whether any installed recognizer can serve <paramref name="requiredLanguage"/>.
    ///
    /// <para>Matching is case-insensitive on the full tag, and falls back to the primary
    /// subtag: <c>en-GB</c> satisfies a request for <c>en-US</c>. That is looser than string
    /// equality, and #55 asked whether it is <i>too</i> loose — if the engine wanted an exact
    /// tag, this check would pass a machine the engine then refuses, and the fatal alert would
    /// go silent on the machine that needs it most.</para>
    ///
    /// <para><b>It is not too loose: the engine does the same thing.</b> Measured directly
    /// against WinRT on a machine whose <c>AvailableRecognizerLanguages</c> is exactly
    /// <c>["en-US"]</c> (Windows 10.0.26200; the probe is re-runnable from Windows PowerShell
    /// 5.1, which is the only host with a WinRT projection):</para>
    ///
    /// <code>
    /// requested   IsLanguageSupported   TryCreateFromLanguage   RecognizerLanguage
    /// en-US       True                  engine                  en-US
    /// en-GB       True                  engine                  en-US
    /// en-AU       True                  engine                  en-US
    /// en-CA       True                  engine                  en-US
    /// en-IN       True                  engine                  en-US
    /// en          True                  engine                  en-US
    /// en-ZZ       True                  engine                  en-US
    /// th-TH       False                 null
    /// fr-FR       False                 null
    /// ja          False                 null
    /// </code>
    ///
    /// <para>Three things follow. <c>AvailableRecognizerLanguages</c> reports a
    /// <i>region-specific</i> tag rather than a neutral <c>en</c>, so string equality would
    /// have been wrong on every non-US English machine — the loose direction is the safe one.
    /// <c>en-ZZ</c>, a region that does not exist, also resolves, which rules out a curated
    /// table of regional aliases and shows the resolution is generic within the primary
    /// subtag. And <c>fr-FR</c> is refused despite being <c>Latn</c> like <c>en-US</c>, so the
    /// engine matches on the language subtag rather than on script. On this data the engine's
    /// behaviour <i>is</i> primary-subtag matching — precisely what this method does.</para>
    ///
    /// <para><b>What the measurement does not cover.</b> It is the mirror of #55's case: an
    /// en-US machine asked for en-GB, not an en-GB machine asked for en-US. This machine has
    /// en-US, so the failing configuration cannot be produced here at all — the same blind
    /// spot as a 1.0 scale factor hiding a DPI bug. The <c>en-ZZ</c> row is what makes the
    /// symmetric reading the reasonable one, but it stays an inference. Untested for the same
    /// reason: whether <c>zh-Hans</c> satisfies <c>zh-Hant</c>, which shares a primary subtag
    /// and would be the one place this really could over-match. Out of MVP scope (en→th), and
    /// if a script-bearing language is ever added this is the paragraph to revisit.</para>
    ///
    /// <para>Deliberately <i>not</i> replaced by <c>OcrEngine.IsLanguageSupported</c>, which
    /// would answer this authoritatively and remove the inference: it would move the WinRT
    /// call into the decision, and keeping the decision a pure function over a list of tags is
    /// what makes the interesting case — the machine this code is not running on — testable at
    /// all. See the type-level comment.</para>
    /// </summary>
    private static bool IsSatisfied(IReadOnlyList<string> installedLanguages, string requiredLanguage)
    {
        var requiredPrimary = PrimarySubtag(requiredLanguage);
        if (requiredPrimary.Length == 0)
        {
            // A blank or malformed request cannot be satisfied by anything. Saying "no"
            // is right; the message names the tag so the misconfiguration is visible.
            return false;
        }

        foreach (var installed in installedLanguages)
        {
            if (installed is null)
            {
                continue;
            }

            if (string.Equals(installed, requiredLanguage, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (string.Equals(PrimarySubtag(installed), requiredPrimary, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The part of a BCP-47 tag before the first hyphen: <c>en-US</c> → <c>en</c>.</summary>
    private static string PrimarySubtag(string tag)
    {
        var trimmed = tag.Trim();
        var hyphen = trimmed.IndexOf('-');
        return hyphen < 0 ? trimmed : trimmed[..hyphen];
    }

    /// <summary>
    /// The message shipped to Node. It carries the install path verbatim because the
    /// Windows UI for this is genuinely hard to find, and it lists what *is* installed
    /// so a support conversation starts from facts rather than from a guess.
    ///
    /// <para>Worded to survive JSON encoding legibly. The protocol serializer uses
    /// System.Text.Json's default HTML-safe encoder, which turns <c>&gt;</c>, <c>&amp;</c>
    /// and <c>"</c> into <c>></c>, <c>&</c> and <c>"</c> — all correct, all
    /// unreadable when someone runs the sidecar standalone and reads stdout, which the
    /// design doc names as the reason stdio was chosen over a named pipe. Arrows and
    /// ampersands are therefore spelled out rather than punctuated. Node re-renders this
    /// for the user in M10-02; this wording is the diagnostic one.</para>
    /// </summary>
    private static string BuildMessage(IReadOnlyList<string> installedLanguages, string requiredLanguage)
    {
        var installed = installedLanguages.Count == 0
            ? "none"
            : string.Join(", ", installedLanguages);

        return $"No OCR recognizer for {requiredLanguage} is installed (installed: {installed}). "
            + "Install it from Settings: Time and language / Language and region / English / "
            + "Language options / Optional language features / Optical character recognition, "
            + "then restart Textlens.";
    }
}
