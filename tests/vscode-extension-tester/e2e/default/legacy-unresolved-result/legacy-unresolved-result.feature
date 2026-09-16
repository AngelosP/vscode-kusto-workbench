Feature: Unresolved legacy Kusto result visibility

  Background:
    Then I collect JSON artifact "unresolved-legacy-isolation" from extension host expression:
      """
      (() => {
        process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH = '1';
        if (vscode.workspace.getConfiguration('files').get('autoSave') !== 'off') throw new Error('This scenario requires an isolated launch with Auto Save off');
        globalThis.__unresolvedLegacyOriginalTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => tab.input?.uri?.toString()).filter(Boolean);
        return { vscodeVersion: vscode.version, autoSave: 'off', originalTabUris: globalThis.__unresolvedLegacyOriginalTabs, syntheticOwner: false };
      })()
      """
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections" with args '[true]'
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closePanel"

  Scenario: Existing markerless data survives auth and Leave No Trace through edit, Save, exact close, reopen, and another edit
    Then I collect JSON artifact "unresolved-legacy-prepared" from extension host expression "(async () => { const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench'); if (!extension) throw new Error('Kusto Workbench extension unavailable'); const template = vscode.Uri.joinPath(extension.extensionUri, 'tests', 'vscode-extension-tester', 'e2e', 'default', 'legacy-result-migration', 'fixtures', 'legacy-chart-ragged.kqlx'); const directory = vscode.Uri.joinPath(extension.extensionUri, 'tests', 'vscode-extension-tester', 'runs', 'default', 'legacy-unresolved-result'); const output = vscode.Uri.joinPath(directory, 'unresolved-legacy-' + Date.now() + '.kqlx'); const fixture = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(template))); fixture.state.sections.find(section => section.id === 'query_legacy_migration').expanded = true; const bytes = new TextEncoder().encode(JSON.stringify(fixture, null, 2)); await vscode.workspace.fs.createDirectory(directory); await vscode.workspace.fs.writeFile(output, bytes); globalThis.__unresolvedLegacyUri = output; return { copiedBytes: bytes.byteLength, filename: output.path.split('/').pop(), ownerPrepared: false, extensionVersion: extension.packageJSON.version }; })()"
    Then I collect JSON artifact "unresolved-legacy-baseline" from extension host expression:
      """
      (async () => {
        const uri = globalThis.__unresolvedLegacyUri;
        if (!uri) throw new Error('Unique unresolved legacy URI was not prepared');
        const bytes = await vscode.workspace.fs.readFile(uri);
        const section = JSON.parse(new TextDecoder().decode(bytes)).state.sections.find(entry => entry.id === 'query_legacy_migration');
        const result = section?.resultJson ? JSON.parse(section.resultJson) : undefined;
        if (JSON.stringify(result?.rows) !== JSON.stringify([['alpha', 10, 'legacy-extra-a'], ['beta', 20, 'legacy-extra-b'], ['gamma', 30, 'legacy-extra-c']]) || section.kustoAccountPartition !== undefined || section.kustoLeaveNoTraceRevision !== undefined || section.resultArtifact?.policy?.exportToCsv !== true || section.resultArtifact?.policy?.exposeToActiveContent !== true) throw new Error('Unresolved legacy baseline is not the exact ragged, markerless fixture');
        globalThis.__unresolvedLegacyResultJson = section.resultJson;
        globalThis.__unresolvedLegacyResultArtifact = JSON.stringify(section.resultArtifact);
        globalThis.__unresolvedLegacyCheckSaved = async expectedTitle => {
          const deadline = Date.now() + 10000;
          let observed = null;
          while (Date.now() < deadline) {
            const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
            const savedBytes = await vscode.workspace.fs.readFile(uri);
            const file = JSON.parse(new TextDecoder().decode(savedBytes));
            const saved = file.state.sections.find(entry => entry.id === 'query_legacy_migration');
            const chart = file.state.sections.find(entry => entry.id === 'chart_legacy_migration');
            observed = { dirty: document?.isDirty ?? null, chartTitle: chart?.chartTitle ?? null, mode: chart?.mode ?? null, resultJson: saved?.resultJson ?? null, resultArtifact: saved?.resultArtifact ?? null };
            if (document && !document.isDirty && chart?.chartTitle === expectedTitle && chart.mode === 'preview') {
              if (saved?.resultJson !== globalThis.__unresolvedLegacyResultJson || JSON.stringify(saved.resultArtifact) !== globalThis.__unresolvedLegacyResultArtifact || saved.kustoAccountPartition !== undefined || saved.kustoLeaveNoTraceRevision !== undefined) throw new Error('Saved existing data or metadata changed: ' + JSON.stringify(observed));
              return { bytes: savedBytes.byteLength, payloadStable: true, metadataStable: true, markerless: true, ...observed };
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error('Real Save did not settle the authored edit: ' + JSON.stringify(observed));
        };
        return { bytes: bytes.byteLength, resultJson: section.resultJson, resultArtifact: section.resultArtifact, markerless: true, persistedRowWidths: result.rows.map(row => row.length) };
      })()
      """
    Then I collect JSON artifact "unresolved-legacy-opened" from extension host expression "(async () => { const uri = globalThis.__unresolvedLegacyUri; if (!uri) throw new Error('Unique unresolved legacy URI was not prepared'); await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor'); return { opened: true, filename: uri.path.split('/').pop() }; })()"
    When I wait for "body[data-kusto-e2e-ready='true']" in the webview for 20 seconds
    When I wait for "kw-query-section" in the webview for 20 seconds
    Then I collect JSON artifact "unresolved-legacy-host-startup" from extension host expression "(async () => { await new Promise(resolve => setTimeout(resolve, 2000)); const uri = globalThis.__unresolvedLegacyUri; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri?.toString()); const buffer = document ? JSON.parse(document.getText()) : undefined; const disk = uri ? JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) : undefined; return { dirty: document?.isDirty ?? null, bufferHasResult: !!buffer?.state?.sections?.find(section => section.id === 'query_legacy_migration')?.resultJson, diskHasResult: !!disk?.state?.sections?.find(section => section.id === 'query_legacy_migration')?.resultJson }; })()"
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.waitForPersistedResult('query_legacy_migration', 19000); })()" in the webview for 20 seconds
    Then I collect JSON artifact "unresolved-legacy-first-file" from extension host expression "(async () => { const uri = globalThis.__unresolvedLegacyUri; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri?.toString()); if (!document) throw new Error('Open unresolved legacy fixture is unavailable'); const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); const section = JSON.parse(text).state.sections.find(entry => entry.id === 'query_legacy_migration'); if (section?.resultJson !== globalThis.__unresolvedLegacyResultJson || section.kustoAccountPartition !== undefined || section.kustoLeaveNoTraceRevision !== undefined) throw new Error('Unresolved legacy disk payload changed before Save: ' + JSON.stringify(section)); return { payloadStable: true, bytes: text.length, markerless: true, hasResult: true, dirtyBeforeSave: document.isDirty, descriptorStillOnDisk: section.resultArtifact !== undefined }; })()"
    Then I collect JSON artifact "unresolved-legacy-first-ui" from webview expression "(async () => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); const chart = await window.__e2e.workbench.assertMigratedResultChart('query_legacy_migration', 'chart_legacy_migration', 3); const section = document.getElementById('query_legacy_migration'); const table = section?.querySelector('kw-data-table'); const values = table?.rows?.map(row => row.slice(0, 2)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); if (JSON.stringify(values) !== JSON.stringify([['alpha', 10], ['beta', 20], ['gamma', 30]]) || rendered.length !== 3 || rendered.some(row => row.getBoundingClientRect().height <= 0) || table.options?.showSave === true) throw new Error('Existing result rows are not rendered exactly: ' + JSON.stringify({ values, rendered: rendered.length, showSave: table?.options?.showSave })); window.__unresolvedLegacyArtifactId = chart.artifactId; return { chart, values, renderedRows: rendered.length, saveVisible: false }; })()"
    Then I collect JSON artifact "unresolved-legacy-auth-lnt" from webview expression:
      """
      (async () => {
        if (window.__e2eIsolatedKustoConnections) throw new Error('Webview isolation would suppress the LNT event under test');
        if (window.connections?.length) throw new Error('Unexpected real Kusto connections in the isolated fixture');
        const state = { acknowledgements: [], blocked: [], policyRequests: 0, revision: 1000 };
        window.__unresolvedLegacyTransport = state;
        const previousCapture = window.__e2eCaptureHostMessage;
        const receive = data => window.dispatchEvent(new MessageEvent('message', { data }));
        const snapshot = policyRequestId => ({
          type: 'connectionsData', connectionsRevision: ++state.revision, connections: [], accounts: [],
          lastConnectionId: null, lastDatabase: null, cachedDatabases: {}, favorites: [],
          caretDocsEnabled: true, caretDocsEnabledUserSet: false,
          autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
          copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
          editingPreferencesRevision: 0, copilotChatFirstTimeDismissed: true, devNotesEnabled: true,
          leaveNoTraceClusters: ['https://unresolved-legacy-e2e.kusto.windows.net'],
          leaveNoTraceGloballyBlocked: false, leaveNoTraceRevisions: { 'unresolved-legacy-e2e.kusto.windows.net': 1 },
          ...(policyRequestId ? { policyRequestId } : {})
        });
        window.__e2eCaptureHostMessage = message => {
          if (message.type === 'kustoPublicationAck' && message.publicationId === 'unresolved-legacy-lnt') {
            state.acknowledgements.push({ phase: message.phase, accepted: message.accepted });
            return false;
          }
          if (message.type === 'getConnections') {
            state.policyRequests++;
            queueMicrotask(() => receive(snapshot(message.policyRequestId)));
            return false;
          }
          if (/executeQuery|executeSqlQuery|Database|Schema|Auth|Account|PowerBI|Fabric|Copilot|fetchUrl|testKustoConnection/.test(message.type)) {
            state.blocked.push(message.type);
            return false;
          }
          return typeof previousCapture === 'function' ? previousCapture(message) : undefined;
        };
        const source = document.getElementById('query_legacy_migration');
        const invalidate = source?.invalidateSchemaLifecycleTarget;
        if (typeof invalidate !== 'function') throw new Error('Source lifecycle observer unavailable');
        let authInvalidations = 0;
        source.invalidateSchemaLifecycleTarget = function (...args) { authInvalidations++; return invalidate.apply(this, args); };
        try { receive({ type: 'kustoAuthIdentityChanged', connectionIds: [] }); }
        finally { source.invalidateSchemaLifecycleTarget = invalidate; }
        if (authInvalidations !== 1) throw new Error('Auth message did not invalidate the real source lifecycle: ' + authInvalidations);
        const waitAck = async phase => {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const acknowledgement = state.acknowledgements.find(entry => entry.phase === phase);
            if (acknowledgement) {
              if (acknowledgement.accepted !== true) throw new Error('LNT projection rejected: ' + JSON.stringify(state.acknowledgements));
              return;
            }
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          throw new Error('LNT projection acknowledgement missing: ' + phase);
        };
        receive({ type: 'kustoPublicationStage', publicationId: 'unresolved-legacy-lnt', publicationDeadline: Date.now() + 10000, payload: snapshot() });
        await waitAck('staged');
        receive({ type: 'kustoPublicationCommit', publicationId: 'unresolved-legacy-lnt' });
        await waitAck('applied');
        const chart = await window.__e2e.workbench.assertMigratedResultChart('query_legacy_migration', 'chart_legacy_migration', 3);
        const values = source.querySelector('kw-data-table')?.rows?.map(row => row.slice(0, 2));
        if (chart.artifactId !== window.__unresolvedLegacyArtifactId || JSON.stringify(values) !== JSON.stringify([['alpha', 10], ['beta', 20], ['gamma', 30]])) throw new Error('Passive auth/LNT replaced existing result data: ' + JSON.stringify({ chart, values }));
        return { authInvalidations, acknowledgements: state.acknowledgements, chart, values, blockedServiceRequests: state.blocked, policyRequests: state.policyRequests };
      })()
      """
    When I click "button.mode-btn[title='Edit']" in the webview
    And I focus "input.chart-title-input" in the webview
    And I press "Ctrl+A"
    When I type "Unresolved legacy saved"
    Then I collect JSON artifact "unresolved-legacy-authored-edit" from webview expression "(() => { const value = document.getElementById('chart_legacy_migration')?.shadowRoot?.querySelector('input.chart-title-input')?.value; if (value !== 'Unresolved legacy saved') throw new Error('Real Chart title input did not receive the edit: ' + value); return { chartTitle: value }; })()"
    When I click "button.mode-btn[title='Preview']" in the webview
    When I press "Ctrl+S"
    Then I collect JSON artifact "unresolved-legacy-saved-file" from extension host expression "globalThis.__unresolvedLegacyCheckSaved('Unresolved legacy saved')"
    Then I collect JSON artifact "unresolved-legacy-saved-ui" from webview expression "(async () => { const chart = await window.__e2e.workbench.assertMigratedResultChart('query_legacy_migration', 'chart_legacy_migration', 3); const state = window.__unresolvedLegacyTransport; if (state.blocked.some(type => /executeQuery|executeSqlQuery|Auth|Account|PowerBI|Fabric|testKustoConnection/.test(type))) throw new Error('Unexpected query/auth/Fabric request was blocked: ' + JSON.stringify(state.blocked)); return { chart, blockedServiceRequests: state.blocked, policyRequests: state.policyRequests, externalQueryAuthFabricRequests: 0 }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "01-unresolved-legacy-saved"

    Then I collect JSON artifact "unresolved-legacy-exact-close" from extension host expression "(async () => { const uri = globalThis.__unresolvedLegacyUri; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString()); if (!document || document.isDirty) throw new Error('Real Save must leave the exact fixture clean before Close'); const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri.toString()); if (tabs.length !== 1 || !await vscode.window.tabGroups.close(tabs, true)) throw new Error('Exact fixture Close failed'); if (vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.uri?.toString() === uri.toString())) throw new Error('Closed fixture tab remains'); return { uri: uri.toString(), dirty: false, closedTabs: tabs.length }; })()"
    When I wait 1 second
    Then I collect JSON artifact "unresolved-legacy-reopened" from extension host expression "(async () => { const uri = globalThis.__unresolvedLegacyUri; await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor'); return { reopened: true, filename: uri.path.split('/').pop() }; })()"
    When I wait for "body[data-kusto-e2e-ready='true']" in the webview for 20 seconds
    When I wait for "kw-query-section" in the webview for 20 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.waitForPersistedResult('query_legacy_migration', 19000); })()" in the webview for 20 seconds
    Then I collect JSON artifact "unresolved-legacy-reopened-file" from extension host expression "globalThis.__unresolvedLegacyCheckSaved('Unresolved legacy saved')"
    Then I collect JSON artifact "unresolved-legacy-reopened-ui" from webview expression "(async () => { const chartContract = await window.__e2e.workbench.assertMigratedResultChart('query_legacy_migration', 'chart_legacy_migration', 3); const section = document.getElementById('query_legacy_migration'); const chart = document.getElementById('chart_legacy_migration'); const chartState = chart?.serialize?.(); const table = section?.querySelector('kw-data-table'); const values = table?.rows?.map(row => row.slice(0, 2)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); if (JSON.stringify(values) !== JSON.stringify([['alpha', 10], ['beta', 20], ['gamma', 30]]) || rendered.length !== 3 || rendered.some(row => row.getBoundingClientRect().height <= 0) || table.options?.showSave === true || chartState?.chartTitle !== 'Unresolved legacy saved') throw new Error('Reopened existing data/Chart contract failed: ' + JSON.stringify({ values, rendered: rendered.length, chartState })); window.__unresolvedLegacyBlockedAfterReopen = []; window.__e2eCaptureHostMessage = message => { if (/executeQuery|executeSqlQuery|Database|Schema|Auth|Account|PowerBI|Fabric|Copilot|fetchUrl|testKustoConnection/.test(message.type)) { window.__unresolvedLegacyBlockedAfterReopen.push(message.type); return false; } }; return { chart: chartContract, values, renderedRows: rendered.length, saveVisible: false, chartTitle: chartState.chartTitle }; })()"
    When I click "button.mode-btn[title='Edit']" in the webview
    And I focus "input.chart-title-input" in the webview
    And I press "Ctrl+A"
    And I type "Unresolved legacy reopened"
    Then I collect JSON artifact "unresolved-legacy-reopened-edit" from webview expression "(() => { const value = document.getElementById('chart_legacy_migration')?.shadowRoot?.querySelector('input.chart-title-input')?.value; if (value !== 'Unresolved legacy reopened') throw new Error('Reopened Chart title input did not receive the edit: ' + value); return { chartTitle: value }; })()"
    When I click "button.mode-btn[title='Preview']" in the webview
    When I press "Ctrl+S"
    Then I collect JSON artifact "unresolved-legacy-post-reopen-save" from extension host expression "globalThis.__unresolvedLegacyCheckSaved('Unresolved legacy reopened')"
    Then I collect JSON artifact "unresolved-legacy-post-reopen-ui" from webview expression "(async () => { const chart = await window.__e2e.workbench.assertMigratedResultChart('query_legacy_migration', 'chart_legacy_migration', 3); const blocked = window.__unresolvedLegacyBlockedAfterReopen; if (blocked.some(type => /executeQuery|executeSqlQuery|Auth|Account|PowerBI|Fabric|testKustoConnection/.test(type))) throw new Error('Unexpected reopened query/auth/Fabric request was blocked: ' + JSON.stringify(blocked)); return { chart, blockedServiceRequests: blocked, externalQueryAuthFabricRequests: 0 }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "02-unresolved-legacy-reopened"

    Then I collect JSON artifact "unresolved-legacy-close" from extension host expression "(async () => { const uri = globalThis.__unresolvedLegacyUri; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri?.toString()); if (!document || document.isDirty) throw new Error('Post-reopen real Save must leave the task-owned document clean'); const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri.toString()); if (tabs.length !== 1 || !await vscode.window.tabGroups.close(tabs, true)) throw new Error('Could not close the exact task-owned unresolved legacy tab'); const remaining = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => tab.input?.uri?.toString()).filter(Boolean); if (remaining.includes(uri.toString()) || globalThis.__unresolvedLegacyOriginalTabs.some(original => !remaining.includes(original))) throw new Error('Exact tab cleanup changed an unrelated tab or retained the fixture'); return { dirty: false, closedTabs: tabs.length, originalTabsRetained: true }; })()"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
    Then I collect JSON artifact "unresolved-legacy-cleanup" from extension host expression "(async () => { const uri = globalThis.__unresolvedLegacyUri; if (uri) await vscode.workspace.fs.delete(uri, { useTrash: false }); delete globalThis.__unresolvedLegacyUri; delete globalThis.__unresolvedLegacyResultJson; delete globalThis.__unresolvedLegacyResultArtifact; delete globalThis.__unresolvedLegacyCheckSaved; delete globalThis.__unresolvedLegacyOriginalTabs; return { deletedOnlyTaskFixture: true }; })()"
