# Use a fresh Development host or the explicitly approved Kusto test profile; never attach or reset existing tabs.
# vscode-ext-test run --extension-path . --features tests/vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline --vscode-version stable --timeout 180000 --no-build
# Prepared Kusto mode: add --reuse-named-profile kusto-auth --env KW_ARCHIVE_BASELINE_PROFILE=kusto-auth; preserve existing tabs.
# Coverage C1: immutable original -> first public activation -> exact-ID notes/dashboard -> preservation -> clean exact-URI close.
# Deferred: original109 pressure/recovery, Production/runtime qualification, native controls, Save/reopen; this is initial readiness only.
Feature: Unchanged original archived canary baseline

  Scenario: Original archived canary provides a working baseline without seed or query
    Given I collect JSON artifact "archive-original-canary-baseline-evidence" from extension host expression:
      """
      (async () => {
        if (process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH !== undefined) throw new Error('SETUP_BLOCKED: standalone repro requires its documented fresh-host command, not reusable-profile suite dispatch');
        const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path'), os = process.getBuiltinModule('node:os');
        const crypto = process.getBuiltinModule('node:crypto'), url = process.getBuiltinModule('node:url'), modules = process.getBuiltinModule('node:module');
        const equal = process.getBuiltinModule('node:util').isDeepStrictEqual, hash = value => crypto.createHash('sha256').update(value).digest('hex');
        const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
        const assertSavedDocument = (snapshot, uri) => { if (snapshot?.documentUri !== uri) throw new Error('Exact task-owned notebook URI does not match the saved-data snapshot'); return snapshot; };
        const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const tabSnapshot = () => tabs().map(tab => ({ uri: tab.input?.uri?.toString() ?? null, type: tab.input?.viewType ?? tab.input?.constructor?.name ?? null, dirty: tab.isDirty, active: tab.isActive }));
        const preserveStartingTabs = (before, after) => {
          const counts = new Map();
          const key = tab => JSON.stringify([tab.uri, tab.type, tab.dirty]);
          for (const tab of after) counts.set(key(tab), (counts.get(key(tab)) ?? 0) + 1);
          for (const tab of before) { const count = counts.get(key(tab)) ?? 0; if (count === 0) return false; counts.set(key(tab), count - 1); }
          return true;
        };
        const previous = globalThis.__archiveOriginalCanaryBaseline;
        const nativeProfile = globalThis.__archiveOriginalProfileConfig;
        const preparedProfile = process.env.KW_ARCHIVE_BASELINE_PROFILE;
        if (preparedProfile !== undefined && preparedProfile !== 'kusto-auth') throw new Error('SETUP_BLOCKED: only the approved Kusto test profile is supported');
        const outcome = { scope: 'ORIGINAL_ARCHIVED_CANARY_INITIAL_READINESS_ONLY', classification: 'SETUP_BLOCKED', calls: [], observations: [], damage: [], tabEvents: [], checks: {}, errors: [] };
        globalThis.__archiveOriginalCanaryBaseline = outcome;
        let extension, main, workbenchRequire, helper, owner, staged, plan, canary, observer, evidenceRoot, setupError, openFileId;
        let activation, notes, dashboard;
        const references = new Map(), models = new Map(), subscriptions = [];
        const write = (name, value) => {
          if (!evidenceRoot) return;
          try { helper.assertAcceptanceRoot(owner); const stat = fs.lstatSync(evidenceRoot);
            if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(evidenceRoot), evidenceRoot)) throw new Error('SETUP_BLOCKED: private evidence directory is aliased');
            fs.writeFileSync(path.join(evidenceRoot, name + '.json'), JSON.stringify(value, null, 2));
          } catch (error) { const message = String(error?.message ?? error); setupError ??= message; outcome.errors.push(message); outcome.checks.evidenceStored = false; outcome.classification = outcome.damage.length ? 'PRESERVATION_FAILED' : 'SETUP_BLOCKED'; }
        };
        const loadedProof = () => {
          const loaded = Object.values(workbenchRequire.cache).find(candidate => samePath(candidate?.filename, main));
          const context = loaded?.exports?.toolOrchestrator?.context, source = fs.readFileSync(main, 'utf8');
          const expectedMode = nativeProfile ? 3 : 2;
          if (loaded?.loaded !== true || context?.extensionMode !== expectedMode || !samePath(context.extensionPath, extension.extensionPath)) throw new Error('SETUP_BLOCKED: actual source test context/main missing');
          if (preparedProfile) {
            const expectedUserData = path.join(extension.extensionPath, 'tests/vscode-extension-tester/profiles', preparedProfile, 'user-data');
            const storagePath = context.globalStorageUri?.fsPath;
            const relative = typeof storagePath === 'string' ? path.relative(expectedUserData, storagePath) : '..';
            if (!['file', 'vscode-userdata'].includes(context.globalStorageUri?.scheme) || context.globalStorageUri.authority || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('SETUP_BLOCKED: not the approved Kusto test profile storage');
            outcome.preparedProfile = { name: preparedProfile, userDataPath: expectedUserData, globalStoragePath: storagePath, extensionAlreadyActive: outcome.extensionAlreadyActive === true };
          }
          if (nativeProfile && (!['file', 'vscode-userdata'].includes(context.globalStorageUri?.scheme) || context.globalStorageUri.authority || !samePath(context.globalStorageUri.fsPath, nativeProfile.globalStoragePath) || hash(fs.readFileSync(main)) !== nativeProfile.mainSha256)) throw new Error('SETUP_BLOCKED: native profile storage/build differs from the verified setup');
          return { filename: loaded.filename, sourceRoot: context.extensionPath, extensionMode: context.extensionMode, mainSha256: hash(fs.readFileSync(main)), vscodeVersion: vscode.version,
            qualification: 'PARTIAL_ORCHESTRATOR_ONLY_NOT_GATEWAY_OR_WEBVIEW', methods: ['collectOpenWorkbenchFiles', 'listSections', 'manageDevelopmentNotes', 'validateHtmlDashboard', 'activateWorkbenchFile'].map(name => {
              const method = loaded.exports.toolOrchestrator[name];
              if (typeof method !== 'function' || !source.includes(Function.prototype.toString.call(method))) throw new Error('SETUP_BLOCKED: executing method/main mismatch: ' + name);
              return { name, sha256: hash(Function.prototype.toString.call(method)), matchesMain: true };
            }) };
        };
        const sample = (document, phase) => {
          const uri = document.uri.toString(), reference = references.get(uri);
          if (!reference) return;
          if (!models.has(document)) { if ([...models.values()].some(model => model.uri === uri)) outcome.damage.push({ uri, phase, reason: 'model-replaced' }); models.set(document, { uri, version: document.version }); }
          const text = document.getText(), record = { uri, phase, atUtc: new Date().toISOString(), version: document.version, dirty: document.isDirty, bufferSha256: hash(text) };
          outcome.observations.push(record);
          if (!Number.isSafeInteger(document.version) || document.version !== 1 || document.version !== models.get(document).version || document.isDirty || text !== reference.text) outcome.damage.push(record);
          write('model-observations', outcome.observations);
        };
        const preservation = phase => {
          helper.assertAcceptanceRoot(owner);
          const changed = [];
          for (const [uri, reference] of references) { try { const stat = fs.lstatSync(reference.file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== reference.bytes || !samePath(fs.realpathSync.native(reference.file), reference.file) || hash(fs.readFileSync(reference.file)) !== reference.sha256) changed.push(uri); } catch { changed.push(uri); } }
          for (const document of models.keys()) sample(document, phase);
          const snapshot = tabSnapshot(); outcome.tabEvents.push({ phase, atUtc: new Date().toISOString(), tabs: snapshot });
          for (const tab of snapshot) if (references.has(tab.uri) && tab.dirty) outcome.damage.push({ uri: tab.uri, phase, reason: 'dirty-tab' });
          outcome.damage.push(...changed.map(uri => ({ uri, phase, reason: 'file-bytes-or-alias-changed' })));
          const cold = helper.inspectAcceptanceColdCanary(owner, staged.historyRoot, staged.coldCanary, staged.files);
          const result = { phase, archiveCopies: plan.files.length, protectedCopies: references.size, changed, cold, passed: changed.length === 0 && outcome.damage.length === 0 };
          write(phase + '-preservation', result); return result;
        };
        const invoke = async (name, input) => {
          const record = { sequence: outcome.calls.length + 1, name, input, attempted: true, startedUtc: new Date().toISOString(), tabsBefore: tabSnapshot() };
          outcome.calls.push(record); write('call-' + record.sequence, record);
          try { record.raw = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input }); const text = record.raw.content.find(part => typeof part?.value === 'string')?.value; record.text = text; try { record.value = JSON.parse(text); } catch { record.decodeError = 'Literal response is not JSON'; } }
          catch (error) { record.transportError = String(error?.message ?? error); }
          record.finishedUtc = new Date().toISOString(); record.elapsedMs = Date.parse(record.finishedUtc) - Date.parse(record.startedUtc); record.tabsAfter = tabSnapshot(); record.complete = true;
          write('call-' + record.sequence, record); return record;
        };
        try {
          extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench'); outcome.initialTabs = tabSnapshot();
          if (!extension || !preparedProfile && (extension.isActive && !nativeProfile || tabs().length !== 0 || (vscode.workspace.workspaceFolders?.length ?? 0) !== 0) || previous) throw new Error('SETUP_BLOCKED: requires an unused test host; prepared profile tabs must be preserved, not reset');
          outcome.extensionAlreadyActive = extension.isActive === true;
          main = path.resolve(extension.extensionPath, extension.packageJSON.main);
          const mainStat = fs.lstatSync(main);
          if (!mainStat.isFile() || mainStat.isSymbolicLink() || mainStat.nlink !== 1 || !samePath(fs.realpathSync.native(main), main)) throw new Error('SETUP_BLOCKED: source main is aliased');
          outcome.mainBeforeSha256 = hash(fs.readFileSync(main)); workbenchRequire = modules.createRequire(main);
          if (nativeProfile) {
            const runner = workbenchRequire(path.join(extension.extensionPath, 'tests/vscode-extension-tester/e2e/opt-in/archive-original-canary-baseline/profile-runner.cjs'));
            const validated = await runner.validateConfig(nativeProfile.configPath, nativeProfile.configSha256);
            if (nativeProfile.phase !== 'check' || !samePath(validated.expectedSourceRoot, extension.extensionPath) || !samePath(validated.mainFile, main) || validated.mainSha256 !== outcome.mainBeforeSha256 || !samePath(validated.userDataDir, nativeProfile.userDataDir)) throw new Error('SETUP_BLOCKED: unverified native profile configuration');
            outcome.nativeProfile = { configPath: validated.configPath, profileName: validated.profileName, userDataDir: validated.userDataDir, extensionsDir: validated.extensionsDir, sharedDataDir: validated.sharedDataDir, expectedMode: 3 };
          }
          helper = await import(url.pathToFileURL(path.join(extension.extensionPath, 'scripts/repro-published-notebook.mjs')).href);
          plan = await helper.inspectAcceptanceArchives(path.join(os.tmpdir(), 'kw-wave3-before-2026-10-09-032b29ab0ad64643abd66746fb58bb7f.zip'), path.join(os.tmpdir(), 'kw-regression-before-2026-10-07-5f779bb4a66542f6ae767e9e817f7a22.zip'), 'current133-api');
          if (plan.activationOrder.includes(plan.archivedCanary.path)) throw new Error('SETUP_BLOCKED: original canary unexpectedly belongs to order109');
          owner = helper.createAcceptanceRoot(); staged = helper.stageBeforeImages(owner, plan, plan.images);
          evidenceRoot = path.join(owner.root, 'evidence'); fs.mkdirSync(evidenceRoot); outcome.evidenceRoot = evidenceRoot; outcome.archive = plan.archive; outcome.checks.evidenceStored = true;
          for (const file of staged.files) { const target = path.join(staged.historyRoot, file.path); references.set(vscode.Uri.file(target).toString(), { ...file, file: target, text: plan.images.get(file.path).toString('utf8').replace(/^\uFEFF/, '') }); }
          const cold = staged.coldCanary; references.set(vscode.Uri.file(cold.filePath).toString(), { ...cold, file: cold.filePath, text: plan.images.get(cold.sourcePath).toString('utf8').replace(/^\uFEFF/, '') });
          canary = vscode.Uri.file(path.join(staged.historyRoot, plan.archivedCanary.path));
          const sections = JSON.parse(plan.images.get(plan.archivedCanary.path).toString('utf8')).state.sections;
          const fact = sections.find(section => section.id === plan.archivedCanary.factSectionId), result = JSON.parse(fact.resultJson), expectedNotes = sections.find(section => section.type === 'devnotes').entries;
          if (sections.length !== 10 || expectedNotes.length !== 1 || plan.archivedCanary.bindingIds.length !== 6 || result.columns.length !== 4 || result.rows.length !== 3 || result.rows.some(row => row.length !== 4)) throw new Error('SETUP_BLOCKED: immutable original graph differs');
          outcome.original = { uri: canary.toString(), sha256: plan.archivedCanary.sha256, sectionCount: sections.length, bindingCount: 6, factSectionId: fact.id, htmlSectionId: plan.archivedCanary.htmlSectionId, rowCount: result.rows.length, factColumns: result.columns, targetConnection: { clusterUrl: fact.clusterUrl ?? null, database: fact.database ?? null, connectionIdHint: fact.connectionIdHint ?? null } };
          outcome.before = preservation('before-open');
          observer = helper.observeAcceptanceExecutionBoundary(workbenchRequire('vscode'), { ownedUris: new Set([canary.toString()]), coldUri: canary.toString(), coldSectionId: fact.id, source: 'actual-workbench-vscode-facade' });
          if (observer.snapshot().blockers.length !== 0) throw new Error('SETUP_BLOCKED: actual execution observer could not arm');
          subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => sample(document, 'open')), vscode.workspace.onDidChangeTextDocument(event => sample(event.document, 'change')), vscode.workspace.onDidCloseTextDocument(document => sample(document, 'close')),
            vscode.window.tabGroups.onDidChangeTabs(() => { outcome.tabEvents.push({ phase: 'tabs-changed', tabs: tabSnapshot() }); for (const tab of tabs()) if (references.has(tab.input?.uri?.toString()) && tab.isDirty) outcome.damage.push({ uri: tab.input.uri.toString(), reason: 'dirty-tab' }); }));
          await extension.activate(); outcome.loadedBefore = loadedProof();
          if (preparedProfile) {
            const loaded = Object.values(workbenchRequire.cache).find(candidate => samePath(candidate?.filename, main));
            const connections = loaded.exports.toolOrchestrator.connectionManager.getConnections();
            outcome.connectionSetup = { configuredConnectionCount: connections.length, matchingCluster: connections.filter(connection => String(connection.clusterUrl).toLowerCase().includes('ddtelinsights')).map(connection => ({ id: connection.id, clusterUrl: connection.clusterUrl, database: connection.database ?? null, authorityId: connection.authorityId ?? null })), savedConnectionIdHint: fact.connectionIdHint ?? null };
          }
          if (nativeProfile) {
            const loaded = Object.values(workbenchRequire.cache).find(candidate => samePath(candidate?.filename, main));
            const manager = loaded.exports.toolOrchestrator.connectionManager;
            const expected = { id: 'conn_1765825441854_gi5ey0lar', name: 'Wave4 isolated starting state', clusterUrl: 'https://ddtelinsights.kusto.windows.net', database: 'DDTelInsights' };
            outcome.checks.restoredConnection = equal(manager.getConnections(), [expected]) && manager.getConnectionIncarnation(expected.id) === 1;
            if (!outcome.checks.restoredConnection) throw new Error('SETUP_BLOCKED: original connection record was not restored by the actual manager');
          }
          if (outcome.loadedBefore.mainSha256 !== outcome.mainBeforeSha256 || !preparedProfile && (!observer.snapshot().registrationObserved || tabs().length !== 0)) throw new Error('SETUP_BLOCKED: source/registration identity changed before first public open');
          if (!preparedProfile) {
            await vscode.workspace.getConfiguration('workbench.editor').update('enablePreview', false, vscode.ConfigurationTarget.Global);
            await vscode.workspace.getConfiguration('files').update('autoSaveDelay', 1000, vscode.ConfigurationTarget.Global); await vscode.workspace.getConfiguration('files').update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
          }
          if (vscode.workspace.getConfiguration('workbench.editor').get('enablePreview') !== false || vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000) throw new Error('SETUP_BLOCKED: isolated preview/Auto Save settings not applied');
          activation = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: canary.toString() });
          const loaded = Object.values(workbenchRequire.cache).find(candidate => samePath(candidate?.filename, main));
          const metadata = loaded.exports.toolOrchestrator.collectOpenWorkbenchFiles().openFiles.filter(file => file.uri === canary.toString());
          outcome.targetMetadata = metadata.map(file => ({ openFileId: file.openFileId, uri: file.uri, fileKind: file.fileKind, isLiveWorkbench: file.isLiveWorkbench }));
          openFileId = typeof activation.value?.openFileId === 'string' ? activation.value.openFileId : metadata.length === 1 ? metadata[0].openFileId : null;
          const exactTabs = tabs().filter(tab => tab.input?.uri?.toString() === canary.toString());
          outcome.checks.sdkTarget = exactTabs.length === 1 && exactTabs[0].input instanceof vscode.TabInputCustom && exactTabs[0].input.viewType === 'kusto.kqlxEditor' && exactTabs[0].isActive;
          outcome.checks.activation = activation.value?.success === true && activation.value.isLiveWorkbench === true && activation.value.uri === canary.toString() && activation.value.openFileId === openFileId;
          outcome.checks.targetIdentity = typeof openFileId === 'string' && openFileId.length > 0 && metadata.length === 1 && metadata[0].openFileId === openFileId;
          if (process.env.KW_ARCHIVE_CDP_MODULE || process.env.KW_ARCHIVE_CDP_PORT) {
            outcome.checks.savedDataDiagnostic = false;
            let cdp;
            try {
              const port = Number(process.env.KW_ARCHIVE_CDP_PORT);
              if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !path.isAbsolute(process.env.KW_ARCHIVE_CDP_MODULE)) throw new Error('Invalid explicit test CDP configuration');
              const { CdpClient } = workbenchRequire(process.env.KW_ARCHIVE_CDP_MODULE);
              cdp = new CdpClient(port); await cdp.connect();
              const expression = `(() => {
                const html = document.getElementById(${JSON.stringify(plan.archivedCanary.htmlSectionId)});
                const query = document.getElementById(${JSON.stringify(plan.archivedCanary.factSectionId)});
                if (!html || !query || html.tagName !== 'KW-HTML-SECTION' || query.tagName !== 'KW-QUERY-SECTION') throw new Error('Exact original notebook frame is not present');
                if (!window.__e2e?.html?.documentOwnershipSnapshot) throw new Error('Existing read-only HTML snapshot helper is unavailable');
                const binding = window.__e2e.html.documentOwnershipSnapshot(html.id);
                (${assertSavedDocument.toString()})(binding, ${JSON.stringify(canary.toString())});
                const bridge = html._buildDataBridgeScript();
                const match = bridge.match(/var _d=([\\s\\S]*?);\\s*var _full=/);
                const data = match ? JSON.parse(match[1]).fact : null;
                return { binding, selectedConnectionId: query.getConnectionId(), selectedDatabase: query.getDatabase(), selectedCluster: query.getClusterUrl(), exportContext: html.getDashboardExportContext(), bridgeHasData: !!data, bridgeFact: data, previewHasSavedData: !!html.shadowRoot?.querySelector('#preview-iframe')?.srcdoc?.includes('var _d=') };
              })()`;
              outcome.savedDataDiagnostic = await cdp.evaluateInWebview(expression, undefined, { timeoutMs: 10000 });
              if (!outcome.savedDataDiagnostic?.binding) throw new Error('Exact diagnostic result was not returned');
              assertSavedDocument(outcome.savedDataDiagnostic.binding, canary.toString());
              outcome.checks.savedDataDiagnostic = true;
              write('saved-data-diagnostic', outcome.savedDataDiagnostic);
            } catch (error) { outcome.savedDataDiagnosticError = String(error?.message ?? error); }
            finally { cdp?.disconnect(); }
          }
          if (typeof openFileId === 'string' && openFileId.length > 0) { notes = await invoke('kusto-workbench_manage-development-notes', { action: 'view', openFileId }); dashboard = await invoke('kusto-workbench_validate-html-dashboard', { sectionId: plan.archivedCanary.htmlSectionId, openFileId }); }
          else for (const name of ['kusto-workbench_manage-development-notes', 'kusto-workbench_validate-html-dashboard']) outcome.calls.push({ name, attempted: false, reason: 'No returned or unique actual-owner openFileId; no invented target or extra activation' });
          outcome.checks.note = notes?.value?.success === true && equal(notes.value.notes, expectedNotes);
          const validation = dashboard?.value;
          outcome.checks.dashboard = validation?.success === true && validation.valid === true && validation.sectionId === plan.archivedCanary.htmlSectionId && validation.hasProvenance === true && validation.bindingCount === 6 && validation.dataSourceCount === 1 && equal(validation.issues, []) && equal(validation.diagnostics, []) && equal(validation.warnings, []) && equal(validation.factColumns, result.columns) && samePath(validation.filePath, canary.fsPath) && validation.fileName === path.basename(canary.fsPath);
          outcome.checks.threeCalls = outcome.calls.length === 3 && outcome.calls.every(call => call.attempted === true && call.complete === true && !call.transportError && !call.decodeError);
        } catch (error) { setupError = String(error?.message ?? error); outcome.errors.push(setupError); }
        finally {
          if (staged) {
            try { outcome.beforeCleanup = preservation('before-cleanup'); } catch (error) { setupError ??= String(error?.message ?? error); outcome.errors.push(String(error?.message ?? error)); }
            let index = 0; for (const document of models.keys()) { try { write('last-buffer-' + (++index), { text: document.getText() }); } catch (error) { setupError ??= String(error?.message ?? error); outcome.errors.push(String(error?.message ?? error)); } }
            try { outcome.cleanup = await helper.closeAcceptanceTabs(vscode, owner, [canary.toString()]); } catch (error) { outcome.errors.push(String(error?.message ?? error)); outcome.cleanup = { refused: true, dirtyDiscard: false }; }
            try { outcome.afterCleanup = preservation('after-cleanup'); } catch (error) { setupError ??= String(error?.message ?? error); outcome.errors.push(String(error?.message ?? error)); }
            outcome.checks.preservation = outcome.before?.passed === true && outcome.beforeCleanup?.passed === true && outcome.afterCleanup?.passed === true && outcome.damage.length === 0;
            outcome.checks.cleanup = outcome.cleanup?.onlyOwnedTabs === true && outcome.cleanup.survivors === 0 && (preparedProfile
              ? preserveStartingTabs(outcome.initialTabs, tabSnapshot())
              : tabs().length === 0); }
          for (const subscription of subscriptions) { try { subscription.dispose(); } catch (error) { setupError ??= String(error?.message ?? error); outcome.errors.push(String(error?.message ?? error)); } }
          outcome.execution = observer?.restore() ?? null;
          const observedExecution = outcome.execution?.registrationObserved === true && outcome.execution.coldPanelObserved === true && outcome.execution.restored === true && outcome.execution.blockers.length === 0;
          if (preparedProfile && outcome.extensionAlreadyActive) {
            outcome.executionObservation = { complete: observedExecution, limitation: observedExecution ? null : 'Workbench was already active; its earlier registrations were not observed', noQueryToolRequested: outcome.calls.every(call => ['kusto-workbench_activate-workbench-file', 'kusto-workbench_manage-development-notes', 'kusto-workbench_validate-html-dashboard'].includes(call.name)) };
            outcome.checks.readOnlyCalls = outcome.executionObservation.noQueryToolRequested && outcome.execution?.restored === true && outcome.execution.blockers.length === 0 && outcome.execution.events.length === 0;
          } else outcome.checks.zeroExecution = observedExecution && outcome.execution.ingressCount === 0 && outcome.execution.startCount === 0;
          if (outcome.loadedBefore) { try { outcome.loadedAfter = loadedProof(); outcome.checks.sourceIdentity = equal(outcome.loadedBefore, outcome.loadedAfter) && outcome.loadedAfter.mainSha256 === outcome.mainBeforeSha256; } catch (error) { setupError ??= String(error?.message ?? error); outcome.errors.push(String(error?.message ?? error)); } }
        }
        const missingStoredOwner = dashboard?.value?.hasProvenance === true && dashboard.value.bindingCount === 6 && dashboard.value.dataSourceCount === 0;
        outcome.classification = outcome.damage.length ? 'PRESERVATION_FAILED' : setupError || outcome.checks.sourceIdentity !== true ? 'SETUP_BLOCKED' : outcome.checks.activation !== true ? 'INITIAL_ACTIVATION_REJECTED' : outcome.checks.targetIdentity !== true ? 'BASELINE_TARGET_UNAVAILABLE' : outcome.checks.note !== true ? 'BASELINE_NOTE_UNAVAILABLE' : missingStoredOwner ? 'PREPARED_PROFILE_REQUIRED' : outcome.checks.dashboard !== true ? 'BASELINE_DASHBOARD_UNAVAILABLE' : Object.values(outcome.checks).every(value => value === true) ? 'BASELINE_AVAILABLE' : 'SETUP_BLOCKED';
        if (missingStoredOwner) outcome.nextRequirement = 'Provide a prepared isolated profile with lawful original stored-result ownership; missing data does not prove an authentication cause. Do not seed, clone credentials, retarget or query.';
        write('final-outcome', outcome); return JSON.parse(JSON.stringify(outcome));
      })()
      """
    Then I collect JSON artifact "archive-original-canary-baseline-assertion" from extension host expression "(() => { const outcome = globalThis.__archiveOriginalCanaryBaseline; if (outcome?.classification !== 'BASELINE_AVAILABLE' || !Object.values(outcome.checks).every(value => value === true)) throw new Error(JSON.stringify({ classification: outcome?.classification, evidenceRoot: outcome?.evidenceRoot, checks: outcome?.checks })); return { passed: true, scope: outcome.scope }; })()"