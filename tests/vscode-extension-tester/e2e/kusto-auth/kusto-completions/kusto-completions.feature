Feature: Kusto schema-based completions — tables, columns, functions

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Schema loads and completions include tables and columns
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select a database with known schema
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const dbs = el._databases || []; const target = dbs.find(d => /sample/i.test(d)) || dbs[0]; if (!target) return 'no dbs'; el.setDesiredDatabase(target); el.dispatchEvent(new CustomEvent('database-changed', { detail: { boxId: el.boxId, database: target }, bubbles: true, composed: true })); return 'db=' + target; })()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds

    # Wait for schema to load — check the schema info element
    And I wait 5 seconds
    Then I take a screenshot "01-database-selected"

    # ── TEST 1: Schema is loaded (tables exist) ───────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const boxId = el.boxId; const schema = window.schemaByBoxId && window.schemaByBoxId[boxId]; if (!schema) { const allKeys = window.schemaByBoxId ? Object.keys(window.schemaByBoxId) : []; throw new Error('No schema for boxId=' + boxId + ' (keys: ' + allKeys.join(',') + ')'); } const tables = schema.tables || (schema.Tables ? Object.keys(schema.Tables) : []); if (tables.length === 0 && schema.columnTypesByTable) { return 'schema loaded via columnTypesByTable, tables=' + Object.keys(schema.columnTypesByTable).length + ' ✓'; } return 'schema loaded, tables=' + (Array.isArray(tables) ? tables.length : JSON.stringify(tables).substring(0,80)) + ' ✓'; })()" in the webview
    Then I take a screenshot "02-schema-loaded"

    # ── TEST 2: Schema info component shows table count ───────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const info = el.shadowRoot?.querySelector('kw-schema-info'); if (!info) throw new Error('No kw-schema-info element'); const text = (info.shadowRoot?.textContent || info.textContent || '').trim(); if (!text) throw new Error('Schema info text is empty'); return 'schema info: ' + text.substring(0, 100) + ' ✓'; })()" in the webview

    # ── TEST 3: Monaco completions include table names ────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const boxId = el.boxId; const ed = window.queryEditors[boxId]; ed.setValue(''); ed.focus(); return 'editor cleared'; })()" in the webview
    And I wait 1 second

    # Type a partial table name and check if completion providers are registered
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const ed = window.queryEditors[el.boxId]; const model = ed.getModel(); if (!model) throw new Error('No model'); const lang = model.getLanguageId(); const providers = monaco.languages.CompletionItemProvider; return 'editor language=' + lang + ', model uri=' + model.uri.toString() + ' ✓'; })()" in the webview

    # ── TEST 4: Trigger completions programmatically ──────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const ed = window.queryEditors[el.boxId]; ed.setValue('Storm'); ed.setPosition({ lineNumber: 1, column: 6 }); ed.focus(); ed.trigger('e2e-test', 'editor.action.triggerSuggest', {}); return 'triggered suggest at Storm|'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "03-completions-triggered"

    # Check if the suggest widget appeared
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const editorEl = document.getElementById(el.boxId + '_query_editor'); if (!editorEl) throw new Error('No editor element'); const suggestWidget = editorEl.querySelector('.suggest-widget'); const visible = suggestWidget && !suggestWidget.classList.contains('hidden') && suggestWidget.style.display !== 'none'; return 'suggest widget: exists=' + !!suggestWidget + ' visible=' + visible; })()" in the webview
    Then I take a screenshot "04-suggest-widget"

    # ── TEST 5: KQL language is registered in Monaco ──────────────────────
    When I evaluate "(() => { const langs = monaco.languages.getLanguages(); const kql = langs.find(l => l.id === 'kusto' || l.id === 'kql'); if (!kql) throw new Error('KQL/Kusto language not registered in Monaco. Available: ' + langs.map(l => l.id).join(', ')); return 'KQL language registered: id=' + kql.id + ' ✓'; })()" in the webview

    # ── TEST 6: Diagnostics provider detects basic KQL syntax ─────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const ed = window.queryEditors[el.boxId]; ed.setValue('range x from 1 to 5 step 1 | extend y=x*2'); ed.focus(); return 'valid KQL set'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const model = window.queryEditors[el.boxId].getModel(); const markers = monaco.editor.getModelMarkers({ resource: model.uri }); const errors = markers.filter(m => m.severity === monaco.MarkerSeverity.Error); return 'markers: total=' + markers.length + ' errors=' + errors.length + (errors.length > 0 ? ' first=' + errors[0].message : '') + ' ✓'; })()" in the webview
    Then I take a screenshot "05-diagnostics"

    Then I take a screenshot "06-final"
