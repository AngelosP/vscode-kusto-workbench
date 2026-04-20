Feature: SQL autocomplete shows schema items

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: SQL autocomplete returns correct schema-aware completions
    # ── Setup ──────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Remove all existing sections (close-btn is in shadow DOM — fire events directly)
    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length + ' sections'; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb — this triggers prefetchSqlSchema → schema loaded into schemaByBoxId
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) return 'no section'; const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs (' + dbs.length + ')'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds

    # Wait for schema to load (prefetchSqlSchema → sqlSchemaData → schemaByBoxId)
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "01-schema-ready"

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── TEST 1: FROM context → tables and views ────────────────────────────
    # Completions are LOCAL (read from schemaByBoxId). No remote calls, no waiting.
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SELECT * FROM '); ed.setPosition({lineNumber:1, column:15}); ed.focus(); return 'set FROM'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "02-from-tables"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'FROM(' + rows.length + '): ' + rows.slice(0,12).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 2: SalesLT. → tables in that schema ──────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SELECT * FROM SalesLT.'); ed.setPosition({lineNumber:1, column:23}); ed.focus(); return 'set SalesLT.'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "03-saleslt-tables"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'SalesLT(' + rows.length + '): ' + rows.slice(0,12).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 3: Column completion via alias ────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SELECT p. FROM SalesLT.Product p'); ed.setPosition({lineNumber:1, column:10}); ed.focus(); return 'set cols'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "04-column-alias"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'Cols(' + rows.length + '): ' + rows.slice(0,12).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 4: dbo. → tables in dbo schema ───────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SELECT * FROM dbo.'); ed.setPosition({lineNumber:1, column:19}); ed.focus(); return 'set dbo.'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "05-dbo-tables"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'dbo(' + rows.length + '): ' + rows.slice(0,12).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 5: Keyword context ────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SEL'); ed.setPosition({lineNumber:1, column:4}); ed.focus(); return 'set SEL'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "06-keyword"
    When I press "Escape"
    And I wait 1 second

    # ── TEST 6: Switch to master ───────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase() === 'master') || dbs.find(d => d.toLowerCase() !== 'sampledb'); if (!t) return 'no other db'; el._database = ''; el._onDatabaseSelected(new CustomEvent('select', { detail: { id: t } })); return 'switched: ' + t; })()" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "07-db-switched"

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM sys.'); ed.setPosition({lineNumber:1, column:19}); ed.focus(); return 'set sys.'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "08-master-sys"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'sys(' + rows.length + '): ' + rows.slice(0,12).map(r => (r.querySelector('.label-name')||{}).textContent||'').join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 7: Switch back to sampledb ────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el._database = ''; el._onDatabaseSelected(new CustomEvent('select', { detail: { id: 'sampledb' } })); return 'switched: sampledb'; })()" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.'); ed.setPosition({lineNumber:1, column:23}); ed.focus(); return 'set SalesLT.'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "09-restored-saleslt"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'restored(' + rows.length + '): ' + rows.slice(0,12).map(r => (r.querySelector('.label-name')||{}).textContent||'').join(', '); })()" in the webview

    Then I take a screenshot "10-final"

