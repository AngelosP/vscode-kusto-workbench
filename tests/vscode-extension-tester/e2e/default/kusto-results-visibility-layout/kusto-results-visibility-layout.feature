Feature: Kusto programmatic results visibility layout

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 800
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "kusto.openQueryEditor"
    And I wait for "body[data-kusto-e2e-ready='true']" in the webview "session.kqlx" for 20 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section" in the webview for 10 seconds

  Scenario: Programmatic hide removes the results gap and restores its height
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); if (!section?.displayResult?.({ columns: [{ name: 'Value', type: 'int' }], rows: [[1], [2], [3]], metadata: { executionTime: '0.01s' } })) throw new Error('Could not render Kusto results'); return section.boxId; })()" in the webview
    When I wait for "kw-query-section kw-data-table" in the webview for 10 seconds
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = document.getElementById(section.boxId + '_results_wrapper'); wrapper.style.height = '300px'; wrapper.dataset.kustoUserResized = 'true'; section.executionCtrl.setResultsVisible(false); return wrapper.style.height; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = document.getElementById(section.boxId + '_results_wrapper'); const resizer = document.getElementById(section.boxId + '_results_resizer'); const table = section.querySelector('kw-data-table'); const viewport = table?.shadowRoot?.querySelector('.vscroll'); const height = wrapper?.getBoundingClientRect().height || 0; const viewportHeight = viewport?.getBoundingClientRect().height || 0; if (wrapper?.style.height !== '48px' || height > 64 || viewportHeight > 0 || resizer?.style.display !== 'none') throw new Error('Programmatic results hide left blank space: ' + JSON.stringify({ inlineHeight: wrapper?.style.height, height, viewportHeight, resizer: resizer?.style.display })); return { height, viewportHeight }; })()" in the webview
    Then I take a screenshot "01-programmatic-results-hidden"
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); section.executionCtrl.setResultsVisible(true); return 'shown'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = document.getElementById(section.boxId + '_results_wrapper'); const resizer = document.getElementById(section.boxId + '_results_resizer'); const table = section.querySelector('kw-data-table'); const viewport = table?.shadowRoot?.querySelector('.vscroll'); const height = wrapper?.getBoundingClientRect().height || 0; const viewportHeight = viewport?.getBoundingClientRect().height || 0; if (wrapper?.style.height !== '300px' || height < 280 || viewportHeight <= 0 || resizer?.style.display === 'none') throw new Error('Programmatic results show did not restore layout: ' + JSON.stringify({ inlineHeight: wrapper?.style.height, height, viewportHeight, resizer: resizer?.style.display })); return { height, viewportHeight }; })()" in the webview
    Then I take a screenshot "02-programmatic-results-restored"
    When I execute command "workbench.action.closeAllEditors"

  Scenario: Revealing initially hidden results fits their content
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); section.executionCtrl.setResultsVisible(false); if (!section?.displayResult?.({ columns: [{ name: 'Month', type: 'datetime' }, { name: 'Count', type: 'long' }], rows: [['2026-05-01', 33980], ['2026-06-01', 163834], ['2026-07-01', 97726], ['2026-08-01', 62425]], metadata: { executionTime: '0.13s' } })) throw new Error('Could not render initially hidden Kusto results'); return section.boxId; })()" in the webview
    When I wait for "kw-query-section kw-data-table" in the webview for 10 seconds
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = document.getElementById(section.boxId + '_results_wrapper'); if (wrapper?.style.height !== '48px') throw new Error('Initially hidden results were not compact: ' + wrapper?.style.height); const table = section.querySelector('kw-data-table'); table.setBodyVisible(true); return 'revealed'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = document.getElementById(section.boxId + '_results_wrapper'); const table = section.querySelector('kw-data-table'); const contentHeight = table?.getContentHeight?.() || 0; const expectedHeight = Math.max(120, Math.min(400, Math.ceil(contentHeight + 20))); const actualHeight = wrapper?.getBoundingClientRect().height || 0; if (wrapper?.style.height === '300px' || Math.abs(actualHeight - expectedHeight) > 2) throw new Error('Revealed results did not fit content: ' + JSON.stringify({ inlineHeight: wrapper?.style.height, actualHeight, contentHeight, expectedHeight })); return { actualHeight, contentHeight, expectedHeight }; })()" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); document.getElementById(section.boxId + '_results_wrapper')?.scrollIntoView({ block: 'center' }); return 'centered fitted results'; })()" in the webview
    And I wait 1 second
    Then I take a screenshot "03-initially-hidden-results-fitted"
    When I execute command "workbench.action.closeAllEditors"