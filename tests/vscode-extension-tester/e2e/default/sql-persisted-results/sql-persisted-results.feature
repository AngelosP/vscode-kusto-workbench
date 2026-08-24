Feature: SQL persisted results restore

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Open a SQLX file with persisted results and mark them stale after editing
    When I delete file "tests/vscode-extension-tester/runs/default/sql-persisted-results/persisted-results.sqlx"
    And I wait 1 second
    When I execute command "kustoWorkbench.test.preparePersistedResultFixture" with args '[{"engine":"sql","templatePath":"tests/vscode-extension-tester/e2e/default/sql-persisted-results/fixtures/persisted-results.sqlx","outputPath":"tests/vscode-extension-tester/runs/default/sql-persisted-results/persisted-results.sqlx"}]'
    And I wait 1 second
    When I open file "tests/vscode-extension-tester/runs/default/sql-persisted-results/persisted-results.sqlx" in the editor
    And I wait 6 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I wait for "kw-sql-section[data-test-has-results='true']" in the webview for 20 seconds
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "01-restored-persisted-sql-results"

    When I evaluate "(() => { const section = document.getElementById('sql_persisted_results'); if (!section) throw new Error('Persisted SQL section not found'); const data = section.serialize(); if (!data.resultJson) throw new Error('Serialized SQL section is missing resultJson after restore'); const persisted = JSON.parse(data.resultJson); if (persisted.rows.length !== 4) throw new Error('Expected 4 persisted SQL rows, got ' + persisted.rows.length); if (persisted.metadata.clientActivityId !== 'sql-persisted-results-e2e') throw new Error('SQL metadata was not preserved'); const dt = document.getElementById('sql_persisted_results_sql_results_body')?.querySelector('kw-data-table'); if (!dt) throw new Error('Restored SQL result did not render a kw-data-table'); const cols = (dt.columns || []).map(c => c.name || c); const rows = dt.rows || []; if (rows.length !== 4) throw new Error('Rendered SQL table expected 4 rows, got ' + rows.length); if (cols.join('|') !== 'RowId|Label|Amount') throw new Error('Unexpected rendered SQL columns: ' + cols.join(',')); if (rows[0][1] !== 'sql_row_01' || rows[3][1] !== 'sql_row_04') throw new Error('Rendered SQL row labels were not restored'); const wrapper = document.getElementById('sql_persisted_results_sql_results_wrapper'); if (!wrapper || wrapper.style.display === 'none') throw new Error('SQL results wrapper is not visible'); return 'persisted SQL results restored: rows=' + rows.length; })()" in the webview

    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.setQuery(`SELECT 'changed' AS sql_persisted_results_marker`)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.assertStaleResults()" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "02-stale-overlay-after-edit"

    Then I collect JSON artifact "first-sql-fixture-closed" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/sql-persisted-results/persisted-results.sqlx'; const findTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.path?.replace(/\\/g, '/').endsWith(suffix)); let tabs = findTabs(); if (tabs.length) { const uri = tabs[0].input.uri; await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { viewColumn: vscode.ViewColumn.One, preview: false, preserveFocus: false }); await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); } const deadline = Date.now() + 10000; while (Date.now() < deadline) { tabs = findTabs(); if (tabs.length === 0) return { closed: true }; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Persisted SQL fixture remained open after exact revert-and-close'); })()"
    When I execute command "kustoWorkbench.test.cleanupPersistedResultFixture"
    When I delete file "tests/vscode-extension-tester/runs/default/sql-persisted-results/persisted-results.sqlx"

  Scenario: Recreated SQL owner preserves results through save and reopen
    When I delete file "tests/vscode-extension-tester/runs/default/sql-persisted-results/recreated-owner.sqlx"
    When I execute command "kustoWorkbench.test.preparePersistedResultFixture" with args '[{"engine":"sql","templatePath":"tests/vscode-extension-tester/e2e/default/sql-persisted-results/fixtures/persisted-results.sqlx","outputPath":"tests/vscode-extension-tester/runs/default/sql-persisted-results/recreated-owner.sqlx","recreateSqlOwner":true}]'
    When I open file "tests/vscode-extension-tester/runs/default/sql-persisted-results/recreated-owner.sqlx" in the editor
    When I wait for "kw-sql-section[data-test-has-results='true']" in the webview for 20 seconds
    When I evaluate "(() => { const section = document.getElementById('sql_persisted_results'); const data = section?.serialize?.(); const rows = document.getElementById('sql_persisted_results_sql_results_body')?.querySelector('kw-data-table')?.rows || []; if (!data?.resultJson || rows.length !== 4) throw new Error('Recreated SQL owner did not restore four persisted rows'); return 'recreated SQL owner restored rows=' + rows.length; })()" in the webview
    When I evaluate "window.__e2e.sql.assertPersistedArtifactCapabilities()" in the webview
    When I evaluate "(async () => ({ snapshotId: await window.__e2e.workbench.persistAndWait('recreated-owner-before-save') }))()" in the webview for 20 seconds
    Then I collect JSON artifact "recreated-owner-dirty-before-save" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/sql-persisted-results/recreated-owner.sqlx'; const deadline = Date.now() + 10000; while (Date.now() < deadline) { const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.path?.replace(/\\/g, '/').endsWith(suffix)); const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (tab?.isDirty && document?.isDirty) return { tabDirty: true, documentDirty: true }; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Recreated-owner snapshot was acknowledged without dirtying the owning tab and document'); })()"
    When I press "Ctrl+S"
    Then I collect JSON artifact "recreated-owner-save-settled" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/sql-persisted-results/recreated-owner.sqlx'; const deadline = Date.now() + 15000; while (Date.now() < deadline) { const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.path?.replace(/\\/g, '/').endsWith(suffix)); const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (tab && !tab.isDirty && document && !document.isDirty) { const bufferText = document.getText(); const diskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri)); if (bufferText === diskText) { const file = JSON.parse(diskText); const section = file.state?.sections?.find(candidate => candidate.type === 'sql'); const result = typeof section?.resultJson === 'string' ? JSON.parse(section.resultJson) : undefined; const connectionId = String(section?.connectionIdHint || ''); const producerConnectionId = String(section?.resultArtifact?.producer?.connectionId || ''); if (result?.rows?.length === 4 && connectionId && producerConnectionId === connectionId) return { saved: true, tabDirty: false, documentDirty: false, rowCount: result.rows.length, reboundConnectionId: connectionId }; } } await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Recreated-owner canonical result save did not settle cleanly in memory and on disk'); })()"
    When I execute command "workbench.action.closeAllEditors"
    When I open file "tests/vscode-extension-tester/runs/default/sql-persisted-results/recreated-owner.sqlx" in the editor
    When I wait for "kw-sql-section[data-test-has-results='true']" in the webview for 20 seconds
    When I evaluate "(() => { const section = document.getElementById('sql_persisted_results'); const data = section?.serialize?.(); const rows = document.getElementById('sql_persisted_results_sql_results_body')?.querySelector('kw-data-table')?.rows || []; if (!data?.resultJson || rows.length !== 4) throw new Error('Recreated SQL owner rows did not survive save and reopen'); return 'recreated SQL owner reopened rows=' + rows.length; })()" in the webview
    When I evaluate "window.__e2e.sql.assertPersistedArtifactCapabilities()" in the webview
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupPersistedResultFixture"
    When I delete file "tests/vscode-extension-tester/runs/default/sql-persisted-results/recreated-owner.sqlx"
