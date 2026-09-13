Feature: Agent closes exact Workbench editors safely

  Scenario: Close a background file and explicitly save a dirty active file
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    Then I collect JSON artifact "close-targeting" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-agent-close-file-targeting');
        try { await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); } catch {}
        await vscode.workspace.fs.createDirectory(root);
        const backgroundUri = vscode.Uri.joinPath(root, 'background.kqlx');
        const activeUri = vscode.Uri.joinPath(root, 'active.kqlx');
        const createFile = (id, query) => JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id, type: 'query', expanded: true, query }] } }, null, 2);
        await vscode.workspace.fs.writeFile(backgroundUri, new TextEncoder().encode(createFile('background_query', 'print Background=1')));
        await vscode.workspace.fs.writeFile(activeUri, new TextEncoder().encode(createFile('active_query', 'print ActiveBefore=1')));
        await vscode.commands.executeCommand('vscode.openWith', backgroundUri, 'kusto.kqlxEditor', { preview: false });
        await vscode.commands.executeCommand('vscode.openWith', activeUri, 'kusto.kqlxEditor', { preview: false });
        const invoke = async (name, input) => {
          const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
          const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
          if (!text || text.startsWith('Error:')) throw new Error(`${name} failed: ${text}`);
          return JSON.parse(text);
        };
        const waitForFile = async uri => {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            const listed = await invoke('kusto-workbench_list-sections', {});
            const file = (listed.openFiles || []).find(candidate => String(candidate.filePath || '').toLowerCase() === uri.fsPath.toLowerCase());
            if (file?.isLiveWorkbench && file.sectionsUnavailable !== true && file.sections?.length) return file;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(`Workbench file did not become ready: ${uri.fsPath}`);
        };
        const background = await waitForFile(backgroundUri);
        const active = await waitForFile(activeUri);
        const backgroundClose = await invoke('kusto-workbench_close-workbench-file', { openFileId: background.openFileId });
        if (backgroundClose.success !== true || backgroundClose.closedTabCount !== 1) throw new Error(`Background close failed: ${JSON.stringify(backgroundClose)}`);
        const openUrisAfterBackgroundClose = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => tab.input?.uri?.toString()).filter(Boolean));
        if (openUrisAfterBackgroundClose.includes(backgroundUri.toString()) || !openUrisAfterBackgroundClose.includes(activeUri.toString())) throw new Error(`Exact close targeting failed: ${JSON.stringify(openUrisAfterBackgroundClose)}`);
        const configured = await invoke('kusto-workbench_configure-query-section', { openFileId: active.openFileId, sectionId: 'active_query', query: 'print ActiveAfter=2', execute: false });
        if (configured.success !== true) throw new Error(`Active query configuration failed: ${JSON.stringify(configured)}`);
        const dirtyRefusal = await invoke('kusto-workbench_close-workbench-file', { openFileId: active.openFileId });
        if (dirtyRefusal.success !== false || dirtyRefusal.closed !== false || dirtyRefusal.wasDirty !== true || !String(dirtyRefusal.error || '').includes('saveChanges')) throw new Error(`Dirty close was not refused safely: ${JSON.stringify(dirtyRefusal)}`);
        const activeStillOpen = vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.uri?.toString() === activeUri.toString());
        if (!activeStillOpen) throw new Error('Dirty refusal closed the active file');
        globalThis.__agentCloseFileTargeting = { root, activeUri, activeOpenFileId: active.openFileId };
        return { backgroundClose, dirtyRefusal, activeStillOpen };
      })()
      """
    When I wait for "#active_query" in the webview for 30 seconds
    Then I collect JSON artifact "dirty-active-editor" from webview expression "(() => { const query = window.queryEditors?.active_query?.getValue?.() || ''; if (query !== 'print ActiveAfter=2') throw new Error('Dirty active query differs: ' + query); return { query }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "dirty-close-refused"
    Then I collect JSON artifact "saved-close" from extension host expression:
      """
      (async () => {
        const context = globalThis.__agentCloseFileTargeting;
        if (!context?.activeUri || !context.activeOpenFileId) throw new Error('Close targeting context was unavailable');
        const result = await vscode.lm.invokeTool('kusto-workbench_close-workbench-file', { toolInvocationToken: undefined, input: { openFileId: context.activeOpenFileId, saveChanges: true } });
        const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
        if (!text || text.startsWith('Error:')) throw new Error(`Saved close failed: ${text}`);
        const closeResult = JSON.parse(text);
        if (closeResult.success !== true || closeResult.closed !== true || closeResult.saved !== true || closeResult.wasDirty !== true) throw new Error(`Saved close result differed: ${text}`);
        const targetStillOpen = vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.uri?.toString() === context.activeUri.toString());
        if (targetStillOpen) throw new Error('Saved target remained open');
        const file = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(context.activeUri)));
        const query = file.state.sections.find(section => section?.id === 'active_query')?.query || '';
        if (query !== 'print ActiveAfter=2') throw new Error(`Saved target query differed: ${query}`);
        await vscode.workspace.fs.delete(context.root, { recursive: true, useTrash: false });
        return { closeResult, targetStillOpen, query, deleted: true };
      })()
      """
