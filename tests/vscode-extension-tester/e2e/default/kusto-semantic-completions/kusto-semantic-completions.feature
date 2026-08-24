Feature: Kusto semantic autocomplete with deterministic schemas

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    And I wait 2 seconds

  Scenario: Fully qualified function body suggests remote Span columns at all expression positions
    When I execute command "kusto.openQueryEditor"
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview
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

    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('first-timestamp'); const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section?.boxId || section?.id]; const query = String(editor?.getValue?.() || ''); const marked = query.replace('| where TIMESTAMP >=', '| where TIME⟦caret⟧STAMP >='); if (!query || marked === query) throw new Error('Could not mark first TIMESTAMP scenario'); window.__e2e.kusto.setQueryWithCaretMarkerStrict(marked); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('first where TIMESTAMP mid-token', 'TIMESTAMP,TIMESTAMP_RemoteOnly', 12000); })()" in the webview for 18 seconds
    When I evaluate "window.__e2e.kusto.assertSemanticCrossClusterTrace()" in the webview
    When I evaluate "window.__e2e.kusto.markAutocompleteTraceSanitized('semantic-autocomplete-trace-sanitized', 'semantic autocomplete trace sanitization')" in the webview
    When I wait for "[data-testid='e2e-proof-semantic-autocomplete-trace-sanitized']" in the webview for 5 seconds

    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('inline-and-timestamp'); const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section?.boxId || section?.id]; const query = String(editor?.getValue?.() || ''); const marked = query.replace('and TIMESTAMP <', 'and TIME⟦caret⟧STAMP <'); if (!query || marked === query) throw new Error('Could not mark inline TIMESTAMP scenario'); window.__e2e.kusto.setQueryWithCaretMarkerStrict(marked); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('inline and TIMESTAMP mid-token', 'TIMESTAMP,TIMESTAMP_RemoteOnly', 12000); })()" in the webview for 18 seconds

    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('second-where-empty'); const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section?.boxId || section?.id]; const query = String(editor?.getValue?.() || ''); const marked = query.replace('| where )', '| where ⟦caret⟧)'); if (!query || marked === query) throw new Error('Could not mark second empty where scenario'); window.__e2e.kusto.setQueryWithCaretMarkerStrict(marked); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('second where empty predicate', 'TIMESTAMP,TIMESTAMP_RemoteOnly,EventName,ResponseId', 12000); })()" in the webview for 18 seconds

    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('second-where-incomplete'); const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section?.boxId || section?.id]; const query = String(editor?.getValue?.() || ''); const marked = query.replace('| where \n;', '| where ⟦caret⟧\n;'); if (!query || marked === query) throw new Error('Could not mark second incomplete where scenario'); window.__e2e.kusto.setQueryWithCaretMarkerStrict(marked); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('second where incomplete predicate', 'TIMESTAMP,TIMESTAMP_RemoteOnly,EventName,ResponseId', 12000); })()" in the webview for 18 seconds

    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('bracketed-agent-column'); const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section?.boxId || section?.id]; const query = String(editor?.getValue?.() || ''); const marked = query.replace('EventName ==', 'Event⟦caret⟧Name =='); if (!query || marked === query) throw new Error('Could not mark EventName scenario'); window.__e2e.kusto.setQueryWithCaretMarkerStrict(marked); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('synthetic EventName mid-token', 'EventName', 12000); })()" in the webview for 18 seconds

    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('summarize-by-trace-id'); const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section?.boxId || section?.id]; const query = String(editor?.getValue?.() || ''); const marked = query.replace('by ResponseId', 'by Response⟦caret⟧Id'); if (!query || marked === query) throw new Error('Could not mark ResponseId scenario'); window.__e2e.kusto.setQueryWithCaretMarkerStrict(marked); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('summarize by ResponseId', 'ResponseId', 12000); })()" in the webview for 18 seconds

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"

  Scenario: Current-cluster synthetic function where dropdown renders TIMESTAMP column
    When I execute command "kusto.openQueryEditor"
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview
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
    When I evaluate "(() => { const trace = window.__e2e.kusto.compactAutocompleteTrace(); const events = trace?.events || []; const event = name => events.find(e => e.event === name); const context = event('schema-prepare-context'); const refsEvent = event('schema-prepare-refs'); if (!context || !refsEvent || !event('schema-prepare-result') || !event('suggest-triggered')) throw new Error('missing expected autocomplete trace events: ' + JSON.stringify(trace)); const detail = context.detail || {}; if (!/^[a-f0-9]{8}$/.test(String(detail.clusterUrlId || '')) || !/^[a-f0-9]{8}$/.test(String(detail.databaseId || '')) || !/^[a-f0-9]{8}$/.test(String(detail.schemaKeyId || ''))) throw new Error('missing opaque trace context IDs: ' + JSON.stringify(trace)); if (Number(refsEvent.detail?.refsCount || 0) !== 0) throw new Error('current cluster treated as cross-cluster: ' + JSON.stringify(trace)); const text = JSON.stringify(trace).toLowerCase(); if (text.includes('semantic-current') || text.includes('telemetrydb')) throw new Error('trace leaked current cluster identity: ' + JSON.stringify(trace)); return 'current cluster opaque trace verified'; })()" in the webview
    When I evaluate "window.__e2e.kusto.assertAutocompleteTraceEvents('current cluster synthetic function trace', 'trigger-start,schema-prepare-context,schema-prepare-refs,schema-prepare-result,suggest-triggered', 'schema-prepare-cross-cluster-wait')" in the webview
    When I evaluate "window.__e2e.kusto.assertAutocompleteTraceSanitized('current cluster synthetic function trace sanitization')" in the webview

    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('workflow-function-timestamp'); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('workflow function TIMESTAMP mid-token', 'TIMESTAMP', 12000); })()" in the webview for 18 seconds
    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('workflow-function-event-name'); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('workflow function EventName mid-token', 'EventName', 12000); })()" in the webview for 18 seconds
    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('workflow-basequery-kind'); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('workflow baseQuery Kind mid-token', 'Kind', 12000); })()" in the webview for 18 seconds
    When I evaluate "(async () => { window.__e2e.kusto.setSemanticScenario('workflow-summarize-trace-id'); window.__e2e.suggest.kusto.hide(); await new Promise(resolve => setTimeout(resolve, 100)); await window.__e2e.suggest.kusto.trigger(); return window.__e2e.suggest.kusto.waitRenderedAllColumnsVisible('workflow summarize env_dt_traceId', 'env_dt_traceId', 12000); })()" in the webview for 18 seconds

    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('cluster(\'semantic-current.westus\').database(\'TelemetryDb\').v_autocomplete_events()\n| summarize count()\n| where ⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertRenderedSnapshotsIncludeAndExcludeColumns('summarize count renders count_ without raw source columns', 'count_', 'TIMESTAMP,EventName,Kind', 12000, 100)" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('cluster(\'semantic-current.westus\').database(\'TelemetryDb\').v_autocomplete_events()\n| take ⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.waitVisible('take offers row-count expressions', '10,100,1000', 5000)" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('cluster(\'semantic-current.westus\').database(\'TelemetryDb\').v_autocomplete_events()\n| top 10 ⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.waitVisible('top offers by before ordering columns', 'by', 5000)" in the webview
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
