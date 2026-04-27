Feature: SQL query execution end-to-end

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Execute SELECT, verify results, test error handling and run controls
    # ── Setup: open editor, add SQL section, connect ─────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb through the database dropdown
    When I evaluate "window.__testSelectKwDropdownItem(`kw-sql-section .select-wrapper[title='SQL Database'] kw-dropdown`, 'sampledb')" in the webview
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
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const btn = el.querySelector('.sql-run-btn'); if (!btn) throw new Error('Run button not found'); if (btn.disabled) throw new Error('Run button should be enabled when connected'); return 'Run button enabled ✓'; })()" in the webview
    Then I take a screenshot "02-run-enabled"

    # ── TEST 2: Execute simple SELECT → results appear ────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-sql-section .query-editor', 'SELECT 1 AS test_col, 2 AS test_col2')" in the webview
    And I wait 1 second

    # Click the Run button
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el.querySelector('.sql-run-btn').click(); return 'clicked run'; })()" in the webview

    # Wait for execution to complete
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    # Verify results appeared
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testHasResults !== 'true') throw new Error('Expected results but data-test-has-results=' + el.dataset.testHasResults); return 'results present ✓'; })()" in the webview
    Then I take a screenshot "03-results-appeared"

    # Verify result columns contain 'test_col'
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const body = el.querySelector('.sql-results-body'); if (!body) throw new Error('No results body'); const dt = body.querySelector('kw-data-table'); if (!dt) throw new Error('No data table element'); const cols = dt.columns || []; const colNames = cols.map(c => c.name || c); if (!colNames.includes('test_col')) throw new Error('Expected column test_col, got: ' + colNames.join(', ')); if (!colNames.includes('test_col2')) throw new Error('Expected column test_col2, got: ' + colNames.join(', ')); return 'columns verified: ' + colNames.join(', ') + ' ✓'; })()" in the webview

    # Verify we got exactly 1 row
    When I evaluate "(() => { const dt = document.querySelector('kw-sql-section .sql-results-body kw-data-table'); if (!dt) throw new Error('No data table'); const rows = dt.rows || []; if (rows.length !== 1) throw new Error('Expected 1 row, got ' + rows.length); return 'row count = 1 ✓'; })()" in the webview

    # ── TEST 3: No error after successful execution ───────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testHasError === 'true') throw new Error('Unexpected error: ' + el._lastError); return 'no error ✓'; })()" in the webview

    # ── TEST 4: Execute invalid SQL → error appears ───────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-sql-section .query-editor', 'SELECT * FROM this_table_does_not_exist_xyz')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el.querySelector('.sql-run-btn').click(); return 'clicked run'; })()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testHasError !== 'true') throw new Error('Expected error after invalid SQL but data-test-has-error=' + el.dataset.testHasError); return 'error shown ✓ — ' + (el._lastError || '').substring(0, 80); })()" in the webview
    Then I take a screenshot "04-error-shown"

    # ── TEST 5: Elapsed timer appears during execution ────────────────────
    # Execute a query that takes a moment
    When I evaluate "window.__testSetMonacoValue('kw-sql-section .query-editor', `WAITFOR DELAY '00:00:02'; SELECT 1 AS done`)" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el.querySelector('.sql-run-btn').click(); return 'clicked run'; })()" in the webview
    And I wait 1 second

    # Check executing state is true while query runs
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testExecuting !== 'true') throw new Error('Expected executing=true during query but got ' + el.dataset.testExecuting); const status = el.querySelector('.query-exec-status'); if (!status || status.style.display === 'none') throw new Error('Elapsed timer not visible during execution'); return 'executing + timer visible ✓'; })()" in the webview
    Then I take a screenshot "05-executing-timer"

    # Wait for it to finish
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    Then I take a screenshot "06-execution-complete"

    # ── TEST 6: Multi-row result ──────────────────────────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-sql-section .query-editor', 'SELECT TOP 5 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el.querySelector('.sql-run-btn').click(); return 'clicked run'; })()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { const dt = document.querySelector('kw-sql-section .sql-results-body kw-data-table'); if (!dt) throw new Error('No data table'); const rows = dt.rows || []; if (rows.length < 2) throw new Error('Expected multiple rows, got ' + rows.length); return 'multi-row result: ' + rows.length + ' rows ✓'; })()" in the webview
    Then I take a screenshot "07-multi-row-results"
    When I execute command "workbench.action.closeAllEditors"
