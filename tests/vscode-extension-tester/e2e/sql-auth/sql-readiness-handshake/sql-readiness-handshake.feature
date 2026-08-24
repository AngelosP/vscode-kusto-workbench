Feature: SQL section readiness handshake

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Database discovery enables Run and STS autocomplete
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 1050
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 20 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds
    Then I collect JSON artifact "sql-readiness-before-database" from webview expression "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('SQL section unavailable'); const run = document.getElementById(el.boxId + '_sql_run_btn'); const state = { boxId: el.boxId || null, instanceId: el.sqlSession?.instanceId || null, targetGeneration: el.sqlSession?.targetGeneration ?? null, databaseRequestId: el.sqlSession?.databaseRequestId || null, connectionId: el.getSqlConnectionId?.() || null, database: el.getDatabase?.() || null, databases: Array.isArray(el._databases) ? el._databases : [], databasesLoading: el.dataset.testDatabasesLoading || null, hasDatabases: el.dataset.testHasDatabases || null, stsReady: el.dataset.testStsReady || null, stsConnectPending: !!el.sqlSession?.stsConnectPending, stsConnectTarget: el.sqlSession?.stsConnectTarget || null, ownerTokenPresent: !!el.getCopilotOwnerToken?.(), runDisabled: run ? !!run.disabled : null, runTitle: run?.title || null, lastError: el._lastError || null }; if (state.stsReady === 'true' || state.ownerTokenPresent) throw new Error('SQL owner became ready before tool preflight: ' + JSON.stringify(state)); return state; })()"
    Then I collect JSON artifact "sql-schema-tool-owner-readiness" from extension host expression "(async () => { const options = input => ({ toolInvocationToken: undefined, input }); const resultText = result => String(result.content.find(part => typeof part?.value === 'string')?.value || ''); const sectionsText = resultText(await vscode.lm.invokeTool('kusto-workbench_list-sections', options({}))); if (!sectionsText || sectionsText.startsWith('Error:')) throw new Error('Could not list sections: ' + sectionsText); const sections = JSON.parse(sectionsText); const section = sections.sections.find(candidate => candidate.type === 'sql'); if (!section?.id) throw new Error('No SQL section was listed: ' + sectionsText); const startedAt = Date.now(); const schemaText = resultText(await vscode.lm.invokeTool('kusto-workbench_get-sql-schema', options({ sectionId: section.id }))); if (!schemaText || schemaText.startsWith('Error:')) throw new Error('SQL schema tool failed during owner readiness: ' + schemaText); const schemaResult = JSON.parse(schemaText); if (schemaResult.success !== true || !schemaResult.schema) throw new Error('SQL schema tool returned no schema: ' + schemaText); return { sectionId: section.id, elapsedMs: Date.now() - startedAt, success: schemaResult.success, schemaPresent: !!schemaResult.schema }; })()"
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds
    When I evaluate "window.__e2e.sql.assertRunEnabled()" in the webview
    When I click at 400, 300
    Then I take a screenshot "01-run-ready"
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT  FROM SalesLT.Product', 1, 8)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.sql.waitExistingAllVisible('readiness completion', 'ProductID,Name', 10000)" in the webview for 15 seconds
    Then I take a screenshot "02-autocomplete-ready"
    When I execute command "workbench.action.closeAllEditors"