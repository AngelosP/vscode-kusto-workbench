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

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-function-timestamp')" in the webview
    Then I take a screenshot "08-workflow-function-timestamp-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-function-event-name')" in the webview
    Then I take a screenshot "09-workflow-function-event-name-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-basequery-kind')" in the webview
    Then I take a screenshot "10-workflow-basequery-kind-suggests"

    When I evaluate "window.__e2e.kusto.assertSemanticScenario('workflow-summarize-trace-id')" in the webview
    Then I take a screenshot "11-workflow-summarize-trace-id-suggests"

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"

  Scenario: Current-cluster synthetic function where dropdown renders TIMESTAMP column
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
    When I evaluate "window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('current cluster synthetic function rendered TIMESTAMP', 'TIMESTAMP', 12000)" in the webview
    When I evaluate "(() => { const trace = window.__e2e.kusto.compactAutocompleteTrace(); const events = trace?.events || []; const event = name => events.find(e => e.event === name); const context = event('schema-prepare-context'); const refsEvent = event('schema-prepare-refs'); if (!context || !refsEvent || !event('schema-prepare-result') || !event('suggest-triggered')) throw new Error('missing expected autocomplete trace events: ' + JSON.stringify(trace)); const detail = context.detail || {}; if (!/semantic-current\.westus/i.test(String(detail.clusterUrl || '')) || String(detail.database || '') !== 'TelemetryDb') throw new Error('wrong trace context: ' + JSON.stringify(trace)); const refs = refsEvent.detail?.refs || []; if (refs.length) throw new Error('current cluster treated as cross-cluster: ' + JSON.stringify(trace)); return 'current cluster trace verified'; })()" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('let Seed = print x = 1;\ncluster(\'semantic-current.westus\').database(\'TelemetryDb\').v_autocomplete_events()\n| where ⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertFirstRenderedColumnsAfterRawCtrlSpace('kw-query-section .query-editor', 'multi-statement current synthetic function rendered columns', 'TIMESTAMP,EventName,Kind', 12000)" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('cluster(\'semantic-current.westus\').database(\'TelemetryDb\').v_autocomplete_events()\n| summarize count()\n| where ⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertFirstRenderedColumnsAfterRawCtrlSpace('kw-query-section .query-editor', 'summarize count rendered Count', 'Count', 12000)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertRenderedSnapshotsExcludeColumns('summarize count excludes raw source columns', 'TIMESTAMP,EventName,Kind', 1500, 100)" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('cluster(\'semantic-current.westus\').database(\'TelemetryDb\').v_autocomplete_events()\n| take ⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertRawCtrlSpaceDoesNotRenderColumns('kw-query-section .query-editor', 'take excludes raw source columns', 'TIMESTAMP,EventName,Kind', 1000, 100)" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('cluster(\'semantic-current.westus\').database(\'TelemetryDb\').v_autocomplete_events()\n| top 10 ⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertRawCtrlSpaceDoesNotRenderColumns('kw-query-section .query-editor', 'top before by excludes raw source columns', 'TIMESTAMP,EventName,Kind', 1000, 100)" in the webview
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
