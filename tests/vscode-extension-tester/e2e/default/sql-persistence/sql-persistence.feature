Feature: SQL persistence without authentication

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Save and reopen a SQLX document with unresolved connection metadata and collapsed state
    Given a file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx" exists

    When I open file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx" in the editor
    And I wait 6 seconds
    When I wait for "#queries-container" in the webview for 20 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { window.addSqlBox({ id: 'sql_default_persistence', name: 'Unresolved SQLX Persistence', query: String.raw`SELECT 'sql_default_persistence_marker' AS marker;`, serverUrl: 'unresolved-default-sql-e2e.database.windows.net', database: 'DefaultWarehouse', expanded: true }); return 'created unresolved SQLX persistence section'; })()" in the webview
    And I wait 5 seconds
    When I wait for "kw-sql-section" in the webview for 20 seconds

    When I evaluate "window.__e2e.persistence.selectSqlRunMode('plain', 'sql_default_persistence')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.getElementById('sql_default_persistence'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); const toggle = shell?.shadowRoot?.querySelector('.toggle-btn'); if (!toggle) throw new Error('Section collapse toggle not found'); toggle.click(); return 'collapsed via shell toggle'; })()" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.persistence.assertDocumentKind('sqlx')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionOrder('sql')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionIds('sql_default_persistence')" in the webview
    When I evaluate "window.__e2e.persistence.assertSqlSection('sql_default_persistence', { name: 'Unresolved SQLX Persistence', queryIncludes: 'sql_default_persistence_marker', serverUrl: 'unresolved-default-sql-e2e.database.windows.net', database: 'DefaultWarehouse', runMode: 'plain', expanded: false })" in the webview
    Then I take a screenshot "01-before-save-collapsed"

    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    Then the file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx" should contain "sql_default_persistence_marker"
    Then the file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx" should contain "unresolved-default-sql-e2e.database.windows.net"
    Then the file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx" should contain "DefaultWarehouse"
    Then the file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx" should contain "plain"

    When I execute command "workbench.action.revertAndCloseActiveEditor"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx" in the editor
    And I wait 8 seconds
    When I wait for "kw-sql-section" in the webview for 20 seconds
    And I wait 4 seconds
    Then I take a screenshot "02-after-reopen"

    When I evaluate "window.__e2e.persistence.assertDocumentKind('sqlx')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionOrder('sql')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionIds('sql_default_persistence')" in the webview
    When I evaluate "window.__e2e.persistence.assertSqlSection('sql_default_persistence', { name: 'Unresolved SQLX Persistence', queryIncludes: 'sql_default_persistence_marker', serverUrl: 'unresolved-default-sql-e2e.database.windows.net', database: 'DefaultWarehouse', runMode: 'plain', expanded: false })" in the webview

    When I execute command "workbench.action.revertAndCloseActiveEditor"
    And I wait 1 second
    When I delete file "tests/vscode-extension-tester/runs/default/sql-persistence/workfile.sqlx"
