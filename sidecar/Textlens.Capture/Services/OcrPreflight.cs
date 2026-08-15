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
    /// Matching is case-insensitive on the full tag, and falls back to the primary
    /// subtag: <c>en-GB</c> satisfies a request for <c>en-US</c>. That is looser than
    /// string equality on purpose. The failure modes are not symmetric — telling a user
    /// with a working English recognizer to go install an English recognizer is a dead
    /// end, whereas an over-optimistic match surfaces later as a concrete engine
    /// creation failure from <c>OcrEngine.TryCreateFromLanguage</c> (M2-04), which is
    /// both actionable and correctly attributed.
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
