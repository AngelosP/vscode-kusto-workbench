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
        const targetless = await invoke('kusto-workbench_close-workbench-file', {});
        if (targetless.success !== false || targetless.closed !== false || !String(targetless.error || '').includes('openFileId or targetFileUri')) throw new Error(`Targetless close was not refused: ${JSON.stringify(targetless)}`);
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
        return { targetless, backgroundClose, dirtyRefusal, activeStillOpen };
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

  Scenario: Metadata-only KQL and SQL changes require an explicit durable save
    Given the extension is in a clean state
    Then I collect JSON artifact "compatibility-close" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-agent-close-compatibility');
        try { await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); } catch {}
        await vscode.workspace.fs.createDirectory(root);
        const cases = [
          { kind: 'kql', uri: vscode.Uri.joinPath(root, 'metadata-only.kql'), viewType: 'kusto.kqlCompatEditor', source: 'print Source=1' },
          { kind: 'sql', uri: vscode.Uri.joinPath(root, 'metadata-only.sql'), viewType: 'kusto.sqlCompatEditor', source: 'SELECT 1 AS Source;' },
        ];
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
            if (file?.isLiveWorkbench) return file;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(`Compatibility file did not become ready: ${uri.fsPath}`);
        };
        const results = [];
        for (const item of cases) {
          await vscode.workspace.fs.writeFile(item.uri, new TextEncoder().encode(item.source));
          const sidecarUri = vscode.Uri.file(item.uri.fsPath + '.json');
          const primaryId = item.kind === 'kql' ? 'compat_primary_query' : 'compat_primary_sql';
          const sidecarSeed = {
            kind: item.kind === 'kql' ? 'kqlx' : 'sqlx',
            version: 1,
            state: { sections: [{ id: primaryId, type: item.kind === 'kql' ? 'query' : 'sql', linkedQueryPath: item.uri.path.split('/').pop(), expanded: true }] },
          };
          await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(JSON.stringify(sidecarSeed, null, 2)));
          await vscode.commands.executeCommand('vscode.openWith', item.uri, item.viewType, { preview: false });
          const file = await waitForFile(item.uri);
          const sectionId = primaryId;
          const collapsed = await invoke('kusto-workbench_collapse-section', { openFileId: file.openFileId, sectionId, collapsed: true });
          if (collapsed.success !== true) throw new Error(`${item.kind} metadata mutation failed: ${JSON.stringify(collapsed)}`);
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === item.uri.toString());
          if (!document || document.isDirty) throw new Error(`${item.kind} primary document was unexpectedly dirty before close: ${document?.isDirty}`);
          const refused = await invoke('kusto-workbench_close-workbench-file', { openFileId: file.openFileId });
          if (refused.success !== false || refused.closed !== false || refused.wasDirty !== true) throw new Error(`${item.kind} metadata-only close was not refused: ${JSON.stringify(refused)}`);
          const stillOpen = vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.uri?.toString() === item.uri.toString());
          if (!stillOpen) throw new Error(`${item.kind} metadata-only refusal closed the tab`);
          const closed = await invoke('kusto-workbench_close-workbench-file', { openFileId: file.openFileId, saveChanges: true });
          if (closed.success !== true || closed.closed !== true || closed.saved !== true || closed.wasDirty !== true) throw new Error(`${item.kind} saved close failed: ${JSON.stringify(closed)}`);
          const sidecarText = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri));
          const sidecar = JSON.parse(sidecarText);
          const persistedSection = sidecar.state?.sections?.find(section => section?.id === sectionId);
          if (persistedSection?.expanded !== false) throw new Error(`${item.kind} companion metadata was not durable: ${sidecarText}`);
          const sourceText = new TextDecoder().decode(await vscode.workspace.fs.readFile(item.uri));
          if (sourceText !== item.source) throw new Error(`${item.kind} source bytes changed: ${sourceText}`);
          results.push({ kind: item.kind, primaryCleanBeforeClose: true, refused, closed, collapsed: persistedSection.expanded === false, sourceText });
        }
        globalThis.__agentCloseCompatibilityRoot = root;
        return { results };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "compatibility-close-complete"
    Then I collect JSON artifact "compatibility-close-cleanup" from extension host expression "(async () => { const root = globalThis.__agentCloseCompatibilityRoot; if (!root) throw new Error('Compatibility close root was unavailable'); const openTargets = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => String(tab.input?.uri?.fsPath || '').startsWith(root.fsPath)); if (openTargets.length) throw new Error('Compatibility target tabs remained open: ' + JSON.stringify(openTargets.map(tab => tab.label))); await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); return { openTargets: 0, deleted: true }; })()"

  Scenario: A dirty companion text editor blocks tool-driven save and close
    Given the extension is in a clean state
    Then I collect JSON artifact "competing-companion-buffer" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-agent-close-competing-buffer');
        try { await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); } catch {}
        await vscode.workspace.fs.createDirectory(root);
        const sourceUri = vscode.Uri.joinPath(root, 'competing.kql');
        const sidecarUri = vscode.Uri.file(sourceUri.fsPath + '.json');
        const sidecarAliasUri = vscode.Uri.joinPath(root, 'competing-alias.json');
        const sourceText = 'print Source=1';
        const sidecarSeed = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id: 'compat_primary_query', type: 'query', linkedQueryPath: 'competing.kql', expanded: true }] } }, null, 2);
        await vscode.workspace.fs.writeFile(sourceUri, new TextEncoder().encode(sourceText));
        await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(sidecarSeed));
        const nodeFs = process.getBuiltinModule('node:fs');
        nodeFs.linkSync(sidecarUri.fsPath, sidecarAliasUri.fsPath);
        await vscode.commands.executeCommand('vscode.openWith', sourceUri, 'kusto.kqlCompatEditor', { preview: false });
        const invoke = async (name, input) => {
          const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
          const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
          if (!text || text.startsWith('Error:')) throw new Error(`${name} failed: ${text}`);
          return JSON.parse(text);
        };
        let file;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const listed = await invoke('kusto-workbench_list-sections', {});
          file = (listed.openFiles || []).find(candidate => String(candidate.filePath || '').toLowerCase() === sourceUri.fsPath.toLowerCase());
          if (file?.isLiveWorkbench && file.sectionsUnavailable !== true) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!file?.isLiveWorkbench || file.sectionsUnavailable === true) throw new Error('Competing-buffer Workbench file did not become ready');
        const collapsed = await invoke('kusto-workbench_collapse-section', { openFileId: file.openFileId, sectionId: 'compat_primary_query', collapsed: true });
        if (collapsed.success !== true) throw new Error(`Metadata mutation failed: ${JSON.stringify(collapsed)}`);
        const durableBeforeRefusal = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri));
        const sidecarDocument = await vscode.workspace.openTextDocument(sidecarAliasUri);
        await vscode.window.showTextDocument(sidecarDocument, { preview: false });
        const manualText = durableBeforeRefusal.replace('"version": 1,', '"version": 1,\n  "manualMarker": true,');
        const dirtyEdit = new vscode.WorkspaceEdit();
        dirtyEdit.replace(sidecarAliasUri, new vscode.Range(sidecarDocument.positionAt(0), sidecarDocument.positionAt(sidecarDocument.getText().length)), manualText);
        if (!await vscode.workspace.applyEdit(dirtyEdit) || !sidecarDocument.isDirty) throw new Error('Companion text editor did not become dirty');
        const refused = await invoke('kusto-workbench_close-workbench-file', { openFileId: file.openFileId, saveChanges: true });
        if (refused.success !== false || refused.closed !== false || refused.wasDirty !== true || !String(refused.error || '').includes('companion metadata editor')) throw new Error(`Competing buffer was not refused: ${JSON.stringify(refused)}`);
        const tabsAfterRefusal = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => [sourceUri.toString(), sidecarAliasUri.toString()].includes(tab.input?.uri?.toString()));
        if (tabsAfterRefusal.length !== 2) throw new Error(`Competing-buffer refusal changed target tabs: ${JSON.stringify(tabsAfterRefusal.map(tab => tab.label))}`);
        const diskAfterRefusal = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri));
        if (diskAfterRefusal !== durableBeforeRefusal) throw new Error(`Competing-buffer refusal changed durable metadata: ${diskAfterRefusal}`);
        const restoreEdit = new vscode.WorkspaceEdit();
        restoreEdit.replace(sidecarAliasUri, new vscode.Range(sidecarDocument.positionAt(0), sidecarDocument.positionAt(sidecarDocument.getText().length)), durableBeforeRefusal);
        if (!await vscode.workspace.applyEdit(restoreEdit) || !await sidecarDocument.save()) throw new Error('Could not resolve the companion text buffer');
        const configured = await invoke('kusto-workbench_configure-query-section', { openFileId: file.openFileId, sectionId: 'compat_primary_query', query: 'print Source=2', execute: false });
        if (configured.success !== true) throw new Error(`Source mutation failed: ${JSON.stringify(configured)}`);
        const sourceDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === sourceUri.toString());
        if (!sourceDocument?.isDirty) throw new Error('Source document did not become dirty for the save-time race');
        const sourceDiskBeforeRace = new TextDecoder().decode(await vscode.workspace.fs.readFile(sourceUri));
        const sidecarDiskBeforeRace = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri));
        const raced = await invoke('kusto-workbench_close-workbench-file', { openFileId: file.openFileId, saveChanges: true });
        if (raced.success !== false || raced.closed !== false || !String(raced.error || '').includes('open separately')) throw new Error(`Open physical alias was not refused before source Save: ${JSON.stringify(raced)}`);
        if (sidecarDocument.isDirty || !sourceDocument.isDirty) throw new Error(`Open-alias refusal did not preserve buffer states: ${JSON.stringify({ sidecarDirty: sidecarDocument.isDirty, sourceDirty: sourceDocument.isDirty })}`);
        const sourceDiskAfterRace = new TextDecoder().decode(await vscode.workspace.fs.readFile(sourceUri));
        const sidecarDiskAfterRace = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri));
        if (sourceDiskAfterRace !== sourceDiskBeforeRace || sidecarDiskAfterRace !== sidecarDiskBeforeRace) throw new Error(`Open-alias refusal changed durable bytes: ${JSON.stringify({ sourceDiskBeforeRace, sourceDiskAfterRace, sidecarChanged: sidecarDiskAfterRace !== sidecarDiskBeforeRace })}`);
        const aliasTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === sidecarAliasUri.toString());
        if (!aliasTabs.length || !await vscode.window.tabGroups.close(aliasTabs, true)) throw new Error('Could not close the resolved companion alias tab');
        const closed = await invoke('kusto-workbench_close-workbench-file', { openFileId: file.openFileId, saveChanges: true });
        if (closed.success !== true || closed.closed !== true || closed.saved !== true) throw new Error(`Resolved competing buffer did not close: ${JSON.stringify(closed)}`);
        const durableSidecar = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri)));
        const persistedSection = durableSidecar.state?.sections?.find(section => section?.id === 'compat_primary_query');
        if (persistedSection?.expanded !== false) throw new Error(`Workbench metadata was not durable after resolution: ${JSON.stringify(durableSidecar)}`);
        const durableSource = new TextDecoder().decode(await vscode.workspace.fs.readFile(sourceUri));
        if (durableSource !== 'print Source=2') throw new Error(`Source mutation was not durable after resolution: ${durableSource}`);
        const openTargets = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => [sourceUri.toString(), sidecarAliasUri.toString()].includes(tab.input?.uri?.toString()));
        if (openTargets.length) throw new Error(`Resolved target tabs remained open: ${JSON.stringify(openTargets.map(tab => tab.label))}`);
        await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false });
        return { physicalAlias: true, refused, diskUnchangedBeforeResolution: true, openAliasBlockedBeforeSourceSave: true, raced, raceDiskUnchanged: true, closed, persistedCollapsed: true, durableSource, openTargets: 0, deleted: true };
      })()
      """
