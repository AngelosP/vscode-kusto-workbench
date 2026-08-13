Feature: Exact CSV result artifacts

  Background:
    Given the extension is in a clean state
  When I move the Dev Host to 0, 0
  And I resize the Dev Host to 1000 by 700
  And I execute command "workbench.action.closeSidebar"
  And I execute command "workbench.action.closeAuxiliaryBar"
  And I execute command "workbench.action.closePanel"
    And I wait 2 seconds

  Scenario: Governed results hide denied Save and export allowed bytes through the host handler
  	When I delete file "${TEMP}\kusto-workbench-exact-results.csv"
  When I execute command "kustoWorkbench.test.setNextCsvSaveTarget" with args '["kusto-workbench-exact-results.csv"]'
  	When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
  And I wait for "#queries-container" in the webview for 20 seconds
  And I evaluate "(async () => { const deadline = performance.now() + 15000; while (performance.now() < deadline) { const container = document.getElementById('queries-container'); if (document.body.dataset.kustoDocumentLoading !== 'true' && container?.getAttribute('aria-busy') !== 'true') return 'notebook ready'; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Notebook document loading did not settle'); })()" in the webview for 20 seconds
  	When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "(async () => { const id = 'query_e2e_csv_artifact'; window.addQueryBox({ id, initialQuery: `print Name='denied'`, name: 'CSV Artifact', defaultResultsVisible: true }); const section = document.getElementById(id); if (!section) throw new Error('CSV result section was not created'); await section.updateComplete; await window.__e2e.workbench.seedResult(id, { columns: [{ name: 'Name', type: 'string' }, { name: 'Score', type: 'long' }], rows: [['denied', 0]], metadata: {} }, { producer: { engine: 'kusto', boxId: id, executionId: 'csv-denied' }, policy: { exportToCsv: false } }); })()" in the webview for 20 seconds
    Then element "[data-testid='data-table-save']" should not exist

    When I evaluate "(async () => { const id = 'query_e2e_csv_artifact'; await window.__e2e.workbench.seedResult(id, { columns: [{ name: 'Name', type: 'string' }, { name: 'Score', type: 'long' }], rows: [['alpha', 1], ['bravo', 2]], metadata: {} }, { producer: { engine: 'kusto', boxId: id, executionId: 'csv-allowed' }, policy: { exportToCsv: true } }); })()" in the webview for 20 seconds
    Then element "[data-testid='data-table-save']" should exist
  	When I click at 100, 100
  	And I wait 1 second
    Then I take a screenshot "csv-save-enabled"

    When I click "[data-testid='data-table-save']" in the webview
    Then I collect JSON artifact "exact-csv-bytes" from extension host expression "(async () => { const base = String(process.env.TEMP || process.env.TMP || ''); const uri = vscode.Uri.joinPath(vscode.Uri.file(base), 'kusto-workbench-exact-results.csv'); const newline = String.fromCharCode(10); const expected = 'Name,Score' + newline + 'alpha,1' + newline + 'bravo,2'; const deadline = Date.now() + 10000; let lastError = ''; while (Date.now() < deadline) { try { const bytes = await vscode.workspace.fs.readFile(uri); const text = new TextDecoder().decode(bytes); if (text !== expected) throw new Error('CSV bytes differ: ' + JSON.stringify({ expected, actual: text })); return { text, byteLength: bytes.byteLength }; } catch (error) { lastError = String(error?.message || error); await new Promise(resolve => setTimeout(resolve, 100)); } } throw new Error('Exact CSV write did not settle: ' + lastError); })()"
  	When I click at 100, 100
  	And I wait 1 second
    Then I take a screenshot "csv-save-complete"
    When I execute command "workbench.action.closeAllEditors"
  	When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"