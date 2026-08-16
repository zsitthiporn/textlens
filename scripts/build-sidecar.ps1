<#
.SYNOPSIS
  Publish the .NET sidecar as a self-contained NativeAOT single exe, for electron-builder to
  pick up as `resources/sidecar/Textlens.Capture.exe` (issue #45 / B1).

.DESCRIPTION
  Always rebuilds. A stale sidecar shipped inside an installer is the worst outcome this
  script exists to prevent: it is invisible in the logs, since an old exe speaks the same
  protocol and reports itself up. There is no "reuse if present" fast path on purpose.

  The exe path this produces must stay in agreement with `resolveSidecarPath` in
  src/main/services/sidecar-client.ts, which - when `app.isPackaged` - looks in exactly
  `<resourcesPath>/sidecar/Textlens.Capture.exe`. The mapping is in electron-builder.yml
  under `extraResources`; this script only has to put the exe where that mapping reads from.

.NOTES
  `NoDefaultCurrentDirectoryInExePath` is cleared below rather than documented as a
  precondition. When it is set at process scope, `VsDevCmd.bat` cannot find `vswhere.exe`,
  MSBuild splices the resulting error text into `$(CppLinker)`, and the NativeAOT link step
  fails as `MSB3073 ... exited with code 123` - which names neither the variable nor the
  linker. Clearing it here means an agent shell, a CI runner and a developer terminal all
  publish the same way. See CLAUDE.md.
#>
[CmdletBinding()]
param(
    # `Release` is what ships. Overridable so a developer can smoke-test the packaging path
    # without paying for a full AOT link.
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot 'sidecar\Textlens.Capture\Textlens.Capture.csproj'
$tfm = 'net10.0-windows10.0.19041.0'
$rid = 'win-x64'
$publishDir = Join-Path $repoRoot "sidecar\Textlens.Capture\bin\$Configuration\$tfm\$rid\publish"
$exePath = Join-Path $publishDir 'Textlens.Capture.exe'

if (-not (Test-Path $project)) {
    throw "sidecar project not found at $project"
}

# See .NOTES. Process scope only - this does not touch the user's environment.
if ($null -ne $env:NoDefaultCurrentDirectoryInExePath) {
    Write-Host 'clearing NoDefaultCurrentDirectoryInExePath for this process (NativeAOT link workaround)'
    Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
}

# Belt and braces for the same failure: if the VS Installer directory is missing from PATH,
# `vswhere.exe` is unreachable by its other lookup route too.
$vsInstaller = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer'
if ((Test-Path $vsInstaller) -and ($env:PATH -notlike "*$vsInstaller*")) {
    $env:PATH = "$env:PATH;$vsInstaller"
}

# A leftover exe from a previous run would survive a failed publish and be packaged silently.
if (Test-Path $exePath) {
    Remove-Item $exePath -Force
}

Write-Host "publishing sidecar ($Configuration, $rid, NativeAOT)..."
& dotnet publish $project -c $Configuration -r $rid --nologo
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path $exePath)) {
    throw "publish reported success but $exePath does not exist"
}

$info = Get-Item $exePath
$hash = (Get-FileHash $exePath -Algorithm SHA256).Hash
Write-Host ''
Write-Host "sidecar published: $exePath"
Write-Host ("  size     : {0:N0} bytes" -f $info.Length)
Write-Host "  modified : $($info.LastWriteTime.ToString('s'))"
Write-Host "  sha256   : $hash"
