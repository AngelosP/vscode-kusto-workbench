Feature: Persisted query results restore

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Open and reopen a KQLX file with persisted results
    When I open file "tests/vscode-extension-tester/e2e/default/persisted-results-restore/fixtures/persisted-results.kqlx" in the editor
    And I wait 6 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I wait for "kw-query-section[data-test-has-results='true']" in the webview for 20 seconds
    Then I take a screenshot "01-restored-persisted-results"

    When I evaluate "(() => { const section = document.getElementById('query_persisted_results'); if (!section) throw new Error('Persisted query section not found'); const data = section.serialize(); if (!data.resultJson) throw new Error('Serialized section is missing resultJson after restore'); const persisted = JSON.parse(data.resultJson); if (persisted.rows.length !== 12) throw new Error('Expected 12 persisted rows, got ' + persisted.rows.length); if (persisted.metadata.clientActivityId !== 'persisted-results-e2e') throw new Error('Metadata was not preserved'); const dt = document.getElementById('query_persisted_results_results')?.querySelector('kw-data-table'); if (!dt) throw new Error('Restored result did not render a kw-data-table'); const cols = (dt.columns || []).map(c => c.name || c); const rows = dt.rows || []; if (rows.length !== 12) throw new Error('Rendered table expected 12 rows, got ' + rows.length); if (cols.join('|') !== 'RowId|Label|Amount') throw new Error('Unexpected rendered columns: ' + cols.join(',')); if (rows[0][1] !== 'persist_row_01' || rows[11][1] !== 'persist_row_12') throw new Error('Rendered row labels were not restored'); const wrapper = document.getElementById('query_persisted_results_results_wrapper'); if (!wrapper || wrapper.style.display === 'none') throw new Error('Results wrapper is not visible'); return 'persisted results restored: rows=' + rows.length; })()" in the webview

    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/e2e/default/persisted-results-restore/fixtures/persisted-results.kqlx" in the editor
    And I wait 6 seconds
    When I wait for "kw-query-section[data-test-has-results='true']" in the webview for 20 seconds
    Then I take a screenshot "02-reopened-persisted-results"

    When I evaluate "(() => { const section = document.getElementById('query_persisted_results'); if (!section) throw new Error('Persisted query section missing after reopen'); const dt = document.getElementById('query_persisted_results_results')?.querySelector('kw-data-table'); if (!dt) throw new Error('Reopened result table missing'); const data = section.serialize(); const persisted = JSON.parse(data.resultJson || '{}'); const rows = dt.rows || []; if (persisted.rows.length !== 12 || rows.length !== 12) throw new Error('Persisted/rendered row count changed after reopen'); if (rows[5][1] !== 'persist_row_06') throw new Error('Reopened row data mismatch'); if (persisted.metadata.executionTime !== '00:00:00.321') throw new Error('Execution metadata changed after reopen'); return 'reopened persisted results verified'; })()" in the webview

    When I execute command "workbench.action.closeAllEditors"
