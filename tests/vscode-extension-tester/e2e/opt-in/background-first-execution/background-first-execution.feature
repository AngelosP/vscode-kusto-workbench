Feature: A background report executes through its real producer before and after Save

  Scenario: First targeted execution hands off ownership and a restored execution publishes fresh results
    Given I collect JSON artifact "background-first-execution" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const modules = process.getBuiltinModule('node:module');
        const assert = process.getBuiltinModule('node:assert/strict');
        const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
        const canonical = value => path.resolve(value).toLowerCase();
        const engine = process.env.KW_FIRST_EXECUTION_ENGINE;
        const outcome = {
          engine, classification: 'SETUP_BLOCKED', phase: 'setup', calls: [], evidence: [], errors: [],
          tabEvents: [], documentEvents: [], surfaces: [], preExecuteTabSelections: [],
          qualification: { compiledProductionOwners: true, installedProductionMode: false, visualReviewed: false, postExecutionFocus: 'Deferred: exact task-file activation prepares DOM inspection' },
          coverage: [
            { id: 'KQL', decision: engine === 'kusto' ? 'Include' : 'Other engine run', lifecycle: 'reveal-false CREATE -> exact SAVE -> LIST -> first retarget Execute -> DOM -> SAVE -> close -> reopen -> restored DOM -> execute-only -> fresh producer -> SAVE', owners: 'background handoff, Kusto execution/publication, native Save and restore' },
            { id: 'SQL', decision: engine === 'sql' ? 'Include' : 'Other engine run', lifecycle: 'same composed lifecycle with SQL owner admission; missing unconfigured LIST identity blocks before Execute', owners: 'background handoff, SQL owner readiness/broker, native Save and restore' },
            { id: 'Starting tabs', decision: 'Include', lifecycle: 'clean restored tabs -> observe exact URI/view type/dirty multiset and model/disk -> new-file lifecycle -> close only task URI -> unchanged starting tabs', owners: 'VS Code tab/document events and read-only local file snapshots' },
            { id: 'Dirty starting files', decision: 'Exclude', reason: 'Refuse before tool calls to avoid unrelated Auto Save; no reset or discard is permitted.' },
            { id: 'Existing native input and mocked handoff', decision: 'Partial', evidence: 'background-user-save-handoff: native typing/Save/reopen/second typing; no real authenticated execution' },
            { id: 'Run button, schema priming, other formats and dependent charts', decision: 'Exclude', reason: 'This contract is the first public configure execute request; those controls or surfaces change the acceptance path.' },
            { id: 'Installed Production and visual appearance', decision: 'Defer', reason: 'Standard Development launcher with current compiled assets; screenshots are not authorized.' }
          ]
        };
        globalThis.__backgroundFirstExecution = outcome;
        let evidenceRoot, manifest, extension, uri, sectionId, cdp, startingTabs, startingSettings;
        const subscriptions = [], startingUris = new Set(), startingModels = new Map();
        const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const inputUris = tab => ['uri', 'original', 'modified', 'base', 'input1', 'input2', 'result'].map(key => tab.input?.[key]).filter(value => value instanceof vscode.Uri);
        const tabState = tab => ({ uri: tab.input?.uri?.toString() ?? null, viewType: tab.input?.viewType ?? null, inputType: tab.input?.constructor?.name ?? null, uris: inputUris(tab).map(value => value.toString()), label: tab.label, dirty: tab.isDirty });
        const multiset = states => states.map(state => JSON.stringify({ uri: state.uri, viewType: state.viewType, inputType: state.inputType, uris: state.uris, dirty: state.dirty, nonFileLabel: state.uri ? null : state.label })).sort();
        const activeSurface = () => ({ tab: vscode.window.tabGroups.activeTabGroup.activeTab ? tabState(vscode.window.tabGroups.activeTabGroup.activeTab) : null, viewColumn: vscode.window.tabGroups.activeTabGroup.viewColumn, textEditorUri: vscode.window.activeTextEditor?.document.uri.toString() ?? null });
        const modelState = document => document ? { version: document.version, dirty: document.isDirty, closed: document.isClosed, sha256: hash(document.getText()) } : null;
        const fileState = fileUri => {
          const snapshot = { uri: fileUri.toString(), model: modelState(vscode.workspace.textDocuments.find(document => document.uri.toString() === fileUri.toString())) };
          try {
            const bytes = fs.readFileSync(fileUri.fsPath);
            snapshot.disk = { bytes: bytes.byteLength, sha256: hash(bytes) };
          } catch (error) { snapshot.disk = { readError: error?.code ?? String(error?.message ?? error) }; }
          return snapshot;
        };
        const record = () => {
          if (evidenceRoot) fs.writeFileSync(path.join(evidenceRoot, 'lifecycle.json'), JSON.stringify(outcome, null, 2));
        };
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const observeSurface = reason => {
          const observation = { reason, phase: outcome.phase, utc: new Date().toISOString(), ...activeSurface() };
          outcome.surfaces.push(observation);
          if (uri && !outcome.firstExecutionStartedUtc && tabs().some(tab => tab.isActive && tab.input?.uri?.toString() === uri.toString())) outcome.preExecuteTabSelections.push(observation);
          record();
        };
        const observeDocument = (kind, document, contentChanges = 0) => {
          if (!startingUris.has(document.uri.toString())) return;
          outcome.documentEvents.push({ kind, phase: outcome.phase, utc: new Date().toISOString(), uri: document.uri.toString(), contentChanges, ...modelState(document) });
          record();
        };
        const invoke = async (name, input) => {
          if (input.targetFileUri !== undefined) check(uri && input.targetFileUri === uri.toString() && !startingUris.has(input.targetFileUri), `${name}: only the exact new task URI may be targeted`);
          if (name === 'kusto-workbench_activate-workbench-file') check(outcome.firstSemanticVerdict === 'success', 'No test-driven activation is permitted before the first successful execution');
          const call = { ordinal: outcome.calls.length + 1, phase: outcome.phase, name, input, startedUtc: new Date().toISOString(), elapsedMs: null, textParts: [], parsed: null };
          outcome.calls.push(call);
          record();
          const started = performance.now();
          try {
            const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
            call.textParts = result.content.filter(part => typeof part?.value === 'string').map(part => part.value);
            call.contentKinds = result.content.map(part => part?.constructor?.name ?? typeof part);
            call.rawText = call.textParts.join('\n');
            call.elapsedMs = performance.now() - started;
            record();
            check(call.textParts.length > 0, `${name}: no text response`);
            check(!call.textParts.some(text => /^\s*Error:/i.test(text)), `${name}: ${call.rawText}`);
            try { call.parsed = JSON.parse(call.rawText); }
            catch (error) { throw new Error(`${name}: non-JSON public response: ${call.rawText}`); }
            record();
            return call.parsed;
          } catch (error) {
            call.elapsedMs = performance.now() - started;
            call.error = String(error?.message ?? error);
            record();
            throw error;
          } finally { observeSurface(`${name}:settled`); }
        };
        const disk = async label => {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = new TextDecoder().decode(bytes);
          const file = JSON.parse(text);
          const model = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
          const matchingTabs = tabs().filter(tab => tab.input?.uri?.toString() === uri.toString());
          const section = file.state?.sections?.find(candidate => candidate.id === sectionId) ?? null;
          const snapshot = { label, uri: uri.toString(), bytes: bytes.byteLength, sha256: hash(bytes), modelPresent: !!model, dirty: model?.isDirty ?? null, version: model?.version ?? null, bufferExact: model?.getText() === text, tabs: matchingTabs.map(tabState), section, initialSections: label === 'initial' ? file.state?.sections ?? null : null };
          outcome.evidence.push(snapshot);
          fs.writeFileSync(path.join(evidenceRoot, `${label}-durable.json`), text);
          record();
          check(model && !model.isDirty && model.getText() === text && matchingTabs.length === 1 && !matchingTabs[0].isDirty, `${label}: exact file is not durable and clean`);
          return snapshot;
        };
        const value = cell => cell && typeof cell === 'object' ? cell.full ?? cell.display : cell;
        const assertResult = (section, label) => {
          check(section?.query === outcome.query, `${label}: authored query changed`);
          check(typeof section.resultJson === 'string', `QUALIFICATION_BLOCKED_RESULT_PERSISTENCE: ${label} has no persistable resultJson; existing privacy policy was not changed`);
          const result = JSON.parse(section.resultJson);
          const columns = (result.columns ?? []).map(column => typeof column === 'string' ? column : column.name);
          check(columns.length === 1 && columns[0] === 'Probe' && result.rows?.length === 1 && result.rows[0].length === 1 && Number(value(result.rows[0][0])) === 1, `${label}: canonical result is not exactly Probe=1`);
          const producer = section.resultArtifact?.producer;
          check(producer?.engine === engine && typeof producer.executionId === 'string' && producer.executionId.length > 0, `${label}: real producer execution identity missing`);
          return { columns, row: result.rows[0].map(value), producer, artifact: section.resultArtifact };
        };
        const inspectDom = async label => {
          check(outcome.firstSemanticVerdict === 'success', 'Webview inspection must follow the first semantic verdict');
          const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString();
          check(active === uri.toString(), `${label}: exact task URI is not active`);
          if (!cdp) {
            const cliRequire = modules.createRequire(path.join(manifest.cliRoot, 'package.json'));
            const { CdpClient } = cliRequire(path.join(manifest.cliRoot, 'dist/runner/cdp-client.js'));
            cdp = new CdpClient(manifest.cdpPort);
            await cdp.connect();
          }
          const snapshot = await cdp.evaluateInWebview(`(async () => {
            const section = document.getElementById(${JSON.stringify(sectionId)});
            if (!section || section.tagName.toLowerCase() !== ${JSON.stringify(engine === 'kusto' ? 'kw-query-section' : 'kw-sql-section')}) return null;
            await section.updateComplete;
            const serialized = section.serialize();
            const table = section.querySelector('kw-data-table') || section.shadowRoot?.querySelector('kw-data-table');
            if (table) await table.updateComplete;
            const rectangle = table?.getBoundingClientRect();
            const roots = table ? [table, table.shadowRoot].filter(Boolean) : [];
            const visibleText = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]).filter(element => { const bounds = element.getBoundingClientRect(); return bounds.width > 0 && bounds.height > 0; }).map(element => element.textContent.trim());
            return {
              sectionId: section.id, frameUrl: location.href, frameOrigin: location.origin, title: document.title,
              serialized, tableColumns: table?.columns ?? [], tableRows: table?.rows ?? [], tableArtifactId: table?.resultArtifactId ?? null,
              tableBounds: rectangle ? { width: rectangle.width, height: rectangle.height } : null,
              renderedHeaders: visibleText('th .th-label'), renderedCells: visibleText('td,[role="cell"]')
            };
          })()`, undefined, { timeoutMs: 20000 });
          check(snapshot?.sectionId === sectionId, `${label}: no exact section/frame snapshot`);
          snapshot.label = label;
          snapshot.activeFileUri = active;
          const frameUrl = new URL(snapshot.frameUrl);
          const frames = await cdp.listWebviewFrameContexts();
          snapshot.frameOwners = frames.filter(frame => frame.targetUrl === snapshot.frameUrl);
          snapshot.frameIdentity = { panelId: frameUrl.searchParams.get('id'), mountId: frameUrl.searchParams.get('mountId') };
          outcome.evidence.push(snapshot);
          record();
          check(frameUrl.hostname && snapshot.frameIdentity.panelId && snapshot.frameIdentity.mountId && snapshot.frameOwners.length === 1, `${label}: exact webview frame identity is missing or ambiguous`);
          check(snapshot.serialized?.query === outcome.query, `${label}: authored query changed`);
          const columns = snapshot.tableColumns.map(column => typeof column === 'string' ? column : column.name);
          check(columns.length === 1 && columns[0] === 'Probe' && snapshot.tableRows.length === 1 && snapshot.tableRows[0].length === 1 && Number(value(snapshot.tableRows[0][0])) === 1, `${label}: actual table is not Probe=1`);
          check(snapshot.tableBounds?.width > 0 && snapshot.tableBounds?.height > 0 && snapshot.renderedHeaders.includes('Probe') && snapshot.renderedCells.includes('1'), `${label}: Probe=1 is not rendered in a nonblank table`);
          check(typeof snapshot.tableArtifactId === 'string' && snapshot.tableArtifactId.length > 0, `${label}: rendered table has no canonical artifact identity`);
          return snapshot;
        };
        const listExact = async label => {
          const listed = await invoke('kusto-workbench_list-sections', {});
          const matches = (listed.openFiles ?? []).filter(file => file.uri === uri.toString() || file.logicalUri === uri.toString() || (file.filePath && canonical(file.filePath) === canonical(uri.fsPath)));
          check(matches.length === 1, `SETUP_BLOCKED: ${label} does not list exactly the created file`);
          const file = matches[0];
          const sections = (file.sections ?? []).filter(section => section.type === (engine === 'kusto' ? 'query' : 'sql'));
          check(typeof file.openFileId === 'string' && sections.length === 1 && typeof sections[0].id === 'string', `SETUP_BLOCKED: ${label} has no unique public section identity; no preconfiguration or invented ID is allowed`);
          check(listed.openFiles.filter(candidate => candidate.openFileId === file.openFileId).length === 1, `SETUP_BLOCKED: ${label} has an ambiguous public file identity`);
          outcome.inventory = { ...file, label };
          record();
          return sections[0].id;
        };
        try {
          check(engine === 'kusto' || engine === 'sql', 'SETUP_BLOCKED: KW_FIRST_EXECUTION_ENGINE must be kusto or sql');
          const manifestPath = process.env.KW_FIRST_EXECUTION_MANIFEST;
          check(manifestPath && process.env.KW_FIRST_EXECUTION_MANIFEST_SHA, 'SETUP_BLOCKED: verified launch manifest missing');
          const manifestBytes = fs.readFileSync(manifestPath);
          check(hash(manifestBytes) === process.env.KW_FIRST_EXECUTION_MANIFEST_SHA, 'SETUP_BLOCKED: launch manifest hash differs');
          manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
          const profileName = process.env.KW_FIRST_EXECUTION_PROFILE_NAME ?? `${engine}-auth`;
          check(typeof profileName === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profileName), 'SETUP_BLOCKED: invalid profile name');
          check(manifest.engine === engine && manifest.profileName === profileName && manifest.cdpPort === 59434, 'SETUP_BLOCKED: engine/profile/port manifest mismatch');
          const dedicatedProfile = profileName !== `${engine}-auth`;
          if (dedicatedProfile) {
            extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
            check(extension && canonical(extension.extensionUri.fsPath) === canonical(manifest.extensionRoot), 'SETUP_BLOCKED: actual loaded extension root differs');
            const extensionRoot = fs.realpathSync(extension.extensionUri.fsPath);
            check(canonical(extensionRoot) === canonical(extension.extensionUri.fsPath), 'SETUP_BLOCKED: redirected extension root');
            const profileDir = path.join(extensionRoot, 'tests/vscode-extension-tester/profiles', profileName);
            const userDataDir = path.join(profileDir, 'user-data');
            for (const candidate of [manifest.profilePath, manifest.authoritativeProfilePath]) {
              check(typeof candidate === 'string' && canonical(candidate) === canonical(userDataDir) && canonical(fs.realpathSync(candidate)) === canonical(userDataDir), 'SETUP_BLOCKED: named profile directory differs or is redirected');
            }
            const profileMetadata = path.join(profileDir, 'profile.json');
            if (fs.existsSync(profileMetadata)) check(JSON.parse(fs.readFileSync(profileMetadata, 'utf8')).name === profileName, 'SETUP_BLOCKED: profile metadata name differs');
            if (engine === 'sql') for (const key of ['sqlConnectionId', 'sqlServerUrl', 'sqlDatabase']) check(typeof manifest[key] === 'string' && manifest[key].trim(), 'SETUP_BLOCKED: named SQL profile requires expected target metadata');
          }
          evidenceRoot = fs.mkdtempSync(path.join(manifest.evidenceRoot, `${engine}-lifecycle-`));
          outcome.evidenceRoot = evidenceRoot;
          outcome.query = engine === 'kusto' ? 'print Probe=1' : 'SELECT 1 AS Probe';
          outcome.manifestSha256 = hash(manifestBytes);
          // Clean restored tabs are an accepted I1 state, not fixtures to close or reset.
          startingTabs = tabs();
          outcome.startingTabs = startingTabs.map(tabState);
          outcome.startingActiveSurface = activeSurface();
          for (const tab of startingTabs) for (const tabUri of inputUris(tab)) startingUris.add(tabUri.toString());
          for (const document of vscode.workspace.textDocuments) {
            startingUris.add(document.uri.toString());
            startingModels.set(document.uri.toString(), { document, state: modelState(document) });
          }
          outcome.startingFiles = [...startingUris].map(value => vscode.Uri.parse(value)).filter(value => value.scheme === 'file').map(fileState);
          outcome.startingModels = [...startingModels].map(([fileUri, entry]) => ({ uri: fileUri, ...entry.state }));
          subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs(event => {
              outcome.tabEvents.push({ phase: outcome.phase, utc: new Date().toISOString(), ...Object.fromEntries(['opened', 'closed', 'changed'].map(kind => [kind, event[kind].map(tab => ({ ...tabState(tab), startingOrdinal: startingTabs.indexOf(tab) }))])) });
              observeSurface('tabs-changed');
            }),
            vscode.window.tabGroups.onDidChangeTabGroups(() => observeSurface('groups-changed')),
            vscode.window.onDidChangeActiveTextEditor(() => observeSurface('active-text-editor-changed')),
            vscode.workspace.onDidOpenTextDocument(document => observeDocument('opened', document)),
            vscode.workspace.onDidChangeTextDocument(event => observeDocument('changed', event.document, event.contentChanges.length)),
            vscode.workspace.onWillSaveTextDocument(event => observeDocument('will-save', event.document)),
            vscode.workspace.onDidSaveTextDocument(document => observeDocument('saved', document)),
            vscode.workspace.onDidCloseTextDocument(document => observeDocument('closed', document))
          );
          observeSurface('initial');
          record();
          check(!startingTabs.some(tab => inputUris(tab).length > 0 && tab.isDirty) && ![...startingModels.values()].some(entry => entry.state.dirty), 'SETUP_BLOCKED: pre-existing dirty file is preserved; no save, close or reset is permitted');
          outcome.profileProvenance = { launchPath: manifest.profilePath, realPath: fs.realpathSync(manifest.profilePath), authoritativePath: fs.realpathSync(manifest.authoritativeProfilePath) };
          check(canonical(outcome.profileProvenance.realPath) === canonical(outcome.profileProvenance.authoritativePath), 'SETUP_BLOCKED: exact prepared profile provenance differs');
          extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
          check(extension && canonical(extension.extensionUri.fsPath) === canonical(manifest.extensionRoot), 'SETUP_BLOCKED: actual loaded extension root differs');
          outcome.runtime = { version: vscode.version, appRoot: vscode.env.appRoot, extensionRoot: extension.extensionUri.fsPath, extensionVersion: extension.packageJSON.version, pid: process.pid, parentPid: process.ppid, executable: process.execPath, launchMode: 'Development', productionModeQualified: false };
          check(vscode.version === '1.143.0' && canonical(vscode.env.appRoot) === canonical(manifest.appRoot), 'SETUP_BLOCKED: runtime version or versioned application root differs');
          outcome.runtime.codeSha256 = hash(fs.readFileSync(process.execPath));
          check(outcome.runtime.codeSha256 === manifest.codeSha256, 'SETUP_BLOCKED: actual runtime executable hash differs');
          outcome.loadedBuild = manifest.build.map(entry => ({ path: entry.path, sha256: hash(fs.readFileSync(path.join(extension.extensionUri.fsPath, entry.path))) }));
          check(outcome.loadedBuild.every((entry, index) => entry.sha256 === manifest.build[index].sha256), 'SETUP_BLOCKED: compiled assets changed before activation');
          const exactArgumentFunction = String.raw`
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
            public static class KwFirstExecutionArgv {
              [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CommandLineToArgvW(string line, out int count);
              [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
              public static string[] Parse(string line) {
                if (String.IsNullOrEmpty(line)) return new string[0];
                int count; IntPtr memory = CommandLineToArgvW(line, out count);
                if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                try { string[] result = new string[count]; for (int index = 0; index < count; index++) result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, index * IntPtr.Size)); return result; }
                finally { LocalFree(memory); }
              }
            }';
            function Get-ExactArgument([string]$line, [string]$name) {
              $values=[KwFirstExecutionArgv]::Parse($line); $flag='--'+$name; $count=0; $result=$null;
              for ($index=1; $index -lt $values.Length; $index++) {
                if ($values[$index] -ceq $flag) { $count++; $result=$null; if ($index+1 -lt $values.Length -and !$values[$index+1].StartsWith('--',[StringComparison]::Ordinal)) { $result=$values[$index+1] } }
                elseif ($values[$index].StartsWith($flag+'=',[StringComparison]::Ordinal)) { $count++; $result=$values[$index].Substring($flag.Length+1) }
              }
              if ($count -ne 1 -or [string]::IsNullOrEmpty($result)) { return $null }; return $result;
            };
            function Test-ExactPathArgument([string]$line, [string]$name, [string]$expected) { $value=Get-ExactArgument $line $name; return [string]::Equals(([string]$value).Replace('/','\').TrimEnd('\'), $expected.Replace('/','\').TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) };`;
          const profileMatch = dedicatedProfile ? "(Test-ExactPathArgument $_.CommandLine 'user-data-dir' $target)" : "($_.CommandLine -and $_.CommandLine.Replace('/','\\').IndexOf($target.Replace('/','\\'),[StringComparison]::OrdinalIgnoreCase) -ge 0)";
          const developmentMatch = dedicatedProfile ? "(Test-ExactPathArgument $_.CommandLine 'extensionDevelopmentPath' $root)" : "($_.CommandLine -and $_.CommandLine.Contains('--extensionDevelopmentPath') -and $_.CommandLine.Replace('/','\\').IndexOf($root.Replace('/','\\'),[StringComparison]::OrdinalIgnoreCase) -ge 0)";
          const processScript = `${exactArgumentFunction} $target=${JSON.stringify(manifest.profilePath.replaceAll('\\', '/'))}; $root=${JSON.stringify(manifest.extensionRoot.replaceAll('\\', '/'))}; @(Get-CimInstance Win32_Process -Filter "Name = 'Code.exe'" | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; parent=$_.ParentProcessId; executable=$_.ExecutablePath; profileMatch=${profileMatch}; developmentMatch=${developmentMatch}; cdpMatch=((Get-ExactArgument $_.CommandLine 'remote-debugging-port') -ceq '59434') } }) | ConvertTo-Json -Compress`;
          const processes = JSON.parse(process.getBuiltinModule('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', processScript], { encoding: 'utf8', timeout: 15000 }));
          const ancestry = [];
          let currentPid = process.pid;
          for (let index = 0; index < 12; index++) {
            const current = processes.find(candidate => candidate.pid === currentPid);
            if (!current) break;
            ancestry.push(current);
            currentPid = current.parent;
          }
          outcome.runtime.ancestry = ancestry;
          check(ancestry.some(candidate => candidate.profileMatch && candidate.developmentMatch && (!dedicatedProfile || candidate.cdpMatch)), 'SETUP_BLOCKED: actual Code ancestry does not prove the exact isolated profile and Development root');
          startingSettings = fs.readFileSync(path.join(manifest.profilePath, 'User/settings.json'));
          await extension.activate();
          const sqlite = process.getBuiltinModule('node:sqlite');
          check(sqlite?.DatabaseSync, 'SETUP_BLOCKED: read-only saved-selection reader unavailable');
          const database = new sqlite.DatabaseSync(path.join(manifest.profilePath, 'User/globalStorage/state.vscdb'), { readOnly: true });
          let selection;
          try {
            const row = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(extension.id.toLowerCase());
            const state = row ? JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')) : {};
            selection = { connectionId: state[`${engine}.lastConnectionId`] ?? null, database: state[`${engine}.lastDatabase`] ?? null, favorites: engine === 'sql' && Array.isArray(state['sql.favorites']) ? state['sql.favorites'].map(favorite => ({ connectionId: favorite.connectionId, database: favorite.database })) : [] };
          } finally { database.close(); }
          outcome.savedSelection = selection;
          const connections = (await invoke(engine === 'kusto' ? 'kusto-workbench_list-connections' : 'kusto-workbench_list-sql-connections', {})).connections ?? [];
          const favorites = engine === 'kusto' ? (await invoke('kusto-workbench_list-favorites', {})).favorites ?? [] : selection.favorites;
          const selected = selection.connectionId ? connections.filter(connection => connection.id === selection.connectionId) : connections;
          check(selected.length === 1, 'SETUP_BLOCKED: saved target is missing or ambiguous; profile and query state remain untouched');
          const connection = selected[0];
          const candidates = [...new Set(favorites.filter(favorite => favorite.connectionId === connection.id && typeof favorite.database === 'string' && favorite.database.trim()).map(favorite => favorite.database))];
          let defaultDatabase = connection.database;
          if (dedicatedProfile && engine === 'sql' && !defaultDatabase) {
            const snapshotPath = path.join(manifest.profilePath, 'User/globalStorage', extension.id.toLowerCase(), 'sql-connections.v1.json');
            if (fs.existsSync(snapshotPath)) {
              const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
              check(snapshot.schemaVersion === 1 && Array.isArray(snapshot.connections), 'SETUP_BLOCKED: SQL default metadata is invalid');
              const defaults = snapshot.connections.filter(candidate => candidate.id === connection.id && candidate.serverUrl === connection.serverUrl);
              check(defaults.length === 1, 'SETUP_BLOCKED: SQL default metadata does not identify the public connection');
              if (typeof defaults[0].database === 'string' && defaults[0].database.trim()) defaultDatabase = defaults[0].database;
            }
          }
          const databaseName = selection.connectionId === connection.id && typeof selection.database === 'string' && selection.database.trim() ? selection.database : defaultDatabase || (candidates.length === 1 ? candidates[0] : null);
          check(typeof databaseName === 'string' && databaseName.trim(), 'SETUP_BLOCKED: no unambiguous existing saved/default/favorite database');
          if (dedicatedProfile && engine === 'sql') check(connection.id === manifest.sqlConnectionId && connection.serverUrl === manifest.sqlServerUrl && databaseName === manifest.sqlDatabase, 'SETUP_BLOCKED: named SQL profile selection differs from the approved target');
          outcome.target = { connectionId: connection.id, database: databaseName, ...(engine === 'kusto' ? { clusterUrl: connection.clusterUrl } : { serverUrl: connection.serverUrl }) };
          record();
          const fileType = engine === 'kusto' ? 'kqlx' : 'sqlx';
          const filePath = path.join(evidenceRoot, 'probe');
          uri = vscode.Uri.file(`${filePath}.${fileType}`);
          check(!fs.existsSync(uri.fsPath) && !startingUris.has(uri.toString()) && !tabs().some(tab => inputUris(tab).some(candidate => candidate.toString() === uri.toString())), 'SETUP_BLOCKED: task URI must be new and unique');
          outcome.fileUri = uri.toString();
          outcome.phase = 'create';
          const created = await invoke('kusto-workbench_create-file', { fileType, filePath, initialContent: outcome.query, reveal: false });
          check(created.success === true && canonical(created.filePath) === canonical(uri.fsPath), 'SETUP_BLOCKED: CREATE did not return the exact task file');
          const initialSave = await invoke('kusto-workbench_save-workbench-file', { targetFileUri: uri.toString() });
          check(initialSave.success === true, 'SETUP_BLOCKED: initial exact SAVE failed');
          sectionId = await listExact('after-initial-save');
          outcome.sectionId = sectionId;
          const initial = await disk('initial');
          // Initial CREATE may omit the durable ID; execution still uses only the exact LIST identity.
          check(initial.initialSections?.length === 1 && initial.initialSections[0].type === (engine === 'kusto' ? 'query' : 'sql') && initial.initialSections[0].query === outcome.query && !initial.initialSections[0].resultJson && !initial.initialSections[0].resultArtifact && (initial.initialSections[0].id === undefined || initial.initialSections[0].id === sectionId), 'SETUP_BLOCKED: initial file is not the exact result-free constant query');
          observeSurface('before-first-execute');
          outcome.beforeFirstExecution = { publicCalls: outcome.calls.map(call => call.name), cdpConnected: !!cdp, observedTabSelections: outcome.preExecuteTabSelections.length, focusQualification: 'Programmatic tab selection is observed, not equated with user activation or focus; no activation/DOM helper has run' };
          check(!cdp && !outcome.calls.some(call => call.name === 'kusto-workbench_activate-workbench-file'), 'FIRST_EXECUTION_PRECONDITION_FAILED: a test helper activated or inspected the task file before execution');
          outcome.phase = 'first-execute';
          const configure = engine === 'kusto' ? 'kusto-workbench_configure-query-section' : 'kusto-workbench_configure-sql-section';
          outcome.firstExecutionStartedUtc = new Date().toISOString();
          const first = await invoke(configure, { targetFileUri: uri.toString(), sectionId, ...outcome.target, execute: true });
          outcome.firstSemanticVerdict = first.success === true ? 'success' : 'failure';
          outcome.firstExecutionSurfaceBeforeInspection = activeSurface();
          record();
          check(first.success === true, `FIRST_EXECUTION_FAILED: ${JSON.stringify(first)}`);
          outcome.phase = 'first-dom';
          const activated = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: uri.toString() });
          check(activated.success === true, 'First result inspection could not activate the exact task file');
          const firstDom = await inspectDom('first-live');
          outcome.phase = 'first-save';
          const saved = await invoke('kusto-workbench_save-workbench-file', { targetFileUri: uri.toString() });
          check(saved.success === true, 'First result SAVE failed');
          const firstDisk = assertResult((await disk('first-save')).section, 'first-save');
          assert.equal(firstDisk.artifact.artifactId, firstDom.tableArtifactId, 'First SAVE producer does not own the rendered result');
          outcome.firstProducer = firstDisk.producer;
          outcome.phase = 'close-reopen';
          const closed = await invoke('kusto-workbench_close-workbench-file', { targetFileUri: uri.toString() });
          check(closed.success === true && !tabs().some(tab => tab.input?.uri?.toString() === uri.toString()), 'Exact clean close failed');
          const reopened = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: uri.toString() });
          check(reopened.success === true, 'Exact URI reopen failed');
          check(await listExact('after-reopen') === sectionId, 'Reopen changed the public section identity');
          const restored = await inspectDom('restored-live');
          const restoredDisk = assertResult((await disk('restored')).section, 'restored');
          assert.equal(restoredDisk.producer.executionId, firstDisk.producer.executionId, 'Restore lost the saved producer');
          assert.equal(restoredDisk.artifact.artifactId, restored.tableArtifactId, 'Restored table and canonical saved producer differ');
          outcome.restoredProducer = restoredDisk.producer;
          outcome.phase = 'second-execute';
          const second = await invoke(configure, { targetFileUri: uri.toString(), sectionId, execute: true });
          outcome.secondSemanticVerdict = second.success === true ? 'success' : 'failure';
          record();
          check(second.success === true, `SECOND_EXECUTION_FAILED: ${JSON.stringify(second)}`);
          const secondDom = await inspectDom('second-live');
          outcome.phase = 'second-save';
          const secondSave = await invoke('kusto-workbench_save-workbench-file', { targetFileUri: uri.toString() });
          check(secondSave.success === true, 'Second result SAVE failed');
          const secondDisk = assertResult((await disk('second-save')).section, 'second-save');
          assert.equal(secondDisk.artifact.artifactId, secondDom.tableArtifactId, 'Second SAVE producer does not own the rendered result');
          check(secondDisk.producer.executionId !== restoredDisk.producer.executionId, 'Second execution reused the restored producer identity; a stale table is not success');
          outcome.secondProducer = secondDisk.producer;
          outcome.classification = 'PASS_DOM_DISK_NOT_VISUAL_OR_INSTALLED_PRODUCTION';
        } catch (error) {
          const message = String(error?.message ?? error);
          outcome.errors.push({ phase: outcome.phase, message, stack: String(error?.stack ?? '') });
          if (outcome.phase === 'first-execute' && !outcome.firstSemanticVerdict) outcome.firstSemanticVerdict = 'error';
          if (outcome.phase === 'second-execute' && !outcome.secondSemanticVerdict) outcome.secondSemanticVerdict = 'error';
          outcome.classification = /QUALIFICATION_BLOCKED/.test(message) ? 'QUALIFICATION_BLOCKED' : /^SETUP_BLOCKED/.test(message) || ['setup', 'create'].includes(outcome.phase) ? 'SETUP_BLOCKED' : 'LIVE_OPERATION_OR_ORACLE_FAILED';
          const last = outcome.calls.at(-1);
          outcome.firstFailure = { phase: outcome.phase, elapsedMs: last?.elapsedMs ?? null, route: last?.name ?? null, message, category: /auth|sign.in|credential|login/i.test(message) ? 'authentication' : /network|socket|ENOTFOUND|ECONN|connection.*timed out/i.test(message) ? 'network' : /ready|owner|live|dispatcher|projection|context|target/i.test(message) ? 'route-or-readiness' : 'unclassified' };
          record();
        } finally {
          cdp?.disconnect();
          outcome.primaryClassification = outcome.classification;
          const cleanupErrors = [];
          try {
            if (uri) {
              const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
              if (document?.isDirty && evidenceRoot) fs.writeFileSync(path.join(evidenceRoot, 'retained-dirty-buffer.json'), document.getText());
              const taskTabs = tabs().filter(tab => tab.input?.uri?.toString() === uri.toString() && !startingTabs?.includes(tab));
              if (taskTabs.length && taskTabs.every(tab => !tab.isDirty) && !document?.isDirty) {
                const closed = await invoke('kusto-workbench_close-workbench-file', { targetFileUri: uri.toString() });
                check(closed.success === true, 'Exact cleanup close failed');
              }
            }
          } catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
          if (startingTabs) {
            const retained = tabs().filter(tab => startingTabs.includes(tab));
            outcome.preservation = { startingCount: startingTabs.length, retainedStartingCount: retained.length, finalTabCount: tabs().length, initialMultiset: multiset(outcome.startingTabs), finalStartingMultiset: multiset(retained.map(tabState)), closedStartingTabs: outcome.tabEvents.flatMap(event => event.closed).filter(tab => tab.startingOrdinal >= 0), dirtyStartingTabEvents: outcome.tabEvents.flatMap(event => event.changed).filter(tab => tab.startingOrdinal >= 0 && tab.dirty !== outcome.startingTabs[tab.startingOrdinal].dirty), finalFiles: outcome.startingFiles.map(snapshot => fileState(vscode.Uri.parse(snapshot.uri))), finalActiveSurface: activeSurface(), focusRestoration: 'No arbitrary focus command; only exact task-file operations' };
            try {
              check(retained.length === startingTabs.length && outcome.preservation.closedStartingTabs.length === 0, 'A pre-existing tab was closed');
              assert.deepEqual(outcome.preservation.finalStartingMultiset, outcome.preservation.initialMultiset, 'Starting tab URI/view type/dirty multiset changed');
              check(outcome.preservation.dirtyStartingTabEvents.length === 0, 'A pre-existing tab changed dirty state');
              check(!outcome.documentEvents.some(event => event.contentChanges > 0 || event.dirty || ['will-save', 'saved'].includes(event.kind)), 'A pre-existing document was edited, dirtied or saved');
            } catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
            for (const [index, snapshot] of outcome.startingFiles.entries()) {
              try { assert.deepEqual(outcome.preservation.finalFiles[index].disk, snapshot.disk, `Pre-existing file bytes changed: ${snapshot.uri}`); }
              catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
            }
            outcome.preservation.finalModels = [];
            for (const [fileUri, entry] of startingModels) {
              const current = vscode.workspace.textDocuments.find(document => document.uri.toString() === fileUri);
              const snapshot = { uri: fileUri, sameModel: current === entry.document, state: modelState(current) };
              outcome.preservation.finalModels.push(snapshot);
              try {
                check(snapshot.sameModel, `Pre-existing document model replaced or closed: ${fileUri}`);
                assert.deepEqual(snapshot.state, entry.state, `Pre-existing document version/dirty/text changed: ${fileUri}`);
              } catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
            }
          }
          try {
            if (manifest && startingSettings) check(hash(fs.readFileSync(path.join(manifest.profilePath, 'User/settings.json'))) === hash(startingSettings), 'Isolated profile settings changed during the scenario');
            if (manifest && extension) {
              outcome.afterBuild = manifest.build.map(entry => ({ path: entry.path, sha256: hash(fs.readFileSync(path.join(extension.extensionUri.fsPath, entry.path))) }));
              check(outcome.afterBuild.every((entry, index) => entry.sha256 === manifest.build[index].sha256), 'Compiled assets changed during the scenario');
            }
          } catch (error) { cleanupErrors.push(String(error?.message ?? error)); }
          for (const subscription of subscriptions) subscription.dispose();
          outcome.cleanup = { errors: cleanupErrors, startingTabCount: startingTabs?.length ?? null, finalTabCount: tabs().length, retainedStartingTabCount: startingTabs ? tabs().filter(tab => startingTabs.includes(tab)).length : null, taskTabsRemaining: uri ? tabs().filter(tab => tab.input?.uri?.toString() === uri.toString()).length : 0, tabs: tabs().map(tabState), taskDirty: !!uri && vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty), filesRetained: true, subscriptionsDisposed: subscriptions.length };
          if (cleanupErrors.length || (outcome.classification.startsWith('PASS_') && outcome.cleanup.tabs.some(tab => tab.uri === uri?.toString()))) outcome.classification = 'PRESERVATION_OR_CLEANUP_FAILED';
          record();
        }
        return outcome;
      })()
      """
    Then I collect JSON artifact "background-first-execution-verdict" from extension host expression:
      """
      (() => {
        const outcome = globalThis.__backgroundFirstExecution;
        if (outcome?.classification !== 'PASS_DOM_DISK_NOT_VISUAL_OR_INSTALLED_PRODUCTION') throw new Error(JSON.stringify({ classification: outcome?.classification, firstFailure: outcome?.firstFailure, cleanup: outcome?.cleanup, evidenceRoot: outcome?.evidenceRoot }));
        return { classification: outcome.classification, engine: outcome.engine, fileUri: outcome.fileUri, firstProducer: outcome.firstProducer, restoredProducer: outcome.restoredProducer, secondProducer: outcome.secondProducer, cleanup: outcome.cleanup, qualification: outcome.qualification };
      })()
      """