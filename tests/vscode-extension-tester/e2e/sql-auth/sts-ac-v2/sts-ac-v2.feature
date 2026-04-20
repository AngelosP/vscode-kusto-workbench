Feature: STS-powered SQL autocomplete verification

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: STS completions provide context-aware columns and tables
    # ── Setup: open editor, add SQL section, connect to sampledb ───────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Remove all existing sections
    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length + ' sections'; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) return 'no section'; const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs (' + dbs.length + ')'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds

    # Trigger STS connect
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el || !el._sqlConnectionId || !el._database) return 'skip'; window.vscode.postMessage({ type: 'stsConnect', boxId: el.boxId, sqlConnectionId: el._sqlConnectionId, database: el._database }); return 'stsConnect: ' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds

    # Wait for schema
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "00-setup-ready"

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── WARM UP STS: fire a trivial completion to force STS to index the document ──
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT 1'); ed.setPosition({lineNumber:1, column:9}); ed.focus(); return 'warmup'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'warmup-suggest'; })()" in the webview
    And I wait 8 seconds
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 1: SELECT column list — "SELECT | FROM SalesLT.Product"
    # Using String.fromCharCode(10) for proper newlines not needed here (single line)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT  FROM SalesLT.Product'); ed.setPosition({lineNumber:1, column:8}); ed.focus(); return 'T1: cursor after SELECT'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "01-select-column-list"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T1(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 2: Multi-line SELECT mid-column-list (your screenshot scenario)
    # Using proper newlines via String.fromCharCode(10) = LF
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const NL = String.fromCharCode(10); const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT TOP 10' + NL + '  ProductID,' + NL + '  Name,' + NL + '  ProductNumber,' + NL + '  Color,' + NL + '  ' + NL + '  ListPrice,' + NL + '  Size,' + NL + '  Weight' + NL + 'FROM SalesLT.Product' + NL + 'ORDER BY ProductID;'); ed.setPosition({lineNumber:6, column:3}); ed.focus(); return 'T2: lines=' + ed.getModel().getLineCount(); })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "02-mid-column-list"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T2(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 3: WHERE clause columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const NL = String.fromCharCode(10); const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product' + NL + 'WHERE '); ed.setPosition({lineNumber:2, column:7}); ed.focus(); return 'T3: WHERE'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "03-where-clause"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T3(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 4: ORDER BY columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const NL = String.fromCharCode(10); const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product' + NL + 'ORDER BY '); ed.setPosition({lineNumber:2, column:10}); ed.focus(); return 'T4: ORDER BY'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "04-order-by"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T4(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 5: JOIN ON alias p. → Product columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const NL = String.fromCharCode(10); const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT *' + NL + 'FROM SalesLT.Product p' + NL + 'JOIN SalesLT.ProductCategory c ON p.'); ed.setPosition({lineNumber:3, column:44}); ed.focus(); return 'T5: JOIN ON p.'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "05-join-on-alias"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T5(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 6: FROM tables — "SELECT * FROM |"
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM '); ed.setPosition({lineNumber:1, column:15}); ed.focus(); return 'T6: FROM'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "06-from-tables"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T6(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 7: SalesLT. → schema-qualified tables
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.'); ed.setPosition({lineNumber:1, column:23}); ed.focus(); return 'T7: SalesLT.'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "07-saleslt-dot"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T7(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 8: Keyword partial — "SEL" → SELECT
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SEL'); ed.setPosition({lineNumber:1, column:4}); ed.focus(); return 'T8: SEL'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "08-keyword-sel"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T8(' + rows.length + '): ' + rows.slice(0,8).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 9: WHERE partial column — "WHERE Colo" → Color
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product WHERE Colo'); ed.setPosition({lineNumber:1, column:42}); ed.focus(); return 'T9: WHERE Colo'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "09-where-partial-col"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T9(' + rows.length + '): ' + rows.slice(0,10).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 10: Subquery SELECT columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const NL = String.fromCharCode(10); const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product' + NL + 'WHERE ProductCategoryID IN (SELECT  FROM SalesLT.ProductCategory)'); ed.setPosition({lineNumber:2, column:36}); ed.focus(); return 'T10: subquery'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "10-subquery"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T10(' + rows.length + '): ' + rows.slice(0,15).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    Then I take a screenshot "99-final"
