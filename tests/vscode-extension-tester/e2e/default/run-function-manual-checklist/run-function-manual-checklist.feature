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
    Then I collect JSON artifact "run-function-dialog-drag-release" from webview expression "(async () => { const dialog = document.querySelector('kw-function-params-dialog'); if (!dialog) throw new Error('Run Function dialog is missing'); await dialog.updateComplete; const root = dialog.shadowRoot; const input = root?.querySelector('.fpd-input'); const backdrop = root?.querySelector('.sd-bg'); if (!input || !backdrop) throw new Error('Run Function dialog controls are missing'); input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 })); backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0 })); backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 0 })); await dialog.updateComplete; const stillOpen = dialog.isConnected && !!root.querySelector('.sd-bg'); if (!stillOpen) throw new Error('Run Function dialog closed after an inside press released outside'); return { stillOpen, inputValue: input.value }; })()"
    Then I take a screenshot "02-parameter-dialog-after-drag-release"
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.finishParameterizedDialog(); if (result == null) throw new Error('finishParameterizedDialog returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.fencedKql(); if (result == null) throw new Error('fencedKql returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    When I evaluate "(async () => { const result = await window.__e2e.kusto.runFunctionManual.cursorOutsideShowsNoFunction(); if (result == null) throw new Error('cursorOutsideShowsNoFunction returned null'); return result; })()" in the webview "session.kqlx" for 10 seconds
    Then I take a screenshot "03-run-function-checklist-finished"