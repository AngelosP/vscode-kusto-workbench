Feature: SQL Leave No Trace live privacy boundary

  Background:
    Given the extension is in a clean state
    When I execute command "kustoWorkbench.test.setSqlLeaveNoTrace" with args '["__CURRENT_SQL_CONNECTION__", false]'
    When I execute command "kustoWorkbench.test.assertSqlLeaveNoTrace" with args '["__CURRENT_SQL_CONNECTION__", false]'
    When I execute command "kustoWorkbench.test.closeQueryEditorSession"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 60 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds

  Scenario: Enabling LNT clears retained and dependent SQL data and blocks new work
    When I evaluate "window.__e2e.sql.setQuery('SELECT 1 AS Category, 10 AS Amount UNION ALL SELECT 2, 20')" in the webview
    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "(() => { const sql = document.querySelector('kw-sql-section'); const sourceId = sql.boxId; window.addTransformationBox({ id: 'transformation_lnt_contract', dataSourceId: sourceId, transformationType: 'derive', deriveColumns: [{ name: 'DoubleAmount', expression: 'Amount * 2' }], mode: 'preview', expanded: true }); const transform = document.getElementById('transformation_lnt_contract'); transform.refresh(); window.addChartBox({ id: 'chart_lnt_contract', dataSourceId: 'transformation_lnt_contract', chartType: 'bar', xColumn: 'Category', yColumns: ['DoubleAmount'], mode: 'preview', expanded: true }); const chart = document.getElementById('chart_lnt_contract'); chart.refresh(); const provenance = '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: sourceId, sectionName: 'SQL Source' } }, bindings: {} }) + '</script><main>SQL bridge</main>'; window.addHtmlBox({ id: 'html_lnt_contract', code: provenance, mode: 'preview', expanded: true }); sql.copilotAppendExecutedQuery('SELECT secret', '1 row', '', 'lnt-entry', window.__e2e.sql.resultContract()); const dataset = window.__kustoGetChartDatasetsInDomOrder().find(d => d.id === 'transformation_lnt_contract'); if (!dataset || dataset.rows.length !== 2) throw new Error('Dependent transformation was not seeded'); return JSON.stringify({ connectionId: sql.getSqlConnectionId(), sourceId }); })()" in the webview
    When I execute command "kustoWorkbench.test.setSqlLeaveNoTrace" with args '["__CURRENT_SQL_CONNECTION__", true]'
    When I execute command "kustoWorkbench.test.assertSqlLeaveNoTrace" with args '["__CURRENT_SQL_CONNECTION__", true]'
    And I wait 2 seconds
    When I evaluate "(() => { const sql = document.querySelector('kw-sql-section'); const source = window.__e2e.sql.resultContract; let sourceCleared = false; try { source(); } catch { sourceCleared = true; } if (!sourceCleared) throw new Error('Protected SQL result state remained'); const datasets = window.__kustoGetChartDatasetsInDomOrder(); if (datasets.some(d => d.id === sql.boxId || d.id === 'transformation_lnt_contract')) throw new Error('Protected source or derived dataset remained'); const chartState = window.__kustoGetChartState('chart_lnt_contract'); if (chartState && chartState.__wasRendering) throw new Error('Chart retained protected rendering state'); const html = document.getElementById('html_lnt_contract'); const iframe = html && html.shadowRoot && html.shadowRoot.getElementById('preview-iframe'); if (String(iframe && iframe.srcdoc || '').includes('10')) throw new Error('HTML bridge retained protected row'); const serialized = sql.serialize(); if (serialized.resultJson) throw new Error('Protected resultJson remained serializable'); const chat = sql.getCopilotChatEl && sql.getCopilotChatEl(); const messageCount = chat && chat.shadowRoot ? chat.shadowRoot.querySelectorAll('.message').length : 0; if (messageCount > 1) throw new Error('SQL Copilot chat history remained: ' + messageCount); return 'LNT cleared source, dependents, persistence, and chat'; })()" in the webview
    When I evaluate "window.__e2e.sql.setQuery('SELECT 99 AS blocked')" in the webview
    When I evaluate "window.__e2e.sql.run()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.assertHasError()" in the webview
    When I execute command "kustoWorkbench.test.setSqlLeaveNoTrace" with args '["__CURRENT_SQL_CONNECTION__", false]'
    When I execute command "kustoWorkbench.test.assertSqlLeaveNoTrace" with args '["__CURRENT_SQL_CONNECTION__", false]'
    When I execute command "workbench.action.closeAllEditors"
