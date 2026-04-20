Feature: SQL persistence — save and reopen .sqlx file

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Create SQL section, verify serialization captures all state
    # ── Setup: open session editor, add SQL section, connect ──────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Clear and add SQL section
    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select database
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true']" in the webview for 10 seconds

    # Set query text
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el._editor.setValue('SELECT 42 AS persistence_test'); el._editor.focus(); return 'query set'; })()" in the webview
    And I wait 1 second

    # Set run mode to plain
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); window.setRunMode(el.boxId || el.id, 'plain'); return 'mode=plain'; })()" in the webview
    And I wait 1 second

    # ── TEST 1: Verify serialization captures all state ──────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); const checks = []; if (data.type !== 'sql') checks.push('type=' + data.type + ' (expected sql)'); if (!data.query || !data.query.includes('persistence_test')) checks.push('query missing persistence_test'); if (!data.serverUrl) checks.push('no serverUrl'); if (!data.database) checks.push('no database'); if (data.runMode !== 'plain') checks.push('runMode=' + data.runMode + ' (expected plain)'); if (checks.length) throw new Error('Serialization issues: ' + checks.join('; ')); return 'serialization complete: type=' + data.type + ', query=' + data.query.substring(0,30) + ', db=' + data.database + ', runMode=' + data.runMode + ' ✓'; })()" in the webview
    Then I take a screenshot "01-serialization-verified"

    # ── TEST 2: Verify state survives auto-persist cycle ──────────────────
    # Trigger a persist cycle and wait
    When I evaluate "(() => { window.schedulePersist && window.schedulePersist(); return 'persist scheduled'; })()" in the webview
    And I wait 3 seconds

    # Re-read serialized state
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (!data.query.includes('persistence_test')) throw new Error('Query text lost after persist cycle'); if (data.runMode !== 'plain') throw new Error('Run mode changed after persist: ' + data.runMode); return 'state stable after persist ✓'; })()" in the webview
    Then I take a screenshot "02-state-stable"

    # ── TEST 3: Expanded state persists ───────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (data.expanded !== true && data.expanded !== undefined) throw new Error('Expected expanded=true, got: ' + data.expanded); return 'expanded=' + data.expanded + ' ✓'; })()" in the webview

    # Collapse and verify serialization
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); shell?.shadowRoot?.querySelector('.toggle-btn')?.click(); return 'collapsed'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (data.expanded !== false) throw new Error('Expected expanded=false after collapse, got: ' + data.expanded); return 'collapsed state serialized ✓'; })()" in the webview
    Then I take a screenshot "03-collapsed-state"
