Feature: Agent query tool does not duplicate notebook content on Save

  Scenario: Repeated tool edits and Saves of a large results notebook retain exact JSON
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "agent-tool-large-created" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kw-agent-tool-save-' + process.pid + '-' + Date.now());
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
        globalThis.__agentToolIntegrity = { root, uri, initialBytes: new TextEncoder().encode(text).length };
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { initialBytes: globalThis.__agentToolIntegrity.initialBytes, sections: 4, firstResultRows: largeRows.length };
      })()
      """
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    Then I collect JSON artifact "agent-tool-save-rounds" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__agentToolIntegrity;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.uri.toString());
        if (!document) throw new Error('Synthetic notebook backing document is missing');
        const crypto = process.getBuiltinModule('node:crypto');
        const inspect = text => {
          let parsed;
          try { parsed = JSON.parse(text); } catch { return { valid: false, length: text.length }; }
          return {
            valid: true, length: text.length,
            hash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16),
            sections: parsed.state.sections.length,
            results: parsed.state.sections.filter(section => typeof section.resultJson === 'string').length,
          };
        };
        const changes = [];
        const saves = [];
        const observed = [
          vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.toString() !== probe.uri.toString() || !event.contentChanges.length) return;
            changes.push({
              changes: event.contentChanges.map(change => ({
                rangeOffset: change.rangeOffset, rangeLength: change.rangeLength, insertedLength: change.text.length,
              })),
              buffer: inspect(event.document.getText()),
            });
          }),
          vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document.uri.toString() === probe.uri.toString()) saves.push({ phase: 'will', buffer: inspect(event.document.getText()) });
          }),
          vscode.workspace.onDidSaveTextDocument(saved => {
            if (saved.uri.toString() === probe.uri.toString()) saves.push({ phase: 'did', buffer: inspect(saved.getText()) });
          }),
        ];
        const invoke = async (name, input) => {
          const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
          const value = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
          if (!value || value.startsWith('Error:')) throw new Error(name + ' was rejected');
          return JSON.parse(value);
        };
        const rounds = [];
        try {
          let openFileId;
          const deadline = Date.now() + 30000;
          while (!openFileId && Date.now() < deadline) {
            const listed = await invoke('kusto-workbench_list-sections', {});
            const file = (listed.openFiles || []).find(entry => String(entry.filePath || '').toLowerCase() === probe.uri.fsPath.toLowerCase());
            if (file?.isLiveWorkbench && file.sectionsUnavailable !== true && file.sections?.length === 4) openFileId = file.openFileId;
            else await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!openFileId) throw new Error('Agent tool inventory did not recognize the open synthetic notebook');
          const queries = [
            'print Probe=42' + String.fromCharCode(10) + '//' + 'Z'.repeat(70000),
            'print Probe=43',
            'print Probe=44' + String.fromCharCode(10) + '//' + 'W'.repeat(65311),
            'print Probe=45',
          ];
          for (let iteration = 0; iteration < queries.length; iteration++) {
            const query = queries[iteration];
            const response = await invoke('kusto-workbench_configure-query-section', {
              openFileId, sectionId: 'query_1', query, execute: false,
            });
            if (response.success !== true) throw new Error('Workbench tool rejected query edit in round ' + iteration);
            const buffer = inspect(document.getText());
            if (!buffer.valid || buffer.sections !== 4 || !JSON.parse(document.getText()).state.sections[0].query.endsWith(query)) {
              throw new Error('Workbench tool left the backing buffer invalid or stale in round ' + iteration);
            }
            if (!await document.save()) throw new Error('Native Save declined the tool edit in round ' + iteration);
            const bytes = await vscode.workspace.fs.readFile(probe.uri);
            const disk = inspect(new TextDecoder().decode(bytes));
            if (!disk.valid || disk.sections !== 4 || disk.results !== 4 || document.isDirty
              || new TextDecoder().decode(bytes) !== document.getText()) {
              throw new Error('Tool edit and native Save did not preserve exact notebook bytes in round ' + iteration);
            }
            rounds.push({ iteration, queryLength: query.length, bufferLength: buffer.length,
              diskBytes: bytes.byteLength, diskHash: disk.hash, results: disk.results, dirty: document.isDirty });
          }
        } finally {
          for (const observer of observed) observer.dispose();
        }
        if (!changes.length || !saves.length) throw new Error('No backing-document changes or saves were observed');
        return { rounds, changes, saves, finalValid: true };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "agent-tool-save-final"
    Then I collect JSON artifact "agent-tool-fixture-removed" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__agentToolIntegrity;
        if (!probe?.root?.path.split('/').pop()?.startsWith('kw-agent-tool-save-')
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
        delete globalThis.__agentToolIntegrity;
        return { fixtureRemoved: true, unrelatedTabsClosed: false };
      })()
      """