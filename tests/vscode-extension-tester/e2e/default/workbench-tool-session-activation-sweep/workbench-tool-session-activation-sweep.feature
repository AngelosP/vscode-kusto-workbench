# ORIGINAL109 ACCEPTANCE BEGIN
#| Feature: Immutable original109 installed-build acceptance
#|
#|   Scenario: Cold controls and exact archive order precede separate native authoring
#|     Given I collect JSON artifact "original109-isolation" from extension host expression:
#|       """
#|       (async () => {
#|         const fs = process.getBuiltinModule('node:fs');
#|         const crypto = process.getBuiltinModule('node:crypto');
#|         const url = process.getBuiltinModule('node:url');
#|         if (!process.env.KW_PUBLISHED_REPLAY_CONFIG) throw new Error('Use the explicit original109 acceptance runner');
#|         const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8'));
#|         if (config.acceptance !== 'original109') throw new Error('Original109 acceptance is not opted in');
#|         if (crypto.createHash('sha256').update(fs.readFileSync(config.acceptanceHarnessPath)).digest('hex') !== config.acceptanceHarnessSha256) throw new Error('Acceptance harness copy changed');
#|         const helper = await import(url.pathToFileURL(config.acceptanceHarnessPath).href);
#|         globalThis.__original109Acceptance = await helper.createAcceptanceSession(vscode, config);
#|         return globalThis.__original109Acceptance.openCold();
#|       })()
#|       """
#|     When I move the Dev Host to 0, 0
#|     When I resize the Dev Host to 1280x1000
#|     When I execute command "workbench.action.closeSidebar"
#|     When I execute command "workbench.action.closeAuxiliaryBar"
#|     When I execute command "workbench.action.closePanel"
#|     When I wait for "#section_b304ae6d-218f-4880-8d14-6233c7ba4156 .monaco-editor" in the webview for 30 seconds
#|     Then I collect JSON artifact "original109-controls-cold-controls" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('cold-controls', 'section_b304ae6d-218f-4880-8d14-6233c7ba4156', '', 'closed')
#|       """
#|     Then I collect JSON artifact "original109-cold-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('cold-controls')"
#|     Then I collect JSON artifact "original109-real-native-toggle-input" from extension host expression "globalThis.__original109Acceptance.clickColdToggle()"
#|     Then I collect JSON artifact "original109-controls-cold-menu" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('cold-menu', 'section_b304ae6d-218f-4880-8d14-6233c7ba4156', '', 'open')
#|       """
#|     Then I collect JSON artifact "original109-menu-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('cold-menu')"
#|     When I press "Escape"
#|     Then I collect JSON artifact "original109-cold-escape" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('cold-escape', 'section_b304ae6d-218f-4880-8d14-6233c7ba4156', '', 'dismissed')
#|       """
#|     Then I collect JSON artifact "original109-escape-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('cold-escape')"
#|     Then I collect JSON artifact "original109-cold-byte-oracle" from extension host expression "globalThis.__original109Acceptance.acceptEscape()"
#|     Then I collect JSON artifact "original109-hidden" from extension host expression "globalThis.__original109Acceptance.hideCold()"
#|     Then I wait 2 seconds
#|     Then I collect JSON artifact "original109-hidden-byte-oracle" from extension host expression "globalThis.__original109Acceptance.checkpoint('hidden')"
#|     Then I collect JSON artifact "original109-revealed" from extension host expression "globalThis.__original109Acceptance.revealCold()"
#|     Then I collect JSON artifact "original109-first-41" from extension host expression "globalThis.__original109Acceptance.activateRange(0, 41)"
#|     Then I collect JSON artifact "original109-through-83" from extension host expression "globalThis.__original109Acceptance.activateRange(41, 83)"
#|     When I wait for "kw-query-section .monaco-editor" in the webview "azure-mcp-growth-analysis.kqlx" for 30 seconds
#|     Then I collect JSON artifact "original109-controls-historical-83" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('historical-83', null)
#|       """
#|     Then I collect JSON artifact "original109-target83-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('historical-83')"
#|     Then I collect JSON artifact "original109-through-88" from extension host expression "globalThis.__original109Acceptance.activateRange(83, 88)"
#|     When I wait for "kw-query-section .monaco-editor" in the webview "azure-mcp-vs-tool-calls-investigation.kqlx" for 30 seconds
#|     Then I collect JSON artifact "original109-controls-historical-88" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('historical-88', null)
#|       """
#|     Then I collect JSON artifact "original109-target88-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('historical-88')"
#|     Then I collect JSON artifact "original109-through-109" from extension host expression "globalThis.__original109Acceptance.activateRange(88, 109)"
#|     When I wait for "kw-query-section .monaco-editor" in the webview "historical_success_rate copy.kql" for 30 seconds
#|     Then I collect JSON artifact "original109-controls-historical-109" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('historical-109', null)
#|       """
#|     Then I collect JSON artifact "original109-target109-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('historical-109')"
#|     Then I wait 2 seconds
#|     Then I collect JSON artifact "original109-full-byte-oracle" from extension host expression "globalThis.__original109Acceptance.checkpoint('full109')"
#|     Then I collect JSON artifact "original109-reveal-after-stress" from extension host expression "globalThis.__original109Acceptance.revealCold()"
#|     Then I collect JSON artifact "original109-clean-close-with-histories-retained" from extension host expression "globalThis.__original109Acceptance.closeCold()"
#|     Then I collect JSON artifact "original109-clean-reopen-with-histories-retained" from extension host expression "globalThis.__original109Acceptance.reopenCold()"
#|     When I wait for "#section_b304ae6d-218f-4880-8d14-6233c7ba4156 .monaco-editor" in the webview "extension-fix-validation-empty-legacy-2026-09-12.kqlx" for 30 seconds
#|     Then I collect JSON artifact "original109-controls-reopened-controls" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('reopened-controls', 'section_b304ae6d-218f-4880-8d14-6233c7ba4156', '', 'closed')
#|       """
#|     Then I collect JSON artifact "original109-reopened-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('reopened-controls')"
#|     Then I collect JSON artifact "original109-reopened-byte-oracle" from extension host expression "globalThis.__original109Acceptance.checkpoint('reopened')"
#|     Then I collect JSON artifact "original109-separate-authoring-copy" from extension host expression "globalThis.__original109Acceptance.openAuthoring()"
#|     When I wait for "#section_b304ae6d-218f-4880-8d14-6233c7ba4156 .monaco-editor" in the webview "original109-authoring.kqlx" for 30 seconds
#|     Then I collect JSON artifact "original109-native-authoring-intent" from extension host expression "globalThis.__original109Acceptance.beginAuthoring(1)"
#|     When I focus "#section_b304ae6d-218f-4880-8d14-6233c7ba4156 .monaco-editor textarea.inputarea" in the webview
#|     When I type "print AcceptanceAuthored=1"
#|     When I execute command "workbench.action.files.save"
#|     Then I collect JSON artifact "original109-first-native-save" from extension host expression "globalThis.__original109Acceptance.waitForAuthoringSave(1)"
#|     Then I collect JSON artifact "original109-authored-close-reopen" from extension host expression "globalThis.__original109Acceptance.reopenAuthoring()"
#|     When I wait for "#section_b304ae6d-218f-4880-8d14-6233c7ba4156 .monaco-editor" in the webview "original109-authoring.kqlx" for 30 seconds
#|     Then I collect JSON artifact "original109-restored-authored-query" from webview expression "(() => { const query = window.queryEditors?.['section_b304ae6d-218f-4880-8d14-6233c7ba4156']?.getValue(); if (query !== 'print AcceptanceAuthored=1') throw new Error('Authored native Save was not restored'); return { query }; })()"
#|     Then I collect JSON artifact "original109-second-native-authoring-intent" from extension host expression "globalThis.__original109Acceptance.beginAuthoring(2)"
#|     When I focus "#section_b304ae6d-218f-4880-8d14-6233c7ba4156 .monaco-editor textarea.inputarea" in the webview
#|     When I press "Ctrl+A"
#|     When I type "print AcceptanceAuthored=2"
#|     When I execute command "workbench.action.files.save"
#|     Then I collect JSON artifact "original109-second-native-save" from extension host expression "globalThis.__original109Acceptance.waitForAuthoringSave(2)"
#|     Then I collect JSON artifact "original109-controls-second-interaction" from webview expression:
#|       """
#|       __ORIGINAL109_CONTROL_PROBE__('second-interaction', 'section_b304ae6d-218f-4880-8d14-6233c7ba4156', 'print AcceptanceAuthored=2', 'closed')
#|       """
#|     Then I collect JSON artifact "original109-second-interaction-native-pixels" from extension host expression "globalThis.__original109Acceptance.acceptControl('second-interaction')"
#|     Then I collect JSON artifact "original109-production-ownership-gate" from extension host expression "globalThis.__original109Acceptance.productionOwnershipGate()"
#|     Then I collect JSON artifact "original109-safe-exact-cleanup-and-build-identity" from extension host expression "globalThis.__original109Acceptance.finish()"
# ORIGINAL109 ACCEPTANCE END

# CURRENT133 API ACCEPTANCE BEGIN
#| Feature: Current133 readonly API preservation
#|
#|   Scenario: Unchanged archived canary survives original109 with exact hidden and ordinary activation oracles
#|     Given I collect JSON artifact "current133-api-isolation-and-initial-oracles" from extension host expression:
#|       """
#|       (async () => {
#|         const fs = process.getBuiltinModule('node:fs');
#|         const crypto = process.getBuiltinModule('node:crypto');
#|         const url = process.getBuiltinModule('node:url');
#|         if (!process.env.KW_PUBLISHED_REPLAY_CONFIG) throw new Error('Use the explicit current133-api acceptance runner');
#|         const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8'));
#|         if (config.acceptance !== 'current133-api') throw new Error('Current133 API acceptance is not opted in');
#|         if (crypto.createHash('sha256').update(fs.readFileSync(config.acceptanceHarnessPath)).digest('hex') !== config.acceptanceHarnessSha256) throw new Error('Acceptance harness copy changed');
#|         const helper = await import(url.pathToFileURL(config.acceptanceHarnessPath).href);
#|         globalThis.__current133ApiAcceptance = await helper.createAcceptanceSession(vscode, config);
#|         return globalThis.__current133ApiAcceptance.openApi();
#|       })()
#|       """
#|     Then I collect JSON artifact "current133-api-through-20" from extension host expression "globalThis.__current133ApiAcceptance.activateRange(0, 20)"
#|     Then I collect JSON artifact "current133-api-through-41" from extension host expression "globalThis.__current133ApiAcceptance.activateRange(20, 41)"
#|     Then I collect JSON artifact "current133-api-through-62" from extension host expression "globalThis.__current133ApiAcceptance.activateRange(41, 62)"
#|     Then I collect JSON artifact "current133-api-through-83" from extension host expression "globalThis.__current133ApiAcceptance.activateRange(62, 83)"
#|     Then I collect JSON artifact "current133-api-through-88" from extension host expression "globalThis.__current133ApiAcceptance.activateRange(83, 88)"
#|     Then I collect JSON artifact "current133-api-through-109" from extension host expression "globalThis.__current133ApiAcceptance.activateRange(88, 109)"
#|     Then I collect JSON artifact "current133-api-hidden-exact-oracles" from extension host expression "globalThis.__current133ApiAcceptance.hideApi()"
#|     Then I collect JSON artifact "current133-api-sole-ordinary-activation-and-oracles" from extension host expression "globalThis.__current133ApiAcceptance.reactivateApi()"
#|     Then I collect JSON artifact "current133-api-readonly-close-and-runtime" from extension host expression "globalThis.__current133ApiAcceptance.finish()"
# CURRENT133 API ACCEPTANCE END

Feature: Workbench tool session survives broad notebook activation

  Scenario: Reactivated canary survives 110 activations with 109 historical files
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeSidebar"
    When I execute command "workbench.action.closeAuxiliaryBar"
    When I execute command "workbench.action.closePanel"
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
        const bindingIds = ['total', 'subtotal', 'summary', 'amount', 'balance', 'grandTotal'];
        const dashboardCode = '<script type="application/kw-provenance">' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'sweep_canary_fact', sectionName: 'Sweep fact' } }, bindings: Object.fromEntries(bindingIds.map(id => [id, { display: { type: 'scalar', agg: 'SUM', column: 'Amount' } }])) }) + '</script>' + bindingIds.map(id => `<span data-kw-bind="${id}">0</span>`).join('');
        globalThis.__sweepDashboardCode = dashboardCode;
        const expectedNote = { id: 'sweep-note', created: '2026-09-12T00:00:00.000Z', updated: '2026-09-12T00:00:00.000Z', category: 'usage-note', content: 'survive activation sweep', source: 'agent' };
        const factColumns = [{ name: 'RowId', type: 'long' }, { name: 'Group', type: 'string' }, { name: 'Amount', type: 'real' }, { name: 'Timestamp', type: 'datetime' }];
        const factRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z']];
        const sqlColumns = [{ name: 'RowId', type: 'int' }, { name: 'Group', type: 'nvarchar' }, { name: 'Amount', type: 'decimal' }, { name: 'Timestamp', type: 'datetime2' }, { name: 'IsActive', type: 'bit' }, { name: 'Note', type: 'nvarchar' }];
        const sqlRows = factRows.map((row, index) => [...row, index !== 1, `saved ${index + 1}`]);
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!extension) throw new Error('The extension under test is unavailable');
        await extension.activate();
        const sqlConnection = await vscode.commands.executeCommand('kustoWorkbench.test.seedCod2SqlConnection');
        if (!sqlConnection?.id || !sqlConnection.serverUrl) throw new Error('Independent offline SQL owner did not prepare');
        let kustoConnection = await vscode.commands.executeCommand('kustoWorkbench.test.seedCopilotClarificationConnection');
        if (!kustoConnection?.id || !kustoConnection.database) throw new Error('Independent offline Kusto owner did not prepare');
        const fixturePreparationAttempts = [];
        globalThis.__sweepFixturePreparationAttempts = fixturePreparationAttempts;
        const legacySection = { id: 'section_b304ae6d-218f-4880-8d14-6233c7ba4156', type: 'query', name: '', clusterUrl: '', database: '', query: '', expanded: true, resultsVisible: true, runMode: 'take100', cacheEnabled: true, cacheValue: 1, cacheUnit: 'days', favoritesMode: true };
        const uris = [];
        const viewTypes = { kqlx: 'kusto.kqlxEditor', sqlx: 'kusto.kqlxEditor', mdx: 'kusto.kqlxEditor', kql: 'kusto.kqlCompatEditor', sql: 'kusto.sqlCompatEditor', md: 'kusto.mdCompatEditor' };
        const sourceBytes = new Map();
        const kindCounts = {};
        for (let index = 0; index < 110; index++) {
          const kind = index >= 105 ? 'kqlx' : index >= 97 ? (index % 2 === 1 ? 'kql' : 'sql')
            : index <= 42 || index === 87 || index === 89 ? 'kqlx'
              : index <= 68 || index === 88 || index === 90 ? 'sqlx'
                : index <= 86 ? 'mdx' : index <= 92 ? 'kql' : index <= 94 ? 'sql' : 'md';
          kindCounts[kind] = (kindCounts[kind] || 0) + 1;
          const uri = vscode.Uri.joinPath(root, `activation-sweep-${String(index).padStart(2, '0')}.${kind}`);
          const sections = index === 0
            ? [
                { id: 'sweep_canary_fact', type: 'query', name: 'Sweep fact', expanded: true, resultsVisible: true, runMode: 'take100', cacheEnabled: true, cacheValue: 1, cacheUnit: 'days', query: "datatable(RowId:long, Group:string, Amount:real, Timestamp:datetime)[1, 'alpha', 10.5, datetime(2026-09-12T00:00:00Z), 2, 'beta', 21.0, datetime(2026-09-13T00:00:00Z), 3, 'gamma', 31.5, datetime(2026-09-14T00:00:00Z)]", resultJson: JSON.stringify({ columns: factColumns, rows: factRows, metadata: { executionTime: '00:00:00.010' } }) },
                { id: 'sweep_canary_query', type: 'query', name: 'Sweep canary', expanded: true, resultsVisible: true, clusterUrl: '', database: '', runMode: 'take100', cacheEnabled: true, cacheValue: 1, cacheUnit: 'days', query: 'print SweepBefore=1' },
                { id: 'sweep_canary_markdown', type: 'markdown', title: 'Sweep notes', expanded: true, text: 'before sweep' },
                { id: 'sweep_canary_dashboard', type: 'html', name: 'Sweep dashboard', code: dashboardCode, mode: 'preview', expanded: true, previewHeightPx: 160, dataSourceIds: ['sweep_canary_fact'] },
                { id: 'sweep_canary_notes', type: 'devnotes', entries: [expectedNote] },
                { id: 'sweep_canary_sql', type: 'sql', name: 'Sweep saved SQL', dialect: 'mssql', serverUrl: sqlConnection.serverUrl, database: sqlConnection.database || 'Db', connectionIdHint: sqlConnection.id, query: "SELECT 1 AS RowId, 'alpha' AS [Group], CAST(10.5 AS decimal(10,1)) AS Amount, CAST('2026-09-12T00:00:00' AS datetime2) AS [Timestamp], CAST(1 AS bit) AS IsActive, 'saved 1' AS Note UNION ALL SELECT 2, 'beta', 21.0, '2026-09-13T00:00:00', 0, 'saved 2' UNION ALL SELECT 3, 'gamma', 31.5, '2026-09-14T00:00:00', 1, 'saved 3'", expanded: true, resultsVisible: true, resultJson: JSON.stringify({ columns: sqlColumns, rows: sqlRows, metadata: { executionTime: '00:00:00.010' } }) },
                { id: 'sweep_canary_chart', type: 'chart', name: 'Sweep chart', expanded: false, dataSourceId: 'sweep_canary_fact', chartType: 'bar', xColumn: 'Group', yColumns: ['Amount'] },
                { id: 'sweep_canary_transformation', type: 'transformation', name: 'Sweep transformation', expanded: false, dataSourceId: 'sweep_canary_fact', transformationType: 'derive', deriveColumns: [{ name: 'DoubleAmount', expression: 'Amount * 2' }] },
                { id: 'sweep_canary_url', type: 'url', name: 'Sweep URL', expanded: false, url: '' },
                { id: 'sweep_canary_python', type: 'python', name: 'Sweep Python', expanded: false, code: 'print("Sweep Python")', output: '' }
              ]
            : index === 108 ? [legacySection]
              : index === 87 || index === 88 ? []
              : kind === 'sqlx' ? [{ id: `sweep_sql_${index}`, type: 'sql', expanded: true, query: `SELECT ${index} AS SweepFile` }]
                : kind === 'mdx' ? [{ id: `sweep_markdown_${index}`, type: 'markdown', title: `Sweep ${index}`, text: `* First ${index}${String.fromCharCode(10)}* Second ${index}${String.fromCharCode(10)}`, expanded: true }]
                  : index === 40 ? [{ type: 'query', expanded: true, query: `print SweepFile=${index}` }]
                    : index >= 1 && index <= 12 ? [
                        { id: `sweep_query_${index}`, type: 'query', expanded: true, query: `print SweepFile=${index}`, ...(index === 1 ? { favoritesMode: true } : {}), ...(index === 3 ? { copilotChatVisible: true, copilotChatWidthPx: 360 } : {}) },
                        { id: `sweep_markdown_${index}`, type: 'markdown', title: `Sweep notes ${index}`, text: `* First ${index}${String.fromCharCode(10)}* Second ${index}${String.fromCharCode(10)}`, expanded: true }
                      ] : [{ id: `sweep_query_${index}`, type: 'query', expanded: true, query: `print SweepFile=${index}` }];
          const source = index === 108 ? JSON.stringify({ kind, version: 1, state: { sections } }, null, 2).split(String.fromCharCode(10)).join(String.fromCharCode(13, 10)) + String.fromCharCode(13, 10)
            : index === 89 || index === 90 ? ''
              : kind === 'kql' ? `print SweepFile=${index}`
                : kind === 'sql' ? `SELECT ${index} AS SweepFile`
                  : kind === 'md' ? ['# Sweep notebook', '', '```kql', `print SweepFile=${index}`, '```'].join(String.fromCharCode(10))
                    : JSON.stringify({ kind, version: 1, state: { sections } }, null, 2);
          const bytes = new TextEncoder().encode(source);
          if (index === 0) {
            const template = vscode.Uri.joinPath(root, 'canary-template.kqlx');
            await vscode.workspace.fs.writeFile(template, bytes);
            let prepared;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                prepared = await vscode.commands.executeCommand('kustoWorkbench.test.preparePersistedResultFixture', { engine: 'kusto', existingConnectionId: kustoConnection.id, templatePath: template.fsPath, outputPath: uri.fsPath });
                fixturePreparationAttempts.push({ attempt: attempt + 1, success: true });
                break;
              } catch (error) {
                const message = String(error?.message || error);
                fixturePreparationAttempts.push({ attempt: attempt + 1, success: false, error: message });
                if (message !== 'Existing persisted-result Kusto owner is unresolved.' || attempt === 2) throw error;
                kustoConnection = await vscode.commands.executeCommand('kustoWorkbench.test.seedCopilotClarificationConnection');
              }
            }
            if (prepared?.outputPath !== uri.fsPath || !prepared.connectionId) throw new Error(`Offline dashboard fact fixture did not prepare: ${JSON.stringify(prepared)}`);
            await vscode.workspace.fs.delete(template, { useTrash: false });
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
            globalThis.__sweepExpectedSectionIds = seededFile.state.sections.map(section => section.id);
          } else {
            await vscode.workspace.fs.writeFile(uri, bytes);
          }
          sourceBytes.set(uri.toString(), Buffer.from(await vscode.workspace.fs.readFile(uri)));
          if (index === 91 || index === 93 || index >= 97 && index <= 104) {
            const sidecarUri = vscode.Uri.file(uri.fsPath + '.json');
            const sidecar = { kind: kind === 'kql' ? 'kqlx' : 'sqlx', version: 1, state: { sections: [{ id: `sweep_companion_${index}`, type: kind === 'kql' ? 'query' : 'sql', linkedQueryPath: path.basename(uri.fsPath), expanded: true, ...(index === 91 ? { copilotChatVisible: true, copilotChatWidthPx: 360 } : {}) }] } };
            await vscode.workspace.fs.writeFile(sidecarUri, Buffer.from(JSON.stringify(sidecar, null, 2), 'utf8'));
            sourceBytes.set(sidecarUri.toString(), Buffer.from(await vscode.workspace.fs.readFile(sidecarUri)));
          }
          uris.push(uri);
        }
        if (JSON.stringify(kindCounts) !== JSON.stringify({ kqlx: 50, sqlx: 28, mdx: 18, kql: 6, sql: 6, md: 2 }) || uris.length !== 110 || sourceBytes.size !== 120 || globalThis.__sweepExpectedSectionIds.length !== 10) throw new Error(`Invalid mixed fixture composition: ${JSON.stringify(kindCounts)}`);
        const verifySourceBytes = async phase => {
          const modified = [];
          let canaryDelta = null;
          const expectedHistoricalHash = crypto.createHash('sha256');
          const actualHistoricalHash = crypto.createHash('sha256');
          let canaryActualHash = '';
          for (const [uriString, expected] of sourceBytes) {
            const actual = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(uriString)));
            const expectedHash = crypto.createHash('sha256').update(expected).digest('hex');
            const actualHash = crypto.createHash('sha256').update(actual).digest('hex');
            if (!actual.equals(expected)) modified.push({ uri: uriString, expectedHash, actualHash });
            if (uriString === uris[0].toString() && !actual.equals(expected)) {
              const before = JSON.parse(expected.toString('utf8'));
              const after = JSON.parse(actual.toString('utf8'));
              const afterSections = new Map(after.state.sections.map(section => [section.id, section]));
              canaryDelta = before.state.sections.map(section => {
                const current = afterSections.get(section.id) || {};
                return { id: section.id, fields: Array.from(new Set([...Object.keys(section), ...Object.keys(current)]))
                  .filter(key => !util.isDeepStrictEqual(section[key], current[key]))
                  .map(key => ({ key, before: section[key] ?? null, after: current[key] ?? null })) };
              }).filter(section => section.fields.length > 0);
            }
            if (uriString === uris[0].toString()) canaryActualHash = actualHash;
            else {
              expectedHistoricalHash.update(uriString).update(expected);
              actualHistoricalHash.update(uriString).update(actual);
            }
          }
          return { phase, fileCount: uris.length, sourceCount: sourceBytes.size, historicalFileCount: uris.length - 1, historicalSourceCount: sourceBytes.size - 1, companionCount: sourceBytes.size - uris.length, historicalStable: !modified.some(file => file.uri !== uris[0].toString()), canaryStable: !modified.some(file => file.uri === uris[0].toString()), historicalExpectedHash: expectedHistoricalHash.digest('hex'), historicalActualHash: actualHistoricalHash.digest('hex'), canaryExpectedHash: crypto.createHash('sha256').update(sourceBytes.get(uris[0].toString())).digest('hex'), canaryActualHash, exactBytes: modified.length === 0, modified, canaryDelta };
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
            if (canary?.isLiveWorkbench && canary.sectionsUnavailable !== true && util.isDeepStrictEqual(canary.sections?.map(section => section.id), globalThis.__sweepExpectedSectionIds)) return { listed, canary };
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
        const waitForNotes = async (phase, openFileId = initial.canary.openFileId) => {
          const deadline = Date.now() + 30000;
          let last;
          while (Date.now() < deadline) {
            last = await invoke('kusto-workbench_manage-development-notes', {
              action: 'view', openFileId, targetFileUri: uris[0].toString()
            });
            if (last.success === true && util.isDeepStrictEqual(last.notes, [expectedNote])) return last;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(`Canary notes unavailable ${phase}: ${JSON.stringify(last)}`);
        };
        const waitForDashboard = async (phase, openFileId = initial.canary.openFileId) => {
          const deadline = Date.now() + 30000;
          let last;
          while (Date.now() < deadline) {
            last = await invoke('kusto-workbench_validate-html-dashboard', {
              openFileId, targetFileUri: uris[0].toString(), sectionId: 'sweep_canary_dashboard'
            });
            if (last.success === true && last.valid === true && last.hasProvenance === true && last.bindingCount === bindingIds.length && last.dataSourceCount === 1 && last.issues?.length === 0 && last.diagnostics?.length === 0 && util.isDeepStrictEqual(last.factColumns?.map(column => column.name), factColumns.map(column => column.name)) && String(last.filePath || '').toLowerCase() === uris[0].fsPath.toLowerCase()) return last;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          throw new Error(`Canary dashboard fixture invalid ${phase}: ${JSON.stringify(last)}`);
        };
        const initialNotes = await waitForNotes('before sweep');
        const initialDashboard = await waitForDashboard('before sweep');
        if (activeUri() !== uris[0].toString()) throw new Error('Refusing to save a non-canary setup target');
        await vscode.commands.executeCommand('workbench.action.files.save');
        const firstSavedBytes = Buffer.from(await vscode.workspace.fs.readFile(uris[0]));
        const firstSavedText = new TextDecoder().decode(firstSavedBytes);
        const setupDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uris[0].toString());
        let setupSaveCount = 1;
        if (setupDocument?.isDirty || setupDocument?.getText() !== firstSavedText) {
          const firstSaved = JSON.parse(firstSavedText);
          const current = JSON.parse(setupDocument.getText());
          const firstSql = firstSaved.state.sections.find(section => section.id === 'sweep_canary_sql');
          const currentSql = current.state.sections.find(section => section.id === 'sweep_canary_sql');
          const expected = JSON.parse(firstSavedText);
          delete expected.state.sections.find(section => section.id === 'sweep_canary_sql').resultArtifact;
          if (!firstSql?.resultArtifact || firstSql.resultArtifact.producer || firstSql.resultArtifact.policy
            || currentSql?.resultArtifact || !util.isDeepStrictEqual(current, expected)) throw new Error('Setup changed beyond the unowned generated SQL descriptor');
          await vscode.commands.executeCommand('workbench.action.files.save');
          setupSaveCount++;
        }
        globalThis.__sweepInitialCanaryBytes = Buffer.from(await vscode.workspace.fs.readFile(uris[0]));
        const savedCanary = JSON.parse(new TextDecoder().decode(globalThis.__sweepInitialCanaryBytes));
        if (!util.isDeepStrictEqual(savedCanary.state.sections.map(section => section.id), globalThis.__sweepExpectedSectionIds)
          || !util.isDeepStrictEqual(savedCanary.state.sections.find(section => section.type === 'devnotes')?.entries, [expectedNote])
          || savedCanary.state.sections.find(section => section.id === 'sweep_canary_dashboard')?.code !== dashboardCode
          || !util.isDeepStrictEqual(JSON.parse(savedCanary.state.sections[0].resultJson).rows, factRows)
          || !util.isDeepStrictEqual(JSON.parse(savedCanary.state.sections.find(section => section.id === 'sweep_canary_sql').resultJson).rows, sqlRows)) throw new Error('Native setup Save lost authored canary content');
        sourceBytes.set(uris[0].toString(), globalThis.__sweepInitialCanaryBytes);
        const baselineDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uris[0].toString());
        const baselineText = new TextDecoder().decode(globalThis.__sweepInitialCanaryBytes);
        if (!baselineDocument || baselineDocument.isDirty || baselineDocument.getText() !== baselineText) {
          const actualText = baselineDocument?.getText() || '';
          const expectedSections = JSON.parse(baselineText).state.sections;
          const actualSections = actualText ? JSON.parse(actualText).state.sections : [];
          const differences = expectedSections.map((section, index) => {
            const current = actualSections[index] || {};
            return { id: section.id, fields: Array.from(new Set([...Object.keys(section), ...Object.keys(current)]))
              .filter(key => !util.isDeepStrictEqual(section[key], current[key]))
              .map(key => ({ key, before: section[key] ?? null, after: current[key] ?? null })) };
          }).filter(section => section.fields.length > 0);
          throw new Error(`Canary fixture changed before sweep: ${JSON.stringify({ dirty: baselineDocument?.isDirty ?? null, expectedHash: crypto.createHash('sha256').update(baselineText).digest('hex'), memoryHash: crypto.createHash('sha256').update(actualText).digest('hex'), differences })}`);
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
        const assertSourceBytes = async (phase, saved = false) => {
          const result = await verifySourceBytes(phase);
          const expectedCanaryHash = crypto.createHash('sha256').update(saved ? globalThis.__sweepState.savedText : globalThis.__sweepInitialCanaryBytes).digest('hex');
          if (!result.historicalStable || result.canaryActualHash !== expectedCanaryHash || saved && (result.canaryStable || result.modified.length !== 1 || result.modified[0].uri !== uris[0].toString()) || !saved && !result.exactBytes) throw new Error(`Source bytes changed ${phase}: ${JSON.stringify({ saved, expectedCanaryHash, canaryUri: uris[0].toString(), savedTextLength: globalThis.__sweepState.savedText?.length ?? null, result })}`);
          return { ...result, authoredCanaryMutationExpected: saved, canaryMatchesExpected: true, expectedCanaryHash };
        };
        const summarizeNotes = result => ({ success: result.success === true, count: result.notes?.length || 0, notes: result.notes || [], error: result.error || '' });
        const summarizeDashboard = result => ({ success: result.success === true, valid: result.valid === true, hasProvenance: result.hasProvenance === true, bindingCount: result.bindingCount || 0, dataSourceCount: result.dataSourceCount || 0, factColumns: result.factColumns || [], issues: result.issues || [], diagnostics: result.diagnostics || [], filePath: result.filePath || '', error: result.error || '' });
        const summarizeApi = (canary, notes, dashboard) => ({ isLiveWorkbench: canary?.isLiveWorkbench === true, sectionsUnavailable: canary?.sectionsUnavailable === true || !canary, openFileId: canary?.openFileId || '', uri: canary?.uri || '', sectionIds: canary?.sections?.map(section => section.id || '') || [], notes: summarizeNotes(notes), dashboard: summarizeDashboard(dashboard) });
        const passes = (api, openFileId = initial.canary.openFileId) => api.isLiveWorkbench && !api.sectionsUnavailable && api.openFileId === openFileId && api.uri === uris[0].toString() && util.isDeepStrictEqual(api.sectionIds, globalThis.__sweepExpectedSectionIds) && api.notes.success && util.isDeepStrictEqual(api.notes.notes, [expectedNote]) && api.dashboard.success && api.dashboard.valid && api.dashboard.hasProvenance && api.dashboard.bindingCount === bindingIds.length && api.dashboard.dataSourceCount === 1 && api.dashboard.issues.length === 0 && api.dashboard.diagnostics.length === 0 && util.isDeepStrictEqual(api.dashboard.factColumns.map(column => column.name), factColumns.map(column => column.name)) && api.dashboard.filePath.toLowerCase() === uris[0].fsPath.toLowerCase();
        const readCanaryApis = async phase => {
          const { canary } = await waitForCanary();
          const notes = await waitForNotes(phase, canary.openFileId);
          const dashboard = await waitForDashboard(phase, canary.openFileId);
          const api = summarizeApi(canary, notes, dashboard);
          if (!canary.openFileId || !passes(api, canary.openFileId) || activeUri() !== uris[0].toString()) throw new Error(`Canary APIs or active URI failed ${phase}: ${JSON.stringify(api)}`);
          globalThis.__sweepCanaryOpenFileId = canary.openFileId;
          return api;
        };
        const assertHistoricalTabs = (phase, includeCanary = true) => {
          const expectedHistoricalUris = uris.slice(1).map(uri => uri.toString()).sort();
          const expectedUris = new Set(uris.map(uri => uri.toString()));
          const own = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => expectedUris.has(tab.input?.uri?.toString()));
          const historical = own.filter(tab => tab.input.uri.toString() !== uris[0].toString());
          const actualHistoricalUris = historical.map(tab => tab.input.uri.toString()).sort();
          const dirtyUris = own.filter(tab => tab.isDirty).map(tab => tab.input.uri.toString());
          if (own.length !== uris.length - (includeCanary ? 0 : 1) || !util.isDeepStrictEqual(actualHistoricalUris, expectedHistoricalUris) || dirtyUris.length > 0) throw new Error(`Historical tabs changed ${phase}: ${JSON.stringify({ ownCount: own.length, expectedHistoricalUris, actualHistoricalUris, dirtyUris })}`);
          return { phase, ownCount: own.length, historicalFileCount: historical.length, historicalUris: actualHistoricalUris, dirtyUris, activeUri: activeUri() };
        };
        const closeCleanCanary = async (phase, retainHistoricals, saved = false) => {
          const parent = path.resolve(process.env.TEMP || process.cwd());
          if (path.dirname(path.resolve(root.fsPath)).toLowerCase() !== parent.toLowerCase() || !path.basename(root.fsPath).startsWith('kw-tool-session-activation-sweep-')) throw new Error('Canary root is not task-owned');
          const beforeSource = await assertSourceBytes(`before ${phase}`, saved);
          const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.toString() === uris[0].toString());
          if (!tab || tab.isDirty) throw new Error(`Refusing to close missing or dirty canary ${phase}: ${JSON.stringify(beforeSource)}`);
          const beforeTabs = retainHistoricals ? assertHistoricalTabs(`before ${phase}`) : null;
          let result = { success: false };
          let closeError = '';
          try { result = await invoke('kusto-workbench_close-workbench-file', { targetFileUri: uris[0].toString() }); }
          catch (error) { closeError = String(error); }
          const afterSource = await assertSourceBytes(`after ${phase}`, saved);
          const remaining = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(candidate => candidate.input?.uri?.toString() === uris[0].toString());
          const afterTabs = retainHistoricals ? assertHistoricalTabs(`after ${phase}`, false) : null;
          const historicalTabsUnchanged = retainHistoricals ? util.isDeepStrictEqual(beforeTabs.historicalUris, afterTabs.historicalUris) : true;
          if (result.success !== true || closeError || remaining.length > 0 || !historicalTabsUnchanged) throw new Error(`Exact clean URI close failed ${phase}: ${JSON.stringify({ result, closeError, remaining: remaining.length, beforeSource, afterSource, beforeTabs, afterTabs })}`);
          return { closed: true, targetFileUri: uris[0].toString(), closedCount: 1, historicalTabsUnchanged, beforeSource, afterSource, beforeTabs, afterTabs };
        };
        const initialSource = await assertSourceBytes('baseline before 109 historical activations');
        globalThis.__sweepState = {
          savedText: null,
          setupSaveCount,
          uris, viewTypes, path, util, kindCounts, initial, expectedNote, bindingIds, factColumns, factRows, sqlColumns, sqlRows, legacySection,
          expectedSectionIds: globalThis.__sweepExpectedSectionIds,
          queryMarker: 'print SweepRecovered=109', initialSource,
          initialNotes, initialDashboard, activeUri, activatedFileCount,
          verifySourceBytes, inspectCanarySource, invoke, waitForCanary, waitForNotes, waitForDashboard,
          assertSourceBytes, summarizeApi, passes, readCanaryApis, assertHistoricalTabs, closeCleanCanary,
        };
        return { createdFileCount: uris.length, historicalFileCount: uris.length - 1, historicalSourceCount: sourceBytes.size - 1, companionCount: sourceBytes.size - uris.length, kindCounts, canaryOpenFileId: initial.canary.openFileId, sectionIds: globalThis.__sweepExpectedSectionIds, baselineNotes: initialNotes.notes, initialDashboard: summarizeDashboard(initialDashboard), initialSource };
        };
        return { createdFileCount: uris.length, companionCount: sourceBytes.size - uris.length, canaryOpenFileId: initial.canary.openFileId };
      })()
      """
    When I evaluate "window.__e2e.workbench.waitForPersistedResult('sweep_canary_fact', 19000)" in the webview "activation-sweep-00.kqlx" for 25 seconds
    When I wait for "#sweep_canary_sql kw-data-table" in the webview for 20 seconds
    When I scroll "#sweep_canary_fact kw-data-table" into view
    Then I collect JSON artifact "canary-fact-baseline" from webview expression:
      """
      (() => {
        const table = document.getElementById('sweep_canary_fact')?.querySelector('kw-data-table');
        const columns = table?.columns || [];
        const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell));
        const expectedColumns = [{ name: 'RowId', type: 'long' }, { name: 'Group', type: 'string' }, { name: 'Amount', type: 'real' }, { name: 'Timestamp', type: 'datetime' }];
        const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z']];
        const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []);
        const visible = rendered.length === expectedRows.length && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; });
        if (JSON.stringify(columns.map(column => ({ name: column.name, type: column.type }))) !== JSON.stringify(expectedColumns) || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('Canary fact schema, values, or visible rows failed: ' + JSON.stringify({ columns, rows, rendered: rendered.length, visible }));
        return { columns: expectedColumns, rows, renderedRows: rendered.length, visible, liveQueryRunTested: false };
      })()
      """
    When I scroll "#sweep_canary_sql kw-data-table" into view
    Then I collect JSON artifact "canary-sql-baseline" from webview expression:
      """
      (() => {
        const table = document.getElementById('sweep_canary_sql')?.querySelector('kw-data-table');
        const columns = table?.columns || [];
        const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell));
        const expectedColumns = [{ name: 'RowId', type: 'int' }, { name: 'Group', type: 'nvarchar' }, { name: 'Amount', type: 'decimal' }, { name: 'Timestamp', type: 'datetime2' }, { name: 'IsActive', type: 'bit' }, { name: 'Note', type: 'nvarchar' }];
        const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z', true, 'saved 1'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z', false, 'saved 2'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z', true, 'saved 3']];
        const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []);
        const visible = rendered.length === expectedRows.length && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; });
        if (JSON.stringify(columns.map(column => ({ name: column.name, type: column.type }))) !== JSON.stringify(expectedColumns) || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('Canary SQL schema, values, or visible rows failed: ' + JSON.stringify({ columns, rows, rendered: rendered.length, visible }));
        return { columns: expectedColumns, rows, renderedRows: rendered.length, visible, savedLegacyDisplayOnly: true, liveQueryRunTested: false };
      })()
      """
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
        if (state.activatedFileCount !== state.uris.length) throw new Error(`Mixed sweep missed an activation: ${state.activatedFileCount}`);
        state.sourceAfterSweep = await state.assertSourceBytes('after 110 initial activations');
        state.hiddenSource = await state.inspectCanarySource('hidden-after-sweep');
        return { activatedFileCount: state.activatedFileCount, historicalFileCount: state.uris.length - 1, tabs: state.assertHistoricalTabs('after initial sweep'), sourceAfterSweep: state.sourceAfterSweep, hiddenSource: state.hiddenSource };
      })()
      """
    Then I collect JSON artifact "activate-legacy-gray-control" from extension host expression "(async () => { const state = globalThis.__sweepState; const beforeSource = await state.assertSourceBytes('before legacy control activation'); const uri = state.uris[108]; await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); if (state.activeUri() !== uri.toString()) throw new Error('Legacy control fixture was not exactly active'); const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString()); const section = document ? JSON.parse(document.getText()).state.sections[0] : null; if (!document || document.isDirty || !state.util.isDeepStrictEqual(section, state.legacySection)) throw new Error('Legacy blank Favorites fixture changed: ' + JSON.stringify(section)); return { uri: uri.toString(), legacySection: section, beforeSource, tabs: state.assertHistoricalTabs('legacy control active') }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #section_b304ae6d-218f-4880-8d14-6233c7ba4156_run_toggle" in the webview "activation-sweep-108.kqlx" for 30 seconds
    When I scroll "#section_b304ae6d-218f-4880-8d14-6233c7ba4156_run_toggle" into view
    Then I collect JSON artifact "legacy-gray-run-controls" from webview expression:
      """
      (() => {
        const id = 'section_b304ae6d-218f-4880-8d14-6233c7ba4156';
        const section = document.getElementById(id);
        const editor = window.queryEditors?.[id];
        const main = document.getElementById(id + '_run_btn');
        const toggle = document.getElementById(id + '_run_toggle');
        const toolbar = section?.querySelector('kw-query-toolbar');
        const style = toggle ? getComputedStyle(toggle) : null;
        const bounds = toggle?.getBoundingClientRect();
        const expectedRunDisabled = section?.executionCtrl?.isRunSelectionReady?.() !== true;
        if (!section || !editor || editor.getValue() !== '' || !toolbar || !main || main.disabled !== expectedRunDisabled || !toggle || toggle.disabled || !bounds || bounds.width <= 0 || bounds.height <= 0 || bounds.top < 0 || bounds.bottom > innerHeight || style.display === 'none' || style.visibility !== 'visible' || style.pointerEvents === 'none' || Number(style.opacity) <= 0) throw new Error('Blank legacy Run controls do not match selection readiness or are not operable');
        return { sectionId: id, blankQuery: true, mainRunDisabled: main.disabled, expectedRunDisabled, toggleDisabled: toggle.disabled, accessibleName: toggle.getAttribute('aria-label') || '', bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }, style: { display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents, opacity: style.opacity, color: style.color, backgroundColor: style.backgroundColor } };
      })()
      """
    When I click "#section_b304ae6d-218f-4880-8d14-6233c7ba4156_run_toggle" in the webview "activation-sweep-108.kqlx"
    Then I collect JSON artifact "legacy-run-menu-visible" from webview expression "(() => { const id = 'section_b304ae6d-218f-4880-8d14-6233c7ba4156'; const menu = document.getElementById(id + '_run_menu'); const style = menu ? getComputedStyle(menu) : null; const bounds = menu?.getBoundingClientRect(); const labels = Array.from(menu?.querySelectorAll('[role=menuitem]') || []).filter(item => getComputedStyle(item).display !== 'none').map(item => (item.textContent || '').trim()); if (!menu || style.display === 'none' || style.visibility !== 'visible' || !bounds || bounds.width <= 0 || bounds.height <= 0 || !['Run All', 'Run Query', 'Run Query (take 100)', 'Run Query (sample 100)'].every(label => labels.includes(label))) throw new Error('Native legacy Run-options click did not expose the expected menu: ' + JSON.stringify(labels)); return { nativeClick: true, visible: true, labels, mainRunDisabled: document.getElementById(id + '_run_btn')?.disabled === true }; })()"
    When I press "Escape"
    Then I collect JSON artifact "legacy-run-menu-dismissed" from webview expression "(() => { const id = 'section_b304ae6d-218f-4880-8d14-6233c7ba4156'; const menu = document.getElementById(id + '_run_menu'); const style = menu ? getComputedStyle(menu) : null; if (!menu || style.display !== 'none' && style.visibility !== 'hidden') throw new Error('Native Escape did not dismiss the legacy Run-options menu'); const query = window.queryEditors?.[id]?.getValue?.(); const expectedRunDisabled = document.getElementById(id)?.executionCtrl?.isRunSelectionReady?.() !== true; const mainRunDisabled = document.getElementById(id + '_run_btn')?.disabled; if (query !== '' || mainRunDisabled !== expectedRunDisabled) throw new Error('Legacy menu probe changed blank Run eligibility'); return { nativeEscape: true, dismissed: true, blankQuery: true, mainRunDisabled, expectedRunDisabled, queryExecuted: false }; })()"
    Then I collect JSON artifact "legacy-control-source-oracle" from extension host expression "(async () => { const state = globalThis.__sweepState; return { source: await state.assertSourceBytes('after native legacy Run-options click and Escape'), tabs: state.assertHistoricalTabs('after legacy control probe') }; })()"
    Then I collect JSON artifact "activation-sweep" from extension host expression:
      """
      (async () => {
        const {
          uris, kindCounts, initial, expectedNote, initialNotes, initialDashboard,
          activatedFileCount, sourceAfterSweep, hiddenSource,
          invoke, waitForCanary, waitForNotes, waitForDashboard,
          assertSourceBytes, inspectCanarySource, summarizeApi, passes, activeUri,
        } = globalThis.__sweepState;
        const expectedSectionIds = globalThis.__sweepState.expectedSectionIds;
        const hiddenListed = await invoke('kusto-workbench_list-sections', {});
        const hiddenCanary = (hiddenListed.openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uris[0].fsPath.toLowerCase());
        const hiddenNotes = await invoke('kusto-workbench_manage-development-notes', { action: 'view', openFileId: initial.canary.openFileId }).catch(error => ({ success: false, error: String(error) }));
        const hiddenDashboard = await invoke('kusto-workbench_validate-html-dashboard', { openFileId: initial.canary.openFileId, targetFileUri: uris[0].toString(), sectionId: 'sweep_canary_dashboard' }).catch(error => ({ success: false, valid: false, error: String(error) }));
        const activated = await invoke('kusto-workbench_activate-workbench-file', { openFileId: initial.canary.openFileId, targetFileUri: uris[0].toString() });
        if (activated.success !== true || activated.isLiveWorkbench !== true || activated.openFileId !== initial.canary.openFileId || activated.uri !== uris[0].toString()) throw new Error(`Canary reactivation was not live and exact: ${JSON.stringify(activated)}`);
        const recovered = await waitForCanary();
        if (recovered.canary.sectionsUnavailable === true || recovered.canary.openFileId !== initial.canary.openFileId || recovered.canary.uri !== uris[0].toString() || JSON.stringify(recovered.canary.sections?.map(section => section.id)) !== JSON.stringify(expectedSectionIds)) throw new Error(`Canary sections or identity changed: ${JSON.stringify(recovered.canary)}`);
        const recoveredNotes = await waitForNotes('after URI reactivation').catch(error => ({ success: false, notes: [], error: String(error) }));
        const recoveredDashboard = await waitForDashboard('after URI reactivation').catch(error => ({ success: false, valid: false, error: String(error) }));
        const sourceAfterReactivation = await assertSourceBytes('after exact openFileId and URI reactivation');
        const revealedSource = await inspectCanarySource('reactivated');
        if (!hiddenSource.parsedStateStable || !revealedSource.parsedStateStable || revealedSource.dirty !== false || !revealedSource.memoryStable) throw new Error(`Canary content changed before authored Save: ${JSON.stringify({ hiddenSource, revealedSource })}`);
        const hiddenApi = summarizeApi(hiddenCanary, hiddenNotes, hiddenDashboard);
        const reactivatedApi = summarizeApi(recovered.canary, recoveredNotes, recoveredDashboard);
        if (activeUri() !== uris[0].toString()) throw new Error('Exact activation did not make the canary visible');
        globalThis.__sweepApiContract = { hidden: passes(hiddenApi), reactivated: passes(reactivatedApi), repeated: false, hiddenApi, reactivatedApi, sourceAfterSweep, sourceAfterReactivation };
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
          initialDashboard: globalThis.__sweepState.summarizeApi(initial.canary, initialNotes, initialDashboard).dashboard,
          recoveredDashboard: reactivatedApi.dashboard,
          hiddenApi,
          reactivatedApi,
          apiContractMet: globalThis.__sweepApiContract.hidden && globalThis.__sweepApiContract.reactivated,
          bytesUnchangedBeforeSave: sourceAfterSweep.exactBytes && sourceAfterReactivation.exactBytes,
          hiddenSource,
          revealedSource
        };
      })()
      """
    When I evaluate "window.__e2e.workbench.waitForPersistedResult('sweep_canary_fact', 19000)" in the webview "activation-sweep-00.kqlx" for 25 seconds
    When I scroll "#sweep_canary_fact kw-data-table" into view
    Then I collect JSON artifact "canary-fact-reactivated" from webview expression "(() => { const table = document.getElementById('sweep_canary_fact')?.querySelector('kw-data-table'); const columns = table?.columns || []; const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z']]; const visible = rendered.length === 3 && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; }); if (columns.map(column => column.name + ':' + column.type).join('|') !== 'RowId:long|Group:string|Amount:real|Timestamp:datetime' || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('Reactivated Kusto 3x4 table is not exact and visible'); return { rows, columnCount: columns.length, renderedRows: rendered.length, visible, liveQueryRunTested: false }; })()"
    When I scroll "#sweep_canary_sql kw-data-table" into view
    Then I collect JSON artifact "canary-sql-reactivated" from webview expression "(() => { const table = document.getElementById('sweep_canary_sql')?.querySelector('kw-data-table'); const columns = table?.columns || []; const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z', true, 'saved 1'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z', false, 'saved 2'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z', true, 'saved 3']]; const visible = rendered.length === 3 && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; }); if (columns.map(column => column.name + ':' + column.type).join('|') !== 'RowId:int|Group:nvarchar|Amount:decimal|Timestamp:datetime2|IsActive:bit|Note:nvarchar' || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('Reactivated saved SQL 3x6 table is not exact and visible'); return { rows, columnCount: columns.length, renderedRows: rendered.length, visible, savedLegacyDisplayOnly: true, liveQueryRunTested: false }; })()"
    Then I collect JSON artifact "repeat-same-visible-exact-activation" from extension host expression:
      """
      (async () => {
        const state = globalThis.__sweepState;
        const uri = state.uris[0].toString();
        if (state.activeUri() !== uri) throw new Error('Repeated exact activation did not start from the same visible canary');
        const beforeSource = await state.assertSourceBytes('before repeated same-visible exact activation');
        const activated = await state.invoke('kusto-workbench_activate-workbench-file', { openFileId: state.initial.canary.openFileId, targetFileUri: uri });
        if (activated.success !== true || activated.isLiveWorkbench !== true || activated.openFileId !== state.initial.canary.openFileId || activated.uri !== uri) throw new Error(`Repeated visible activation failed: ${JSON.stringify(activated)}`);
        const api = await state.readCanaryApis('after repeated same-visible exact activation');
        const source = await state.assertSourceBytes('after repeated same-visible exact activation');
        const memory = await state.inspectCanarySource('repeated same-visible activation');
        if (!state.passes(api) || !memory.memoryStable || memory.dirty !== false) throw new Error(`Repeated activation lost exact clean canary state: ${JSON.stringify({ api, memory })}`);
        Object.assign(globalThis.__sweepApiContract, { repeated: true, repeatedApi: api, sourceAfterRepeatedActivation: source });
        return { activated, api, beforeSource, source, memory, tabs: state.assertHistoricalTabs('after repeated same-visible exact activation') };
      })()
      """
    Then I collect JSON artifact "mixed-sweep-api-oracle" from extension host expression "(() => { const result = globalThis.__sweepApiContract; if (!result?.hidden || !result.reactivated || !result.repeated || !result.sourceAfterSweep?.exactBytes || !result.sourceAfterReactivation?.exactBytes || !result.sourceAfterRepeatedActivation?.exactBytes) throw new Error('Strict hidden, reactivated, repeated-visible APIs or no-Save bytes failed: ' + JSON.stringify(result)); return { hidden: true, reactivated: true, repeatedVisible: true, exactBytes: true }; })()"
    Then I collect JSON artifact "close-clean-canary-with-histories-open" from extension host expression "globalThis.__sweepState.closeCleanCanary('no-Save canary close with 109 historical tabs retained', true)"
    Then I wait 1 second
    Then I collect JSON artifact "reopen-canary-with-histories-open" from extension host expression "(async () => { const state = globalThis.__sweepState; const beforeSource = await state.assertSourceBytes('before no-Save reopen'); state.assertHistoricalTabs('before no-Save reopen', false); await vscode.commands.executeCommand('vscode.openWith', state.uris[0], 'kusto.kqlxEditor', { preview: false }); if (state.activeUri() !== state.uris[0].toString()) throw new Error('No-Save reopen did not select exact canary URI'); return { opened: true, uri: state.uris[0].toString(), beforeSource, tabs: state.assertHistoricalTabs('after no-Save reopen') }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #sweep_canary_query" in the webview "activation-sweep-00.kqlx" for 30 seconds
    When I evaluate "window.__e2e.workbench.waitForPersistedResult('sweep_canary_fact', 19000)" in the webview "activation-sweep-00.kqlx" for 25 seconds
    When I wait for "#sweep_canary_sql kw-data-table" in the webview for 20 seconds
    When I scroll "#sweep_canary_fact kw-data-table" into view
    Then I collect JSON artifact "canary-fact-no-save-reopened" from webview expression "(() => { const table = document.getElementById('sweep_canary_fact')?.querySelector('kw-data-table'); const columns = table?.columns || []; const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z']]; const visible = rendered.length === 3 && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; }); if (columns.map(column => column.name + ':' + column.type).join('|') !== 'RowId:long|Group:string|Amount:real|Timestamp:datetime' || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('No-Save reopened Kusto 3x4 table changed'); return { rows, columnCount: columns.length, renderedRows: rendered.length, visible, liveQueryRunTested: false }; })()"
    When I scroll "#sweep_canary_sql kw-data-table" into view
    Then I collect JSON artifact "canary-sql-no-save-reopened" from webview expression "(() => { const table = document.getElementById('sweep_canary_sql')?.querySelector('kw-data-table'); const columns = table?.columns || []; const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z', true, 'saved 1'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z', false, 'saved 2'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z', true, 'saved 3']]; const visible = rendered.length === 3 && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; }); if (columns.map(column => column.name + ':' + column.type).join('|') !== 'RowId:int|Group:nvarchar|Amount:decimal|Timestamp:datetime2|IsActive:bit|Note:nvarchar' || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('No-Save reopened saved SQL 3x6 table changed'); return { rows, columnCount: columns.length, renderedRows: rendered.length, visible, savedLegacyDisplayOnly: true, liveQueryRunTested: false }; })()"
    Then I collect JSON artifact "no-save-reopened-canary-apis" from extension host expression "(async () => { const state = globalThis.__sweepState; const api = await state.readCanaryApis('no-Save reopen with all historical tabs retained'); const source = await state.assertSourceBytes('after no-Save reopen APIs'); const memory = await state.inspectCanarySource('no-Save reopened'); if (!memory.memoryStable || memory.dirty !== false) throw new Error('No-Save reopened canary was not exactly clean: ' + JSON.stringify(memory)); const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uris[0].toString()); if (JSON.parse(document.getText()).state.sections[1].query !== 'print SweepBefore=1') throw new Error('Canary query changed before authored edit'); return { api, source, memory, tabs: state.assertHistoricalTabs('no-Save reopen complete') }; })()"
    Then I collect JSON artifact "close-disposable-sweep-tabs" from extension host expression "(async () => { const state = globalThis.__sweepState; const beforeSource = await state.assertSourceBytes('before closing historical siblings'); const beforeTabs = state.assertHistoricalTabs('before closing historical siblings'); const historicalUris = new Set(state.uris.slice(1).map(uri => uri.toString())); const other = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => historicalUris.has(tab.input?.uri?.toString())); if (other.length !== historicalUris.size || other.some(tab => tab.isDirty)) throw new Error('Refusing to close missing or dirty historical siblings'); if (!await vscode.window.tabGroups.close(other)) throw new Error('Could not close all historical siblings'); const remaining = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => historicalUris.has(tab.input?.uri?.toString())); if (remaining.length !== 0 || state.activeUri() !== state.uris[0].toString()) throw new Error('Historical close changed or hid the canary'); return { closed: other.length, historicalFileCount: historicalUris.size, remaining: remaining.length, canaryUri: state.uris[0].toString(), active: state.activeUri(), beforeTabs, beforeSource, afterSource: await state.assertSourceBytes('after closing historical siblings') }; })()"
    Then I collect JSON artifact "configured-canary" from extension host expression "(async () => { const state = globalThis.__sweepState; const configured = await state.invoke('kusto-workbench_configure-query-section', { openFileId: globalThis.__sweepCanaryOpenFileId, targetFileUri: state.uris[0].toString(), sectionId: 'sweep_canary_query', query: state.queryMarker, execute: false }); if (configured.success !== true) throw new Error('Canary query update was rejected: ' + JSON.stringify(configured)); return configured; })()"
    Then I collect JSON artifact "reactivated-canary" from extension host expression "(() => { const state = globalThis.__sweepState; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uris[0].toString()); const section = document && JSON.parse(document.getText()).state.sections.find(item => item.id === 'sweep_canary_query'); if (!document || section?.query !== state.queryMarker || state.activeUri() !== state.uris[0].toString()) throw new Error('Known canary query was not live in the exact document buffer: ' + JSON.stringify(section)); return { query: section.query, dirty: document.isDirty, activeUri: state.activeUri() }; })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "durable-canary" from extension host expression:
      """
      (async () => {
        const crypto = process.getBuiltinModule('node:crypto');
        const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx');
        let text = '';
        let previousText = '';
        let stableSince = Date.now();
        const saveDeadline = Date.now() + 10000;
        while (Date.now() < saveDeadline) {
          text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
          const currentDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          if (text !== previousText || currentDocument?.isDirty || currentDocument?.getText() !== text) stableSince = Date.now();
          if (text === previousText && currentDocument && !currentDocument.isDirty && currentDocument.getText() === text && Date.now() - stableSince >= 500) break;
          previousText = text;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (Date.now() >= saveDeadline) throw new Error('Native authored Save did not settle to clean, stable buffer/disk bytes');
        const file = JSON.parse(text);
        const sections = file.state.sections;
        const state = globalThis.__sweepState;
        const expectedIds = state.expectedSectionIds;
        const initialFile = JSON.parse(new TextDecoder().decode(globalThis.__sweepInitialCanaryBytes));
        const expectedFile = structuredClone(initialFile);
        expectedFile.state.sections[1].query = state.queryMarker;
        if (file.kind !== 'kqlx' || file.version !== 1 || JSON.stringify(sections.map(section => section.id)) !== JSON.stringify(expectedIds)
          || !state.util.isDeepStrictEqual(file, expectedFile)
          || text !== JSON.stringify(file, null, 2) + String.fromCharCode(10)) {
          const differences = expectedFile.state.sections.map((section, index) => {
            const current = sections[index] || {};
            return { id: section.id, fields: Array.from(new Set([...Object.keys(section), ...Object.keys(current)]))
              .filter(key => JSON.stringify(section[key]) !== JSON.stringify(current[key]))
              .map(key => ({ key, before: section[key] ?? null, after: current[key] ?? null })) };
          }).filter(section => section.fields.length > 0);
          throw new Error('Saved canary did not exactly match the authored change: ' + JSON.stringify({
            differences, deepEqual: state.util.isDeepStrictEqual(file, expectedFile),
            canonicalText: text === JSON.stringify(file, null, 2) + String.fromCharCode(10),
            rootKeys: Object.keys(file), expectedRootKeys: Object.keys(expectedFile),
          }));
        }
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!document || document.isDirty) throw new Error(`Saved canary was not clean: ${document?.isDirty}`);
        globalThis.__sweepSavedText = text;
        state.savedText = text;
        return { exactBytes: true, sha256: crypto.createHash('sha256').update(text).digest('hex'), sectionIds: expectedIds, query: sections[1].query, dirty: document.isDirty, source: await state.assertSourceBytes('after authored canary Save', true) };
      })()
      """
    Then I collect JSON artifact "close-canary-for-reopen" from extension host expression "globalThis.__sweepState.closeCleanCanary('saved canary close for reopen', false, true)"
    Then I wait 1 second
    Then I collect JSON artifact "reopen-canary" from extension host expression "(async () => { const state = globalThis.__sweepState; const beforeSource = await state.assertSourceBytes('before saved canary reopen', true); await vscode.commands.executeCommand('vscode.openWith', state.uris[0], 'kusto.kqlxEditor', { preview: false }); if (state.activeUri() !== state.uris[0].toString()) throw new Error('Saved reopen selected another URI'); return { opened: true, uri: state.uris[0].toString(), beforeSource }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #sweep_canary_query" in the webview "activation-sweep-00.kqlx" for 30 seconds
    Then I collect JSON artifact "reopened-canary" from webview expression "(() => { const query = window.queryEditors?.sweep_canary_query?.getValue?.() || ''; if (query !== 'print SweepRecovered=109') throw new Error('Reopened canary query was not durable: ' + query); const ids = Array.from(document.getElementById('queries-container')?.children || []).map(section => section.id).filter(Boolean); const expectedIds = ['sweep_canary_fact', 'sweep_canary_query', 'sweep_canary_markdown', 'sweep_canary_dashboard', 'sweep_canary_sql', 'sweep_canary_chart', 'sweep_canary_transformation', 'sweep_canary_url', 'sweep_canary_python']; if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new Error('Reopened visible section IDs or direct child order changed: ' + JSON.stringify(ids)); return { query, visibleSectionIds: ids, hiddenDevnotesExcludedFromDom: true }; })()"
    When I evaluate "window.__e2e.workbench.waitForPersistedResult('sweep_canary_fact', 19000)" in the webview "activation-sweep-00.kqlx" for 25 seconds
    When I wait for "#sweep_canary_sql kw-data-table" in the webview for 20 seconds
    When I scroll "#sweep_canary_fact kw-data-table" into view
    Then I collect JSON artifact "canary-fact-saved-reopened" from webview expression "(() => { const table = document.getElementById('sweep_canary_fact')?.querySelector('kw-data-table'); const columns = table?.columns || []; const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z']]; const visible = rendered.length === 3 && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; }); if (columns.map(column => column.name + ':' + column.type).join('|') !== 'RowId:long|Group:string|Amount:real|Timestamp:datetime' || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('Saved reopened Kusto 3x4 table changed'); return { rows, columnCount: columns.length, renderedRows: rendered.length, visible, liveQueryRunTested: false }; })()"
    When I scroll "#sweep_canary_sql kw-data-table" into view
    Then I collect JSON artifact "canary-sql-saved-reopened" from webview expression "(() => { const table = document.getElementById('sweep_canary_sql')?.querySelector('kw-data-table'); const columns = table?.columns || []; const rows = (table?.rows || []).map(row => row.map(cell => cell && typeof cell === 'object' && Object.hasOwn(cell, 'full') ? cell.full : cell)); const rendered = Array.from(table?.shadowRoot?.querySelectorAll('#dt-body tbody tr') || []); const expectedRows = [[1, 'alpha', 10.5, '2026-09-12T00:00:00.000Z', true, 'saved 1'], [2, 'beta', 21, '2026-09-13T00:00:00.000Z', false, 'saved 2'], [3, 'gamma', 31.5, '2026-09-14T00:00:00.000Z', true, 'saved 3']]; const visible = rendered.length === 3 && rendered.every(row => { const bounds = row.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight; }); if (columns.map(column => column.name + ':' + column.type).join('|') !== 'RowId:int|Group:nvarchar|Amount:decimal|Timestamp:datetime2|IsActive:bit|Note:nvarchar' || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !visible) throw new Error('Saved reopened SQL 3x6 table changed'); return { rows, columnCount: columns.length, renderedRows: rendered.length, visible, savedLegacyDisplayOnly: true, liveQueryRunTested: false }; })()"
    Then I collect JSON artifact "reopened-inventory" from extension host expression:
      """
      (async () => {
        const uri = vscode.Uri.joinPath(globalThis.__sweepRoot, 'activation-sweep-00.kqlx');
        const state = globalThis.__sweepState;
        const expectedIds = state.expectedSectionIds;
        const result = await vscode.lm.invokeTool('kusto-workbench_list-sections', { toolInvocationToken: undefined, input: {} });
        const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
        if (!text || text.startsWith('Error:')) throw new Error(`Reopened inventory failed: ${text}`);
        const listed = JSON.parse(text);
        const canary = (listed.openFiles || []).find(file => String(file.filePath || '').toLowerCase() === uri.fsPath.toLowerCase());
        const sectionIds = canary?.sections?.map(section => section.id) || [];
        const durableText = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!canary?.isLiveWorkbench || canary.sectionsUnavailable === true || JSON.stringify(sectionIds) !== JSON.stringify(expectedIds) || durableText !== globalThis.__sweepSavedText || !document || document.isDirty || document.getText() !== durableText) throw new Error(`Reopened inventory, clean buffer, or saved bytes differed: ${JSON.stringify(canary)}`);
        const api = await state.readCanaryApis('final saved canary reopen');
        return { sectionIds, sectionsUnavailable: false, exactSavedBytes: true, dirty: false, api, source: await state.assertSourceBytes('final reopened canary APIs', true) };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "reopened-canary-after-110-activations-109-historicals"
    Then I collect JSON artifact "close-reopened-canary" from extension host expression "globalThis.__sweepState.closeCleanCanary('final reopened canary close', false, true)"
    Then I collect JSON artifact "activation-sweep-cleanup" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const root = globalThis.__sweepRoot; const parent = path.resolve(process.env.TEMP || process.cwd()); if (!root?.fsPath || path.dirname(path.resolve(root.fsPath)).toLowerCase() !== parent.toLowerCase() || !path.basename(root.fsPath).startsWith('kw-tool-session-activation-sweep-')) throw new Error('Refusing to delete an unowned sweep fixture'); const state = globalThis.__sweepState; const expectedUris = new Set(state.uris.map(uri => uri.toString())); const remaining = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => expectedUris.has(tab.input?.uri?.toString())); if (remaining.length !== 0) throw new Error('Refusing cleanup while task-owned editors remain open'); const source = await state.assertSourceBytes('before fixture cleanup', true); await vscode.commands.executeCommand('kustoWorkbench.test.cleanupPersistedResultFixture'); await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }); const settings = globalThis.__sweepAutoSaveSettings; const config = vscode.workspace.getConfiguration('files'); await config.update('autoSave', settings.previousAutoSave, vscode.ConfigurationTarget.Global); await config.update('autoSaveDelay', settings.previousDelay, vscode.ConfigurationTarget.Global); delete globalThis.__sweepAutoSaveSettings; delete globalThis.__sweepRoot; return { deleted: true, remainingTaskTabs: remaining.length, source, visualReview: 'UNREVIEWED_VISUAL' }; })()"
