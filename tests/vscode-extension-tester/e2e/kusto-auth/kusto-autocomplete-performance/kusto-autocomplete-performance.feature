Feature: Kusto autocomplete performance guard

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Repeated local Kusto suggestions stay responsive after schema load
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
    When I evaluate "window.__e2e.kusto.startCompletionTargetProbe(25000)" in the webview
    When I wait for "kw-query-section[data-test-completion-targets-ready='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.assertCompletionTargetsReady()" in the webview
    Then I take a screenshot "01-schema-ready"

    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('kusto', false)" in the webview

    When I evaluate "window.__e2e.kusto.assertRepeatedSuggestLatency('table-prefix', 5, 3000, 1500)" in the webview

    When I evaluate "window.__e2e.kusto.assertRepeatedSuggestLatency('project-columns', 5, 3000, 1500)" in the webview

    When I evaluate "window.__e2e.kusto.assertRepeatedSuggestLatency('pipe-operators', 5, 3000, 1500)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionStaysVisible('pipe-operators', 800)" in the webview
    Then I take a screenshot "02-latency-guard-visible"
    When I evaluate "window.__e2e.kusto.acceptSuggestion('pipe-operators')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.assertAcceptedCompletion('pipe-operators')" in the webview
    Then I take a screenshot "03-operator-accepted"

    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('kusto', true)" in the webview
    When I execute command "workbench.action.closeAllEditors"
