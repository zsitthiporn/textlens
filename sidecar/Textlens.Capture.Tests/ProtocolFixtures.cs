namespace Textlens.Capture.Tests;

/// <summary>
/// Locates <c>tests/fixtures/protocol/</c> — the golden samples this suite shares
/// with the vitest suite.
///
/// The files are read from the repository in place rather than copied into the test
/// output. That is the whole point: a copy step would let the two suites drift onto
/// two different versions of the "same" fixture and still both pass.
/// </summary>
internal static class ProtocolFixtures
{
    /// <summary>Absolute path of the shared fixture directory.</summary>
    public static string Root { get; } = Locate();

    /// <summary>Reads one single-line fixture, without its trailing newline.</summary>
    public static string Read(string fileName) => File.ReadAllText(Path.Combine(Root, fileName)).Trim();

    /// <summary>Reads a JSON-lines fixture, skipping blank lines exactly as a stream reader would.</summary>
    public static string[] ReadLines(string fileName) =>
        File.ReadAllLines(Path.Combine(Root, fileName))
            .Where(line => line.Trim().Length > 0)
            .ToArray();

    private static string Locate()
    {
        // Walk up rather than counting "..\..\..": the number of levels changes with
        // configuration and TFM, and a wrong count fails as "fixture not found" long
        // after the change that caused it.
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "tests", "fixtures", "protocol");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new DirectoryNotFoundException(
            $"walked up from '{AppContext.BaseDirectory}' without finding tests/fixtures/protocol");
    }
}
