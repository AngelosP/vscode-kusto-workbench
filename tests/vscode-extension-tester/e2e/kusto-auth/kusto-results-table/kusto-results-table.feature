Feature: Kusto results table — display, columns, rows, data table features

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Results table rendering, column types, row data, visibility toggle
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select database through the dropdown
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    Then I take a screenshot "01-setup-ready"

    # ── TEST 1: Multi-column result with typed columns ────────────────────
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print str_col='hello', int_col=42, real_col=3.14, bool_col=true, dt_col=datetime(2024-01-15)`)" in the webview
    When I evaluate "window.__e2e.kusto.assertQuery(String.raw`print str_col='hello', int_col=42, real_col=3.14, bool_col=true, dt_col=datetime(2024-01-15)`)" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const dt = document.getElementById(el.boxId + '_results')?.querySelector('kw-data-table'); if (!dt) throw new Error('No data table'); const cols = (dt.columns || []).map(c => ({ name: c.name || c, type: c.type || '' })); if (cols.length < 5) throw new Error('Expected 5 columns, got ' + cols.length); const names = cols.map(c => c.name); if (!names.includes('str_col')) throw new Error('Missing str_col'); if (!names.includes('int_col')) throw new Error('Missing int_col'); if (!names.includes('real_col')) throw new Error('Missing real_col'); if (!names.includes('bool_col')) throw new Error('Missing bool_col'); if (!names.includes('dt_col')) throw new Error('Missing dt_col'); return 'columns: ' + cols.map(c => c.name + '(' + c.type + ')').join(', ') + ' ✓'; })()" in the webview
    Then I take a screenshot "02-typed-columns"

    # ── TEST 2: Row data values are correct ───────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const dt = document.getElementById(el.boxId + '_results')?.querySelector('kw-data-table'); if (!dt) throw new Error('No data table'); const rows = dt.rows || []; if (rows.length !== 1) throw new Error('Expected 1 row, got ' + rows.length); const cols = (dt.columns || []).map(c => c.name || c); const row = rows[0]; const strIdx = cols.indexOf('str_col'); const intIdx = cols.indexOf('int_col'); if (String(row[strIdx]) !== 'hello') throw new Error('str_col expected hello, got ' + row[strIdx]); if (Number(row[intIdx]) !== 42) throw new Error('int_col expected 42, got ' + row[intIdx]); return 'row data verified ✓'; })()" in the webview

    # ── TEST 3: Larger result set ─────────────────────────────────────────
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`range i from 1 to 20 step 1 | extend name=strcat('item_', tostring(i)), value=i*10`)" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { window.__e2e.kusto.assertRowCount(20); return window.__e2e.kusto.assertResultColumns('i,name,value'); })()" in the webview
    Then I take a screenshot "03-large-result"

    # ── TEST 4: Data table has save button ────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const dt = document.getElementById(el.boxId + '_results')?.querySelector('kw-data-table'); if (!dt) throw new Error('No data table'); const sr = dt.shadowRoot; if (!sr) throw new Error('No shadow root on data table'); const saveBtn = sr.querySelector('.save-btn, .results-save-btn, [title*=Save], [title*=save], [title*=CSV], [title*=csv]'); if (!saveBtn) throw new Error('Expected data table save/export button'); return 'save button found'; })()" in the webview

    # ── TEST 5: No results query ──────────────────────────────────────────
    When I evaluate "window.__e2e.kusto.setQuery('print x=1 | where x == 99')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    # For empty results: either has-results with 0 rows, or "No results" message
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const resultsDiv = document.getElementById(el.boxId + '_results'); if (!resultsDiv) throw new Error('No results div'); const html = resultsDiv.innerHTML; const dt = resultsDiv.querySelector('kw-data-table'); if (dt) { const rows = dt.rows || []; if (rows.length > 0) throw new Error('Expected 0 rows, got ' + rows.length); return 'empty data table (0 rows)'; } if (html.toLowerCase().includes('no results') || html.toLowerCase().includes('no result')) { return 'No results message shown'; } throw new Error('Expected empty results table or no-results message, got: ' + html.substring(0, 100)); })()" in the webview
    Then I take a screenshot "04-no-results"

    # ── TEST 6: Stale overlay then re-run clears it ───────────────────────
    When I evaluate "window.__e2e.kusto.setQuery('range i from 1 to 3 step 1')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    # Edit to trigger stale
    When I evaluate "window.__e2e.kusto.setQuery('range i from 1 to 3 step 1 | extend modified=true')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.assertStaleResults()" in the webview
    Then I take a screenshot "05-stale-overlay"

    # Re-run to clear stale
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.assertResultsNotStale()" in the webview
    Then I take a screenshot "06-stale-cleared"
    When I execute command "workbench.action.closeAllEditors"
