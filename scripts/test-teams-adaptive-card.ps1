<#
.SYNOPSIS
    Generates an Adaptive Card preview of a .kqlx notebook and opens it in the
    Adaptive Cards Designer to see exactly how it would look in Teams.

.DESCRIPTION
    Temporary test script. Reads a .kqlx file, builds an Adaptive Card JSON,
    saves it, copies it to your clipboard, and opens the Adaptive Cards Designer.

    No authentication or app registration needed.

.PARAMETER KqlxFile
    Path to the .kqlx file to preview.

.EXAMPLE
    .\scripts\test-teams-adaptive-card.ps1 -KqlxFile "C:\Users\angelpe\OneDrive - Microsoft\Documents\Azure DevEx\Kusto Workbench\azd-12yr-executive-audit.kqlx"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$KqlxFile
)

$ErrorActionPreference = 'Stop'

# ---- Validate input ----

if (-not (Test-Path $KqlxFile)) {
    Write-Error "File not found: $KqlxFile"
    exit 1
}

$fileName = [System.IO.Path]::GetFileName($KqlxFile)
if (-not $fileName.EndsWith('.kqlx', [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Error "Expected a .kqlx file, got: $fileName"
    exit 1
}

# ---- Parse .kqlx ----

Write-Host "`n📄 Reading $fileName ..." -ForegroundColor Cyan
$raw = Get-Content -Path $KqlxFile -Raw -Encoding UTF8
$kqlx = $raw | ConvertFrom-Json

$sections = @()
if ($kqlx.state -and $kqlx.state.sections) {
    $sections = $kqlx.state.sections
} elseif ($kqlx.sections) {
    $sections = $kqlx.sections
} else {
    Write-Error "Could not find sections in the .kqlx file. Unexpected format."
    exit 1
}

Write-Host "   Found $($sections.Count) sections" -ForegroundColor Gray

# ---- Build summary ----

$querySections = @($sections | Where-Object { $_.type -eq 'query' -or $_.type -eq 'copilotQuery' })
$markdownSections = @($sections | Where-Object { $_.type -eq 'markdown' })
$chartSections = @($sections | Where-Object { $_.type -eq 'chart' })
$transformSections = @($sections | Where-Object { $_.type -eq 'transformation' })

$summaryParts = @()
if ($querySections.Count -gt 0) {
    $summaryParts += "$($querySections.Count) 🔍"
}
if ($markdownSections.Count -gt 0) {
    $summaryParts += "$($markdownSections.Count) 📝"
}
if ($chartSections.Count -gt 0) {
    $summaryParts += "$($chartSections.Count) 📊"
}
if ($transformSections.Count -gt 0) {
    $summaryParts += "$($transformSections.Count) 🔄"
}

$pythonSections = @($sections | Where-Object { $_.type -eq 'python' })
if ($pythonSections.Count -gt 0) {
    $summaryParts += "$($pythonSections.Count) 🐍"
}
$urlSections = @($sections | Where-Object { $_.type -eq 'url' })
if ($urlSections.Count -gt 0) {
    $summaryParts += "$($urlSections.Count) 🌐"
}
$summaryLine = $summaryParts -join '  '
if (-not $summaryLine) { $summaryLine = 'Empty notebook' }

# ---- Extract cluster info ----

$clusterInfo = $null
foreach ($s in $querySections) {
    if ($s.clusterUrl) {
        $short = $s.clusterUrl -replace '^https?://', '' -replace '\.kusto\.windows\.net/?$', ''
        $db = if ($s.database) { " → $($s.database)" } else { "" }
        $clusterInfo = "$short$db"
        break
    }
}

# ---- Build Adaptive Card body ----

$displayName = ($fileName -replace '\.kqlx$', '') -replace '[-_]', ' '

$body = @(
    # Header
    @{
        type = 'ColumnSet'
        columns = @(
            @{
                type = 'Column'
                width = 'auto'
                items = @(
                    @{
                        type = 'Image'
                        url = 'https://github.com/AngelosP/vscode-kusto-workbench/raw/HEAD/media/images/kusto-workbench-logo.png'
                        size = 'Small'
                        width = '36px'
                        height = '36px'
                    }
                )
                verticalContentAlignment = 'Center'
            },
            @{
                type = 'Column'
                width = 'stretch'
                items = @(
                    @{
                        type = 'TextBlock'
                        text = $displayName
                        weight = 'Bolder'
                        size = 'Medium'
                        wrap = $true
                    },
                    @{
                        type = 'TextBlock'
                        text = $summaryLine
                        spacing = 'None'
                        isSubtle = $true
                        size = 'Small'
                    }
                )
            }
        )
    }
)

# Full-width button using a Column that stretches
$body += @{
    type = 'ColumnSet'
    spacing = 'Medium'
    columns = @(
        @{
            type = 'Column'
            width = 'stretch'
            items = @(
                @{
                    type = 'ActionSet'
                    actions = @(
                        @{
                            type = 'Action.OpenUrl'
                            title = 'Open in VS Code'
                            url = "vscode://angelpe.vscode-kusto-workbench/open?file=$([Uri]::EscapeDataString($fileName))"
                            style = 'positive'
                            iconUrl = 'https://code.visualstudio.com/favicon.ico'
                        }
                    )
                }
            )
        }
    )
}

# Marketplace link
$body += @{
    type = 'TextBlock'
    text = '[requires Kusto Workbench extension](https://marketplace.visualstudio.com/items?itemName=angelos-petropoulos.vscode-kusto-workbench)'
    size = 'Small'
    isSubtle = $true
    spacing = 'Small'
    horizontalAlignment = 'Left'
}



# ---- Assemble Adaptive Card ----

$adaptiveCard = @{
    type = 'AdaptiveCard'
    '$schema' = 'http://adaptivecards.io/schemas/adaptive-card.json'
    version = '1.5'
    body = $body
}

$cardJson = $adaptiveCard | ConvertTo-Json -Depth 20

Write-Host "`n✅ Adaptive Card generated ($([math]::Round($cardJson.Length / 1024, 1)) KB)" -ForegroundColor Green

# ---- Save, copy, and open designer ----

$outPath = Join-Path $PSScriptRoot 'adaptive-card-output.json'
$cardJson | Out-File -FilePath $outPath -Encoding UTF8
Write-Host "   Saved to: $outPath" -ForegroundColor Gray

Set-Clipboard -Value $cardJson
Write-Host "   📋 Copied to clipboard!" -ForegroundColor Green

Write-Host "`n🌐 Opening Adaptive Cards Designer..." -ForegroundColor Cyan
Start-Process 'https://adaptivecards.microsoft.com/designer/'

Write-Host ""
Write-Host "   In the designer:" -ForegroundColor Yellow
Write-Host "   1. Set 'Select host app' to 'Microsoft Teams' (top-left dropdown)" -ForegroundColor Yellow  
Write-Host "   2. Click the 'Card Payload Editor' tab at the bottom" -ForegroundColor Yellow
Write-Host "   3. Select all (Ctrl+A) and paste (Ctrl+V)" -ForegroundColor Yellow
Write-Host "   4. The card preview appears in the center panel" -ForegroundColor Yellow
Write-Host ""
Write-Host "   You'll see exactly how it renders in Teams — light and dark theme." -ForegroundColor Gray
Write-Host ""
