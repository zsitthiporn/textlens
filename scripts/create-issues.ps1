<#
.SYNOPSIS
    Create every GitHub issue defined in docs/backlog/mvp-issues.md

.DESCRIPTION
    Parses the backlog file, creates any missing milestones and labels, then
    opens one issue per entry. Issue bodies are Thai; this script's own output
    is English on purpose - Windows PowerShell 5.1 reads .ps1 files as ANSI
    unless they carry a UTF-8 BOM, and non-ASCII source text breaks the parser.

.EXAMPLE
    powershell -File scripts/create-issues.ps1 -DryRun
    powershell -File scripts/create-issues.ps1
#>
[CmdletBinding()]
param(
    [string]$BacklogPath = '',
    [string]$Repo = '',
    [switch]$DryRun,
    # Update the body, milestone and labels of issues that already exist,
    # matched by exact title. Creates nothing.
    [switch]$Sync
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is not reliably populated while param defaults bind under PS 5.1,
# so resolve the default path here instead.
if (-not $BacklogPath) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $BacklogPath = Join-Path $scriptDir '..\docs\backlog\mvp-issues.md'
}

# --- preflight ---------------------------------------------------------------

# -DryRun only exercises parsing, so it does not need gh.
if (-not $DryRun) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        Write-Host "gh CLI is not installed. Install it with:" -ForegroundColor Red
        Write-Host "  winget install --id GitHub.cli"
        Write-Host "then sign in with:"
        Write-Host "  gh auth login"
        exit 1
    }
    gh auth status *> $null
    if (-not $?) {
        Write-Host "gh is not authenticated. Run: gh auth login" -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path $BacklogPath)) { throw "Backlog file not found: $BacklogPath" }

$repoArgs = @()
if ($Repo) { $repoArgs = @('--repo', $Repo) }

# --- parse -------------------------------------------------------------------

$raw = Get-Content $BacklogPath -Raw -Encoding utf8

# Everything after the END marker is document prose, not issue content. Without
# this the trailing sections get appended to the final issue's body.
$endIdx = $raw.IndexOf('<!-- END ISSUES -->')
if ($endIdx -ge 0) { $raw = $raw.Substring(0, $endIdx) }

$blocks = $raw -split '<!-- ISSUE -->' | Select-Object -Skip 1

$issues = @()
foreach ($b in $blocks) {
    $lines = $b -split "`r?`n"
    $meta = @{}
    $bodyStart = 0

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ([string]::IsNullOrWhiteSpace($line)) {
            if ($meta.Count -gt 0) { $bodyStart = $i + 1; break }
            continue
        }
        if ($line -match '^(title|milestone|labels|depends):\s*(.*)$') {
            $meta[$Matches[1]] = $Matches[2].Trim()
        }
        else { $bodyStart = $i; break }
    }

    if (-not $meta.ContainsKey('title') -or -not $meta['title']) { continue }

    # Strip the trailing --- separator that divides entries in the source file.
    $body = ($lines[$bodyStart..($lines.Count - 1)] -join "`n").Trim()
    $body = ($body -replace '(?s)\n-{3,}\s*$', '').Trim()

    if ($meta['depends']) {
        $body = "$body`n`n---`n`n**Blocked by:** $($meta['depends'])"
    }
    $body = "$body`n`n<sub>Generated from ``docs/backlog/mvp-issues.md`` - edit there and re-sync.</sub>"

    $labels = @()
    if ($meta['labels']) {
        $labels = $meta['labels'] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    }

    $issues += [pscustomobject]@{
        Title     = $meta['title']
        Milestone = $meta['milestone']
        Labels    = $labels
        Body      = $body
    }
}

Write-Host "Parsed $($issues.Count) issues from the backlog." -ForegroundColor Cyan
if ($issues.Count -eq 0) { throw "No issues parsed - check the file format." }

# --- dry run -----------------------------------------------------------------

if ($DryRun) {
    Write-Host "`n=== DRY RUN - nothing will be created ===`n" -ForegroundColor Yellow
    $issues | Group-Object Milestone | ForEach-Object {
        Write-Host "[$($_.Name)]  $($_.Count) issues" -ForegroundColor Green
        $_.Group | ForEach-Object {
            Write-Host ("   - {0}  ({1})" -f $_.Title, ($_.Labels -join ', '))
        }
    }
    Write-Host "`nLabels needed:     $((($issues.Labels | Sort-Object -Unique) -join ', '))"
    Write-Host "Milestones needed: $((($issues.Milestone | Sort-Object -Unique) -join ' | '))"
    $short = $issues | Where-Object { $_.Body.Length -lt 200 }
    if ($short) {
        Write-Host "`nWARNING - suspiciously short bodies:" -ForegroundColor Yellow
        $short | ForEach-Object { Write-Host "   $($_.Title) ($($_.Body.Length) chars)" }
    }
    exit 0
}

# --- sync mode ---------------------------------------------------------------

if ($Sync) {
    $listJson = gh issue list --state all --limit 300 --json number,title @repoArgs
    $existing = $listJson | ConvertFrom-Json
    $byTitle = @{}
    foreach ($e in $existing) { $byTitle[$e.title] = $e.number }

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) 'textlens-issues-sync'
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

    $updated = 0
    $missing = 0
    foreach ($iss in $issues) {
        if (-not $byTitle.ContainsKey($iss.Title)) {
            Write-Host "SKIP (no such issue) $($iss.Title)" -ForegroundColor Yellow
            $missing++
            continue
        }
        $num = $byTitle[$iss.Title]
        $bodyFile = Join-Path $tmpDir "$num.md"
        [System.IO.File]::WriteAllText($bodyFile, $iss.Body, (New-Object System.Text.UTF8Encoding $false))

        $ghArgs = @('issue', 'edit', "$num", '--body-file', $bodyFile) + $repoArgs
        if ($iss.Milestone) { $ghArgs += @('--milestone', $iss.Milestone) }
        try {
            & gh @ghArgs *> $null
            if ($?) { Write-Host "SYNCED #$num  $($iss.Title)" -ForegroundColor Green; $updated++ }
            else { Write-Host "FAIL #$num  $($iss.Title)" -ForegroundColor Red }
        }
        catch { Write-Host "FAIL #$num - $($_.Exception.Message)" -ForegroundColor Red }
        Start-Sleep -Milliseconds 300
    }
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "`nSynced $updated, not found $missing." -ForegroundColor Cyan
    exit 0
}

# --- milestones --------------------------------------------------------------

$existingMilestones = @()
try {
    $json = gh api 'repos/{owner}/{repo}/milestones?state=all&per_page=100' @repoArgs
    $existingMilestones = ($json | ConvertFrom-Json) | ForEach-Object { $_.title }
}
catch {
    Write-Host "Could not read existing milestones; will try to create all." -ForegroundColor Yellow
}

foreach ($m in ($issues.Milestone | Sort-Object -Unique)) {
    if ($existingMilestones -contains $m) {
        Write-Host "milestone exists: $m"
        continue
    }
    try {
        gh api 'repos/{owner}/{repo}/milestones' @repoArgs -f title="$m" *> $null
        Write-Host "created milestone: $m" -ForegroundColor Green
    }
    catch {
        Write-Host "could not create milestone '$m': $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# --- labels ------------------------------------------------------------------

foreach ($l in ($issues.Labels | Sort-Object -Unique)) {
    try {
        gh label create "$l" @repoArgs *> $null
        Write-Host "created label: $l" -ForegroundColor Green
    }
    catch {
        Write-Host "label exists: $l"
    }
}

# --- issues ------------------------------------------------------------------

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) 'textlens-issues'
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$created = 0
$failed = 0
foreach ($iss in $issues) {
    $bodyFile = Join-Path $tmpDir (($iss.Title -replace '[^\w\-]', '_') + '.md')
    # PS 5.1's -Encoding utf8 writes a BOM, which gh renders as stray characters.
    [System.IO.File]::WriteAllText($bodyFile, $iss.Body, (New-Object System.Text.UTF8Encoding $false))

    $ghArgs = @('issue', 'create', '--title', $iss.Title, '--body-file', $bodyFile) + $repoArgs
    if ($iss.Milestone) { $ghArgs += @('--milestone', $iss.Milestone) }
    foreach ($l in $iss.Labels) { $ghArgs += @('--label', $l) }

    try {
        $url = & gh @ghArgs
        if ($?) {
            Write-Host "OK   $($iss.Title)  ->  $url" -ForegroundColor Green
            $created++
        }
        else {
            Write-Host "FAIL $($iss.Title)" -ForegroundColor Red
            $failed++
        }
    }
    catch {
        Write-Host "FAIL $($iss.Title) - $($_.Exception.Message)" -ForegroundColor Red
        $failed++
    }
    Start-Sleep -Milliseconds 400   # stay under GitHub's secondary rate limit
}

Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`nCreated $created, failed $failed." -ForegroundColor Cyan
