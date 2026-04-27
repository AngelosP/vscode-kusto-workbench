Feature: SQL toolbar actions — prettify, comment toggle, undo/redo, search

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Prettify, toggle comment, undo, redo, and search
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    # Focus the SQL editor
    When I wait for "kw-sql-section" in the webview for 10 seconds
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # Set ugly SQL
    When I evaluate "window.__e2e.sql.setQuery(`select * from mytable where id=1 and name='test'`)" in the webview
    And I wait 1 second
    Then I take a screenshot "01-before-prettify"

    # ── TEST 1: Prettify formats SQL ──────────────────────────────────────
    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Prettify]'); if (!btn) throw new Error('Prettify toolbar button not found'); btn.click(); return 'prettify clicked'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (val === `select * from mytable where id=1 and name='test'`) throw new Error('SQL was not prettified - still equals original'); const lines = val.split('\\n'); if (lines.length < 2) throw new Error('Prettified SQL should be multi-line, got ' + lines.length + ' lines: ' + val.substring(0, 80)); return 'prettified (' + lines.length + ' lines): ' + val.substring(0, 80); })()" in the webview
    Then I take a screenshot "02-after-prettify"

    # ── TEST 2: Toggle comment ────────────────────────────────────────────
    # Set a simple query, select all, toggle comment
    When I evaluate "(() => { window.__e2e.sql.setQuery('SELECT 1'); return window.__e2e.sql.setSelection(1, 1, 1, 9); })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Comment]'); if (!btn) throw new Error('Comment toolbar button not found'); btn.click(); return 'comment clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (!val.includes('--')) throw new Error('Comment toggle should add -- prefix, got: ' + val); return 'commented: ' + val; })()" in the webview
    Then I take a screenshot "03-commented"

    # ── TEST 3: Undo reverts comment ──────────────────────────────────────
    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Undo]'); if (!btn) throw new Error('Undo toolbar button not found'); btn.click(); return 'undo clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (val.includes('--')) throw new Error('Undo should remove comment, got: ' + val); if (!val.includes('SELECT')) throw new Error('Undo should restore SELECT, got: ' + val); return 'undone: ' + val; })()" in the webview
    Then I take a screenshot "04-undone"

    # ── TEST 4: Redo re-applies comment ───────────────────────────────────
    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Redo]'); if (!btn) throw new Error('Redo toolbar button not found'); btn.click(); return 'redo clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (!val.includes('--')) throw new Error('Redo should restore comment, got: ' + val); return 'redone: ' + val; })()" in the webview
    Then I take a screenshot "05-redone"

    # ── TEST 5: Search opens find widget ──────────────────────────────────
    When I evaluate "window.__e2e.sql.setQuery(`SELECT * FROM Products WHERE Color = 'Red'`)" in the webview
    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Search]'); if (!btn) throw new Error('Search toolbar button not found'); btn.click(); return 'search clicked'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const findWidget = el.querySelector('.find-widget') || el.querySelector('.monaco-editor .find-widget'); if (!findWidget) throw new Error('Find widget not visible after triggering search'); const visible = findWidget.style.display !== 'none' && findWidget.offsetHeight > 0; if (!visible) throw new Error('Find widget exists but is not visible'); return 'find widget visible ✓'; })()" in the webview
    Then I take a screenshot "06-find-widget"

    # Close find widget
    When I press "Escape"
    And I wait 1 second
    When I execute command "workbench.action.closeAllEditors"
