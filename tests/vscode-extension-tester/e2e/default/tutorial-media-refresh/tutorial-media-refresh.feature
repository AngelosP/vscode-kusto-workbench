@screenshot-generator
Feature: Capture refreshed Did you know tutorial media

  Scenario: Add section picker with Transformation highlighted
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 620
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second
    When I wait for "button[data-add-kind='transformation']" in the webview for 20 seconds
    When I evaluate "(() => { const btn = document.querySelector('button[data-add-kind=transformation]'); if (!btn) throw new Error('Transformation add button not found'); btn.scrollIntoView({ block: 'center', inline: 'center' }); btn.style.background = 'var(--vscode-list-hoverBackground)'; btn.style.outline = '2px solid var(--vscode-focusBorder)'; btn.style.outlineOffset = '2px'; return 'highlighted ' + (btn.textContent || '').trim(); })()" in the webview
    And I wait 1 second
    Then I take a screenshot "01-add-transformation"

  Scenario: Result table search and column tools
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 980 by 760
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    When I open file "tests/vscode-extension-tester/e2e/default/tutorial-media-refresh/fixtures/results-showcase.kqlx" in the editor
    And I wait 6 seconds
    When I wait for "kw-data-table" in the webview for 20 seconds
    When I evaluate "(async () => { const section = document.getElementById('query_results_showcase'); if (!section) throw new Error('Result query section not found'); section.scrollIntoView({ block: 'start' }); const table = section.shadowRoot?.querySelector('kw-data-table') || section.querySelector('kw-data-table') || document.querySelector('kw-data-table'); if (!table) throw new Error('Data table not found'); const search = table._searchCtrl; if (!search) throw new Error('Search controller not found'); search.visible = true; search.mode = 'wildcard'; search.setQuery('retryPolicy'); if (typeof search._execSearch === 'function') search._execSearch(); table.requestUpdate(); await table.updateComplete; const bar = table.shadowRoot?.querySelector('kw-search-bar'); if (!bar) throw new Error('Search bar not rendered'); await bar.updateComplete; const link = table.shadowRoot?.querySelector('td.mc.obj-cell .obj-link'); if (!link) throw new Error('Current JSON match with View link not visible'); return 'search matches=' + search.matches.length; })()" in the webview for 10 seconds
    And I wait 1 second
    Then I take a screenshot "02-results-search-json"
    When I evaluate "(async () => { const table = document.querySelector('kw-query-section')?.shadowRoot?.querySelector('kw-data-table') || document.querySelector('kw-data-table'); if (!table) throw new Error('Data table not found'); const bar = table.shadowRoot?.querySelector('kw-search-bar'); if (!bar) throw new Error('Search bar not found'); await bar.updateComplete; const btn = bar.shadowRoot?.querySelector('.mode-toggle'); if (!btn) throw new Error('Search mode toggle not found'); btn.style.background = 'var(--vscode-list-hoverBackground)'; btn.style.outline = '2px solid var(--vscode-focusBorder)'; btn.style.outlineOffset = '2px'; btn.scrollIntoView({ block: 'center', inline: 'center' }); return btn.getAttribute('title') || 'highlighted mode toggle'; })()" in the webview for 10 seconds
    And I wait 1 second
    Then I take a screenshot "03-results-search-regex-toggle"
    When I evaluate "(async () => { const table = document.querySelector('kw-query-section')?.shadowRoot?.querySelector('kw-data-table') || document.querySelector('kw-data-table'); if (!table) throw new Error('Data table not found'); const header = Array.from(table.shadowRoot?.querySelectorAll('th') || []).find(th => (th.textContent || '').includes('Details')); if (!header) throw new Error('Details column header not found'); const btn = header.querySelector('.cm-btn'); if (!btn) throw new Error('Column menu button not found'); btn.click(); table.requestUpdate(); await table.updateComplete; const menu = table.shadowRoot?.querySelector('.cm'); if (!menu || !menu.textContent.includes('Show unique values')) throw new Error('Column menu did not open with analysis actions'); return 'column menu opened'; })()" in the webview for 10 seconds
    And I wait 1 second
    Then I take a screenshot "04-results-column-menu"

  Scenario: Command Palette entry for the Kusto query editor
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 860 by 480
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    When I start command "workbench.action.showCommands"
    And I wait 1 second
    When I type "Kusto Workbench: Open Query Editor"
    And I wait 1 second
    Then I take a screenshot "05-editor-first-query"

  Scenario: Kusto Workbench agent schema-search prompt
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 560 by 430
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    When I execute command "workbench.action.chat.openInEditor"
    And I wait 1 second
    And I execute command "workbench.action.chat.open" with args '[{"mode":"Kusto Workbench","query":"Find where product adoption is recorded. Search saved connection schemas exhaustively, list candidate tables and columns with confidence, then wait before running queries.","isPartialQuery":true}]'
    And I wait 1 second
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "workbench.action.chat.focusInput"
    And I wait 1 second
    Then I take a screenshot "06-agent-schema-search"

  Scenario: Query toolbar run mode dropdown
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 620
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); if (!section) throw new Error('Query section not found'); section.scrollIntoView({ block: 'start' }); const wrapper = document.getElementById(section.boxId + '_query_editor'); if (wrapper) { wrapper.style.height = '170px'; wrapper.style.minHeight = '170px'; } const toggle = document.getElementById(section.boxId + '_run_toggle'); if (!toggle) throw new Error('Run mode toggle not found'); const menu = document.getElementById(section.boxId + '_run_menu'); if (!menu || !menu.textContent.includes('Run Query')) throw new Error('Run mode menu not found'); const rect = toggle.getBoundingClientRect(); menu.style.display = 'block'; menu.style.position = 'fixed'; menu.style.left = Math.max(8, Math.round(rect.left - 6)) + 'px'; menu.style.top = Math.max(8, Math.round(rect.top - 118)) + 'px'; menu.style.zIndex = '99999'; menu.style.minWidth = '230px'; return 'run menu pinned open'; })()" in the webview
    And I wait 1 second
    Then I take a screenshot "07-editor-run-modes"

  Scenario: Integrated Copilot chat inside a query section
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 980 by 720
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I evaluate "(async () => { const section = document.querySelector('kw-query-section'); if (!section) throw new Error('Query section not found'); section.scrollIntoView({ block: 'start' }); if (typeof section.setCopilotChatWidthPx === 'function') section.setCopilotChatWidthPx(360); if (typeof section.setCopilotChatVisible !== 'function') throw new Error('Query section does not expose setCopilotChatVisible'); section.setCopilotChatVisible(true); await new Promise(resolve => setTimeout(resolve, 500)); const chat = section.getCopilotChatEl?.(); if (!chat) throw new Error('Integrated Copilot chat not installed'); chat.appendMessage('user', 'Improve this query and keep the result shape stable.'); chat.appendMessage('assistant', 'I can edit this section directly and keep the query beside the conversation.'); await chat.updateComplete; return 'copilot chat ready'; })()" in the webview for 10 seconds
    And I wait 1 second
    Then I take a screenshot "08-copilot-integrated-chat"

  Scenario: Chart connections, type controls, axis settings, and zoom
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 980 by 800
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    When I open file "tests/vscode-extension-tester/e2e/default/tutorial-media-refresh/fixtures/chart-showcase.kqlx" in the editor
    And I wait 7 seconds
    When I wait for "#chart_zoom_example_chart_zoom_select" in the webview for 20 seconds
    When I evaluate "(() => { const source = document.getElementById('query_zoom_series'); const chart = document.getElementById('chart_zoom_example'); if (!source || !chart) throw new Error('Expected source query and chart sections'); source.scrollIntoView({ block: 'start' }); return 'source and chart visible'; })()" in the webview
    And I wait 1 second
    Then I take a screenshot "09-chart-live"
    When I evaluate "(async () => { const chart = document.getElementById('chart_zoom_example'); if (!chart) throw new Error('Chart section not found'); chart.scrollIntoView({ block: 'start' }); await chart.updateComplete; const active = chart.shadowRoot?.querySelector('.chart-type-btn.is-active'); if (!active || !active.textContent.includes('Line')) throw new Error('Line chart type button is not active'); return 'chart type row ready'; })()" in the webview for 10 seconds
    And I wait 1 second
    Then I take a screenshot "10-chart-types"
    When I evaluate "(async () => { const chart = document.getElementById('chart_zoom_example'); if (!chart) throw new Error('Chart section not found'); chart.scrollIntoView({ block: 'start' }); await chart.updateComplete; const label = chart.shadowRoot?.querySelector('.axis-label-clickable[data-axis=y]'); if (!label) throw new Error('Y-axis clickable label not found'); label.click(); await chart.updateComplete; const pop = chart.shadowRoot?.querySelector('kw-popover'); if (!pop || !pop.textContent.includes('Range')) throw new Error('Y-axis settings popover did not open'); return 'y-axis popover opened'; })()" in the webview for 10 seconds
    And I wait 1 second
    Then I take a screenshot "11-chart-axis-settings"
    When I evaluate "(async () => { const chart = document.getElementById('chart_zoom_example'); if (!chart) throw new Error('Chart section not found'); if (typeof chart._closeAxisPopup === 'function') chart._closeAxisPopup(); chart.scrollIntoView({ block: 'start' }); await chart.updateComplete; const button = document.getElementById('chart_zoom_example_chart_zoom_select'); const controls = document.getElementById('chart_zoom_example_chart_zoom_controls'); if (!button || button.hidden) throw new Error('Zoom button is not available'); if (controls) { controls.style.opacity = '1'; controls.style.pointerEvents = 'auto'; } try { window.sessionStorage.removeItem('kustoWorkbench.chartZoomHintShown'); } catch {} delete window.__kustoZoomPanHintShown; button.focus(); button.click(); const hint = document.getElementById('chart_zoom_example_chart_zoom_hint'); if (!hint || hint.hidden || !hint.textContent.includes('Drag a rectangle')) throw new Error('Zoom hint did not appear'); return 'zoom control and hint visible'; })()" in the webview for 10 seconds
    And I wait 1 second
    Then I take a screenshot "12-chart-zoom"