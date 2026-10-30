# Fresh isolated launch only, with --no-build --vscode-version 1.143.0 --vscode-arg=--log=trace.
# KW_TYPESPEC_FROZEN_MANIFEST and KW_TYPESPEC_FROZEN_SHA identify a verified copy of existing runtime assets.
# KW_TYPESPEC_TRIAL=standalone is first; prefix100-103 requires KW_TYPESPEC_STANDALONE_RECEIPT from a passing fresh host.
# C1: exact archived TypeSpec bytes -> first public URI activation -> immediate semantic oracle -> preservation -> exact clean close.
# C2: a separate fresh host retains archived targets 100-103, then applies the identical first-call oracle to TypeSpec.
# Owners: public LM tool, native custom editor, startup gateway/projection, SDK document versions, exact URI cleanup.
# Existing archive sweeps are partial evidence, not this standalone first-call contract. No getter, inventory, retry, Save, or query.
# Deferred: warm16/profile fidelity, original109 pressure, long hidden outage, installed Production identity, and visual qualification.
# Standard product Trace logs are retained; file-open traces do not prove actual SDK probe delivery or ACK admission.
Feature: Archived TypeSpec first public activation

  Scenario: An unopened archived TypeSpec copy activates successfully on its first public call
    Given I capture the output channel "Kusto Workbench"
    And I capture the output channel "Extension Tester Controller"
    And I collect JSON artifact "typespec-first-activation-evidence" from extension host expression:
      """
      (async function runTypeSpecAcceptance() {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const modules = process.getBuiltinModule('node:module');
        const url = process.getBuiltinModule('node:url');
        const assert = process.getBuiltinModule('node:assert/strict');
        const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
        const canonicalPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const tabSnapshot = () => tabs().map(tab => ({ uri: tab.input?.uri?.toString() ?? null, viewType: tab.input?.viewType ?? null, dirty: tab.isDirty, active: tab.isActive }));
        const archive = path.join(process.getBuiltinModule('node:os').tmpdir(), 'kw-regression-build2-before-2026-10-20-500ddb040c5b4dcf87630e2d488f4112.zip');
        const archiveSha256 = 'f743e4f9be3e2470301a5ef9b0b0961022f5fdf8a3be8355a6f912ab5e82d9b3';
        const targetPath = 'shared/lori/typespec/typespec vs old (with fix for E2D).kqlx';
        const previous = globalThis.__typespecFirstActivation;
        const outcome = { schemaVersion: 1, trial: process.env.KW_TYPESPEC_TRIAL ?? 'standalone', classification: 'SETUP_BLOCKED', calls: [], models: [], damage: [], saved: [], errors: [], evidenceFailures: [], evidenceFailureCount: 0, checks: { evidenceSink: true }, dispatcherObservation: { schemaVersion: 2, observed: false, complete: false, completeCapture: false, restored: false, boundaryDiagnostics: [], boundaryDiagnosticOverflow: 0, status: 'NOT_INSTALLED' }, limitations: ['Development runtime snapshot, not the incident loaded-memory image or installed Production build', 'No visual review', 'Passive SDK observations do not establish production ACK admission or a timeout cause', 'No auth or data-query requests; no claim of instrumented absence of all physical network activity'] };
        globalThis.__typespecFirstActivation = outcome;
        outcome.guardContract = { version: 'typespec-dispatcher-v3', scriptSha256: hash(Function.prototype.toString.call(runTypeSpecAcceptance)) };
        const references = new Map();
        const models = new Map();
        const initialDocumentReferences = new Map();
        let initialDocumentsAdmitted = false;
        const initialDocumentMetadata = document => {
          const metadata = { uri: document.uri.toString(), scheme: document.uri.scheme, version: document.version, dirty: document.isDirty, languageId: document.languageId };
          return { ...metadata, ownershipClassification: metadata.uri === 'chatSessionInput:input-0' && metadata.scheme === 'chatSessionInput' && metadata.languageId === 'plaintext' && metadata.dirty === false && Number.isSafeInteger(metadata.version) && metadata.version > 0 ? 'framework-chat-input' : 'unknown-before-manifest' };
        };
        const preserveInitialDocuments = label => {
          if (!initialDocumentsAdmitted) return;
          const damageCount = outcome.damage.length;
          for (const [document, expected] of initialDocumentReferences) {
            const sameDocument = vscode.workspace.textDocuments.includes(document);
            const actual = sameDocument ? initialDocumentMetadata(document) : null;
            if (!sameDocument || Object.keys(expected).some(key => actual[key] !== expected[key])) outcome.damage.push({ label, kind: 'framework-chat-input', expected, actual, sameDocument });
          }
          assert.equal(outcome.damage.length, damageCount, 'Pre-existing framework chat model changed: ' + label);
        };
        const subscriptions = [];
        const settings = [];
        outcome.configuration = { workspaceFile: vscode.workspace.workspaceFile?.toString() ?? null, presetOnly: process.env.KW_TYPESPEC_PRESET_ONLY === '1', changes: [] };
        let helper, owner, evidenceRoot, manifest, main, workbenchRequire, extension, helperPath, helperSha256, dispatcherObserver, startupCapture;
        let phase = 'setup';
        const write = (name, value) => {
          if (!evidenceRoot) return;
          try {
            helper.assertAcceptanceRoot(owner);
            fs.writeFileSync(path.join(evidenceRoot, name + '.json'), JSON.stringify(value, null, 2));
          } catch {
            outcome.evidenceFailureCount++;
            if (outcome.evidenceFailures.length < 16) outcome.evidenceFailures.push({ checkpoint: name.slice(0, 128), code: 'EVIDENCE_WRITE_FAILED' });
            outcome.checks.evidenceSink = false;
            if (outcome.classification === 'PASS') outcome.classification = 'EVIDENCE_OR_CLEANUP_FAILED';
          }
        };
        const verifyTypeSpecTrace = async () => {
          const controllerPort = Number(process.env.VSCODE_EXT_TESTER_PORT);
          const cdpPort = Number(process.env.KW_TYPESPEC_CDP_PORT);
          for (const port of [controllerPort, cdpPort]) assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Exact isolated tester ports required');
          assert.notEqual(controllerPort, cdpPort);
          const testerRequire = modules.createRequire(path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/package.json'));
          assert.equal(testerRequire('./package.json').version, '0.1.24');
          const { ControllerClient } = testerRequire('./dist/runner/controller-client.js');
          const { TestRunner } = testerRequire('./dist/runner/test-runner.js');
          const client = new ControllerClient(controllerPort);
          const runner = new TestRunner(client, {}, undefined, undefined, cdpPort);
          try {
            await client.connect();
            await runner.setLogLevel('Trace', 'Kusto Workbench');
            outcome.namedChannelAssertion = await runner.runSingleStep({
              keyword: 'Then ', text: 'the output channel "Kusto Workbench" log level should be "Trace"',
            }, { screenshotPolicy: 'never', captureLogs: false, includeState: false });
            assert.equal(outcome.namedChannelAssertion.status, 'passed', outcome.namedChannelAssertion.error?.message);
            outcome.checks.namedChannelTrace = true;
          } finally {
            try { runner.cleanup(); } finally { client.disconnect(); }
          }
        };
        const captureFailedTypeSpecRenderer = async () => {
          const failed = outcome.calls.find(call => call.oraclePassed === false);
          const reference = failed && references.get(failed.input?.targetFileUri);
          if (!reference?.sectionIds?.length) return { status: 'unavailable', reason: 'no-section-identity' };
          const active = tabs().filter(tab => tab.isActive);
          if (active.length !== 1 || active[0].input?.uri?.toString() !== reference.uri) return { status: 'unavailable', reason: 'active-target-mismatch' };
          const peerIds = new Set([...references.values()].filter(candidate => candidate !== reference).flatMap(candidate => candidate.sectionIds || []));
          const uniqueIds = reference.sectionIds.filter(id => !peerIds.has(id));
          if (!uniqueIds.length) return { status: 'unavailable', reason: 'ambiguous-section-identity' };
          const started = performance.now();
          let client, timer, retired = false, settled = false;
          const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout', pendingAtDeadline: !settled }), 4000); });
          const inspect = (async () => {
            try {
              const testerRequire = modules.createRequire(path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/package.json'));
              assert.equal(testerRequire('./package.json').version, '0.1.24');
              const port = Number(process.env.KW_TYPESPEC_CDP_PORT);
              assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
              const { CdpClient } = testerRequire('./dist/runner/cdp-client.js');
              client = new CdpClient(port);
              await client.connect();
              if (retired) return { status: 'unavailable', reason: 'deadline' };
              const expression = `(() => {
                const ids = ${JSON.stringify(uniqueIds)};
                if (!ids.every(id => document.getElementById(id))) return null;
                const descriptor = Object.getOwnPropertyDescriptor(window, '__kustoHostMessageDispatcherReady');
                return { matchedSectionCount: ids.length, readyState: document.readyState, visibility: document.visibilityState,
                  dispatcherFlag: !descriptor ? 'absent' : !Object.hasOwn(descriptor, 'value') ? 'accessor' : descriptor.value === true ? 'true' : 'other',
                  querySections: document.querySelectorAll('kw-query-section').length,
                  markdownSections: document.querySelectorAll('kw-markdown-section').length };
              })()`;
              const value = await client.evaluateInWebview(expression, undefined, { timeoutMs: Math.max(1, 4000 - (performance.now() - started)) });
              if (retired) return { status: 'unavailable', reason: 'late-result' };
              if (value?.matchedSectionCount !== uniqueIds.length) return { status: 'unavailable', reason: 'target-not-observed' };
              return { status: 'available', referenceIndex: reference.index, identity: 'unique-section-ids-in-single-opened-reference', value,
                limitation: 'Dispatcher flag is an installation latch, not proof of listener liveness; the standard tester may poll frame discovery and install a temporary capture marker until host shutdown' };
            } catch { return { status: 'unavailable', reason: 'inspection-failed' }; }
            finally { settled = true; try { client?.disconnect(); } catch {} }
          })();
          try { return { ...await Promise.race([inspect, timeout]), elapsedMs: performance.now() - started }; }
          finally { retired = true; clearTimeout(timer); try { client?.disconnect(); } catch {} }
        };
        const pendingTypeSpecCaptures = new Set();
        const startPendingTypeSpecCapture = reference => {
          let originalSettled = false, retired = false, trigger, budget, client, task, row;
          const disconnect = () => { try { client?.disconnect(); } catch {} };
          const clear = timer => { try { clearTimeout(timer); } catch {} };
          const capture = {
            settle() { originalSettled = true; clear(trigger); if (!task) pendingTypeSpecCaptures.delete(capture); },
            retire() {
              retired = true;
              clear(trigger); clear(budget); disconnect();
              if (row?.status === 'capturing') row.status = 'retired';
              pendingTypeSpecCaptures.delete(capture);
            },
          };
          pendingTypeSpecCaptures.add(capture);
          const inspect = async () => {
            const started = performance.now();
            let stage = 'native', native;
            let expired = false;
            const timeout = new Promise(resolve => { budget = setTimeout(() => { expired = true; resolve({ status: 'timeout' }); }, 4000); });
            const operation = (async () => {
              try {
                const active = tabs().filter(tab => tab.isActive);
                const document = reference.uri ? vscode.workspace.textDocuments.find(document => document.uri.toString() === reference.uri) : undefined;
                native = { activeTabMatches: active.length === 1 && active[0].input?.uri?.toString() === reference.uri,
                  documentPresent: !!document, ...(document ? { version: document.version, dirty: document.isDirty } : {}) };
                const testerRequire = modules.createRequire(path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/package.json'));
                assert.equal(testerRequire('./package.json').version, '0.1.24');
                const port = Number(process.env.KW_TYPESPEC_CDP_PORT);
                assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
                const { CdpClient } = testerRequire('./dist/runner/cdp-client.js');
                client = new CdpClient(port);
                stage = 'connecting';
                await client.connect();
                if (retired || expired) return { status: 'retired' };
                stage = 'evaluating';
                const expression = `(() => {
                  if (!document.querySelector('.monaco-workbench')) return null;
                  const visible = element => !!element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
                  const name = ${JSON.stringify(path.basename(reference.path))};
                  return { readyState: document.readyState, iframeCount: document.querySelectorAll('iframe').length,
                    quickInputVisible: visible(document.querySelector('.quick-input-widget')),
                    visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).length,
                    activeNameMatches: Array.from(document.querySelectorAll('.tab.active .label-name')).some(element => element.textContent === name) };
                })()`;
                const value = await client.evaluate(expression, { timeoutMs: Math.max(1, 4000 - (performance.now() - started)) });
                if (retired || expired) return { status: 'retired' };
                if (!value || !['loading', 'interactive', 'complete'].includes(value.readyState)
                  || !Number.isSafeInteger(value.iframeCount) || !Number.isSafeInteger(value.visibleDialogs)
                  || typeof value.quickInputVisible !== 'boolean' || typeof value.activeNameMatches !== 'boolean') return { status: 'unavailable', reason: 'workbench-not-observed', native };
                stage = 'complete';
                return { status: 'available', native, workbench: { readyState: value.readyState, iframeCount: value.iframeCount,
                  quickInputVisible: value.quickInputVisible, visibleDialogs: value.visibleDialogs, activeNameMatches: value.activeNameMatches },
                  limitation: 'Main workbench facts and basename match are not proof of webview identity or listener liveness' };
              } catch { return { status: 'unavailable', reason: 'inspection-failed' }; }
              finally { disconnect(); }
            })();
            try { return { ...await Promise.race([operation, timeout]), stage, ...(native ? { native } : {}), elapsedMs: performance.now() - started, sampledWhilePending: !originalSettled }; }
            finally { clear(budget); disconnect(); }
          };
          try {
            trigger = setTimeout(() => {
              if (originalSettled || retired) return;
              row = { referenceIndex: reference.index, status: 'capturing', startedUtc: new Date().toISOString(), triggerDelayMs: 5000 };
              (outcome.pendingActivationDiagnostics ??= []).push(row);
              task = Promise.resolve().then(inspect).then(value => {
                if (retired) return;
                Object.assign(row, value);
                write('pending-activation-' + reference.index, row);
              }).catch(() => {
                if (retired) return;
                row.status = 'unavailable'; row.reason = 'capture-failed';
                try { write('pending-activation-' + reference.index, row); } catch {}
              }).finally(() => { pendingTypeSpecCaptures.delete(capture); });
            }, 5000);
          } catch { pendingTypeSpecCaptures.delete(capture); }
          return capture;
        };
        const createTypeSpecDispatcherObserver = ({ references, getPhase, clock, setTimer = setTimeout, clearTimer = clearTimeout }) => {
          const nativeThen = Promise.prototype.then;
          const isNativePromise = process.getBuiltinModule('node:util').types.isPromise;
          const isProxy = process.getBuiltinModule('node:util').types.isProxy;
          const fields = ['type', 'probeId', 'runtimeId', 'requestId', 'reloadRequestId', 'sourceGeneration', 'viewSessionId', 'applied'];
          const descriptorFields = ['configurable', 'enumerable', 'writable', 'value', 'get', 'set'];
          const state = { schemaVersion: 2, registrationInstalled: false, registrationObserved: false, registrationCalls: 0, captureFailures: 0, boundaryUnavailable: 0, boundaryDiagnostics: [], boundaryDiagnosticOverflow: 0, overflow: 0, truncated: 0, settlementUnavailable: 0, restoreMismatch: 0, restoreFailures: 0, disposeFailures: 0, pendingAtRestore: 0, restored: false };
          const records = [], patches = [], listeners = [];
          const panels = new Map(), providers = new WeakSet();
          let retired = false, installed = false, sequence = 0;
          let drainPromise, notifyDrain;
          const safeTry = action => { try { return action(); } catch { state.captureFailures++; } };
          const sameDescriptor = (left, right) => !left || !right ? left === right : descriptorFields.every(key => Object.hasOwn(left, key) === Object.hasOwn(right, key) && Object.is(left[key], right[key]));
          const stamp = () => {
            const atMs = clock(), phase = getPhase();
            if (!Number.isFinite(atMs) || typeof phase !== 'string' || phase.length > 128) throw new Error('Observation clock or phase unavailable');
            return { atMs, phase, order: ++sequence };
          };
          const capture = (panel, direction, message) => {
            if (isProxy(message)) { state.captureFailures++; return; }
            const metadata = {};
            for (const key of fields) {
              const descriptor = message && Object.getOwnPropertyDescriptor(message, key);
              if (!descriptor) continue;
              if (!Object.hasOwn(descriptor, 'value')) { state.captureFailures++; continue; }
              const value = descriptor.value;
              if (value === undefined || value === null) continue;
              if (typeof value === 'string' && value.length > 128) { state.truncated++; continue; }
              if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) metadata[key] = value;
              else state.captureFailures++;
            }
            if (metadata.type === 'toolStateResponse') {
              const error = Object.getOwnPropertyDescriptor(message, 'error');
              if (error && Object.hasOwn(error, 'value') && (error.value === undefined || typeof error.value === 'string')) metadata.hasError = typeof error.value === 'string' && error.value.length > 0;
              else if (!error) {
                const prototype = Object.getPrototypeOf(message);
                if (prototype === null || !isProxy(prototype) && Object.getPrototypeOf(prototype) === null && !Object.getOwnPropertyDescriptor(prototype, 'error')) metadata.hasError = false;
              }
              const sections = Object.getOwnPropertyDescriptor(message, 'sections');
              if (sections && Object.hasOwn(sections, 'value') && !isProxy(sections.value) && Array.isArray(sections.value)) {
                const length = Object.getOwnPropertyDescriptor(sections.value, 'length')?.value;
                if (Number.isSafeInteger(length) && length >= 0) metadata.sectionCount = length;
              }
            }
            if (typeof metadata.type !== 'string') state.captureFailures++;
            const priority = /probe/i.test(metadata.type ?? '') ? 'probe' : /ready|document|reload|projection|toolstate/i.test(metadata.type ?? '') ? 'lifecycle' : 'routine';
            const point = stamp();
            const panelRecords = records.filter(candidate => candidate.panelId === panel.panelId);
            let entry = priority === 'lifecycle' ? undefined : panelRecords.find(candidate => candidate.direction === direction && candidate.phase === point.phase && fields.every(key => candidate[key] === metadata[key]));
            if (!entry) {
              if (priority !== 'lifecycle' && panelRecords.filter(candidate => candidate.priority === priority && candidate.phase === point.phase).length >= (priority === 'probe' ? 64 : 32)) { state.overflow++; return; }
              if (panelRecords.length === 128) {
                state.overflow++;
                const replaceable = priority === 'lifecycle' ? records.findIndex(candidate => candidate.panelId === panel.panelId && candidate.priority !== 'lifecycle') : -1;
                if (replaceable < 0) return;
                records.splice(replaceable, 1);
              }
              entry = { panelId: panel.panelId, referenceIndex: panel.referenceIndex, uriClassification: panel.uriClassification, direction, priority, phase: point.phase, firstOrder: point.order, lastOrder: point.order, firstMs: point.atMs, lastMs: point.atMs, count: 0, attempts: 0, successTrue: 0, successFalse: 0, rejected: 0, thrown: 0, pending: 0, settlementUnavailable: 0, firstSettledOrder: 0, lastSettledOrder: 0, firstSettledMs: 0, lastSettledMs: 0, pendingAtReceive: 0, readyBeforeSettlement: 0 };
              for (const key of [...fields, 'hasError', 'sectionCount']) if (Object.hasOwn(metadata, key)) entry[key] = metadata[key];
              records.push(entry);
            }
            entry.count++;
            entry.lastOrder = point.order;
            entry.lastMs = point.atMs;
            if (direction === 'receive') {
              entry.pendingAtReceive = panel.pending;
              if (/ready/i.test(metadata.type ?? '') && panel.pending > 0) entry.readyBeforeSettlement++;
            }
            return entry;
          };
          const settle = (panel, attempt, kind, value) => {
            if (retired || !attempt || attempt.done) return;
            safeTry(() => {
              const point = stamp();
              attempt.done = true;
              panel.pending--;
              notifyDrain?.();
              if (kind === 'fulfilled') kind = value === true ? 'successTrue' : value === false ? 'successFalse' : 'settlementUnavailable';
              if (kind === 'settlementUnavailable') state.settlementUnavailable++;
              const entry = attempt.entry;
              if (!entry) return;
              entry.pending--;
              entry[kind]++;
              if (kind === 'successTrue' || kind === 'successFalse') entry.accepted = value;
              if (!entry.firstSettledOrder) { entry.firstSettledOrder = point.order; entry.firstSettledMs = point.atMs; }
              entry.lastSettledOrder = point.order;
              entry.lastSettledMs = point.atMs;
              entry.settlementPhase = point.phase;
            });
          };
          const replace = (target, key, wrap, inherited = false, boundary = 'registration', panelId = null) => {
            const diagnostic = { boundary, panelId, descriptorFound: null, ownerDepth: null, descriptorKind: 'unknown', configurable: null, writable: null, valueType: null, hasGetter: false, hasSetter: false, targetExtensible: null, patchCount: patches.length, rejectionReason: null };
            const reject = rejectionReason => {
              state.boundaryUnavailable++;
              diagnostic.patchCount = patches.length;
              diagnostic.rejectionReason = rejectionReason;
              if (state.boundaryDiagnostics.length < 16) state.boundaryDiagnostics.push(diagnostic);
              else state.boundaryDiagnosticOverflow++;
              return false;
            };
            try {
              const original = Object.getOwnPropertyDescriptor(target, key);
              let descriptor = original, descriptorOwner = target, ownerDepth = 0;
              for (let depth = 0; !descriptor && inherited && depth < 16; depth++) {
                descriptorOwner = Object.getPrototypeOf(descriptorOwner);
                if (!descriptorOwner) break;
                ownerDepth = depth + 1;
                descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, key);
              }
              diagnostic.descriptorFound = !!descriptor;
              diagnostic.ownerDepth = descriptor ? ownerDepth : null;
              diagnostic.descriptorKind = descriptor ? Object.hasOwn(descriptor, 'value') ? 'data' : 'accessor' : 'missing';
              if (descriptor) {
                diagnostic.configurable = descriptor.configurable;
                diagnostic.writable = descriptor.writable ?? null;
                diagnostic.valueType = Object.hasOwn(descriptor, 'value') ? typeof descriptor.value : null;
                diagnostic.hasGetter = typeof descriptor.get === 'function';
                diagnostic.hasSetter = typeof descriptor.set === 'function';
              }
              diagnostic.targetExtensible = Object.isExtensible(target);
              if (!descriptor) return reject('DESCRIPTOR_MISSING');
              if (!Object.hasOwn(descriptor, 'value')) return reject('ACCESSOR_DESCRIPTOR');
              if (typeof descriptor.value !== 'function') return reject('NON_FUNCTION_VALUE');
              if (!descriptor.configurable && (!original || !descriptor.writable)) return reject(original ? 'NON_CONFIGURABLE_NON_WRITABLE' : 'NON_CONFIGURABLE_INHERITED');
              if (!original && !diagnostic.targetExtensible) return reject('TARGET_NOT_EXTENSIBLE');
              if (patches.length === 64) return reject('PATCH_LIMIT');
              const replacement = { value: wrap(descriptor.value), configurable: descriptor.configurable, enumerable: descriptor.enumerable, writable: descriptor.writable };
              patches.push({ target, key, original, descriptorOwner, descriptor, replacement });
              Object.defineProperty(target, key, replacement);
              if (!sameDescriptor(Object.getOwnPropertyDescriptor(target, key), replacement)) return reject('PATCH_VERIFICATION_FAILED');
              return true;
            } catch { state.captureFailures++; return reject('REFLECTION_FAILED'); }
          };
          const observePanel = (document, actualPanel) => {
            const reference = references.get(document.uri.toString());
            if (!reference) return;
            if (panels.has(actualPanel)) { panels.get(actualPanel).resolveCalls++; return; }
            if (panels.size === 32) { state.overflow++; return; }
            const panel = Object.defineProperties({ resolveCalls: 1, received: 0, submissions: 0, pending: 0, inboundAttached: false, postWrapped: false }, {
              panelId: { value: panels.size + 1, enumerable: true }, referenceIndex: { value: reference.index, enumerable: true },
              uriClassification: { value: reference.index === 104 ? 'typespec-target' : 'owned-prefix', enumerable: true }, actualPanel: { value: actualPanel },
            });
            panels.set(actualPanel, panel);
            const webview = panel.actualPanel.webview;
            const receive = webview.onDidReceiveMessage;
            if (typeof receive !== 'function') { state.boundaryUnavailable++; return; }
            const listener = Reflect.apply(receive, webview, [message => {
              if (!retired) safeTry(() => { panel.received++; capture(panel, 'receive', message); });
            }]);
            listeners.push(listener);
            panel.inboundAttached = typeof listener?.dispose === 'function';
            if (!panel.inboundAttached) state.boundaryUnavailable++;
            panel.postWrapped = replace(webview, 'postMessage', original => function (...args) {
              const attempt = retired ? undefined : safeTry(() => {
                panel.submissions++;
                panel.pending++;
                const entry = capture(panel, 'post', args[0]);
                if (entry) { entry.attempts++; entry.pending++; }
                return { entry, done: false };
              });
              let result;
              try { result = Reflect.apply(original, this, args); }
              catch (error) { settle(panel, attempt, 'thrown'); throw error; }
              if (!retired && attempt) {
                if (typeof result === 'boolean') settle(panel, attempt, 'fulfilled', result);
                else {
                  try {
                    if (isNativePromise(result)) {
                      const observed = nativeThen.call(result, value => { settle(panel, attempt, 'fulfilled', value); }, () => { settle(panel, attempt, 'rejected'); });
                      nativeThen.call(observed, undefined, () => {});
                    } else settle(panel, attempt, 'settlementUnavailable');
                  } catch { settle(panel, attempt, 'settlementUnavailable'); }
                }
              }
              return result;
            }, true, 'panel-post', panel.panelId);
          };
          const snapshot = () => {
            const observed = state.registrationInstalled && state.registrationObserved && panels.size > 0 && state.boundaryUnavailable === 0 && [...panels.values()].every(panel => panel.inboundAttached && panel.postWrapped);
            const completeCapture = observed && ['captureFailures', 'boundaryDiagnosticOverflow', 'overflow', 'truncated', 'settlementUnavailable', 'pendingAtRestore'].every(key => state[key] === 0);
            const complete = retired && completeCapture && state.restored && state.disposeFailures === 0;
            return { ...state, boundaryDiagnostics: state.boundaryDiagnostics.map(entry => ({ ...entry })), observed, freshPanelObserved: panels.size > 0, completeCapture, complete, status: complete ? 'COMPLETE' : retired ? 'INCOMPLETE' : 'OBSERVING', retired, sequence,
              panels: [...panels.values()].map(panel => ({ panelId: panel.panelId, referenceIndex: panel.referenceIndex, uriClassification: panel.uriClassification, resolveCalls: panel.resolveCalls, received: panel.received, submissions: panel.submissions, pending: panel.pending, inboundAttached: panel.inboundAttached, postWrapped: panel.postWrapped })),
              records: records.map(record => ({ ...record })) };
          };
          return {
            install(facade) {
              if (installed || retired) return;
              installed = true;
              safeTry(() => {
                state.registrationInstalled = replace(facade.window, 'registerCustomEditorProvider', original => function (...args) {
                  if (!retired && args[0] === 'kusto.kqlxEditor') safeTry(() => {
                    state.registrationCalls++;
                    state.registrationObserved = true;
                    const provider = args[1];
                    if (providers.has(provider)) return;
                    providers.add(provider);
                    replace(provider, 'resolveCustomTextEditor', resolve => function (...args) {
                      if (!retired) safeTry(() => observePanel(args[0], args[1]));
                      return Reflect.apply(resolve, this, args);
                    }, true, 'provider-resolve');
                  });
                  return Reflect.apply(original, this, args);
                });
              });
            },
            snapshot,
            waitForPendingPosts() {
              if (drainPromise) return drainPromise;
              drainPromise = new Promise(resolve => {
                const pending = () => [...panels.values()].reduce((total, panel) => total + panel.pending, 0);
                const initialPending = pending();
                let timer, finished = false;
                const finish = status => {
                  if (finished) return;
                  finished = true; clearTimer(timer); notifyDrain = undefined;
                  resolve(Object.freeze({ status, initialPending, remainingPending: pending(), timeoutMs: 2000, timedOut: status === 'timeout' }));
                };
                notifyDrain = () => { if (retired) finish('retired'); else if (pending() === 0) finish('settled'); };
                notifyDrain();
                if (!finished) timer = setTimer(() => finish('timeout'), 2000);
              });
              return drainPromise;
            },
            restore() {
              if (retired) return snapshot();
              retired = true;
              notifyDrain?.();
              state.pendingAtRestore = [...panels.values()].reduce((total, panel) => total + panel.pending, 0);
              for (const listener of listeners) {
                try { listener.dispose(); } catch { state.disposeFailures++; }
              }
              for (const patch of patches.slice().reverse()) {
                try {
                  const current = Object.getOwnPropertyDescriptor(patch.target, patch.key);
                  if (sameDescriptor(current, patch.replacement)) {
                    if (patch.original) Object.defineProperty(patch.target, patch.key, patch.original);
                    else Reflect.deleteProperty(patch.target, patch.key);
                  } else if (!sameDescriptor(current, patch.original)) { state.restoreMismatch++; continue; }
                  if (!sameDescriptor(Object.getOwnPropertyDescriptor(patch.target, patch.key), patch.original) || !patch.original && !sameDescriptor(Object.getOwnPropertyDescriptor(patch.descriptorOwner, patch.key), patch.descriptor)) state.restoreMismatch++;
                } catch { state.restoreFailures++; }
              }
              state.restored = state.restoreMismatch === 0 && state.restoreFailures === 0;
              return snapshot();
            },
          };
        };
        const readSetting = (section, key) => {
          const configuration = vscode.workspace.getConfiguration(section);
          const inspection = configuration.inspect(key);
          assert.ok(inspection, 'Private setting is not registered: ' + section + '.' + key);
          return { effective: configuration.get(key), inspection, scopes: Object.fromEntries(['defaultValue', 'globalValue', 'workspaceValue', 'workspaceFolderValue', 'defaultLanguageValue', 'globalLanguageValue', 'workspaceLanguageValue', 'workspaceFolderLanguageValue'].map(scope => [scope, inspection[scope] ?? null])) };
        };
        const updateSetting = async (setting, value, expectedEffective, operation) => {
          const started = performance.now();
          const change = { operation, section: setting.section, key: setting.key, target: 'Global', requested: value ?? null, removeOverride: value === undefined, expectedEffective, before: readSetting(setting.section, setting.key), readbacks: [] };
          outcome.configuration.changes.push(change);
          write('private-settings', outcome.configuration);
          let listener, deadline, settled = false, updateCompleted = false;
          const matches = state => Object.is(state.inspection.globalValue, value) && Object.is(state.effective, expectedEffective);
          try {
            await new Promise((resolve, reject) => {
              const finish = error => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                listener?.dispose();
                if (error) reject(error); else resolve();
              };
              const check = trigger => {
                if (settled) return;
                try {
                  const state = readSetting(setting.section, setting.key);
                  change.readbacks.push({ trigger, elapsedMs: performance.now() - started, ...state });
                  if (updateCompleted && matches(state)) finish();
                } catch (error) { finish(error); }
              };
              listener = vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(setting.section + '.' + setting.key)) check('configuration-event');
              });
              deadline = setTimeout(() => finish(new Error('Private setting deadline: ' + JSON.stringify({ section: setting.section, key: setting.key, expectedEffective, readback: readSetting(setting.section, setting.key) }))), 10000);
              if (matches(change.before)) {
                updateCompleted = true;
                check('already-applied');
              } else {
                Promise.resolve().then(() => vscode.workspace.getConfiguration(setting.section).update(setting.key, value, vscode.ConfigurationTarget.Global)).then(() => {
                  updateCompleted = true;
                  check('update-completed');
                }, finish);
              }
            });
            const fresh = readSetting(setting.section, setting.key);
            assert.equal(fresh.inspection.globalValue, value, 'Private setting scope did not apply');
            assert.equal(fresh.effective, expectedEffective, 'Private test setting did not apply');
            change.applied = true;
          } finally {
            settled = true;
            clearTimeout(deadline);
            listener?.dispose();
            change.after = readSetting(setting.section, setting.key);
            change.elapsedMs = performance.now() - started;
            write('private-settings', outcome.configuration);
          }
        };
        const typeSpecSettings = [['files', 'autoSave', 'afterDelay'], ['files', 'autoSaveDelay', 1000], ['workbench.editor', 'enablePreview', false]];
        const readTypeSpecSettings = () => typeSpecSettings.map(([section, key, value]) => ({ section, key, value, before: readSetting(section, key) }));
        const requireTypeSpecPreset = snapshot => {
          assert.equal(snapshot.length, typeSpecSettings.length, 'Preset must contain exactly three settings');
          for (const [index, [section, key, value]] of typeSpecSettings.entries()) {
            const setting = snapshot[index];
            assert.equal(setting.section, section);
            assert.equal(setting.key, key);
            assert.equal(setting.before.inspection.globalValue, value, 'Preset global mismatch: ' + section + '.' + key);
            assert.equal(setting.before.effective, value, 'Preset effective mismatch: ' + section + '.' + key);
          }
        };
        const configureTypeSpecSettings = async () => {
          outcome.configuration.before = readTypeSpecSettings();
          if (outcome.configuration.presetOnly) {
            requireTypeSpecPreset(outcome.configuration.before);
            outcome.configuration.presetVerified = true;
            return;
          }
          for (const { section, key, value, before } of outcome.configuration.before) {
            phase = 'configure-' + section + '.' + key;
            const setting = { section, key, previous: before.inspection.globalValue, previousEffective: before.effective };
            settings.push(setting);
            await updateSetting(setting, value, value, 'configure');
          }
        };
        const requireTypeSpecStandaloneReceipt = receipt => {
          assert.equal(receipt.schemaVersion, 1, 'Versioned observer receipt required');
          assert.equal(receipt.trial, 'standalone');
          assert.equal(receipt.classification, 'PASS');
          assert.equal(receipt.calls.length, 1);
          assert.equal(receipt.calls[0].oraclePassed, true);
          assert.equal(receipt.calls[0].index, 104);
          assert.equal(receipt.dispatcherObservation.schemaVersion, 2);
          for (const key of ['observed', 'freshPanelObserved', 'completeCapture', 'complete', 'restored', 'retired']) assert.equal(receipt.dispatcherObservation[key], true, 'Incomplete SDK observation: ' + key);
          for (const key of ['captureFailures', 'boundaryUnavailable', 'boundaryDiagnosticOverflow', 'overflow', 'truncated', 'settlementUnavailable', 'restoreMismatch', 'restoreFailures', 'disposeFailures', 'pendingAtRestore']) assert.equal(receipt.dispatcherObservation[key], 0, 'Blocked SDK observation: ' + key);
          assert.equal(Array.isArray(receipt.dispatcherObservation.boundaryDiagnostics), true);
          assert.equal(receipt.dispatcherObservation.boundaryDiagnostics.length, 0);
          assert.equal(receipt.dispatcherObservation.status, 'COMPLETE');
          const panels = receipt.dispatcherObservation.panels, records = receipt.dispatcherObservation.records;
          assert.ok(Array.isArray(panels) && panels.length > 0 && panels.length <= 32, 'Recorded panels must contain 1..32 entries');
          assert.ok(Array.isArray(records) && records.length <= 4096, 'Recorded rows must be an array of at most 4096 entries');
          const panelCounts = new Map();
          for (const panel of panels) {
            assert.ok(Number.isSafeInteger(panel.panelId) && panel.panelId > 0 && panel.panelId <= 32, 'Invalid recorded panel identity');
            assert.equal(panelCounts.has(panel.panelId), false, 'Duplicate recorded panel identity');
            panelCounts.set(panel.panelId, 0);
          }
          for (const record of records) {
            assert.ok(panelCounts.has(record.panelId), 'Recorded row has no matching panel');
            const count = panelCounts.get(record.panelId) + 1;
            assert.ok(count <= 128, 'Recorded panel exceeds 128 rows');
            panelCounts.set(record.panelId, count);
          }
          assert.ok(receipt.dispatcherObservation.panels.some(panel => panel.referenceIndex === 104 && panel.inboundAttached && panel.postWrapped));
          assert.equal(receipt.evidenceFailureCount, 0);
          assert.equal(receipt.evidenceFailures.length, 0);
          assert.equal(receipt.errors.length, 0);
          assert.equal(receipt.checks.dispatcherObservation, true);
          assert.equal(receipt.checks.evidenceSink, true);
          assert.equal(Object.values(receipt.checks).every(value => value === true), true);
          assert.deepEqual(receipt.guardContract, outcome.guardContract, 'Runtime guard version or executing script changed');
          assert.match(receipt.guardContract.scriptSha256, /^[a-f0-9]{64}$/);
          assert.match(receipt.helperSha256, /^[a-f0-9]{64}$/);
          assert.equal(receipt.helperSha256, outcome.helperSha256, 'Imported cleanup helper changed');
          assert.equal(receipt.checks.helperUnchanged, true);
          assert.equal(receipt.configuration.presetOnly, true, 'A setting-mutating receipt cannot authorize the prefix trial');
          assert.equal(receipt.configuration.presetVerified, true);
          assert.equal(receipt.configuration.changes.length, 0);
          requireTypeSpecPreset(receipt.configuration.before);
          requireTypeSpecPreset(receipt.configuration.after);
          assert.equal(receipt.build.mainSha256, outcome.build.mainSha256);
          assert.equal(receipt.build.manifestSha256, outcome.build.manifestSha256, 'Original frozen manifest changed');
          assert.equal(receipt.build.assetManifestSha256, outcome.build.assetManifestSha256, 'Frozen asset identity changed');
          assert.deepEqual(receipt.build.assets, outcome.build.assets, 'Full frozen asset hashes changed');
          assert.equal(receipt.runtime.vscode, vscode.version);
          assert.equal(receipt.runtime.codeCommit, outcome.runtime.codeCommit, 'Code commit changed');
          assert.equal(receipt.runtime.codeSha256, outcome.runtime.codeSha256, 'Code executable changed');
          assert.equal(receipt.runtime.codeBytes, outcome.runtime.codeBytes, 'Code executable size changed');
          assert.equal(receipt.checks.actualCode, true);
          assert.deepEqual(receipt.actualCode, outcome.actualCode, 'Observed Code identity changed');
          assert.deepEqual(receipt.afterActualCode, receipt.actualCode, 'Code identity changed during the standalone trial');
          assert.equal(receipt.archive.sha256, outcome.archive.sha256);
          assert.equal(receipt.archive.baselineSha256, outcome.archive.baselineSha256);
          assert.equal(receipt.archive.ledgerSha256, outcome.archive.ledgerSha256);
        };
        const sample = (document, event) => {
          const uri = document.uri.toString();
          const reference = references.get(uri);
          if (!reference) return;
          if (!models.has(document)) models.set(document, { uri, version: document.version });
          const text = document.getText();
          const observation = { uri, event, version: document.version, dirty: document.isDirty, bufferSha256: hash(text), atUtc: new Date().toISOString() };
          outcome.models.push(observation);
          if (document.version !== 1 || document.version !== models.get(document).version || document.isDirty || text !== reference.text) outcome.damage.push(observation);
        };
        const preservation = label => {
          helper.assertAcceptanceRoot(owner);
          const files = [];
          for (const reference of references.values()) {
            const stat = fs.lstatSync(reference.file);
            const actual = { path: reference.path, bytes: stat.size, sha256: hash(fs.readFileSync(reference.file)) };
            actual.unchanged = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && canonicalPath(fs.realpathSync.native(reference.file)) === canonicalPath(reference.file) && actual.bytes === reference.bytes && actual.sha256 === reference.sha256 && stat.mtimeMs === reference.mtimeMs;
            files.push(actual);
            if (!actual.unchanged) outcome.damage.push({ label, ...actual });
          }
          for (const document of models.keys()) sample(document, label);
          for (const tab of tabs()) if (references.has(tab.input?.uri?.toString()) && tab.isDirty) outcome.damage.push({ label, uri: tab.input.uri.toString(), dirtyTab: true });
          const result = { label, files, saved: [...outcome.saved], passed: outcome.damage.length === 0 && outcome.saved.length === 0 };
          write(label, result);
          return result;
        };
        const verifyFrozenBuild = () => {
          for (const file of manifest.files) {
            const actual = path.join(extension.extensionPath, file.path);
            const stat = fs.lstatSync(actual);
            assert.equal(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, true, 'Aliased frozen runtime asset');
            assert.equal(stat.size, file.bytes, 'Frozen runtime size changed: ' + file.path);
            assert.equal(hash(fs.readFileSync(actual)), file.sha256, 'Frozen runtime changed: ' + file.path);
          }
          const assets = manifest.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
          return { mainSha256: hash(fs.readFileSync(main)), fileCount: manifest.files.length, extensionRoot: extension.extensionPath, manifestSha256: process.env.KW_TYPESPEC_FROZEN_SHA, assets, assetManifestSha256: hash(JSON.stringify(assets)) };
        };
        const readActualCodeIdentity = () => {
          const productPath = path.join(vscode.env.appRoot, 'product.json');
          const packagePath = path.join(vscode.env.appRoot, 'package.json');
          const codeProduct = JSON.parse(fs.readFileSync(productPath, 'utf8'));
          const codePackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
          const codeBytes = fs.readFileSync(process.execPath);
          assert.equal(codePackage?.version, vscode.version, 'Loaded Code package version differs from vscode.version');
          assert.equal(codePackage?.version, '1.143.0', 'Exact Code package version required');
          assert.match(codeProduct?.commit, /^[a-f0-9]{40}$/, 'Observed Code commit required');
          assert.ok(codeBytes.length > 0, 'Observed Code executable is empty');
          const actualCode = { version: codePackage.version, commit: codeProduct.commit, codeBytes: codeBytes.length, codeSha256: hash(codeBytes), execPath: canonicalPath(process.execPath), appRoot: canonicalPath(vscode.env.appRoot), productPath: canonicalPath(productPath), packagePath: canonicalPath(packagePath) };
          assert.match(actualCode.codeSha256, /^[a-f0-9]{64}$/, 'Observed Code executable hash required');
          if (Object.hasOwn(manifest, 'code')) {
            const expectedCode = manifest.code;
            assert.ok(expectedCode && typeof expectedCode === 'object' && !Array.isArray(expectedCode), 'Present manifest.code must contain an exact Code identity');
            assert.match(expectedCode.commit, /^[a-f0-9]{40}$/, 'Exact frozen Code commit required');
            assert.match(expectedCode.codeSha256, /^[a-f0-9]{64}$/, 'Exact frozen Code executable hash required');
            assert.ok(Number.isSafeInteger(expectedCode.codeBytes) && expectedCode.codeBytes > 0, 'Exact frozen Code executable size required');
            assert.equal(actualCode.commit, expectedCode.commit, 'Loaded Code commit differs from the original manifest');
            assert.equal(actualCode.codeBytes, expectedCode.codeBytes, 'Loaded Code executable size differs');
            assert.equal(actualCode.codeSha256, expectedCode.codeSha256, 'Loaded Code executable hash differs');
            if (Object.hasOwn(expectedCode, 'version')) assert.equal(actualCode.version, expectedCode.version, 'Loaded Code version differs from the original manifest');
          }
          return actualCode;
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
        try {
          assert.equal(previous, undefined, 'Requires one trial per fresh host');
          assert.equal(process.env.KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH, undefined, 'Do not use reusable-profile suite dispatch');
          assert.equal([undefined, '0', '1'].includes(process.env.KW_TYPESPEC_PRESET_ONLY), true, 'KW_TYPESPEC_PRESET_ONLY must be unset, 0 or 1');
          assert.equal(['standalone', 'prefix100-103'].includes(outcome.trial), true, 'Unsupported trial');
          assert.equal(vscode.version, '1.143.0', 'Never silently substitute another VS Code version');
          assert.equal(vscode.env.logLevel, vscode.LogLevel.Trace, 'Trace must be enabled at process startup');
          extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
          assert.ok(extension, 'Workbench extension missing');
          assert.equal(extension.isActive, false, 'Requires an unused isolated extension host');
          assert.equal(tabs().length, 0, 'Preserve pre-existing tabs; never reset them');
          for (const document of vscode.workspace.textDocuments) initialDocumentReferences.set(document, initialDocumentMetadata(document));
          outcome.initialDocuments = [...initialDocumentReferences.values()];
          assert.equal(outcome.initialDocuments.every(metadata => metadata.ownershipClassification === 'framework-chat-input'), true, 'Preserve pre-existing document models; only the known clean framework chat input is eligible');
          initialDocumentsAdmitted = true;
          assert.equal(vscode.workspace.workspaceFolders?.length ?? 0, 0, 'Requires an empty isolated window');
          outcome.initialTabs = tabSnapshot();
          const manifestBytes = fs.readFileSync(process.env.KW_TYPESPEC_FROZEN_MANIFEST);
          assert.equal(hash(manifestBytes), process.env.KW_TYPESPEC_FROZEN_SHA, 'Frozen manifest identity changed');
          manifest = JSON.parse(manifestBytes);
          assert.equal(manifest.runtimeStableDuringCopy, true);
          assert.equal(canonicalPath(extension.extensionPath), canonicalPath(manifest.extensionRoot), 'Wrong loaded extension root');
          assert.notEqual(canonicalPath(extension.extensionPath), canonicalPath(manifest.sourceRoot), 'Do not run against the parent watcher output');
          main = path.resolve(extension.extensionPath, extension.packageJSON.main);
          workbenchRequire = modules.createRequire(main);
          outcome.build = verifyFrozenBuild();
          outcome.actualCode = readActualCodeIdentity();
          outcome.runtime = { vscode: vscode.version, codeCommit: outcome.actualCode.commit, codeBytes: outcome.actualCode.codeBytes, codeSha256: outcome.actualCode.codeSha256, node: process.version, versions: process.versions, pid: process.pid, ppid: process.ppid, execPath: process.execPath, appRoot: vscode.env.appRoot, extensionVersion: extension.packageJSON.version, logLevel: vscode.env.logLevel, manifestPath: process.env.KW_TYPESPEC_FROZEN_MANIFEST };
          helperPath = path.join(manifest.sourceRoot, 'scripts/repro-published-notebook.mjs');
          helperSha256 = hash(fs.readFileSync(helperPath));
          helper = await import(url.pathToFileURL(helperPath).href);
          owner = helper.createAcceptanceRoot();
          evidenceRoot = path.join(owner.root, 'evidence');
          fs.mkdirSync(evidenceRoot);
          outcome.evidenceRoot = evidenceRoot;
          outcome.helperSha256 = helperSha256;
          write('initial', outcome);
          assert.equal(hash(fs.readFileSync(archive)), archiveSha256, 'Immutable ZIP hash mismatch');
          const metadata = await readArchive(new Set(['baseline.json', 'evidence/verified-prequalification-ledger.json']));
          const baseline = JSON.parse(metadata.get('baseline.json'));
          const ledger = JSON.parse(metadata.get('evidence/verified-prequalification-ledger.json'));
          assert.equal(ledger.sweep.length, 109);
          for (const [index, entry] of ledger.sweep.entries()) {
            assert.equal(entry.index, index + 1, 'Recorded ledger is not contiguous');
            assert.equal(entry.call.tool, 'kusto-workbench_activate-workbench-file');
            assert.equal(baseline.files.filter(file => file.path === entry.relativePath).length, 1, 'Recorded path has no unique baseline');
          }
          assert.equal(ledger.sweep[103].relativePath, targetPath);
          assert.equal(ledger.sweep[103].observedSuccess, false);
          outcome.archive = { path: archive, sha256: archiveSha256, baselineSha256: hash(metadata.get('baseline.json')), ledgerSha256: hash(metadata.get('evidence/verified-prequalification-ledger.json')), originalInitialTabs: baseline.preservedInitialPaths, completeOrder: ledger.sweep.map(entry => ({ index: entry.index, path: entry.relativePath })) };
          if (outcome.trial === 'prefix100-103') {
            const receiptBytes = fs.readFileSync(process.env.KW_TYPESPEC_STANDALONE_RECEIPT);
            const receipt = JSON.parse(receiptBytes);
            requireTypeSpecStandaloneReceipt(receipt);
            outcome.standaloneReceipt = { path: process.env.KW_TYPESPEC_STANDALONE_RECEIPT, sha256: hash(receiptBytes) };
          }
          const selected = outcome.trial === 'standalone' ? [ledger.sweep[103]] : ledger.sweep.slice(99, 104);
          const images = await readArchive(new Set(selected.map(entry => 'before/' + entry.relativePath)));
          for (const entry of selected) {
            const relative = entry.relativePath;
            assert.equal(path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(relative) || relative.split('/').some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)), false, 'Unsafe archived path');
            const reference = baseline.files.find(file => file.path === relative);
            const bytes = images.get('before/' + relative);
            assert.equal(bytes.length, reference.bytes);
            assert.equal(hash(bytes), reference.sha256.toLowerCase());
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const sections = JSON.parse(text).state.sections;
            assert.equal(sections.some(section => section.linkedQueryPath), false, 'Linked dependency requires separate lawful staging');
            if (relative === targetPath) {
              assert.equal(bytes.length, 54487);
              assert.equal(hash(bytes), '38c40a018111e2b4dc4fe79424e15f1d44a7f4675203eecd379400301049bf6e');
              assert.equal(sections.length, 6);
              assert.equal(sections.some(section => Object.hasOwn(section, 'resultJson')), false);
            }
            const file = path.join(owner.root, 'history', relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, bytes, { flag: 'wx' });
            const uri = vscode.Uri.file(file);
            const normalized = uri.fsPath.split(path.sep).join('/');
            const key = 'file:' + (process.platform === 'win32' ? normalized.toLowerCase() : normalized);
            references.set(uri.toString(), { path: relative, index: entry.index, file, uri: uri.toString(), text, bytes: reference.bytes, sha256: reference.sha256.toLowerCase(), mtimeMs: fs.statSync(file).mtimeMs, expectedOpenFileId: 'wf_' + Buffer.from(key, 'utf8').toString('base64url'), sectionIds: sections.map(section => section.id).filter(id => typeof id === 'string' && id.length > 0) });
          }
          subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => sample(document, 'open')), vscode.workspace.onDidChangeTextDocument(event => sample(event.document, 'change')), vscode.workspace.onDidCloseTextDocument(document => sample(document, 'close')), vscode.workspace.onDidSaveTextDocument(document => { if (references.has(document.uri.toString())) outcome.saved.push(document.uri.toString()); }), vscode.window.tabGroups.onDidChangeTabs(() => { for (const tab of tabs()) if (references.has(tab.input?.uri?.toString()) && tab.isDirty) outcome.damage.push({ uri: tab.input.uri.toString(), dirtyTab: true }); }));
          await configureTypeSpecSettings();
          outcome.checks.configuration = true;
          outcome.before = preservation('before-open');
          startupCapture = startPendingTypeSpecCapture({ index: 'startup', uri: '', path: '' });
          write('startup-before-observer', { phase: 'before-observer' });
          dispatcherObserver = createTypeSpecDispatcherObserver({ references, getPhase: () => phase, clock: () => performance.now() });
          dispatcherObserver.install(workbenchRequire('vscode'));
          phase = 'extension-activation';
          preserveInitialDocuments('before-extension-activation');
          write('startup-before-activation', { phase: 'before-activation' });
          try { await extension.activate(); }
          finally { startupCapture.settle(); }
          write('startup-activated', { phase: 'activated' });
          assert.equal(tabs().length, 0, 'Activation setup must not open or warm any target');
          await verifyTypeSpecTrace();
          outcome.classification = 'RUNNING';
          for (const reference of references.values()) {
            phase = 'first-activation-' + reference.index;
            preserveInitialDocuments('before-public-activation-' + reference.index);
            assert.equal(tabs().some(tab => tab.input?.uri?.toString() === reference.uri), false, 'Target was opened before its first public call');
            assert.equal(vscode.workspace.textDocuments.some(document => document.uri.toString() === reference.uri), false, 'Target model was warmed before its first public call');
            const record = { index: reference.index, path: reference.path, input: { targetFileUri: reference.uri }, expectedOpenFileId: reference.expectedOpenFileId, startedUtc: new Date().toISOString(), oraclePassed: false };
            outcome.calls.push(record);
            write('call-' + reference.index + '-started', record);
            const started = performance.now();
            const pendingCapture = startPendingTypeSpecCapture(reference);
            try {
              const raw = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file', { toolInvocationToken: undefined, input: record.input });
              record.raw = raw;
              record.textParts = raw.content.filter(part => typeof part?.value === 'string').map(part => part.value);
              record.allText = record.textParts.join('\n');
              try { record.value = JSON.parse(record.allText); } catch (error) { record.decodeError = String(error.message); }
            } catch (error) { record.transportError = String(error?.message ?? error); }
            finally { pendingCapture.settle(); }
            record.elapsedMs = performance.now() - started;
            record.finishedUtc = new Date().toISOString();
            write('call-' + reference.index + '-response', record);
            try {
              assert.equal(record.transportError, undefined);
              assert.equal(record.value?.success, true, record.allText);
              assert.equal(record.value.isLiveWorkbench, true, record.allText);
              assert.equal(record.value.isReadOnlyFallback, false, record.allText);
              assert.equal(record.value.uri, reference.uri, 'First response URI differs');
              assert.equal(record.value.openFileId, reference.expectedOpenFileId, 'First response file ID differs');
              record.oraclePassed = true;
            } catch (error) {
              record.oracleError = String(error?.message ?? error);
              outcome.classification = reference.path === targetPath ? 'TYPESPEC_FIRST_ACTIVATION_FAILED' : 'PREFIX_FIRST_ACTIVATION_FAILED';
              write('call-' + reference.index + '-oracle', record);
              throw error;
            } finally {
              outcome.dispatcherObservation = dispatcherObserver.snapshot();
              write('dispatcher-observation-' + reference.index, outcome.dispatcherObservation);
            }
            write('call-' + reference.index + '-oracle', record);
            const exactTabs = tabs().filter(tab => tab.input?.uri?.toString() === reference.uri);
            assert.equal(exactTabs.length, 1, 'First successful response has no unique native tab');
            assert.equal(exactTabs[0].input instanceof vscode.TabInputCustom, true);
            assert.equal(exactTabs[0].input.viewType, 'kusto.kqlxEditor');
            assert.equal(exactTabs[0].isActive, true);
            assert.equal(tabs().filter(tab => references.has(tab.input?.uri?.toString())).length, outcome.calls.length, 'Previously opened prefix tabs were not retained');
          }
          outcome.checks.firstResponses = outcome.calls.length === selected.length && outcome.calls.every(record => record.oraclePassed);
        } catch (error) {
          outcome.errors.push({ phase, message: String(error?.message ?? error), stack: String(error?.stack ?? '') });
          if (outcome.classification === 'RUNNING') outcome.classification = 'NATIVE_TAB_ASSERTION_FAILED';
          if (['PREFIX_FIRST_ACTIVATION_FAILED', 'TYPESPEC_FIRST_ACTIVATION_FAILED'].includes(outcome.classification)) {
            try { outcome.rendererAfterFirstFailure = await captureFailedTypeSpecRenderer(); }
            catch { outcome.rendererAfterFirstFailure = { status: 'unavailable', reason: 'capture-failed' }; }
            write('renderer-after-first-failure', outcome.rendererAfterFirstFailure);
          }
        } finally {
          for (const capture of [...pendingTypeSpecCaptures]) capture.retire();
          phase = 'cleanup';
          try {
          if (owner) {
            try { outcome.beforeCleanup = preservation('before-cleanup'); } catch (error) { outcome.errors.push({ phase: 'preservation', message: String(error?.message ?? error) }); }
            try { outcome.cleanup = await helper.closeAcceptanceTabs(vscode, owner, [...references.keys()]); } catch (error) { outcome.errors.push({ phase: 'cleanup', message: String(error?.message ?? error) }); }
            try { outcome.dispatcherDrain = await dispatcherObserver?.waitForPendingPosts?.(); }
            catch (error) { outcome.dispatcherDrain = { status: 'failed' }; outcome.errors.push({ phase: 'dispatcher-drain', message: String(error?.message ?? error) }); }
            try { outcome.afterCleanup = preservation('after-cleanup'); } catch (error) { outcome.errors.push({ phase: 'preservation', message: String(error?.message ?? error) }); }
          }
          for (const subscription of subscriptions) {
            try { subscription.dispose(); } catch (error) { outcome.errors.push({ phase: 'subscription-disposal', message: String(error?.message ?? error) }); }
          }
          outcome.checks.settingsRestored = true;
          for (const setting of settings.reverse()) {
            try { await updateSetting(setting, setting.previous, setting.previousEffective, 'restore'); } catch (error) { outcome.checks.settingsRestored = false; outcome.errors.push({ phase: 'restore-private-setting', section: setting.section, key: setting.key, message: String(error?.message ?? error) }); }
          }
          if (outcome.configuration.presetVerified) {
            try {
              outcome.configuration.after = readTypeSpecSettings();
              requireTypeSpecPreset(outcome.configuration.after);
              assert.equal(outcome.configuration.changes.length, 0, 'Preset-only mode must never update settings');
            } catch (error) { outcome.checks.settingsRestored = false; outcome.errors.push({ phase: 'preset-preservation', message: String(error?.message ?? error) }); }
          }
          try { preserveInitialDocuments('after-cleanup-and-settings-restore'); } catch (error) { outcome.errors.push({ phase: 'framework-model-preservation', message: String(error?.message ?? error) }); }
          outcome.finalTabs = tabSnapshot();
          outcome.checks.preservation = outcome.before?.passed === true && outcome.beforeCleanup?.passed === true && outcome.afterCleanup?.passed === true && outcome.damage.length === 0 && outcome.saved.length === 0;
          outcome.checks.cleanup = outcome.cleanup?.onlyOwnedTabs === true && outcome.cleanup.survivors === 0 && outcome.finalTabs.length === 0;
          if (workbenchRequire && extension.isActive) {
            try {
              const loaded = Object.values(workbenchRequire.cache).find(candidate => candidate?.filename && canonicalPath(candidate.filename) === canonicalPath(main));
              const context = loaded?.exports?.toolOrchestrator?.context;
              assert.equal(loaded?.loaded, true, 'Executing main module not identified');
              assert.equal(context?.extensionMode, vscode.ExtensionMode.Development);
              assert.equal(canonicalPath(context.extensionPath), canonicalPath(extension.extensionPath));
              outcome.loaded = { main: loaded.filename, extensionMode: context.extensionMode, logUri: context.logUri.toString(), globalStorageUri: context.globalStorageUri.toString() };
              outcome.afterBuild = verifyFrozenBuild();
              outcome.checks.frozenBuild = outcome.afterBuild.mainSha256 === outcome.build.mainSha256;
              const logRoot = context.logUri.fsPath;
              outcome.readinessTrace = { source: logRoot, files: [], lines: [], sdkProbeAckCoverage: false };
              if (fs.existsSync(logRoot)) {
                const destination = path.join(evidenceRoot, 'product-logs');
                fs.cpSync(logRoot, destination, { recursive: true, errorOnExist: true, force: false });
                for (const entry of fs.readdirSync(destination, { recursive: true, withFileTypes: true })) {
                  if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
                  const file = path.join(entry.parentPath ?? entry.path, entry.name);
                  outcome.readinessTrace.files.push(file);
                  outcome.readinessTrace.lines.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => /\[file-open:|dispatcher|projection|bridge|policy/i.test(line)));
                }
              }
              outcome.checks.productTrace = outcome.readinessTrace.lines.some(line => line.includes('[file-open:'));
              outcome.checks.archiveUnchanged = hash(fs.readFileSync(archive)) === archiveSha256;
              outcome.checks.helperUnchanged = hash(fs.readFileSync(helperPath)) === helperSha256;
            } catch (error) { outcome.errors.push({ phase: 'runtime-evidence', message: String(error?.message ?? error) }); }
          }
          if (outcome.actualCode) {
            outcome.checks.actualCode = false;
            try {
              outcome.afterActualCode = readActualCodeIdentity();
              assert.deepEqual(outcome.afterActualCode, outcome.actualCode, 'Loaded Code identity changed during trial');
              outcome.checks.actualCode = true;
            } catch (error) { outcome.errors.push({ phase: 'code-identity-preservation', message: String(error?.message ?? error) }); }
          }
          } finally {
            if (dispatcherObserver) outcome.dispatcherObservation = dispatcherObserver.restore();
            outcome.checks.dispatcherObservation = outcome.dispatcherDrain?.status === 'settled' && outcome.dispatcherObservation.complete === true && outcome.calls.every(call => outcome.dispatcherObservation.panels.some(panel => panel.referenceIndex === call.index));
          }
        }
        if (outcome.damage.length || outcome.saved.length) outcome.classification = 'PRESERVATION_FAILED';
        else if (outcome.classification === 'RUNNING') outcome.classification = outcome.errors.length === 0 && Object.values(outcome.checks).every(value => value === true) ? 'PASS' : 'EVIDENCE_OR_CLEANUP_FAILED';
        write('final-outcome', outcome);
        return JSON.parse(JSON.stringify(outcome));
      })()
      """
    Then I collect JSON artifact "typespec-first-activation-assertion" from extension host expression:
      """
      (() => {
        const outcome = globalThis.__typespecFirstActivation;
        if (outcome?.classification !== 'PASS') throw new Error(JSON.stringify({ classification: outcome?.classification, evidenceRoot: outcome?.evidenceRoot, calls: outcome?.calls.map(record => ({ index: record.index, elapsedMs: record.elapsedMs, value: record.value, textParts: record.textParts, transportError: record.transportError, oraclePassed: record.oraclePassed })), dispatcherObservation: outcome?.dispatcherObservation, evidenceFailures: outcome?.evidenceFailures, checks: outcome?.checks, errors: outcome?.errors }));
        return { schemaVersion: outcome.schemaVersion, passed: true, trial: outcome.trial, firstActivations: outcome.calls.length, evidenceRoot: outcome.evidenceRoot, dispatcherObservation: outcome.dispatcherObservation, guardContract: outcome.guardContract, helperSha256: outcome.helperSha256, actualCode: outcome.actualCode, afterActualCode: outcome.afterActualCode, build: outcome.build, runtime: outcome.runtime };
      })()
      """