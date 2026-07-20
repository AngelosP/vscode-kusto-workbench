Feature: Chart regressions - live webview state and renderer options

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1300 by 950
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Tool chart titles and heatmap numeric categories survive live rendering
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.chart.assertTitleSyncAndHeatmapNumericCategories()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const chart = document.getElementById('chart_e2e_heatmap_regression'); const canvas = document.getElementById('chart_e2e_heatmap_regression_chart_canvas_preview'); const state = window.chartStateByBoxId?.chart_e2e_heatmap_regression; const error = canvas?.querySelector('.error-message')?.textContent || ''; if (!chart?.isConnected || !canvas || error || !state?.__echarts?.instance) throw new Error('Unstable chart fixture: ' + JSON.stringify({ connected: !!chart?.isConnected, canvas: !!canvas, error, dataSourceId: state?.dataSourceId, canvasId: state?.__echarts?.canvasId })); return 'chart remained connected and rendered'; })()" in the webview
