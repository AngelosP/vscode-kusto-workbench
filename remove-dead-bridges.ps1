# D7: Remove dead bridge assignments
$ErrorActionPreference = 'Continue'

$removals = @{
    'modules/queryBoxes.ts' = @('__kustoGetSectionName','__kustoGetCurrentClusterUrlForBox','__kustoGetCurrentDatabaseForBox','__kustoFindFavorite','__kustoLog','fullyQualifyTablesInEditor')
    'modules/queryBoxes-execution.ts' = @('setQueryExecuting','__kustoIsRunSelectionReady','acceptOptimizations','toggleQueryResultsVisibility','displayComparisonSummary','optimizeQueryWithCopilot','formatElapsed')
    'modules/queryBoxes-toolbar.ts' = @('updateCopilotInlineCompletionsToggleButtons','closeToolsDropdown','toggleOverflowSubmenu','closeToolbarOverflow','getRunModeLabelText','closeRunMenu')
    'modules/extraBoxes.ts' = @('__kustoGetRawCellValueForChart','__kustoCellToChartString','__kustoCellToChartNumber','__kustoCellToChartTimeMs','__kustoInferTimeXAxisFromRows','__kustoNormalizeResultsColumnName','__kustoSetSelectOptions','__kustoPickFirstNonEmpty','__kustoCleanupSectionModeResizeObserver','__kustoRefreshDependentExtraBoxes','onPythonResult','onPythonError')
    'modules/extraBoxes-chart.ts' = @('__kustoGetChartState','__kustoUpdateChartBuilderUI')
    'core/results-state.ts' = @('displayResultForBox','displayResult','displayCancelled')
    'core/persistence.ts' = @('handleDocumentDataMessage','__kustoOnQueryResult','__kustoSetCompatibilityMode','__kustoApplyDocumentCapabilities','__kustoGetWrapperHeightPx')
}

$totalRemoved = 0
foreach ($file in $removals.Keys) {
    $path = "src/webview/$file"
    $content = [System.IO.File]::ReadAllText((Resolve-Path $path).Path)
    $originalLen = $content.Length
    
    foreach ($name in $removals[$file]) {
        # Pattern 1: window.name = funcRef;\n
        $pattern1 = "window.$name = $name;`n"
        if ($content.Contains($pattern1)) {
            $content = $content.Replace($pattern1, '')
            $totalRemoved++
            continue
        }
        # Pattern 2: window.name = funcRef;\r\n  
        $pattern2 = "window.$name = $name;`r`n"
        if ($content.Contains($pattern2)) {
            $content = $content.Replace($pattern2, '')
            $totalRemoved++
            continue
        }
        # Pattern 3: with leading tab
        $pattern3 = "`twindow.$name = $name;`n"
        if ($content.Contains($pattern3)) {
            $content = $content.Replace($pattern3, '')
            $totalRemoved++
            continue
        }
        Write-Host "NOT FOUND: $name in $file"
    }
    
    if ($content.Length -ne $originalLen) {
        [System.IO.File]::WriteAllText((Resolve-Path $path).Path, $content)
        $diff = $originalLen - $content.Length
        Write-Host "$file : removed $diff chars"
    }
}

Write-Host "Total bridges removed: $totalRemoved"
