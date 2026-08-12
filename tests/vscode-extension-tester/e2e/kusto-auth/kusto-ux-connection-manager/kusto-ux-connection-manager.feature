Feature: Kusto Connection Manager surrounding UX

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1100 by 900
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    When I execute command "kusto.manageConnections"
    When I wait for "[data-testid='cm-add-connection']" in the webview "Connection Manager" for 20 seconds
    When I wait for "[data-testid='cm-explorer-panel'][data-test-kind='kusto']" in the webview "Connection Manager" for 20 seconds

  Scenario: Add and edit dialogs preserve focus and never save cancelled drafts
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const root = manager?.shadowRoot; const names = [...(root?.querySelectorAll('[data-testid=cm-kusto-connection-row] .explorer-list-item-name') || [])].map(node => node.textContent?.trim()); if (!names.length) throw new Error('No Kusto connection rows are available'); window.__cmUxOriginalNames = names; return names; })()" in the webview "Connection Manager"

    When I click "[data-testid='cm-add-connection']" in the webview "Connection Manager"
    When I wait for "[data-testid='cm-modal-save']" in the webview "Connection Manager" for 10 seconds
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const form = manager?.shadowRoot?.querySelector('kw-kusto-connection-form'); const cluster = form?.shadowRoot?.querySelector('[data-testid=kusto-conn-cluster-url]'); const modal = manager?.shadowRoot?.querySelector('[data-testid=cm-modal-content]'); if (!modal || modal.getAttribute('role') !== 'dialog' || form?.shadowRoot?.activeElement !== cluster) throw new Error('Add modal is not accessible or focused'); return 'add modal focused'; })()" in the webview "Connection Manager"
    Then I take a screenshot "01-manager-add-dialog"

    When I click "[data-testid='kusto-conn-test']" in the webview "Connection Manager"
    When I wait for "[data-testid='kusto-conn-test-result']" in the webview "Connection Manager" for 10 seconds
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const form = manager?.shadowRoot?.querySelector('kw-kusto-connection-form'); const text = form?.shadowRoot?.querySelector('[data-testid=kusto-conn-test-result]')?.textContent || ''; if (!text.includes('Enter a cluster URL')) throw new Error('Empty Test Connection feedback missing: ' + text); return text; })()" in the webview "Connection Manager"
    Then I take a screenshot "02-manager-validation"

    When I click "[data-testid='kusto-conn-cluster-url']" in the webview "Connection Manager"
    When I type "draft-only.kusto.windows.net"
    When I click "[data-testid='cm-modal-cancel']" in the webview "Connection Manager"
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const root = manager?.shadowRoot; const add = root?.querySelector('[data-testid=cm-add-connection]'); const names = [...(root?.querySelectorAll('[data-testid=cm-kusto-connection-row] .explorer-list-item-name') || [])].map(node => node.textContent?.trim()); if (root?.querySelector('[data-testid=cm-modal-overlay]') || root?.activeElement !== add || names.some(name => name?.includes('draft-only'))) throw new Error('Cancelled add draft leaked or focus was lost'); return 'add draft cancelled'; })()" in the webview "Connection Manager"

    When I click "[data-testid='cm-kusto-connection-row'] button[title='Edit']" in the webview "Connection Manager"
    When I wait for "[data-testid='cm-modal-save']" in the webview "Connection Manager" for 10 seconds
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const root = manager?.shadowRoot; const form = root?.querySelector('kw-kusto-connection-form'); const cluster = form?.shadowRoot?.querySelector('[data-testid=kusto-conn-cluster-url]'); const heading = root?.querySelector('#cm-kusto-modal-title')?.textContent?.trim(); if (heading !== 'Edit Connection' || !cluster?.value || form?.shadowRoot?.activeElement !== cluster) throw new Error('Edit modal did not restore values and focus'); return { heading, clusterUrl: cluster.value }; })()" in the webview "Connection Manager"
    Then I take a screenshot "03-manager-edit-dialog"

    When I click "[data-testid='kusto-conn-name']" in the webview "Connection Manager"
    When I press "Ctrl+A"
    When I type "Do Not Save This Name"
    When I press "Escape"
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const root = manager?.shadowRoot; const names = [...(root?.querySelectorAll('[data-testid=cm-kusto-connection-row] .explorer-list-item-name') || [])].map(node => node.textContent?.trim()); const active = root?.activeElement; if (root?.querySelector('[data-testid=cm-modal-overlay]') || active?.getAttribute('title') !== 'Edit' || names.some(name => name === 'Do Not Save This Name') || JSON.stringify(names) !== JSON.stringify(window.__cmUxOriginalNames)) throw new Error('Cancelled edit draft leaked or focus was lost: ' + JSON.stringify({ names, activeTitle: active?.getAttribute('title') })); return 'edit draft cancelled'; })()" in the webview "Connection Manager"

    When I click "[data-testid='cm-filter-search']" in the webview "Connection Manager"
    When I wait for "[data-testid='cm-search-input']" in the webview "Connection Manager" for 10 seconds
    When I click ".search-refresh-drop" in the webview "Connection Manager"
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const menu = manager?.shadowRoot?.querySelector('.search-refresh-menu'); if (!menu || menu.getBoundingClientRect().width <= 0 || !menu.textContent.includes('Refresh all connections')) throw new Error('Search refresh menu did not open visibly'); return 'refresh menu open'; })()" in the webview "Connection Manager"
    Then I take a screenshot "04-manager-refresh-menu"
    When I press "Escape"
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); if (manager?.shadowRoot?.querySelector('.search-refresh-menu')) throw new Error('Search refresh menu did not close on Escape'); return 'refresh menu dismissed'; })()" in the webview "Connection Manager"
    When I execute command "workbench.action.closeAllEditors"