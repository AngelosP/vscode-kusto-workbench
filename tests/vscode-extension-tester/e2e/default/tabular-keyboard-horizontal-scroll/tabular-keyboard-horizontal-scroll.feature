Feature: Tabular keyboard horizontal scroll

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Right-arrow selection reveals columns in Kusto, SQL, and CSV tables
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I wait for "kw-query-section" in the webview for 20 seconds

    When I evaluate "(async () => { const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); const removeAll = window.__testRemoveAllSections; if (typeof removeAll === 'function') removeAll(); await sleep(300); const columnCount = 40; const rowCount = 12; const columns = Array.from({ length: columnCount }, (_, i) => ({ name: 'WideColumn_' + String(i + 1).padStart(2, '0') + '_KeyboardReveal_ResultSet', type: 'string' })); const rows = Array.from({ length: rowCount }, (_, r) => columns.map((_, c) => 'Row_' + String(r + 1).padStart(2, '0') + '_Column_' + String(c + 1).padStart(2, '0') + '_wide_value_for_keyboard_reveal')); const result = { columns, rows, metadata: { executionTime: '00:00:00.001', clientActivityId: 'tabular-keyboard-horizontal-scroll' } }; const kustoId = window.addQueryBox({ id: 'e2e_kusto_wide_table', initialQuery: 'range RowNumber from 1 to 12 step 1 | extend many_wide_columns=1', expanded: true }); window.dispatchEvent(new MessageEvent('message', { data: { type: 'queryResult', boxId: kustoId, result } })); const sqlId = window.addSqlBox({ id: 'e2e_sql_wide_table', name: 'Wide SQL table', query: 'SELECT TOP 12 * FROM keyboard_reveal_wide_table', serverUrl: 'offline-sql-e2e.database.windows.net', database: 'OfflineWarehouse', expanded: true }); window.dispatchEvent(new MessageEvent('message', { data: { type: 'queryResult', boxId: sqlId, result } })); const csvId = window.addUrlBox({ id: 'e2e_csv_wide_table', url: 'https://example.invalid/wide.csv', expanded: true }); const csvBody = [columns.map(c => c.name).join(','), ...rows.map(row => row.join(','))].join('\\n'); window.dispatchEvent(new MessageEvent('message', { data: { type: 'urlContent', boxId: csvId, url: 'https://example.invalid/wide.csv', kind: 'csv', contentType: 'text/csv', status: 200, body: csvBody } })); const getTable = kind => { if (kind === 'kusto') return document.getElementById('e2e_kusto_wide_table_results')?.querySelector('kw-data-table'); if (kind === 'sql') return document.getElementById('e2e_sql_wide_table_sql_results_body')?.querySelector('kw-data-table'); if (kind === 'csv') return document.getElementById('e2e_csv_wide_table')?.shadowRoot?.querySelector('kw-data-table'); throw new Error('Unknown table kind: ' + kind); }; const waitForTable = async kind => { for (let i = 0; i < 120; i++) { const table = getTable(kind); if (table?.shadowRoot?.querySelector('.vscroll') && (table.columns || []).length >= columnCount) return table; await sleep(100); } throw new Error('Timed out waiting for ' + kind + ' kw-data-table'); }; const tableState = table => { const scroller = table.shadowRoot.querySelector('.vscroll'); const focused = table.shadowRoot.querySelector('td.cf'); return { selectedCol: table.getSelectedCol ? table.getSelectedCol() : -1, scrollLeft: scroller?.scrollLeft ?? -1, hasFocusedCell: !!focused }; }; const dispatchCellClick = cell => { const rect = cell.getBoundingClientRect(); const x = rect.left + Math.max(2, Math.min(12, rect.width / 2)); const y = rect.top + Math.max(2, Math.min(12, rect.height / 2)); const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: x, clientY: y }; cell.dispatchEvent(new MouseEvent('mousedown', init)); cell.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 })); cell.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 })); }; const focusTable = async kind => { const table = await waitForTable(kind); if (kind === 'csv') table.style.width = '520px'; table.scrollIntoView({ block: 'center' }); if (typeof table.setSelectedCell === 'function') table.setSelectedCell(null); if (typeof table.clearSelectionRange === 'function') table.clearSelectionRange(); table.requestUpdate(); await table.updateComplete; const scroller = table.shadowRoot.querySelector('.vscroll'); if (!scroller) throw new Error(kind + ' vscroll missing'); scroller.scrollLeft = 0; const cell = table.shadowRoot.querySelector('#dt-body tbody tr td:nth-child(2)'); if (!cell) throw new Error(kind + ' first rendered data cell missing'); dispatchCellClick(cell); await table.updateComplete; scroller.focus(); await sleep(80); const state = tableState(table); if (state.selectedCol !== 0) throw new Error(kind + ' click did not select first data cell: ' + JSON.stringify(state)); if (table.shadowRoot.activeElement !== scroller) throw new Error(kind + ' vscroll did not keep keyboard focus'); return { kind, ...state }; }; const assertVisible = async (kind, minCol) => { const table = await waitForTable(kind); await table.updateComplete; await sleep(80); const scroller = table.shadowRoot.querySelector('.vscroll'); const focused = table.shadowRoot.querySelector('td.cf'); if (!scroller) throw new Error(kind + ' vscroll missing while asserting'); if (!focused) throw new Error(kind + ' selected cell marker missing'); const selectedCol = table.getSelectedCol ? table.getSelectedCol() : -1; const cellRect = focused.getBoundingClientRect(); const viewRect = scroller.getBoundingClientRect(); const leftLimit = viewRect.left + 40; if (selectedCol < minCol) throw new Error(kind + ' selected column did not move far enough: ' + selectedCol + ', expected at least ' + minCol); if (minCol >= 8 && scroller.scrollLeft <= 0) throw new Error(kind + ' horizontal scroll did not move; selectedCol=' + selectedCol); if (cellRect.right > viewRect.right + 2 || cellRect.left < leftLimit - 2) throw new Error(kind + ' selected column is not visible after keyboard navigation: cell=' + JSON.stringify({ left: cellRect.left, right: cellRect.right }) + ', view=' + JSON.stringify({ left: viewRect.left, right: viewRect.right }) + ', scrollLeft=' + scroller.scrollLeft + ', selectedCol=' + selectedCol); return { kind, selectedCol, scrollLeft: scroller.scrollLeft, visible: true }; }; window.__e2eTabularKeyboardScroll = { focusTable, assertVisible }; return { kusto: await focusTable('kusto'), sqlReady: !!(await waitForTable('sql')), csvReady: !!(await waitForTable('csv')) }; })()" in the webview for 25 seconds
    When I evaluate "(() => { const getTable = kind => kind === 'kusto' ? document.getElementById('e2e_kusto_wide_table_results')?.querySelector('kw-data-table') : kind === 'sql' ? document.getElementById('e2e_sql_wide_table_sql_results_body')?.querySelector('kw-data-table') : document.getElementById('e2e_csv_wide_table')?.shadowRoot?.querySelector('kw-data-table'); window.__e2eAssertActiveKwScroller = async (kind, minCol) => { const table = getTable(kind); if (!table) throw new Error(kind + ' table missing'); await table.updateComplete; const scroller = table._vScrollCtrl?.getScrollElement?.() || table.shadowRoot?.querySelector('.vscroll'); const focused = table.shadowRoot?.querySelector('td.cf'); if (!scroller || !focused) throw new Error(kind + ' active scroller or focused cell missing'); const selectedCol = table.getSelectedCol ? table.getSelectedCol() : -1; const cellRect = focused.getBoundingClientRect(); const viewRect = scroller.getBoundingClientRect(); if (selectedCol < minCol) throw new Error(kind + ' selectedCol=' + selectedCol + ', expected ' + minCol); if (scroller.scrollLeft <= 0) throw new Error(kind + ' active viewport did not scroll; selectedCol=' + selectedCol); if (cellRect.right > viewRect.right + 2 || cellRect.left < viewRect.left + 38) throw new Error(kind + ' selected cell outside active viewport: cell=' + JSON.stringify({ left: cellRect.left, right: cellRect.right }) + ', view=' + JSON.stringify({ left: viewRect.left, right: viewRect.right }) + ', scrollLeft=' + scroller.scrollLeft); return { kind, selectedCol, scrollLeft: scroller.scrollLeft }; }; return 'active scroller assertion installed'; })()" in the webview for 10 seconds

    When I evaluate "window.__e2eTabularKeyboardScroll.focusTable('kusto')" in the webview for 10 seconds
    When I evaluate "(() => { document.body.tabIndex = -1; document.body.focus(); return document.activeElement === document.body ? 'body focused' : 'active=' + document.activeElement?.tagName; })()" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('kusto', 4)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('kusto', 8)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('kusto', 12)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('kusto', 16)" in the webview for 10 seconds
    When I evaluate "window.__e2eAssertActiveKwScroller('kusto', 16)" in the webview for 10 seconds

    When I evaluate "window.__e2eTabularKeyboardScroll.focusTable('sql')" in the webview for 10 seconds
    When I evaluate "(() => { document.body.tabIndex = -1; document.body.focus(); return document.activeElement === document.body ? 'body focused' : 'active=' + document.activeElement?.tagName; })()" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('sql', 4)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('sql', 8)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('sql', 12)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('sql', 16)" in the webview for 10 seconds
    When I evaluate "window.__e2eAssertActiveKwScroller('sql', 16)" in the webview for 10 seconds

    When I evaluate "window.__e2eTabularKeyboardScroll.focusTable('csv')" in the webview for 10 seconds
    When I evaluate "(() => { document.body.tabIndex = -1; document.body.focus(); return document.activeElement === document.body ? 'body focused' : 'active=' + document.activeElement?.tagName; })()" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('csv', 4)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('csv', 8)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('csv', 12)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eTabularKeyboardScroll.assertVisible('csv', 16)" in the webview for 10 seconds
    When I evaluate "window.__e2eAssertActiveKwScroller('csv', 16)" in the webview for 10 seconds