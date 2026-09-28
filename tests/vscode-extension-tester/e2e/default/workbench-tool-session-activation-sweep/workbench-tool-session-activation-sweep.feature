Feature: Workbench tool session survives broad notebook activation

  Scenario: Reactivated canary answers section tools after a 97-file mixed sweep
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    And I wait 2 seconds
    Then I collect JSON artifact "activation-sweep-baseline" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const util = process.getBuiltinModule('node:util');
        const config = vscode.workspace.getConfiguration('files');
        const previousAutoSave = config.inspect('autoSave')?.globalValue;
        const previousDelay = config.inspect('autoSaveDelay')?.globalValue;
        globalThis.__sweepAutoSaveSettings = { previousAutoSave, previousDelay };
        await config.update('autoSaveDelay', 1000, vscode.ConfigurationTarget.Global);
        await config.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
        const settingsDeadline = Date.now() + 5000;
        while (Date.now() < settingsDeadline && (vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000)) await new Promise(resolve => setTimeout(resolve, 100));
        if (vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000) throw new Error('Isolated sweep autosave was not enabled');
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'kw-tool-session-activation-sweep-')));
        globalThis.__sweepRoot = root;
        const dashboardCode = '<script type="application/kw-provenance">' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'sweep_canary_fact', sectionName: 'Sweep fact' } }, bindings: { total: { display: { type: 'scalar', agg: 'SUM', column: 'Amount' } } } }) + '</script><span data-kw-bind="total">0</span>';
        globalThis.__sweepDashboardCode = dashboardCode;
        const uris = [];
        const viewTypes = { kqlx: 'kusto.kqlxEditor', sqlx: 'kusto.kqlxEditor', mdx: 'kusto.kqlxEditor', kql: 'kusto.kqlCompatEditor', sql: 'kusto.sqlCompatEditor', md: 'kusto.mdCompatEditor' };
        const sourceBytes = new Map();
        const kindCounts = {};
        for (let index = 0; index < 97; index++) {
          const kind = index <= 42 || index === 87 || index === 89 ? 'kqlx'
            : index <= 68 || index === 88 || index === 90 ? 'sqlx'
              : index <= 86 ? 'mdx' : index <= 92 ? 'kql' : index <= 94 ? 'sql' : 'md';
          kindCounts[kind] = (kindCounts[kind] || 0) + 1;
          const uri = vscode.Uri.joinPath(root, `activation-sweep-${String(index).padStart(2, '0')}.${kind}`);
          const sections = index === 0
            ? [
                { id: 'sweep_canary_fact', type: 'query', name: 'Sweep fact', expanded: true, resultsVisible: false, runMode: 'take100', cacheEnabled: true, cacheValue: 1, cacheUnit: 'days', query: 'datatable(RowId:long, Amount:real)[1, 10.5, 2, 21.0]', resultJson: JSON.stringify({ columns: [{ name: 'RowId', type: 'long' }, { name: 'Amount', type: 'real' }], rows: [[1, 10.5], [2, 21]], metadata: { executionTime: '00:00:00.010' } }) },
                { id: 'sweep_canary_query', type: 'query', name: 'Sweep canary', expanded: true, resultsVisible: true, clusterUrl: '', database: '', runMode: 'take100', cacheEnabled: true, cacheValue: 1, cacheUnit: 'days', query: 'print SweepBefore=1' },
                { id: 'sweep_canary_markdown', type: 'markdown', title: 'Sweep notes', expanded: true, text: 'before sweep' },
                { id: 'sweep_canary_dashboard', type: 'html', name: 'Sweep dashboard', code: dashboardCode, mode: 'preview', expanded: true, previewHeightPx: 160, dataSourceIds: ['sweep_canary_fact'] },
                { id: 'sweep_canary_notes', type: 'devnotes', entries: [{ id: 'sweep-note', created: '2026-09-12T00:00:00.000Z', updated: '2026-09-12T00:00:00.000Z', category: 'usage-note', content: 'survive activation sweep', source: 'agent' }] }
              ]
            : index === 87 || index === 88 ? []
              : kind === 'sqlx' ? [{ id: `sweep_sql_${index}`, type: 'sql', expanded: true, query: `SELECT ${index} AS SweepFile` }]
                : kind === 'mdx' ? [{ id: `sweep_markdown_${index}`, type: 'markdown', title: `Sweep ${index}`, text: `* First ${index}${String.fromCharCode(10)}* Second ${index}${String.fromCharCode(10)}`, expanded: true }]
                  : index === 40 ? [{ type: 'query', expanded: true, query: `print SweepFile=${index}` }]
                    : index >= 1 && index <= 12 ? [
                        { id: `sweep_query_${index}`, type: 'query', expanded: true, query: `print SweepFile=${index}`, ...(index === 1 ? { favoritesMode: true } : {}), ...(index === 3 ? { copilotChatVisible: true, copilotChatWidthPx: 360 } : {}) },
                        { id: `sweep_markdown_${index}`, type: 'markdown', title: `Sweep notes ${index}`, text: `* First ${index}${String.fromCharCode(10)}* Second ${index}${String.fromCharCode(10)}`, expanded: true }
                      ] : [{ id: `sweep_query_${index}`, type: 'query', expanded: true, query: `print SweepFile=${index}` }];
          const source = index === 89 || index === 90 ? ''
            : kind === 'kql' ? `print SweepFile=${index}`
              : kind === 'sql' ? `SELECT ${index} AS SweepFile`
                : kind === 'md' ? ['# Sweep notebook', '', '```kql', `print SweepFile=${index}`, '```'].join(String.fromCharCode(10))
                  : JSON.stringify({ kind, version: 1, state: { sections } }, null, 2);
          const bytes = new TextEncoder().encode(source);
          if (index === 0) {
            const template = vscode.Uri.joinPath(root, 'canary-template.kqlx');
            await vscode.workspace.fs.writeFile(template, bytes);
            const prepared = await vscode.commands.executeCommand('kustoWorkbench.test.preparePersistedResultFixture', { engine: 'kusto', templatePath: template.fsPath, outputPath: uri.fsPath });
            if (prepared?.outputPath !== uri.fsPath || !prepared.connectionId) throw new Error(`Offline dashboard fact fixture did not prepare: ${JSON.stringify(prepared)}`);
            const seededFile = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
            if (seededFile.state.sections[0].id !== 'sweep_canary_fact') throw new Error('Prepared fixture lost its fact section');
            const queryFieldOrder = ['id', 'type', 'name', 'clusterUrl', 'authorityId', 'connectionIdHint', 'database', 'query', 'expanded', 'resultsVisible', 'runMode', 'cacheEnabled', 'cacheValue', 'cacheUnit', 'editorHeightPx', 'resultsHeightPx', 'resultJson', 'resultArtifact', 'kustoAccountPartition', 'kustoLeaveNoTraceRevision', 'selectedResultIndex'];
            seededFile.state.sections = seededFile.state.sections.map(section => {
              if (section.type !== 'query') return section;
              if (section.authorityId === '') delete section.authorityId;
              return Object.fromEntries([
                ...queryFieldOrder.filter(key => Object.hasOwn(section, key)).map(key => [key, section[key]]),
                ...Object.entries(section).filter(([key]) => !queryFieldOrder.includes(key))
              ]);
            });
            await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(seededFile, null, 2) + String.fromCharCode(10), 'utf8'));
            globalThis.__sweepInitialCanaryBytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
          } else {
            await vscode.workspace.fs.writeFile(uri, bytes);
          }
          sourceBytes.set(uri.toString(), Buffer.from(await vscode.workspace.fs.readFile(uri)));
          if (index === 91 || index === 93) {
            const sidecarUri = vscode.Uri.file(uri.fsPath + '.json');
            const sidecar = { kind: kind === 'kql' ? 'kqlx' : 'sqlx', version: 1, state: { sections: [{ id: `sweep_companion_${index}`, type: kind === 'kql' ? 'query' : 'sql', linkedQueryPath: path.basename(uri.fsPath), expanded: true, ...(index === 91 ? { copilotChatVisible: true, copilotChatWidthPx: 360 } : {}) }] } };
            await vscode.workspace.fs.writeFile(sidecarUri, Buffer.from(JSON.stringify(sidecar, null, 2), 'utf8'));
            sourceBytes.set(sidecarUri.toString(), Buffer.from(await vscode.workspace.fs.readFile(sidecarUri)));
          }
          uris.push(uri);
        }
        if (JSON.stringify(kindCounts) !== JSON.stringify({ kqlx: 45, sqlx: 28, mdx: 18, kql: 2, sql: 2, md: 2 }) || uris.length !== 97 || sourceBytes.size !== 99) throw new Error(`Invalid mixed fixture composition: ${JSON.stringify(kindCounts)}`);
        const verifySourceBytes = async phase => {
          const modified = [];
          for (const [uriString, expected] of sourceBytes) {
            const actual = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(uriString)));
            if (!actual.equals(expected)) modified.push({ uri: uriString, expectedHash: crypto.createHash('sha256').update(expected).digest('hex'), actualHash: crypto.createHash('sha256').update(actual).digest('hex') });
          }
          return { phase, fileCount: uris.length, companionCount: sourceBytes.size - uris.length, exactBytes: modified.length === 0, modified };
        };
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
        if (initial.canary.uri !== uris[0].toString() || !initial.canary.openFileId) throw new Error(`Canary has no exact URI/openFileId: ${JSON.stringify(initial.canary)}`);
        globalThis.__sweepFinishBaseline = async () => {
        const expectedNote = { id: 'sweep-note', content: 'survive activation sweep' };
        const waitForNotes = async (phase) => {
          const deadline = Date.now() + 30000;
          let last;
          while (Date.now() < deadline) {
            last = await invoke('kusto-workbench_manage-development-notes', {
              action: 'view', openFileId: initial.canary.openFileId
            });
            if (last.success === true && last.notes?.length === 1 && last.notes[0]?.id === expectedNote.id && last.notes[0]?.content === expectedNote.content) return last;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(`Canary notes unavailable ${phase}: ${JSON.stringify(last)}`);
        };
        const waitForDashboard = async phase => {
          const deadline = Date.now() + 30000;
          let last;
          while (Date.now() < deadline) {
            last = await invoke('kusto-workbench_validate-html-dashboard', {
              openFileId: initial.canary.openFileId, targetFileUri: uris[0].toString(), sectionId: 'sweep_canary_dashboard'
            });
            if (last.success === true && last.valid === true && last.hasProvenance === true && last.bindingCount === 1 && last.dataSourceCount === 1 && last.issues?.length === 0 && last.diagnostics?.length === 0 && last.factColumns?.some(column => column.name === 'Amount') && String(last.filePath || '').toLowerCase() === uris[0].fsPath.toLowerCase()) return last;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          throw new Error(`Canary dashboard fixture invalid ${phase}: ${JSON.stringify(last)}`);
        };
        const initialNotes = await waitForNotes('before sweep');
        const initialDashboard = await waitForDashboard('before sweep');
        const baselineDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uris[0].toString());
        const baselineText = new TextDecoder().decode(globalThis.__sweepInitialCanaryBytes);
        if (!baselineDocument || baselineDocument.isDirty || baselineDocument.getText() !== baselineText) {
          const actualText = baselineDocument?.getText() || '';
          const expectedSections = JSON.parse(baselineText).state.sections;
          const actualSections = actualText ? JSON.parse(actualText).state.sections : [];
          throw new Error(`Canary fixture changed before sweep: ${JSON.stringify({ dirty: baselineDocument?.isDirty ?? null, expectedHash: crypto.createHash('sha256').update(baselineText).digest('hex'), memoryHash: crypto.createHash('sha256').update(actualText).digest('hex'), differingSectionIds: expectedSections.filter((section, index) => JSON.stringify(section) !== JSON.stringify(actualSections[index])).map(section => section.id) })}`);
        }
        const inspectCanarySource = async phase => {
          const disk = Buffer.from(await vscode.workspace.fs.readFile(uris[0]));
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uris[0].toString());
          const memory = document?.getText() || '';
          const expectedFile = JSON.parse(baselineText);
          const actualFile = memory ? JSON.parse(memory) : { state: { sections: [] } };
          const expectedSections = expectedFile.state.sections;
          const actualSections = actualFile.state.sections;
          const differingSections = expectedSections.map((section, index) => ({
            id: section.id,
            fields: Array.from(new Set([...Object.keys(section), ...Object.keys(actualSections[index] || {})]))
              .filter(key => !util.isDeepStrictEqual(section[key], actualSections[index]?.[key]))
              .map(key => ({ key, expected: section[key] ?? null, actual: actualSections[index]?.[key] ?? null }))
          })).filter(section => section.fields.length > 0);
          let firstDifference = 0;
          while (firstDifference < Math.min(memory.length, baselineText.length) && memory[firstDifference] === baselineText[firstDifference]) firstDifference++;
          const rootKeys = Array.from(new Set([...Object.keys(expectedFile), ...Object.keys(actualFile)]));
          const stateKeys = Array.from(new Set([...Object.keys(expectedFile.state), ...Object.keys(actualFile.state)]));
          return { phase, diskStable: disk.equals(globalThis.__sweepInitialCanaryBytes), dirty: document?.isDirty ?? null, memoryStable: memory === baselineText, memoryHash: crypto.createHash('sha256').update(memory).digest('hex'), parsedStateStable: util.isDeepStrictEqual(expectedFile, actualFile), firstDifference, baselineLength: baselineText.length, memoryLength: memory.length, baselineExcerpt: baselineText.slice(Math.max(0, firstDifference - 24), firstDifference + 60), memoryExcerpt: memory.slice(Math.max(0, firstDifference - 24), firstDifference + 60), rootKeysChanged: rootKeys.filter(key => !util.isDeepStrictEqual(expectedFile[key], actualFile[key])), stateKeysChanged: stateKeys.filter(key => key !== 'sections' && !util.isDeepStrictEqual(expectedFile.state[key], actualFile.state[key])), differingSections };
        };
        globalThis.__sweepState = {
          uris, viewTypes, path, kindCounts, initial, expectedNote,
          initialNotes, initialDashboard, activeUri, activatedFileCount,
          verifySourceBytes, inspectCanarySource, invoke, waitForCanary, waitForNotes, waitForDashboard,
        };
        return { createdFileCount: uris.length, companionCount: sourceBytes.size - uris.length, canaryOpenFileId: initial.canary.openFileId, baselineNoteCount: initialNotes.notes.length, initialDashboardValid: initialDashboard.valid };
        };
        return { createdFileCount: uris.length, companionCount: sourceBytes.size - uris.length, canaryOpenFileId: initial.canary.openFileId };
      })()
      """
    When I evaluate "window.__e2e.workbench.waitForPersistedResult('sweep_canary_fact', 19000)" in the webview "activation-sweep-00.kqlx" for 25 seconds
    Then I collect JSON artifact "activation-sweep-canary-baseline" from extension host expression "globalThis.__sweepFinishBaseline()"
    Then I collect JSON artifact "activation-sweep-files" from extension host expression:
      """
      (async () => {
        const state = globalThis.__sweepState;
        for (let index = 1; index < state.uris.length; index++) {
          const kind = state.path.extname(state.uris[index].fsPath).slice(1);
          await vscode.commands.executeCommand('vscode.openWith', state.uris[index], state.viewTypes[kind], { preview: false });
          if (state.activeUri() !== state.uris[index].toString()) throw new Error(`Activation ${index} selected ${state.activeUri()}`);
          state.activatedFileCount++;
        }
        state.sourceAfterSweep = await state.verifySourceBytes('after 97 activations');
        state.hiddenSource = await state.inspectCanarySource('hidden-after-sweep');
        return { activatedFileCount: state.activatedFileCount, sourceAfterSweep: state.sourceAfterSweep, hiddenSource: state.hiddenSource };
      })()
      """
    Then I collect JSON artifact "activation-sweep" from extension host expression:
      """
      (async () => {
        const {
          uris, kindCounts, initial, expectedNote, initialNotes, initialDashboard,
          activatedFileCount, sourceAfterSweep, hiddenSource,
          invoke, waitForCanary, waitForNotes, waitForDashboard,
          verifySourceBytes, inspectCanarySource,
        } = globalThis.__sweepState;
        const expectedSectionIds = initial.canary.sections.map(section => section.id);
        const hiddenListed = await invoke('kusto-workbench_list-sections', {});
        const hiddenCanary = (hiddenListed.openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uris[0].fsPath.toLowerCase());
        const hiddenNotes = await invoke('kusto-workbench_manage-development-notes', { action: 'view', openFileId: initial.canary.openFileId }).catch(error => ({ success: false, error: String(error) }));
        const hiddenDashboard = await invoke('kusto-workbench_validate-html-dashboard', { openFileId: initial.canary.openFileId, targetFileUri: uris[0].toString(), sectionId: 'sweep_canary_dashboard' }).catch(error => ({ success: false, valid: false, error: String(error) }));
        const activated = await invoke('kusto-workbench_activate-workbench-file', { openFileId: initial.canary.openFileId });
        if (activated.success !== true || activated.isLiveWorkbench !== true || activated.openFileId !== initial.canary.openFileId || activated.uri !== uris[0].toString()) throw new Error(`Canary reactivation was not live and exact: ${JSON.stringify(activated)}`);
        const recovered = await waitForCanary();
        if (recovered.canary.sectionsUnavailable === true || recovered.canary.openFileId !== initial.canary.openFileId || recovered.canary.uri !== uris[0].toString() || JSON.stringify(recovered.canary.sections?.map(section => section.id)) !== JSON.stringify(expectedSectionIds)) throw new Error(`Canary sections or identity changed: ${JSON.stringify(recovered.canary)}`);
        const recoveredNotes = await waitForNotes('after URI reactivation').catch(error => ({ success: false, notes: [], error: String(error) }));
        const recoveredDashboard = await waitForDashboard('after URI reactivation').catch(error => ({ success: false, valid: false, error: String(error) }));
        const sourceAfterReactivation = await verifySourceBytes('after URI reactivation');
        const revealedSource = await inspectCanarySource('reactivated');
        if (!hiddenSource.parsedStateStable || !revealedSource.parsedStateStable) throw new Error(`Canary content changed before authored Save: ${JSON.stringify({ hiddenSource, revealedSource })}`);
        const summarizeNotes = result => ({ success: result.success === true, count: result.notes?.length || 0, id: result.notes?.[0]?.id || '', content: result.notes?.[0]?.content || '', error: result.error || '' });
        const summarizeDashboard = result => ({ success: result.success === true, valid: result.valid === true, hasProvenance: result.hasProvenance === true, bindingCount: result.bindingCount || 0, dataSourceCount: result.dataSourceCount || 0, factColumns: result.factColumns || [], issues: result.issues || [], filePath: result.filePath || '', error: result.error || '' });
        const hiddenApi = { isLiveWorkbench: hiddenCanary?.isLiveWorkbench === true, sectionsUnavailable: hiddenCanary?.sectionsUnavailable === true, openFileId: hiddenCanary?.openFileId || '', uri: hiddenCanary?.uri || '', sectionIds: hiddenCanary?.sections?.map(section => section.id) || [], notes: summarizeNotes(hiddenNotes), dashboard: summarizeDashboard(hiddenDashboard) };
        const reactivatedApi = { isLiveWorkbench: recovered.canary.isLiveWorkbench === true, sectionsUnavailable: false, openFileId: recovered.canary.openFileId, uri: recovered.canary.uri, sectionIds: recovered.canary.sections.map(section => section.id), notes: summarizeNotes(recoveredNotes), dashboard: summarizeDashboard(recoveredDashboard) };
        const passes = api => api.isLiveWorkbench && !api.sectionsUnavailable && api.openFileId === initial.canary.openFileId && api.uri === uris[0].toString() && JSON.stringify(api.sectionIds) === JSON.stringify(expectedSectionIds) && api.notes.success && api.notes.count === 1 && api.notes.id === expectedNote.id && api.notes.content === expectedNote.content && api.dashboard.success && api.dashboard.valid && api.dashboard.hasProvenance && api.dashboard.bindingCount === 1 && api.dashboard.dataSourceCount === 1 && api.dashboard.issues.length === 0 && api.dashboard.factColumns.some(column => column.name === 'Amount') && api.dashboard.filePath.toLowerCase() === uris[0].fsPath.toLowerCase();
        globalThis.__sweepApiContract = { hidden: passes(hiddenApi), reactivated: passes(reactivatedApi), hiddenApi, reactivatedApi, sourceAfterSweep, sourceAfterReactivation };
        globalThis.__sweepCanaryOpenFileId = initial.canary.openFileId;
        return {
          activatedFileCount,
          kindCounts,
          sourceAfterSweep,
          sourceAfterReactivation,
          canaryOpenFileId: initial.canary.openFileId,
          initialSectionIds: initial.canary.sections.map(section => section.id),
          recoveredSectionIds: recovered.canary.sections.map(section => section.id),
          sectionsUnavailable: recovered.canary.sectionsUnavailable === true,
          baselineNoteCount: initialNotes.notes.length,
          noteCount: recoveredNotes.notes.length,
          initialDashboard: { valid: initialDashboard.valid, bindingCount: initialDashboard.bindingCount, dataSourceCount: initialDashboard.dataSourceCount, factColumns: initialDashboard.factColumns },
          recoveredDashboard: { valid: recoveredDashboard.valid, bindingCount: recoveredDashboard.bindingCount, dataSourceCount: recoveredDashboard.dataSourceCount, factColumns: recoveredDashboard.factColumns },
          hiddenApi,
          reactivatedApi,
          apiContractMet: globalThis.__sweepApiContract.hidden && globalThis.__sweepApiContract.reactivated,
          bytesUnchangedBeforeSave: sourceAfterSweep.exactBytes && sourceAfterReactivation.exactBytes,
          hiddenSource,
          revealedSource
        };
      })()
      """
    Then I collect JSON artifact "mixed-sweep-api-oracle" from extension host expression "(() => { const result = globalThis.__sweepApiContract; if (!result?.hidden || !result.reactivated || !result.sourceAfterSweep?.exactBytes || !result.sourceAfterReactivation?.exactBytes) throw new Error('No-Save bytes or canary APIs failed after the mixed sweep: ' + JSON.stringify(result)); return { hidden: true, reactivated: true, exactBytes: true }; })()"
    Then I collect JSON artifact "close-disposable-sweep-tabs" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const root = globalThis.__sweepRoot; const expected = vscode.Uri.joinPath(root, 'activation-sweep-00.kqlx').toString(); const parent = path.resolve(process.env.TEMP || process.cwd()); if (!root?.fsPath || path.dirname(path.resolve(root.fsPath)).toLowerCase() !== parent.toLowerCase() || !path.basename(root.fsPath).startsWith('kw-tool-session-activation-sweep-')) throw new Error('Sweep root is not task-owned'); const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs); const own = tabs.filter(tab => tab.input?.uri?.scheme === 'file' && path.dirname(tab.input.uri.fsPath).toLowerCase() === path.resolve(root.fsPath).toLowerCase()); const other = own.filter(tab => tab.input.uri.toString() !== expected); if (own.length !== 97 || other.length !== 96 || own.some(tab => tab.isDirty)) throw new Error('Refusing to close missing or dirty disposable tabs: ' + JSON.stringify({ own: own.length, other: other.length, dirty: own.filter(tab => tab.isDirty).map(tab => tab.input?.uri?.fsPath) })); if (!await vscode.window.tabGroups.close(other)) throw new Error('Could not close all 96 disposable sweep tabs'); if (vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== expected) await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(expected), 'kusto.kqlxEditor', { preview: false }); return { closed: 96, canaryUri: expected, active: vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() }; })()"
    Then I collect JSON artifact "configured-canary" from extension host expression "(async () => { const result = await vscode.lm.invokeTool('kusto-workbench_configure-query-section', { toolInvocationToken: undefined, input: { openFileId: globalThis.__sweepCanaryOpenFileId, sectionId: 'sweep_canary_query', query: 'print SweepRecovered=97', execute: false } }); const text = String(result.content.find(part => typeof part?.value === 'string')?.value || ''); if (!text || text.startsWith('Error:')) throw new Error('Canary query update failed: ' + text); const configured = JSON.parse(text); if (configured.success !== true) throw new Error('Canary query update was rejected: ' + text); return configured; })()"
    Then I collect JSON artifact "reactivated-canary" from extension host expression "(() => { const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx'); const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString()); const section = document && JSON.parse(document.getText()).state.sections.find(item => item.id === 'sweep_canary_query'); if (!document || section?.query !== 'print SweepRecovered=97') throw new Error('Known canary query was not live in the document buffer: ' + JSON.stringify(section)); return { query: section.query, dirty: document.isDirty, activeUri: vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() || '' }; })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "durable-canary" from extension host expression:
      """
      (async () => {
        const crypto = process.getBuiltinModule('node:crypto');
        const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx');
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const file = JSON.parse(text);
        const sections = file.state.sections;
        const expectedIds = ['sweep_canary_fact', 'sweep_canary_query', 'sweep_canary_markdown', 'sweep_canary_dashboard', 'sweep_canary_notes'];
        const initialFile = JSON.parse(new TextDecoder().decode(globalThis.__sweepInitialCanaryBytes));
        if (file.kind !== 'kqlx' || file.version !== 1 || JSON.stringify(sections.map(section => section.id)) !== JSON.stringify(expectedIds)
          || sections[0].resultJson !== initialFile.state.sections[0].resultJson
          || sections[1].query !== 'print SweepRecovered=97'
          || sections[2].text !== 'before sweep'
          || sections[3].code !== globalThis.__sweepDashboardCode || sections[3].dataSourceIds?.join('|') !== 'sweep_canary_fact'
          || sections[4].entries?.length !== 1 || sections[4].entries[0]?.id !== 'sweep-note' || sections[4].entries[0]?.content !== 'survive activation sweep'
          || text !== JSON.stringify(file, null, 2) + String.fromCharCode(10)) throw new Error(`Saved canary lost expected content or formatting: ${text}`);
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!document || document.isDirty) throw new Error(`Saved canary was not clean: ${document?.isDirty}`);
        globalThis.__sweepSavedText = text;
        return { exactBytes: true, sha256: crypto.createHash('sha256').update(text).digest('hex'), sectionIds: expectedIds, query: sections[1].query, dirty: document.isDirty };
      })()
      """
    Then I collect JSON artifact "close-canary-for-reopen" from extension host expression "(async () => { const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx'); const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.toString() === uri.toString()); if (!tab || tab.isDirty || !await vscode.window.tabGroups.close(tab)) throw new Error('Could not cleanly close the exact task-owned canary'); return { closed: true }; })()"
    Then I wait 1 second
    Then I collect JSON artifact "reopen-canary" from extension host expression "(async () => { const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx'); await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); return { opened: true }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #sweep_canary_query" in the webview "activation-sweep-00.kqlx" for 30 seconds
    Then I collect JSON artifact "reopened-canary" from webview expression "(() => { const query = window.queryEditors?.sweep_canary_query?.getValue?.() || ''; if (query !== 'print SweepRecovered=97') throw new Error('Reopened canary query was not durable: ' + query); return { query }; })()"
    Then I collect JSON artifact "reopened-inventory" from extension host expression:
      """
      (async () => {
        const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx');
        const expectedIds = ['sweep_canary_fact', 'sweep_canary_query', 'sweep_canary_markdown', 'sweep_canary_dashboard', 'sweep_canary_notes'];
        const result = await vscode.lm.invokeTool('kusto-workbench_list-sections', { toolInvocationToken: undefined, input: {} });
        const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
        if (!text || text.startsWith('Error:')) throw new Error(`Reopened inventory failed: ${text}`);
        const listed = JSON.parse(text);
        const canary = (listed.openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uri.fsPath.toLowerCase());
        const sectionIds = canary?.sections?.map(section => section.id) || [];
        const durableText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        if (!canary?.isLiveWorkbench || canary.sectionsUnavailable === true || JSON.stringify(sectionIds) !== JSON.stringify(expectedIds) || durableText !== globalThis.__sweepSavedText) throw new Error(`Reopened inventory or saved bytes differed: ${JSON.stringify(canary)}`);
        return { sectionIds, sectionsUnavailable: false, exactSavedBytes: true };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "reopened-canary-after-97-files"
    Then I collect JSON artifact "close-reopened-canary" from extension host expression "(async () => { const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx'); const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.toString() === uri.toString()); if (!tab || tab.isDirty || !await vscode.window.tabGroups.close(tab)) throw new Error('Could not cleanly close the exact reopened canary'); return { closed: true }; })()"
    Then I collect JSON artifact "activation-sweep-cleanup" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const root = globalThis.__sweepRoot; const parent = path.resolve(process.env.TEMP || process.cwd()); if (!root?.fsPath || path.dirname(path.resolve(root.fsPath)).toLowerCase() !== parent.toLowerCase() || !path.basename(root.fsPath).startsWith('kw-tool-session-activation-sweep-')) throw new Error('Refusing to delete an unowned sweep fixture'); await vscode.commands.executeCommand('kustoWorkbench.test.cleanupPersistedResultFixture'); await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); const settings = globalThis.__sweepAutoSaveSettings; const config = vscode.workspace.getConfiguration('files'); await config.update('autoSave', settings.previousAutoSave, vscode.ConfigurationTarget.Global); await config.update('autoSaveDelay', settings.previousDelay, vscode.ConfigurationTarget.Global); delete globalThis.__sweepAutoSaveSettings; delete globalThis.__sweepRoot; return { deleted: true }; })()"
