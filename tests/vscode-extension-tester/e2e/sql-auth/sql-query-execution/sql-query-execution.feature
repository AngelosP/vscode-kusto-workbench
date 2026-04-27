Feature: SQL query execution end-to-end

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Execute SELECT, verify results, test error handling and run controls
    # ── Setup: open editor, add SQL section, connect ─────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb through the database dropdown
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "01-setup-ready"

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── TEST 1: Run button disabled when no connection ────────────────────
    # Verify Run button is currently enabled (we have connection + database)
    When I evaluate "window.__e2e.sql.assertRunEnabled()" in the webview
    Then I take a screenshot "02-run-enabled"

    # ── TEST 2: Execute simple SELECT → results appear ────────────────────
    When I evaluate "window.__e2e.sql.setQuery('SELECT 1 AS test_col, 2 AS test_col2')" in the webview
    And I wait 1 second

    # Click the Run button
    When I evaluate "window.__e2e.sql.run()" in the webview

    # Wait for execution to complete
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    # Verify results appeared
    When I evaluate "window.__e2e.sql.assertHasResults()" in the webview
    Then I take a screenshot "03-results-appeared"

    # Verify result columns contain 'test_col'
    When I evaluate "window.__e2e.sql.assertResultColumns('test_col,test_col2')" in the webview

    # Verify we got exactly 1 row
    When I evaluate "window.__e2e.sql.assertRowCount(1)" in the webview

    # ── TEST 3: No error after successful execution ───────────────────────
    When I evaluate "window.__e2e.sql.assertNoError()" in the webview

    # ── TEST 4: Execute invalid SQL → error appears ───────────────────────
    When I evaluate "window.__e2e.sql.setQuery('SELECT * FROM this_table_does_not_exist_xyz')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertHasError()" in the webview
    Then I take a screenshot "04-error-shown"

    # ── TEST 5: Elapsed timer appears during execution ────────────────────
    # Execute a query that takes a moment
    When I evaluate "window.__e2e.sql.setQuery(`WAITFOR DELAY '00:00:02'; SELECT 1 AS done`)" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.run()" in the webview
    And I wait 1 second

    # Check executing state is true while query runs
    When I evaluate "window.__e2e.sql.assertExecutingTimerVisible()" in the webview
    Then I take a screenshot "05-executing-timer"

    # Wait for it to finish
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    Then I take a screenshot "06-execution-complete"

    # ── TEST 6: Multi-row result ──────────────────────────────────────────
    When I evaluate "window.__e2e.sql.setQuery('SELECT TOP 5 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertMinRowCount(2)" in the webview
    Then I take a screenshot "07-multi-row-results"
    When I execute command "workbench.action.closeAllEditors"
