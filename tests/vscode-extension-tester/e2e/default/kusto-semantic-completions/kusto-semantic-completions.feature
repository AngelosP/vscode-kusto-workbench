Feature: Kusto semantic autocomplete with deterministic schemas

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Fully qualified function body suggests remote Span columns at all expression positions
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
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

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-v-bizops-timestamp')" in the webview
    Then I take a screenshot "08-workflow-v-bizops-timestamp-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-v-bizops-event-name')" in the webview
    Then I take a screenshot "09-workflow-v-bizops-event-name-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-basequery-kind')" in the webview
    Then I take a screenshot "10-workflow-basequery-kind-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-summarize-trace-id')" in the webview
    Then I take a screenshot "11-workflow-summarize-trace-id-suggests"

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"

  Scenario: Current-cluster v_bizops where dropdown renders TIMESTAMP column
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
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

    When I evaluate "window.__e2e.kusto.applyCurrentClusterWorkflowFixture()" in the webview
    When I evaluate "window.__e2e.kusto.setCurrentClusterWorkflowScenario()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('current cluster v_bizops rendered TIMESTAMP', 'TIMESTAMP', 12000)" in the webview
    When I evaluate "(() => { const trace = window.__e2e.kusto.compactAutocompleteTrace(); const events = trace?.events || []; const event = name => events.find(e => e.event === name); const context = event('schema-prepare-context'); const refsEvent = event('schema-prepare-refs'); if (!context || !refsEvent || !event('schema-prepare-result') || !event('suggest-triggered')) throw new Error('missing expected autocomplete trace events: ' + JSON.stringify(trace)); const detail = context.detail || {}; if (!/aoaiagents1\\.westus/i.test(String(detail.clusterUrl || '')) || String(detail.database || '').toLowerCase() !== 'prod') throw new Error('wrong trace context: ' + JSON.stringify(trace)); const refs = refsEvent.detail?.refs || []; if (refs.length) throw new Error('current cluster treated as cross-cluster: ' + JSON.stringify(trace)); return 'current cluster trace verified'; })()" in the webview
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
