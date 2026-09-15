Feature: Workbench tool session survives broad notebook activation

  Scenario: Reactivated canary answers section tools after a 76-file sweep
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    Then I collect JSON artifact "activation-sweep" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-tool-session-activation-sweep');
        try { await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); } catch {}
        await vscode.workspace.fs.createDirectory(root);
        const uris = [];
        for (let index = 0; index < 76; index++) {
          const uri = vscode.Uri.joinPath(root, `activation-sweep-${String(index).padStart(2, '0')}.kqlx`);
          const sections = index === 0
            ? [
                { id: 'sweep_canary_query', type: 'query', name: 'Sweep canary', expanded: true, query: 'print SweepBefore=1' },
                { id: 'sweep_canary_markdown', type: 'markdown', title: 'Sweep notes', expanded: true, text: 'before sweep' },
                { id: 'sweep_canary_notes', type: 'devnotes', entries: [{ id: 'sweep-note', created: '2026-09-12T00:00:00.000Z', updated: '2026-09-12T00:00:00.000Z', category: 'usage-note', content: 'survive activation sweep', source: 'agent' }] }
              ]
            : [{ id: `sweep_query_${index}`, type: 'query', expanded: true, query: `print SweepFile=${index}` }];
          const bytes = new TextEncoder().encode(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2));
          await vscode.workspace.fs.writeFile(uri, bytes);
          uris.push(uri);
        }
        const invoke = async (name, input) => {
          const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
          const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
          if (!text || text.startsWith('Error:')) throw new Error(`${name} failed: ${text}`);
          return JSON.parse(text);
        };
        const waitForCanary = async () => {
          const deadline = Date.now() + 30000;
          let lastCanary = null;
          while (Date.now() < deadline) {
            const listed = await invoke('kusto-workbench_list-sections', {});
            const canary = (listed.openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uris[0].fsPath.toLowerCase());
            lastCanary = canary || null;
            if (canary?.isLiveWorkbench && canary.sectionsUnavailable !== true && canary.sections?.some(section => section.id === 'sweep_canary_query')) return { listed, canary };
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(`Canary did not expose its initial section bridge: ${JSON.stringify(lastCanary)}`);
        };
        await vscode.commands.executeCommand('vscode.openWith', uris[0], 'kusto.kqlxEditor', { preview: false });
        const activeUri = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() || '';
        if (activeUri() !== uris[0].toString()) throw new Error(`Canary activation selected ${activeUri()}`);
        let activatedFileCount = 1;
        const initial = await waitForCanary();
        for (let index = 1; index < uris.length; index++) {
          await vscode.commands.executeCommand('vscode.openWith', uris[index], 'kusto.kqlxEditor', { preview: false });
          if (activeUri() !== uris[index].toString()) throw new Error(`Activation ${index} selected ${activeUri()}`);
          activatedFileCount++;
        }
        const activated = await invoke('kusto-workbench_activate-workbench-file', { openFileId: initial.canary.openFileId });
        if (activated.success !== true) throw new Error(`Canary reactivation failed: ${JSON.stringify(activated)}`);
        const recovered = await waitForCanary();
        if (recovered.canary.sectionsUnavailable === true) throw new Error(`Canary sections remained unavailable: ${JSON.stringify(recovered.canary)}`);
        const configured = await invoke('kusto-workbench_configure-query-section', {
          openFileId: initial.canary.openFileId,
          sectionId: 'sweep_canary_query',
          query: 'print SweepRecovered=76',
          execute: false
        });
        if (configured.success !== true) throw new Error(`Known canary section update failed: ${JSON.stringify(configured)}`);
        return {
          activatedFileCount,
          canaryOpenFileId: initial.canary.openFileId,
          initialSectionIds: initial.canary.sections.map(section => section.id),
          recoveredSectionIds: recovered.canary.sections.map(section => section.id),
          sectionsUnavailable: recovered.canary.sectionsUnavailable === true,
          configured
        };
      })()
      """
    When I wait for "#sweep_canary_query" in the webview for 30 seconds
    Then I collect JSON artifact "reactivated-canary" from webview expression "(() => { const section = document.getElementById('sweep_canary_query'); const query = window.queryEditors?.sweep_canary_query?.getValue?.() || section?.getCopilotEditorValue?.() || ''; if (query !== 'print SweepRecovered=76') throw new Error('Known canary section did not receive the tool update: ' + query); return { query, sectionCount: document.querySelectorAll('#queries-container > [id]').length }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "reactivated-canary-after-76-files"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "durable-canary" from extension host expression:
      """
      (async () => {
        const uri = vscode.Uri.joinPath(vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-tool-session-activation-sweep'), 'activation-sweep-00.kqlx');
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const expectedSections = [
          { id: 'sweep_canary_query', type: 'query', name: 'Sweep canary', expanded: true, resultsVisible: true, clusterUrl: '', database: '', query: 'print SweepRecovered=76', runMode: 'take100', cacheEnabled: true, cacheValue: 1, cacheUnit: 'days' },
          { id: 'sweep_canary_markdown', type: 'markdown', title: 'Sweep notes', text: 'before sweep', expanded: true },
          { id: 'sweep_canary_notes', type: 'devnotes', entries: [{ id: 'sweep-note', created: '2026-09-12T00:00:00.000Z', updated: '2026-09-12T00:00:00.000Z', category: 'usage-note', content: 'survive activation sweep', source: 'agent' }] }
        ];
        const expectedFile = { kind: 'kqlx', version: 1, state: { sections: expectedSections } };
        const expectedText = JSON.stringify(expectedFile, null, 2) + String.fromCharCode(10);
        if (text !== expectedText) throw new Error(`Saved canary bytes differed: ${text}`);
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!document || document.isDirty) throw new Error(`Saved canary was not clean: ${document?.isDirty}`);
        return { exactBytes: true, sectionIds: expectedSections.map(section => section.id), query: expectedSections[0].query, dirty: document.isDirty };
      })()
      """
    When I execute command "workbench.action.closeAllEditors"
    Then I wait 1 second
    Then I collect JSON artifact "reopen-canary" from extension host expression "(async () => { const uri = vscode.Uri.joinPath(vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-tool-session-activation-sweep'), 'activation-sweep-00.kqlx'); await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); return { opened: true }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #sweep_canary_query" in the webview "activation-sweep-00.kqlx" for 30 seconds
    Then I collect JSON artifact "reopened-canary" from webview expression "(() => { const query = window.queryEditors?.sweep_canary_query?.getValue?.() || ''; if (query !== 'print SweepRecovered=76') throw new Error('Reopened canary query was not durable: ' + query); return { query }; })()"
    Then I collect JSON artifact "reopened-inventory" from extension host expression:
      """
      (async () => {
        const uri = vscode.Uri.joinPath(vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-tool-session-activation-sweep'), 'activation-sweep-00.kqlx');
        const expectedIds = ['sweep_canary_query', 'sweep_canary_markdown', 'sweep_canary_notes'];
        const result = await vscode.lm.invokeTool('kusto-workbench_list-sections', { toolInvocationToken: undefined, input: {} });
        const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
        if (!text || text.startsWith('Error:')) throw new Error(`Reopened inventory failed: ${text}`);
        const listed = JSON.parse(text);
        const canary = (listed.openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uri.fsPath.toLowerCase());
        const sectionIds = canary?.sections?.map(section => section.id) || [];
        if (!canary?.isLiveWorkbench || canary.sectionsUnavailable === true || JSON.stringify(sectionIds) !== JSON.stringify(expectedIds)) throw new Error(`Reopened inventory differed: ${JSON.stringify(canary)}`);
        return { sectionIds, sectionsUnavailable: false };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "reopened-canary-after-76-files"
    When I execute command "workbench.action.closeAllEditors"
    Then I collect JSON artifact "activation-sweep-cleanup" from extension host expression "(async () => { const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-tool-session-activation-sweep'); await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); return { deleted: true }; })()"
