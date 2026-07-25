Feature: Kusto connection flow — cluster select, database loading, schema

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    And I wait 2 seconds

  Scenario: Cluster connection, database loading, database select, schema load
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Remove all existing sections
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    # Add a fresh KQL section
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    # ── TEST 1: KQL section appears with cluster connection ───────────────
    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('No kw-query-section found'); if (el.dataset.testConnection !== 'true') throw new Error('No cluster connection established'); const url = el.getClusterUrl(); if (!url) throw new Error('getClusterUrl() returned empty'); return 'connection established, cluster=' + url + ' ✓'; })()" in the webview

    # ── TEST 2: Cluster dropdown has entries ───────────────────────────────
    When I evaluate "window.__testAssertKwDropdownHasItems(`kw-query-section .select-wrapper[title='Kusto Cluster'] kw-dropdown`, 1)" in the webview

    # ── TEST 3: Database list loaded ──────────────────────────────────────
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const count = parseInt(el.dataset.testDatabaseCount || '0', 10); if (count < 1) throw new Error('Expected at least 1 database, got ' + count); return 'databases loaded: ' + count; })()" in the webview

    # ── TEST 4: Select a database ─────────────────────────────────────────
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const toolbar = el.querySelector('.query-editor-toolbar'); const progress = toolbar ? getComputedStyle(toolbar, '::after') : null; if (el.dataset.testPreparationState !== 'preparing') throw new Error('Expected preparing state immediately after database selection, got ' + el.dataset.testPreparationState); if (!progress || !String(progress.animationName || '').includes('kusto-section-preparing')) throw new Error('Toolbar progress animation is not active: ' + (progress?.animationName || '(missing)')); return 'schema preparation indicator active'; })()" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 600, 350
    Then I take a screenshot "04-schema-preparing"
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testDatabaseSelected !== 'true') throw new Error('Database not selected'); const db = el.dataset.testDatabase || el.getDatabase(); if (!db) throw new Error('No database name'); return 'database selected: ' + db + ' ✓'; })()" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 60000)" in the webview for 65 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const toolbar = el.querySelector('.query-editor-toolbar'); const progress = toolbar ? getComputedStyle(toolbar, '::after') : null; if (el.getAttribute('aria-busy') !== 'false') throw new Error('Section remained aria-busy after preparation'); if (progress && String(progress.content || '') !== 'none') throw new Error('Progress pseudo-element remained visible after preparation'); return 'schema preparation complete'; })()" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 600, 350
    Then I take a screenshot "05-schema-ready"

    # ── TEST 5: Changing database after editor focus settles without a second click ──
    When I click "kw-query-section .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.selectDifferentDatabase()" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testPreparationState !== 'preparing') throw new Error('Expected preparing after database switch, got ' + el.dataset.testPreparationState); return 'database switch preparation started'; })()" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.getAttribute('aria-busy') !== 'false') throw new Error('Database switch remained busy'); return 'database switch prepared without editor refocus'; })()" in the webview

    # ── TEST 6: Refresh databases ─────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const prevCount = parseInt(el.dataset.testDatabaseCount || '0', 10); el.dispatchEvent(new CustomEvent('refresh-databases', { detail: { boxId: el.boxId, connectionId: el.getConnectionId() }, bubbles: true, composed: true })); return 'refresh dispatched, prev count=' + prevCount; })()" in the webview
    And I wait 3 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const count = parseInt(el.dataset.testDatabaseCount || '0', 10); if (count < 1) throw new Error('Expected databases after refresh, got ' + count); return 'databases refreshed: ' + count + ' ✓'; })()" in the webview

    # ── TEST 7: Connection state is correct ───────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const connId = el.getConnectionId(); const clusterUrl = el.getClusterUrl(); const db = el.getDatabase(); if (!connId) throw new Error('No connectionId'); if (!clusterUrl) throw new Error('No clusterUrl'); if (!db) throw new Error('No database selected'); return 'state: connId=' + connId + ' cluster=' + clusterUrl + ' db=' + db + ' ✓'; })()" in the webview

  Scenario: Database switch during initial preparation completes without editor refocus
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testPreparationState !== 'preparing') throw new Error('Initial database did not start preparation'); return 'initial preparation active'; })()" in the webview
    When I click "kw-query-section .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.selectDifferentDatabase()" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testPreparationState !== 'preparing') throw new Error('Database switch did not supersede preparation'); return 'replacement preparation active'; })()" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.getAttribute('aria-busy') !== 'false') throw new Error('Replacement preparation remained busy'); return 'replacement prepared without editor refocus'; })()" in the webview
    When I evaluate "window.__e2e.kusto.assertPreparationReady(0)" in the webview

  Scenario: Persisted single empty section switches database without editor refocus
    When I open file "tests/vscode-extension-tester/e2e/kusto-auth/kusto-connection-flow/fixtures/single-empty-section.kqlx" in the editor
    When I wait for "#query_single_empty_restore" in the webview for 20 seconds
    When I evaluate "(() => { const sections = document.querySelectorAll('kw-query-section'); const el = sections[0]; const editor = window.queryEditors?.[el?.boxId || el?.id]; if (sections.length !== 1) throw new Error('Expected one restored Kusto section, got ' + sections.length); if (String(editor?.getValue?.() || '') !== '') throw new Error('Restored section is not empty'); return 'restored one empty Kusto section'; })()" in the webview
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I click "kw-query-section .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.selectDifferentDatabase()" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.getAttribute('aria-busy') !== 'false') throw new Error('Restored section remained busy after database switch'); return 'restored section database switch ready'; })()" in the webview
    When I evaluate "window.__e2e.kusto.assertPreparationReady(0)" in the webview
    When I execute command "workbench.action.files.revert"
    When I execute command "workbench.action.closeAllEditors"

  Scenario: User database switch completes while another Kusto section owns focus
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 60000)" in the webview for 65 seconds
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section:nth-of-type(2)" in the webview for 20 seconds
    When I wait for "kw-query-section:nth-of-type(2)[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase(1)" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(1, 60000)" in the webview for 65 seconds
    When I click "kw-query-section:nth-of-type(2) .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.waitForWorkerContext(1, 10000)" in the webview
    When I evaluate "window.__e2e.kusto.assertActualWorkerContext(1)" in the webview
    When I evaluate "window.__e2e.kusto.selectDifferentDatabase()" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview
    When I evaluate "(() => { const sections = document.querySelectorAll('kw-query-section'); if (sections.length !== 2) throw new Error('Expected two Kusto sections'); if (sections[0].getAttribute('aria-busy') !== 'false') throw new Error('First section remained busy while second owned focus'); return 'multi-section database switch ready'; })()" in the webview
    When I evaluate "window.__e2e.kusto.assertPreparationReady(0)" in the webview
    When I evaluate "window.__e2e.kusto.assertWorkerContext(1)" in the webview
    When I evaluate "window.__e2e.kusto.assertActualWorkerContext(1)" in the webview
    When I evaluate "window.__e2e.kusto.assertTableCompletionForSection(1, 5000)" in the webview
