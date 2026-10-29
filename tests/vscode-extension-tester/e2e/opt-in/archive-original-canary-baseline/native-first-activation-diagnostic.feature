# Fresh preset-only isolated profile per case; --no-build --timeout 90000 --vscode-arg=--log=trace.
# A: alone/custom; B: prefix100/custom; C: alone/text; D: prefix100/text.
# C/D are conditional controls after a missing custom boundary or hang, never a warm fallback.
# Acceptance: immutable ZIP bytes -> one first open per URI -> exact live/custom or default-text tab -> unchanged models/files.
# Node checks cover observer transparency, not a product reproduction. No Save, query, retry, settings update or timeout override.
# INSTRUMENTED: passive raw renderer metadata and heartbeat; built-in IPC remains unobserved.
Feature: Native first activation boundary diagnostic

  Scenario: Observe the first native open of archived target 101 in an independent cold host
    Given I collect JSON artifact "native-first-activation-diagnostic" from extension host expression:
      """
      (async function runNativeOpenDiagnostic() {
        const fs = process.getBuiltinModule('node:fs'), path = process.getBuiltinModule('node:path');
        const modules = process.getBuiltinModule('node:module'), url = process.getBuiltinModule('node:url');
        const assert = process.getBuiltinModule('node:assert/strict');
        const hash = bytes => process.getBuiltinModule('node:crypto').createHash('sha256').update(bytes).digest('hex');
        const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        const readNativeMessageMetadata = (message, isProxy = () => false) => {
          if (!message || typeof message !== 'object' || isProxy(message)) return {};
          const metadata = {};
          for (const key of ['type', 'probeId', 'requestId', 'viewSessionId', 'documentViewSessionId', 'reloadRequestId', 'sourceGeneration', 'forceReload', 'documentRevision', 'editRevision', 'runtimeId', 'applied']) {
            const descriptor = Object.getOwnPropertyDescriptor(message, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
            const value = descriptor.value;
            if (typeof value === 'string' && value.length <= 128 || typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value) || value === null) metadata[key] = value;
          }
          return metadata;
        };
        const createNativeOpenObserver = ({ facade, references, initialDocuments, clock, getPhase }) => {
          const types = process.getBuiltinModule('node:util').types, nativeThen = Promise.prototype.then;
          const records = [], patches = [], listeners = [], pending = new Map(), providers = new WeakSet(), panels = new WeakSet();
          const state = { lost: 0, failures: 0, unavailable: [], settlementUnavailable: 0, restoreFailures: 0, saved: 0, changed: 0, modelDamage: 0, configurationChanges: 0 };
          const documentReferences = new Map();
          let retired = false, sequence = 0, operation = 0, panelSequence = 0;
          const safeTry = action => { if (!retired) { try { return action(); } catch { state.failures++; } } };
          const data = (value, key) => {
            if (!value || types.isProxy(value)) return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
          };
          const identity = value => {
            if (!value || types.isProxy(value) || !(value instanceof facade.Uri)) return null;
            const scheme = value.scheme;
            const safeScheme = typeof scheme === 'string' && /^[a-zA-Z][a-zA-Z0-9+.-]{0,63}$/.test(scheme) ? scheme : 'unknown';
            if (safeScheme !== 'file' && safeScheme !== 'chatSessionInput') return { uri: null, scheme: safeScheme, index: null, known: false };
            const raw = Reflect.apply(facade.Uri.prototype.toString, value, []), reference = references.get(raw);
            const knownChat = raw === 'chatSessionInput:input-0' && [...initialDocuments.keys()].some(document => document.uri === value);
            return { uri: reference || knownChat || safeScheme === 'file' && !value.query && !value.fragment && raw.length <= 2048 ? raw : null, scheme: safeScheme, index: reference?.index ?? null, known: !!reference || knownChat };
          };
          const ownedArgument = value => {
            const metadata = identity(value) ?? identity(data(value, 'uri'));
            return metadata?.index != null ? metadata : null;
          };
          const record = (kind, metadata = {}) => safeTry(() => {
            const phase = getPhase(), atMs = clock(), key = JSON.stringify([kind, phase, metadata]);
            let entry = records.find(candidate => candidate.key === key);
            if (!entry) {
              if (records.length === 128) { state.lost++; return; }
              entry = { key, kind, phase, ...metadata, firstMs: atMs, lastMs: atMs, firstOrder: ++sequence, lastOrder: sequence, count: 0 };
              records.push(entry);
            } else entry.lastOrder = ++sequence;
            entry.lastMs = atMs; entry.count++;
            return entry;
          });
          const unavailable = boundary => { if (state.unavailable.length < 32) state.unavailable.push(boundary); else state.lost++; };
          const equalDescriptor = (left, right) => !left || !right ? left === right : ['value', 'writable', 'enumerable', 'configurable', 'get', 'set'].every(key => Object.hasOwn(left, key) === Object.hasOwn(right, key) && Object.is(left[key], right[key]));
          const patch = (target, key, factory) => safeTry(() => {
            const original = Object.getOwnPropertyDescriptor(target, key);
            let descriptor = original, owner = target;
            for (let depth = 0; !descriptor && depth < 16; depth++) { owner = Object.getPrototypeOf(owner); if (!owner) break; descriptor = Object.getOwnPropertyDescriptor(owner, key); }
            if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || !descriptor.configurable && (!original || !descriptor.writable) || !original && !Object.isExtensible(target) || patches.length === 64) { unavailable(key); return false; }
            const replacement = { ...descriptor, value: factory(descriptor.value) };
            Object.defineProperty(target, key, replacement);
            patches.push({ target, key, original, replacement });
            return true;
          });
          const observeCall = (original, receiver, args, kind, metadata, beforeCall) => {
            const attempt = safeTry(() => {
              if (!metadata) return;
              const entry = { operation: ++operation, kind, ...metadata, phase: getPhase(), atMs: clock() };
              if (pending.size === 128) { state.lost++; return; }
              pending.set(entry.operation, entry); record(kind + '.entry', metadata); return entry;
            });
            if (beforeCall) safeTry(beforeCall);
            const settle = (settlement, value) => safeTry(() => {
              if (!attempt || !pending.delete(attempt.operation)) return;
              const sdkResult = settlement === 'thrown' ? 'throw' : settlement === 'rejected' ? 'rejected' : typeof value === 'boolean' ? value : 'unobserved';
              record(kind + '.' + settlement, { ...metadata, ...(kind === 'webview.post' ? { sdkResult } : {}) });
            });
            let result;
            try { result = Reflect.apply(original, receiver, args); }
            catch (error) { settle('thrown'); throw error; }
            if (attempt && !retired) safeTry(() => {
              if (types.isPromise(result)) {
                const observed = nativeThen.call(result, value => settle('fulfilled', value), () => settle('rejected'));
                nativeThen.call(observed, undefined, () => {});
              } else if (result === undefined || result === null || typeof result !== 'object' && typeof result !== 'function') settle('returned', result);
              else { state.settlementUnavailable++; settle('unobserved-return'); }
            });
            return result;
          };
          const messageMetadata = message => readNativeMessageMetadata(message, types.isProxy);
          const observePanel = (panel, metadata) => {
            if (!metadata?.known || metadata.index == null || panels.has(panel)) return;
            panels.add(panel);
            metadata = { ...metadata, panelId: ++panelSequence, uriSha256: process.getBuiltinModule('node:crypto').createHash('sha256').update(metadata.uri).digest('hex') };
            const webview = panel.webview;
            listeners.push(webview.onDidReceiveMessage(message => safeTry(() => record('webview.receive', { ...metadata, ...messageMetadata(message) }))));
            patch(webview, 'postMessage', original => function (...args) { return observeCall(original, this, args, 'webview.post', safeTry(() => ({ ...metadata, ...messageMetadata(args[0]) }))); });
          };
          const documentEvent = (kind, document, changes = 0) => safeTry(() => {
            const metadata = identity(document.uri);
            if (!metadata?.known) return;
            if (metadata.index != null) {
              if (!documentReferences.has(metadata.uri)) documentReferences.set(metadata.uri, document);
              if (documentReferences.get(metadata.uri) !== document || document.version !== 1 || document.isDirty) state.modelDamage++;
            } else {
              const expected = initialDocuments.get(document);
              if (!expected || document.version !== expected.version || document.isDirty !== expected.dirty || document.languageId !== expected.languageId) state.modelDamage++;
            }
            if (kind === 'document.save' || kind === 'document.willSave') state.saved++;
            if (kind === 'document.change' && (changes > 0 || document.isDirty)) state.changed++;
            record(kind, { ...metadata, version: document.version, dirty: document.isDirty, changes });
          });
          return {
            install() {
              patch(facade.workspace, 'openTextDocument', original => function (...args) { return observeCall(original, this, args, 'workspace.openTextDocument', safeTry(() => ownedArgument(args[0]))); });
              patch(facade.commands, 'executeCommand', original => function (...args) { return observeCall(original, this, args, 'commands.openWith', safeTry(() => args[0] === 'vscode.openWith' ? ownedArgument(args[1]) : null)); });
              patch(facade.window, 'registerCustomEditorProvider', original => function (...args) {
                safeTry(() => {
                  const provider = args[1], viewType = typeof args[0] === 'string' && args[0].length <= 128 ? args[0] : null;
                  if (providers.has(provider)) return;
                  providers.add(provider);
                  patch(provider, 'resolveCustomTextEditor', resolve => function (...resolveArgs) {
                    const metadata = safeTry(() => ({ ...(identity(resolveArgs[0]?.uri) ?? { uri: null, scheme: 'unknown', index: null, known: false }), viewType })) ?? { uri: null, scheme: 'unknown', index: null, known: false, viewType };
                    return observeCall(resolve, this, resolveArgs, 'provider.resolveCustomTextEditor', metadata, () => observePanel(resolveArgs[1], metadata));
                  });
                });
                return Reflect.apply(original, this, args);
              });
              for (const [event, kind] of [['onDidOpenTextDocument', 'document.open'], ['onDidCloseTextDocument', 'document.close'], ['onWillSaveTextDocument', 'document.willSave'], ['onDidSaveTextDocument', 'document.save']]) safeTry(() => listeners.push(facade.workspace[event](value => documentEvent(kind, value.document ?? value))));
              safeTry(() => listeners.push(facade.workspace.onDidChangeTextDocument(event => documentEvent('document.change', event.document, event.contentChanges.length))));
              safeTry(() => listeners.push(facade.workspace.onDidChangeConfiguration(event => {
                for (const key of ['files.autoSave', 'files.autoSaveDelay', 'workbench.editor.enablePreview']) if (event.affectsConfiguration(key)) safeTry(() => { state.configurationChanges++; record('configuration.change', { key }); });
              })));
              safeTry(() => listeners.push(facade.window.tabGroups.onDidChangeTabs(event => {
                for (const change of ['opened', 'changed', 'closed']) for (const tab of event[change]) safeTry(() => {
                  const metadata = identity(tab.input?.uri);
                  if (metadata?.known) record('tab.' + change, { ...metadata, dirty: tab.isDirty, active: tab.isActive, viewType: typeof tab.input?.viewType === 'string' ? tab.input.viewType : null });
                });
              })));
            },
            snapshot() { return { ...state, unavailable: [...state.unavailable], retired, records: records.map(({ key, ...entry }) => ({ ...entry })), pending: [...pending.values()].map(entry => ({ ...entry })) }; },
            restore() {
              if (!retired) {
                retired = true;
                for (const listener of listeners) { try { listener.dispose(); } catch { state.restoreFailures++; } }
                for (const entry of patches.reverse()) {
                  try {
                    if (!equalDescriptor(Object.getOwnPropertyDescriptor(entry.target, entry.key), entry.replacement)) { state.restoreFailures++; continue; }
                    if (entry.original) Object.defineProperty(entry.target, entry.key, entry.original); else if (!Reflect.deleteProperty(entry.target, entry.key)) state.restoreFailures++;
                    if (!equalDescriptor(Object.getOwnPropertyDescriptor(entry.target, entry.key), entry.original)) state.restoreFailures++;
                  } catch { state.restoreFailures++; }
                }
              }
              return this.snapshot();
            },
          };
        };
        const installNativeRendererProbe = (readMetadata, bindingName, namespace, expiresUtc) => {
          if (Object.getOwnPropertyDescriptor(globalThis, namespace)) return false;
          const publish = Object.getOwnPropertyDescriptor(globalThis, bindingName)?.value;
          const readData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
          if (typeof publish !== 'function' || typeof readData !== 'function') return false;
          const messages = new Map(), now = () => performance.now();
          let retired = false, allEvents = 0, ticks = 0, lost = 0, failures = 0, maximumGap = 0, previous = now(), lastStatus = previous, interval, expiry;
          const emit = (kind, fields = {}) => { try { Reflect.apply(publish, globalThis, [JSON.stringify({ kind, ...fields, atMs: now() })]); } catch { failures++; } };
          const flush = () => { for (const entry of messages.values()) if (entry.changed) { entry.changed = false; emit('message', { message: entry.message, count: entry.count, firstMs: entry.firstMs, lastMs: entry.lastMs }); } };
          const listener = event => {
            if (retired) return;
            allEvents++;
            try {
              const message = readMetadata(Reflect.apply(readData, event, []));
              if (typeof message.type !== 'string') return;
              const key = JSON.stringify(message), atMs = now();
              const existing = messages.get(key);
              if (existing) { existing.count++; existing.lastMs = atMs; existing.changed = true; return; }
              if (messages.size === 128) { if (++lost === 1) emit('overflow'); return; }
              const entry = { message, count: 1, firstMs: atMs, lastMs: atMs, changed: false };
              messages.set(key, entry); emit('message', { message, count: 1, firstMs: atMs, lastMs: atMs });
            } catch { failures++; emit('probe-error', { failures }); }
          };
          let observedDocument = document;
          let observedRoot = observedDocument.documentElement;
          const reconcileDocument = () => {
            if (retired) return;
            const currentDocument = globalThis.document, currentRoot = currentDocument.documentElement;
            if (currentDocument === observedDocument && currentRoot === observedRoot) return;
            if (currentDocument !== observedDocument) {
              documentObserver.disconnect();
              documentObserver.observe(currentDocument, { childList: true });
            }
            observedDocument = currentDocument;
            observedRoot = currentRoot;
            globalThis.addEventListener('message', listener, true);
          };
          const documentObserver = new MutationObserver(reconcileDocument);
          const api = { inspect() {
            return { allEvents, sameDocument: globalThis.document === observedDocument, hasDispatcher: Object.getOwnPropertyDescriptor(globalThis, '__kustoHostMessageDispatcherReady')?.value === true };
          }, dispose(reason = 'disposed') {
            if (retired) return true;
            retired = true; documentObserver.disconnect(); clearInterval(interval); clearTimeout(expiry); globalThis.removeEventListener('message', listener, true); flush();
            const removed = Object.getOwnPropertyDescriptor(globalThis, namespace)?.value === api && Reflect.deleteProperty(globalThis, namespace);
            emit(reason, { ticks, maxGapMs: maximumGap, lost, failures, listenerRemoved: true, timersCleared: true, namespaceRemoved: removed });
            return removed;
          } };
          Object.defineProperty(globalThis, namespace, { configurable: true, value: api });
          documentObserver.observe(observedDocument, { childList: true });
          globalThis.addEventListener('message', listener, true); emit('installed');
          interval = setInterval(() => {
            if (retired) return;
            const current = now(); ticks++; maximumGap = Math.max(maximumGap, current - previous); previous = current;
            if (Date.now() >= expiresUtc) { api.dispose('expired'); return; }
            reconcileDocument();
            if (current - lastStatus >= 1000) { lastStatus = current; flush(); emit('heartbeat', { ticks, maxGapMs: maximumGap, lost, failures }); }
          }, 250);
          expiry = setTimeout(() => api.dispose('expired'), Math.min(85000, Math.max(0, expiresUtc - Date.now())));
          return true;
        };
        const createNativeRendererObserver = ({ CDP, port, token, clock, setTimer = setTimeout, clearTimer = clearTimeout }) => {
          const bindingName = 'kwNativeDiag_' + token, namespace = '__kwNativeDiag_' + token;
          const source = '(' + installNativeRendererProbe.toString() + ')(' + readNativeMessageMetadata.toString() + ',' + JSON.stringify(bindingName) + ',' + JSON.stringify(namespace) + ',' + (Date.now() + 85000) + ')';
          const sessions = new Map(), contexts = new Map(), numericContexts = new Map(), messages = new Map(), lifecycle = [], handlers = [], setups = new Set();
          const state = { instrumented: true, arm: 'not-started', lost: 0, issues: [], disconnected: false, cleanup: null };
          let client, stopping = false, retired = false, sequence = 0, expiry, disposal;
          const note = (kind, metadata = {}) => {
            if (retired) return;
            const order = ++sequence, atMs = clock(), key = JSON.stringify([kind, metadata]);
            const previous = lifecycle.find(entry => entry.key === key);
            if (previous) { previous.count++; previous.lastMs = atMs; previous.lastOrder = order; }
            else if (lifecycle.length < 128) lifecycle.push({ key, kind, ...metadata, count: 1, firstMs: atMs, lastMs: atMs, firstOrder: order, lastOrder: order });
            else state.lost++;
            return order;
          };
          const issue = (boundary, status, error) => {
            if (retired) return;
            const metadata = { boundary, status };
            if (error && !process.getBuiltinModule('node:util').types.isProxy(error)) {
              const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
              if (typeof descriptor?.value === 'string') metadata.message = descriptor.value.slice(0, 512);
            }
            if (!state.issues.some(entry => JSON.stringify(entry) === JSON.stringify(metadata))) {
              if (state.issues.length < 32) state.issues.push(metadata); else state.lost++;
            }
          };
          const bounded = (action, boundary, late, reportIssue = true) => new Promise(resolve => {
            let finished = false;
            const timer = setTimer(() => { finished = true; if (reportIssue) issue(boundary, 'timeout'); resolve({ ok: false, status: 'timeout' }); }, 2000);
            const finish = (ok, value) => {
              if (finished) { if (ok && late) { try { Promise.resolve(late(value)).catch(() => {}); } catch {} } return; }
              finished = true; clearTimer(timer);
              if (!ok && reportIssue) issue(boundary, 'rejected', value);
              resolve(ok ? { ok, value } : { ok, status: 'rejected' });
            };
            try { Promise.resolve(action()).then(value => finish(true, value), error => finish(false, error)); }
            catch (error) { finish(false, error); }
          });
          const send = (method, params, sessionId, late) => bounded(() => client.send(method, params, sessionId), method, late);
          const autoAttach = autoAttach => ({ autoAttach, flatten: true, waitForDebuggerOnStart: false });
          const retireContext = (context, kind) => {
            if (!context || context.destroyed) return;
            context.destroyed = true; context.destroyedOrder = note(kind, { contextKey: context.key });
            if (numericContexts.get(context.sessionId + ':' + context.contextId) === context.key) numericContexts.delete(context.sessionId + ':' + context.contextId);
          };
          const listen = (name, action) => {
            const handler = (...args) => { if (!retired) { try { action(...args); } catch (error) { issue(name, 'handler-error', error); } } };
            client.on(name, handler); handlers.push([name, handler]);
          };
          const snapshot = (host = { records: [] }) => {
            const posts = host.records.filter(entry => entry.kind === 'webview.post.entry' && entry.type === 'documentData');
            const first = posts.filter(entry => entry.index === 101 && entry.sourceGeneration === 1 && typeof entry.viewSessionId === 'string' && typeof entry.reloadRequestId === 'string');
            const matches = first.flatMap(post => [...messages.values()].filter(message => message.type === 'documentData' && message.viewSessionId === post.viewSessionId && message.reloadRequestId === post.reloadRequestId && message.sourceGeneration === 1).map(message => ({ post, message })));
            let binding = null;
            if (first.length === 1 && matches.length === 1 && !posts.some(post => post.panelId !== first[0].panelId && post.viewSessionId === first[0].viewSessionId && post.reloadRequestId === first[0].reloadRequestId && post.sourceGeneration === 1)) {
              const { post, message } = matches[0], context = contexts.get(message.contextKey);
              if (context?.installedOrder && context.installedOrder < message.firstOrder) binding = { index: 101, panelId: post.panelId, uriSha256: post.uriSha256, viewSessionId: post.viewSessionId, reloadRequestId: post.reloadRequestId, sourceGeneration: 1,
                contextKey: context.key, targetId: context.targetId, sessionId: context.sessionId, frameId: context.frameId, uniqueContextId: context.uniqueContextId, installedOrder: context.installedOrder, rawGen1Order: message.firstOrder };
            }
            const context = binding && contexts.get(binding.contextKey);
            return { ...state, issues: state.issues.map(entry => ({ ...entry })), cleanup: state.cleanup && { ...state.cleanup, pendingContexts: [...state.cleanup.pendingContexts] },
              qualification: binding && !state.lost && !state.issues.length && state.arm === 'armed' ? 'QUALIFIED' : 'LATE_OR_INCOMPLETE', binding,
              liveness: context?.heartbeat ? 'heartbeat-observed' : 'unknown',
              contexts: [...contexts.values()].map(entry => ({ ...entry, heartbeat: entry.heartbeat && { ...entry.heartbeat } })),
              messages: [...messages.values()].map(({ key, ...entry }) => ({ ...entry })), lifecycle: lifecycle.map(({ key, ...entry }) => ({ ...entry })) };
          };
          const api = {
            async arm() {
              state.arm = 'connecting';
              const version = await bounded(() => CDP.Version({ host: '127.0.0.1', port }), 'CDP.Version');
              if (!version.ok) { state.arm = 'unavailable'; return; }
              const connection = await bounded(() => CDP({ target: version.value.webSocketDebuggerUrl, port }), 'CDP.connect', late => late.close());
              if (!connection.ok) { state.arm = 'unavailable'; return; }
              client = connection.value;
              listen('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
                if (stopping || !['page', 'iframe', 'webview'].includes(targetInfo.type)) return;
                if (sessions.has(sessionId)) return;
                if (sessions.size === 64) { state.lost++; return; }
                const session = { sessionId, targetId: targetInfo.targetId, active: true, scriptId: null };
                sessions.set(sessionId, session); note('target.attached', { sessionId, targetId: session.targetId });
                const setup = (async () => {
                  await send('Target.setAutoAttach', autoAttach(true), sessionId);
                  if (stopping) return;
                  const added = await send('Runtime.addBinding', { name: bindingName }, sessionId);
                  if (stopping || !added.ok) return;
                  const preload = await send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId,
                    value => client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: value.identifier }, sessionId));
                  if (preload.ok) session.scriptId = preload.value.identifier;
                  if (stopping) return;
                  await send('Runtime.enable', {}, sessionId);
                })();
                setups.add(setup); setup.finally(() => setups.delete(setup)).catch(error => issue('session-setup', 'rejected', error));
              });
              listen('Runtime.executionContextCreated', ({ context }, sessionId) => {
                if (stopping || context.auxData?.isDefault !== true) return;
                const session = sessions.get(sessionId);
                if (!session || typeof context.uniqueId !== 'string' || typeof context.auxData.frameId !== 'string') { issue('context-identity', 'missing'); return; }
                const key = JSON.stringify([session.targetId, sessionId, context.auxData.frameId, context.uniqueId]);
                if (contexts.has(key)) return;
                if (contexts.size === 64) { state.lost++; return; }
                const numericKey = sessionId + ':' + context.id;
                retireContext(contexts.get(numericContexts.get(numericKey)), 'context.replaced');
                const entry = { key, targetId: session.targetId, sessionId, frameId: context.auxData.frameId, contextId: context.id, uniqueContextId: context.uniqueId, destroyed: false, installedOrder: null, cleaned: false, heartbeat: null };
                contexts.set(key, entry); numericContexts.set(numericKey, key); note('context.created', { contextKey: key });
                void send('Runtime.evaluate', { expression: source, uniqueContextId: entry.uniqueContextId, returnByValue: true, awaitPromise: false, silent: true }, sessionId).then(result => {
                  if (!retired && !stopping && result.ok && !entry.installedOrder) issue('instrument-install', 'marker-missing');
                });
              });
              listen('Runtime.bindingCalled', ({ name, payload, executionContextId }, sessionId) => {
                if (name !== bindingName) return;
                const context = contexts.get(numericContexts.get(sessionId + ':' + executionContextId));
                if (!context || context.destroyed || typeof payload !== 'string' || payload.length > 8192) { issue('binding-context', 'unattributed'); return; }
                const event = JSON.parse(payload), atMs = clock();
                if (!event || !Number.isFinite(event.atMs) || !['installed', 'message', 'heartbeat', 'disposed', 'expired', 'overflow', 'probe-error'].includes(event.kind)) { issue('binding-metadata', 'invalid'); return; }
                if (event.kind === 'installed') { context.installedOrder = note('probe.installed', { contextKey: context.key }); return; }
                if (event.kind === 'message') {
                  if (!Number.isSafeInteger(event.count) || event.count < 1 || !Number.isFinite(event.firstMs) || !Number.isFinite(event.lastMs)) { issue('message-metadata', 'invalid'); return; }
                  const metadata = readNativeMessageMetadata(event.message), key = JSON.stringify([context.key, metadata]), order = ++sequence;
                  const previous = messages.get(key);
                  if (previous) { previous.count = event.count; previous.lastRendererMs = event.lastMs; previous.lastMs = atMs; previous.lastOrder = order; }
                  else if (messages.size < 128) messages.set(key, { key, contextKey: context.key, ...metadata, count: event.count, firstRendererMs: event.firstMs, lastRendererMs: event.lastMs, firstMs: atMs, lastMs: atMs, firstOrder: order, lastOrder: order });
                  else state.lost++;
                } else if (event.kind === 'heartbeat') {
                  if (!Number.isSafeInteger(event.ticks) || event.ticks < 1 || !Number.isFinite(event.maxGapMs)) { issue('heartbeat-metadata', 'invalid'); return; }
                  context.heartbeat = { ticks: event.ticks, maxGapMs: event.maxGapMs, rendererMs: event.atMs, receivedMs: atMs, updates: (context.heartbeat?.updates ?? 0) + 1 };
                }
                else if (event.kind === 'disposed' || event.kind === 'expired') { context.cleaned = event.listenerRemoved === true && event.timersCleared === true && event.namespaceRemoved === true; note('probe.' + event.kind, { contextKey: context.key, clean: context.cleaned }); }
                else issue('renderer-' + (['overflow', 'probe-error'].includes(event.kind) ? event.kind : 'event'), 'incomplete');
                if (event.lost > 0 || event.failures > 0) issue('renderer-counters', 'incomplete');
              });
              listen('Runtime.executionContextDestroyed', (event, sessionId) => {
                const context = event.executionContextUniqueId ? [...contexts.values()].find(entry => entry.sessionId === sessionId && entry.uniqueContextId === event.executionContextUniqueId) : contexts.get(numericContexts.get(sessionId + ':' + event.executionContextId));
                retireContext(context, 'context.destroyed');
              });
              listen('Runtime.executionContextsCleared', (event, sessionId) => { for (const context of contexts.values()) if (context.sessionId === sessionId) retireContext(context, 'contexts.cleared'); });
              listen('Target.detachedFromTarget', ({ sessionId }) => { const session = sessions.get(sessionId); if (session) session.active = false; note('target.detached', { sessionId }); });
              listen('disconnect', () => { state.disconnected = true; note('cdp.disconnected'); if (!stopping) issue('CDP.connection', 'disconnected'); });
              const attached = await send('Target.setAutoAttach', autoAttach(true));
              state.arm = attached.ok ? 'armed' : 'unavailable';
              expiry = setTimer(() => { void api.dispose(); }, 85000); expiry?.unref?.();
            },
            snapshot,
            async inspectRealms() {
              if (!client || retired || stopping) return { status: 'unavailable', contexts: [] };
              const expression = '(() => { const probe = Object.getOwnPropertyDescriptor(globalThis,' + JSON.stringify(namespace) + ')?.value; const inspect = probe && Object.getOwnPropertyDescriptor(probe,"inspect")?.value; return typeof inspect === "function" ? Reflect.apply(inspect, probe, []) : null; })()';
              const active = [...contexts.values()].filter(context => !context.destroyed && sessions.get(context.sessionId)?.active);
              const observations = await Promise.all(active.map(async context => {
                const base = { contextKey: context.key };
                const response = await bounded(() => client.send('Runtime.evaluate', { expression, uniqueContextId: context.uniqueContextId, returnByValue: true, awaitPromise: false, silent: true }, context.sessionId), 'realm-inspection', undefined, false);
                if (!response.ok) return { ...base, status: response.status };
                if (retired || context.destroyed || !sessions.get(context.sessionId)?.active) return { ...base, status: 'retired' };
                if (response.value?.exceptionDetails) return { ...base, status: 'exception' };
                const value = response.value?.result?.value;
                if (value === null) return { ...base, status: 'unavailable' };
                if (!value || typeof value !== 'object') return { ...base, status: 'invalid' };
                const allEvents = Object.getOwnPropertyDescriptor(value, 'allEvents')?.value;
                const sameDocument = Object.getOwnPropertyDescriptor(value, 'sameDocument')?.value;
                const hasDispatcher = Object.getOwnPropertyDescriptor(value, 'hasDispatcher')?.value;
                if (!Number.isSafeInteger(allEvents) || allEvents < 0 || typeof sameDocument !== 'boolean' || typeof hasDispatcher !== 'boolean') return { ...base, status: 'invalid' };
                return { ...base, status: 'available', allEvents, sameDocument, hasDispatcher };
              }));
              return { status: 'inspected', contexts: observations };
            },
            async afterFailedFirstResult(host, failed) {
              const evidence = snapshot(host), binding = evidence.binding;
              if (!failed || !binding) return { status: 'not-requested' };
              const context = contexts.get(binding.contextKey);
              if (context.destroyed) return { status: 'destroyed', contextKey: context.key };
              const missing = host.records.some(post => post.kind === 'webview.post.entry' && post.panelId === binding.panelId && post.type === 'documentData' && post.sourceGeneration > 1 && !evidence.messages.some(message => message.contextKey === binding.contextKey && message.viewSessionId === post.viewSessionId && message.reloadRequestId === post.reloadRequestId && message.sourceGeneration === post.sourceGeneration));
              if (!missing || context.heartbeat && clock() - context.heartbeat.receivedMs < 1000) return { status: 'not-requested' };
              const result = await send('Runtime.evaluate', { expression: '1', uniqueContextId: binding.uniqueContextId, returnByValue: true, awaitPromise: false, silent: true }, binding.sessionId);
              return { status: result.ok && result.value.result?.value === 1 && !result.value.exceptionDetails ? 'responsive' : result.ok ? 'evaluation-failed' : result.status, contextKey: context.key };
            },
            dispose() {
              if (disposal) return disposal;
              stopping = true; clearTimer(expiry);
              disposal = (async () => {
                await Promise.all([...setups]);
                const active = [...sessions.values()].filter(session => session.active), removals = await Promise.all(active.filter(session => session.scriptId).map(session => send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.scriptId }, session.sessionId)));
                await Promise.all([...contexts.values()].filter(context => !context.destroyed && !context.cleaned).map(async context => {
                  const result = await send('Runtime.evaluate', { expression: 'globalThis[' + JSON.stringify(namespace) + ']?.dispose() ?? null', uniqueContextId: context.uniqueContextId, returnByValue: true, awaitPromise: false, silent: true }, context.sessionId);
                  if (result.ok && result.value.result?.value === true) context.cleaned = true;
                }));
                const bindings = await Promise.all(active.map(session => send('Runtime.removeBinding', { name: bindingName }, session.sessionId)));
                if (client) await send('Target.setAutoAttach', autoAttach(false));
                const pendingContexts = [...contexts.values()].filter(context => !context.destroyed && !context.cleaned && context.installedOrder).map(context => context.key);
                const closed = client ? await bounded(() => client.close(), 'CDP.close') : { ok: true };
                for (const [name, handler] of handlers) client.removeListener(name, handler);
                state.cleanup = { preloadsRemoved: removals.every(result => result.ok), bindingsRemoved: bindings.every(result => result.ok), connectionClosed: closed.ok, pendingContexts,
                  hostShutdownRequired: pendingContexts.length > 0 || !closed.ok || state.issues.length > 0 };
                retired = true; return snapshot();
              })();
              return disposal;
            },
          };
          return api;
        };
        const hasPendingNativeOpen = snapshot => snapshot?.pending.some(entry => ['commands.openWith', 'workspace.openTextDocument', 'provider.resolveCustomTextEditor'].includes(entry.kind)) === true;
        const inspectNativeHostEnvironment = () => {
          for (const key of ['VSCODE_EXT_TEST_WORKSPACE', 'KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH']) assert.equal(Object.hasOwn(process.env, key), false, key + ' must be absent');
          return { workspaceAndBypassAbsent: true, electronRunAsNodePresent: Object.hasOwn(process.env, 'ELECTRON_RUN_AS_NODE'), electronRunAsNodeValue: [undefined, '', '0', '1'].includes(process.env.ELECTRON_RUN_AS_NODE) ? process.env.ELECTRON_RUN_AS_NODE ?? null : 'other', scope: 'extension-host, not CLI launch environment' };
        };
        const outcome = { schemaVersion: 2, trial: process.env.KW_NATIVE_OPEN_TRIAL, editorMode: process.env.KW_NATIVE_OPEN_MODE, classification: 'SETUP_BLOCKED', productVerdict: 'NOT_RUN', instrumentation: 'INSTRUMENTED, not timing-neutral', calls: [], errors: [], checks: {}, heartbeat: { count: 0, maxGapMs: 0 }, ipcCoverage: 'Product-scoped SDK and raw renderer window messages; not built-in $tryOpenDocument IPC or parser admission' };
        assert.equal(globalThis.__nativeOpenDiagnostic, undefined, 'One scenario per cold host');
        globalThis.__nativeOpenDiagnostic = outcome;
        const references = new Map(), initialDocuments = new Map(), modelReferences = new Map();
        const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const modelMetadata = document => ({ uri: document.uri.toString(), version: document.version, dirty: document.isDirty, languageId: document.languageId });
        const metadataSnapshot = () => ({ atMs: performance.now(), phase, heartbeat: { ...outcome.heartbeat }, pendingCall: pendingCall ? { ...pendingCall } : null, observer: observer?.snapshot() ?? null, renderer: renderer?.snapshot(observer?.snapshot()) ?? null, tabs: tabs().filter(tab => references.has(tab.input?.uri?.toString())).map(tab => ({ uri: tab.input.uri.toString(), viewType: tab.input.viewType ?? 'default', dirty: tab.isDirty, active: tab.isActive })), models: vscode.workspace.textDocuments.filter(document => references.has(document.uri.toString()) || initialDocuments.has(document)).map(modelMetadata) });
        let helper, owner, evidenceRoot, manifest, main, observer, renderer, heartbeatTimer, checkpointTimer, exitListener, extension, scoped, pendingCall;
        let phase = 'setup';
        const write = (name, value) => {
          if (!owner) return;
          try { helper.assertAcceptanceRoot(owner); fs.writeFileSync(path.join(evidenceRoot, name + '.json'), JSON.stringify(value, null, 2), { flag: 'wx' }); }
          catch { outcome.errors.push({ phase, code: 'EVIDENCE_WRITE_FAILED', name }); }
        };
        const preset = () => [['files', 'autoSave', 'afterDelay'], ['files', 'autoSaveDelay', 1000], ['workbench.editor', 'enablePreview', false]].map(([section, key, expected]) => {
          const config = vscode.workspace.getConfiguration(section);
          assert.equal(config.inspect(key)?.globalValue, expected, 'Preset global setting missing');
          assert.equal(config.get(key), expected, 'Preset effective setting differs');
          return { section, key, expected };
        });
        const verifyBuild = () => {
          assert.equal(hash(fs.readFileSync(process.env.KW_NATIVE_OPEN_MANIFEST)), process.env.KW_NATIVE_OPEN_MANIFEST_SHA);
          for (const file of manifest.files) {
            const location = path.resolve(extension.extensionPath, file.path), stat = fs.lstatSync(location);
            assert.ok(location.startsWith(extension.extensionPath + path.sep));
            assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
            assert.equal(stat.size, file.bytes); assert.equal(hash(fs.readFileSync(location)), file.sha256);
          }
          return { mainSha256: hash(fs.readFileSync(main)), manifestSha256: process.env.KW_NATIVE_OPEN_MANIFEST_SHA, assetCount: manifest.files.length, assetsSha256: hash(JSON.stringify(manifest.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })))) };
        };
        const actualCode = () => {
          const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'))), app = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'package.json')));
          const executable = fs.readFileSync(process.execPath);
          assert.equal(app.version, '1.143.0'); assert.equal(app.version, vscode.version);
          assert.match(product.commit, /^[a-f0-9]{40}$/); assert.equal(product.commit, process.env.KW_NATIVE_OPEN_CODE_COMMIT);
          assert.equal(hash(executable), process.env.KW_NATIVE_OPEN_CODE_SHA);
          if (Object.hasOwn(manifest, 'code')) {
            assert.equal(product.commit, manifest.code.commit); assert.equal(executable.length, manifest.code.codeBytes); assert.equal(hash(executable), manifest.code.codeSha256);
          }
          return { version: app.version, commit: product.commit, sha256: hash(executable), bytes: executable.length, execPath: process.execPath, appRoot: vscode.env.appRoot };
        };
        const preserve = label => {
          helper.assertAcceptanceRoot(owner);
          for (const [document, expected] of initialDocuments) { assert.ok(vscode.workspace.textDocuments.includes(document)); assert.deepEqual(modelMetadata(document), expected, 'Initial chat model changed'); }
          for (const reference of references.values()) {
            const stat = fs.lstatSync(reference.file);
            assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && canonical(fs.realpathSync.native(reference.file)) === canonical(reference.file));
            assert.equal(stat.size, reference.bytes); assert.equal(stat.mtimeMs, reference.mtimeMs); assert.equal(hash(fs.readFileSync(reference.file)), reference.sha256);
          }
          for (const document of vscode.workspace.textDocuments) {
            if (initialDocuments.has(document)) continue;
            assert.ok(references.has(document.uri.toString()), 'Unexpected document model');
            if (!modelReferences.has(document.uri.toString())) modelReferences.set(document.uri.toString(), document);
            assert.equal(modelReferences.get(document.uri.toString()), document); assert.equal(document.version, 1); assert.equal(document.isDirty, false);
          }
          assert.equal(tabs().some(tab => tab.isDirty), false);
          if (observer) { const observed = observer.snapshot(); assert.equal(observed.saved, 0); assert.equal(observed.changed, 0); assert.equal(observed.modelDamage, 0); assert.equal(observed.configurationChanges, 0); }
          const snapshot = metadataSnapshot(); write(label, snapshot); return snapshot;
        };
        const archive = path.join(process.getBuiltinModule('node:os').tmpdir(), 'kw-regression-build2-before-2026-10-20-500ddb040c5b4dcf87630e2d488f4112.zip');
        const readArchive = wanted => new Promise((resolve, reject) => {
          modules.createRequire(path.join(manifest.sourceRoot, 'package.json'))('yauzl').open(archive, { lazyEntries: true }, (error, zip) => {
            if (error) return reject(error);
            const entries = new Map(), fail = failure => { zip.close(); reject(failure); };
            zip.on('error', fail); zip.on('end', () => entries.size === wanted.size ? resolve(entries) : reject(new Error('Missing archive member')));
            zip.on('entry', entry => {
              if (!wanted.has(entry.fileName)) { zip.readEntry(); return; }
              const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
              if (entries.has(entry.fileName) || entry.uncompressedSize > 64 * 1024 * 1024 || kind !== 0 && kind !== 0x8000) return fail(new Error('Unsafe archive member'));
              zip.openReadStream(entry, (failure, stream) => {
                if (failure) return fail(failure);
                const chunks = []; stream.on('error', fail); stream.on('data', chunk => chunks.push(chunk));
                stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
              });
            }); zip.readEntry();
          });
        });
        try {
          assert.ok(['alone', 'prefix100'].includes(outcome.trial)); assert.ok(['custom', 'text'].includes(outcome.editorMode));
          outcome.hostEnvironment = inspectNativeHostEnvironment();
          assert.equal(vscode.env.logLevel, vscode.LogLevel.Trace); assert.equal(tabs().length, 0); assert.equal(vscode.workspace.workspaceFolders?.length ?? 0, 0);
          for (const document of vscode.workspace.textDocuments) {
            const metadata = modelMetadata(document);
            assert.equal(metadata.uri, 'chatSessionInput:input-0'); assert.equal(document.uri.scheme, 'chatSessionInput'); assert.equal(metadata.languageId, 'plaintext'); assert.equal(metadata.dirty, false); assert.ok(Number.isSafeInteger(metadata.version) && metadata.version > 0);
            initialDocuments.set(document, metadata);
          }
          extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench'); assert.ok(extension); assert.equal(extension.isActive, false);
          const manifestBytes = fs.readFileSync(process.env.KW_NATIVE_OPEN_MANIFEST);
          assert.equal(hash(manifestBytes), process.env.KW_NATIVE_OPEN_MANIFEST_SHA); manifest = JSON.parse(manifestBytes);
          assert.equal(manifest.runtimeStableDuringCopy, true); assert.equal(canonical(extension.extensionPath), canonical(manifest.extensionRoot)); assert.notEqual(canonical(extension.extensionPath), canonical(manifest.sourceRoot));
          main = path.resolve(extension.extensionPath, extension.packageJSON.main); scoped = modules.createRequire(main)('vscode');
          outcome.build = verifyBuild(); outcome.actualCode = actualCode(); outcome.configuration = preset();
          const helperPath = path.join(manifest.sourceRoot, 'scripts/repro-published-notebook.mjs');
          outcome.helperPath = helperPath; outcome.helperSha256 = hash(fs.readFileSync(helperPath)); helper = await import(url.pathToFileURL(helperPath).href);
          owner = helper.createAcceptanceRoot(); evidenceRoot = path.join(owner.root, 'evidence'); fs.mkdirSync(evidenceRoot); outcome.evidenceRoot = evidenceRoot;
          outcome.runtime = { pid: process.pid, ppid: process.ppid, extensionRoot: extension.extensionPath, scopedApi: scoped !== vscode ? 'product-specific' : 'shared', initialModels: [...initialDocuments.values()] };
          outcome.archiveSha256 = hash(fs.readFileSync(archive)); assert.equal(outcome.archiveSha256, 'f743e4f9be3e2470301a5ef9b0b0961022f5fdf8a3be8355a6f912ab5e82d9b3');
          const metadata = await readArchive(new Set(['baseline.json', 'evidence/verified-prequalification-ledger.json']));
          const baseline = JSON.parse(metadata.get('baseline.json')), ledger = JSON.parse(metadata.get('evidence/verified-prequalification-ledger.json'));
          outcome.archiveMetadata = Object.fromEntries([...metadata].map(([key, bytes]) => [key, hash(bytes)]));
          const selected = outcome.trial === 'alone' ? [ledger.sweep[100]] : ledger.sweep.slice(99, 101);
          assert.equal(ledger.sweep[99].relativePath, 'powerbi/new-powerbi-report.kqlx'); assert.equal(ledger.sweep[100].relativePath, 'query-compare/query-comparison-test.kqlx');
          const images = await readArchive(new Set(selected.map(entry => 'before/' + entry.relativePath)));
          for (const entry of selected) {
            assert.equal(entry.index, entry.relativePath === 'powerbi/new-powerbi-report.kqlx' ? 100 : 101); assert.equal(entry.call.tool, 'kusto-workbench_activate-workbench-file');
            const matches = baseline.files.filter(file => file.path === entry.relativePath); assert.equal(matches.length, 1);
            const expected = matches[0], bytes = images.get('before/' + entry.relativePath), sections = JSON.parse(bytes).state.sections;
            assert.equal(bytes.length, expected.bytes); assert.equal(hash(bytes), expected.sha256.toLowerCase()); assert.equal(sections.some(section => section.linkedQueryPath), false);
            if (entry.index === 101) { assert.equal(bytes.length, 7276); assert.equal(sections.length, 1); assert.equal(sections[0].type, 'query'); assert.equal(sections.some(section => Object.hasOwn(section, 'resultJson')), false); }
            const file = path.join(owner.root, 'history', entry.relativePath); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
            const uri = vscode.Uri.file(file), normalized = uri.fsPath.split(path.sep).join('/'), key = 'file:' + (process.platform === 'win32' ? normalized.toLowerCase() : normalized);
            references.set(uri.toString(), { index: entry.index, path: entry.relativePath, file, uri: uri.toString(), bytes: expected.bytes, sha256: expected.sha256.toLowerCase(), mtimeMs: fs.statSync(file).mtimeMs, openFileId: 'wf_' + Buffer.from(key).toString('base64url') });
          }
          outcome.references = [...references.values()]; preserve('before-activation'); write('prepared', outcome);
          observer = createNativeOpenObserver({ facade: scoped, references, initialDocuments, clock: () => performance.now(), getPhase: () => phase }); observer.install();
          try {
            const port = Number(process.env.KW_NATIVE_OPEN_CDP_PORT);
            assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Owned raw CDP port required');
            const CDP = modules.createRequire(path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/package.json'))('chrome-remote-interface');
            renderer = createNativeRendererObserver({ CDP, port, token: process.getBuiltinModule('node:crypto').randomUUID().replaceAll('-', ''), clock: () => performance.now() });
            await renderer.arm();
          } catch (error) { outcome.rendererSetupError = String(error?.message ?? error); }
          let lastBeat = performance.now();
          heartbeatTimer = setInterval(() => { const now = performance.now(); outcome.heartbeat.count++; outcome.heartbeat.maxGapMs = Math.max(outcome.heartbeat.maxGapMs, now - lastBeat); outcome.heartbeat.lastMs = now; lastBeat = now; }, 250);
          exitListener = () => { write('host-exit-checkpoint', { ...metadataSnapshot(), classification: pendingCall ? 'DIAGNOSTIC_INTERRUPTED' : outcome.classification, pendingCheckpoint: outcome.pendingCheckpoint ?? null, exitObservedInHost: true }); };
          process.once('exit', exitListener);
          phase = 'extension.activate'; await extension.activate();
          const loaded = Object.values(modules.createRequire(main).cache).find(candidate => candidate?.filename && canonical(candidate.filename) === canonical(main));
          const context = loaded?.exports?.toolOrchestrator?.context;
          assert.equal(loaded?.loaded, true); assert.equal(context?.extensionMode, vscode.ExtensionMode.Development); assert.equal(canonical(context.extensionPath), canonical(extension.extensionPath));
          assert.match(process.env.KW_NATIVE_OPEN_PROFILE, /^nod-[a-f0-9]{6}$/);
          const profileRoot = path.join(extension.extensionPath, 'tests', 'vscode-extension-tester', 'profiles', process.env.KW_NATIVE_OPEN_PROFILE, 'user-data');
          assert.ok(canonical(context.globalStorageUri.fsPath).startsWith(canonical(profileRoot) + path.sep));
          outcome.loaded = { main: loaded.filename, extensionMode: context.extensionMode, logRoot: context.logUri.fsPath, globalStorageUri: context.globalStorageUri.toString(), profileRoot };
          write('loaded-runtime', outcome.loaded); assert.equal(tabs().length, 0); preserve('after-extension-activation');
          outcome.classification = 'RUNNING';
          for (const reference of references.values()) {
            preserve('before-first-open-' + reference.index);
            assert.equal(vscode.workspace.textDocuments.some(document => document.uri.toString() === reference.uri), false, 'No model warming');
            assert.equal(tabs().some(tab => tab.input?.uri?.toString() === reference.uri), false, 'No target retry');
            const mode = reference.index === 100 ? 'custom' : outcome.editorMode;
            phase = 'first-open-' + reference.index + '-' + mode;
            const call = { index: reference.index, uri: reference.uri, mode, actor: mode === 'custom' ? 'public-lm-tool' : 'native-default-text', startedMs: performance.now(), startedUtc: new Date().toISOString(), pending: true, oraclePassed: false };
            outcome.calls.push(call); pendingCall = call; write('call-' + reference.index + '-started', metadataSnapshot());
            checkpointTimer = setTimeout(() => { outcome.pendingCheckpoint = { ...metadataSnapshot(), index: reference.index, classification: 'FIRST_AWAIT_PENDING', elapsedMs: performance.now() - call.startedMs }; }, 45000);
            try {
              if (mode === 'custom') {
                const raw = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file', { toolInvocationToken: undefined, input: { targetFileUri: reference.uri } });
                call.text = raw.content.filter(part => typeof part?.value === 'string').map(part => part.value).join('\n');
                call.value = JSON.parse(call.text);
              } else await scoped.commands.executeCommand('vscode.openWith', scoped.Uri.file(reference.file), 'default', { preview: false });
            } catch (error) { call.error = String(error?.message ?? error); }
            finally { call.pending = false; call.elapsedMs = performance.now() - call.startedMs; pendingCall = undefined; clearTimeout(checkpointTimer); }
            write('call-' + reference.index + '-settled', { call, observation: metadataSnapshot() });
            if (call.error) { outcome.classification = /cancel/i.test(call.error) ? 'DIAGNOSTIC_INTERRUPTED' : 'FIRST_OPEN_REJECTED'; throw new Error(call.error); }
            if (mode === 'custom') {
              assert.equal(call.value?.success, true, call.text); assert.equal(call.value.isLiveWorkbench, true); assert.equal(call.value.isReadOnlyFallback, false); assert.equal(call.value.uri, reference.uri); assert.equal(call.value.openFileId, reference.openFileId);
            }
            const exact = tabs().filter(tab => tab.input?.uri?.toString() === reference.uri); assert.equal(exact.length, 1); assert.equal(exact[0].isActive, true);
            assert.ok(mode === 'custom' ? exact[0].input instanceof vscode.TabInputCustom : exact[0].input instanceof vscode.TabInputText);
            if (mode === 'custom') assert.equal(exact[0].input.viewType, 'kusto.kqlxEditor');
            assert.equal(tabs().length, outcome.calls.length, 'Retain the prefix'); assert.ok(vscode.workspace.textDocuments.some(document => document.uri.toString() === reference.uri));
            preserve('after-first-open-' + reference.index); call.oraclePassed = true;
          }
          outcome.productVerdict = 'PASS';
          outcome.classification = 'PASS';
        } catch (error) {
          outcome.errors.push({ phase, message: String(error?.message ?? error) });
          if (outcome.calls.length) outcome.productVerdict = pendingCall ? 'PENDING_OR_CANCELED' : 'FIRST_RESULT_OR_PRESERVATION_FAILED';
          if (outcome.classification === 'RUNNING') outcome.classification = 'FIRST_OPEN_OR_PRESERVATION_FAILED';
        } finally {
          clearTimeout(checkpointTimer); clearInterval(heartbeatTimer);
          const nativePending = hasPendingNativeOpen(observer?.snapshot());
          if (exitListener && !nativePending && !pendingCall) process.removeListener('exit', exitListener);
          if (nativePending || pendingCall) outcome.classification = 'DIAGNOSTIC_INTERRUPTED';
          outcome.rendererAtVerdict = renderer?.snapshot(observer?.snapshot()) ?? null;
          try { outcome.rendererRealmInspection = await renderer?.inspectRealms?.() ?? { status: 'unavailable', contexts: [] }; }
          catch { outcome.rendererRealmInspection = { status: 'failed', contexts: [] }; }
          try { outcome.rendererFailureProbe = await renderer?.afterFailedFirstResult(observer?.snapshot(), outcome.calls.some(call => call.index === 101 && !call.pending && (call.error || call.value?.success !== true))); }
          catch (error) { outcome.rendererFailureProbe = { status: 'unavailable', error: String(error?.message ?? error) }; }
          if (owner && !pendingCall && !nativePending) {
            phase = 'cleanup';
            try { preserve('before-cleanup'); outcome.cleanup = await helper.closeAcceptanceTabs(vscode, owner, [...references.keys()]); preserve('after-cleanup'); outcome.checks.preservation = true; }
            catch (error) { outcome.errors.push({ phase, message: String(error?.message ?? error) }); }
          }
          try { await renderer?.dispose(); }
          catch (error) { outcome.rendererCleanupError = String(error?.message ?? error); }
          finally { outcome.observer = observer?.restore() ?? null; }
          outcome.renderer = renderer?.snapshot(outcome.observer ?? { records: [] }) ?? null;
          outcome.observationFlags = { incomplete: !!outcome.rendererSetupError || outcome.rendererAtVerdict?.qualification !== 'QUALIFIED', cleanupIncomplete: !!outcome.rendererCleanupError || outcome.renderer?.cleanup?.hostShutdownRequired !== false };
          outcome.boundaries = outcome.calls.map(call => ({ index: call.index, mode: call.mode, entries: Object.fromEntries(['commands.openWith', 'workspace.openTextDocument', 'provider.resolveCustomTextEditor'].map(kind => [kind, outcome.observer?.records.filter(entry => entry.kind === kind + '.entry' && entry.uri === call.uri).reduce((count, entry) => count + entry.count, 0) ?? 0])) }));
          outcome.checks.observer = !!outcome.observer && ['lost', 'failures', 'settlementUnavailable', 'restoreFailures'].every(key => outcome.observer[key] === 0) && outcome.observer.unavailable.length === 0 && outcome.observer.pending.length === 0;
          try {
            if (manifest) { assert.deepEqual(verifyBuild(), outcome.build); assert.deepEqual(actualCode(), outcome.actualCode); assert.deepEqual(preset(), outcome.configuration); outcome.checks.frozenBuild = true; }
            if (helper) { assert.equal(hash(fs.readFileSync(outcome.helperPath)), outcome.helperSha256); assert.equal(hash(fs.readFileSync(archive)), outcome.archiveSha256); outcome.checks.immutableInputs = true; }
            if (outcome.loaded) {
              outcome.productLogs = { root: outcome.loaded.logRoot, exists: fs.existsSync(outcome.loaded.logRoot) };
              if (outcome.productLogs.exists) fs.cpSync(outcome.loaded.logRoot, path.join(evidenceRoot, 'product-logs'), { recursive: true, force: false, errorOnExist: true });
            }
          } catch (error) { outcome.errors.push({ phase: 'final-identity', message: String(error?.message ?? error) }); }
          if (outcome.classification === 'PASS' && (outcome.errors.length || !outcome.checks.preservation || outcome.cleanup?.survivors !== 0)) outcome.classification = 'EVIDENCE_OR_CLEANUP_FAILED';
          if (outcome.classification === 'PASS' && !outcome.checks.observer) outcome.classification = 'DIAGNOSTIC_BOUNDARY_UNAVAILABLE';
          write('final-outcome', outcome);
        }
        return outcome;
      })()
      """
    Then I collect JSON artifact "native-open-diagnostic-verdict" from extension host expression:
      """
      (() => { const result = globalThis.__nativeOpenDiagnostic; if (result?.classification !== 'PASS') throw new Error(JSON.stringify({ classification: result?.classification, errors: result?.errors, evidenceRoot: result?.evidenceRoot })); return { classification: result.classification, calls: result.calls, evidenceRoot: result.evidenceRoot }; })()
      """