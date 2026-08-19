Feature: Kusto query sections preserve multiple primary results

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeAuxiliaryBar"

  Scenario: Run All with standalone separators, select Result 2, chart it, save, and reopen
    When I delete file "tests/vscode-extension-tester/runs/kusto-auth/kusto-multi-result/multi-result.kqlx"
    Given a file "tests/vscode-extension-tester/runs/kusto-auth/kusto-multi-result/multi-result.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"query_multi_result","type":"query","name":"Three primary results","query":"print ResultSet = 'first', Value = 1\n;\nprint ResultSet = 'second', Value = 2\n;\nprint ResultSet = 'third', Value = 3","expanded":true,"clusterUrl":"https://1es.kusto.windows.net","database":"Liquid"}]}}
      """
    When I open file "tests/vscode-extension-tester/runs/kusto-auth/kusto-multi-result/multi-result.kqlx" in the editor
    When I wait for "kw-query-section[data-test-connection='true']" in the webview "multi-result.kqlx" for 60 seconds
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview "multi-result.kqlx" for 60 seconds
    When I evaluate "window.__e2e.kusto.runAll()" in the webview "multi-result.kqlx"
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview "multi-result.kqlx" for 60 seconds
    When I wait for "[data-testid='result-set-picker']" in the webview "multi-result.kqlx" for 10 seconds
    Then I collect JSON artifact "live-result-one" from webview expression "(() => { const section = document.getElementById('query_multi_result'); const table = section?.querySelector('kw-data-table'); const picker = table?.shadowRoot?.querySelector('[data-testid=result-set-picker]'); if (!table || !picker) throw new Error('Multi-result picker is unavailable'); const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const columns = (table.columns || []).map(column => typeof column === 'string' ? column : column.name); const resultSetIndex = columns.indexOf('ResultSet'); const valueIndex = columns.indexOf('Value'); const row = table.rows?.[0] || []; const rawRow = row.map(raw); const options = [...picker.options].map(option => option.textContent); if (options.length !== 3 || picker.value !== '0' || raw(row[resultSetIndex]) !== 'first' || Number(raw(row[valueIndex])) !== 1) throw new Error('Unexpected Result 1 state: ' + JSON.stringify({ options, value: picker.value, columns, row })); return { optionCount: options.length, options, selectedResultIndex: 0, row: rawRow }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    And I press "Escape"
    And I wait 1 second
    Then I take a screenshot "01-two-result-picker"

    When I evaluate "(() => { const table = document.getElementById('query_multi_result')?.querySelector('kw-data-table'); const picker = table?.shadowRoot?.querySelector('[data-testid=result-set-picker]'); if (!picker) throw new Error('Result picker is unavailable'); picker.value = '1'; picker.dispatchEvent(new Event('change', { bubbles: true, composed: true })); return 'requested Result 2'; })()" in the webview "multi-result.kqlx"
    And I wait 3 seconds
    When I evaluate "(() => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const table = document.getElementById('query_multi_result')?.querySelector('kw-data-table'); const picker = table?.shadowRoot?.querySelector('[data-testid=result-set-picker]'); const columns = (table?.columns || []).map(column => typeof column === 'string' ? column : column.name); const row = table?.rows?.[0] || []; if (picker?.value !== '1' || raw(row[columns.indexOf('ResultSet')]) !== 'second' || Number(raw(row[columns.indexOf('Value')])) !== 2) throw new Error('Result 2 did not become active: ' + JSON.stringify({ picker: picker?.value, selected: table?.options?.selectedResultIndex, row })); return { selectedResultIndex: 1, row: row.map(raw) }; })()" in the webview "multi-result.kqlx"
    Then I collect JSON artifact "live-result-two" from webview expression "(() => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const table = document.getElementById('query_multi_result')?.querySelector('kw-data-table'); const picker = table?.shadowRoot?.querySelector('[data-testid=result-set-picker]'); const columns = (table?.columns || []).map(column => typeof column === 'string' ? column : column.name); const row = table?.rows?.[0] || []; if (picker?.value !== '1' || raw(row[columns.indexOf('ResultSet')]) !== 'second' || Number(raw(row[columns.indexOf('Value')])) !== 2) throw new Error('Result 2 is not active'); return { selectedResultIndex: 1, row: row.map(raw) }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    And I press "Escape"
    And I wait 1 second
    Then I take a screenshot "02-result-two-selected"

    When I evaluate "(() => { const chartId = window.addChartBox({ id: 'chart_multi_result_two', name: 'Result 2 chart', dataSourceId: 'query_multi_result', dataSourceResultIndex: 1, chartType: 'bar', xColumn: 'ResultSet', yColumns: ['Value'], mode: 'preview', expanded: true, afterBoxId: 'query_multi_result' }); const chart = document.getElementById(chartId); chart?.refresh?.(); return chartId; })()" in the webview "multi-result.kqlx"
    And I wait 5 seconds
    When I evaluate "(() => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const chart = document.getElementById('chart_multi_result_two'); const serialized = chart?.serialize?.(); const dataset = chart?.getDatasets?.().find(entry => entry.id === 'query_multi_result' && entry.resultIndex === 1); const state = window.chartStateByBoxId?.chart_multi_result_two; if (!serialized || serialized.dataSourceResultIndex !== 1 || !dataset || raw(dataset.rows?.[0]?.[0]) !== 'second' || Number(raw(dataset.rows?.[0]?.[1])) !== 2 || serialized.validation?.valid !== true || !state?.__echarts?.instance || state.__wasRendering !== true) throw new Error('Result 2 chart contract failed: ' + JSON.stringify({ serialized, dataset, rendered: !!state?.__echarts?.instance })); chart.scrollIntoView({ block: 'start' }); return 'Result 2 chart rendered'; })()" in the webview "multi-result.kqlx"
    And I wait 1 second
    Then I collect JSON artifact "result-two-chart" from webview expression "(() => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const chart = document.getElementById('chart_multi_result_two'); const serialized = chart.serialize(); const dataset = chart.getDatasets().find(entry => entry.id === 'query_multi_result' && entry.resultIndex === 1); return { dataSourceId: serialized.dataSourceId, dataSourceResultIndex: serialized.dataSourceResultIndex, rows: dataset.rows.map(row => row.map(raw)) }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    And I press "Escape"
    And I wait 1 second
    Then I take a screenshot "03-result-two-chart"

    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    Then I collect JSON artifact "durable-multi-result-file" from extension host expression "(async () => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const suffix = '/tests/vscode-extension-tester/runs/kusto-auth/kusto-multi-result/multi-result.kqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Multi-result document is not open'); const deadline = Date.now() + 10000; while (Date.now() < deadline) { const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri)); const file = JSON.parse(text); const query = file.state.sections.find(section => section.id === 'query_multi_result'); const chart = file.state.sections.find(section => section.id === 'chart_multi_result_two'); const batch = query?.resultJson ? JSON.parse(query.resultJson) : undefined; const second = batch?.additionalResults?.sets?.[0]; const secondRow = second?.rows?.[0]?.map(raw); const resultSetCount = 1 + (batch?.additionalResults?.sets?.length || 0); if (query?.selectedResultIndex === 1 && query?.resultArtifact?.version === 1 && resultSetCount === 3 && second?.resultIndex === 1 && secondRow?.[0] === 'second' && Number(secondRow?.[1]) === 2 && chart?.dataSourceResultIndex === 1) return { selectedResultIndex: query.selectedResultIndex, artifactId: query.resultArtifact.artifactId, resultSetCount, secondRow, chartResultIndex: chart.dataSourceResultIndex }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Durable multi-result state did not settle'); })()"

    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/kusto-auth/kusto-multi-result/multi-result.kqlx" in the editor
    When I evaluate "window.__e2e.workbench.waitForPersistedResult('query_multi_result', 19000)" in the webview "multi-result.kqlx" for 20 seconds
    When I wait for "kw-chart-section[data-test-chart-rendering='true']" in the webview "multi-result.kqlx" for 30 seconds
    When I evaluate "(() => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const table = document.getElementById('query_multi_result')?.querySelector('kw-data-table'); const picker = table?.shadowRoot?.querySelector('[data-testid=result-set-picker]'); const columns = (table?.columns || []).map(column => typeof column === 'string' ? column : column.name); const row = table?.rows?.[0] || []; if (picker?.value !== '1' || raw(row[columns.indexOf('ResultSet')]) !== 'second' || Number(raw(row[columns.indexOf('Value')])) !== 2) throw new Error('Reopened Result 2 table did not restore'); return 'reopened Result 2 table'; })()" in the webview "multi-result.kqlx"
    When I evaluate "(() => { const chart = document.getElementById('chart_multi_result_two'); const serialized = chart?.serialize?.(); const state = window.chartStateByBoxId?.chart_multi_result_two; if (!state?.__echarts?.instance || state.__wasRendering !== true) throw new Error('Reopened Result 2 chart did not render'); chart.scrollIntoView({ block: 'start' }); return { dataSourceId: serialized?.dataSourceId, dataSourceResultIndex: serialized?.dataSourceResultIndex }; })()" in the webview "multi-result.kqlx"
    Then I collect JSON artifact "reopened-multi-result" from webview expression "(() => { const raw = value => value && typeof value === 'object' ? value.full ?? value.display : value; const table = document.getElementById('query_multi_result').querySelector('kw-data-table'); const picker = table.shadowRoot.querySelector('[data-testid=result-set-picker]'); const chart = document.getElementById('chart_multi_result_two').serialize(); return { selectedResultIndex: Number(picker.value), row: table.rows[0].map(raw), chartResultIndex: chart.dataSourceResultIndex }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    And I press "Escape"
    And I wait 1 second
    Then I take a screenshot "04-reopened-result-two-chart"
    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/kusto-auth/kusto-multi-result/multi-result.kqlx"