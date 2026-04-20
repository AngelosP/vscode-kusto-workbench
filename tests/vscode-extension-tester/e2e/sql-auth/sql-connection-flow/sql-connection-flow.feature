Feature: SQL connection flow — server select, database loading, refresh

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Server dropdown, database loading, database select, refresh
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    # ── TEST 1: SQL section appears with server connection ────────────────
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('No SQL section'); if (el.dataset.testSqlConnection !== 'true') throw new Error('No SQL connection'); return 'connection established ✓'; })()" in the webview
    Then I take a screenshot "01-connected"

    # ── TEST 2: Database list loaded ──────────────────────────────────────
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const count = parseInt(el.dataset.testDatabaseCount || '0', 10); if (count < 1) throw new Error('Expected at least 1 database, got ' + count); return 'databases loaded: ' + count + ' ✓'; })()" in the webview
    Then I take a screenshot "02-databases-loaded"

    # ── TEST 3: Select a database ─────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: t }, bubbles: true, composed: true })); } return 'selected db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true']" in the webview for 10 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testDatabaseSelected !== 'true') throw new Error('Database not selected'); const db = el.dataset.testDatabase; if (!db) throw new Error('No database name in dataset'); return 'database selected: ' + db + ' ✓'; })()" in the webview
    Then I take a screenshot "03-database-selected"

    # ── TEST 4: Schema loads after database selection ─────────────────────
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testSchemaReady !== 'true') throw new Error('Schema not ready'); return 'schema ready, status=' + el.dataset.testSchemaStatus + ' ✓'; })()" in the webview
    Then I take a screenshot "04-schema-loaded"

    # ── TEST 5: Schema info badge shows table count ───────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const info = el.shadowRoot?.querySelector('kw-schema-info'); if (!info) throw new Error('No schema-info element'); const text = info.shadowRoot?.textContent || info.textContent || ''; if (!text.includes('table')) throw new Error('Schema info should mention tables, got: ' + text.substring(0, 80)); return 'schema info: ' + text.trim().substring(0, 60) + ' ✓'; })()" in the webview

    # ── TEST 6: Refresh databases ─────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const prevCount = (el._databases || []).length; el.dispatchEvent(new CustomEvent('sql-refresh-databases', { detail: { boxId: el.boxId || el.id }, bubbles: true, composed: true })); return 'refresh dispatched, prev count=' + prevCount; })()" in the webview
    And I wait 3 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const count = parseInt(el.dataset.testDatabaseCount || '0', 10); if (count < 1) throw new Error('Expected databases after refresh, got ' + count); return 'databases refreshed: ' + count + ' ✓'; })()" in the webview
    Then I take a screenshot "05-databases-refreshed"

    # ── TEST 7: Server dropdown has entries ────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const conns = el._connections || []; if (conns.length < 1) throw new Error('Expected at least 1 server connection, got ' + conns.length); return 'server connections: ' + conns.length + ' (' + conns.map(c => c.name || c.serverUrl || c.id).join(', ') + ') ✓'; })()" in the webview
    Then I take a screenshot "06-server-entries"
