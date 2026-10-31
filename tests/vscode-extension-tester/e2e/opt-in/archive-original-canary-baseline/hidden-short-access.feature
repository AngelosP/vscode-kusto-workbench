# Launch only this feature from a private staging directory with --no-build --vscode-version 1.143.0.
# Use --controller-port 59423 --cdp-port 59424 --vscode-arg=--log=trace --timeout 240000; never attach.
# KW_HIDDEN_SHORT_MANIFEST and KW_HIDDEN_SHORT_MANIFEST_SHA identify an immutable runtime copy.
# C1 Include: original bytes -> public activation -> exact notes THEN valid dashboard -> hide using archived target 1.
# C2 Include: retain exact mixed prefix 1-19 -> notes THEN dashboard -> prefix 20-32 -> notes THEN dashboard.
# C3 Include on first failure: one ordinary activation -> first same notes/dashboard calls, with no inventory.
# Owners: LM tools, native/compatibility editor activation, startup/projection, hidden tool session, saved artifacts.
# Existing archive-original-canary-baseline covers only initial readiness against older archive metadata.
# Defer: original109 with 16 warm tabs, prepared-profile fidelity, Save/reopen, physical execution and full SDK/ACK proof.
# SDK tab events do not prove continuous WebviewPanel.visible or renderer visibility. No title-targeted CDP or images.
# All reads succeeding means NOT_REPRODUCED_SHORT_RUN, never PASS_OUTAGE_FIXED. No profile settings are changed.
# KW_HIDDEN_ACCESS_PROLONGED=1 selects the October 30 archive, its 13 warm files and all 109 targets.
# That opt-in requires Code 1.144.0 and --timeout 3600000, retains the canary for 2300 seconds,
# uses exact URI-targeted reads, and always checks one ordinary activation after the full hidden pair.
# KW_HIDDEN_ACCESS_DIAGNOSTIC_SECONDS shortens only a diagnostic run, never the full qualification.
# KW_HIDDEN_ACCESS_DIAGNOSTIC_TARGETS limits an allocation-profiling run before renderer loss.
# KW_HIDDEN_ACCESS_DIAGNOSTIC_PAUSE_SECONDS leaves a bounded read-only inspection window after recovery.
Feature: Archived canary hidden access

  Scenario: Original notes and dashboard survive retained hidden access and ordinary recovery
    Given I collect JSON artifact "hidden-short-access-evidence" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const os = process.getBuiltinModule('node:os');
        const modules = process.getBuiltinModule('node:module');
        const url = process.getBuiltinModule('node:url');
        const assert = process.getBuiltinModule('node:assert/strict');
        const equal = process.getBuiltinModule('node:util').isDeepStrictEqual;
        const hash = bytes => process.getBuiltinModule('node:crypto').createHash('sha256').update(bytes).digest('hex');
        const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        const prolonged = process.env.KW_HIDDEN_ACCESS_PROLONGED === '1';
        const diagnosticSeconds = process.env.KW_HIDDEN_ACCESS_DIAGNOSTIC_SECONDS === undefined
          ? undefined : Number(process.env.KW_HIDDEN_ACCESS_DIAGNOSTIC_SECONDS);
        const diagnosticPauseSeconds = Number(process.env.KW_HIDDEN_ACCESS_DIAGNOSTIC_PAUSE_SECONDS ?? 0);
        const diagnosticTargets = Number(process.env.KW_HIDDEN_ACCESS_DIAGNOSTIC_TARGETS ?? 109);
        const hiddenDurationMs = (diagnosticSeconds ?? 2300) * 1000;
        const archive = path.join(os.tmpdir(), prolonged
          ? 'kw-regression-before-2026-10-30-6539ac42be5b48c68c183e8aac12e0ac.zip'
          : 'kw-regression-build2-before-2026-10-20-500ddb040c5b4dcf87630e2d488f4112.zip');
        const archiveSha256 = prolonged
          ? 'b1d340688c700060f8368450bd0df94a7fe1db0b192ec8031a2de11d32a8f3a2'
          : 'f743e4f9be3e2470301a5ef9b0b0961022f5fdf8a3be8355a6f912ab5e82d9b3';
        const canaryPath = 'extension-regression-2026-10-07.kqlx';
        const canarySha256 = 'eeafb29fdb57398dbb6e2a83a7aec0fd5b2cc658f12e156f671fdfee144f51e0';
        const htmlId = 'html_1791393873620';
        const noteId = 'dn_1791393497188_yncr7k';
        const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const tabSnapshot = () => vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ uri: tab.input?.uri?.toString() ?? null, viewType: tab.input?.viewType ?? tab.input?.constructor?.name ?? null, dirty: tab.isDirty, active: tab.isActive, groupActive: group.isActive, column: group.viewColumn, preview: tab.isPreview })));
        const previous = globalThis.__hiddenShortAccess;
        const outcome = { classification: 'SETUP_BLOCKED', calls: [], pairs: [], activations: [], tabEvents: [], documentEvents: [], damage: [], saved: [], pinActions: [], checks: {}, errors: [], limits: ['Only prefixes 1-19 and 20-32; not original109 with 16 warm tabs', 'Development runtime copy, not the incident loaded-memory image or installed Production build', 'SDK tab events/active flags do not prove continuous WebviewPanel.visible or renderer visibility', 'Standard startup Trace is not correlated SDK send/receipt/ACK evidence', 'No query/auth tools requested; no claim of instrumented absence of every physical execution or network request', 'No screenshot or image review; no forced Auto Save setting, Save/reopen or authoring coverage'] };
        outcome.prolonged = prolonged;
        outcome.diagnosticSeconds = diagnosticSeconds;
        outcome.diagnosticTargets = diagnosticTargets;
        outcome.warmActivations = [];
        outcome.activationFailures = [];
        outcome.retainedSamples = [];
        if (prolonged) outcome.limits[0] = 'October 30 exact archived bytes, 13 warm files and original109; isolated profile is not the original dogfood account/session state';
        globalThis.__hiddenShortAccess = outcome;
        const references = new Map();
        const retainedUris = new Set();
        const models = new Map();
        const subscriptions = [];
        const startingDocuments = [];
        let phase = 'setup', extension, manifest, main, helper, owner, evidenceRoot, canaryUri, openFileId, expectedNotes, factColumns, hidden = false, hiddenStart, failure, workbenchRequire, measurementStart;
        const write = (name, value) => {
          if (!evidenceRoot) return;
          helper.assertAcceptanceRoot(owner);
          fs.writeFileSync(path.join(evidenceRoot, name + '.json'), JSON.stringify(value, null, 2));
        };
        const safeRelative = relative => {
          assert.equal(typeof relative, 'string');
          assert.equal(!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(relative) || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)), false, 'Unsafe archived or runtime path');
          return relative;
        };
        const sampleTabs = trigger => {
          const snapshot = tabSnapshot();
          const record = { trigger, phase, atUtc: new Date().toISOString(), monotonicMs: performance.now(), hidden, tabs: snapshot };
          outcome.tabEvents.push(record);
          if (hidden && snapshot.some(tab => tab.uri === canaryUri && tab.active)) outcome.visibilityViolation ??= record;
          for (const tab of snapshot) if (references.has(tab.uri) && tab.dirty) outcome.damage.push({ phase, trigger, uri: tab.uri, reason: 'dirty-tab' });
          return snapshot;
        };
        const checkStartingDocuments = event => {
          let unchanged = true;
          for (const entry of startingDocuments) {
            if (entry.frameworkEmptyInput) {
              const inputs = vscode.workspace.textDocuments.filter(document => document.uri.toString() === entry.uri && !document.isClosed);
              if (inputs.some(document => document.languageId !== 'plaintext' || document.isDirty || document.getText() !== '')) {
                unchanged = false;
                outcome.damage.push({ event, uri: entry.uri, reason: 'framework-input-content-changed' });
              }
              continue;
            }
            const document = entry.document;
            const current = vscode.workspace.textDocuments.includes(document) && document.isClosed !== true
              && document.uri.toString() === entry.uri && document.version === entry.version
              && document.isDirty === entry.dirty && hash(document.getText()) === entry.bufferSha256;
            let sameFile = true;
            if (entry.fileSha256 !== undefined) {
              try { sameFile = hash(fs.readFileSync(entry.file)) === entry.fileSha256; } catch { sameFile = false; }
            }
            if (!current || !sameFile) {
              unchanged = false;
              outcome.damage.push({ event, uri: entry.uri, reason: 'starting-document-changed' });
            }
          }
          return unchanged;
        };
        const sampleDocument = (document, event) => {
          const uri = document.uri.toString();
          checkStartingDocuments(event);
          if (!references.has(uri)) return;
          if (!models.has(document)) {
            if ([...models.values()].some(model => model.uri === uri)) outcome.damage.push({ phase, uri, reason: 'model-replaced' });
            models.set(document, { uri, version: document.version });
          }
          const observation = { phase, event, uri, version: document.version, dirty: document.isDirty, atUtc: new Date().toISOString() };
          outcome.documentEvents.push(observation);
          if (document.version !== 1 || document.version !== models.get(document).version || document.isDirty) outcome.damage.push(observation);
        };
        const preservation = label => {
          helper.assertAcceptanceRoot(owner);
          const files = [];
          for (const reference of references.values()) {
            const stat = fs.lstatSync(reference.file);
            const actual = { path: reference.path, bytes: stat.size, sha256: hash(fs.readFileSync(reference.file)) };
            actual.unchanged = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && canonical(fs.realpathSync.native(reference.file)) === canonical(reference.file) && actual.bytes === reference.bytes && actual.sha256 === reference.sha256 && stat.mtimeMs === reference.mtimeMs;
            files.push(actual);
            if (!actual.unchanged) outcome.damage.push({ label, ...actual });
          }
          for (const [document, model] of models) {
            sampleDocument(document, label);
            if (document.getText() !== references.get(model.uri).text) outcome.damage.push({ label, uri: model.uri, reason: 'buffer-changed' });
          }
          sampleTabs(label);
          const result = { label, files, passed: outcome.damage.length === 0 && outcome.saved.length === 0 };
          write(label, result);
          return result;
        };
        const verifyFrozenBuild = () => {
          assert.equal(manifest.runtimeStableDuringCopy, true);
          assert.equal(canonical(extension.extensionPath), canonical(manifest.extensionRoot));
          if (manifest.runtimeMode === 'verified-workspace') {
            assert.equal(prolonged, true, 'Workspace runtime is only supported by the opt-in prolonged replay');
            assert.equal(canonical(extension.extensionPath), canonical(manifest.sourceRoot));
          } else {
            assert.notEqual(canonical(extension.extensionPath), canonical(manifest.sourceRoot));
          }
          for (const file of manifest.files) {
            const target = path.join(extension.extensionPath, safeRelative(file.path));
            const stat = fs.lstatSync(target);
            assert.equal(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && canonical(fs.realpathSync.native(target)) === canonical(target), true, 'Aliased runtime asset');
            assert.equal(stat.size, file.bytes, 'Frozen runtime size changed: ' + file.path);
            assert.equal(hash(fs.readFileSync(target)), file.sha256, 'Frozen runtime changed: ' + file.path);
          }
          return { root: extension.extensionPath, mainSha256: hash(fs.readFileSync(main)), fileCount: manifest.files.length, runtimeMode: manifest.runtimeMode ?? 'frozen-copy' };
        };
        const readArchive = wanted => new Promise((resolve, reject) => {
          modules.createRequire(path.join(manifest.sourceRoot, 'package.json'))('yauzl').open(archive, { lazyEntries: true }, (error, zip) => {
            if (error) return reject(error);
            const entries = new Map();
            const fail = failure => { zip.close(); reject(failure); };
            zip.on('error', fail);
            zip.on('end', () => entries.size === wanted.size ? resolve(entries) : reject(new Error('Requested archive member missing')));
            zip.on('entry', entry => {
              if (!wanted.has(entry.fileName)) { zip.readEntry(); return; }
              const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
              if (entries.has(entry.fileName) || entry.uncompressedSize > 64 * 1024 * 1024 || unixType !== 0 && unixType !== 0x8000) { fail(new Error('Duplicate, linked, or oversized archive member')); return; }
              zip.openReadStream(entry, (error, stream) => {
                if (error) { fail(error); return; }
                const chunks = [];
                stream.on('error', fail);
                stream.on('data', chunk => chunks.push(chunk));
                stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
              });
            });
            zip.readEntry();
          });
        });
        const invoke = async (name, input) => {
          const record = { sequence: outcome.calls.length + 1, phase, name, input, startedUtc: new Date().toISOString(), startedMonotonicMs: performance.now(), hidden, hiddenElapsedMs: hidden ? performance.now() - hiddenStart : null, tabsBefore: sampleTabs('before-call') };
          outcome.calls.push(record);
          write('call-' + record.sequence + '-started', record);
          try {
            assert.equal(diagnosticSeconds === undefined || prolonged && Number.isInteger(diagnosticSeconds) && diagnosticSeconds >= 0 && diagnosticSeconds < 2300, true, 'Invalid diagnostic duration');
            assert.equal(Number.isInteger(diagnosticPauseSeconds) && diagnosticPauseSeconds >= 0 && diagnosticPauseSeconds <= 300, true, 'Invalid diagnostic inspection window');
            assert.equal(Number.isInteger(diagnosticTargets) && diagnosticTargets >= 20 && diagnosticTargets <= 109
              && (diagnosticTargets === 109 || prolonged && diagnosticSeconds !== undefined), true, 'Limited load is diagnostic only');
            record.raw = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
            record.textParts = (record.raw.content ?? []).filter(part => typeof part?.value === 'string').map(part => part.value);
            record.allText = record.textParts.join('\n');
            try { record.value = JSON.parse(record.allText); } catch (error) { record.parseError = String(error?.message ?? error); }
          } catch (error) { record.transportError = String(error?.message ?? error); }
          record.elapsedMs = performance.now() - record.startedMonotonicMs;
          record.finishedUtc = new Date().toISOString();
          record.tabsAfter = sampleTabs('after-call');
          record.complete = true;
          write('call-' + record.sequence + '-response', record);
          return record;
        };
        const notesOracle = record => !record.transportError && !record.parseError && record.value?.success === true && equal(record.value.notes, expectedNotes);
        const dashboardOracle = record => {
          const value = record.value;
          return !record.transportError && !record.parseError && value?.success === true && value.valid === true && value.sectionId === htmlId && value.hasProvenance === true && value.bindingCount === 6 && value.dataSourceCount === 1 && equal(value.issues, []) && equal(value.warnings, []) && equal(value.diagnostics, []) && equal(value.factColumns, factColumns) && typeof value.filePath === 'string' && canonical(value.filePath) === canonical(vscode.Uri.parse(canaryUri).fsPath) && value.fileName === canaryPath;
        };
        const pair = async label => {
          const target = prolonged ? { targetFileUri: canaryUri } : { openFileId };
          phase = label + '-notes';
          const notes = await invoke('kusto-workbench_manage-development-notes', { action: 'view', ...target });
          phase = label + '-dashboard';
          const dashboard = await invoke('kusto-workbench_validate-html-dashboard', { sectionId: htmlId, ...target });
          const result = { label, notesSequence: notes.sequence, dashboardSequence: dashboard.sequence, notesPassed: notesOracle(notes), dashboardPassed: dashboardOracle(dashboard), hidden, noInventoryBeforeReads: true };
          result.passed = result.notesPassed && result.dashboardPassed;
          outcome.pairs.push(result);
          write(label + '-pair', result);
          return result;
        };
        const assertHidden = () => {
          const exact = tabs().filter(tab => tab.input?.uri?.toString() === canaryUri);
          assert.equal(exact.length, 1, 'Canary must remain open');
          assert.equal(exact[0].isActive, false, 'Canary unexpectedly became active');
          assert.equal(outcome.visibilityViolation, undefined, 'SDK observed a canary activation during the hidden arm');
        };
        const retainActive = async uri => {
          const exact = tabs().filter(tab => tab.input?.uri?.toString() === uri);
          assert.equal(exact.length, 1, 'Activated target must have exactly one native tab');
          assert.equal(exact[0].isActive, true, 'Activated target is not active');
          if (exact[0].isPreview) {
            outcome.pinActions.push({ phase, uri, command: 'workbench.action.keepEditor' });
            await vscode.commands.executeCommand('workbench.action.keepEditor');
            assert.equal(exact[0].isPreview, false, 'Native Keep Open did not retain the target');
          }
          retainedUris.add(uri);
        };
        try {
          assert.equal(previous, undefined, 'One short trial per fresh launch');
          assert.equal(process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH, undefined, 'Do not use suite reset dispatch');
          assert.equal(vscode.version, prolonged ? '1.144.0' : '1.143.0', 'Wrong Code version is setup failure, not a causal red');
          assert.equal(vscode.env.logLevel, vscode.LogLevel.Trace, 'Enable Trace at startup');
          extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
          assert.ok(extension, 'Workbench extension missing');
          outcome.initialTabs = tabSnapshot();
          if (process.env.KW_HIDDEN_ACCESS_REQUIRE_EMPTY_PROFILE === '1') {
            assert.equal(outcome.initialTabs.length, 0, 'SETUP_BLOCKED: allocation profile must have no restored tabs');
          }
          assert.equal(outcome.initialTabs.some(tab => tab.dirty), false, 'SETUP_BLOCKED: dirty starting tab must remain untouched');
          assert.equal(vscode.workspace.textDocuments.some(document => document.isDirty), false, 'SETUP_BLOCKED: dirty starting document must remain untouched');
          for (const document of vscode.workspace.textDocuments) {
            const file = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
            const frameworkEmptyInput = document.uri.toString() === 'chatSessionInput:input-0'
              && document.languageId === 'plaintext' && !document.isDirty && document.getText() === '';
            startingDocuments.push({ document, uri: document.uri.toString(), version: document.version, dirty: document.isDirty, frameworkEmptyInput,
              bufferSha256: hash(document.getText()), file,
              fileSha256: file && fs.existsSync(file) ? hash(fs.readFileSync(file)) : undefined });
          }
          outcome.startingDocuments = startingDocuments.map(({ document, ...entry }) => entry);
          outcome.extensionAlreadyActive = extension.isActive;
          const manifestBytes = fs.readFileSync(process.env.KW_HIDDEN_SHORT_MANIFEST);
          assert.equal(hash(manifestBytes), process.env.KW_HIDDEN_SHORT_MANIFEST_SHA, 'Frozen manifest changed');
          manifest = JSON.parse(manifestBytes);
          const folders = vscode.workspace.workspaceFolders ?? [];
          if (manifest.workspaceRoot) {
            assert.equal(folders.length, 1, 'Expected the isolated empty workspace');
            assert.equal(canonical(folders[0].uri.fsPath), canonical(manifest.workspaceRoot), 'Wrong profiling workspace');
            assert.deepEqual(fs.readdirSync(manifest.workspaceRoot), [], 'Profiling workspace must start empty');
          } else {
            assert.equal(folders.length, 0, 'Use an empty isolated test window');
          }
          if (manifest.runtimeMode === 'verified-workspace') outcome.limits[1] = 'Development workspace runtime hashed before and after the replay; not an installed Production build or proof of the incident loaded-memory image';
          main = path.resolve(extension.extensionPath, extension.packageJSON.main);
          workbenchRequire = modules.createRequire(main);
          outcome.build = verifyFrozenBuild();
          outcome.runtime = { vscode: vscode.version, node: process.version, pid: process.pid, ppid: process.ppid, execPath: process.execPath, appRoot: vscode.env.appRoot, extensionVersion: extension.packageJSON.version, logLevel: vscode.env.logLevel, manifestPath: process.env.KW_HIDDEN_SHORT_MANIFEST, manifestSha256: hash(manifestBytes) };
          outcome.settings = { autoSave: vscode.workspace.getConfiguration('files').get('autoSave'), autoSaveDelay: vscode.workspace.getConfiguration('files').get('autoSaveDelay'), enablePreview: vscode.workspace.getConfiguration('workbench.editor').get('enablePreview'), changed: false };
          helper = await import(url.pathToFileURL(path.join(extension.extensionPath, 'scripts/repro-published-notebook.mjs')).href);
          owner = helper.createAcceptanceRoot();
          evidenceRoot = path.join(owner.root, 'evidence');
          fs.mkdirSync(evidenceRoot);
          outcome.evidenceRoot = evidenceRoot;
          write('initial', outcome);
          assert.equal(hash(fs.readFileSync(archive)), archiveSha256, 'Immutable archive hash mismatch');
          const orderEntry = prolonged ? 'evidence/prolonged-load-protocol.json' : 'evidence/verified-prequalification-ledger.json';
          const metadata = await readArchive(new Set(['baseline.json', orderEntry]));
          const baseline = JSON.parse(metadata.get('baseline.json'));
          const order = JSON.parse(metadata.get(orderEntry));
          const sweep = prolonged ? order.targets : order.sweep;
          assert.equal(sweep.length, 109);
          const inventory = new Map();
          for (const file of baseline.files) {
            safeRelative(file.path);
            assert.equal(inventory.has(file.path.toLowerCase()), false, 'Duplicate baseline path');
            inventory.set(file.path.toLowerCase(), file);
          }
          for (const [index, entry] of sweep.entries()) {
            assert.equal(entry.index, index + 1, 'Noncontiguous recorded prefix');
            if (!prolonged) assert.equal(entry.call.tool, 'kusto-workbench_activate-workbench-file');
            assert.equal(inventory.get(safeRelative(entry.relativePath).toLowerCase())?.path, entry.relativePath, 'Ledger path has no exact baseline');
          }
          const prefix = sweep.slice(0, prolonged ? diagnosticTargets : 32);
          assert.equal(prefix.some(entry => entry.relativePath === canaryPath), false);
          const firstKinds = new Set(prefix.slice(0, 19).map(entry => path.extname(entry.relativePath).toLowerCase()));
          assert.equal(['.kqlx', '.mdx', '.sqlx'].every(kind => firstKinds.has(kind)) && ['.kql', '.csl', '.sql'].some(kind => firstKinds.has(kind)), true, 'Recorded first19 is not the required mixed prefix');
          outcome.archive = { path: archive, sha256: archiveSha256, baselineSha256: hash(metadata.get('baseline.json')), ledgerSha256: hash(metadata.get(orderEntry)), originalInitialPaths: baseline.preservedInitialPaths, selectedPrefix: prefix.map(entry => ({ index: entry.index, path: entry.relativePath })), baselineCount: baseline.files.length };
          const images = await readArchive(new Set(baseline.files.map(file => 'before/' + file.path)));
          for (const reference of baseline.files) {
            const bytes = images.get('before/' + reference.path);
            assert.equal(bytes.length, reference.bytes);
            assert.equal(hash(bytes), reference.sha256.toLowerCase(), 'Before-image hash differs: ' + reference.path);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (/\.(kqlx|mdx|sqlx|(?:kql|csl|sql)\.json)$/i.test(reference.path) && text.trim()) {
              for (const section of JSON.parse(text).state?.sections ?? []) {
                if (!section.linkedQueryPath) continue;
                const linked = safeRelative(section.linkedQueryPath.replace(/\\/g, '/'));
                const resolved = path.posix.join(path.posix.dirname(reference.path), linked);
                assert.equal(inventory.has(resolved.toLowerCase()), true, 'Linked dependency is not privately archived');
              }
            }
            const file = path.join(owner.root, 'history', reference.path);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes, { flag: 'wx' });
            const uri = vscode.Uri.file(file).toString();
            references.set(uri, { path: reference.path, uri, file, text, bytes: reference.bytes, sha256: reference.sha256.toLowerCase(), mtimeMs: fs.statSync(file).mtimeMs });
          }
          canaryUri = vscode.Uri.file(path.join(owner.root, 'history', canaryPath)).toString();
          const original = references.get(canaryUri);
          assert.equal(original.sha256, canarySha256);
          const sections = JSON.parse(original.text).state.sections;
          assert.equal(sections.length, 10);
          expectedNotes = sections.find(section => section.type === 'devnotes').entries;
          assert.equal(expectedNotes.length, 1);
          assert.equal(expectedNotes[0].id, noteId);
          const html = sections.find(section => section.id === htmlId);
          assert.equal(html.code.length, 6566);
          const provenance = JSON.parse(html.code.match(/<script[^>]*type=["']application\/kw-provenance["'][^>]*>([\s\S]*?)<\/script>/i)[1]);
          assert.equal(Object.keys(provenance.bindings).length, 6);
          const fact = sections.find(section => section.id === provenance.model.fact.sectionId);
          const result = JSON.parse(fact.resultJson);
          factColumns = result.columns;
          assert.equal(factColumns.length, 4);
          assert.equal(result.rows.length, 3);
          outcome.original = { uri: canaryUri, sha256: canarySha256, sectionIds: sections.map(section => section.id), expectedNotes, htmlSectionId: htmlId, htmlLength: html.code.length, factSectionId: fact.id, factColumns, bindingIds: Object.keys(provenance.bindings), savedResultHashes: sections.filter(section => typeof section.resultJson === 'string').map(section => ({ id: section.id, sha256: hash(section.resultJson) })) };
          subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => sampleTabs('tabs-event')), vscode.window.tabGroups.onDidChangeTabGroups(() => sampleTabs('tab-groups-event')), vscode.workspace.onDidOpenTextDocument(document => sampleDocument(document, 'open')), vscode.workspace.onDidChangeTextDocument(event => sampleDocument(event.document, 'change')), vscode.workspace.onDidCloseTextDocument(document => sampleDocument(document, 'close')), vscode.workspace.onDidSaveTextDocument(document => { if (references.has(document.uri.toString())) outcome.saved.push({ uri: document.uri.toString(), phase }); }));
          outcome.before = preservation('before-open');
          await extension.activate();
          const loaded = Object.values(workbenchRequire.cache).find(candidate => candidate?.filename && canonical(candidate.filename) === canonical(main));
          const context = loaded?.exports?.toolOrchestrator?.context;
          assert.equal(loaded?.loaded, true, 'Executing module not identified');
          assert.equal(context?.extensionMode, vscode.ExtensionMode.Development);
          assert.equal(canonical(context.extensionPath), canonical(extension.extensionPath));
          outcome.loaded = { main: loaded.filename, extensionMode: context.extensionMode, logUri: context.logUri.toString(), globalStorageUri: context.globalStorageUri.toString() };
          if (process.env.KW_HIDDEN_SHORT_PROFILE_USER_DATA) {
            const approved = canonical(process.env.KW_HIDDEN_SHORT_PROFILE_USER_DATA);
            const relative = path.relative(approved, canonical(context.globalStorageUri.fsPath));
            assert.equal(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), false, 'Wrong prepared profile storage');
            outcome.profile = { mode: 'framework-managed-existing-profile', userDataPath: process.env.KW_HIDDEN_SHORT_PROFILE_USER_DATA, storagePath: context.globalStorageUri.fsPath };
          } else {
            assert.equal(outcome.initialTabs.length, 0, 'Fresh baseline requires no pre-existing tabs; never reset');
            outcome.profile = { mode: 'fresh-framework-profile', storagePath: context.globalStorageUri.fsPath };
          }
          if (prolonged) {
            assert.equal(order.minimumHiddenSeconds, 2148.246);
            assert.deepEqual(order.initialFileIdentitiesPreserved, baseline.preservedInitialPaths);
            assert.equal(baseline.preservedInitialPaths.length, 13);
            for (const originalPath of baseline.preservedInitialPaths) {
              const relative = safeRelative(path.win32.relative(baseline.workspace, originalPath).replace(/\\/g, '/'));
              assert.equal(inventory.has(relative.toLowerCase()), true, 'Warm file is not archived');
              const uri = vscode.Uri.file(path.join(owner.root, 'history', relative)).toString();
              phase = 'warm-' + (outcome.warmActivations.length + 1);
              const record = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: uri });
              outcome.warmActivations.push({ path: relative, sequence: record.sequence });
              assert.equal(record.value?.success === true && record.value.uri === uri, true, 'SETUP_BLOCKED: warm activation failed');
              await retainActive(uri);
            }
          }
          measurementStart = performance.now();
          phase = 'baseline-activation';
          const activation = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: canaryUri });
          assert.equal(activation.value?.success === true && activation.value.isLiveWorkbench === true && activation.value.uri === canaryUri && typeof activation.value.openFileId === 'string' && activation.value.openFileId.length > 0, true, 'SETUP_BLOCKED: original baseline activation unavailable');
          openFileId = activation.value.openFileId;
          const canaryTabs = tabs().filter(tab => tab.input?.uri?.toString() === canaryUri);
          assert.equal(canaryTabs.length, 1, 'Original baseline has no unique native tab');
          assert.equal(canaryTabs[0].input instanceof vscode.TabInputCustom && canaryTabs[0].input.viewType === 'kusto.kqlxEditor' && canaryTabs[0].isActive, true, 'Original baseline is not the active native notebook');
          outcome.canaryTarget = { uri: canaryUri, openFileId, identitySource: 'first-public-activation-only' };
          const baselinePair = await pair('baseline');
          assert.equal(baselinePair.passed, true, 'SETUP_BLOCKED: exact archived note and valid six-binding one-source dashboard required; no seed, retarget or query');
          outcome.checks.validBaseline = true;
          await retainActive(canaryUri);
          if (process.env.KW_HIDDEN_ACCESS_SAMPLE_ALLOCATIONS === '1') {
            assert.notEqual(diagnosticSeconds, undefined, 'Allocation sampling is diagnostic only');
            write('sampling-ready', { canaryUri, pid: process.pid, atUtc: new Date().toISOString() });
            const location = path.join(path.dirname(process.env.KW_HIDDEN_SHORT_MANIFEST), 'sampling-evidence.json');
            assert.equal(fs.existsSync(location), false, 'Allocation sampling requires a fresh manifest');
            fs.writeFileSync(location + '.tmp', JSON.stringify({ evidenceRoot, canaryUri, pid: process.pid }), { flag: 'wx' });
            fs.renameSync(location + '.tmp', location);
            const receipt = path.join(evidenceRoot, 'sampling-started.json');
            const deadline = performance.now() + 30000;
            while (!fs.existsSync(receipt) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(fs.existsSync(receipt), true, 'Allocation observer did not attach before the workload');
            const started = JSON.parse(fs.readFileSync(receipt, 'utf8'));
            assert.equal(started.canaryUri, canaryUri, 'Allocation observer targeted a different canary');
            assert.equal(started.pid, process.pid, 'Allocation observer targeted a different host');
          }
          for (const checkpoint of prolonged ? [19, diagnosticTargets] : [19, 32]) {
            const begin = outcome.activations.length;
            for (const entry of prefix.slice(begin, checkpoint)) {
              phase = 'prefix-' + entry.index;
              if (!prolonged && performance.now() - measurementStart > 150000) { outcome.classification = 'BOUNDED_SHORT_RUN_INCOMPLETE'; throw new Error('Short-run wall budget reached between natural calls; no forced timeout'); }
              const uri = vscode.Uri.file(path.join(owner.root, 'history', entry.relativePath)).toString();
              const record = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: uri });
              outcome.activations.push({ index: entry.index, path: entry.relativePath, sequence: record.sequence });
              const activated = record.value?.success === true && record.value.uri === uri && typeof record.value.openFileId === 'string';
              if (!activated) outcome.activationFailures.push({ index: entry.index, path: entry.relativePath, sequence: record.sequence });
              if (!prolonged) assert.equal(activated, true, 'SETUP_BLOCKED: mixed-prefix activation failed, not a hidden-canary read red');
              await retainActive(uri);
              if (!hidden) { hidden = true; hiddenStart = performance.now(); sampleTabs('hidden-arm-start'); }
              assertHidden();
              assert.equal(tabs().filter(tab => references.has(tab.input?.uri?.toString())).length, retainedUris.size, 'Mixed-prefix tabs were not retained');
            }
            if (prolonged && checkpoint === diagnosticTargets) {
              phase = 'retained-load';
              outcome.sweepFinishedUtc = new Date().toISOString();
              while (performance.now() - hiddenStart < hiddenDurationMs) {
                assertHidden();
                outcome.retainedSamples.push({ atUtc: new Date().toISOString(), hiddenElapsedMs: performance.now() - hiddenStart, retainedTabs: retainedUris.size, hostMemory: process.memoryUsage() });
                write('retained-load-progress', outcome.retainedSamples);
                await new Promise(resolve => setTimeout(resolve, Math.min(60000, hiddenDurationMs - (performance.now() - hiddenStart))));
              }
              if (diagnosticSeconds === undefined) outcome.checks.qualifiedHiddenDuration = performance.now() - hiddenStart >= 2300000;
              else outcome.checks.diagnosticHiddenDuration = performance.now() - hiddenStart >= hiddenDurationMs;
            }
            assertHidden();
            const observed = await pair('hidden-' + checkpoint);
            assertHidden();
            if (!observed.passed || prolonged && checkpoint === diagnosticTargets) {
              if (!observed.passed) {
                failure = { ...observed, firstFailureRetained: true, baselineValid: true, prefixCount: outcome.activations.length, sdkHiddenAtCheckpoints: true, continuousWebviewVisibilityProven: false, phaseProof: 'PUBLIC_BLACK_BOX_ONLY' };
                outcome.firstFailure = failure;
                write('first-hidden-failure', failure);
              }
              hidden = false;
              phase = 'activation-only-recovery';
              outcome.recoveryActivation = await invoke('kusto-workbench_activate-workbench-file', prolonged ? { targetFileUri: canaryUri } : { openFileId });
              outcome.recovery = await pair('first-after-one-activation');
              outcome.recovery.sameTarget = outcome.recoveryActivation.value?.openFileId === openFileId && outcome.recoveryActivation.value?.uri === canaryUri;
              outcome.recovery.activeCanary = tabSnapshot().some(tab => tab.uri === canaryUri && tab.active && tab.groupActive);
              if (diagnosticPauseSeconds > 0) {
                write('diagnostic-ready', { atUtc: new Date().toISOString(), canaryUri, pid: process.pid, pauseSeconds: diagnosticPauseSeconds });
                await new Promise(resolve => setTimeout(resolve, diagnosticPauseSeconds * 1000));
              }
              break;
            }
          }
          outcome.classification = failure ? 'NATURAL_HIDDEN_READ_FAILURE'
            : diagnosticSeconds !== undefined ? 'NOT_REPRODUCED_DIAGNOSTIC_RUN'
            : prolonged ? 'NOT_REPRODUCED_QUALIFIED_RUN' : 'NOT_REPRODUCED_SHORT_RUN';
          outcome.checks.sequence = outcome.pairs[0]?.label === 'baseline' && (failure ? outcome.pairs.at(-1)?.label === 'first-after-one-activation' : prolonged
            ? equal(outcome.pairs.map(result => result.label), ['baseline', 'hidden-19', `hidden-${diagnosticTargets}`, 'first-after-one-activation']) && outcome.activations.length === diagnosticTargets
            : equal(outcome.pairs.map(result => result.label), ['baseline', 'hidden-19', 'hidden-32']) && outcome.activations.length === 32);
        } catch (error) {
          outcome.errors.push({ phase, message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
        } finally {
          hidden = false;
          phase = 'cleanup';
          outcome.checks.startingDocumentsPreserved = checkStartingDocuments('before-cleanup');
          if (owner) {
            try { outcome.beforeCleanup = preservation('before-cleanup'); } catch (error) { outcome.errors.push({ phase, message: String(error?.message ?? error) }); }
            try { outcome.cleanup = await helper.closeAcceptanceTabs(vscode, owner, [...references.keys()]); } catch (error) { outcome.errors.push({ phase, message: String(error?.message ?? error) }); }
            try { outcome.afterCleanup = preservation('after-cleanup'); } catch (error) { outcome.errors.push({ phase, message: String(error?.message ?? error) }); }
          }
          for (const subscription of subscriptions) subscription.dispose();
          outcome.checks.startingDocumentsPreserved = checkStartingDocuments('after-cleanup') && outcome.checks.startingDocumentsPreserved;
          outcome.finalTabs = tabSnapshot();
          outcome.checks.preservation = outcome.before?.passed === true && outcome.beforeCleanup?.passed === true && outcome.afterCleanup?.passed === true && outcome.saved.length === 0 && outcome.damage.length === 0;
          const stableTab = tab => JSON.stringify([tab.uri, tab.viewType, tab.dirty, tab.column]);
          outcome.checks.cleanup = outcome.cleanup?.onlyOwnedTabs === true && outcome.cleanup.survivors === 0 && equal((outcome.initialTabs ?? []).map(stableTab).sort(), outcome.finalTabs.map(stableTab).sort());
          outcome.checks.onlyReadOnlyPublicCalls = outcome.calls.every(call => ['kusto-workbench_activate-workbench-file', 'kusto-workbench_manage-development-notes', 'kusto-workbench_validate-html-dashboard'].includes(call.name));
          outcome.readCalls = outcome.calls.filter(call => call.name !== 'kusto-workbench_activate-workbench-file').map(call => ({ sequence: call.sequence, phase: call.phase, name: call.name, input: call.input, elapsedMs: call.elapsedMs, responseArtifact: 'call-' + call.sequence + '-response.json' }));
          try {
            if (manifest && main) { outcome.afterBuild = verifyFrozenBuild(); outcome.checks.frozenBuild = outcome.afterBuild.mainSha256 === outcome.build.mainSha256; }
            outcome.checks.archiveUnchanged = hash(fs.readFileSync(archive)) === archiveSha256;
            if (outcome.loaded && evidenceRoot) {
              const logRoot = vscode.Uri.parse(outcome.loaded.logUri).fsPath;
              outcome.startupTrace = { source: logRoot, files: [], phaseProof: 'STANDARD_TRACE_ONLY_NOT_SDK_ACK' };
              if (fs.existsSync(logRoot)) {
                const destination = path.join(evidenceRoot, 'product-logs');
                fs.cpSync(logRoot, destination, { recursive: true, errorOnExist: true, force: false });
                outcome.startupTrace.files = fs.readdirSync(destination, { recursive: true }).filter(file => file.endsWith('.log')).map(file => path.join(destination, file));
              }
              write('startup-trace', outcome.startupTrace);
            }
          } catch (error) { outcome.errors.push({ phase: 'evidence', message: String(error?.message ?? error) }); }
        }
        if (outcome.damage.length || outcome.saved.length) outcome.classification = 'PRESERVATION_FAILED';
        else if (outcome.errors.length || !Object.values(outcome.checks).every(value => value === true)) outcome.classification = outcome.classification === 'BOUNDED_SHORT_RUN_INCOMPLETE' ? outcome.classification : 'SETUP_BLOCKED';
        outcome.fourSecondResponses = outcome.calls.filter(call => call.phase.startsWith('hidden-') && call.elapsedMs >= 3500 && call.elapsedMs <= 7000 && !(call.name === 'kusto-workbench_manage-development-notes' ? notesOracle(call) : dashboardOracle(call))).map(call => ({ sequence: call.sequence, phase: call.phase, elapsedMs: call.elapsedMs, allText: call.allText, parseError: call.parseError, transportError: call.transportError, phaseProof: 'PUBLIC_BLACK_BOX_ONLY' }));
        write('final-outcome', outcome);
        return JSON.parse(JSON.stringify(outcome));
      })()
      """
    Then I collect JSON artifact "hidden-short-access-assertion" from extension host expression "(() => { const result = globalThis.__hiddenShortAccess; const expected = result?.diagnosticSeconds !== undefined ? 'NOT_REPRODUCED_DIAGNOSTIC_RUN' : result?.prolonged ? 'NOT_REPRODUCED_QUALIFIED_RUN' : 'NOT_REPRODUCED_SHORT_RUN'; if (result?.classification !== expected || !Object.values(result.checks).every(value => value === true) || result.prolonged && (!result.recovery?.passed || !result.recovery?.sameTarget || !result.recovery?.activeCanary || result.recoveryActivation?.value?.success !== true || result.recoveryActivation?.value?.isLiveWorkbench !== true)) throw new Error(JSON.stringify({ classification: result?.classification, evidenceRoot: result?.evidenceRoot, checks: result?.checks, firstFailure: result?.firstFailure, recovery: result?.recovery, errors: result?.errors })); return { classification: result.classification, baseline: result.pairs[0], checkpoints: result.pairs.slice(1), limitations: result.limits }; })()"
    Then the output channel "Kusto Workbench" should contain "[file-open:"
    And I take a screenshot "hidden-access-cleanup"