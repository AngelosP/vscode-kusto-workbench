# Scan for dead window bridges and write results to scan-dead-results.txt
$ErrorActionPreference = 'Continue'
$results = @()
$allPaths = (Get-ChildItem src/webview -Recurse -Include *.ts,*.js,*.html | Where-Object { $_.FullName -notmatch '\.d\.ts$' }).FullName

# Bridges to check: name -> defining module
$bridges = @{
    # queryBoxes.ts
    '__kustoGetSectionName' = 'queryBoxes.ts'
    '__kustoGetCurrentClusterUrlForBox' = 'queryBoxes.ts'
    '__kustoGetCurrentDatabaseForBox' = 'queryBoxes.ts'
    '__kustoFindFavorite' = 'queryBoxes.ts'
    '__kustoLog' = 'queryBoxes.ts'
    'fullyQualifyTablesInEditor' = 'queryBoxes.ts'
    # queryBoxes-execution.ts
    'setQueryExecuting' = 'queryBoxes-execution.ts'
    '__kustoIsRunSelectionReady' = 'queryBoxes-execution.ts'
    'acceptOptimizations' = 'queryBoxes-execution.ts'
    'toggleQueryResultsVisibility' = 'queryBoxes-execution.ts'
    'displayComparisonSummary' = 'queryBoxes-execution.ts'
    'optimizeQueryWithCopilot' = 'queryBoxes-execution.ts'
    'formatElapsed' = 'queryBoxes-execution.ts'
    # queryBoxes-toolbar.ts
    'updateCopilotInlineCompletionsToggleButtons' = 'queryBoxes-toolbar.ts'
    'closeToolsDropdown' = 'queryBoxes-toolbar.ts'
    'toggleOverflowSubmenu' = 'queryBoxes-toolbar.ts'
    'closeToolbarOverflow' = 'queryBoxes-toolbar.ts'
    'getRunModeLabelText' = 'queryBoxes-toolbar.ts'
    'closeRunMenu' = 'queryBoxes-toolbar.ts'
    # extraBoxes.ts
    '__kustoGetRawCellValueForChart' = 'extraBoxes.ts'
    '__kustoCellToChartString' = 'extraBoxes.ts'
    '__kustoCellToChartNumber' = 'extraBoxes.ts'
    '__kustoCellToChartTimeMs' = 'extraBoxes.ts'
    '__kustoInferTimeXAxisFromRows' = 'extraBoxes.ts'
    '__kustoNormalizeResultsColumnName' = 'extraBoxes.ts'
    '__kustoSetSelectOptions' = 'extraBoxes.ts'
    '__kustoPickFirstNonEmpty' = 'extraBoxes.ts'
    '__kustoCleanupSectionModeResizeObserver' = 'extraBoxes.ts'
    '__kustoRefreshDependentExtraBoxes' = 'extraBoxes.ts'
    'onPythonResult' = 'extraBoxes.ts'
    'onPythonError' = 'extraBoxes.ts'
    # extraBoxes-chart.ts
    '__kustoGetChartState' = 'extraBoxes-chart.ts'
    '__kustoUpdateChartBuilderUI' = 'extraBoxes-chart.ts'
    # resultsState.ts
    'displayResultForBox' = 'resultsState.ts'
    'displayResult' = 'resultsState.ts'
    'displayCancelled' = 'resultsState.ts'
    # persistence.ts
    'handleDocumentDataMessage' = 'persistence.ts'
    '__kustoOnQueryResult' = 'persistence.ts'
    '__kustoSetCompatibilityMode' = 'persistence.ts'
    '__kustoApplyDocumentCapabilities' = 'persistence.ts'
    '__kustoGetWrapperHeightPx' = 'persistence.ts'
}

foreach ($name in $bridges.Keys | Sort-Object) {
    $defFile = $bridges[$name]
    $extConsumers = @()
    foreach ($fp in $allPaths) {
        $fname = Split-Path $fp -Leaf
        if ($fname -eq $defFile) { continue }
        if ((Get-Content $fp -Raw).Contains($name)) { $extConsumers += $fname }
    }
    if ($extConsumers.Count -eq 0) {
        $results += "DEAD: $name ($defFile)"
    } else {
        $results += "ALIVE: $name ($defFile) -> $($extConsumers -join ', ')"
    }
}

$results | Out-File -FilePath scan-dead-results.txt -Encoding utf8
Write-Host "Done. $($results.Count) bridges checked."
