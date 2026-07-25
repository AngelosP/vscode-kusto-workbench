Feature: Kusto schema-based completions — tables, columns, functions

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
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

    # Wait for the exact schema/model preparation to finish.
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 60000)" in the webview for 65 seconds
    Then I take a screenshot "01-schema-ready"

    # ── TEST 1: Schema is loaded (tables exist) ───────────────────────────
    When I evaluate "window.__e2e.kusto.prepareCompletionTargets()" in the webview

    # ── TEST 2: Schema info component shows table count ───────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const info = el.shadowRoot?.querySelector('kw-schema-info'); if (!info) throw new Error('No kw-schema-info element'); const text = (info.shadowRoot?.textContent || info.textContent || '').trim(); if (!text) throw new Error('Schema info text is empty'); return 'schema info: ' + text.substring(0, 100) + ' ✓'; })()" in the webview

    # ── TEST 3: Monaco completions include table names ────────────────────
    When I evaluate "window.__e2e.kusto.setQuery('')" in the webview
    And I wait 1 second

    # Type a partial table name and check if completion providers are registered
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview

    # ── TEST 4: Trigger completions programmatically ──────────────────────
    When I evaluate "(async () => { window.__e2e.kusto.prepareCompletionTargets(); const targets = window.__e2eKustoCompletionTargets; if (!targets?.table || !targets?.tablePrefix) throw new Error('Kusto completion targets are unavailable'); const expectedTable = targets.table; const prefix = targets.tablePrefix; window.__e2eKustoCompletionExpected = { table: expectedTable, prefix }; window.__e2e.suggest.kusto.setTextAt(prefix, 1, prefix.length + 1); window.__e2e.kusto.requestSchemaApply(); await window.__e2e.suggest.kusto.trigger(); return 'triggered suggest at ' + prefix + '| expecting ' + expectedTable; })()" in the webview

    # Check if the suggest widget appeared
    When I evaluate "(async () => { const expected = window.__e2eKustoCompletionExpected; if (!expected) throw new Error('Missing expected completion metadata'); return await window.__e2e.suggest.kusto.waitVisible('Kusto table completion', expected.table + ',' + expected.prefix, 5000); })()" in the webview

    # ── TEST 5: KQL language is registered in Monaco ──────────────────────
    When I evaluate "(() => { const langs = monaco.languages.getLanguages(); const kql = langs.find(l => l.id === 'kusto' || l.id === 'kql'); if (!kql) throw new Error('KQL/Kusto language not registered in Monaco. Available: ' + langs.map(l => l.id).join(', ')); return 'KQL language registered: id=' + kql.id + ' ✓'; })()" in the webview

    # ── TEST 6: Diagnostics provider detects basic KQL syntax ─────────────
    When I evaluate "window.__e2e.kusto.setQuery('range x from 1 to 5 step 1 | extend y=x*2')" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.kusto.assertMarkers('none', '', 'error')" in the webview
    Then I take a screenshot "02-valid-query-no-errors"
    When I execute command "workbench.action.closeAllEditors"
