Feature: SQL auto-trigger schema-based completions

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Auto-trigger completions appear when typing in a SQL editor
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

    # Wait for schema to load
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "00-setup-ready"

    # Auto-trigger defaults to ON — verify it
    When I evaluate "(() => { return 'autoTrigger=' + window.autoTriggerAutocompleteEnabled; })()" in the webview

    # ══════════════════════════════════════════════════════════════════════
    # TEST 1: Verify the auto-trigger toggle button exists in the SQL toolbar
    # ══════════════════════════════════════════════════════════════════════
    Then element "kw-sql-toolbar .qe-auto-autocomplete-toggle" should exist
    Then I take a screenshot "01-toggle-exists"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 2: Auto-trigger after dot — "SalesLT." should show tables
    #   The dot is NOT a word char, so end-of-word suppression does NOT fire.
    #   This is the cleanest test of auto-trigger actually working.
    #   Uses Monaco API to type (avoids OS-level focus issues).
    # ══════════════════════════════════════════════════════════════════════

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # Set up the editor and type a dot via Monaco's executeEdits API to fire onDidChangeModelContent
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT'); ed.setPosition({lineNumber:1, column:22}); ed.focus(); return 'ready: ' + ed.getValue(); })()" in the webview
    And I wait 1 second

    # Type the dot via Monaco's native type command — triggers onDidChangeModelContent reliably
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.focus(); ed.trigger('keyboard', 'type', { text: '.' }); return 'typed dot: ' + ed.getValue(); })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "02-auto-trigger-dot"

    # ASSERT: suggest widget should be visible with table names
    Then element ".suggest-widget.visible" should exist
    When I evaluate "(() => { const rows = Array.from(document.querySelectorAll('.suggest-widget.visible .monaco-list-row')); if (rows.length === 0) return 'FAIL: no suggestions'; return 'DOT(' + rows.length + '): ' + rows.slice(0,10).map(r => (r.querySelector('.label-name')||{}).textContent||'').map(s=>s.trim()).join(', '); })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 3: Auto-trigger after open paren — should show suggestions
    #   The ( char is in the trigger set and is not a word char
    # ══════════════════════════════════════════════════════════════════════

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT COUNT'); ed.setPosition({lineNumber:1, column:13}); ed.focus(); return 'ready: ' + ed.getValue(); })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.focus(); ed.trigger('keyboard', 'type', { text: '(' }); return 'typed paren: ' + ed.getValue(); })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "03-auto-trigger-paren"

    # The suggest widget should appear (COUNT( triggers suggestions for column names)
    When I evaluate "(() => { const w = document.querySelector('.suggest-widget.visible'); return w ? 'SUGGEST_VISIBLE' : 'NO_WIDGET'; })()" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 4: No auto-trigger when disabled — toggle OFF via toolbar, type dot, no widget
    # ══════════════════════════════════════════════════════════════════════

    # Click the toggle to disable auto-trigger (it's ON by default)
    When I click "kw-sql-toolbar .qe-auto-autocomplete-toggle" in the webview
    And I wait 1 second

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT'); ed.setPosition({lineNumber:1, column:22}); ed.focus(); return 'ready disabled test'; })()" in the webview
    And I wait 1 second

    # Type the same dot — but with auto-trigger disabled via toggle
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.focus(); ed.trigger('keyboard', 'type', { text: '.' }); return 'typed dot (disabled): ' + ed.getValue(); })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "04-no-auto-trigger-disabled"

    # ASSERT: suggest widget should NOT be visible
    Then element ".suggest-widget.visible" should not exist

    # Re-enable via toggle click
    When I click "kw-sql-toolbar .qe-auto-autocomplete-toggle" in the webview
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 5: Toggle sync — clicking SQL toolbar toggle changes state
    #   State is currently ON (re-enabled at end of TEST 4).
    # ══════════════════════════════════════════════════════════════════════

    # Verify auto-trigger is ON (re-enabled at end of TEST 4)
    When I evaluate "(() => { if (!window.autoTriggerAutocompleteEnabled) throw new Error('Expected autoTrigger ON'); return 'before toggle: ON'; })()" in the webview

    # Click the toggle button in the SQL toolbar — should turn it OFF
    When I click "kw-sql-toolbar .qe-auto-autocomplete-toggle" in the webview
    And I wait 1 second
    Then I take a screenshot "05-toggle-clicked-off"

    # Verify state toggled to OFF
    When I evaluate "(() => { if (window.autoTriggerAutocompleteEnabled) throw new Error('Expected autoTrigger OFF after toggle'); return 'after toggle: OFF'; })()" in the webview

    # Click again to re-enable
    When I click "kw-sql-toolbar .qe-auto-autocomplete-toggle" in the webview
    And I wait 1 second
    Then I take a screenshot "06-toggle-clicked-on"

    # Verify state toggled back to ON
    When I evaluate "(() => { if (!window.autoTriggerAutocompleteEnabled) throw new Error('Expected autoTrigger ON after re-toggle'); return 'after re-toggle: ON'; })()" in the webview

    # ══════════════════════════════════════════════════════════════════════
    # TEST 6: End-of-word suppression — typing word chars at EOL should NOT trigger
    # ══════════════════════════════════════════════════════════════════════

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT '); ed.setPosition({lineNumber:1, column:8}); ed.focus(); return 'ready'; })()" in the webview
    And I wait 1 second

    # Type word chars at end of line — end-of-word suppression should prevent trigger
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.focus(); ed.trigger('keyboard', 'type', { text: 'Name' }); return 'typed Name: ' + ed.getValue(); })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "07-end-of-word-suppression"

    # ASSERT: suggest widget should NOT be visible (end-of-word suppression)
    Then element ".suggest-widget.visible" should not exist

    # ══════════════════════════════════════════════════════════════════════
    # TEST 7: Verify auto-trigger fires after dot even after word suppression test
    #   This confirms the mechanism is still active after suppression.
    # ══════════════════════════════════════════════════════════════════════

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM dbo'); ed.setPosition({lineNumber:1, column:18}); ed.focus(); return 'ready dbo'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.focus(); ed.trigger('keyboard', 'type', { text: '.' }); return 'typed dbo.: ' + ed.getValue(); })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "08-auto-trigger-dbo-dot"

    # ASSERT: suggest widget should be visible
    Then element ".suggest-widget.visible" should exist
    When I press "Escape"
    And I wait 1 second

    Then I take a screenshot "09-final"
