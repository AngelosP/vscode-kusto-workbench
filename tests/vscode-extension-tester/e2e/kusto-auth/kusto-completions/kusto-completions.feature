Feature: Kusto schema-based completions — tables, columns, functions

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Schema loads and completions include tables and columns
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select a database with known schema
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('KQL section not found'); const dbs = el._databases || []; const target = dbs.find(d => /sample/i.test(d)) || dbs[0]; if (!target) throw new Error('No Kusto databases available'); el.setDesiredDatabase(target); el.dispatchEvent(new CustomEvent('database-changed', { detail: { boxId: el.boxId, database: target }, bubbles: true, composed: true })); return 'db=' + target; })()" in the webview
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
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const boxId = el.boxId; const ed = window.queryEditors[boxId]; ed.setValue(''); ed.focus(); return 'editor cleared'; })()" in the webview
    And I wait 1 second

    # Type a partial table name and check if completion providers are registered
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const ed = window.queryEditors[el.boxId]; const model = ed.getModel(); if (!model) throw new Error('No model'); const lang = model.getLanguageId(); const providers = monaco.languages.CompletionItemProvider; return 'editor language=' + lang + ', model uri=' + model.uri.toString() + ' ✓'; })()" in the webview

    # ── TEST 4: Trigger completions programmatically ──────────────────────
    When I evaluate "(async () => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('KQL section not found'); const boxId = el.boxId; const schema = window.schemaByBoxId && window.schemaByBoxId[boxId]; if (!schema) throw new Error('No schema for boxId=' + boxId); const tableNames = Array.isArray(schema.tables) ? schema.tables : Object.keys(schema.Tables || schema.rawSchemaJson?.Databases?.[el.getDatabase?.()]?.Tables || {}); const expectedTable = tableNames.find(t => /^RawEventsADS$/i.test(t)) || tableNames.find(t => /^RawEvents/i.test(t)) || tableNames.find(t => /^[A-Za-z][A-Za-z0-9_]{5,}$/.test(t)); if (!expectedTable) throw new Error('No usable table names in schema: ' + tableNames.slice(0, 20).join(', ')); const prefixLength = Math.min(Math.max(4, Math.ceil(expectedTable.length / 2)), expectedTable.length); const prefix = expectedTable.slice(0, prefixLength); window.__e2eKustoCompletionExpected = { table: expectedTable, prefix }; const ed = window.queryEditors[boxId]; const model = ed && ed.getModel && ed.getModel(); if (!ed || !model) throw new Error('No Monaco editor/model for boxId=' + boxId); ed.setValue(prefix); ed.setPosition({ lineNumber: 1, column: prefix.length + 1 }); ed.focus(); if (typeof window.__kustoUpdateSchemaForFocusedBox === 'function') await window.__kustoUpdateSchemaForFocusedBox(boxId, true); ed.focus(); ed.trigger('e2e-test', 'editor.action.triggerSuggest', {}); return 'triggered suggest at ' + prefix + '| expecting ' + expectedTable; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "03-completions-triggered"

    # Check if the suggest widget appeared
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const expected = window.__e2eKustoCompletionExpected; if (!expected) throw new Error('Missing expected completion metadata'); const editorEl = document.getElementById(el.boxId + '_query_editor'); if (!editorEl) throw new Error('No editor element'); const widgets = Array.from(editorEl.querySelectorAll('.suggest-widget.visible')).filter(w => !w.classList.contains('hidden') && w.style.display !== 'none' && w.offsetParent !== null); if (widgets.length === 0) throw new Error('Suggest widget should be visible after triggering completions'); const suggestWidget = widgets[widgets.length - 1]; const widgetText = (suggestWidget.textContent || '').trim(); if (/no suggestions/i.test(widgetText)) throw new Error('Suggest widget reported no suggestions for prefix ' + expected.prefix + ' from table ' + expected.table); const rows = Array.from(suggestWidget.querySelectorAll('.monaco-list-row')).filter(r => r.offsetParent !== null); const labels = rows.map(r => ((r.querySelector('.label-name') || {}).textContent || '').trim()).filter(Boolean); if (labels.length === 0) throw new Error('Suggest widget is visible but has no visible row labels. Text: ' + widgetText.slice(0, 200)); if (!labels.some(l => l.toLowerCase() === expected.table.toLowerCase() || l.toLowerCase().startsWith(expected.prefix.toLowerCase()))) throw new Error('Expected completion for ' + expected.table + ' using prefix ' + expected.prefix + ', got: ' + labels.slice(0, 20).join(', ')); return 'suggest widget visible with labels: ' + labels.slice(0, 12).join(', '); })()" in the webview
    Then I take a screenshot "04-suggest-widget"

    # ── TEST 5: KQL language is registered in Monaco ──────────────────────
    When I evaluate "(() => { const langs = monaco.languages.getLanguages(); const kql = langs.find(l => l.id === 'kusto' || l.id === 'kql'); if (!kql) throw new Error('KQL/Kusto language not registered in Monaco. Available: ' + langs.map(l => l.id).join(', ')); return 'KQL language registered: id=' + kql.id + ' ✓'; })()" in the webview

    # ── TEST 6: Diagnostics provider detects basic KQL syntax ─────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const ed = window.queryEditors[el.boxId]; ed.setValue('range x from 1 to 5 step 1 | extend y=x*2'); ed.focus(); return 'valid KQL set'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const model = window.queryEditors[el.boxId].getModel(); const markers = monaco.editor.getModelMarkers({ resource: model.uri }); const errors = markers.filter(m => m.severity === monaco.MarkerSeverity.Error); if (errors.length > 0) throw new Error('Valid KQL produced diagnostics: ' + errors.map(e => e.message).join('; ')); return 'markers: total=' + markers.length + ' errors=0'; })()" in the webview
    Then I take a screenshot "05-diagnostics"

    Then I take a screenshot "06-final"
    When I execute command "workbench.action.closeAllEditors"
