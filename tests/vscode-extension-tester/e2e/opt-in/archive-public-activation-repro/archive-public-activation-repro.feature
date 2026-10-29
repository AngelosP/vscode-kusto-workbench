# Launch only in a fresh ephemeral host, never --attach-devhost or a named profile:
# vscode-ext-test run --extension-path . --features tests/vscode-extension-tester/e2e/opt-in/archive-public-activation-repro --vscode-version stable --timeout 180000
# Add --env KW_ARCHIVE_REPRO_TIMING=wave4 to replay the recorded open/check timing.
# Source-only Development reproduction, not a frozen candidate or Production qualification.
# The new synthetic canary is NOT the archived regression canary. SQL is blank;
# the second Query has no saved results. This does not certify the original result graph.
# Coverage ledger: initial positive control -> exact original109 public URI calls
# -> hidden checkpoint19/full109 reads -> one ordinary exact-ID activation -> reads
# -> preservation evidence -> exact clean cleanup. No retry can heal a first failure.
# Owners: real LM registration, SDK tabs, custom-editor bridge, notes/dashboard reads,
# actual stateGetter, immutable archive bytes, document versions, execution observer.
# Writer evidence: default-off helper -> owned applyEdit attempts -> private queued
# payloads and first changed buffers -> hash/range/version correlation -> exact
# descriptor cleanup. Attempts and unqualified stack locations are not cause proof.
# The older activation sweep prepares equivalents and warms with openWith: partial
# evidence only, not a replacement for these first public historical activations.
# Deferred: installed Production identity, native pixels/controls, authenticated runs,
# original-canary full result graph, authoring/Save/reopen. They require separate cases.

Feature: Archive first public activation and hidden canary preservation

  Scenario: First calls and exact hidden reads survive all 109 historical activations
    Given I collect JSON artifact "source-repro-initial-positive-control" from extension host expression:
      """
      (async () => {
        if (process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH !== undefined) throw new Error('SETUP_BLOCKED: standalone repro requires its documented fresh-host command, not reusable-profile suite dispatch');
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const os = process.getBuiltinModule('node:os');
        const crypto = process.getBuiltinModule('node:crypto');
        const url = process.getBuiltinModule('node:url');
        const modules = process.getBuiltinModule('node:module');
        const equal = process.getBuiltinModule('node:util').isDeepStrictEqual;
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const activeUri = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() ?? null;
        const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!extension || extension.isActive || tabs().length !== 0 || globalThis.__archiveSourceRepro) throw new Error('SETUP_BLOCKED: requires an inactive extension and fresh zero-tab ephemeral host; do not reset or attach');
        const sourceRoot = extension.extensionPath;
        const main = path.resolve(sourceRoot, extension.packageJSON.main);
        const mainStat = fs.lstatSync(main);
        if (!mainStat.isFile() || mainStat.isSymbolicLink() || mainStat.nlink !== 1 || !samePath(fs.realpathSync.native(main), main)) throw new Error('SETUP_BLOCKED: executing main path is aliased');
        const workbenchRequire = modules.createRequire(main);
        const helperPath = path.join(sourceRoot, 'scripts/repro-published-notebook.mjs');
        const helper = await import(url.pathToFileURL(helperPath).href);
        const beforeArchive = path.join(os.tmpdir(), 'kw-wave3-before-2026-10-09-032b29ab0ad64643abd66746fb58bb7f.zip');
        const orderArchive = path.join(os.tmpdir(), 'kw-regression-before-2026-10-07-5f779bb4a66542f6ae767e9e817f7a22.zip');
        let plan;
        try { plan = await helper.inspectAcceptanceArchives(beforeArchive, orderArchive, 'current133-api'); }
        catch (error) { throw new Error('SETUP_BLOCKED: immutable private archives unavailable or invalid: ' + error.message); }
        const timingMode = process.env.KW_ARCHIVE_REPRO_TIMING;
        if (timingMode !== undefined && timingMode !== 'wave4') throw new Error('SETUP_BLOCKED: unknown recorded timing mode');
        let recordedTiming = null;
        if (timingMode === 'wave4') {
          const timingArchive = path.join(os.tmpdir(), 'kw-wave4-before-2026-10-09-6c23d6ecf3794e69884147af469f0a89.zip');
          if (hash(fs.readFileSync(timingArchive)) !== 'fdf3c0d5096227b0f310b1c6ea3596bb01a7db1fdd24f5f41aa24cd637dd0652') throw new Error('SETUP_BLOCKED: recorded Wave4 timing archive changed');
          const ledger = await new Promise((resolve, reject) => {
            workbenchRequire('yauzl').open(timingArchive, { lazyEntries: true }, (error, zip) => {
              if (error) return reject(error);
              let found = false;
              zip.on('error', reject);
              zip.on('end', () => { if (!found) reject(new Error('SETUP_BLOCKED: recorded activation timing missing')); });
              zip.on('entry', entry => {
                if (entry.fileName !== 'evidence/activation-request-ledger.json') { zip.readEntry(); return; }
                found = true;
                if (entry.uncompressedSize > 1024 * 1024) { zip.close(); reject(new Error('SETUP_BLOCKED: oversized timing ledger')); return; }
                zip.openReadStream(entry, (error, stream) => {
                  if (error) { zip.close(); reject(error); return; }
                  const chunks = [];
                  stream.on('error', error => { zip.close(); reject(error); });
                  stream.on('data', chunk => chunks.push(chunk));
                  stream.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } finally { zip.close(); } });
                });
              });
              zip.readEntry();
            });
          });
          if (!Array.isArray(ledger) || ledger.length !== 109 || ledger.some((entry, index) => entry.index !== index + 1 || entry.relativePath.replaceAll('\\', '/') !== plan.activationOrder[index] || !Number.isFinite(Date.parse(entry.requestedUtc))
            || index > 0 && Date.parse(entry.requestedUtc) <= Date.parse(ledger[index - 1].requestedUtc))) throw new Error('SETUP_BLOCKED: recorded timing differs from exact109 order');
          const origin = Date.parse(ledger[0].requestedUtc);
          recordedTiming = { mode: 'wave4', archiveSha256: hash(fs.readFileSync(timingArchive)), firstOpenDelayMs: origin - Date.parse('2026-10-09T16:39:38.479Z'),
            offsetsMs: ledger.map(entry => Date.parse(entry.requestedUtc) - origin),
            checkpoint19Ms: Date.parse('2026-10-09T16:45:32.731Z') - origin,
            hidden109Ms: Date.parse('2026-10-09T16:57:22.398Z') - origin,
            recoveryMs: Date.parse('2026-10-09T16:58:02.051Z') - origin,
            afterRecoveryMs: Date.parse('2026-10-09T16:58:24.801Z') - origin };
        }
        if (plan.activationOrder.includes(plan.archivedCanary.path)) throw new Error('SETUP_BLOCKED: archived regression canary must remain unopened outside order109');
        const owner = helper.createAcceptanceRoot();
        const staged = helper.stageBeforeImages(owner, plan, plan.images);
        const canary = vscode.Uri.file(path.join(owner.root, 'synthetic-source-canary.kqlx'));
        const template = path.join(owner.root, 'synthetic-source-canary-template.json');
        const evidenceRoot = path.join(owner.root, 'evidence');
        fs.mkdirSync(evidenceRoot);
        const write = (name, value) => fs.writeFileSync(path.join(evidenceRoot, name + '.json'), JSON.stringify(value, null, 2));
        const references = new Map(plan.files.map(file => [vscode.Uri.file(path.join(staged.historyRoot, file.path)).toString(), { path: 'history/' + file.path, file: path.join(staged.historyRoot, file.path), sha256: file.sha256, text: plan.images.get(file.path).toString('utf8').replace(/^\uFEFF/, '') }]));
        const historicalUris = plan.activationOrder.map(relative => vscode.Uri.file(path.join(staged.historyRoot, relative)).toString());
        const archivedCanaryUri = vscode.Uri.file(path.join(staged.historyRoot, plan.archivedCanary.path)).toString();
        const ownedUris = new Set([...references.keys(), canary.toString(), staged.coldCanary.uri, vscode.Uri.file(template).toString()]);
        const bindingIds = ['total', 'subtotal', 'summary', 'amount', 'balance', 'grandTotal'];
        const factColumns = [{ name: 'RowId', type: 'long' }, { name: 'Group', type: 'string' }, { name: 'Amount', type: 'real' }, { name: 'Timestamp', type: 'datetime' }];
        const factRows = [[1, 'alpha', 10.5, '2026-10-01T00:00:00.000Z'], [2, 'beta', 21, '2026-10-02T00:00:00.000Z'], [3, 'gamma', 31.5, '2026-10-03T00:00:00.000Z']];
        const expectedNote = { id: 'archive-source-note', created: '2026-10-09T00:00:00.000Z', updated: '2026-10-09T00:00:00.000Z', category: 'usage-note', content: 'Synthetic self-owned activation control', source: 'agent', relatedSectionIds: ['archive_source_fact', 'archive_source_html'] };
        const dashboardCode = '<script type="application/kw-provenance">' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'archive_source_fact', sectionName: 'Synthetic fact' } }, bindings: Object.fromEntries(bindingIds.map(id => [id, { display: { type: 'scalar', agg: 'SUM', column: 'Amount' } }])) }) + '</script>' + bindingIds.map(id => `<span data-kw-bind="${id}">0</span>`).join('');
        const sections = [
          { id: 'archive_source_fact', type: 'query', name: 'Synthetic fact', query: "datatable(RowId:long, Group:string, Amount:real, Timestamp:datetime)[1, 'alpha', 10.5, datetime(2026-10-01), 2, 'beta', 21.0, datetime(2026-10-02), 3, 'gamma', 31.5, datetime(2026-10-03)]", expanded: true, resultsVisible: true, resultJson: JSON.stringify({ columns: factColumns, rows: factRows, metadata: { executionTime: '00:00:00.010' } }) },
          { id: 'archive_source_query', type: 'query', name: 'Synthetic second Query', query: 'print SyntheticSourceControl=1', clusterUrl: '', database: '', expanded: false },
          { id: 'archive_source_markdown', type: 'markdown', title: 'Synthetic notes', text: 'Self-owned source-only control', mode: 'preview', expanded: false },
          { id: 'archive_source_html', type: 'html', name: 'Synthetic dashboard', code: dashboardCode, mode: 'preview', expanded: true, previewHeightPx: 160, dataSourceIds: ['archive_source_fact'] },
          { id: 'archive_source_devnotes', type: 'devnotes', entries: [expectedNote] },
          { id: 'archive_source_sql', type: 'sql', name: 'Blank SQL owner', dialect: 'mssql', serverUrl: '', database: '', query: '', expanded: false },
          { id: 'archive_source_chart', type: 'chart', name: 'Synthetic Chart', expanded: false, dataSourceId: 'archive_source_fact', chartType: 'bar', xColumn: 'Group', yColumns: ['Amount'] },
          { id: 'archive_source_transform', type: 'transformation', name: 'Synthetic Transformation', expanded: false, dataSourceId: 'archive_source_fact', transformationType: 'derive', deriveColumns: [{ name: 'DoubleAmount', expression: 'Amount * 2' }] },
          { id: 'archive_source_url', type: 'url', name: 'Blank URL owner', url: '', expanded: false },
          { id: 'archive_source_python', type: 'python', name: 'Blank Python owner', code: '', output: '', expanded: false }
        ];
        fs.writeFileSync(template, JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2), { flag: 'wx' });
        const state = { mode: 'SOURCE_ONLY_DEVELOPMENT', owner, evidenceRoot, first: [], calls: [], checks: {}, damage: [], models: [], subscriptions: [], initialGate: false, ordinaryActivationCount: 0, hiddenObservation: null, finished: false, recordedTiming, timingEvents: [], observationBlockers: [], writerCaptures: [], firstChangedCaptures: [] };
        globalThis.__archiveSourceRepro = state;
        const waitRecordedOffset = async (offsetMs, label) => {
          if (!state.recordedTiming) return;
          if (!state.initialGate || !Number.isFinite(state.replayStart) || !Number.isFinite(offsetMs) || offsetMs < 0) throw new Error('SETUP_BLOCKED: recorded timing used before a healthy baseline');
          const scheduledAt = state.replayStart + offsetMs;
          const delayMs = Math.max(0, scheduledAt - Date.now());
          if (delayMs > 120000) throw new Error('SETUP_BLOCKED: one recorded wait exceeds the existing step budget');
          if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
          state.timingEvents.push({ label, offsetMs, scheduledAt, observedAt: Date.now(), lateByMs: Math.max(0, Date.now() - scheduledAt) });
          write('recorded-timing', { recordedTiming: state.recordedTiming, replayStart: state.replayStart, events: state.timingEvents });
        };
        let observer;
        let baselineFact;
        let baselineSignature;
        let orchestrator;
        const captureRelativePath = value => {
          if (typeof value !== 'string') throw new Error('Private capture path rejected');
          const relative = value.replaceAll('\\', '/');
          if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || /[\x00-\x1f<>:"|?*]/.test(relative)
            || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Private capture path rejected');
          return relative;
        };
        const captureSamePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
        const assertPrivateCaptureDirectory = directory => {
          const stat = fs.lstatSync(directory);
          if (!stat.isDirectory() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.nlink) || stat.nlink < 1 || process.platform === 'win32' && stat.nlink !== 1
            || !captureSamePath(fs.realpathSync.native(directory), path.resolve(directory))) throw new Error('Private capture parent rejected');
        };
        const privateCapturePath = relative => {
          const root = helper.assertAcceptanceRoot(owner);
          if (!captureSamePath(path.resolve(evidenceRoot), path.join(root, 'evidence'))) throw new Error('Private capture root rejected');
          const segments = captureRelativePath(relative).split('/');
          let parent = root;
          assertPrivateCaptureDirectory(parent);
          for (const segment of ['evidence', ...segments.slice(0, -1)]) {
            const next = path.join(parent, segment);
            const inside = path.relative(root, next);
            if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Private capture parent rejected');
            if (!fs.existsSync(next)) fs.mkdirSync(next);
            assertPrivateCaptureDirectory(next);
            parent = next;
          }
          return path.join(parent, segments.at(-1));
        };
        const writePrivateCapture = (relative, contents) => {
          const file = privateCapturePath(relative);
          const descriptor = fs.openSync(file, 'wx');
          try {
            const stat = fs.fstatSync(descriptor, { bigint: true });
            const named = fs.lstatSync(file, { bigint: true });
            helper.assertAcceptanceRoot(owner);
            let parent = path.dirname(file);
            for (;;) {
              assertPrivateCaptureDirectory(parent);
              if (captureSamePath(parent, owner.root)) break;
              parent = path.dirname(parent);
            }
            if (!stat.isFile() || stat.nlink !== 1n || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || process.platform !== 'win32' && stat.dev !== named.dev || stat.ino !== named.ino
              || !captureSamePath(fs.realpathSync.native(file), file)) throw new Error('Private capture file rejected');
            fs.writeFileSync(descriptor, contents, 'utf8');
          } finally { fs.closeSync(descriptor); }
          return { bytes: Buffer.byteLength(contents, 'utf8'), sha256: hash(contents) };
        };
        const pendingPrivateWrites = new Set();
        const firstChangedAttempted = new Set();
        const privateCaptureLimit = 16 * 1024 * 1024;
        let privateCaptureBytes = 0;
        const observationBlock = reason => {
          try { if (state.observationBlockers.length < 32 && !state.observationBlockers.includes(reason)) state.observationBlockers.push(reason); } catch {}
        };
        const queuePrivateCapture = (relative, payload, receipt, failureReason) => {
          let settle;
          const pending = new Promise(resolve => { settle = resolve; });
          pendingPrivateWrites.add(pending);
          const fail = () => { receipt.status = 'blocked'; observationBlock(failureReason); };
          try {
            queueMicrotask(() => {
              try {
                const contents = typeof payload === 'string' ? payload : JSON.stringify(payload);
                const bytes = Buffer.byteLength(contents, 'utf8');
                if (privateCaptureBytes + bytes > privateCaptureLimit) { fail(); observationBlock('Private capture exceeded its 16-MiB byte bound'); }
                else { privateCaptureBytes += bytes; Object.assign(receipt, writePrivateCapture(relative, contents), { status: 'captured' }); }
              } catch { fail(); }
              finally { pendingPrivateWrites.delete(pending); settle(); }
            });
          } catch { fail(); pendingPrivateWrites.delete(pending); settle(); }
        };
        const flushPrivateCaptures = async () => {
          while (pendingPrivateWrites.size) await Promise.all([...pendingPrivateWrites]);
          return { bytes: privateCaptureBytes, maxBytes: privateCaptureLimit, pending: pendingPrivateWrites.size };
        };
        const captureWriterAttempt = event => {
          const relative = 'writer-attempts/' + String(event.sequence).padStart(6, '0') + '.json';
          const receipt = { sequence: event.sequence, path: relative, status: 'pending' };
          state.writerCaptures.push(receipt);
          queuePrivateCapture(relative, Object.freeze({ schemaVersion: 1, expectedMode: event.fullReplacement ? 'fullReplacement' : 'partial', ...event }), receipt, 'Writer payload capture failed');
        };
        const captureFirstChangedBuffer = (reference, document, model, event, text, bufferSha256, previousBufferSha256, changes) => {
          const uri = document.uri.toString();
          if (firstChangedAttempted.has(uri)) return;
          firstChangedAttempted.add(uri);
          const documentGeneration = observer?.writerDocumentGeneration(document) ?? null;
          const matchingWriterSequences = (observer?.snapshot().writerRecords ?? []).filter(record => record.uri === uri && record.documentGeneration === documentGeneration
            && record.documentVersion + 1 === document.version && record.beforeSha256 === previousBufferSha256
            && (record.fullReplacement && record.newTextSha256 === bufferSha256 || changes.some(change => change.rangeOffset === record.startOffset && change.rangeLength === record.endOffset - record.startOffset && change.newTextSha256 === record.newTextSha256))).map(record => record.sequence);
          const relative = 'before-image-changed/' + reference.path.replaceAll('\\', '/');
          const receipt = { path: relative, sourcePath: reference.path, uri, event, status: 'pending', observedAt: Date.now(), modelGeneration: model.generation, documentGeneration,
            documentVersion: document.version, bufferSha256, expectedModelSha256: hash(reference.text), previousBufferSha256, changes, matchingWriterSequences, correlation: 'ATTEMPT_MATCH_ONLY_NOT_COMMIT_OR_CAUSE' };
          state.firstChangedCaptures.push(receipt);
          queuePrivateCapture(relative, text, receipt, 'First changed buffer capture failed');
        };
        const fingerprintTree = directory => {
          const files = [];
          const visit = folder => {
            for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
              const file = path.join(folder, entry.name);
              if (entry.isSymbolicLink()) throw new Error('SETUP_BLOCKED: aliased source/resource tree');
              if (entry.isDirectory()) visit(file);
              else if (/\.(?:js|cjs|mjs|ts|css|json|html|wasm|ttf|woff2?)$/i.test(file)) files.push({ path: path.relative(sourceRoot, file).split(path.sep).join('/'), sha256: hash(fs.readFileSync(file)) });
            }
          };
          visit(directory);
          files.sort((left, right) => left.path.localeCompare(right.path));
          return { count: files.length, sha256: hash(JSON.stringify(files)) };
        };
        const sourceHead = () => {
          try {
            let gitRoot = path.join(sourceRoot, '.git');
            if (fs.lstatSync(gitRoot).isFile()) gitRoot = path.resolve(sourceRoot, fs.readFileSync(gitRoot, 'utf8').trim().replace(/^gitdir: /, ''));
            const head = fs.readFileSync(path.join(gitRoot, 'HEAD'), 'utf8').trim();
            if (/^[0-9a-f]{40}$/i.test(head)) return head;
            const ref = head.replace(/^ref: /, '');
            if (fs.existsSync(path.join(gitRoot, ref))) return fs.readFileSync(path.join(gitRoot, ref), 'utf8').trim();
            return fs.readFileSync(path.join(gitRoot, 'packed-refs'), 'utf8').split(/\r?\n/).find(line => line.endsWith(' ' + ref))?.split(' ')[0] ?? null;
          } catch { return null; }
        };
        const diskProof = () => ({ sourceHead: sourceHead(), mainSha256: hash(fs.readFileSync(main)), source: fingerprintTree(path.join(sourceRoot, 'src')), resources: fingerprintTree(path.join(sourceRoot, 'dist')), helperSha256: hash(fs.readFileSync(helperPath)), dependencyLockSha256: fs.existsSync(path.join(sourceRoot, 'package-lock.json')) ? hash(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'))) : null });
        const loadedProof = () => {
          const loaded = Object.values(workbenchRequire.cache).find(candidate => samePath(candidate?.filename, main));
          const context = loaded?.exports?.toolOrchestrator?.context;
          if (loaded?.loaded !== true || context?.extensionMode !== vscode.ExtensionMode.Development || context.extensionMode !== 2 || !samePath(context.extensionPath, sourceRoot)) throw new Error('SETUP_BLOCKED: actual loaded Development context/main identity missing');
          const mainSource = fs.readFileSync(main, 'utf8');
          return { sourceRoot, loadedFilename: loaded.filename, extensionMode: context.extensionMode, mainSha256: hash(mainSource), vscodeVersion: vscode.version, manifestVersion: extension.packageJSON.version, qualification: 'PARTIAL_ORCHESTRATOR_ONLY_NOT_PANEL_RUNTIME', panelOwnersQualified: false, methods: ['collectOpenWorkbenchFiles', 'listSections', 'manageDevelopmentNotes', 'validateHtmlDashboard', 'activateWorkbenchFile'].map(name => { const method = loaded.exports.toolOrchestrator[name]; if (typeof method !== 'function') throw new Error('SETUP_BLOCKED: loaded method absent: ' + name); const text = Function.prototype.toString.call(method); if (!mainSource.includes(text)) throw new Error('SETUP_BLOCKED: executing method does not match source main: ' + name); return { name, sha256: hash(text), matchesMain: true }; }) };
        };
        const sampleDocument = (document, event, contentChanges = []) => {
          const uri = document.uri.toString();
          const reference = references.get(uri);
          if (!reference) return;
          const text = document.getText();
          const bufferSha256 = hash(text);
          let model = state.models.find(candidate => candidate.document === document);
          if (!model) { model = { document, uri, version: document.version, generation: state.models.length + 1, lastSampledHash: hash(reference.text) }; state.models.push(model); if (state.models.some(candidate => candidate !== model && candidate.uri === uri)) state.damage.push({ path: reference.path, event: 'model-replaced' }); }
          const previousBufferSha256 = model.lastSampledHash;
          model.lastSampledHash = bufferSha256;
          if (document.isDirty || document.version !== model.version || text !== reference.text) state.damage.push(Object.freeze({ path: reference.path, event, firstVersion: model.version, version: document.version, dirty: document.isDirty, bufferSha256, observedAt: Date.now() }));
          if (text !== reference.text) {
            try {
              const changes = [];
              if (!Array.isArray(contentChanges) || contentChanges.length > 64) observationBlock('Document change observation exceeded its 64-edit bound');
              else for (const change of contentChanges) changes.push({ rangeOffset: change.rangeOffset, rangeLength: change.rangeLength, newTextLength: change.text.length, newTextSha256: hash(change.text) });
              captureFirstChangedBuffer(reference, document, model, event, text, bufferSha256, previousBufferSha256, changes);
            } catch { firstChangedAttempted.add(uri); observationBlock('First changed buffer capture failed'); }
          }
        };
        const sampleTabs = () => {
          for (const tab of tabs()) if (references.has(tab.input?.uri?.toString()) && tab.isDirty) state.damage.push({ path: path.relative(owner.root, tab.input.uri.fsPath), event: 'dirty-tab' });
          if (state.hiddenObservation && (activeUri() === canary.toString() || observer?.panelFor(canary.toString())?.active === true)) state.hiddenObservation.events.push({ activeUri: activeUri(), at: Date.now() });
        };
        const preservation = phase => {
          const changed = [];
          for (const reference of references.values()) {
            try { if (hash(fs.readFileSync(reference.file)) !== reference.sha256) changed.push(reference.path); }
            catch { changed.push(reference.path); }
          }
          for (const model of state.models) sampleDocument(model.document, phase);
          sampleTabs();
          const archivedCanaryUnopened = !state.models.some(model => model.uri === archivedCanaryUri) && !tabs().some(tab => tab.input?.uri?.toString() === archivedCanaryUri);
          let independentColdCopyStable = false;
          try { independentColdCopyStable = hash(fs.readFileSync(staged.coldCanary.filePath)) === staged.coldCanary.sha256; } catch {}
          return { phase, historicalCopies: plan.files.length, protectedSources: references.size, independentColdCopyCount: 1, independentColdCopyStable, byteHashChanged: changed, damage: [...state.damage], archivedCanaryUnopened, passed: changed.length === 0 && state.damage.length === 0 && archivedCanaryUnopened && independentColdCopyStable };
        };
        const invoke = async (name, input, phase) => {
          const record = { sequence: state.calls.length + 1, name, input, phase, startedAt: Date.now(), settled: false, activeBefore: activeUri() };
          state.calls.push(record);
          write('call-' + String(record.sequence).padStart(3, '0'), record);
          try {
            record.raw = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
            const text = record.raw.content.find(part => typeof part?.value === 'string')?.value;
            if (typeof text !== 'string' || text.startsWith('Error:')) record.decodeError = 'Missing or rejected JSON tool response';
            else { try { record.value = JSON.parse(text); } catch { record.decodeError = 'Invalid JSON tool response'; } }
          } catch (error) { record.transportError = String(error?.message ?? error); }
          record.settled = true; record.elapsedMs = Date.now() - record.startedAt; record.activeImmediatelyAfter = activeUri();
          write('call-' + String(record.sequence).padStart(3, '0'), record);
          return record;
        };
        const activationShape = (record, uri, markdown = false) => record.value?.success === true && record.value.uri === uri && (record.value.isLiveWorkbench === true || markdown && record.value.isReadOnlyFallback === true) && !record.transportError && !record.decodeError;
        const waitExactTab = (uri, readOnlyMarkdown = false, authoredSetup = false) => new Promise((resolve, reject) => {
          const subscriptions = [];
          let settled = false;
          const finish = error => { if (settled) return; settled = true; clearTimeout(timer); subscriptions.forEach(subscription => subscription.dispose()); if (error) reject(error); else resolve(); };
          const check = () => {
            const matches = tabs().filter(tab => tab.input?.uri?.toString() === uri);
            if (matches.length > 1) return finish(new Error('Duplicate exact SDK target'));
            const tab = matches[0];
            const kind = path.extname(vscode.Uri.parse(uri).fsPath).slice(1).toLowerCase();
            const viewType = ['kqlx', 'sqlx', 'mdx'].includes(kind) ? 'kusto.kqlxEditor' : kind === 'md' ? 'kusto.mdCompatEditor' : kind === 'sql' ? 'kusto.sqlCompatEditor' : 'kusto.kqlCompatEditor';
            const exactEditor = tab?.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType || readOnlyMarkdown && kind === 'md' && tab?.input instanceof vscode.TabInputText;
            if (tab && (!exactEditor || tab.isDirty && !authoredSetup)) return finish(new Error('Wrong or dirty exact SDK target'));
            if (tab && activeUri() === uri && vscode.workspace.textDocuments.some(document => document.uri.toString() === uri)) finish();
          };
          const timer = setTimeout(() => finish(new Error('Exact SDK target not active within observation-only 90s deadline')), 90000);
          subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(check), vscode.window.tabGroups.onDidChangeTabGroups(check), vscode.workspace.onDidOpenTextDocument(check));
          check();
        });
        state.oracles = async (phase, hidden) => {
          if (phase === 'checkpoint19' && state.first.length !== 19 || phase === 'full109-hidden' && state.first.length !== 109) throw new Error('SETUP_BLOCKED: incorrect composed checkpoint');
          if (phase === 'checkpoint19') await waitRecordedOffset(state.recordedTiming?.checkpoint19Ms, phase);
          if (phase === 'full109-hidden') await waitRecordedOffset(state.recordedTiming?.hidden109Ms, phase);
          if (phase === 'after-ordinary-activation') await waitRecordedOffset(state.recordedTiming?.afterRecoveryMs, phase);
          const before = activeUri();
          const observation = { events: [] };
          if (hidden) state.hiddenObservation = observation;
          const target = { openFileId: state.canaryId, ...(state.recordedTiming ? {} : { targetFileUri: canary.toString() }) };
          let snapshot;
          let getterError;
          const notes = await invoke('kusto-workbench_manage-development-notes', { action: 'view', ...target }, phase);
          const afterNotes = activeUri();
          const dashboard = await invoke('kusto-workbench_validate-html-dashboard', { sectionId: 'archive_source_html', ...target }, phase);
          const afterDashboard = activeUri();
          try {
            const connections = [...orchestrator.liveConnections.values()].filter(connection => (connection.documentUri ?? connection.documentInfo?.uriString) === canary.toString());
            if (connections.length !== 1 || typeof connections[0].stateGetter !== 'function') throw new Error('Exact canary stateGetter unavailable');
            snapshot = await connections[0].stateGetter();
            if (Array.isArray(snapshot)) snapshot = JSON.parse(JSON.stringify(snapshot));
            if (orchestrator.liveConnections.get(connections[0].token) !== connections[0]) throw new Error('Captured canary connection retired');
          } catch (error) { getterError = String(error?.message ?? error); }
          const after = activeUri();
          sampleTabs(); state.hiddenObservation = null;
          const find = id => Array.isArray(snapshot) ? snapshot.find(section => section.id === id) : undefined;
          const fact = find('archive_source_fact');
          let factResult;
          try { factResult = JSON.parse(fact?.resultJson); } catch {}
          const signature = fact ? { resultJsonSha256: typeof fact.resultJson === 'string' ? hash(fact.resultJson) : null, artifactSha256: fact.resultArtifact === undefined ? null : hash(JSON.stringify(fact.resultArtifact)) } : null;
          if (phase === 'initial') baselineSignature = signature;
          const checks = {
            fullOrder: Array.isArray(snapshot) && equal(snapshot.map(section => [section.id, section.type]), sections.map(section => [section.id, section.type])),
            fullNote: notes.value?.success === true && equal(notes.value.notes, [expectedNote]) && equal(find('archive_source_devnotes')?.entries, [expectedNote]),
            typedFact: equal(factResult?.columns, factColumns) && equal(factResult?.rows, factRows) && fact?.resultJson === baselineFact?.resultJson && (!Object.hasOwn(baselineFact ?? {}, 'resultArtifact') || equal(fact?.resultArtifact, baselineFact.resultArtifact)) && equal(signature, baselineSignature),
            owners: find('archive_source_query')?.query === sections[1].query && find('archive_source_markdown')?.text === sections[2].text && find('archive_source_html')?.code === dashboardCode && equal(find('archive_source_html')?.dataSourceIds, ['archive_source_fact']) && ['archive_source_chart', 'archive_source_transform'].every(id => find(id)?.dataSourceId === 'archive_source_fact') && ['archive_source_sql', 'archive_source_url', 'archive_source_python'].every(id => find(id)?.expanded === false),
            dashboard: dashboard.value?.success === true && dashboard.value.valid === true && dashboard.value.hasProvenance === true && dashboard.value.bindingCount === 6 && dashboard.value.dataSourceCount === 1 && dashboard.value.issues?.length === 0 && dashboard.value.diagnostics?.length === 0 && samePath(dashboard.value.filePath, canary.fsPath) && equal(dashboard.value.factColumns, factColumns),
            noAutoReveal: before === afterNotes && before === afterDashboard && before === after && observation.events.length === 0,
            expectedVisibility: hidden ? before !== canary.toString() && observer.panelFor(canary.toString())?.visible === false : before === canary.toString() && observer.panelFor(canary.toString())?.active === true,
            actualSnapshot: Array.isArray(snapshot) && !getterError
          };
          const result = { phase, passed: Object.values(checks).every(value => value === true), checks, activeBefore: before, activeAfterNotes: afterNotes, activeAfterDashboard: afterDashboard, activeAfter: after, transientCanaryActivations: observation.events.length, signature };
          state.checks[phase] = result;
          write(phase + '-oracles', { ...result, snapshot, getterError, notesCall: notes.sequence, dashboardCall: dashboard.sequence });
          return result;
        };
        state.activateOne = async index => {
          if (!state.initialGate || index !== state.first.length || index < 0 || index >= 109) throw new Error('SETUP_BLOCKED: historical activation must be first, ordered and unreplayed');
          await waitRecordedOffset(state.recordedTiming?.offsetsMs[index], 'historical-' + (index + 1));
          const uri = historicalUris[index];
          const record = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: uri }, 'historical-' + (index + 1));
          let sdkError;
          if (activationShape(record, uri, /\.md$/i.test(plan.activationOrder[index]))) { try { await waitExactTab(uri, record.value.isReadOnlyFallback === true); } catch (error) { sdkError = error.message; } }
          const passed = activationShape(record, uri, /\.md$/i.test(plan.activationOrder[index])) && !sdkError && activeUri() === uri;
          const result = { ordinal: index + 1, path: plan.activationOrder[index], call: record.sequence, success: record.value?.success ?? null, isLiveWorkbench: record.value?.isLiveWorkbench ?? null, isReadOnlyFallback: record.value?.isReadOnlyFallback ?? null, elapsedMs: record.elapsedMs, activeImmediatelyAfter: record.activeImmediatelyAfter, activeAfterObservation: activeUri(), passed, error: passed ? null : record.transportError ? 'TOOL_TRANSPORT_FAILURE' : record.decodeError ? 'TOOL_RESPONSE_FAILURE' : record.value?.success !== true ? 'PUBLIC_ACTIVATION_REJECTED' : 'EXACT_LIVE_SDK_TARGET_NOT_ESTABLISHED' };
          state.first.push(result);
          write('activation-' + String(index + 1).padStart(3, '0'), { ...result, sdkError, firstResponse: record });
          return result;
        };
        state.afterLoad = async () => {
          const hidden = await state.oracles('full109-hidden', true);
          const retained = tabs().filter(tab => historicalUris.includes(tab.input?.uri?.toString()));
          state.retention = { retainedCount: retained.length, passed: retained.length === 109 && new Set(retained.map(tab => tab.input.uri.toString())).size === 109 && retained.every(tab => !tab.isDirty) };
          const inventory = await invoke('kusto-workbench_list-sections', {}, 'later-inventory-once');
          state.laterAccessibility = [...new Set([18, 23, ...state.first.filter(record => !record.passed).map(record => record.ordinal - 1)])].map(index => { const matches = inventory.value?.openFiles?.filter(file => file.uri === historicalUris[index]) ?? []; const file = matches[0]; return { ordinal: index + 1, path: plan.activationOrder[index], firstPassed: state.first[index].passed, laterAccessible: matches.length === 1 && file.isLiveWorkbench === true && file.sectionsUnavailable !== true && !file.error, isLiveWorkbench: file?.isLiveWorkbench ?? null, sectionsUnavailable: file?.sectionsUnavailable ?? null }; });
          return { hidden, retention: state.retention, laterAccessibility: state.laterAccessibility, firstFailuresRemain: state.first.filter(record => !record.passed).length };
        };
        state.recoverOnce = async () => {
          if (state.first.length !== 109 || !state.checks['full109-hidden'] || state.ordinaryActivationCount !== 0) throw new Error('SETUP_BLOCKED: sole exact-ID activation requires the full hidden checkpoint');
          await waitRecordedOffset(state.recordedTiming?.recoveryMs, 'ordinary-exact-id');
          state.ordinaryActivationCount++;
          const record = await invoke('kusto-workbench_activate-workbench-file', { openFileId: state.canaryId }, 'ordinary-exact-id');
          let sdkReady = false;
          if (activationShape(record, canary.toString()) && record.value.openFileId === state.canaryId) { try { await waitExactTab(canary.toString()); sdkReady = true; } catch {} }
          state.recovered = { call: record.sequence, passed: activationShape(record, canary.toString()) && record.value.openFileId === state.canaryId && sdkReady, success: record.value?.success ?? null, isLiveWorkbench: record.value?.isLiveWorkbench ?? null, activeImmediatelyAfter: record.activeImmediatelyAfter };
          const oracles = await state.oracles('after-ordinary-activation', false);
          return { activation: state.recovered, oracles };
        };
        state.finish = async () => {
          if (state.finished) throw new Error('SETUP_BLOCKED: finalizer cannot be replayed');
          state.finished = true;
          const beforeCleanup = preservation('before-cleanup');
          const privateCaptureBeforeCleanup = await flushPrivateCaptures();
          let identityAfter;
          let identityError;
          try { identityAfter = { loaded: loadedProof(), disk: diskProof() }; } catch (error) { identityError = error.message; }
          const boundary = observer?.snapshot() ?? null;
          const finalContracts = { mode: state.mode, qualification: 'SOURCE_ONLY_PARTIAL_RUNTIME_NOT_PRODUCTION', evidenceRoot, setupBlocked: state.setupBlocked ?? null, initialPassed: state.initialGate, historicalCopies: plan.files.length, protectedSources: references.size, firstActivationCallCount: state.first.length, firstActivationFailureCount: state.first.filter(record => !record.passed).length, firstFailures: state.first.filter(record => !record.passed).map(({ ordinal, path, error, call }) => ({ ordinal, path, error, call })), checkpoint19passed: state.checks.checkpoint19?.passed === true, hiddenpassed: state.checks['full109-hidden']?.passed === true, recoveredpassed: state.ordinaryActivationCount === 1 && state.recovered?.passed === true && state.checks['after-ordinary-activation']?.passed === true, firstActivationContract: state.first.length === 109 && state.first.every(record => record.passed), retentionPassed: state.retention?.passed === true, preservationPassed: beforeCleanup.passed, byteHashChanged: beforeCleanup.byteHashChanged, executionObserved: boundary?.registrationObserved === true && boundary.coldPanelObserved === true && boundary.blockers.length === 0, ingressCount: boundary?.ingressCount ?? null, startCount: boundary?.startCount ?? null, identityUnchanged: !identityError && equal(identityAfter?.loaded, state.loadedBefore) && equal(identityAfter?.disk, state.diskBefore), laterAccessibility: state.laterAccessibility ?? [] };
          finalContracts.recordedTiming = state.recordedTiming;
          finalContracts.timingEvents = state.timingEvents;
          write('final-outcome-before-cleanup', { finalContracts, beforeCleanup, boundary, privateCapture: privateCaptureBeforeCleanup, observationBlockers: [...state.observationBlockers], writerCaptures: state.writerCaptures, firstChangedCaptures: state.firstChangedCaptures, identityBefore: { loaded: state.loadedBefore, disk: state.diskBefore }, identityAfter, identityError });
          try { finalContracts.cleanup = await helper.closeAcceptanceTabs(vscode, owner, [...ownedUris]); }
          catch (error) { finalContracts.cleanup = { refused: true, error: error.message, dirtyDiscard: false }; }
          finally {
            let afterCleanup;
            let cleanupVerificationError;
            let restored;
            try {
              afterCleanup = preservation('after-cleanup');
              finalContracts.preservationPassed = finalContracts.preservationPassed && afterCleanup.passed;
              finalContracts.byteHashChanged = [...new Set([...finalContracts.byteHashChanged, ...afterCleanup.byteHashChanged])];
              finalContracts.ownedTabSurvivors = tabs().filter(tab => ownedUris.has(tab.input?.uri?.toString())).length;
            } catch (error) { cleanupVerificationError = String(error?.message ?? error); finalContracts.preservationPassed = false; }
            finally { for (const subscription of state.subscriptions) { try { subscription.dispose(); } catch {} } restored = observer?.restore() ?? null; }
            const privateCapture = await flushPrivateCaptures();
            finalContracts.observationBlockers = [...state.observationBlockers];
            finalContracts.writerObservationPassed = boundary?.writerObservation.enabled === true && boundary.writerObservation.installed === true && boundary.writerObservation.status === 'observing'
              && restored?.writerObservation.status === 'complete' && state.observationBlockers.length === 0 && [...state.writerCaptures, ...state.firstChangedCaptures].every(receipt => receipt.status === 'captured');
            finalContracts.observerRestored = restored?.restored === true && restored.blockers.length === 0;
            finalContracts.zeroExecutionPassed = finalContracts.executionObserved && boundary.ingressCount === 0 && boundary.startCount === 0 && restored?.ingressCount === 0 && restored?.startCount === 0;
            finalContracts.classification = state.setupBlocked ? 'SETUP_BLOCKED_INITIAL_CONTROL' : !finalContracts.preservationPassed ? 'PRESERVATION_FAILED' : !finalContracts.identityUnchanged || !finalContracts.zeroExecutionPassed || !finalContracts.observerRestored || !finalContracts.writerObservationPassed ? 'SOURCE_OR_OBSERVATION_BLOCKED' : !finalContracts.firstActivationContract || !finalContracts.checkpoint19passed || !finalContracts.hiddenpassed || !finalContracts.recoveredpassed || !finalContracts.retentionPassed ? 'SOURCE_ONLY_PRODUCT_CONTRACT_FAILED' : finalContracts.cleanup?.refused || finalContracts.ownedTabSurvivors !== 0 ? 'CLEANUP_BLOCKED' : 'SOURCE_ONLY_REPRO_NOT_OBSERVED';
            state.finalContracts = finalContracts;
            write('final-outcome', { finalContracts, beforeCleanup, afterCleanup, cleanupVerificationError, execution: restored, privateCapture, writerCaptures: state.writerCaptures, firstChangedCaptures: state.firstChangedCaptures, identityAfter, identityError });
          }
          return finalContracts;
        };
        try {
          state.diskBefore = diskProof();
          observer = helper.observeAcceptanceExecutionBoundary(workbenchRequire('vscode'), { ownedUris, coldUri: canary.toString(), coldSectionId: 'archive_source_fact', source: 'actual-workbench-vscode-facade', observeWrites: true, onWriterEvent: captureWriterAttempt });
          if (observer.snapshot().blockers.length !== 0) throw new Error('Actual facade observation cannot be armed');
          state.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => sampleDocument(document, 'open')), vscode.workspace.onDidChangeTextDocument(event => sampleDocument(event.document, 'change', event.contentChanges)), vscode.window.tabGroups.onDidChangeTabs(sampleTabs), vscode.window.tabGroups.onDidChangeTabGroups(sampleTabs));
          await extension.activate();
          state.loadedBefore = loadedProof();
          orchestrator = Object.values(workbenchRequire.cache).find(candidate => samePath(candidate?.filename, main)).exports.toolOrchestrator;
          if (!observer.snapshot().registrationObserved || observer.snapshot().blockers.length !== 0) throw new Error('Actual custom-editor registration was not observed');
          if (!(await vscode.commands.getCommands(true)).includes('kustoWorkbench.test.preparePersistedResultFixture')) throw new Error('Development fixture command missing');
          await vscode.workspace.getConfiguration('workbench.editor').update('enablePreview', false, vscode.ConfigurationTarget.Global);
          await vscode.workspace.getConfiguration('files').update('autoSaveDelay', 1000, vscode.ConfigurationTarget.Global);
          await vscode.workspace.getConfiguration('files').update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
          if (vscode.workspace.getConfiguration('workbench.editor').get('enablePreview') !== false || vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000) throw new Error('Isolated preview/Auto Save settings did not settle');
          const prepared = await vscode.commands.executeCommand('kustoWorkbench.test.preparePersistedResultFixture', { engine: 'kusto', templatePath: template, outputPath: canary.fsPath, exposeToActiveContent: true });
          if (!samePath(prepared?.outputPath, canary.fsPath) || typeof prepared.connectionId !== 'string' || !prepared.connectionId) throw new Error('Synthetic fixture preparation did not return its own owner');
          const canaryBytes = fs.readFileSync(canary.fsPath);
          const preparedSections = JSON.parse(canaryBytes.toString('utf8')).state.sections;
          baselineFact = preparedSections[0];
          if (baselineFact.id !== 'archive_source_fact' || !equal(preparedSections.map(section => [section.id, section.type]), sections.map(section => [section.id, section.type])) || !equal(JSON.parse(baselineFact.resultJson).rows, factRows)) throw new Error('Synthetic prepared fixture lost authored sections or values');
          const preparedArtifact = baselineFact.resultArtifact;
          if (preparedArtifact?.version !== 1 || preparedArtifact.artifactId !== 'result:archive_source_fact:1' || preparedArtifact.sourceBoxId !== baselineFact.id || preparedArtifact.revision !== 1
            || preparedArtifact.producer?.engine !== 'kusto' || preparedArtifact.producer.boxId !== baselineFact.id || preparedArtifact.producer.connectionId !== prepared.connectionId
            || preparedArtifact.producer.query !== baselineFact.query || preparedArtifact.producer.database !== baselineFact.database
            || preparedArtifact.policy?.accountPartition !== baselineFact.kustoAccountPartition || preparedArtifact.policy.leaveNoTraceRevision !== baselineFact.kustoLeaveNoTraceRevision
            || preparedArtifact.policy.exposeToActiveContent !== true || ['sendToModel', 'shareToClipboard', 'exportToCsv'].some(capability => Object.hasOwn(preparedArtifact.policy, capability))) throw new Error('New synthetic canary lacks its exact authored active-content-only artifact before opening');
          state.syntheticFixture = { outputPath: prepared.outputPath, connectionId: prepared.connectionId, savedPayloadSha256: hash(baselineFact.resultJson), savedAttachmentSha256: baselineFact.resultArtifact === undefined ? null : hash(JSON.stringify(baselineFact.resultArtifact)), setupSaveCount: 0 };
          write('synthetic-fixture-baseline', state.syntheticFixture);
          const initial = await invoke('kusto-workbench_activate-workbench-file', { targetFileUri: canary.toString() }, 'initial');
          state.initialActivationCall = initial.sequence;
          if (!activationShape(initial, canary.toString()) || !initial.value.openFileId) throw new Error('First synthetic public activation failed; no full-load reproduction or retry');
          await waitExactTab(canary.toString(), false, true);
          const metadata = orchestrator.collectOpenWorkbenchFiles().openFiles.filter(file => file.uri === canary.toString());
          if (metadata.length !== 1 || metadata[0].openFileId !== initial.value.openFileId) throw new Error('Exact synthetic metadata identity missing or changed');
          state.canaryId = initial.value.openFileId;
          state.syntheticFixture.setupSaveCount++;
          await vscode.commands.executeCommand('workbench.action.files.save');
          const saveDeadline = Date.now() + 10000;
          let stableSince = Date.now();
          let previousText = null;
          let authoredBytes;
          while (Date.now() < saveDeadline) {
            const bytes = fs.readFileSync(canary.fsPath);
            const text = bytes.toString('utf8');
            const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === canary.toString());
            if (!document || document.isDirty || document.getText() !== text || text !== previousText) stableSince = Date.now();
            if (document && !document.isDirty && document.getText() === text && Date.now() - stableSince >= 500) { authoredBytes = bytes; break; }
            previousText = text;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!authoredBytes || activeUri() !== canary.toString()) throw new Error('One synthetic setup Save did not settle on its exact target; no Save replay');
          const authoredSections = JSON.parse(authoredBytes.toString('utf8')).state.sections;
          baselineFact = authoredSections[0];
          const authoredResult = JSON.parse(baselineFact.resultJson);
          if (!equal(baselineFact.resultArtifact, preparedArtifact)) throw new Error('Synthetic setup Save changed the prepared saved-result descriptor or its permissions');
          if (!equal(authoredSections.map(section => [section.id, section.type]), sections.map(section => [section.id, section.type])) || !equal(authoredResult.columns, factColumns) || !equal(authoredResult.rows, factRows)
            || !equal(authoredSections.find(section => section.type === 'devnotes').entries, [expectedNote]) || authoredSections.find(section => section.type === 'html').code !== dashboardCode) throw new Error('Synthetic setup Save changed required authored values');
          references.set(canary.toString(), { path: path.basename(canary.fsPath), file: canary.fsPath, sha256: hash(authoredBytes), text: authoredBytes.toString('utf8') });
          state.syntheticFixture.authoredBaselineSha256 = hash(authoredBytes);
          state.syntheticFixture.authoredSavedPayloadSha256 = hash(baselineFact.resultJson);
          write('synthetic-fixture-authored-baseline', state.syntheticFixture);
          const initialOracles = await state.oracles('initial', false);
          const initialPreservation = preservation('initial');
          const initialBoundary = observer.snapshot();
          if (!initialOracles.passed || !initialPreservation.passed || !initialBoundary.coldPanelObserved || initialBoundary.ingressCount !== 0 || initialBoundary.startCount !== 0 || initialBoundary.blockers.length !== 0) throw new Error('Initial exact own-data/notes/dashboard/preservation/execution control failed');
          state.initialGate = true;
          state.replayStart = Date.now() + (state.recordedTiming?.firstOpenDelayMs ?? 0);
          return { mode: state.mode, initialPassed: true, archive: plan.archive, originalOrderCount: historicalUris.length, ownedHistoricalCopies: plan.files.length, protectedSourceCount: 134, unopenedIndependentColdCopyCount: 1, syntheticFixture: state.syntheticFixture, initialOracles, loadedIdentity: state.loadedBefore, diskIdentity: state.diskBefore, evidenceRoot };
        } catch (error) {
          state.setupBlocked = String(error?.message ?? error);
          try { await state.finish(); } catch (cleanupError) { write('setup-finalizer-blocked', { error: String(cleanupError?.message ?? cleanupError) }); state.subscriptions.forEach(subscription => subscription.dispose()); observer?.restore(); }
          throw new Error('SETUP_BLOCKED_INITIAL_CONTROL: ' + state.setupBlocked + '; no completed pressure repro; evidence: ' + evidenceRoot);
        }
      })()
      """
    When I set the global log level to "Trace"
    Then I collect JSON artifact "activation-001" from extension host expression "globalThis.__archiveSourceRepro.activateOne(0)"
    Then I collect JSON artifact "activation-002" from extension host expression "globalThis.__archiveSourceRepro.activateOne(1)"
    Then I collect JSON artifact "activation-003" from extension host expression "globalThis.__archiveSourceRepro.activateOne(2)"
    Then I collect JSON artifact "activation-004" from extension host expression "globalThis.__archiveSourceRepro.activateOne(3)"
    Then I collect JSON artifact "activation-005" from extension host expression "globalThis.__archiveSourceRepro.activateOne(4)"
    Then I collect JSON artifact "activation-006" from extension host expression "globalThis.__archiveSourceRepro.activateOne(5)"
    Then I collect JSON artifact "activation-007" from extension host expression "globalThis.__archiveSourceRepro.activateOne(6)"
    Then I collect JSON artifact "activation-008" from extension host expression "globalThis.__archiveSourceRepro.activateOne(7)"
    Then I collect JSON artifact "activation-009" from extension host expression "globalThis.__archiveSourceRepro.activateOne(8)"
    Then I collect JSON artifact "activation-010" from extension host expression "globalThis.__archiveSourceRepro.activateOne(9)"
    Then I collect JSON artifact "activation-011" from extension host expression "globalThis.__archiveSourceRepro.activateOne(10)"
    Then I collect JSON artifact "activation-012" from extension host expression "globalThis.__archiveSourceRepro.activateOne(11)"
    Then I collect JSON artifact "activation-013" from extension host expression "globalThis.__archiveSourceRepro.activateOne(12)"
    Then I collect JSON artifact "activation-014" from extension host expression "globalThis.__archiveSourceRepro.activateOne(13)"
    Then I collect JSON artifact "activation-015" from extension host expression "globalThis.__archiveSourceRepro.activateOne(14)"
    Then I collect JSON artifact "activation-016" from extension host expression "globalThis.__archiveSourceRepro.activateOne(15)"
    Then I collect JSON artifact "activation-017" from extension host expression "globalThis.__archiveSourceRepro.activateOne(16)"
    Then I collect JSON artifact "activation-018" from extension host expression "globalThis.__archiveSourceRepro.activateOne(17)"
    Then I collect JSON artifact "activation-019" from extension host expression "globalThis.__archiveSourceRepro.activateOne(18)"
    Then I collect JSON artifact "checkpoint19-hidden-oracles" from extension host expression "globalThis.__archiveSourceRepro.oracles('checkpoint19', true)"
    Then I collect JSON artifact "activation-020" from extension host expression "globalThis.__archiveSourceRepro.activateOne(19)"
    Then I collect JSON artifact "activation-021" from extension host expression "globalThis.__archiveSourceRepro.activateOne(20)"
    Then I collect JSON artifact "activation-022" from extension host expression "globalThis.__archiveSourceRepro.activateOne(21)"
    Then I collect JSON artifact "activation-023" from extension host expression "globalThis.__archiveSourceRepro.activateOne(22)"
    Then I collect JSON artifact "activation-024" from extension host expression "globalThis.__archiveSourceRepro.activateOne(23)"
    Then I collect JSON artifact "activation-025" from extension host expression "globalThis.__archiveSourceRepro.activateOne(24)"
    Then I collect JSON artifact "activation-026" from extension host expression "globalThis.__archiveSourceRepro.activateOne(25)"
    Then I collect JSON artifact "activation-027" from extension host expression "globalThis.__archiveSourceRepro.activateOne(26)"
    Then I collect JSON artifact "activation-028" from extension host expression "globalThis.__archiveSourceRepro.activateOne(27)"
    Then I collect JSON artifact "activation-029" from extension host expression "globalThis.__archiveSourceRepro.activateOne(28)"
    Then I collect JSON artifact "activation-030" from extension host expression "globalThis.__archiveSourceRepro.activateOne(29)"
    Then I collect JSON artifact "activation-031" from extension host expression "globalThis.__archiveSourceRepro.activateOne(30)"
    Then I collect JSON artifact "activation-032" from extension host expression "globalThis.__archiveSourceRepro.activateOne(31)"
    Then I collect JSON artifact "activation-033" from extension host expression "globalThis.__archiveSourceRepro.activateOne(32)"
    Then I collect JSON artifact "activation-034" from extension host expression "globalThis.__archiveSourceRepro.activateOne(33)"
    Then I collect JSON artifact "activation-035" from extension host expression "globalThis.__archiveSourceRepro.activateOne(34)"
    Then I collect JSON artifact "activation-036" from extension host expression "globalThis.__archiveSourceRepro.activateOne(35)"
    Then I collect JSON artifact "activation-037" from extension host expression "globalThis.__archiveSourceRepro.activateOne(36)"
    Then I collect JSON artifact "activation-038" from extension host expression "globalThis.__archiveSourceRepro.activateOne(37)"
    Then I collect JSON artifact "activation-039" from extension host expression "globalThis.__archiveSourceRepro.activateOne(38)"
    Then I collect JSON artifact "activation-040" from extension host expression "globalThis.__archiveSourceRepro.activateOne(39)"
    Then I collect JSON artifact "activation-041" from extension host expression "globalThis.__archiveSourceRepro.activateOne(40)"
    Then I collect JSON artifact "activation-042" from extension host expression "globalThis.__archiveSourceRepro.activateOne(41)"
    Then I collect JSON artifact "activation-043" from extension host expression "globalThis.__archiveSourceRepro.activateOne(42)"
    Then I collect JSON artifact "activation-044" from extension host expression "globalThis.__archiveSourceRepro.activateOne(43)"
    Then I collect JSON artifact "activation-045" from extension host expression "globalThis.__archiveSourceRepro.activateOne(44)"
    Then I collect JSON artifact "activation-046" from extension host expression "globalThis.__archiveSourceRepro.activateOne(45)"
    Then I collect JSON artifact "activation-047" from extension host expression "globalThis.__archiveSourceRepro.activateOne(46)"
    Then I collect JSON artifact "activation-048" from extension host expression "globalThis.__archiveSourceRepro.activateOne(47)"
    Then I collect JSON artifact "activation-049" from extension host expression "globalThis.__archiveSourceRepro.activateOne(48)"
    Then I collect JSON artifact "activation-050" from extension host expression "globalThis.__archiveSourceRepro.activateOne(49)"
    Then I collect JSON artifact "activation-051" from extension host expression "globalThis.__archiveSourceRepro.activateOne(50)"
    Then I collect JSON artifact "activation-052" from extension host expression "globalThis.__archiveSourceRepro.activateOne(51)"
    Then I collect JSON artifact "activation-053" from extension host expression "globalThis.__archiveSourceRepro.activateOne(52)"
    Then I collect JSON artifact "activation-054" from extension host expression "globalThis.__archiveSourceRepro.activateOne(53)"
    Then I collect JSON artifact "activation-055" from extension host expression "globalThis.__archiveSourceRepro.activateOne(54)"
    Then I collect JSON artifact "activation-056" from extension host expression "globalThis.__archiveSourceRepro.activateOne(55)"
    Then I collect JSON artifact "activation-057" from extension host expression "globalThis.__archiveSourceRepro.activateOne(56)"
    Then I collect JSON artifact "activation-058" from extension host expression "globalThis.__archiveSourceRepro.activateOne(57)"
    Then I collect JSON artifact "activation-059" from extension host expression "globalThis.__archiveSourceRepro.activateOne(58)"
    Then I collect JSON artifact "activation-060" from extension host expression "globalThis.__archiveSourceRepro.activateOne(59)"
    Then I collect JSON artifact "activation-061" from extension host expression "globalThis.__archiveSourceRepro.activateOne(60)"
    Then I collect JSON artifact "activation-062" from extension host expression "globalThis.__archiveSourceRepro.activateOne(61)"
    Then I collect JSON artifact "activation-063" from extension host expression "globalThis.__archiveSourceRepro.activateOne(62)"
    Then I collect JSON artifact "activation-064" from extension host expression "globalThis.__archiveSourceRepro.activateOne(63)"
    Then I collect JSON artifact "activation-065" from extension host expression "globalThis.__archiveSourceRepro.activateOne(64)"
    Then I collect JSON artifact "activation-066" from extension host expression "globalThis.__archiveSourceRepro.activateOne(65)"
    Then I collect JSON artifact "activation-067" from extension host expression "globalThis.__archiveSourceRepro.activateOne(66)"
    Then I collect JSON artifact "activation-068" from extension host expression "globalThis.__archiveSourceRepro.activateOne(67)"
    Then I collect JSON artifact "activation-069" from extension host expression "globalThis.__archiveSourceRepro.activateOne(68)"
    Then I collect JSON artifact "activation-070" from extension host expression "globalThis.__archiveSourceRepro.activateOne(69)"
    Then I collect JSON artifact "activation-071" from extension host expression "globalThis.__archiveSourceRepro.activateOne(70)"
    Then I collect JSON artifact "activation-072" from extension host expression "globalThis.__archiveSourceRepro.activateOne(71)"
    Then I collect JSON artifact "activation-073" from extension host expression "globalThis.__archiveSourceRepro.activateOne(72)"
    Then I collect JSON artifact "activation-074" from extension host expression "globalThis.__archiveSourceRepro.activateOne(73)"
    Then I collect JSON artifact "activation-075" from extension host expression "globalThis.__archiveSourceRepro.activateOne(74)"
    Then I collect JSON artifact "activation-076" from extension host expression "globalThis.__archiveSourceRepro.activateOne(75)"
    Then I collect JSON artifact "activation-077" from extension host expression "globalThis.__archiveSourceRepro.activateOne(76)"
    Then I collect JSON artifact "activation-078" from extension host expression "globalThis.__archiveSourceRepro.activateOne(77)"
    Then I collect JSON artifact "activation-079" from extension host expression "globalThis.__archiveSourceRepro.activateOne(78)"
    Then I collect JSON artifact "activation-080" from extension host expression "globalThis.__archiveSourceRepro.activateOne(79)"
    Then I collect JSON artifact "activation-081" from extension host expression "globalThis.__archiveSourceRepro.activateOne(80)"
    Then I collect JSON artifact "activation-082" from extension host expression "globalThis.__archiveSourceRepro.activateOne(81)"
    Then I collect JSON artifact "activation-083" from extension host expression "globalThis.__archiveSourceRepro.activateOne(82)"
    Then I collect JSON artifact "activation-084" from extension host expression "globalThis.__archiveSourceRepro.activateOne(83)"
    Then I collect JSON artifact "activation-085" from extension host expression "globalThis.__archiveSourceRepro.activateOne(84)"
    Then I collect JSON artifact "activation-086" from extension host expression "globalThis.__archiveSourceRepro.activateOne(85)"
    Then I collect JSON artifact "activation-087" from extension host expression "globalThis.__archiveSourceRepro.activateOne(86)"
    Then I collect JSON artifact "activation-088" from extension host expression "globalThis.__archiveSourceRepro.activateOne(87)"
    Then I collect JSON artifact "activation-089" from extension host expression "globalThis.__archiveSourceRepro.activateOne(88)"
    Then I collect JSON artifact "activation-090" from extension host expression "globalThis.__archiveSourceRepro.activateOne(89)"
    Then I collect JSON artifact "activation-091" from extension host expression "globalThis.__archiveSourceRepro.activateOne(90)"
    Then I collect JSON artifact "activation-092" from extension host expression "globalThis.__archiveSourceRepro.activateOne(91)"
    Then I collect JSON artifact "activation-093" from extension host expression "globalThis.__archiveSourceRepro.activateOne(92)"
    Then I collect JSON artifact "activation-094" from extension host expression "globalThis.__archiveSourceRepro.activateOne(93)"
    Then I collect JSON artifact "activation-095" from extension host expression "globalThis.__archiveSourceRepro.activateOne(94)"
    Then I collect JSON artifact "activation-096" from extension host expression "globalThis.__archiveSourceRepro.activateOne(95)"
    Then I collect JSON artifact "activation-097" from extension host expression "globalThis.__archiveSourceRepro.activateOne(96)"
    Then I collect JSON artifact "activation-098" from extension host expression "globalThis.__archiveSourceRepro.activateOne(97)"
    Then I collect JSON artifact "activation-099" from extension host expression "globalThis.__archiveSourceRepro.activateOne(98)"
    Then I collect JSON artifact "activation-100" from extension host expression "globalThis.__archiveSourceRepro.activateOne(99)"
    Then I collect JSON artifact "activation-101" from extension host expression "globalThis.__archiveSourceRepro.activateOne(100)"
    Then I collect JSON artifact "activation-102" from extension host expression "globalThis.__archiveSourceRepro.activateOne(101)"
    Then I collect JSON artifact "activation-103" from extension host expression "globalThis.__archiveSourceRepro.activateOne(102)"
    Then I collect JSON artifact "activation-104" from extension host expression "globalThis.__archiveSourceRepro.activateOne(103)"
    Then I collect JSON artifact "activation-105" from extension host expression "globalThis.__archiveSourceRepro.activateOne(104)"
    Then I collect JSON artifact "activation-106" from extension host expression "globalThis.__archiveSourceRepro.activateOne(105)"
    Then I collect JSON artifact "activation-107" from extension host expression "globalThis.__archiveSourceRepro.activateOne(106)"
    Then I collect JSON artifact "activation-108" from extension host expression "globalThis.__archiveSourceRepro.activateOne(107)"
    Then I collect JSON artifact "activation-109" from extension host expression "globalThis.__archiveSourceRepro.activateOne(108)"
    Then I collect JSON artifact "full109-hidden-and-later-inventory" from extension host expression "globalThis.__archiveSourceRepro.afterLoad()"
    Then I collect JSON artifact "sole-ordinary-exact-id-activation-and-oracles" from extension host expression "globalThis.__archiveSourceRepro.recoverOnce()"
    Then I collect JSON artifact "final-contracts-and-exact-cleanup" from extension host expression "globalThis.__archiveSourceRepro.finish()"
    Then I collect JSON artifact "assert-independent-repro-contracts" from extension host expression:
      """
      (() => {
        const result = globalThis.__archiveSourceRepro.finalContracts;
        if (!result.initialPassed || !result.firstActivationContract || !result.checkpoint19passed || !result.hiddenpassed || !result.recoveredpassed || !result.retentionPassed || !result.preservationPassed || !result.zeroExecutionPassed || !result.identityUnchanged || !result.observerRestored || !result.writerObservationPassed || result.ownedTabSurvivors !== 0 || result.cleanup?.refused) throw new Error('SOURCE_ONLY_CONTRACT_FAILED: ' + JSON.stringify(result));
        return result;
      })()
      """