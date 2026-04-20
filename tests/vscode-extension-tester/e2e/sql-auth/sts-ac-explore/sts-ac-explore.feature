Feature: Comprehensive T-SQL autocomplete exploration

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Explore all interesting T-SQL autocomplete contexts
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

    # Select sampledb — this triggers prefetchSqlSchema → schema loaded into schemaByBoxId
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) return 'no section'; const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs (' + dbs.length + ')'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds

    # Trigger STS connect (needed for context-aware completions from SqlToolsService)
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el || !el._sqlConnectionId || !el._database) return 'skip'; window.vscode.postMessage({ type: 'stsConnect', boxId: el.boxId, sqlConnectionId: el._sqlConnectionId, database: el._database }); return 'stsConnect: ' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds

    # Wait for schema to load (prefetchSqlSchema → sqlSchemaData → schemaByBoxId)
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "00-setup-ready"

    # Dump schema state for diagnostics
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el?.boxId; const schema = window.schemaByBoxId?.[boxId]; if (!schema) return 'NO SCHEMA for boxId=' + boxId + ', keys=' + Object.keys(window.schemaByBoxId || {}).join(','); return 'tables=' + (schema.tables||[]).length + ' views=' + (schema.views||[]).length + ' colTables=' + Object.keys(schema.columnsByTable||{}).length; })()" in the webview

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 1: SELECT column list — cursor after "SELECT " in "SELECT | FROM SalesLT.Product"
    # EXPECTED: column names from SalesLT.Product (ProductID, Name, Color, etc.)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT  FROM SalesLT.Product'); ed.setPosition({lineNumber:1, column:8}); ed.focus(); return 'T1: cursor after SELECT'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "01-select-column-list"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T1-SELECT-COLS(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; const k = r.querySelector('.codicon')?.className||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : '') + (k.includes('field') ? ' {field}' : k.includes('keyword') ? ' {kw}' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 2: Multi-line SELECT with cursor mid-column-list (user's exact scenario)
    # EXPECTED: column names from the FROM table, not random keywords like PROCEDURE
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT TOP 10\\n  ProductID,\\n  Name,\\n  ProductNumber,\\n  Color,\\n  \\n  ListPrice,\\n  Size,\\n  Weight\\nFROM SalesLT.Product\\nORDER BY ProductID;'); ed.setPosition({lineNumber:6, column:3}); ed.focus(); return 'T2: mid-column-list'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "02-mid-column-list"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T2-MID-COLS(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 3: WHERE clause — cursor after WHERE
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product\\nWHERE '); ed.setPosition({lineNumber:2, column:7}); ed.focus(); return 'T3: WHERE clause'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "03-where-clause"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T3-WHERE(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 4: ORDER BY columns
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product\\nORDER BY '); ed.setPosition({lineNumber:2, column:10}); ed.focus(); return 'T4: ORDER BY'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "04-order-by"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T4-ORDERBY(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 5: GROUP BY columns
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT Color, COUNT(*)\\nFROM SalesLT.Product\\nGROUP BY '); ed.setPosition({lineNumber:3, column:10}); ed.focus(); return 'T5: GROUP BY'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "05-group-by"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T5-GROUPBY(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 6: Inside aggregate function — COUNT(|)
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT COUNT() FROM SalesLT.Product'); ed.setPosition({lineNumber:1, column:14}); ed.focus(); return 'T6: inside COUNT()'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "06-inside-aggregate"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T6-COUNT(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 7: JOIN ON clause — columns from both tables
    # EXPECTED: columns from both Product and ProductCategory
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT *\\nFROM SalesLT.Product p\\nJOIN SalesLT.ProductCategory c ON p.'); ed.setPosition({lineNumber:3, column:44}); ed.focus(); return 'T7: JOIN ON p.'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "07-join-on-alias"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T7-JOIN-ON(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 8: JOIN second alias — c. should show ProductCategory columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT *\\nFROM SalesLT.Product p\\nJOIN SalesLT.ProductCategory c ON p.ProductCategoryID = c.'); ed.setPosition({lineNumber:3, column:59}); ed.focus(); return 'T8: JOIN ON c.'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "08-join-second-alias"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T8-JOIN-C(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 9: UPDATE SET columns
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('UPDATE SalesLT.Product SET '); ed.setPosition({lineNumber:1, column:28}); ed.focus(); return 'T9: UPDATE SET'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "09-update-set"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T9-UPDATE(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 10: INSERT INTO table columns — inside parentheses
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('INSERT INTO SalesLT.Product ()'); ed.setPosition({lineNumber:1, column:30}); ed.focus(); return 'T10: INSERT INTO cols'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "10-insert-into-cols"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T10-INSERT(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 11: FROM context — "SELECT * FROM " (space after FROM)
    # EXPECTED: table names (SalesLT.Product, SalesLT.ProductCategory, etc.)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM '); ed.setPosition({lineNumber:1, column:15}); ed.focus(); return 'T11: FROM tables'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "11-from-tables"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T11-FROM(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 12: SalesLT. context — schema-qualified table completion
    # EXPECTED: tables in SalesLT schema (Product, ProductCategory, etc.)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.'); ed.setPosition({lineNumber:1, column:23}); ed.focus(); return 'T12: SalesLT.'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "12-saleslt-dot"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T12-SALESLT(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 13: Keyword partial — "SEL" should match SELECT first
    # EXPECTED: SELECT as top suggestion
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SEL'); ed.setPosition({lineNumber:1, column:4}); ed.focus(); return 'T13: keyword SEL'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "13-keyword-sel"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T13-SEL(' + rows.length + '): ' + rows.slice(0,8).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; return n.trim(); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 14: HAVING clause
    # EXPECTED: columns or aggregate functions
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT Color, COUNT(*)\\nFROM SalesLT.Product\\nGROUP BY Color\\nHAVING '); ed.setPosition({lineNumber:4, column:8}); ed.focus(); return 'T14: HAVING'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "14-having"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T14-HAVING(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 15: CTE / WITH clause — after AS ( SELECT
    # EXPECTED: context-aware completions
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('WITH cte AS (\\n  SELECT  FROM SalesLT.Product\\n)\\nSELECT * FROM cte'); ed.setPosition({lineNumber:2, column:10}); ed.focus(); return 'T15: CTE select'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "15-cte-select"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T15-CTE(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 16: Partial table name after FROM — "FROM Prod"
    # EXPECTED: SalesLT.Product and related tables matching "Prod"
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM Prod'); ed.setPosition({lineNumber:1, column:19}); ed.focus(); return 'T16: partial table name'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "16-partial-table"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T16-PARTIAL(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 17: WHERE with partial column — "WHERE Colo"
    # EXPECTED: Color column should appear
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product WHERE Colo'); ed.setPosition({lineNumber:1, column:42}); ed.focus(); return 'T17: WHERE partial col'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "17-where-partial-col"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T17-WHERECOL(' + rows.length + '): ' + rows.slice(0,10).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 18: After WHERE condition — "WHERE Color = 'Red' AND "
    # EXPECTED: column names for additional conditions
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product\\nWHERE Color = \\'Red\\' AND '); ed.setPosition({lineNumber:2, column:25}); ed.focus(); return 'T18: WHERE AND'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "18-where-and"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T18-AND(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 19: Subquery context — "WHERE ProductID IN (SELECT )"
    # EXPECTED: context-aware (columns or sub-select items)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product\\nWHERE ProductCategoryID IN (SELECT  FROM SalesLT.ProductCategory)'); ed.setPosition({lineNumber:2, column:36}); ed.focus(); return 'T19: subquery SELECT'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "19-subquery"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T19-SUBQ(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 20: JOIN context — second table
    # EXPECTED: table names after JOIN
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Product\\nJOIN '); ed.setPosition({lineNumber:2, column:6}); ed.focus(); return 'T20: JOIN table'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { document.querySelector('kw-sql-section')._editor.trigger('test','editor.action.triggerSuggest',{}); return 'suggest'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "20-join-table"
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); return 'T20-JOIN(' + rows.length + '): ' + rows.slice(0,15).map(r => { const n = (r.querySelector('.label-name')||{}).textContent||''; const d = (r.querySelector('.details-label')||{}).textContent||''; return n.trim() + (d.trim() ? ' [' + d.trim() + ']' : ''); }).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    Then I take a screenshot "99-final"
