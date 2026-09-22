# take-screenshot.ps1 -- Capture and crop a single README marketplace screenshot.
#
# Usage:
#   .\take-screenshot.ps1 import-connections          # capture + crop one screenshot
#   .\take-screenshot.ps1 import-connections -NoBuild  # skip the compile step
#   .\take-screenshot.ps1 import-connections -CropOnly # re-crop from last raw capture
#
# Prerequisites:
#   - vscode-ext-test CLI installed globally
#   - Windows PowerShell (this script uses System.Drawing)
#   - Display scaling at 100%

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Name,

    [switch]$NoBuild,
    [switch]$CropOnly
)

$ErrorActionPreference = 'Stop'

# -- Paths -------------------------------------------------------------------
# PSScriptRoot = .github/skills/readme-screenshots -> repo root is 3 levels up

$repoRoot    = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$skillDir    = $PSScriptRoot
$manifestPath = Join-Path $skillDir 'screenshots.json'
$featuresDir = Join-Path $skillDir 'features'
$mediaDir    = Join-Path $repoRoot 'media' 'marketplace'
$e2eBase     = Join-Path $repoRoot 'tests' 'vscode-extension-tester' 'e2e'
$runsBase    = Join-Path $repoRoot 'tests' 'vscode-extension-tester' 'runs'

# -- Load manifest ------------------------------------------------------------

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$entry = $manifest | Where-Object { $_.filename -eq "$Name.png" }
if (-not $entry) {
    Write-Error "No manifest entry for '$Name'. Check screenshots.json."
    exit 1
}

$featureName = if ($entry.feature) { $entry.feature } else { $Name }
$featureFile = Join-Path $featuresDir "$featureName.feature"
if (-not (Test-Path $featureFile)) {
    Write-Error "Feature file not found: $featureFile"
    exit 1
}

$captureProfile = $entry.profile
$testId  = if ($entry.testId) { $entry.testId } else { "readme-ss-$Name" }

function Copy-AdditionalOutputs([string]$Source) {
    foreach ($relativePath in $entry.additionalOutputs) {
        $destination = Join-Path $repoRoot $relativePath
        Copy-Item -LiteralPath $Source -Destination $destination -Force
        Write-Host "Also published: $destination" -ForegroundColor Green
    }
}

# -- Phase 1: Capture (unless -CropOnly) --------------------------------------

if (-not $CropOnly) {
    # Copy feature file into the e2e directory for the right profile
    $targetDir = Join-Path $e2eBase $captureProfile $testId
    if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
    Copy-Item $featureFile -Destination (Join-Path $targetDir "$featureName.feature") -Force

    # Build the run command
    $cmd = "vscode-ext-test run --test-id $testId"
    if ($captureProfile -ne 'default') { $cmd += " --reuse-named-profile $captureProfile" }
    if ($NoBuild)               { $cmd += " --no-build" }

    Write-Host "`n=== Capturing: $Name (profile=$captureProfile) ===" -ForegroundColor Cyan
    Invoke-Expression "$cmd 2>&1" | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Capture failed for $Name (exit code $LASTEXITCODE)"
        exit 1
    }
}

# -- Find the latest run directory ---------------------------------------------

$runProfileDir = Join-Path $runsBase $(if ($captureProfile -eq 'default') { 'default' } else { $captureProfile })
$runDirs = Get-ChildItem (Join-Path $runProfileDir $testId) -Directory | Sort-Object Name -Descending
if ($runDirs.Count -eq 0) {
    Write-Error "No run directory found for $testId"
    exit 1
}
$latestRun = $runDirs[0].FullName

$screenshotFilter = if ($entry.screenshotLabel) { "*-$($entry.screenshotLabel).png" } else { '*.png' }
$rawPng = Get-ChildItem $latestRun -Filter $screenshotFilter | Sort-Object Name | Select-Object -Last 1
if (-not $rawPng) {
    Write-Error "No screenshot PNG found in $latestRun"
    exit 1
}
Write-Host "Raw screenshot: $($rawPng.FullName)" -ForegroundColor Gray

# -- Phase 2: Crop ------------------------------------------------------------

$crop = $entry.crop
if (-not $crop) {
    Write-Warning "No crop coordinates in manifest for $Name -- copying raw screenshot as-is."
    $targetPng = Join-Path $mediaDir $entry.filename
    $oldPng = Join-Path $mediaDir ($entry.filename -replace '\.png$', '.old.png')
    if (-not (Test-Path $oldPng) -and (Test-Path $targetPng)) { Rename-Item $targetPng $oldPng -Force }
    Copy-Item $rawPng.FullName $targetPng -Force
    Copy-AdditionalOutputs $targetPng
    Write-Host "Copied (no crop): $targetPng" -ForegroundColor Green
    exit 0
}

Add-Type -AssemblyName System.Drawing

$targetPng = Join-Path $mediaDir $entry.filename
$oldPng    = Join-Path $mediaDir ($entry.filename -replace '\.png$', '.old.png')

# Back up existing (only if .old doesn't already exist -- preserve the original)
if (-not (Test-Path $oldPng) -and (Test-Path $targetPng)) { Rename-Item $targetPng $oldPng -Force }
if (Test-Path $targetPng) { Remove-Item $targetPng -Force }

$src     = [System.Drawing.Image]::FromFile($rawPng.FullName)
$rect    = [System.Drawing.Rectangle]::new($crop.x, $crop.y, $crop.width, $crop.height)
$cropped = $src.Clone($rect, $src.PixelFormat)
$cropped.Save($targetPng)
$src.Dispose()
$cropped.Dispose()
Copy-AdditionalOutputs $targetPng

Write-Host "`n=== Done: $Name ===" -ForegroundColor Green
Write-Host "  New:  $targetPng"
Write-Host "  Old:  $oldPng"
Write-Host "  Crop: x=$($crop.x) y=$($crop.y) w=$($crop.width) h=$($crop.height)"
