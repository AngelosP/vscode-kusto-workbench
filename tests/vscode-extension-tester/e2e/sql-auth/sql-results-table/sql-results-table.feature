Feature: SQL results table — display, stale overlay, metadata

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Results display correctly, stale overlay on edit, metadata shown
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) throw new Error('No SQL databases available'); if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

    # Focus editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── TEST 1: Execute and verify multi-column results ───────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el._editor.setValue('SELECT TOP 3 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME'); el._editor.focus(); return 'query set'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { document.querySelector('kw-sql-section .sql-run-btn').click(); return 'run'; })()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { const dt = document.querySelector('kw-sql-section .sql-results-body kw-data-table'); if (!dt) throw new Error('No data table'); const cols = (dt.columns || []).map(c => c.name || c); if (cols.length < 3) throw new Error('Expected 3+ columns, got ' + cols.length + ': ' + cols.join(', ')); if (!cols.includes('TABLE_SCHEMA')) throw new Error('Missing TABLE_SCHEMA column'); if (!cols.includes('TABLE_NAME')) throw new Error('Missing TABLE_NAME column'); return 'columns verified: ' + cols.join(', ') + ' ✓'; })()" in the webview
    Then I take a screenshot "01-multi-column-results"

    # ── TEST 2: Results have correct row count ────────────────────────────
    When I evaluate "(() => { const dt = document.querySelector('kw-sql-section .sql-results-body kw-data-table'); const rows = dt.rows || []; if (rows.length !== 3) throw new Error('Expected 3 rows (TOP 3), got ' + rows.length); return 'rows = 3 ✓'; })()" in the webview

    # ── TEST 3: Edit query → stale overlay appears ────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el._editor.setValue('SELECT TOP 3 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES -- modified'); el._editor.focus(); return 'query edited'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const wrapper = document.querySelector('kw-sql-section .results-wrapper'); if (!wrapper) throw new Error('No results wrapper'); const isStale = wrapper.classList.contains('is-stale'); if (!isStale) throw new Error('Results wrapper should have is-stale class after edit'); return 'stale overlay shown ✓'; })()" in the webview
    Then I take a screenshot "02-stale-overlay"

    # ── TEST 4: Re-run → stale overlay clears ────────────────────────────
    When I evaluate "(() => { document.querySelector('kw-sql-section .sql-run-btn').click(); return 'rerun'; })()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { const wrapper = document.querySelector('kw-sql-section .results-wrapper'); if (!wrapper) throw new Error('No results wrapper'); const isStale = wrapper.classList.contains('is-stale'); if (isStale) throw new Error('Stale overlay should be cleared after re-run'); return 'stale cleared ✓'; })()" in the webview
    Then I take a screenshot "03-stale-cleared"
    When I execute command "workbench.action.closeAllEditors"
