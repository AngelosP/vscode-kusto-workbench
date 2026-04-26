Feature: Connection Manager — Back button, filter bar, and Search tab

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Filter bar always visible with Search tab, back button, and search UI
    # ── Open the Connection Manager ───────────────────────────────────────
    When I execute command "kusto.manageConnections"
    And I wait 3 seconds
    When I wait for "kw-connection-manager" in the webview for 20 seconds
    Then I take a screenshot "01-cm-opened"

    # Helper shorthand for shadow root access
    # const sr = document.querySelector('kw-connection-manager')?.shadowRoot

    # ── TEST 1: Filter bar is always visible (even with 0 favorites/LNT) ──
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const bar = sr?.querySelector('[data-testid=cm-filter-bar]'); if (!bar) throw new Error('Filter bar not found — should always be visible'); return 'filter bar visible'; })()" in the webview
    Then I take a screenshot "02-filter-bar"

    # ── TEST 2: Filter bar has All tab ────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const allBtn = sr?.querySelector('[data-testid=cm-filter-all]'); if (!allBtn) throw new Error('All filter tab not found'); if (!allBtn.classList.contains('active')) throw new Error('All tab should be active by default'); return 'All tab active'; })()" in the webview

    # ── TEST 3: Filter bar has Search tab ─────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const searchBtn = sr?.querySelector('[data-testid=cm-filter-search]'); if (!searchBtn) throw new Error('Search tab not found'); if (searchBtn.classList.contains('active')) throw new Error('Search should NOT be active by default'); const label = searchBtn.querySelector('.filter-label'); if (!label?.textContent?.includes('Search')) throw new Error('No Search label: ' + label?.textContent); return 'Search tab found, inactive'; })()" in the webview
    Then I take a screenshot "03-search-tab"

    # ── TEST 4: Back button is NOT visible at root level ──────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const backBtn = sr?.querySelector('[data-testid=cm-breadcrumb-back]'); if (backBtn) throw new Error('Back button should not be visible at root — no explorerPath set'); return 'back button correctly hidden at root'; })()" in the webview

    # ── TEST 5: Click Search tab → search container appears ───────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-filter-search]')?.click(); return 'clicked Search tab'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const searchTab = sr?.querySelector('[data-testid=cm-filter-search]'); if (!searchTab?.classList.contains('active')) throw new Error('Search tab should be active after click'); const container = sr?.querySelector('[data-testid=cm-search-container]'); if (!container) throw new Error('Search container not found after clicking Search tab'); return 'search container visible'; })()" in the webview
    Then I take a screenshot "04-search-active"

    # ── TEST 6: Search container has input, scope selector, and categories ─
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const input = sr?.querySelector('[data-testid=cm-search-input]'); if (!input) throw new Error('Search input not found'); const scope = sr?.querySelector('[data-testid=cm-search-scope]'); if (!scope) throw new Error('Scope selector not found'); const cats = sr?.querySelector('[data-testid=cm-search-categories]'); if (!cats) throw new Error('Categories container not found'); const chips = cats.querySelectorAll('.search-category-chip'); if (chips.length < 2) throw new Error('Expected at least 2 category chips, got ' + chips.length); return 'input + scope + ' + chips.length + ' categories'; })()" in the webview
    Then I take a screenshot "05-search-elements"

    # ── TEST 7: Verify Kusto categories: Clusters, Databases, Table Names, Function Names ─
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const cats = sr?.querySelector('[data-testid=cm-search-categories]'); const chips = cats?.querySelectorAll('.search-category-chip') || []; const labels = Array.from(chips).map(c => c.textContent.trim()); const expected = ['Clusters', 'Databases', 'Table Names', 'Function Names']; for (const e of expected) { if (!labels.some(l => l.includes(e))) throw new Error('Missing category: ' + e + '. Found: ' + labels.join(', ')); } return 'all 4 Kusto categories found: ' + labels.join(', '); })()" in the webview

    # ── TEST 8: All categories are active by default ──────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const chips = sr?.querySelectorAll('[data-testid=cm-search-categories] .search-category-chip') || []; const inactive = Array.from(chips).filter(c => !c.classList.contains('active')); if (inactive.length > 0) throw new Error('Inactive categories by default: ' + Array.from(inactive).map(c => c.textContent.trim()).join(', ')); return 'all ' + chips.length + ' categories active'; })()" in the webview

    # ── TEST 9: Tables and Functions pills cycle through 3 states ──────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const chips = Array.from(sr?.querySelectorAll('[data-testid=cm-search-categories] .search-category-chip') || []); const tablesChip = chips.find(c => c.textContent.trim().includes('Table')); if (!tablesChip) throw new Error('No Tables chip found'); if (!tablesChip.textContent.trim().includes('Table Names')) throw new Error('Active Tables chip should show Table Names, got: ' + tablesChip.textContent.trim()); tablesChip.click(); const label2 = tablesChip.textContent.trim(); if (!label2.includes('Tables & Columns')) throw new Error('After 1st click expected Tables & Columns, got: ' + label2); tablesChip.click(); if (tablesChip.classList.contains('active')) throw new Error('After 2nd click Tables chip should be off'); tablesChip.click(); return 'Tables pill 3-state cycle works'; })()" in the webview

    # ── TEST 10: Scope buttons visible (not dropdown) at normal width ─────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const btns = sr?.querySelectorAll('.search-scope-btn') || []; if (btns.length !== 3) throw new Error('Expected 3 scope buttons, got ' + btns.length); const labels = Array.from(btns).map(b => b.textContent.trim()); const active = Array.from(btns).find(b => b.classList.contains('active')); if (!active) throw new Error('No active scope button'); if (!active.textContent.includes('Quick')) throw new Error('Default scope should be Quick Search, got: ' + active.textContent); return 'scope buttons: ' + labels.join(', '); })()" in the webview
    Then I take a screenshot "06-scope-buttons"

    # ── TEST 11: Scope description updates for default cached scope ───────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const desc = sr?.querySelector('.search-scope-description'); if (!desc?.textContent?.includes('cached')) throw new Error('Scope description should mention cached: ' + desc?.textContent); return 'scope description: ' + desc?.textContent?.trim(); })()" in the webview

    # ── TEST 12: Empty state when no query typed ──────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const results = sr?.querySelector('[data-testid=cm-search-results]'); const empty = results?.querySelector('.empty-state'); if (!empty) throw new Error('Expected empty state when no query typed'); if (!empty.textContent.includes('Search your connections')) throw new Error('Wrong empty state text: ' + empty.textContent); return 'empty state: ' + empty.textContent.trim().slice(0, 60); })()" in the webview
    Then I take a screenshot "07-empty-search"

    # ── TEST 13: Toggle a category off ────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const chips = sr?.querySelectorAll('[data-testid=cm-search-categories] .search-category-chip') || []; const clustersChip = Array.from(chips).find(c => c.textContent.includes('Clusters')); if (!clustersChip) throw new Error('Clusters chip not found'); clustersChip.click(); return 'clicked Clusters chip'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const chips = sr?.querySelectorAll('[data-testid=cm-search-categories] .search-category-chip') || []; const clustersChip = Array.from(chips).find(c => c.textContent.includes('Clusters')); if (clustersChip?.classList.contains('active')) throw new Error('Clusters chip should be inactive after toggle'); return 'Clusters toggled off'; })()" in the webview
    Then I take a screenshot "08-clusters-off"

    # ── TEST 14: Toggle Clusters back on ──────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const chips = sr?.querySelectorAll('[data-testid=cm-search-categories] .search-category-chip') || []; Array.from(chips).find(c => c.textContent.includes('Clusters'))?.click(); return 'toggled Clusters back on'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const chips = sr?.querySelectorAll('[data-testid=cm-search-categories] .search-category-chip') || []; const clustersChip = Array.from(chips).find(c => c.textContent.includes('Clusters')); if (!clustersChip?.classList.contains('active')) throw new Error('Clusters should be active again'); return 'Clusters back on'; })()" in the webview

    # ── TEST 15: Click All tab → exits search, search container hidden ────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-filter-all]')?.click(); return 'clicked All tab'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const container = sr?.querySelector('[data-testid=cm-search-container]'); if (container) throw new Error('Search container should be hidden after clicking All'); const allTab = sr?.querySelector('[data-testid=cm-filter-all]'); if (!allTab?.classList.contains('active')) throw new Error('All tab should be active'); return 'search hidden, All active'; })()" in the webview
    Then I take a screenshot "09-back-to-all"

    # ── TEST 16: Switch to SQL mode → filter bar has SQL Search tab ───────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cm-kind-picker]'); const btns = picker?.shadowRoot?.querySelectorAll('button') || []; const sqlBtn = Array.from(btns).find(b => b.textContent.toLowerCase().includes('sql')); if (!sqlBtn) throw new Error('SQL tab not found'); sqlBtn.click(); return 'switched to SQL'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const bar = sr?.querySelector('[data-testid=cm-sql-filter-bar]'); if (!bar) throw new Error('SQL filter bar not found'); const searchBtn = sr?.querySelector('[data-testid=cm-sql-filter-search]'); if (!searchBtn) throw new Error('SQL Search tab not found'); return 'SQL filter bar with Search tab found'; })()" in the webview
    Then I take a screenshot "10-sql-filter-bar"

    # ── TEST 17: SQL Search tab shows SQL-specific categories ─────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-sql-filter-search]')?.click(); return 'clicked SQL Search'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const cats = sr?.querySelector('[data-testid=cm-search-categories]'); const chips = cats?.querySelectorAll('.search-category-chip') || []; const labels = Array.from(chips).map(c => c.textContent.trim()); const expected = ['Servers', 'Databases', 'Tables', 'Views', 'Stored Procedures']; for (const e of expected) { if (!labels.some(l => l.includes(e))) throw new Error('Missing SQL category: ' + e + '. Found: ' + labels.join(', ')); } return '5 SQL categories: ' + labels.join(', '); })()" in the webview
    Then I take a screenshot "11-sql-categories"

    # ── TEST 18: SQL categories with expandable content toggle: Tables, Views, Stored Procedures ─
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const chips = sr?.querySelectorAll('[data-testid=cm-search-categories] .search-category-chip.has-content') || []; if (chips.length !== 3) throw new Error('Expected 3 SQL pills with content toggle, got ' + chips.length); const texts = Array.from(chips).map(c => c.querySelector('.search-content-text')?.textContent?.trim()); return 'SQL expandable pills: ' + texts.join(', '); })()" in the webview

    # ── TEST 19: Switch back to Kusto, verify search deactivates ──────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cm-kind-picker]'); const btns = picker?.shadowRoot?.querySelectorAll('button') || []; Array.from(btns).find(b => b.textContent.toLowerCase().includes('kusto'))?.click(); return 'back to Kusto'; })()" in the webview
    And I wait 1 second

    # ── TEST 20: Simulate connections + drill in → verify back button ─────
    # First reset filter to All so breadcrumb is visible, then inject data
    When I evaluate "(() => { const cm = document.querySelector('kw-connection-manager'); cm._activeFilter = 'all'; cm._snapshot = { ...cm._snapshot || {}, connections: [{ id: 'test1', name: 'TestCluster', clusterUrl: 'https://test.kusto.windows.net', database: '' }], cachedDatabases: { 'test.kusto.windows.net': ['db1', 'db2'] }, favorites: [], leaveNoTraceClusters: [] }; cm._explorerPath = { connectionId: 'test1' }; cm.requestUpdate(); return 'injected connection + drilled to cluster'; })()" in the webview
    And I wait 1 second
    Then I take a screenshot "12-drilled-cluster"

    # ── TEST 21: Back button visible when drilled in ──────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const back = sr?.querySelector('[data-testid=cm-breadcrumb-back]'); if (!back) throw new Error('Back button not found when drilled into cluster'); return 'back button visible'; })()" in the webview

    # ── TEST 22: Breadcrumb shows All / TestCluster ───────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const crumbs = sr?.querySelectorAll('.breadcrumb-item') || []; if (crumbs.length < 2) throw new Error('Expected at least 2 breadcrumb items, got ' + crumbs.length); const texts = Array.from(crumbs).map(c => c.textContent.trim()); if (!texts.some(t => t.includes('All'))) throw new Error('Missing All crumb'); if (!texts.some(t => t.includes('TestCluster'))) throw new Error('Missing TestCluster crumb'); return 'breadcrumbs: ' + texts.join(' / '); })()" in the webview
    Then I take a screenshot "13-breadcrumb-with-back"

    # ── TEST 23: Click back → goes up to root (no explorerPath) ───────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-breadcrumb-back]')?.click(); return 'clicked back'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const cm = document.querySelector('kw-connection-manager'); if (cm._explorerPath !== null) throw new Error('explorerPath should be null after back from cluster level, got: ' + JSON.stringify(cm._explorerPath)); return 'back to root — explorerPath is null'; })()" in the webview
    Then I take a screenshot "14-back-to-root"

    # ── TEST 24: Back button gone at root ─────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const back = sr?.querySelector('[data-testid=cm-breadcrumb-back]'); if (back) throw new Error('Back button should not be visible at root'); return 'back button hidden at root'; })()" in the webview

    # ── TEST 25: Drill deeper → database level → back goes to cluster ─────
    When I evaluate "(() => { const cm = document.querySelector('kw-connection-manager'); cm._explorerPath = { connectionId: 'test1', database: 'db1' }; cm._databaseSchemas = { ...cm._databaseSchemas, 'test1|db1': { tables: ['T1', 'T2'], functions: [] } }; cm.requestUpdate(); return 'drilled to db1'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-breadcrumb-back]')?.click(); return 'clicked back from db level'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const cm = document.querySelector('kw-connection-manager'); const ep = cm._explorerPath; if (!ep) throw new Error('explorerPath should not be null — should be at cluster level'); if (ep.database) throw new Error('Should have no database after back, got: ' + ep.database); if (ep.connectionId !== 'test1') throw new Error('Wrong connectionId: ' + ep.connectionId); return 'back to cluster level: ' + JSON.stringify(ep); })()" in the webview
    Then I take a screenshot "15-back-to-cluster"

    # ── TEST 26: Drill to section → back goes to database ─────────────────
    When I evaluate "(() => { const cm = document.querySelector('kw-connection-manager'); cm._explorerPath = { connectionId: 'test1', database: 'db1', section: 'tables', folderPath: [] }; cm.requestUpdate(); return 'drilled to tables section'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-breadcrumb-back]')?.click(); return 'clicked back from section'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const cm = document.querySelector('kw-connection-manager'); const ep = cm._explorerPath; if (!ep?.database) throw new Error('Should still have database'); if (ep.section) throw new Error('Section should be cleared after back, got: ' + ep.section); return 'back to database: ' + JSON.stringify(ep); })()" in the webview
    Then I take a screenshot "16-back-to-database"

    # ── FINAL SCREENSHOT ──────────────────────────────────────────────────
    Then I take a screenshot "99-final"
