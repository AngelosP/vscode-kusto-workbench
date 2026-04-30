Feature: Kusto autocomplete schema contexts

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Kusto suggestions are correct across table, pipe, column, and function contexts
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.waitForCompletionTargets(25000)" in the webview
    Then I take a screenshot "01-schema-ready"

    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('kusto', false)" in the webview

    When I evaluate "window.__e2e.kusto.setCompletionContext('table-prefix')" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionLatency('table-prefix', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionVisible('table-prefix')" in the webview
    When I evaluate "window.__e2e.kusto.acceptSuggestion('table-prefix')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.assertAcceptedCompletion('table-prefix')" in the webview
    Then I take a screenshot "02-table-accepted"

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.setCompletionContext('pipe-operators')" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionLatency('pipe-operators', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionVisible('pipe-operators')" in the webview

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.setCompletionContext('project-columns')" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionLatency('project-columns', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionVisible('project-columns')" in the webview
    When I evaluate "window.__e2e.kusto.acceptSuggestion('project-columns')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.assertAcceptedCompletion('project-columns')" in the webview

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.setCompletionContext('where-columns')" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionLatency('where-columns', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionVisible('where-columns')" in the webview

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.setCompletionContext('summarize-functions')" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionLatency('summarize-functions', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionVisible('summarize-functions')" in the webview

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.setCompletionContext('extend-functions')" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionLatency('extend-functions', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionVisible('extend-functions')" in the webview

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.setCompletionContext('valid-query')" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.kusto.assertMarkers('none', '', 'error')" in the webview
    Then I take a screenshot "03-valid-query-no-errors"

    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('kusto', true)" in the webview
    When I execute command "workbench.action.closeAllEditors"
