Feature: Kusto identity manual checklist

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Short, full, regional, favorites, cached databases, and ADX export use one logical identity
    When I execute command "kustoWorkbench.test.prepareKustoIdentitySelectionBaseline"
    When I execute command "kustoWorkbench.test.seedKustoIdentityChecklist"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-identity-manual-checklist/identity-checklist.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"query_identity_checklist","type":"query","name":"Identity checklist","query":"print identity_checklist = 1","expanded":true}]}}
      """
    When I open file "tests/vscode-extension-tester/runs/default/kusto-identity-manual-checklist/identity-checklist.kqlx" in the editor
    When I wait for "kw-query-section .monaco-editor" in the webview "identity-checklist.kqlx" for 20 seconds
    When I evaluate "window.__e2e.workbench.persistAndWait('e2e-identity-baseline', 25000)" in the webview "identity-checklist.kqlx" for 28 seconds

    Then I collect JSON artifact "kusto-identity-manual-checklist" from webview expression "window.__e2e.kusto.manualIdentityChecklist.run()" in the webview "identity-checklist.kqlx"
    When I execute command "kustoWorkbench.test.assertClipboardContains" with args '["https://dataexplorer.azure.com/clusters/identityadx.westus/databases/ChecklistDb?query="]'

    When I execute command "workbench.action.files.save"
    And I wait 2 seconds
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupKustoIdentityChecklist" with args '["tests/vscode-extension-tester/runs/default/kusto-identity-manual-checklist/identity-checklist.kqlx"]'
    And I delete file "tests/vscode-extension-tester/runs/default/kusto-identity-manual-checklist/identity-checklist.kqlx"
    When I execute command "kustoWorkbench.test.assertAndCleanupKustoIdentitySelectionBaseline"