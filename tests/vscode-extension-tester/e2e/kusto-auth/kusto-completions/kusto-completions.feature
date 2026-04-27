Feature: Kusto schema-based completions — tables, columns, functions

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Schema loads and completions include tables and columns
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select a database with known schema through the dropdown
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds

    # Wait for schema to load — check the schema info element
    And I wait 5 seconds
    Then I take a screenshot "01-database-selected"

    # ── TEST 1: Schema is loaded (tables exist) ───────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const boxId = el.boxId; const schema = window.schemaByBoxId && window.schemaByBoxId[boxId]; if (!schema) { const allKeys = window.schemaByBoxId ? Object.keys(window.schemaByBoxId) : []; throw new Error('No schema for boxId=' + boxId + ' (keys: ' + allKeys.join(',') + ')'); } const tables = schema.tables || (schema.Tables ? Object.keys(schema.Tables) : []); const tableCount = Array.isArray(tables) ? tables.length : Object.keys(tables || {}).length; const columnTableCount = Object.keys(schema.columnTypesByTable || {}).length; if (tableCount === 0 && columnTableCount === 0) throw new Error('Schema loaded but has no tables/columns'); return 'schema loaded, tables=' + tableCount + ', columnTables=' + columnTableCount; })()" in the webview
    Then I take a screenshot "02-schema-loaded"

    # ── TEST 2: Schema info component shows table count ───────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const info = el.shadowRoot?.querySelector('kw-schema-info'); if (!info) throw new Error('No kw-schema-info element'); const text = (info.shadowRoot?.textContent || info.textContent || '').trim(); if (!text) throw new Error('Schema info text is empty'); return 'schema info: ' + text.substring(0, 100) + ' ✓'; })()" in the webview

    # ── TEST 3: Monaco completions include table names ────────────────────
    When I evaluate "window.__e2e.kusto.setQuery('')" in the webview
    And I wait 1 second

    # Type a partial table name and check if completion providers are registered
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview

    # ── TEST 4: Trigger completions programmatically ──────────────────────
    When I evaluate "(async () => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('KQL section not found'); const boxId = el.boxId; const schema = window.schemaByBoxId && window.schemaByBoxId[boxId]; if (!schema) throw new Error('No schema for boxId=' + boxId); const tableNames = Array.isArray(schema.tables) ? schema.tables : Object.keys(schema.Tables || schema.rawSchemaJson?.Databases?.[el.getDatabase?.()]?.Tables || {}); const expectedTable = tableNames.find(t => /^RawEventsADS$/i.test(t)) || tableNames.find(t => /^RawEvents/i.test(t)) || tableNames.find(t => /^[A-Za-z][A-Za-z0-9_]{5,}$/.test(t)); if (!expectedTable) throw new Error('No usable table names in schema: ' + tableNames.slice(0, 20).join(', ')); const prefixLength = Math.min(Math.max(4, Math.ceil(expectedTable.length / 2)), expectedTable.length); const prefix = expectedTable.slice(0, prefixLength); window.__e2eKustoCompletionExpected = { table: expectedTable, prefix }; window.__e2e.suggest.kusto.setTextAt(prefix, 1, prefix.length + 1); if (typeof window.__kustoUpdateSchemaForFocusedBox === 'function') await window.__kustoUpdateSchemaForFocusedBox(boxId, true); window.__e2e.suggest.kusto.trigger(); return 'triggered suggest at ' + prefix + '| expecting ' + expectedTable; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "03-completions-triggered"

    # Check if the suggest widget appeared
    When I evaluate "(() => { const expected = window.__e2eKustoCompletionExpected; if (!expected) throw new Error('Missing expected completion metadata'); return window.__e2e.suggest.kusto.assertVisible('Kusto table completion', expected.table + ',' + expected.prefix); })()" in the webview
    Then I take a screenshot "04-suggest-widget"

    # ── TEST 5: KQL language is registered in Monaco ──────────────────────
    When I evaluate "(() => { const langs = monaco.languages.getLanguages(); const kql = langs.find(l => l.id === 'kusto' || l.id === 'kql'); if (!kql) throw new Error('KQL/Kusto language not registered in Monaco. Available: ' + langs.map(l => l.id).join(', ')); return 'KQL language registered: id=' + kql.id + ' ✓'; })()" in the webview

    # ── TEST 6: Diagnostics provider detects basic KQL syntax ─────────────
    When I evaluate "window.__e2e.kusto.setQuery('range x from 1 to 5 step 1 | extend y=x*2')" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.kusto.assertMarkers('none', '', 'error')" in the webview
    Then I take a screenshot "05-diagnostics"

    Then I take a screenshot "06-final"
    When I execute command "workbench.action.closeAllEditors"
