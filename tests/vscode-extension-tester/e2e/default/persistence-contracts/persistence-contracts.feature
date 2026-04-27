Feature: Persistence contracts for unresolved selections and legacy file shapes

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Save and reopen unresolved Kusto and SQL selections without dropping metadata
    Given a file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" exists

    When I open file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    And I wait for "kw-query-section" in the webview for 20 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const queryId = window.addQueryBox({ id: 'query_unresolved_selection', initialQuery: String.raw`print marker = 'unresolved_kusto_marker'` }); const query = document.getElementById(queryId); query.setName('Unresolved Kusto Selection'); query.setDesiredClusterUrl('https://unresolved-e2e.kusto.windows.net'); query.setDesiredDatabase('UnresolvedDb'); window.addSqlBox({ id: 'sql_unresolved_selection', name: 'Unresolved SQL Selection', query: String.raw`SELECT 'unresolved_sql_marker' AS marker;`, serverUrl: 'unresolved-sql-e2e.database.windows.net', database: 'UnresolvedWarehouse', expanded: true, afterBoxId: queryId }); return 'created unresolved selection sections'; })()" in the webview
    And I wait 5 seconds

    When I evaluate "window.__e2e.persistence.selectKustoRunMode('sample100', '#query_unresolved_selection')" in the webview
    When I evaluate "window.__e2e.persistence.selectSqlRunMode('plain', 'sql_unresolved_selection')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.persistence.assertDocumentKind('kqlx')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionOrder('query,sql')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionIds('query_unresolved_selection,sql_unresolved_selection')" in the webview
    When I evaluate "window.__e2e.persistence.assertQuerySection('query_unresolved_selection', { name: 'Unresolved Kusto Selection', queryIncludes: 'unresolved_kusto_marker', clusterUrl: 'https://unresolved-e2e.kusto.windows.net', database: 'UnresolvedDb', runMode: 'sample100', resultsVisible: true })" in the webview
    When I evaluate "window.__e2e.persistence.assertSqlSection('sql_unresolved_selection', { name: 'Unresolved SQL Selection', queryIncludes: 'unresolved_sql_marker', serverUrl: 'unresolved-sql-e2e.database.windows.net', database: 'UnresolvedWarehouse', runMode: 'plain' })" in the webview
    Then I take a screenshot "01-unresolved-before-save"

    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    Then the file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" should contain "unresolved-e2e.kusto.windows.net"
    Then the file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" should contain "UnresolvedDb"
    Then the file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" should contain "unresolved-sql-e2e.database.windows.net"
    Then the file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" should contain "UnresolvedWarehouse"
    Then the file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" should contain "sample100"
    Then the file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" should contain "plain"

    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "kw-sql-section" in the webview for 20 seconds
    And I wait 4 seconds
    Then I take a screenshot "02-unresolved-after-reopen"

    When I evaluate "window.__e2e.persistence.assertSectionOrder('query,sql')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionIds('query_unresolved_selection,sql_unresolved_selection')" in the webview
    When I evaluate "window.__e2e.persistence.assertQuerySection('query_unresolved_selection', { name: 'Unresolved Kusto Selection', queryIncludes: 'unresolved_kusto_marker', clusterUrl: 'https://unresolved-e2e.kusto.windows.net', database: 'UnresolvedDb', runMode: 'sample100', resultsVisible: true })" in the webview
    When I evaluate "window.__e2e.persistence.assertSqlSection('sql_unresolved_selection', { name: 'Unresolved SQL Selection', queryIncludes: 'unresolved_sql_marker', serverUrl: 'unresolved-sql-e2e.database.windows.net', database: 'UnresolvedWarehouse', runMode: 'plain' })" in the webview

    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    When I delete file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx"

  Scenario: Legacy KQLX file shapes restore as current sections
    When I open file "tests/vscode-extension-tester/e2e/default/persistence-contracts/fixtures/legacy-kqlx-contract.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "kw-query-section" in the webview for 20 seconds
    When I wait for "kw-markdown-section" in the webview for 20 seconds
    And I wait 4 seconds
    Then I take a screenshot "03-legacy-kqlx-opened"

    When I evaluate "window.__e2e.persistence.assertDocumentKind('kqlx')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionOrder('query,markdown')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionIds('query_legacy_copilot,markdown_legacy_preview')" in the webview
    When I evaluate "window.__e2e.persistence.assertQuerySection('query_legacy_copilot', { name: 'Legacy Copilot Query', queryIncludes: 'legacy_kqlx_marker_alpha', clusterUrl: 'https://persist-e2e.kusto.windows.net', database: 'PersistDb', runMode: 'sample100', resultsVisible: false, resultRows: 2, resultColumns: 'RowId,Label' })" in the webview
    When I evaluate "window.__e2e.persistence.assertMarkdownSection('markdown_legacy_preview', { title: 'Legacy Preview Notes', textIncludes: 'legacy markdown marker', mode: 'preview', tab: 'preview' })" in the webview

    When I execute command "workbench.action.revertAndCloseActiveEditor"
