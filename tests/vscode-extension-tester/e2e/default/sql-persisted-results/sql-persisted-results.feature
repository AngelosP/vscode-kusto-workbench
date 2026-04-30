Feature: SQL persisted results restore

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Open a SQLX file with persisted results and mark them stale after editing
    When I open file "tests/vscode-extension-tester/e2e/default/sql-persisted-results/fixtures/persisted-results.sqlx" in the editor
    And I wait 6 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I wait for "kw-sql-section[data-test-has-results='true']" in the webview for 20 seconds
    Then I take a screenshot "01-restored-persisted-sql-results"

    When I evaluate "(() => { const section = document.getElementById('sql_persisted_results'); if (!section) throw new Error('Persisted SQL section not found'); const data = section.serialize(); if (!data.resultJson) throw new Error('Serialized SQL section is missing resultJson after restore'); const persisted = JSON.parse(data.resultJson); if (persisted.rows.length !== 4) throw new Error('Expected 4 persisted SQL rows, got ' + persisted.rows.length); if (persisted.metadata.clientActivityId !== 'sql-persisted-results-e2e') throw new Error('SQL metadata was not preserved'); const dt = document.getElementById('sql_persisted_results_sql_results_body')?.querySelector('kw-data-table'); if (!dt) throw new Error('Restored SQL result did not render a kw-data-table'); const cols = (dt.columns || []).map(c => c.name || c); const rows = dt.rows || []; if (rows.length !== 4) throw new Error('Rendered SQL table expected 4 rows, got ' + rows.length); if (cols.join('|') !== 'RowId|Label|Amount') throw new Error('Unexpected rendered SQL columns: ' + cols.join(',')); if (rows[0][1] !== 'sql_row_01' || rows[3][1] !== 'sql_row_04') throw new Error('Rendered SQL row labels were not restored'); const wrapper = document.getElementById('sql_persisted_results_sql_results_wrapper'); if (!wrapper || wrapper.style.display === 'none') throw new Error('SQL results wrapper is not visible'); return 'persisted SQL results restored: rows=' + rows.length; })()" in the webview

    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.setQuery(`SELECT 'changed' AS sql_persisted_results_marker`)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.assertStaleResults()" in the webview
    Then I take a screenshot "02-stale-overlay-after-edit"

    When I execute command "workbench.action.revertAndCloseActiveEditor"
