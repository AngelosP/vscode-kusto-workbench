Feature: SQL toolbar actions - prettify, comment toggle, undo, redo, search

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Prettify, toggle comment, undo, redo, and search without a SQL connection
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section" in the webview for 10 seconds
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.setQuery(`select * from mytable where id=1 and name='test'`)" in the webview
    And I wait 1 second
    Then I take a screenshot "01-before-prettify"

    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Prettify]'); if (!btn) throw new Error('Prettify toolbar button not found'); btn.click(); return 'prettify clicked'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (val === `select * from mytable where id=1 and name='test'`) throw new Error('SQL was not prettified - still equals original'); const lines = val.split('\\n'); if (lines.length < 2) throw new Error('Prettified SQL should be multi-line, got ' + lines.length + ' lines: ' + val.substring(0, 80)); return 'prettified (' + lines.length + ' lines): ' + val.substring(0, 80); })()" in the webview
    Then I take a screenshot "02-after-prettify"

    When I evaluate "(() => { window.__e2e.sql.setQuery('SELECT 1'); return window.__e2e.sql.setSelection(1, 1, 1, 9); })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Comment]'); if (!btn) throw new Error('Comment toolbar button not found'); btn.click(); return 'comment clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (!val.includes('--')) throw new Error('Comment toggle should add -- prefix, got: ' + val); return 'commented: ' + val; })()" in the webview
    Then I take a screenshot "03-commented"

    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Undo]'); if (!btn) throw new Error('Undo toolbar button not found'); btn.click(); return 'undo clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (val.includes('--')) throw new Error('Undo should remove comment, got: ' + val); if (!val.includes('SELECT')) throw new Error('Undo should restore SELECT, got: ' + val); return 'undone: ' + val; })()" in the webview
    Then I take a screenshot "04-undone"

    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Redo]'); if (!btn) throw new Error('Redo toolbar button not found'); btn.click(); return 'redo clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const val = window.__testGetMonacoValue('kw-sql-section .query-editor'); if (!val.includes('--')) throw new Error('Redo should restore comment, got: ' + val); return 'redone: ' + val; })()" in the webview
    Then I take a screenshot "05-redone"

    When I evaluate "window.__e2e.sql.setQuery(`SELECT * FROM Products WHERE Color = 'Red'`)" in the webview
    When I evaluate "(() => { const btn = document.querySelector('kw-sql-toolbar button[aria-label=Search]'); if (!btn) throw new Error('Search toolbar button not found'); btn.click(); return 'search clicked'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const findWidget = el.querySelector('.find-widget') || el.querySelector('.monaco-editor .find-widget'); if (!findWidget) throw new Error('Find widget not visible after triggering search'); const visible = findWidget.style.display !== 'none' && findWidget.offsetHeight > 0; if (!visible) throw new Error('Find widget exists but is not visible'); return 'find widget visible'; })()" in the webview
    Then I take a screenshot "06-find-widget"

    When I press "Escape"
    And I wait 1 second
    When I execute command "workbench.action.closeAllEditors"

  Scenario: Narrow toolbar overflow executes an action and dismisses on page scroll
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 700 by 900
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.layout.createStressNotebook()" in the webview for 20 seconds
    And I evaluate "(() => { const section = document.getElementById('e2e_layout_sql'); const toolbar = section?.querySelector('kw-sql-toolbar'); const surface = toolbar?.querySelector('.query-editor-toolbar'); if (!section || !toolbar || !surface) throw new Error('Layout SQL toolbar is missing'); toolbar.style.display = 'block'; toolbar.style.width = '180px'; toolbar.style.maxWidth = '180px'; surface.style.width = '180px'; surface.style.maxWidth = '180px'; section.scrollIntoView({ block: 'start' }); window.__e2e.sql.setQuery(`select * from mytable where id=1 and name='test'`); return { toolbarWidth: toolbar.getBoundingClientRect().width, surfaceWidth: surface.getBoundingClientRect().width }; })()" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-toolbar [data-testid='toolbar-overflow-button']" in the webview for 10 seconds
    And I evaluate "(() => { const button = document.querySelector(`kw-sql-toolbar [data-testid='toolbar-overflow-button']`); if (!button || button.getBoundingClientRect().width <= 0) throw new Error('Toolbar overflow button is not visible'); return button.getAttribute('aria-expanded'); })()" in the webview
    When I click "kw-sql-toolbar [data-testid='toolbar-overflow-button']" in the webview
    And I wait for "kw-sql-toolbar [data-testid='toolbar-overflow-menu']" in the webview for 10 seconds
    And I wait for "kw-sql-toolbar [data-action-label='Search']" in the webview for 10 seconds
    When I click "kw-sql-toolbar [data-action-label='Search']" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.getElementById('e2e_layout_sql'); const findWidget = section?.querySelector('.find-widget') || section?.querySelector('.monaco-editor .find-widget'); if (!findWidget || findWidget.getBoundingClientRect().height <= 0) throw new Error('Overflow Search did not open the Monaco find widget'); if (document.querySelector(`kw-sql-toolbar [data-testid='toolbar-overflow-menu']`)) throw new Error('Overflow menu remained open after action'); return 'overflow Search opened Monaco find'; })()" in the webview
    When I press "Escape"
    And I wait 1 second
    When I click "kw-sql-toolbar [data-testid='toolbar-overflow-button']" in the webview
    And I wait for "kw-sql-toolbar [data-testid='toolbar-overflow-menu']" in the webview for 10 seconds
    When I scroll "[data-kw-page-scroll-element='true']" by 0 300
    And I wait 1 second
    When I evaluate "(() => { const viewport = document.querySelector(`[data-kw-page-scroll-element='true']`); if (!viewport || viewport.scrollTop < 100) throw new Error('Page did not scroll'); if (document.querySelector(`kw-sql-toolbar [data-testid='toolbar-overflow-menu']`)) throw new Error('Overflow menu remained open after page scroll'); return viewport.scrollTop; })()" in the webview
    Then I take a screenshot "07-narrow-toolbar-overflow-dismissed"
    When I execute command "workbench.action.revertAndCloseActiveEditor"
