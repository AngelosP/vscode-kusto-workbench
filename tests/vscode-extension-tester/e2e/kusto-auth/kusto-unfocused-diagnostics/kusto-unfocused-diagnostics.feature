Feature: Kusto diagnostics require focus and authoritative schema readiness

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 800

  Scenario: A restored unfocused section never shows transient red squiggles
    Given a file "tests/vscode-extension-tester/runs/kusto-auth/kusto-unfocused-diagnostics/unfocused-diagnostics.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"query_diagnostic_anchor","type":"query","name":"Focused anchor","query":"print Healthy = 1","expanded":true,"clusterUrl":"https://1es.kusto.windows.net","database":"Liquid"},{"id":"query_unfocused_diagnostic","type":"query","name":"Unfocused diagnostic","query":"DefinitelyMissingTableForFocusGate\n| take 1","expanded":true,"clusterUrl":"https://1es.kusto.windows.net","database":"Liquid"}]}}
      """
    And I wait 1 second
    When I open file "tests/vscode-extension-tester/runs/kusto-auth/kusto-unfocused-diagnostics/unfocused-diagnostics.kqlx" in the editor
    When I wait for "#query_diagnostic_anchor[data-test-connection='true'][data-test-database-selected='true']" in the webview "unfocused-diagnostics.kqlx" for 20 seconds
    When I wait for "#query_unfocused_diagnostic[data-test-connection='true'][data-test-database-selected='true']" in the webview "unfocused-diagnostics.kqlx" for 20 seconds
    When I wait for "#query_unfocused_diagnostic .monaco-editor" in the webview "unfocused-diagnostics.kqlx" for 20 seconds
    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/kusto-auth/kusto-unfocused-diagnostics/unfocused-diagnostics.kqlx" in the editor
    When I wait for "#query_unfocused_diagnostic .monaco-editor" in the webview "unfocused-diagnostics.kqlx" for 20 seconds
    When I evaluate "(() => { if (!window.__e2e?.kusto || !window.queryEditors?.query_diagnostic_anchor || !window.queryEditors?.query_unfocused_diagnostic || typeof monaco === 'undefined') throw new Error('Kusto editor context unavailable'); clearInterval(window.__diagnosticOwnershipTraceTimer); document.querySelectorAll('[data-testid^=e2e-proof-diagnostic-ownership]').forEach(element => element.remove()); const history = []; const quietPeriodMs = 1500; const maxDurationMs = 40000; const startedAt = Date.now(); let previous = ''; let completed = false; let returnedAt = 0; const section = (entry, boxId) => entry.sections.find(item => item.boxId === boxId); const publish = (valid, summary) => { if (completed) return; completed = true; clearInterval(window.__diagnosticOwnershipTraceTimer); const proof = document.createElement('div'); proof.dataset.testid = valid ? 'e2e-proof-diagnostic-ownership' : 'e2e-proof-diagnostic-ownership-failure'; proof.style.display = 'none'; proof.textContent = JSON.stringify({ valid, ...summary }); document.body.appendChild(proof); }; const snapshot = () => { const activeBoxId = window.activeQueryEditorBoxId || ''; const sections = ['query_diagnostic_anchor', 'query_unfocused_diagnostic'].map(boxId => { const editor = window.queryEditors[boxId]; const model = editor?.getModel?.(); const errors = model?.uri ? monaco.editor.getModelMarkers({ owner: 'kusto', resource: model.uri }).filter(marker => marker.severity === monaco.MarkerSeverity.Error) : []; const sectionElement = document.getElementById(boxId); return { boxId, focused: editor?.hasTextFocus?.() === true || editor?.hasWidgetFocus?.() === true, preparation: sectionElement?.dataset?.testPreparationState || '', errors: errors.map(marker => ({ message: marker.message, code: marker.code || null })) }; }); const state = { activeBoxId, sections }; const serialized = JSON.stringify(state); if (serialized !== previous) { history.push({ at: Date.now(), ...state }); previous = serialized; } const anchorOwnedIndex = history.findIndex(entry => entry.activeBoxId === 'query_diagnostic_anchor' && section(entry, 'query_diagnostic_anchor')?.focused); const diagnosticOwnedIndex = history.findIndex((entry, index) => index > anchorOwnedIndex && entry.activeBoxId === 'query_unfocused_diagnostic' && section(entry, 'query_unfocused_diagnostic')?.focused); const focusedErrorIndex = history.findIndex((entry, index) => index >= diagnosticOwnedIndex && entry.activeBoxId === 'query_unfocused_diagnostic' && section(entry, 'query_unfocused_diagnostic')?.focused && section(entry, 'query_unfocused_diagnostic')?.preparation === 'ready' && section(entry, 'query_unfocused_diagnostic')?.errors.some(error => error.message.includes('DefinitelyMissingTableForFocusGate'))); const returnedAnchorIndex = focusedErrorIndex >= 0 ? history.findIndex((entry, index) => index > focusedErrorIndex && entry.activeBoxId === 'query_diagnostic_anchor' && section(entry, 'query_diagnostic_anchor')?.focused && section(entry, 'query_unfocused_diagnostic')?.errors.length === 0) : -1; const leaks = history.filter(entry => { const diagnostic = section(entry, 'query_unfocused_diagnostic'); return diagnostic?.errors.length && (entry.activeBoxId !== 'query_unfocused_diagnostic' || !diagnostic.focused || diagnostic.preparation !== 'ready'); }); if (returnedAnchorIndex >= 0 && !returnedAt) returnedAt = Date.now(); const summary = { anchorOwnedIndex, diagnosticOwnedIndex, focusedErrorIndex, returnedAnchorIndex, quietPeriodMs, maxDurationMs, leakCount: leaks.length, leaks, history }; if (leaks.length) publish(false, summary); else if (focusedErrorIndex >= 0 && returnedAnchorIndex >= 0 && Date.now() - returnedAt >= quietPeriodMs) publish(anchorOwnedIndex >= 0 && diagnosticOwnedIndex >= 0, summary); else if (Date.now() - startedAt >= maxDurationMs) publish(false, summary); }; snapshot(); window.__diagnosticOwnershipTraceTimer = setInterval(snapshot, 50); return 'diagnostic ownership trace armed'; })()" in the webview "unfocused-diagnostics.kqlx"
    When I evaluate "window.__e2e.kusto.waitForCompletionTargets(25000)" in the webview "unfocused-diagnostics.kqlx" for 28 seconds
    Then I evaluate "window.__testAssertMonacoMarkers('#query_unfocused_diagnostic .query-editor', 'none', 'kusto', 'error')" in the webview "unfocused-diagnostics.kqlx"

    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 400, 300
    And I wait 8 seconds
    When I click at 400, 730
    And I wait 15 seconds
    When I click at 400, 300
    And I wait 2 seconds

    When I wait for "[data-testid='e2e-proof-diagnostic-ownership'], [data-testid='e2e-proof-diagnostic-ownership-failure']" in the webview "unfocused-diagnostics.kqlx" for 20 seconds
    Then I collect JSON artifact "diagnostic-ownership-trace" from webview expression "(() => { const proof = document.querySelector('[data-testid=e2e-proof-diagnostic-ownership], [data-testid=e2e-proof-diagnostic-ownership-failure]'); return proof ? JSON.parse(proof.textContent) : null; })()"
    When I wait for "[data-testid='e2e-proof-diagnostic-ownership']" in the webview "unfocused-diagnostics.kqlx" for 5 seconds
    Then I take a screenshot "unfocused-diagnostic-cleared"
    When I execute command "workbench.action.closeAllEditors"
