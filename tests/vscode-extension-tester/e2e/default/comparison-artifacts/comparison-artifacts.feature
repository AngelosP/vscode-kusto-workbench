Feature: Exact comparison artifact lineage

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Comparison summary remains bound to source A after source current advances
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.comparison.assertExactArtifactLineage()" in the webview for 20 seconds