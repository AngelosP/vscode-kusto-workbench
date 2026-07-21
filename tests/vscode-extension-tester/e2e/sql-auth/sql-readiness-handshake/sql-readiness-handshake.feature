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
    And I wait 10 seconds
    Then I collect JSON artifact "sql-readiness-before-database" from webview expression "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('SQL section unavailable'); const run = document.getElementById(el.boxId + '_sql_run_btn'); return { boxId: el.boxId || null, instanceId: el.sqlSession?.instanceId || null, targetGeneration: el.sqlSession?.targetGeneration ?? null, databaseRequestId: el.sqlSession?.databaseRequestId || null, connectionId: el.getSqlConnectionId?.() || null, database: el.getDatabase?.() || null, databases: Array.isArray(el._databases) ? el._databases : [], databasesLoading: el.dataset.testDatabasesLoading || null, hasDatabases: el.dataset.testHasDatabases || null, stsReady: el.dataset.testStsReady || null, stsConnectPending: !!el.sqlSession?.stsConnectPending, stsConnectTarget: el.sqlSession?.stsConnectTarget || null, ownerTokenPresent: !!el.getCopilotOwnerToken?.(), runDisabled: run ? !!run.disabled : null, runTitle: run?.title || null, lastError: el._lastError || null }; })()"
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds
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