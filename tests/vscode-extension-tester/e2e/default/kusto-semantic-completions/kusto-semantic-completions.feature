Feature: Kusto semantic autocomplete with deterministic schemas

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Fully qualified function body suggests remote Span columns at all expression positions
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 15 seconds

    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.applySemanticCompletionFixture()" in the webview
    Then I take a screenshot "01-semantic-fixture-applied"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('first-timestamp')" in the webview
    Then I take a screenshot "02-first-timestamp-suggests"
    When I evaluate "window.__e2e.kusto.assertSemanticCrossClusterTrace()" in the webview

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('inline-and-timestamp')" in the webview
    Then I take a screenshot "03-inline-and-timestamp-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('second-where-empty')" in the webview
    Then I take a screenshot "04-second-where-empty-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('second-where-incomplete')" in the webview
    Then I take a screenshot "05-second-where-incomplete-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('bracketed-agent-column')" in the webview
    Then I take a screenshot "06-bracketed-agent-column-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('summarize-by-trace-id')" in the webview
    Then I take a screenshot "07-summarize-by-column-suggests"

    When I execute command "workbench.action.closeAllEditors"
