Feature: Kusto surrounding UX controls

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I capture the output channel "Kusto Workbench"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 60000)" in the webview for 65 seconds

  Scenario: Result table tools remain interactive, dismissable, and visible
    When I evaluate "window.__e2e.kusto.selectRunMode('plain')" in the webview
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`datatable(Timestamp:datetime, User:string, Action:string, DurationMs:long) [datetime(2026-05-01 09:00:00), 'alex', 'Checkout', 138, datetime(2026-05-01 09:02:00), 'bianca', 'Search', 82, datetime(2026-05-01 09:05:00), 'chen', 'Export', 211] | extend Details = case(User == 'alex', bag_pack('requestId', 'R-1001', 'retryPolicy', 'fast-path', 'country', 'US'), User == 'bianca', bag_pack('requestId', 'R-1002', 'query', 'chart zoom', 'country', 'GB'), bag_pack('requestId', 'R-1003', 'format', 'csv', 'retryPolicy', 'none', 'country', 'CA')) | project Timestamp, User, Action, Details, DurationMs`)" in the webview
    When I evaluate "window.__e2e.kusto.assertRunEnabled()" in the webview
    When I click "kw-query-section [id$='_run_btn']" in the webview
    When I wait for "kw-query-section[data-test-executing='false']" in the webview for 30 seconds
    When I evaluate "(() => { window.__e2e.kusto.assertNoError(); window.__e2e.kusto.assertResultColumns('Timestamp,User,Action,Details,DurationMs'); window.__e2e.kusto.assertRowCount(3); return window.__e2e.kusto.ux.assertRenderedRows(3); })()" in the webview
    When I evaluate "(() => { const table = document.querySelector('kw-query-section kw-data-table'); if (!table) throw new Error('Rendered Kusto result table was not found for scrolling'); table.scrollIntoView({ block: 'center' }); return table.getBoundingClientRect().toJSON(); })()" in the webview

    When I click "button[title='Search data']" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertPopup('search', true)" in the webview
    When I click "input.search-input" in the webview
    When I type "retryPolicy"
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.ux.assertSearch('retryPolicy', 2)" in the webview
    Then I take a screenshot "01-table-search"
    When I click "button[aria-label='Wildcard mode']" in the webview
    When I evaluate "(() => { const table = document.querySelector('kw-query-section kw-data-table'); if (table?._searchCtrl?.mode !== 'regex') throw new Error('Search mode did not switch to regex'); return 'regex search mode active'; })()" in the webview
    When I press "Escape"
    When I evaluate "window.__e2e.kusto.ux.assertPopup('search', false)" in the webview

    When I click "button[title='Scroll to row']" in the webview
    When I click "input.row-jump-inp" in the webview
    When I type "3"
    When I press "Enter"
    When I evaluate "window.__e2e.kusto.ux.assertSelectedRow(3)" in the webview
    Then I take a screenshot "02-row-jump"
    When I press "Escape"
    When I evaluate "window.__e2e.kusto.ux.assertPopup('rowJump', false)" in the webview

    When I click "button[title='Scroll to column']" in the webview
    When I click "input.cj-inp" in the webview
    When I type "DurationMs"
    When I press "Enter"
    When I evaluate "window.__e2e.kusto.ux.assertColumnVisible('DurationMs')" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertPopup('columnJump', false)" in the webview

    When I click "button[title='Sort']" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertPopup('sort', true)" in the webview
    Then I take a screenshot "03-sort-dialog"
    When I click "[data-testid='sort-add-column']" in the webview
    When I press "ArrowDown"
    When I press "ArrowDown"
    When I press "ArrowDown"
    When I press "ArrowDown"
    When I press "ArrowDown"
    When I press "Enter"
    When I click "[data-testid='sort-add-direction']" in the webview
    When I press "ArrowDown"
    When I press "Enter"
    When I move the Dev Host to 0, 0
    When I evaluate "(() => { const table = document.querySelector('kw-query-section kw-data-table'); const dialog = table?.shadowRoot?.querySelector('kw-sort-dialog'); const column = dialog?.shadowRoot?.querySelector('[data-testid=sort-add-column]'); const direction = dialog?.shadowRoot?.querySelector('[data-testid=sort-add-direction]'); if (column?.value !== '4' || direction?.value !== 'desc') throw new Error('Sort controls did not accept keyboard input: ' + JSON.stringify({ column: column?.value, direction: direction?.value })); return { column: column.value, direction: direction.value }; })()" in the webview
    When I click "[data-testid='sort-apply']" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.ux.assertFirstRow('DurationMs', '211')" in the webview
    When I evaluate "(() => { const table = document.querySelector('kw-query-section kw-data-table'); table?._clearSort(); return 'sort dialog state cleaned up'; })()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.ux.assertFirstRow('User', 'alex')" in the webview

    When I click "button[aria-label='Column menu for User']" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertPopup('columnMenu', true)" in the webview
    Then I take a screenshot "04-column-menu"
    When I click ".cm [data-action='sort-descending']" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.ux.assertFirstRow('User', 'chen')" in the webview
    Then I take a screenshot "05-column-sort-applied"
    When I click "button[title='Clear sort']" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.ux.assertFirstRow('User', 'alex')" in the webview

    When I click "button[aria-label='Column menu for User']" in the webview
    When I click ".cm [data-action='filter']" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertPopup('filter', true)" in the webview
    When I click ".fd-actions button:last-child" in the webview
    When I click "[data-filter-value='bianca'] input" in the webview
    When I click "[data-testid='filter-apply']" in the webview
    And I wait 1 second
    When I evaluate "(() => { window.__e2e.kusto.ux.assertRenderedRows(1); return window.__e2e.kusto.ux.assertFirstRow('User', 'bianca'); })()" in the webview
    Then I take a screenshot "06-filtered-table"
    When I click ".filtered-link" in the webview
    When I click "[data-testid='filter-remove']" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.ux.assertRenderedRows(3)" in the webview

    When I click "button[aria-label='Column menu for User']" in the webview
    When I click ".cm [data-action='unique-values']" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertPopup('uniqueValues', true)" in the webview
    Then I take a screenshot "07-unique-values"
    When I press "Escape"
    When I evaluate "window.__e2e.kusto.ux.assertPopup('uniqueValues', false)" in the webview

    When I click "td.obj-cell a.obj-link" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertObjectViewer('requestId')" in the webview
    Then I take a screenshot "08-object-viewer"
    When I press "Escape"
    When I evaluate "window.__e2e.kusto.ux.assertPopup('objectViewer', false)" in the webview

    When I click "button[title='Hide results']" in the webview
    When I evaluate "window.__e2e.kusto.ux.assertResultsVisible(false)" in the webview
    Then I take a screenshot "09-results-hidden"
    When I click "button[title='Show results']" in the webview
    When I evaluate "(() => { window.__e2e.kusto.ux.assertResultsVisible(true); return window.__e2e.kusto.ux.assertRenderedRows(3); })()" in the webview

    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = document.getElementById(section.boxId + '_results_wrapper'); wrapper.style.height = '300px'; wrapper.dataset.kustoUserResized = 'true'; window.__kustoUxResultsHeightBefore = wrapper.getBoundingClientRect().height; return window.__kustoUxResultsHeightBefore; })()" in the webview
    When I double click "kw-query-section [id$='_results_resizer']" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = document.getElementById(section.boxId + '_results_wrapper'); const before = Number(window.__kustoUxResultsHeightBefore); const after = wrapper?.getBoundingClientRect().height || 0; if (after < 80 || after > 750 || before - after < 20) throw new Error('Result auto-fit did not visibly change height: ' + JSON.stringify({ before, after })); return { before, after }; })()" in the webview
    Then I take a screenshot "10-results-restored-and-fit"
    When I execute command "workbench.action.closeAllEditors"