Feature: A programmatically selected background report accepts a real user edit

  Scenario: Typing in a reveal-false report hands Save to the live editor
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    Then I collect JSON artifact "background-created" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const root = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'kw-background-user-save-'));
        const uri = vscode.Uri.file(path.join(root, 'report.kqlx'));
        globalThis.__backgroundUserSave = { root, uri };
        const invoke = async (name, input) => {
          const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
          const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
          if (!text || text.startsWith('Error:')) throw new Error(`${name}: ${text}`);
          return JSON.parse(text);
        };
        const created = await invoke('kusto-workbench_create-file', {
          fileType: 'kqlx', filePath: path.join(root, 'report'), initialContent: 'print Before=1', reveal: false
        });
        if (!created.success || created.filePath.toLowerCase() !== uri.fsPath.toLowerCase()) throw new Error(`Create failed: ${JSON.stringify(created)}`);
        const deadline = Date.now() + 30000;
        let report;
        while (Date.now() < deadline) {
          const listed = await invoke('kusto-workbench_list-sections', {});
          report = (listed.openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uri.fsPath.toLowerCase());
          if (report?.sections?.some(section => section.type === 'query')) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!report) throw new Error('The new report did not appear in the file inventory.');
        const added = await invoke('kusto-workbench_add-section', {
          openFileId: report.openFileId, type: 'markdown', name: 'Summary', text: '# Preserved'
        });
        if (!added.success) throw new Error(`Background Markdown Add failed without retry: ${JSON.stringify(added)}`);
        const saved = await invoke('kusto-workbench_save-workbench-file', { openFileId: report.openFileId });
        if (!saved.success || !saved.saved) throw new Error(`Background Save failed: ${JSON.stringify(saved)}`);
        const onDisk = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
        if (!onDisk.state.sections.some(section => section.id === added.sectionId && section.title === 'Summary' && section.text === '# Preserved')) throw new Error('Background Save lost Markdown.');
        const before = await invoke('kusto-workbench_list-sections', {});
        const owned = (before.openFiles || []).find(file => file.openFileId === report.openFileId);
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const modulePath = path.join(extension.extensionUri.fsPath, extension.packageJSON.main);
        const orchestrator = process.getBuiltinModule('node:module').createRequire(modulePath)(modulePath).toolOrchestrator;
        if (!owned || !orchestrator?.isHostOwnedBackgroundFile(uri)) throw new Error(`The report was incorrectly handed off before input: ${JSON.stringify(owned)}`);
        const active = vscode.window.tabGroups.activeTabGroup?.activeTab?.input?.uri?.toString();
        if (active !== uri.toString()) throw new Error(`Programmatic open did not select the report: ${active}`);
        return { path: uri.fsPath, active, backgroundOwned: true, webviewConnected: !!owned.isLiveWorkbench, markdownId: added.sectionId, query: onDisk.state.sections[0].query };
      })()
      """
    When I wait for "body[data-kusto-e2e-ready='true'] kw-query-section .monaco-editor" in the webview for 30 seconds
    When I evaluate "__testFocusMonaco('kw-query-section .monaco-editor')" in the webview
    When I press "Ctrl+A"
    When I type "print UserTyped=77"
    Then I collect JSON artifact "user-typed-live" from webview expression "(() => { const id = document.querySelector('kw-query-section')?.id; const query = window.queryEditors?.[id]?.getValue?.(); if (query !== 'print UserTyped=77') throw new Error('Native typing did not update Monaco: ' + query); return { query }; })()"
    Then I collect JSON artifact "user-took-ownership" from extension host expression:
      """
      (async () => {
        const { uri } = globalThis.__backgroundUserSave;
        const path = process.getBuiltinModule('node:path');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const modulePath = path.join(extension.extensionUri.fsPath, extension.packageJSON.main);
        const orchestrator = process.getBuiltinModule('node:module').createRequire(modulePath)(modulePath).toolOrchestrator;
        if (!orchestrator || orchestrator.isHostOwnedBackgroundFile(uri)) throw new Error('Native input did not transfer the background owner.');
        const result = await vscode.lm.invokeTool('kusto-workbench_list-sections', { toolInvocationToken: undefined, input: {} });
        const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
        if (!text || text.startsWith('Error:')) throw new Error(`Inventory failed: ${text}`);
        const report = (JSON.parse(text).openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uri.fsPath.toLowerCase());
        if (!report?.isLiveWorkbench) throw new Error(`Native input did not transfer ownership: ${JSON.stringify(report)}`);
        return { liveOwner: true, sectionIds: report.sections?.map(section => section.id) || [] };
      })()
      """
    When I press "Ctrl+S"
    Then I collect JSON artifact "user-saved-durable" from extension host expression:
      """
      (async () => {
        const { uri } = globalThis.__backgroundUserSave;
        const deadline = Date.now() + 10000;
        let last;
        while (Date.now() < deadline) {
          const file = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
          const sections = file.state.sections;
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          last = { sections, dirty: document?.isDirty };
          if (sections[0].query === 'print UserTyped=77' && sections[1].title === 'Summary' && sections[1].text === '# Preserved' && document && !document.isDirty) {
            return { query: sections[0].query, markdown: sections[1].text, dirty: false };
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`First Save was not durable and clean: ${JSON.stringify(last)}`);
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    When I move the Dev Host to 0, 0
    Then I take a screenshot "background-report-after-real-input-save"
    When I execute command "workbench.action.closeAllEditors"
    Then I wait 1 second
    Then I collect JSON artifact "reopened-report" from extension host expression "(async () => { const { uri } = globalThis.__backgroundUserSave; await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); return { uri: uri.toString() }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] kw-query-section .monaco-editor" in the webview for 30 seconds
    Then I collect JSON artifact "reopened-editor" from webview expression "(() => { const id = document.querySelector('kw-query-section')?.id; const query = window.queryEditors?.[id]?.getValue?.(); const markdown = document.querySelector('kw-markdown-section'); if (query !== 'print UserTyped=77' || !markdown) throw new Error('Reopened report lost a section or query: ' + query); return { query, markdownId: markdown.id }; })()"
    When I evaluate "__testFocusMonaco('kw-query-section .monaco-editor')" in the webview
    When I press "Ctrl+A"
    When I type "print UserTyped=78"
    When I press "Ctrl+S"
    Then I collect JSON artifact "reopened-edit-saved" from extension host expression:
      """
      (async () => {
        const { uri } = globalThis.__backgroundUserSave;
        const deadline = Date.now() + 10000;
        let last;
        while (Date.now() < deadline) {
          const file = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
          const sections = file.state.sections;
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          last = { sections, dirty: document?.isDirty };
          if (sections[0].query === 'print UserTyped=78' && sections[1].text === '# Preserved' && document && !document.isDirty) {
            return { query: sections[0].query, markdown: sections[1].text, dirty: false };
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error(`Post-reopen Save failed: ${JSON.stringify(last)}`);
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    When I move the Dev Host to 0, 0
    Then I take a screenshot "reopened-report-after-second-save"
    When I execute command "workbench.action.closeAllEditors"
    Then I collect JSON artifact "fixture-cleanup" from extension host expression "(async () => { const { root, uri } = globalThis.__backgroundUserSave; if (vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input?.uri?.toString() === uri.toString()))) throw new Error('The test report tab remained open.'); await vscode.workspace.fs.delete(vscode.Uri.file(root), { recursive: true, useTrash: false }); delete globalThis.__backgroundUserSave; return { removed: true }; })()"