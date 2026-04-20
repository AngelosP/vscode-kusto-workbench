Feature: Connection Manager with Kusto connections — explorer, drill-down, favorites

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Connection list, drill into cluster, explore databases
    # ── Open the Connection Manager ───────────────────────────────────────
    When I execute command "kusto.manageConnections"
    And I wait 3 seconds
    Then I take a screenshot "01-cm-opened"

    # ── TEST 1: Connection list has at least one cluster ──────────────────
    When I evaluate "(() => { const panel = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('[data-testid=cm-explorer-panel]'); const count = parseInt(panel?.dataset.testConnections || '0', 10); if (count < 1) throw new Error('Expected at least 1 Kusto connection, got ' + count); return 'connections: ' + count; })()" in the webview

    # ── TEST 2: Cluster list items render ─────────────────────────────────
    When I evaluate "(() => { const items = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelectorAll('.explorer-list-item'); if (items.length < 1) throw new Error('No cluster list items rendered'); const first = items[0]; const name = first.querySelector('.explorer-list-item-name')?.textContent?.trim(); const url = first.querySelector('.explorer-list-item-url')?.textContent?.trim(); if (!name) throw new Error('No cluster name'); if (!url) throw new Error('No cluster URL'); return 'first cluster: ' + name + ' (' + url + ')'; })()" in the webview
    Then I take a screenshot "02-cluster-list"

    # ── TEST 3: Each cluster has Edit/Delete/Refresh action buttons ───────
    When I evaluate "(() => { const item = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('.explorer-list-item'); const actions = item?.querySelector('.explorer-list-item-actions'); if (!actions) throw new Error('No action buttons'); const btns = actions.querySelectorAll('.btn-icon'); const titles = Array.from(btns).map(b => b.getAttribute('title')); if (!titles.includes('Edit')) throw new Error('No Edit button'); if (!titles.includes('Delete')) throw new Error('No Delete button'); if (!titles.includes('Refresh')) throw new Error('No Refresh button'); return 'action buttons: ' + titles.join(', '); })()" in the webview

    # ── TEST 4: Drill into first cluster → database list loads ────────────
    When I evaluate "(() => { const item = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('.explorer-list-item'); item.click(); return 'clicked first cluster'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "03-drilled-into-cluster"

    # ── TEST 5: Breadcrumb bar appears when drilled in ────────────────────
    When I evaluate "(() => { const bc = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('.explorer-breadcrumb'); if (!bc) throw new Error('No breadcrumb visible after drilling into cluster'); const items = bc.querySelectorAll('.breadcrumb-item'); if (items.length < 2) throw new Error('Expected at least 2 breadcrumb items, got ' + items.length); const labels = Array.from(items).map(i => i.textContent.trim()); return 'breadcrumb: ' + labels.join(' / '); })()" in the webview
    Then I take a screenshot "04-breadcrumb"

    # ── TEST 6: Database list items rendered ───────────────────────────────
    When I evaluate "(() => { const items = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelectorAll('.explorer-list-item'); if (items.length < 1) throw new Error('No database items after drilling into cluster'); const dbItems = Array.from(items).filter(i => i.querySelector('.explorer-list-item-icon.database')); return 'database items: ' + dbItems.length + ' (total items: ' + items.length + ')'; })()" in the webview
    Then I take a screenshot "05-database-list"

    # ── TEST 7: Each database has Refresh + Open actions ──────────────────
    When I evaluate "(() => { const items = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelectorAll('.explorer-list-item'); const dbItem = Array.from(items).find(i => i.querySelector('.explorer-list-item-icon.database')); if (!dbItem) throw new Error('No database item found'); const actions = dbItem.querySelector('.explorer-list-item-actions'); if (!actions) throw new Error('No actions on database item'); const btns = actions.querySelectorAll('.btn-icon'); if (btns.length < 1) throw new Error('No action buttons on database'); return 'database actions: ' + btns.length + ' buttons'; })()" in the webview

    # ── TEST 8: Drill into a database → sections view (Tables, Functions)──
    When I evaluate "(() => { const items = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelectorAll('.explorer-list-item'); const dbItem = Array.from(items).find(i => i.querySelector('.explorer-list-item-icon.database')); if (!dbItem) throw new Error('No database item'); dbItem.click(); return 'clicked database'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "06-database-sections"

    # ── TEST 9: Section overview shows Tables and Functions ────────────────
    When I evaluate "(() => { const items = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelectorAll('.explorer-list-item'); const labels = Array.from(items).map(i => i.querySelector('.explorer-list-item-name')?.textContent?.trim()); const hasTablesOrFuncs = labels.some(l => l && (l.includes('Tables') || l.includes('Functions') || l.includes('table') || l.includes('function'))); if (!hasTablesOrFuncs) throw new Error('Expected Tables/Functions sections, got: ' + labels.join(', ')); return 'sections: ' + labels.join(', '); })()" in the webview

    # ── TEST 10: Breadcrumb shows cluster + database ──────────────────────
    When I evaluate "(() => { const bc = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('.explorer-breadcrumb'); const items = bc?.querySelectorAll('.breadcrumb-item') || []; if (items.length < 3) throw new Error('Expected 3+ breadcrumb items (root, cluster, db), got ' + items.length); const labels = Array.from(items).map(i => i.textContent.trim()); return 'breadcrumb: ' + labels.join(' / '); })()" in the webview
    Then I take a screenshot "07-breadcrumb-with-db"

    # ── TEST 11: Click root breadcrumb → back to cluster list ─────────────
    When I evaluate "(() => { const bc = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('.explorer-breadcrumb'); const items = bc?.querySelectorAll('.breadcrumb-item') || []; const root = items[0]; if (!root) throw new Error('No root breadcrumb'); root.click(); return 'clicked root breadcrumb'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const bc = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('.explorer-breadcrumb'); if (bc) throw new Error('Breadcrumb should disappear at root level'); const items = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelectorAll('.explorer-list-item'); if (items.length < 1) throw new Error('No cluster items at root'); const firstIcon = items[0].querySelector('.explorer-list-item-icon.cluster'); if (!firstIcon) throw new Error('First item is not a cluster — might still be drilled in'); return 'back to root: ' + items.length + ' clusters'; })()" in the webview
    Then I take a screenshot "08-back-to-root"

    # ── TEST 12: Edit modal opens for first cluster ───────────────────────
    When I evaluate "(() => { const item = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('.explorer-list-item'); const editBtn = item?.querySelector('.btn-icon[title=Edit]'); if (!editBtn) throw new Error('Edit button not found'); editBtn.click(); return 'clicked Edit'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const modal = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('[data-testid=cm-modal-overlay]'); if (!modal) throw new Error('Edit modal did not open'); const h2 = modal.querySelector('h2'); if (!h2?.textContent?.includes('Edit')) throw new Error('Not an Edit modal: ' + h2?.textContent); const form = modal.querySelector('kw-kusto-connection-form'); if (!form) throw new Error('No form in Edit modal'); return 'edit modal opened: ' + h2.textContent; })()" in the webview
    Then I take a screenshot "09-edit-modal"

    # Close modal
    When I evaluate "(() => { const modal = document.querySelector('kw-connection-manager')?.shadowRoot?.querySelector('[data-testid=cm-modal-content]'); modal?.querySelector('.modal-footer button:first-child')?.click(); return 'closed edit modal'; })()" in the webview
    And I wait 1 second
    Then I take a screenshot "10-final"
