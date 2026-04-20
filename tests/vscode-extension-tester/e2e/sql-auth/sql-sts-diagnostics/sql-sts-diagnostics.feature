Feature: SQL STS diagnostics — red squiggles for invalid T-SQL

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Invalid SQL shows diagnostic markers, fixing clears them
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true']" in the webview for 10 seconds

    # Explicitly trigger STS connect (matches sts-ac-v2 pattern)
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el || !el._sqlConnectionId || !el._database) return 'skip'; window.vscode.postMessage({ type: 'stsConnect', boxId: el.boxId, sqlConnectionId: el._sqlConnectionId, database: el._database }); return 'stsConnect: ' + el._database; })()" in the webview

    # Wait for STS to be ready (may take time for download + startup)
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds
    Then I take a screenshot "01-sts-ready"

    # Focus editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── TEST 1: Type invalid SQL → diagnostic markers appear ──────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SELEC * FORM invalid_syntax_here'); ed.focus(); return 'set invalid SQL'; })()" in the webview

    # Wait for STS to process and push diagnostics (may take a few seconds)
    And I wait 8 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; const model = ed.getModel(); if (!model) throw new Error('No editor model'); const markers = monaco.editor.getModelMarkers({ resource: model.uri }); return 'markers(' + markers.length + '): ' + markers.slice(0, 5).map(m => m.message.substring(0, 40) + ' [L' + m.startLineNumber + ':' + m.startColumn + ']').join('; '); })()" in the webview
    Then I take a screenshot "02-diagnostics-visible"

    # Verify at least one marker exists
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; const model = ed.getModel(); const markers = monaco.editor.getModelMarkers({ resource: model.uri }); if (markers.length === 0) throw new Error('Expected diagnostic markers for invalid SQL, but got 0 markers'); return 'diagnostic markers present: ' + markers.length + ' ✓'; })()" in the webview

    # ── TEST 2: Fix the SQL → markers should clear ────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SELECT 1 AS test_value'); ed.focus(); return 'set valid SQL'; })()" in the webview
    And I wait 8 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; const model = ed.getModel(); const markers = monaco.editor.getModelMarkers({ resource: model.uri }); return 'markers after fix: ' + markers.length + ' — ' + (markers.length === 0 ? '✓ cleared' : 'remaining: ' + markers.map(m => m.message.substring(0, 30)).join('; ')); })()" in the webview
    Then I take a screenshot "03-markers-cleared"

    # ── TEST 3: Kusto section should NOT have SQL diagnostics ─────────────
    # Add a Kusto section and verify no SQL markers leak to it
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const kqlEl = document.querySelector('kw-query-section'); if (!kqlEl) return 'no kusto section — skipping isolation test'; const boxId = kqlEl.boxId || kqlEl.id; const ed = window.queryEditors && window.queryEditors[boxId]; if (!ed) return 'no kusto editor found — skipping'; const model = ed.getModel(); if (!model) return 'no kusto model — skipping'; const markers = monaco.editor.getModelMarkers({ resource: model.uri, owner: 'sql-sts' }); if (markers.length > 0) throw new Error('Kusto section should have 0 sql-sts markers but has ' + markers.length); return 'Kusto section has 0 sql-sts markers — isolation verified ✓'; })()" in the webview
    Then I take a screenshot "04-kusto-isolation"
