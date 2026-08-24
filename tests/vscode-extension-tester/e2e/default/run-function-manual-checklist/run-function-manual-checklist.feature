Feature: Run Function manual checklist

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 900
    And I capture the output channel "Kusto Workbench"
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"

  Scenario: Run Function handles comments, cursor targeting, CRLF, parameters, and fences
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "(async () => { await window.__e2e.workbench.clearSections(); return 'session sections cleared'; })()" in the webview "session.kqlx"
    And I wait 1 seconds
    When I wait for "button[data-add-kind='query']" in the webview "session.kqlx" for 20 seconds
    When I click "button[data-add-kind='query']" in the webview "session.kqlx"
    When I wait for "kw-query-section .monaco-editor" in the webview "session.kqlx" for 20 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.setConnected(); if (result == null) throw new Error('setConnected returned null'); return 'Run Function section connected'; })()" in the webview "session.kqlx" for 10 seconds
    Then I take a screenshot "01-run-function-section-ready"

    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.leadingComments(); if (result == null) throw new Error('leadingComments returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.cursorSecondSameLine(); if (result == null) throw new Error('cursorSecondSameLine returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.crlfSecond(); if (result == null) throw new Error('crlfSecond returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.openParameterizedDialog(); if (result == null) throw new Error('openParameterizedDialog returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    Then I take a screenshot "02-parameter-dialog-default"
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.finishParameterizedDialog(); if (result == null) throw new Error('finishParameterizedDialog returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.fencedKql(); if (result == null) throw new Error('fencedKql returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.cursorOutsideShowsNoFunction(); if (result == null) throw new Error('cursorOutsideShowsNoFunction returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    Then I take a screenshot "03-run-function-checklist-finished"