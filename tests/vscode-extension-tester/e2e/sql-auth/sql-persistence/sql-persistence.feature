Feature: SQL persistence — save and reopen .sqlx file

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Save and reopen a SQL document with section state
    Given a file "tests/vscode-extension-tester/runs/sql-auth/sql-persistence/workfile.sqlx" exists

    When I open file "tests/vscode-extension-tester/runs/sql-auth/sql-persistence/workfile.sqlx" in the editor
    And I wait 6 seconds
    When I wait for "#queries-container" in the webview for 20 seconds

    # Clear any restored state from a reused profile/workfile and add one SQL section through the UI.
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select database through the dropdown
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds

    # Set query text
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.setQuery('SELECT 42 AS sql_persistence_marker;')" in the webview
    And I wait 1 second

    # Set run mode to plain through the visible split-button menu.
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.boxId || el.id; const toggle = document.getElementById(boxId + '_sql_run_toggle'); if (!toggle) throw new Error('SQL run-mode toggle not found'); toggle.click(); const menu = document.getElementById(boxId + '_sql_run_menu'); const plain = Array.from(menu?.querySelectorAll('[role=menuitem]') || []).find(item => (item.textContent || '').trim() === 'Run Query'); if (!plain) throw new Error('Plain Run Query menu item not found'); plain.click(); return 'mode=plain via menu'; })()" in the webview
    And I wait 1 second

    # Collapse through the real shell control before saving, so reopen proves UI state too.
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); const toggle = shell?.shadowRoot?.querySelector('.toggle-btn'); if (!toggle) throw new Error('Section collapse toggle not found'); toggle.click(); return 'collapsed via shell toggle'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); const checks = []; if (data.type !== 'sql') checks.push('type=' + data.type); if (!data.query || !data.query.includes('sql_persistence_marker')) checks.push('query missing sql_persistence_marker'); if (!data.serverUrl) checks.push('no serverUrl'); if (!data.database) checks.push('no database'); if (data.runMode !== 'plain') checks.push('runMode=' + data.runMode); if (data.expanded !== false) checks.push('expanded=' + data.expanded); if (checks.length) throw new Error('Pre-save serialization issues: ' + checks.join('; ')); return 'pre-save SQL state verified'; })()" in the webview
    Then I take a screenshot "01-before-save-collapsed"

    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    Then the file "tests/vscode-extension-tester/runs/sql-auth/sql-persistence/workfile.sqlx" should contain "sql_persistence_marker"
    Then the file "tests/vscode-extension-tester/runs/sql-auth/sql-persistence/workfile.sqlx" should contain "plain"

    # The file content assertions above prove the desired state is on disk; discard-close avoids a VS Code close prompt if the custom editor remains transiently dirty.
    When I execute command "workbench.action.revertAndCloseActiveEditor"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/sql-auth/sql-persistence/workfile.sqlx" in the editor
    And I wait 8 seconds
    When I wait for "kw-sql-section" in the webview for 20 seconds
    Then I take a screenshot "02-after-reopen"

    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-sql-section')); if (sections.length !== 1) throw new Error('Expected exactly one SQL section after reopen, found ' + sections.length); const data = sections[0].serialize(); const checks = []; if (data.type !== 'sql') checks.push('type=' + data.type); if (!data.query || !data.query.includes('sql_persistence_marker')) checks.push('query missing sql_persistence_marker'); if (!data.serverUrl) checks.push('no serverUrl'); if (!data.database) checks.push('no database'); if (data.runMode !== 'plain') checks.push('runMode=' + data.runMode); if (data.expanded !== false) checks.push('expanded=' + data.expanded); if (checks.length) throw new Error('Reopened SQL state issues: ' + checks.join('; ')); return 'reopened SQL state verified'; })()" in the webview

    When I execute command "workbench.action.revertAndCloseActiveEditor"
    And I wait 1 second
    When I delete file "tests/vscode-extension-tester/runs/sql-auth/sql-persistence/workfile.sqlx"
