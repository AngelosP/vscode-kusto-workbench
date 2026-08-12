Feature: Exact clipboard share result artifacts

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Share pins A, reopens on B, and denies or revokes unavailable rows
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I click the element "session.kqlx"
    When I evaluate "window.__e2e.share.assertArtifactClipboard()" in the webview for 20 seconds
    And I wait 1 second
    Then I collect JSON artifact "hst5-rich-share-clipboard" from extension host expression "(async () => { const text = await vscode.env.clipboard.readText(); if (!text.includes('artifact-b') || text.includes('must-not-copy') || text.includes('revoked')) throw new Error('Unexpected rich-share clipboard: ' + JSON.stringify(text)); return { text, containsArtifactB: true, containsDenied: false, containsRevoked: false }; })()"
    When I execute command "workbench.action.closeAllEditors"

  Scenario: Copy a Kusto ADX link through the real host clipboard adapter
    When I execute command "kustoWorkbench.test.cleanupKustoIdentityChecklist"
    When I execute command "kustoWorkbench.test.seedKustoIdentityChecklist"
    When I execute command "kusto.openQueryEditor"
    And I wait 2 seconds
    When I evaluate "(() => { const connection = (window.connections || []).find(c => c.name === 'E2E Identity Checklist Regional'); if (!connection) throw new Error('HST-5 seeded connection unavailable'); window.vscode?.postMessage({ type: 'copyAdeLink', boxId: 'hst5-native-copy', query: 'print hst5_query_sharing = 1', connectionId: connection.id, database: 'ChecklistDb' }); return { connectionId: connection.id }; })()" in the webview for 15 seconds
    And I wait 1 second
    When I execute command "kustoWorkbench.test.assertClipboardContains" with args '["https://dataexplorer.azure.com/clusters/identityadx.westus/databases/ChecklistDb?query="]'
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "hst5-query-sharing-clipboard"
    When I execute command "kustoWorkbench.test.cleanupKustoIdentityChecklist"
    When I execute command "workbench.action.closeAllEditors"
