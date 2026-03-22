# Scan for dead window bridges and write results to scan-dead-results.txt
$ErrorActionPreference = 'Continue'
$results = @()
$allPaths = (Get-ChildItem src/webview -Recurse -Include *.ts,*.js,*.html | Where-Object { $_.FullName -notmatch '\.d\.ts$' }).FullName

# Bridges to check: name -> defining module
$bridges = @{
    # modules/queryBoxes.ts
    '__kustoGetSectionName' = 'modules/queryBoxes.ts'
    '__kustoGetCurrentClusterUrlForBox' = 'modules/queryBoxes.ts'
    '__kustoGetCurrentDatabaseForBox' = 'modules/queryBoxes.ts'
    '__kustoFindFavorite' = 'modules/queryBoxes.ts'
    '__kustoLog' = 'modules/queryBoxes.ts'
    'fullyQualifyTablesInEditor' = 'modules/queryBoxes.ts'
    # modules/queryBoxes-execution.ts
    'setQueryExecuting' = 'modules/queryBoxes-execution.ts'
    '__kustoIsRunSelectionReady' = 'modules/queryBoxes-execution.ts'
    'acceptOptimizations' = 'modules/queryBoxes-execution.ts'
    'toggleQueryResultsVisibility' = 'modules/queryBoxes-execution.ts'
    'displayComparisonSummary' = 'modules/queryBoxes-execution.ts'
    'optimizeQueryWithCopilot' = 'modules/queryBoxes-execution.ts'
    'formatElapsed' = 'modules/queryBoxes-execution.ts'
    # modules/queryBoxes-toolbar.ts
    'updateCopilotInlineCompletionsToggleButtons' = 'modules/queryBoxes-toolbar.ts'
    'closeToolsDropdown' = 'modules/queryBoxes-toolbar.ts'
    'toggleOverflowSubmenu' = 'modules/queryBoxes-toolbar.ts'
    'closeToolbarOverflow' = 'modules/queryBoxes-toolbar.ts'
    'getRunModeLabelText' = 'modules/queryBoxes-toolbar.ts'
    'closeRunMenu' = 'modules/queryBoxes-toolbar.ts'
    # modules/extraBoxes.ts
    '__kustoGetRawCellValueForChart' = 'modules/extraBoxes.ts'
    '__kustoCellToChartString' = 'modules/extraBoxes.ts'
    '__kustoCellToChartNumber' = 'modules/extraBoxes.ts'
    '__kustoCellToChartTimeMs' = 'modules/extraBoxes.ts'
    '__kustoInferTimeXAxisFromRows' = 'modules/extraBoxes.ts'
    '__kustoNormalizeResultsColumnName' = 'modules/extraBoxes.ts'
    '__kustoSetSelectOptions' = 'modules/extraBoxes.ts'
    '__kustoPickFirstNonEmpty' = 'modules/extraBoxes.ts'
    '__kustoCleanupSectionModeResizeObserver' = 'modules/extraBoxes.ts'
    '__kustoRefreshDependentExtraBoxes' = 'modules/extraBoxes.ts'
    'onPythonResult' = 'modules/extraBoxes.ts'
    'onPythonError' = 'modules/extraBoxes.ts'
    # modules/extraBoxes-chart.ts
    '__kustoGetChartState' = 'modules/extraBoxes-chart.ts'
    '__kustoUpdateChartBuilderUI' = 'modules/extraBoxes-chart.ts'
    # core/results-state.ts
    'displayResultForBox' = 'core/results-state.ts'
    'displayResult' = 'core/results-state.ts'
    'displayCancelled' = 'core/results-state.ts'
    # core/persistence.ts
    'handleDocumentDataMessage' = 'core/persistence.ts'
    '__kustoOnQueryResult' = 'core/persistence.ts'
    '__kustoSetCompatibilityMode' = 'core/persistence.ts'
    '__kustoApplyDocumentCapabilities' = 'core/persistence.ts'
    '__kustoGetWrapperHeightPx' = 'core/persistence.ts'
}

$webviewRoot = (Resolve-Path 'src/webview').Path

foreach ($name in $bridges.Keys | Sort-Object) {
    $defFile = $bridges[$name]
    $extConsumers = @()
    foreach ($fp in $allPaths) {
        $relPath = $fp.Substring($webviewRoot.Length + 1).Replace('\\', '/')
        if ($relPath -eq $defFile) { continue }
        if ((Get-Content $fp -Raw).Contains($name)) { $extConsumers += $relPath }
    }
    if ($extConsumers.Count -eq 0) {
        $results += "DEAD: $name ($defFile)"
    } else {
        $results += "ALIVE: $name ($defFile) -> $($extConsumers -join ', ')"
    }
}

$results | Out-File -FilePath scan-dead-results.txt -Encoding utf8
Write-Host "Done. $($results.Count) bridges checked."
