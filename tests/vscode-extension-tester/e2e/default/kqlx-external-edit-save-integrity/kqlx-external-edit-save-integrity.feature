Feature: External text edits to large KQLX files stay valid when saved

  Scenario: Local and whole-file edits do not append a notebook suffix
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "external-edit-created" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kw-external-edit-save-' + process.pid + '-' + Date.now());
        const uri = vscode.Uri.joinPath(root, 'synthetic.kqlx');
        const largeRows = Array.from({ length: 2578 }, (_, index) => [{ display: String(index), full: 'V'.repeat(2120) }]);
        const smallRows = Array.from({ length: 6 }, (_, index) => [{ display: String(index), full: 'S'.repeat(100) }]);
        const sections = Array.from({ length: 4 }, (_, index) => ({
          id: 'query_' + (index + 1), type: 'query', name: 'Synthetic ' + (index + 1),
          expanded: index === 0, resultsVisible: true, query: 'print Probe=' + (index + 1),
          resultJson: JSON.stringify({ columns: [{ name: 'Payload', type: 'string' }], rows: index === 0 ? largeRows : smallRows }),
        }));
        const crlf = String.fromCharCode(13, 10);
        const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2).replace(/\n/g, crlf) + crlf;
        await vscode.workspace.fs.createDirectory(root);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        globalThis.__externalEditIntegrity = { root, uri };
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { initialBytes: new TextEncoder().encode(text).length, sections: 4, firstResultRows: largeRows.length };
      })()
      """
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    Then I collect JSON artifact "external-edit-save-rounds" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__externalEditIntegrity;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        if (!document) throw new Error('Synthetic notebook backing document is missing');
        const crypto = process.getBuiltinModule('node:crypto');
        const inspect = text => {
          let parsed;
          try { parsed = JSON.parse(text); } catch { return { valid: false, length: text.length }; }
          return { valid: true, length: text.length,
            hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
            sections: parsed.state.sections.length,
            results: parsed.state.sections.filter(section => typeof section.resultJson === 'string').length,
          };
        };
        const changes = [];
        const saves = [];
        const observers = [
          vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() !== probe.uri.toString() || !event.contentChanges.length) return;
            changes.push({ edits: event.contentChanges.map(change => ({
              rangeOffset: change.rangeOffset, rangeLength: change.rangeLength, insertedLength: change.text.length,
            })), buffer: inspect(event.document.getText()) });
          }),
          vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document.uri.toString() === probe.uri.toString()) saves.push({ phase: 'will', buffer: inspect(event.document.getText()) });
          }),
          vscode.workspace.onDidSaveTextDocument(saved => {
            if (saved.uri.toString() === probe.uri.toString()) saves.push({ phase: 'did', buffer: inspect(saved.getText()) });
          }),
        ];
        const crlf = String.fromCharCode(13, 10);
        const rounds = [];
        let previousQuery = 'print Probe=1';
        const applyAndSave = async (label, edit, nextQuery) => {
          if (!await vscode.workspace.applyEdit(edit)) throw new Error(label + ' edit was rejected by VS Code');
          const bufferText = document.getText();
          const buffer = inspect(bufferText);
          if (!buffer.valid || buffer.sections !== 4 || buffer.results !== 4 || document.eol !== vscode.EndOfLine.CRLF) {
            throw new Error(label + ' changed the backing buffer into an invalid notebook');
          }
          const file = JSON.parse(bufferText);
          if (file.state.sections[0].query !== nextQuery) throw new Error(label + ' failed to change the first query');
          if (!await document.save()) throw new Error(label + ' Save was declined');
          const bytes = await vscode.workspace.fs.readFile(probe.uri);
          const diskText = new TextDecoder().decode(bytes);
          const disk = inspect(diskText);
          if (!disk.valid || disk.sections !== 4 || disk.results !== 4 || diskText !== document.getText() || document.isDirty) {
            throw new Error(label + ' left extra bytes on disk or lost saved results');
          }
          rounds.push({ label, bufferLength: buffer.length, diskBytes: bytes.byteLength,
            diskHash: disk.hash, validJson: true, savedResults: disk.results });
          previousQuery = nextQuery;
        };
        const replaceQueryValue = async (label, query) => {
          const before = document.getText();
          const needle = '"query": ' + JSON.stringify(previousQuery);
          const start = before.indexOf(needle);
          if (start < 0 || before.indexOf(needle, start + 1) >= 0) throw new Error(label + ' could not find a unique query property');
          const valueStart = start + '"query": '.length;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(probe.uri, new vscode.Range(
            document.positionAt(valueStart), document.positionAt(valueStart + JSON.stringify(previousQuery).length),
          ), JSON.stringify(query));
          await applyAndSave(label, edit, query);
        };
        try {
          await replaceQueryValue('localized-expand', 'print Probe=42' + String.fromCharCode(10) + '//' + 'Z'.repeat(70000));
          await replaceQueryValue('localized-shrink', 'print Probe=43');
          const before = document.getText();
          const file = JSON.parse(before);
          const nextQuery = 'print Probe=44' + String.fromCharCode(10) + '//' + 'W'.repeat(65311);
          file.state.sections[0].query = nextQuery;
          const candidate = JSON.stringify(file, null, 2).replace(/\n/g, crlf) + crlf;
          const replace = new vscode.WorkspaceEdit();
          replace.replace(probe.uri, new vscode.Range(document.positionAt(0), document.positionAt(before.length)), candidate);
          await applyAndSave('whole-document-expand', replace, nextQuery);
          await replaceQueryValue('localized-shrink-again', 'print Probe=45');
          const end = document.getText();
          if (!end.endsWith('}' + crlf)) throw new Error('Document no longer has canonical final CRLF');
          const insert = new vscode.WorkspaceEdit();
          insert.insert(probe.uri, document.positionAt(end.length - crlf.length), ' '.repeat(65311));
          await applyAndSave('before-final-newline', insert, previousQuery);
        } finally {
          for (const observer of observers) observer.dispose();
        }
        if (changes.length < rounds.length || saves.length < rounds.length) {
          throw new Error('Expected content-free document-change and Save observations for every edit');
        }
        return { rounds, changes, saves, finalValid: true };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "external-edit-save-final"
    Then I collect JSON artifact "external-edit-fixture-removed" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__externalEditIntegrity;
        if (!probe?.root?.path.split('/').pop()?.startsWith('kw-external-edit-save-')
          || probe.uri.path !== probe.root.path + '/synthetic.kqlx') throw new Error('Refusing to remove an unowned fixture');
        const entries = await vscode.workspace.fs.readDirectory(probe.root);
        if (entries.length !== 1 || entries[0][0] !== 'synthetic.kqlx') throw new Error('Unexpected fixture directory contents');
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === probe.uri.toString());
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        if (tabs.length !== 1 || document?.isDirty || !await vscode.window.tabGroups.close(tabs[0])) {
          throw new Error('Could not close the exact clean fixture tab');
        }
        await vscode.workspace.fs.delete(probe.uri, { useTrash: false });
        await vscode.workspace.fs.delete(probe.root, { useTrash: false });
        delete globalThis.__externalEditIntegrity;
        return { fixtureRemoved: true, unrelatedTabsClosed: false };
      })()
      """