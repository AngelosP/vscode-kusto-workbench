Feature: Kusto connection flow — cluster select, database loading, schema

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
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
    Then I take a screenshot "01-connected"

    # ── TEST 2: Cluster dropdown has entries ───────────────────────────────
    When I evaluate "window.__testAssertKwDropdownHasItems(`kw-query-section .select-wrapper[title='Kusto Cluster'] kw-dropdown`, 1)" in the webview
    Then I take a screenshot "02-cluster-entries"

    # ── TEST 3: Database list loaded ──────────────────────────────────────
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const count = parseInt(el.dataset.testDatabaseCount || '0', 10); if (count < 1) throw new Error('Expected at least 1 database, got ' + count); return 'databases loaded: ' + count; })()" in the webview
    Then I take a screenshot "03-databases-loaded"

    # ── TEST 4: Select a database ─────────────────────────────────────────
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testDatabaseSelected !== 'true') throw new Error('Database not selected'); const db = el.dataset.testDatabase || el.getDatabase(); if (!db) throw new Error('No database name'); return 'database selected: ' + db + ' ✓'; })()" in the webview
    Then I take a screenshot "04-database-selected"

    # ── TEST 5: Refresh databases ─────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const prevCount = parseInt(el.dataset.testDatabaseCount || '0', 10); el.dispatchEvent(new CustomEvent('refresh-databases', { detail: { boxId: el.boxId, connectionId: el.getConnectionId() }, bubbles: true, composed: true })); return 'refresh dispatched, prev count=' + prevCount; })()" in the webview
    And I wait 3 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const count = parseInt(el.dataset.testDatabaseCount || '0', 10); if (count < 1) throw new Error('Expected databases after refresh, got ' + count); return 'databases refreshed: ' + count + ' ✓'; })()" in the webview
    Then I take a screenshot "05-databases-refreshed"

    # ── TEST 6: Connection state is correct ───────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const connId = el.getConnectionId(); const clusterUrl = el.getClusterUrl(); const db = el.getDatabase(); if (!connId) throw new Error('No connectionId'); if (!clusterUrl) throw new Error('No clusterUrl'); if (!db) throw new Error('No database selected'); return 'state: connId=' + connId + ' cluster=' + clusterUrl + ' db=' + db + ' ✓'; })()" in the webview
    Then I take a screenshot "06-connection-state"
