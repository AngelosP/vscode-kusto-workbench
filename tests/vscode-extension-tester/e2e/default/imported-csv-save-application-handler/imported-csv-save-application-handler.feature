Feature: Imported CSV save application handler

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1000x700
    When I execute command "workbench.action.closeSidebar"
    When I execute command "workbench.action.closeAuxiliaryBar"
    When I execute command "workbench.action.closePanel"

  Scenario: Imported URL CSV writes exact UTF-8 bytes through the native picker
    When I delete file "${TEMP}\kusto-workbench-imported-hst4.csv"
    When I execute command "kusto.openQueryEditor"
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "(async () => { const deadline = performance.now() + 15000; while (performance.now() < deadline) { const container = document.getElementById('queries-container'); if (document.body.dataset.kustoDocumentLoading !== 'true' && container?.getAttribute('aria-busy') !== 'true') return 'notebook ready'; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Notebook document loading did not settle'); })()" in the webview for 20 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I evaluate "(async () => { const id = window.addUrlBox({ id: 'url_hst4_imported_csv', name: 'HST-4 imported CSV', url: 'https://example.invalid/hst4.csv', expanded: true, outputHeightPx: 260 }); const deadline = performance.now() + 10000; let section; while (performance.now() < deadline) { section = document.getElementById(id); if (section?.isConnected) break; await new Promise(resolve => setTimeout(resolve, 100)); } if (!section) throw new Error('Imported CSV section was not created'); await section.updateComplete; const url = 'https://example.invalid/hst4.csv'; const requestId = 'hst4-local-import'; const csvBody = 'Name,City' + String.fromCharCode(10) + 'Jos\u00e9,\u6771\u4eac' + String.fromCharCode(10) + 'Zo\u00eb,M\u00fcnchen'; section._activeFetchRequest = { requestId, url }; section._fetchState = { ...section._fetchState, url, expanded: true, loading: true, loaded: false, error: '' }; window.dispatchEvent(new MessageEvent('message', { data: { type: 'urlContent', boxId: id, requestId, requestedUrl: url, url, kind: 'csv', contentType: 'text/csv', status: 200, body: csvBody, truncated: false, byteLength: new TextEncoder().encode(csvBody).byteLength } })); await section.updateComplete; await section.updateComplete; const table = section.shadowRoot?.querySelector('kw-data-table'); if (!table) throw new Error('Imported CSV table did not render'); await table.updateComplete; return { id, rows: table.rows, saveVisible: !!table.shadowRoot?.querySelector('[data-testid=data-table-save]') }; })()" in the webview for 15 seconds
    Then element "[data-testid='data-table-save']" should exist
    When I click "[data-testid='data-table-save']" in the webview
    And I wait 3 seconds
    And I save the file as "${TEMP}\kusto-workbench-imported-hst4"
    And I wait 2 seconds
    Then I collect JSON artifact "hst4-imported-csv-bytes" from extension host expression "(async () => { const base = String(process.env.TEMP || process.env.TMP || ''); const uri = vscode.Uri.joinPath(vscode.Uri.file(base), 'kusto-workbench-imported-hst4.csv'); const bytes = await vscode.workspace.fs.readFile(uri); const text = new TextDecoder().decode(bytes); const newline = String.fromCharCode(10); const expected = 'Name,City' + newline + 'Jos\u00e9,\u6771\u4eac' + newline + 'Zo\u00eb,M\u00fcnchen'; if (text !== expected) throw new Error('Imported CSV bytes differ: ' + JSON.stringify({ expected, actual: text })); return { text, byteLength: bytes.byteLength, uri: uri.toString() }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 400, 600
    Then I take a screenshot "hst4-imported-csv-saved"
    When I execute command "workbench.action.closeAllEditors"
    When I delete file "${TEMP}\kusto-workbench-imported-hst4.csv"