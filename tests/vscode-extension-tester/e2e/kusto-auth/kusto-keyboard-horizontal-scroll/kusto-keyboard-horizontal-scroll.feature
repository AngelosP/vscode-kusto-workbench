Feature: Kusto result keyboard horizontal scroll

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Right-arrow selection reveals columns in a real Kusto result table
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds

    When I evaluate "(() => { const cols = Array.from({ length: 40 }, (_, i) => { const n = String(i + 1).padStart(2, '0'); return 'WideColumn_' + n + '_KeyboardReveal = strcat(\'row_\', tostring(RowNumber), \'_column_' + n + '_wide_value_for_keyboard_reveal\')'; }); const query = 'range RowNumber from 1 to 30 step 1\n| extend ' + cols.join(',\n         '); window.__e2e.kusto.setQuery(query); return query; })()" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 45 seconds
    And I wait 1 second

    When I evaluate "(async () => { const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); const section = document.querySelector('kw-query-section'); const table = document.getElementById(section.boxId + '_results')?.querySelector('kw-data-table'); if (!table) throw new Error('No real Kusto data table found'); const waitForTable = async () => { for (let i = 0; i < 80; i++) { if (table.shadowRoot?.querySelector('.vscroll') && (table.columns || []).length >= 40) return table; await sleep(100); } throw new Error('Timed out waiting for wide real Kusto table; cols=' + (table.columns || []).length); }; const dispatchCellClick = cell => { const rect = cell.getBoundingClientRect(); const x = rect.left + Math.max(2, Math.min(12, rect.width / 2)); const y = rect.top + Math.max(2, Math.min(12, rect.height / 2)); const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, clientX: x, clientY: y }; cell.dispatchEvent(new MouseEvent('mousedown', init)); cell.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 })); cell.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 })); }; const focusTable = async () => { const table = await waitForTable(); table.scrollIntoView({ block: 'center' }); if (typeof table.setSelectedCell === 'function') table.setSelectedCell(null); if (typeof table.clearSelectionRange === 'function') table.clearSelectionRange(); table.requestUpdate(); await table.updateComplete; const scroller = table.shadowRoot.querySelector('.vscroll'); if (!scroller) throw new Error('vscroll missing'); scroller.scrollLeft = 0; const cell = table.shadowRoot.querySelector('#dt-body tbody tr td:nth-child(2)'); if (!cell) throw new Error('first rendered real Kusto data cell missing'); dispatchCellClick(cell); await table.updateComplete; scroller.focus(); await sleep(80); const selectedCol = table.getSelectedCol ? table.getSelectedCol() : -1; if (selectedCol !== 0) throw new Error('real Kusto click did not select first data cell; selectedCol=' + selectedCol); return { selectedCol, scrollLeft: scroller.scrollLeft, rows: (table.rows || []).length, cols: (table.columns || []).length }; }; const assertVisible = async minCol => { const table = await waitForTable(); await table.updateComplete; await sleep(80); const scroller = table.shadowRoot.querySelector('.vscroll'); const focused = table.shadowRoot.querySelector('td.cf'); if (!scroller) throw new Error('vscroll missing while asserting'); if (!focused) throw new Error('selected cell marker missing'); const selectedCol = table.getSelectedCol ? table.getSelectedCol() : -1; const cellRect = focused.getBoundingClientRect(); const viewRect = scroller.getBoundingClientRect(); const leftLimit = viewRect.left + 40; if (selectedCol < minCol) throw new Error('selected column did not move far enough: ' + selectedCol + ', expected at least ' + minCol); if (minCol >= 8 && scroller.scrollLeft <= 0) throw new Error('real Kusto horizontal scroll did not move; selectedCol=' + selectedCol); if (cellRect.right > viewRect.right + 2 || cellRect.left < leftLimit - 2) throw new Error('real Kusto selected column is not visible: cell=' + JSON.stringify({ left: cellRect.left, right: cellRect.right }) + ', view=' + JSON.stringify({ left: viewRect.left, right: viewRect.right }) + ', scrollLeft=' + scroller.scrollLeft + ', selectedCol=' + selectedCol); return { selectedCol, scrollLeft: scroller.scrollLeft, visible: true }; }; window.__e2eRealKustoKeyboardScroll = { focusTable, assertVisible }; return focusTable(); })()" in the webview for 15 seconds
    When I evaluate "(() => { document.body.tabIndex = -1; document.body.focus(); return document.activeElement === document.body ? 'body focused' : 'active=' + document.activeElement?.tagName; })()" in the webview for 10 seconds

    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eRealKustoKeyboardScroll.assertVisible(4)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eRealKustoKeyboardScroll.assertVisible(8)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eRealKustoKeyboardScroll.assertVisible(12)" in the webview for 10 seconds
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I evaluate "window.__e2eRealKustoKeyboardScroll.assertVisible(16)" in the webview for 10 seconds
    When I evaluate "(async () => { const section = document.querySelector('kw-query-section'); const table = document.getElementById(section.boxId + '_results')?.querySelector('kw-data-table'); if (!table) throw new Error('No real Kusto data table found for active viewport assertion'); await table.updateComplete; const scroller = table._vScrollCtrl?.getScrollElement?.() || table.shadowRoot?.querySelector('.vscroll'); const focused = table.shadowRoot?.querySelector('td.cf'); if (!scroller || !focused) throw new Error('Missing active scroller or focused cell'); const selectedCol = table.getSelectedCol ? table.getSelectedCol() : -1; const cellRect = focused.getBoundingClientRect(); const viewRect = scroller.getBoundingClientRect(); if (selectedCol < 16) throw new Error('Expected selected column >= 16, got ' + selectedCol); if (scroller.scrollLeft <= 0) throw new Error('Active Kusto result viewport did not scroll; selectedCol=' + selectedCol); if (cellRect.right > viewRect.right + 2 || cellRect.left < viewRect.left + 38) throw new Error('Selected Kusto cell outside active viewport: cell=' + JSON.stringify({ left: cellRect.left, right: cellRect.right }) + ', view=' + JSON.stringify({ left: viewRect.left, right: viewRect.right }) + ', scrollLeft=' + scroller.scrollLeft); return { selectedCol, scrollLeft: scroller.scrollLeft }; })()" in the webview for 10 seconds