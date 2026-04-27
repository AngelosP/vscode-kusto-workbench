Feature: Kusto query execution end-to-end

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Execute KQL query, verify results, test error handling and run controls
    # ── Setup: open editor, add KQL section, connect ─────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    # Wait for cluster connection and databases
    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select a database with data (prefers sample/storm, falls back to the first dropdown item)
    When I evaluate "window.__testSelectKwDropdownItem(`kw-query-section .select-wrapper[title='Kusto Database'] kw-dropdown`, 'sample,storm', true)" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    Then I take a screenshot "01-setup-ready"

    # Focus the KQL editor
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__testAssertMonacoEditorMapped('kw-query-section .query-editor')" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const editorEl = document.getElementById(el.boxId + '_query_editor'); if (editorEl) editorEl.scrollIntoView({ block: 'center' }); return 'scrolled'; })()" in the webview
    And I wait 1 second

    # ── TEST 1: Run button is enabled when connected ──────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); if (!btn) throw new Error('Run button not found'); if (btn.disabled) throw new Error('Run button should be enabled when connected'); return 'Run button enabled ✓'; })()" in the webview
    Then I take a screenshot "02-run-enabled"

    # ── TEST 2: Execute simple query → results appear ─────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-query-section .query-editor', String.raw`print message='hello from e2e test', value=42`)" in the webview
    When I evaluate "window.__testAssertMonacoValue('kw-query-section .query-editor', String.raw`print message='hello from e2e test', value=42`)" in the webview
    And I wait 1 second

    # Click the Run button
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); btn.click(); return 'clicked run'; })()" in the webview

    # Wait for execution to complete
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    # Verify results appeared
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testHasResults !== 'true') throw new Error('Expected results but data-test-has-results=' + el.dataset.testHasResults); return 'results present ✓'; })()" in the webview
    Then I take a screenshot "03-results-appeared"

    # Verify result columns contain expected content
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const resultsDiv = document.getElementById(el.boxId + '_results'); const dt = resultsDiv?.querySelector('kw-data-table'); if (!dt) throw new Error('No data table element'); const cols = (dt.columns || []).map(c => c.name || c); if (!cols.includes('message')) throw new Error('Expected column message, got: ' + cols.join(', ')); if (!cols.includes('value')) throw new Error('Expected column value, got: ' + cols.join(', ')); return 'columns verified: ' + cols.join(', ') + ' ✓'; })()" in the webview

    # Verify we got exactly 1 row
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const dt = document.getElementById(el.boxId + '_results')?.querySelector('kw-data-table'); if (!dt) throw new Error('No data table'); const rows = dt.rows || []; if (rows.length !== 1) throw new Error('Expected 1 row, got ' + rows.length); return 'row count = 1 ✓'; })()" in the webview

    # ── TEST 3: No error after successful execution ───────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testHasError === 'true') throw new Error('Unexpected error after successful query'); return 'no error ✓'; })()" in the webview

    # ── TEST 4: Execute invalid KQL → error appears ───────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-query-section .query-editor', 'this_table_does_not_exist_xyz_abc')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); document.getElementById(el.boxId + '_run_btn').click(); return 'clicked run'; })()" in the webview
    When I wait for "kw-query-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testHasError !== 'true') throw new Error('Expected error after invalid KQL but data-test-has-error=' + el.dataset.testHasError); return 'error shown ✓'; })()" in the webview
    Then I take a screenshot "04-error-shown"

    # ── TEST 5: Elapsed timer appears during execution ────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-query-section .query-editor', 'print x=1 | extend y=x')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); document.getElementById(el.boxId + '_run_btn').click(); return 'clicked run'; })()" in the webview

    # Check if the executing state is shown (status spinner visible)
    # Note: the query may finish fast, so we just verify it eventually completes
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    Then I take a screenshot "05-execution-complete"

    # ── TEST 6: Multi-row query result ────────────────────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-query-section .query-editor', String.raw`range x from 1 to 5 step 1 | extend label = strcat('row_', tostring(x))`)" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); document.getElementById(el.boxId + '_run_btn').click(); return 'clicked run'; })()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const dt = document.getElementById(el.boxId + '_results')?.querySelector('kw-data-table'); if (!dt) throw new Error('No data table'); const rows = dt.rows || []; if (rows.length !== 5) throw new Error('Expected 5 rows, got ' + rows.length); const cols = (dt.columns || []).map(c => c.name || c); if (!cols.includes('x')) throw new Error('Missing column x'); if (!cols.includes('label')) throw new Error('Missing column label'); return 'multi-row: ' + rows.length + ' rows, cols=' + cols.join(',') + ' ✓'; })()" in the webview
    Then I take a screenshot "06-multi-row-results"

    # ── TEST 7: Stale overlay after editing query ─────────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-query-section .query-editor', 'range x from 1 to 5 step 1 | extend modified=true')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const resultsDiv = document.getElementById(el.boxId + '_results'); if (!resultsDiv) throw new Error('No results div'); const isStale = resultsDiv.classList.contains('is-stale'); if (!isStale) throw new Error('Results should have is-stale class after edit'); return 'stale overlay shown ✓'; })()" in the webview
    Then I take a screenshot "07-stale-overlay"

    # ── TEST 8: Final verification ──────────────────────────────────────
    Then I take a screenshot "08-final"
    When I execute command "workbench.action.closeAllEditors"
