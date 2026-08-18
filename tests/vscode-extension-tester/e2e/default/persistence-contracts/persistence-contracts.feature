Feature: Persistence contracts for unresolved selections and legacy file shapes

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
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
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
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
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "02-unresolved-after-reopen"

    When I evaluate "window.__e2e.persistence.assertSectionOrder('query,sql')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionIds('query_unresolved_selection,sql_unresolved_selection')" in the webview
    When I evaluate "window.__e2e.persistence.assertQuerySection('query_unresolved_selection', { name: 'Unresolved Kusto Selection', queryIncludes: 'unresolved_kusto_marker', clusterUrl: 'https://unresolved-e2e.kusto.windows.net', database: 'UnresolvedDb', runMode: 'sample100', resultsVisible: true })" in the webview
    When I evaluate "window.__e2e.persistence.assertSqlSection('sql_unresolved_selection', { name: 'Unresolved SQL Selection', queryIncludes: 'unresolved_sql_marker', serverUrl: 'unresolved-sql-e2e.database.windows.net', database: 'UnresolvedWarehouse', runMode: 'plain' })" in the webview
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    When I delete file "tests/vscode-extension-tester/runs/default/persistence-contracts/unresolved-selection.kqlx"

  Scenario: Legacy KQLX file shapes restore as current sections
    Given a file "tests/vscode-extension-tester/runs/default/persistence-contracts/legacy-kqlx-contract.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"caretDocsEnabled":true,"sections":[{"id":"query_legacy_copilot","type":"copilotQuery","name":"Legacy Copilot Query","clusterUrl":"https://persist-e2e.kusto.windows.net","database":"PersistDb","query":"datatable(RowId:int, Label:string)[1, 'legacy_kqlx_marker_alpha', 2, 'legacy_kqlx_marker_beta']","expanded":true,"resultsVisible":false,"runMode":"sample100","cacheEnabled":true,"cacheValue":3,"cacheUnit":"hours","resultJson":"{\"columns\":[{\"name\":\"RowId\",\"type\":\"int\"},{\"name\":\"Label\",\"type\":\"string\"}],\"rows\":[[1,\"legacy_kqlx_marker_alpha\"],[2,\"legacy_kqlx_marker_beta\"]],\"metadata\":{\"executionTime\":\"00:00:00.123\",\"clientActivityId\":\"legacy-kqlx-contract-e2e\"}}"},{"id":"markdown_legacy_preview","type":"markdown","title":"Legacy Preview Notes","text":"# Legacy Markdown\nlegacy markdown marker survives preview tab restore","tab":"preview","expanded":true}]}}
      """
    When I execute command "kustoWorkbench.test.preparePersistedResultFixture" with args '[{"engine":"kusto","templatePath":"tests/vscode-extension-tester/runs/default/persistence-contracts/legacy-kqlx-contract.kqlx","outputPath":"tests/vscode-extension-tester/runs/default/persistence-contracts/legacy-kqlx-contract.kqlx"}]'
    When I open file "tests/vscode-extension-tester/runs/default/persistence-contracts/legacy-kqlx-contract.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "kw-query-section" in the webview for 20 seconds
    When I wait for "kw-markdown-section" in the webview for 20 seconds
    And I wait 4 seconds
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "03-legacy-kqlx-opened"

    When I evaluate "window.__e2e.persistence.assertDocumentKind('kqlx')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionOrder('query,markdown')" in the webview
    When I evaluate "window.__e2e.persistence.assertSectionIds('query_legacy_copilot,markdown_legacy_preview')" in the webview
    When I evaluate "window.__e2e.persistence.assertQuerySection('query_legacy_copilot', { name: 'Legacy Copilot Query', queryIncludes: 'legacy_kqlx_marker_alpha', clusterUrl: 'https://persist-e2e.kusto.windows.net', database: 'PersistDb', runMode: 'sample100', resultsVisible: false, resultRows: 2, resultColumns: 'RowId,Label' })" in the webview
    When I evaluate "window.__e2e.persistence.assertMarkdownSection('markdown_legacy_preview', { title: 'Legacy Preview Notes', textIncludes: 'legacy markdown marker', mode: 'preview', tab: 'preview' })" in the webview

    When I execute command "workbench.action.revertAndCloseActiveEditor"
    When I execute command "kustoWorkbench.test.cleanupPersistedResultFixture"
    When I delete file "tests/vscode-extension-tester/runs/default/persistence-contracts/legacy-kqlx-contract.kqlx"
