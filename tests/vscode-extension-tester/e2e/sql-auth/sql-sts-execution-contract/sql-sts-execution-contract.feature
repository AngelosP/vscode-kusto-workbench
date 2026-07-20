Feature: SQL Tools Service execution contract

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

  Scenario: Execute, reject errors, cancel, recover, and page results through STS
    When I evaluate "window.__e2e.sql.setQuery('SELECT 1 AS test_col, 2 AS test_col2')" in the webview
    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.assertHasResults()" in the webview
    When I evaluate "window.__e2e.sql.assertResultColumns('test_col,test_col2')" in the webview
    When I evaluate "window.__e2e.sql.assertRowCount(1)" in the webview
    When I evaluate "window.__e2e.sql.assertNoError()" in the webview

    When I evaluate "window.__e2e.sql.setQuery('SELECT * FROM this_table_does_not_exist_xyz')" in the webview
    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.assertHasError()" in the webview

    When I evaluate "window.__e2e.sql.setQuery(`WAITFOR DELAY '00:00:30'; SELECT 1 AS too_late`)" in the webview
    When I evaluate "window.__e2e.sql.run()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.assertExecutingTimerVisible()" in the webview
    When I evaluate "window.__e2e.sql.clickCancel()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 10 seconds

    When I evaluate "window.__e2e.sql.setQuery('SELECT TOP 5 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES')" in the webview
    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.assertMinRowCount(2)" in the webview
    When I execute command "workbench.action.closeAllEditors"