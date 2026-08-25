Feature: SQL results table — display, stale overlay, metadata

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 1050
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Results display correctly, stale overlay on edit, metadata shown
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds

    # Focus editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── TEST 1: Execute and verify multi-column results ───────────────────
    When I evaluate "window.__e2e.sql.setQuery('SELECT TOP 3 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertResultColumns('TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE')" in the webview
    When I move the Dev Host to 0, 0
    When I click at 30, 700
    Then I take a screenshot "01-multi-column-results"

    # ── TEST 2: Results have correct row count ────────────────────────────
    When I evaluate "window.__e2e.sql.assertRowCount(3)" in the webview

    # Bind a Chart to this exact SQL result before editing.
    When I click "button[data-add-kind='chart']" in the webview
    When I wait for "kw-chart-section" in the webview for 20 seconds
    When I evaluate "(() => { const sql = document.querySelector('kw-sql-section'); const chart = document.querySelector('kw-chart-section'); if (!sql || !chart || !chart.configure({ dataSourceId: sql.boxId, chartType: 'pie', labelColumn: 'TABLE_NAME' })) throw new Error('Could not bind Chart to SQL result'); const datasets = chart.getDatasets(); if (!datasets.some(dataset => dataset.id === sql.boxId)) throw new Error('Chart did not bind the SQL result: ' + JSON.stringify(datasets)); return { sqlBoxId: sql.boxId, chartBoxId: chart.boxId, datasetIds: datasets.map(dataset => dataset.id) }; })()" in the webview

    # ── TEST 3: Edit query → stale overlay appears ────────────────────────
    When I evaluate "window.__e2e.sql.setQuery('SELECT TOP 3 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES -- modified')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertStaleResults()" in the webview
    When I evaluate "(() => { const sql = document.querySelector('kw-sql-section'); const chart = document.querySelector('kw-chart-section'); const table = sql?.querySelector('kw-data-table'); const wrapper = sql && document.getElementById(sql.boxId + '_sql_results_wrapper'); if (!sql || !chart || !table || !wrapper) throw new Error('SQL/Chart composition is incomplete'); const rect = wrapper.getBoundingClientRect(); const style = getComputedStyle(wrapper); if (table.rows.length !== 3 || style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) throw new Error('Stale SQL table should remain visibly rendered: ' + JSON.stringify({ rows: table.rows.length, display: style.display, visibility: style.visibility, width: rect.width, height: rect.height })); if (table.canCopyRows() || table.options.showSave === true) throw new Error('Stale SQL table retained copy/export capability'); if (chart.getDatasets().length !== 0) throw new Error('Chart retained stale SQL artifact authority: ' + JSON.stringify(chart.getDatasets())); const serialized = sql.serialize(); if (serialized.resultJson || serialized.resultArtifact) throw new Error('Stale SQL result remained persistable: ' + JSON.stringify({ resultJson: !!serialized.resultJson, resultArtifact: !!serialized.resultArtifact })); return { staleRows: table.rows.length, chartDatasets: chart.getDatasets().length, canCopyRows: table.canCopyRows(), showSave: table.options.showSave, persistableResultJson: !!serialized.resultJson, persistableResultArtifact: !!serialized.resultArtifact, width: rect.width, height: rect.height }; })()" in the webview
    When I move the Dev Host to 0, 0
    When I click at 30, 700
    Then I take a screenshot "02-stale-overlay"

    # ── TEST 4: Re-run → stale overlay clears ────────────────────────────
    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertResultsNotStale()" in the webview
    When I evaluate "(() => { window.__e2e.sql.assertRowCount(3); return window.__e2e.sql.assertResultColumns('TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE'); })()" in the webview
    When I evaluate "window.__e2e.sql.assertRenderedRowCount(3)" in the webview
    When I evaluate "(() => { const sql = document.querySelector('kw-sql-section'); const chart = document.querySelector('kw-chart-section'); const datasets = chart?.getDatasets?.() || []; if (!sql || !datasets.some(dataset => dataset.id === sql.boxId)) throw new Error('Chart did not rebind the rerun SQL artifact: ' + JSON.stringify(datasets)); return datasets.map(dataset => dataset.id); })()" in the webview
    When I move the Dev Host to 0, 0
    When I click at 30, 700
    Then I take a screenshot "03-stale-cleared"
    When I execute command "workbench.action.closeAllEditors"
