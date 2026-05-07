Feature: Chart regressions - live webview state and renderer options

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Tool chart titles and heatmap numeric categories survive live rendering
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.chart.assertTitleSyncAndHeatmapNumericCategories()" in the webview
    Then I take a screenshot "01-chart-regressions"