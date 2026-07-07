Feature: Kusto identity manual checklist

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Short, full, regional, favorites, cached databases, and ADX export use one logical identity
    When I execute command "kustoWorkbench.test.cleanupKustoIdentityChecklist"
    When I execute command "kustoWorkbench.test.seedKustoIdentityChecklist"
    When I execute command "kusto.openQueryEditor"
    And I wait 2 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 15 seconds

    Then I collect JSON artifact "kusto-identity-manual-checklist" from webview expression "window.__e2e.kusto.manualIdentityChecklist.run()"
    When I execute command "kustoWorkbench.test.assertClipboardContains" with args '["https://dataexplorer.azure.com/clusters/identityadx.westus/databases/ChecklistDb?query="]'
    Then I take a screenshot "kusto-identity-manual-checklist-proof"

    When I execute command "kustoWorkbench.test.cleanupKustoIdentityChecklist"
    When I execute command "workbench.action.closeAllEditors"