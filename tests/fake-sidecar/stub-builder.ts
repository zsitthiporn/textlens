/**
 * Compiles the launcher that lets a fixture satisfy `TEXTLENS_SIDECAR_PATH` (M3-06).
 *
 * `resolveSidecarPath` and `src/main/index.ts` are out of scope for this issue and stay
 * unmodified (see CLAUDE.md task scope): `startSidecar` builds `new SidecarClient({ exePath,
 * logger })` with **no args**, so whatever `TEXTLENS_SIDECAR_PATH` points at is spawned as
 * `child_process.spawn(exePath, [])` - no shell, zero arguments. A plain Node script cannot
 * satisfy that: Node hardened `spawn`/`execFile` against CVE-2024-27980, so a `.cmd`/`.bat`
 * file spawned this way now throws `EINVAL` instead of silently going through `cmd.exe`
 * (verified empirically against this repo's own Node 22.22.3, not assumed from the advisory).
 * `TEXTLENS_SIDECAR_PATH` only ever pointed at a real sidecar `.exe` before this issue, and
 * the fake has to be a real `.exe` too, or the env-var plug-in point stops being true.
 *
 * The launcher is a ~40-line C# program compiled on the fly with `csc.exe`, which ships
 * with the .NET Framework 4 runtime present by default on every supported Windows release
 * (Windows 10/11, and the `windows-latest` GitHub Actions image) - not a new project
 * dependency, npm or otherwise. It runs `node <replay.mjs> <fixture>` and proxies bytes
 * between its own stdio and that child's on two background threads.
 *
 * That proxying is not optional ceremony. `Process.Start` with every `RedirectStandard*`
 * left `false` does **not** forward the launcher's own inherited stdio handles to the
 * grandchild when `CreateNoWindow` is set - there is no console to inherit from and no
 * `STARTF_USESTDHANDLES` gets set, so the grandchild's stdin/stdout end up unusable. This
 * was measured while building this file: a passthrough-only stub left `ready` unreadable
 * and `stdin.end()` never reaching the grandchild (it hung past its shutdown timeout).
 * Redirecting explicitly and pumping bytes by hand is what makes `SidecarClient.stop()`'s
 * "close stdin, wait for exit" contract work through the extra process hop.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where `csc.exe` lives on a stock Windows install. First match wins. */
const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
] as const;

function findCsc(): string {
  const found = CSC_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (found !== undefined) return found;
  throw new Error(
    `csc.exe not found in any of: ${CSC_CANDIDATES.join(', ')}. It ships with the .NET ` +
      'Framework 4 runtime and is present by default on Windows 10/11 and windows-latest ' +
      'GitHub Actions runners; a machine without it cannot build the fake-sidecar launcher.',
  );
}

/** A valid C# string literal for an arbitrary value - escapes backslashes and quotes. */
function csString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Forward slashes read fine in both a Win32 path and a C# string literal; avoids escaping. */
function forwardSlashes(value: string): string {
  return value.split(path.sep).join('/');
}

function stubSource(nodeExePath: string, scriptArgs: readonly string[]): string {
  const commandLine = scriptArgs.map((arg) => `"${forwardSlashes(arg)}"`).join(' ');

  return `using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

class Stub
{
    static int Main()
    {
        var psi = new ProcessStartInfo
        {
            FileName = ${csString(forwardSlashes(nodeExePath))},
            Arguments = ${csString(commandLine)},
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        using (var p = Process.Start(psi))
        {
            var outThread = StartPump(p.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
            var errThread = StartPump(p.StandardError.BaseStream, Console.OpenStandardError(), false);
            // Do not join the input pump: our own stdin may outlive the grandchild (a
            // caller that never closes it), and that must not hang shutdown.
            StartPump(Console.OpenStandardInput(), p.StandardInput.BaseStream, true);

            p.WaitForExit();
            outThread.Join();
            errThread.Join();
            return p.ExitCode;
        }
    }

    // Manual byte pump, not "don't redirect": see the module doc for why the latter
    // leaves the grandchild's stdio unusable once CreateNoWindow is set.
    static Thread StartPump(Stream input, Stream output, bool closeOutputOnEof)
    {
        var t = new Thread(() =>
        {
            var buffer = new byte[8192];
            int read;
            try
            {
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, read);
                    output.Flush();
                }
            }
            catch (IOException) { }
            catch (ObjectDisposedException) { }
            finally
            {
                if (closeOutputOnEof)
                {
                    try { output.Close(); } catch { }
                }
            }
        });
        t.IsBackground = true;
        t.Start();
        return t;
    }
}
`;
}

export interface FakeSidecarStub {
  /** Path to the compiled launcher. Point `TEXTLENS_SIDECAR_PATH` (or `exePath`) at this. */
  readonly exePath: string;
  /** Removes the scratch directory holding the generated `.cs` and compiled `.exe`. */
  cleanup(): void;
}

/**
 * Compile a launcher that runs `node <scriptPath> <...scriptArgs>` with its stdio
 * transparently proxied. Takes on the order of a few hundred ms; there is no cache -
 * see README.md for why that trade-off was made deliberately.
 */
export function buildFakeSidecarStub(scriptPath: string, scriptArgs: readonly string[] = []): FakeSidecarStub {
  const csc = findCsc();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'textlens-fake-sidecar-'));
  const csPath = path.join(workDir, 'Stub.cs');
  const exePath = path.join(workDir, 'Stub.exe');

  fs.writeFileSync(csPath, stubSource(process.execPath, [scriptPath, ...scriptArgs]), 'utf8');

  const result = spawnSync(csc, ['/nologo', '/target:exe', `/out:${exePath}`, csPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `csc.exe failed to build the fake-sidecar launcher (exit ${String(result.status)}):\n` +
        `${result.stdout}\n${result.stderr}`,
    );
  }

  return {
    exePath,
    cleanup: () => {
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}
