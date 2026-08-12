Feature: Kusto toolbar, dropdown, dialog, and Copilot UX

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 900
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I capture the output channel "Kusto Workbench"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const connectionId = section?.getConnectionId?.(); const clusterUrl = section?.getClusterUrl?.(); if (!connectionId || !clusterUrl) throw new Error('Kusto connection API is not ready'); return { connectionId, clusterUrl }; })()" in the webview

  Scenario: Menus, dropdowns, dialogs, chat, and section controls preserve focus and dismiss correctly
    When I click "button[aria-label='Kusto Cluster']" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const dropdown = section?.shadowRoot?.querySelector('kw-dropdown[data-testid=cluster-dropdown]'); const button = dropdown?.shadowRoot?.querySelector('.kusto-dropdown-btn'); const menu = dropdown?.shadowRoot?.querySelector('.kusto-dropdown-menu'); if (!menu || button?.getAttribute('aria-expanded') !== 'true') throw new Error('Cluster dropdown did not open'); return { selected: dropdown.selectedId, items: dropdown.items.length }; })()" in the webview
    Then I take a screenshot "01-cluster-dropdown"
    When I press "Escape"
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const dropdown = section?.shadowRoot?.querySelector('kw-dropdown[data-testid=cluster-dropdown]'); const button = dropdown?.shadowRoot?.querySelector('.kusto-dropdown-btn'); if (dropdown?.shadowRoot?.querySelector('.kusto-dropdown-menu') || dropdown?.shadowRoot?.activeElement !== button) throw new Error('Cluster dropdown did not close and restore focus'); return 'cluster dropdown dismissed'; })()" in the webview

    When I click "button[aria-label='Kusto Database']" in the webview
    When I press "ArrowDown"
    When I press "Enter"
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 60000)" in the webview for 65 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); if (!section.getDatabase()) throw new Error('Keyboard database selection did not apply'); return section.getDatabase(); })()" in the webview
    Then I take a screenshot "02-database-selected"

    When I click "kw-query-section [id$='_run_toggle']" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const menu = document.getElementById(section.boxId + '_run_menu'); if (menu?.style.display !== 'block') throw new Error('Run menu did not open'); return 'run menu open'; })()" in the webview
    Then I take a screenshot "03-run-menu"
    When I press "Escape"
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const menu = document.getElementById(section.boxId + '_run_menu'); if (menu?.style.display !== 'none') throw new Error('Run menu did not close on Escape'); return 'run menu dismissed'; })()" in the webview

    When I click "kw-query-toolbar button[aria-label='Tools']" in the webview
    When I evaluate "(() => { const button = document.querySelector('kw-query-toolbar button[aria-label=Tools]'); if (button?.getAttribute('aria-expanded') !== 'true') throw new Error('Toolbar Tools menu did not open'); return 'tools menu open'; })()" in the webview
    Then I take a screenshot "04-toolbar-tools-menu"
    When I press "Escape"
    When I evaluate "(() => { const button = document.querySelector('kw-query-toolbar button[aria-label=Tools]'); if (button?.getAttribute('aria-expanded') !== 'false') throw new Error('Toolbar Tools menu did not close on Escape'); return 'tools menu dismissed'; })()" in the webview

    When I click "button[aria-label='Kusto Cluster']" in the webview
    When I click "[data-dropdown-action-id='__enter_new__']" in the webview
    When I wait for "[data-testid='kusto-add-connection-save']" in the webview for 10 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const form = section?.shadowRoot?.querySelector('kw-kusto-connection-form'); const cluster = form?.shadowRoot?.querySelector('[data-testid=kusto-conn-cluster-url]'); if (!cluster || form.shadowRoot.activeElement !== cluster) throw new Error('Add Connection did not focus Cluster URL'); return 'cluster input focused'; })()" in the webview
    Then I take a screenshot "05-add-connection-dialog"
    When I type "draft-only.kusto.windows.net"
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const form = section?.shadowRoot?.querySelector('kw-kusto-connection-form'); const value = form?.shadowRoot?.querySelector('[data-testid=kusto-conn-cluster-url]')?.value; if (value !== 'draft-only.kusto.windows.net') throw new Error('Add Connection draft typing did not apply: ' + value); return value; })()" in the webview
    When I press "Escape"
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const dropdown = section?.shadowRoot?.querySelector('kw-dropdown[data-testid=cluster-dropdown]'); const button = dropdown?.shadowRoot?.querySelector('.kusto-dropdown-btn'); if (section?.shadowRoot?.querySelector('.add-connection-dialog') || dropdown?.shadowRoot?.activeElement !== button) throw new Error('Add Connection did not cancel and restore cluster focus'); return 'add connection cancelled'; })()" in the webview

    When I execute command "kustoWorkbench.test.resetCopilotChatFirstTime"
    When I evaluate "window.__e2e.kusto.resetCopilotFirstTimeState()" in the webview
    When I click "kw-query-toolbar [id$='_copilot_chat_toggle']" in the webview
    When I click "Use this Copilot Chat window" on the "Visual Studio Code" dialog
    When I wait for "kw-query-section kw-copilot-chat" in the webview for 15 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const chat = section?.getCopilotChatEl?.(); const pane = document.getElementById(section.boxId + '_copilot_chat_pane'); const input = chat?.shadowRoot?.querySelector('textarea'); if (!pane || pane.classList.contains('kusto-copilot-chat-hidden') || chat?.shadowRoot?.activeElement !== input) throw new Error('Copilot chat did not open and focus input'); return 'copilot chat focused'; })()" in the webview
    Then I take a screenshot "06-copilot-chat"
    When I click "[data-testid='copilot-chat-tools']" in the webview
    When I evaluate "(() => { const chat = document.querySelector('kw-copilot-chat'); const panel = chat?.shadowRoot?.querySelector('.tools-panel'); const rect = panel?.getBoundingClientRect(); if (!panel || !rect || rect.width <= 0 || rect.top < 0 || rect.bottom > window.innerHeight) throw new Error('Copilot tools panel escaped the viewport: ' + JSON.stringify(rect?.toJSON())); return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight }; })()" in the webview
    When I scroll ".tools-panel" to the bottom
    When I evaluate "(() => { const chat = document.querySelector('kw-copilot-chat'); const panel = chat?.shadowRoot?.querySelector('.tools-panel'); const last = panel?.querySelector('.tool-item:last-child'); const panelRect = panel?.getBoundingClientRect(); const lastRect = last?.getBoundingClientRect(); if (!panelRect || !lastRect || lastRect.bottom > panelRect.bottom + 1 || lastRect.top < panelRect.top) throw new Error('Last Copilot tool is not reachable after scrolling'); return 'copilot tools open'; })()" in the webview
    Then I take a screenshot "07-copilot-tools"
    When I press "Escape"
    When I evaluate "(() => { const chat = document.querySelector('kw-copilot-chat'); if (chat?.shadowRoot?.querySelector('.tools-panel')) throw new Error('Copilot tools panel did not close on Escape'); return 'copilot tools dismissed'; })()" in the webview
    When I click "[data-testid='copilot-chat-close']" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section.boxId]; const pane = document.getElementById(section.boxId + '_copilot_chat_pane'); if (!pane?.classList.contains('kusto-copilot-chat-hidden') || !editor?.hasTextFocus?.()) throw new Error('Closing Copilot chat did not restore editor focus'); return 'copilot chat closed with editor focus'; })()" in the webview

    When I click "kw-query-section [id$='_toggle']" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); if (!section?.classList.contains('is-collapsed')) throw new Error('Section did not collapse'); return 'section collapsed'; })()" in the webview
    When I click "kw-query-section [id$='_toggle']" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const wrapper = section?.querySelector('.query-editor-wrapper'); if (section?.classList.contains('is-collapsed') || !wrapper || wrapper.getBoundingClientRect().height < 80) throw new Error('Section did not expand visibly'); return wrapper.getBoundingClientRect().height; })()" in the webview
    Then I take a screenshot "08-section-restored"
    When I execute command "workbench.action.closeAllEditors"