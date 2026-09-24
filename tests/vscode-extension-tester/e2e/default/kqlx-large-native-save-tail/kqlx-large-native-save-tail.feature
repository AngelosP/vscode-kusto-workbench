Feature: Large KQLX native saves do not append repeated content

  Scenario: Shrinking a notebook with saved results stays valid across saves and reopen
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "large-notebook-created" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kw-large-save-tail-' + process.pid + '-' + Date.now());
        const uri = vscode.Uri.joinPath(root, 'synthetic.kqlx');
        const largeRows = Array.from({ length: 2578 }, (_, index) => [{ display: String(index), full: 'V'.repeat(2120) }]);
        const smallRows = Array.from({ length: 6 }, (_, index) => Array.from({ length: 19 }, (_, column) => ({ display: String(index), full: 'S'.repeat(100) + column })));
        const sections = Array.from({ length: 4 }, (_, index) => ({
          id: 'query_' + (index + 1), type: 'query', name: 'Synthetic ' + (index + 1),
          expanded: index === 0, resultsVisible: true,
          query: index === 0 ? 'print Probe=1' : 'print Probe=' + (index + 1) + String.fromCharCode(10) + '//' + 'Q'.repeat(4000),
          resultJson: JSON.stringify({ columns: [{ name: 'Payload', type: 'string' }], rows: index === 0 ? largeRows : smallRows }),
        }));
        const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
        await vscode.workspace.fs.createDirectory(root);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        globalThis.__largeSaveTailProbe = { root, uri, initialBytes: new TextEncoder().encode(text).length };
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { initialBytes: globalThis.__largeSaveTailProbe.initialBytes, sectionCount: sections.length, firstResultRows: largeRows.length };
      })()
      """
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    And I evaluate "window.__testSetMonacoValue('kw-query-section .monaco-editor', 'print Probe=42' + String.fromCharCode(10) + '//' + 'Z'.repeat(70000))" in the webview
    Then I collect JSON artifact "large-notebook-dirty" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__largeSaveTailProbe;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        const deadline = Date.now() + 15000;
        while (document && (!document.isDirty || !document.getText().includes('Z'.repeat(1000))) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!document?.isDirty || !document.getText().includes('Z'.repeat(1000))) throw new Error('The large query edit did not reach the backing document');
        return { dirty: true, bufferBytes: new TextEncoder().encode(document.getText()).length };
      })()
      """
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "large-notebook-saved" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__largeSaveTailProbe;
        const bytes = await vscode.workspace.fs.readFile(probe.uri);
        const text = new TextDecoder().decode(bytes);
        const file = JSON.parse(text);
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        if (file.state.sections.length !== 4 || !file.state.sections[0].query.endsWith('Z'.repeat(70000))
          || JSON.parse(file.state.sections[0].resultJson).rows.length !== 2578
          || file.state.sections.filter(section => typeof section.resultJson === 'string').length !== 4
          || document?.isDirty || document.getText() !== text) throw new Error('Large native Save did not publish an exact valid notebook');
        probe.largeSavedBytes = bytes.byteLength;
        return { validJson: true, savedBytes: bytes.byteLength, dirty: false, results: 4 };
      })()
      """
    When I evaluate "window.__testSetMonacoValue('kw-query-section .monaco-editor', 'print Probe=42')" in the webview
    Then I collect JSON artifact "short-notebook-dirty" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__largeSaveTailProbe;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        const deadline = Date.now() + 15000;
        while (document && (!document.isDirty || document.getText().includes('Z'.repeat(1000))) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!document?.isDirty || document.getText().includes('Z'.repeat(1000))) throw new Error('The shorter query edit did not reach the backing document');
        return { dirty: true, bufferBytes: new TextEncoder().encode(document.getText()).length, previousSavedBytes: probe.largeSavedBytes };
      })()
      """
    When I execute command "workbench.action.files.save"
    And I execute command "workbench.action.files.save"
    And I execute command "workbench.action.files.save"
    Then I collect JSON artifact "short-notebook-saved" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__largeSaveTailProbe;
        const bytes = await vscode.workspace.fs.readFile(probe.uri);
        const text = new TextDecoder().decode(bytes);
        const file = JSON.parse(text);
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        if (bytes.byteLength >= probe.largeSavedBytes || file.state.sections.length !== 4
          || file.state.sections[0].query !== 'print Probe=42'
          || JSON.parse(file.state.sections[0].resultJson).rows.length !== 2578
          || file.state.sections.filter(section => typeof section.resultJson === 'string').length !== 4
          || document?.isDirty || document.getText() !== text) throw new Error('Shorter native Save left stale bytes or lost results');
        return { validJson: true, savedBytes: bytes.byteLength, decreasedBytes: probe.largeSavedBytes - bytes.byteLength, dirty: false, results: 4 };
      })()
      """
    When I execute command "workbench.action.closeAllEditors"
    Then I collect JSON artifact "short-notebook-reopened" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__largeSaveTailProbe;
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(probe.uri));
        const file = JSON.parse(text);
        if (file.state.sections[0].query !== 'print Probe=42') throw new Error('The short query was not durable');
        await vscode.commands.executeCommand('vscode.openWith', probe.uri, 'kusto.kqlxEditor', { preview: false });
        return { reopened: true, sections: file.state.sections.length };
      })()
      """
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    And I evaluate "(() => { const sections = [...document.querySelectorAll('#queries-container > kw-query-section')]; if (sections.length !== 4 || sections[0].serialize?.().query !== 'print Probe=42') throw new Error('The reopened notebook did not restore four query sections'); return { restored: true, sections: sections.length }; })()" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "large-notebook-after-reopen"
    Then I collect JSON artifact "synthetic-fixture-removed" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__largeSaveTailProbe;
        if (!probe?.root?.path.split('/').pop()?.startsWith('kw-large-save-tail-')
          || probe.uri.path !== probe.root.path + '/synthetic.kqlx') throw new Error('Refusing to remove an unowned fixture');
        const entries = await vscode.workspace.fs.readDirectory(probe.root);
        if (entries.length !== 1 || entries[0][0] !== 'synthetic.kqlx') throw new Error('Unexpected fixture directory contents');
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === probe.uri.toString());
        if (tabs.length !== 1 || vscode.workspace.textDocuments.find(document => document.uri.toString() === probe.uri.toString())?.isDirty) throw new Error('Refusing to close a dirty or ambiguous fixture tab');
        if (!await vscode.window.tabGroups.close(tabs[0])) throw new Error('Could not close the fixture tab');
        await vscode.workspace.fs.delete(probe.uri, { useTrash: false });
        await vscode.workspace.fs.delete(probe.root, { useTrash: false });
        delete globalThis.__largeSaveTailProbe;
        return { fixtureRemoved: true, unrelatedTabsClosed: false };
      })()
      """