Feature: Lossless future-compatible document codec

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"

  Scenario: Edit one known field without losing future document data
    Given a file "tests/vscode-extension-tester/runs/default/codec-lossless-roundtrip/future-compatible.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"futureRoot":{"producer":2},"state":{"futureState":["keep"],"sections":[{"id":"query_codec_1","type":"query","name":"Codec Query","query":"print before = 1","futureQuerySetting":{"mode":"future"}},{"id":"future_codec_1","type":"future-section","payload":{"nested":[1,2,3]}},{"id":"markdown_codec_1","type":"markdown","title":"After opaque","text":"Visible markdown"}]}}
      """

    When I open file "tests/vscode-extension-tester/runs/default/codec-lossless-roundtrip/future-compatible.kqlx" in the editor
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.setQuery('print after = 2')" in the webview
    When I evaluate "window.__e2e.kusto.assertQuery('print after = 2')" in the webview
    When I evaluate "window.schedulePersist('codec-lossless-e2e', true)" in the webview
    And I wait 2 seconds
    When I execute command "workbench.action.files.save"
    And I wait 2 seconds
    When I click "kw-query-section .query-editor" in the webview
    Then I take a screenshot "01-lossless-codec-saved"
    Then I collect JSON artifact "lossless-codec-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/codec-lossless-roundtrip/future-compatible.kqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Open codec fixture not found'); const bytes = await vscode.workspace.fs.readFile(document.uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const sections = file.state.sections; const ids = sections.map(section => section.id); const expectedIds = ['query_codec_1','future_codec_1','markdown_codec_1']; if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new Error('Section order changed: ' + JSON.stringify(ids)); if (file.futureRoot?.producer !== 2) throw new Error('Future root field was lost'); if (JSON.stringify(file.state.futureState) !== JSON.stringify(['keep'])) throw new Error('Future state field was lost'); if (sections[0].query !== 'print after = 2') throw new Error('Known query edit was not saved: ' + sections[0].query); if (sections[0].futureQuerySetting?.mode !== 'future') throw new Error('Known-section extension was lost'); if (JSON.stringify(sections[1].payload) !== JSON.stringify({ nested: [1,2,3] })) throw new Error('Opaque section payload was lost'); return { ids, query: sections[0].query, futureRoot: file.futureRoot, futureState: file.state.futureState, futureQuerySetting: sections[0].futureQuerySetting, opaquePayload: sections[1].payload }; })()"

    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/default/codec-lossless-roundtrip/future-compatible.kqlx"
