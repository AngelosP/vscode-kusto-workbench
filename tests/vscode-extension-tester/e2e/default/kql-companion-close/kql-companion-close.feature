Feature: KQL companion metadata close

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 900

  Scenario: Save dirty companion metadata from the real close prompt and reopen it
    Given a file "tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql" exists with content "StormEvents | take 5"
    And a file "tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql.json" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"type":"query","linkedQueryPath":"sidecar-close.kql"}]}}
      """
    When I open file "tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql" in the editor
    And I wait 2 seconds
    When I start command "workbench.action.reopenWithEditor"
    And I wait 1 second
    When I select "Kusto Query (Compatibility Mode)" from the QuickPick
    And I wait 5 seconds
    When I wait for "button[data-add-kind='markdown']" in the webview for 10 seconds
    And I click "button[data-add-kind='markdown']" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-markdown-section'); if (!section) throw new Error('Markdown section was not added'); section.setText('Saved from close prompt'); section.setName('Close prompt note'); section.commitDocumentState(); window.schedulePersist('close-prompt-e2e', true); return section.id; })()" in the webview
    And I wait 1 second
    Then I collect JSON artifact "sidecar-dirty-before-close" from extension host expression "(async () => { const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith('/tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql')); if (!document) throw new Error('Open sidecar-close.kql document is unavailable'); const uri = document.uri.with({ path: document.uri.path + '.json' }); const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); if (text.includes('Saved from close prompt')) throw new Error('Dirty sidecar was written before close'); return { persistedBeforeClose: false, bytes: text.length }; })()"
    When I start command "workbench.action.closeActiveEditor"
    And I wait 1 second
    When I click "Save" on the "Visual Studio Code" dialog
    And I wait 2 seconds
    Then the file "tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql.json" should contain "Saved from close prompt"
    When I open file "tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql" in the editor
    And I wait 2 seconds
    When I start command "workbench.action.reopenWithEditor"
    And I wait 1 second
    When I select "Kusto Query (Compatibility Mode)" from the QuickPick
    And I wait 5 seconds
    When I wait for "kw-markdown-section" in the webview for 10 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-markdown-section'); if (!section || section.getText() !== 'Saved from close prompt' || section.getName() !== 'Close prompt note') throw new Error('Saved companion metadata did not restore'); return { id: section.id, name: section.getName(), text: section.getText() }; })()" in the webview
    When I click at 30, 700
    Then I take a screenshot "01-close-prompt-sidecar-restored"
    When I execute command "workbench.action.revertAndCloseActiveEditor"
    When I delete file "tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql"
    When I delete file "tests/vscode-extension-tester/e2e/default/kql-companion-close/sidecar-close.kql.json"