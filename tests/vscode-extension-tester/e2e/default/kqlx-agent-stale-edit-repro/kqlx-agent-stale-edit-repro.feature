Feature: Diagnose a stale generic edit after a Workbench agent tool changes KQLX

  Scenario: A stale full-file edit duplicates the new document ending three times
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "stale-edit-created" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kw-stale-agent-edit-' + process.pid + '-' + Date.now());
        const uri = vscode.Uri.joinPath(root, 'synthetic.kqlx');
        const largeRows = Array.from({ length: 2578 }, (_, index) => [{ display: String(index), full: 'V'.repeat(2120) }]);
        const smallRows = Array.from({ length: 6 }, (_, index) => [{ display: String(index), full: 'S'.repeat(100) }]);
        const sections = Array.from({ length: 4 }, (_, index) => ({
          id: 'query_' + (index + 1), type: 'query', name: 'Synthetic ' + (index + 1),
          expanded: index === 0, resultsVisible: true, query: 'print Probe=' + (index + 1),
          resultJson: JSON.stringify({ columns: [{ name: 'Payload', type: 'string' }], rows: index === 0 ? largeRows : smallRows }),
        }));
        const crlf = String.fromCharCode(13, 10);
        const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2)
          .split(String.fromCharCode(10)).join(crlf) + crlf;
        await vscode.workspace.fs.createDirectory(root);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        globalThis.__staleAgentEditRepro = { root, uri };
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { initialBytes: new TextEncoder().encode(text).length, sections: 4, firstResultRows: largeRows.length };
      })()
      """
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    Then I collect JSON artifact "stale-edit-observed" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__staleAgentEditRepro;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        if (!document || document.isDirty) throw new Error('Synthetic notebook did not open clean');
        const original = document.getText();
        const staleRange = new vscode.Range(document.positionAt(0), document.positionAt(original.length));
        const edits = [];
        const observer = vscode.workspace.onDidChangeTextDocument(event => {
          if (event.document.uri.toString() !== probe.uri.toString() || !event.contentChanges.length) return;
          let valid = true;
          try { JSON.parse(event.document.getText()); } catch { valid = false; }
          edits.push({ valid, changedRanges: event.contentChanges.map(change => ({
            offset: change.rangeOffset, removedLength: change.rangeLength, insertedLength: change.text.length,
          })) });
        });
        const invoke = async (name, input) => {
          const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
          const value = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
          if (!value || value.startsWith('Error:')) throw new Error('The registered Workbench tool was unavailable');
          return JSON.parse(value);
        };
        try {
          let openFileId;
          const deadline = Date.now() + 30000;
          while (!openFileId && Date.now() < deadline) {
            const listed = await invoke('kusto-workbench_list-sections', {});
            const file = (listed.openFiles || []).find(entry => String(entry.filePath || '').toLowerCase() === probe.uri.fsPath.toLowerCase());
            if (file?.isLiveWorkbench && file.sectionsUnavailable !== true && file.sections?.length === 4) openFileId = file.openFileId;
            else await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!openFileId) throw new Error('Synthetic notebook was not available to Workbench tools');
          const added = await invoke('kusto-workbench_add-section', {
            openFileId, type: 'markdown', name: 'Synthetic note', text: 'X'.repeat(65154),
          });
          if (added.success !== true) throw new Error('Workbench section mutation was rejected');
          const afterTool = document.getText();
          const crlf = String.fromCharCode(13, 10);
          if (!afterTool.endsWith(crlf) || JSON.parse(afterTool).state.sections.length !== 5
            || document.positionAt(afterTool.length).line <= staleRange.end.line) {
            throw new Error('Workbench tool did not extend the serialized notebook');
          }
          const rootText = afterTool.slice(0, -2);
          const block = afterTool.slice(document.offsetAt(staleRange.end), -2);
          if (Buffer.byteLength(block) !== 65311 || !rootText.endsWith(block)) {
            throw new Error('Stale replacement would not leave the expected 65,311-byte suffix');
          }
          const rounds = [];
          for (let copyCount = 1; copyCount <= 3; copyCount++) {
            const genericEdit = new vscode.WorkspaceEdit();
            genericEdit.replace(probe.uri, staleRange, rootText);
            if (!await vscode.workspace.applyEdit(genericEdit)) throw new Error('VS Code rejected the stale generic edit');
            const expected = rootText + block.repeat(copyCount) + crlf;
            const actual = document.getText();
            let fullValid = true;
            try { JSON.parse(actual); } catch { fullValid = false; }
            if (actual !== expected || fullValid) throw new Error('Stale edit did not reproduce the exact repeated-tail corruption');
            rounds.push({ copyCount, blockBytes: Buffer.byteLength(block), bufferBytes: Buffer.byteLength(actual),
              prefixValid: true, wholeBufferValid: false, exactRepeatedSuffix: true });
          }
          if (!await document.save()) throw new Error('VS Code refused the intentionally malformed synthetic Save');
          const diskText = new TextDecoder().decode(await vscode.workspace.fs.readFile(probe.uri));
          if (document.isDirty || diskText !== document.getText()
            || diskText !== rootText + block.repeat(3) + crlf) throw new Error('Synthetic corruption was not saved exactly');
          const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(item => item.input?.uri?.toString() === probe.uri.toString());
          if (tab.length !== 1 || !await vscode.window.tabGroups.close(tab[0])) throw new Error('Could not close the exact clean synthetic tab');
          await vscode.commands.executeCommand('vscode.openWith', probe.uri, 'kusto.kqlxEditor', { preview: false });
          return { staleEndLine: staleRange.end.line, newEndLine: document.positionAt(afterTool.length).line,
            rounds, editEvents: edits, diskBytes: Buffer.byteLength(diskText), saveClean: true, reopened: true };
        } finally {
          observer.dispose();
        }
      })()
      """
    Then the webview should contain "Invalid Kusto Workbench file"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "stale-edit-corrupt-file"
    Then I collect JSON artifact "stale-edit-fixture-removed" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__staleAgentEditRepro;
        const fs = process.getBuiltinModule('node:fs');
        if (!probe?.root?.path.split('/').pop()?.startsWith('kw-stale-agent-edit-')
          || probe.uri.path !== probe.root.path + '/synthetic.kqlx'
          || fs.lstatSync(probe.root.fsPath).isSymbolicLink()
          || fs.readdirSync(probe.root.fsPath).join(',') !== 'synthetic.kqlx') {
          throw new Error('Refusing ambiguous synthetic fixture cleanup');
        }
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === probe.uri.toString());
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        if (tabs.length !== 1 || document?.isDirty || !await vscode.window.tabGroups.close(tabs[0])) {
          throw new Error('Could not close the exact clean synthetic tab');
        }
        await vscode.workspace.fs.delete(probe.uri, { useTrash: false });
        await vscode.workspace.fs.delete(probe.root, { useTrash: false });
        delete globalThis.__staleAgentEditRepro;
        return { fixtureRemoved: true, unrelatedTabsClosed: false };
      })()
      """