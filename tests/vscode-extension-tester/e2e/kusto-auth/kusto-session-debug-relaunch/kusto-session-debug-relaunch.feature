Feature: Session results survive an Extension Host restart

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1100x900
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"

  Scenario: Durable Kusto results return when session.kqlx reopens after window reload
    When I execute command "kustoWorkbench.test.closeQueryEditorSession"
    When I execute command "kustoWorkbench.test.preparePersistedResultFixture" with args '[{"engine":"kusto","templatePath":"tests/vscode-extension-tester/e2e/default/persisted-results-restore/fixtures/persisted-results.kqlx","sessionFile":true,"existingClusterIncludes":"1es.kusto.windows.net","database":"Liquid","includeChart":true}]'
    And I execute command "kusto.openQueryEditor"
    When I wait for "#query_persisted_results" in the webview "session.kqlx" for 20 seconds
    When I evaluate "window.schedulePersist?.('e2e-chart-startup-neighbor', true)" in the webview "session.kqlx"
    When I evaluate "window.__e2e.workbench.waitForPersistedResult('query_persisted_results', 24000)" in the webview "session.kqlx" for 28 seconds
    When I wait for "#chart_persisted_results" in the webview "session.kqlx" for 20 seconds
    Then I collect JSON artifact "before-reload-durable-session" from extension host expression "(async () => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith('/session.kqlx')); if (!document) throw new Error('Session fixture document is unavailable'); const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri)); const file = JSON.parse(text); const section = file.state.sections.find(candidate => candidate.id === 'query_persisted_results'); const result = section?.resultJson ? JSON.parse(section.resultJson) : undefined; if (Number(raw(result?.rows?.[0]?.[0])) !== 1 || raw(result.rows[0][1]) !== 'persist_row_01') throw new Error('session.kqlx lost its fixture result before reload'); return { bytes: new TextEncoder().encode(text).byteLength, row: result.rows[0].map(raw), hasChart: file.state.sections.some(candidate => candidate.id === 'chart_persisted_results') }; })()"

    When I start command "workbench.action.reloadWindow"
    And I wait 8 seconds
    When I wait for "#query_persisted_results" in the webview "session.kqlx" for 30 seconds
    When I evaluate "(async () => { const deadline = Date.now() + 24000; while (Date.now() < deadline) { const section = document.getElementById('query_persisted_results'); const table = section?.querySelector('kw-data-table'); if (section?.dataset?.testHasResults === 'true' && table?.rows?.length === 12) return 'persisted result restored after reload'; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for persisted result after reload'); })()" in the webview "session.kqlx" for 28 seconds
    Then I collect JSON artifact "reopened-session-result" from webview expression "(async () => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const deadline = Date.now() + 12000; while (Date.now() < deadline) { const section = document.getElementById('query_persisted_results'); const table = section?.querySelector('kw-data-table'); const columns = (table?.columns || []).map(column => typeof column === 'string' ? column : column.name); const row = table?.rows?.[0] || []; if (Number(raw(row[columns.indexOf('RowId')])) === 1 && raw(row[columns.indexOf('Label')]) === 'persist_row_01') return { columns, row: row.map(raw), artifactId: table.resultArtifactId }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Reopened session result did not stabilize'); })()"
    When I evaluate "(async () => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { const chart = document.getElementById('chart_persisted_results'); const state = chart?.createDocumentState?.() || chart?.serialize?.(); const dataset = chart?.getDatasets?.().find(candidate => candidate.id === 'query_persisted_results' && Number(candidate.resultIndex || 0) === 0); if (state?.dataSourceId === 'query_persisted_results' && dataset?.rows?.length === 12) return 'reopened Chart restored its dataset'; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for reopened Chart dataset'); })()" in the webview "session.kqlx" for 24 seconds
    Then I collect JSON artifact "reopened-session-chart" from webview expression "(async () => { const deadline = Date.now() + 12000; while (Date.now() < deadline) { const chart = document.getElementById('chart_persisted_results'); const state = chart?.createDocumentState?.() || chart?.serialize?.(); const dataset = chart?.getDatasets?.().find(candidate => candidate.id === 'query_persisted_results' && Number(candidate.resultIndex || 0) === 0); if (state?.dataSourceId === 'query_persisted_results' && dataset?.rows?.length === 12) return { dataSourceId: state.dataSourceId, rows: dataset.rows.length, chartType: state.chartType }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Reopened Chart result did not stabilize'); })()"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "01-session-result-after-reload"
