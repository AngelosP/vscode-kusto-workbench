import * as assert from 'assert';
import * as vscode from 'vscode';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { types as utilTypes } from 'node:util';

import { KqlCompatEditorProvider } from '../../src/host/kqlCompatEditorProvider';
import { KqlxEditorProvider, OwnedDocumentEditTracker } from '../../src/host/kqlxEditorProvider';
import { MdCompatEditorProvider } from '../../src/host/mdCompatEditorProvider';
import { QueryEditorProvider } from '../../src/host/queryEditorProvider';
import { MainWebviewStartupGateway } from '../../src/host/mainWebviewStartupGateway';
import { KustoResultPersistenceRegistry } from '../../src/host/kustoResultPersistenceOwner';
import { KustoAuthPreferenceService } from '../../src/host/kustoAuthPreferenceService';
import { parseKqlxText, stringifyKqlxFile } from '../../src/host/kqlxFormat';
import { SqlCompatEditorProvider } from '../../src/host/sqlCompatEditorProvider';
import { CompatSidecarStore, readCompatSidecarSnapshot } from '../../src/host/compatSidecarStore';
import { CompatSidecarSession } from '../../src/host/compatSidecarSession';
import { CompatSidecarCloseCoordinator } from '../../src/host/compatSidecarCloseCoordinator';
import { CompatSidecarProjectionCoordinator } from '../../src/host/compatSidecarProjectionCoordinator';
import { CompatSidecarPersistCoordinator } from '../../src/host/compatSidecarPersistCoordinator';
import { KustoWorkbenchToolOrchestrator } from '../../src/host/kustoWorkbenchTools';
import { parseCompatibilityPersistenceWebviewMessage } from '../../src/shared/compatibilityPersistenceProtocol';
import { parseDocumentViewHostMessage, parseDocumentViewWebviewMessage } from '../../src/shared/documentViewProtocol';
import { createToolStateResponseMessage } from '../../src/shared/toolStateSnapshotProtocol';
import { normalizeWorkbenchUriKey } from '../../src/host/workbenchFileTypes';
import {
	adaptCompatibilityPersistenceTestPanel,
	adaptMainWebviewStartupTestPanel,
	deferMainWebviewReadyForTest,
	getCompatibilityPersistenceTestBootstrap,
	registerCompatibilityPersistenceTestBootstrap,
} from './mainWebviewStartupTestAdapter';
import { createLiveTextDocumentTestFacade } from './liveTextDocumentTestFacade';

type DisposableLike = { dispose(): void };
function connectionManagerStub(overrides: Record<string, unknown> = {}) {
	const changeEmitter = new vscode.EventEmitter<unknown>();
	const leaveNoTraceSnapshot = {
		clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {},
	};
	return {
		getConnections: () => [],
		addConnection: async () => undefined,
		onDidChangeConnections: changeEmitter.event,
		runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: any) => unknown) => await run(leaveNoTraceSnapshot),
		...overrides,
	} as any;
}

function sqlWorkbenchStub() {
				const posted: any[] = [];
	const ownerSnapshot = {
		policy: { connectionIds: [], version: 0, globallyBlocked: false, revocationGenerations: {} },
		connections: [], connectionVersion: 0,
		accountsByServer: {}, principalVersion: 0,
	};
	return {
		connectionManager: {
			getConnections: () => [], getConnection: () => undefined,
			onDidChangeConnections: () => ({ dispose() {} }),
		},
		client: {},
		runtime: { onDidChangeProcessManager: () => ({ dispose() {} }) },
		queryService: {},
		onDidChangeLeaveNoTrace: () => ({ dispose() {} }),
		onDidChangeSqlPrincipals: () => ({ dispose() {} }),
		getLeaveNoTraceConnectionIds: () => [],
		isLeaveNoTraceConnection: () => false,
		refreshLeaveNoTracePolicy: async () => [],
		assertSqlConnectionAllowed: async () => undefined,
		dispatchSqlOwnerSnapshot: async (dispatch: (snapshot: any) => unknown) => await dispatch(ownerSnapshot),
		runWithSqlOwnerSnapshotLock: async (run: (snapshot: any) => unknown) => await run(ownerSnapshot),
		tryDispatchSqlOwnerSnapshot: async (dispatch: (snapshot: any) => unknown) => ({
			acquired: true, value: await dispatch(ownerSnapshot),
		}),
		tryRunWithSqlOwnerSnapshotLock: async (run: (snapshot: any) => unknown) => ({
			acquired: true, value: await run(ownerSnapshot),
		}),
		retrySqlOwnerSnapshotAcquisition: async (attempt: () => Promise<any>) => {
			const result = await attempt();
			if (!result.acquired) throw new Error('Expected the integration SQL owner snapshot lock to be available.');
			return result.value;
		},
		ready: async () => undefined,
	} as any;
}

function mirrorFreshSqlSanitizerIntoPublisher(): () => void {
	const prototype = (QueryEditorProvider as any).prototype;
	const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
	prototype.publishSqlLeaveNoTraceStateFresh = async function (
		this: QueryEditorProvider,
		state: any,
		publish: (sanitizedState: any) => Promise<unknown>,
		onKustoSanitized?: (before: any, after: any, context: { snapshot: any }) => void,
	) {
		return publish(await (this as any).sanitizeSqlLeaveNoTraceStateFresh(state, onKustoSanitized));
	};
	return () => { prototype.publishSqlLeaveNoTraceStateFresh = originalPublish; };
}

function interceptSqlPersistenceInvalidation() {
	const prototype = (QueryEditorProvider as any).prototype;
	const originalInitialize = prototype.initializeWebviewPanel;
	let listener: (() => void) | undefined;
	let kustoListener: (() => void) | undefined;
	let disposed = false;
	prototype.initializeWebviewPanel = async function (this: QueryEditorProvider, ...args: any[]) {
		const result = await originalInitialize.apply(this, args);
		(this as any).onDidInvalidateSqlPersistence = (next: () => void) => {
			listener = next;
			disposed = false;
			return { dispose: () => { disposed = true; } };
		};
		(this as any).onDidInvalidateKustoPersistence = (next: () => void) => {
			kustoListener = next;
			return { dispose() {} };
		};
		return result;
	};
	return {
		fire: () => {
			if (!listener) throw new Error('SQL persistence invalidation listener was not registered.');
			listener();
		},
		isSubscribed: () => !!listener,
		isKustoSubscribed: () => !!kustoListener,
		isDisposed: () => disposed,
		restore: () => { prototype.initializeWebviewPanel = originalInitialize; },
	};
}

function reloadAwarePostMessage(
	getReceiveHandler: () => ((message: any) => unknown) | undefined,
	posted?: any[],
) {
	return async (message: any) => {
		posted?.push(message);
		if (message?.reloadRequestId) {
			await Promise.resolve(getReceiveHandler()?.({
				type: 'documentReloadResult', requestId: message.reloadRequestId,
				applied: true, editRevision: Number(message.editRevision || 0),
			}));
		}
		return true;
	};
}

const documentViewWebviewMessageTypes = new Set([
	'documentReloadResult',
	'markdownDocumentCommand',
	'markdownDocumentCommandBarrierResult',
]);
const adaptedDocumentViewPanels = new WeakSet<object>();

function adaptKqlxDocumentViewTestPanel(panel: vscode.WebviewPanel): void {
	if (adaptedDocumentViewPanels.has(panel as object)) return;
	adaptedDocumentViewPanels.add(panel as object);
	let envelope: Record<string, unknown> | undefined;
	const webview = panel.webview as any;
	const originalPostMessage = webview.postMessage.bind(webview);
	webview.postMessage = async (message: any) => {
		if (message?.channel === 'document-view') {
			envelope = {
				protocolVersion: message.protocolVersion,
				channel: message.channel,
				viewSessionId: message.viewSessionId,
			};
		}
		return originalPostMessage(message);
	};
	const originalOnDidReceiveMessage = webview.onDidReceiveMessage.bind(webview);
	webview.onDidReceiveMessage = (handler: (message: any) => unknown, ...args: any[]) =>
		originalOnDidReceiveMessage((message: any) => {
			if (!envelope
				|| !documentViewWebviewMessageTypes.has(String(message?.type || ''))
				|| message?.protocolVersion !== undefined
				|| message?.channel !== undefined
				|| message?.viewSessionId !== undefined) return handler(message);
			return handler({ ...envelope, ...message });
		}, ...args);
}

function withProjectedCompatPrimary(
	posted: readonly any[],
	message: any,
	options: { replaceExistingId?: boolean } = {},
): any {
	const sections = Array.isArray(message?.state?.sections) ? message.state.sections : undefined;
	if (!sections?.length) return message;
	if (!options.replaceExistingId && String(sections[0]?.id || '').trim()) return message;
	const projection = [...posted].reverse().find(candidate =>
		candidate?.type === 'documentData' && candidate?.ok === true
		&& Array.isArray(candidate?.state?.sections) && candidate.state.sections.length > 0,
	);
	const projectedPrimary = projection?.state?.sections?.[0];
	const projectedId = String(projectedPrimary?.id || '').trim();
	if (!projectedId) throw new Error('Expected a projected compatibility primary ID before sending test state.');
	return {
		...message,
		state: {
			...message.state,
			sections: [{ ...sections[0], id: projectedId }, ...sections.slice(1)],
		},
	};
}

async function waitForCondition(
	predicate: () => boolean,
	message: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(message);
		await new Promise<void>(resolve => setTimeout(resolve, 25));
	}
}

const createNativeSaveParticipantTrace = (enabled: boolean) => {
	if (!enabled) return undefined;
	type Listener = { listenerId: number; creatorTest: string; start: number; retired: boolean; pending: number };
	type Pending = { kind: string; listenerId: number; invocationId: number; waitId?: number; creatorTest: string; start: number; uriId?: number };
	type Entry = { seq: number; tMs: number; kind: string; creatorTest: string; currentTest: string; listenerId?: number; invocationId?: number; waitId?: number; uriId?: number; status?: string | boolean };
	const limit = 1024, clock = performance.now.bind(performance), intrinsicThen = Promise.prototype.then;
	const intrinsicFunctionToString = Function.prototype.toString;
	const nativePromiseSource = Reflect.apply(intrinsicFunctionToString, Promise, []);
	const nativeSpeciesSource = Reflect.apply(intrinsicFunctionToString, Object.getOwnPropertyDescriptor(Promise, Symbol.species)!.get!, []);
	const listeners = new Map<number, Listener>(), pending = new Map<string, Pending>();
	const subscriptions = new WeakMap<object, number>(), uris = new WeakMap<object, number>(), waitMethods = new WeakMap<Function, Function>();
	const baselineGaps = { preWrapperUnknown: 1, manualDisposeUnknown: 1, timerUnobserved: 1 };
	const cumulativeGaps: Record<string, number> = { ...baselineGaps };
	let listenerId = 0, invocationId = 0, waitId = 0, uriId = 0, seq = 0, testId = 0, testName = '', dropped = 0, cumulativeDropped = 0;
	let entries: Entry[] = [], gaps: Record<string, number> = { ...baselineGaps };
	const gap = (name: string) => { gaps[name] = (gaps[name] ?? 0) + 1; cumulativeGaps[name] = (cumulativeGaps[name] ?? 0) + 1; };
	const safe = (action: () => void) => { try { action(); } catch { gap('observerError'); } };
	const emit = (kind: string, detail: Partial<Entry> = {}) => {
		const entry = { seq: ++seq, tMs: clock(), kind, creatorTest: testName, currentTest: testName, ...detail };
		if (entries.length < limit) entries.push(entry); else { dropped++; cumulativeDropped++; }
	};
	const prune = (listener: Listener) => { if (listener.retired && !listener.pending) listeners.delete(listener.listenerId); };
	const retain = (key: string, value: Pending, listener: Listener) => {
		if (pending.size >= limit) { gap('pendingCapacity'); return false; }
		pending.set(key, value); listener.pending++; return true;
	};
	const release = (key: string, listener: Listener) => { if (pending.delete(key)) listener.pending--; prune(listener); };
	const isNativePromiseConstructor = (value: unknown) => {
		if (typeof value !== 'function' || utilTypes.isProxy(value)
			|| Reflect.apply(intrinsicFunctionToString, value, []) !== nativePromiseSource) return false;
		const prototype = Object.getOwnPropertyDescriptor(value, 'prototype');
		return !!prototype && 'value' in prototype && prototype.writable === false && prototype.configurable === false
			&& prototype.enumerable === false && prototype.value !== null && typeof prototype.value === 'object' && !utilTypes.isProxy(prototype.value);
	};
	const observe = (value: unknown, listener: Listener, invocation: number, uri: number | undefined) => {
		if (!utilTypes.isPromise(value)) { gap('unknownThenable'); return; }
		const prototype = !utilTypes.isProxy(value) && !Object.getOwnPropertyDescriptor(value, 'constructor') ? Object.getPrototypeOf(value) : undefined;
		const constructor = prototype && !utilTypes.isProxy(prototype) ? Object.getOwnPropertyDescriptor(prototype, 'constructor') : undefined;
		const nativeConstructor = constructor && 'value' in constructor && isNativePromiseConstructor(constructor.value)
			&& Object.getOwnPropertyDescriptor(constructor.value, 'prototype')!.value === prototype ? constructor.value : undefined;
		const species = nativeConstructor ? Object.getOwnPropertyDescriptor(nativeConstructor, Symbol.species) : undefined;
		const supported = species && ('value' in species
			? species.value === null || species.value === undefined || isNativePromiseConstructor(species.value)
			: typeof species.get === 'function' && !utilTypes.isProxy(species.get) && species.set === undefined
				&& Reflect.apply(intrinsicFunctionToString, species.get, []) === nativeSpeciesSource);
		if (!supported) { gap('unsupportedPromise'); return; }
		const wait = ++waitId, key = `wait:${wait}`;
		const detail = { listenerId: listener.listenerId, invocationId: invocation, waitId: wait, creatorTest: listener.creatorTest, uriId: uri };
		if (!retain(key, { kind: 'waitUntil', ...detail, start: clock() }, listener)) return;
		const settled = (status: string) => safe(() => { emit('waitUntil.settled', { ...detail, status }); release(key, listener); });
		try {
			Reflect.apply(intrinsicThen, value, [() => settled('fulfilled'), () => settled('rejected')]);
			emit('waitUntil.accepted', detail);
		} catch { release(key, listener); gap('promiseObservationFailed'); }
	};
	return {
		beginTest(name: string) { safe(() => { testId++; testName = name; }); },
		record(kind: string, status?: boolean) { safe(() => emit(kind, { status: typeof status === 'boolean' ? status : undefined })); },
		wrap(register: (...args: any[]) => vscode.Disposable, kind: 'willSave' | 'didSave') {
			return function (this: unknown, ...args: any[]) {
				const handler = args[0];
				let listener: Listener | undefined;
				safe(() => {
					if (typeof handler !== 'function') { gap('callbackShape'); return; }
					if (listeners.size >= limit) { gap('listenerCapacity'); return; }
					listener = { listenerId: ++listenerId, creatorTest: testName, start: clock(), retired: false, pending: 0 };
					listeners.set(listener.listenerId, listener);
				});
				if (!listener) return Reflect.apply(register, this, args);
				const owner = listener;
				const callback = function (this: unknown, ...callbackArgs: any[]) {
					const invocation = ++invocationId, key = `callback:${invocation}`;
					let restore: (() => void) | undefined, status = 'threw';
					const detail = { listenerId: owner.listenerId, invocationId: invocation, creatorTest: owner.creatorTest, uriId: undefined as number | undefined };
					safe(() => {
						const event = callbackArgs[0], uri = kind === 'willSave' ? event?.document?.uri : event?.uri;
						if (uri && typeof uri === 'object') { if (!uris.has(uri)) uris.set(uri, ++uriId); detail.uriId = uris.get(uri); }
						retain(key, { kind, ...detail, start: clock() }, owner);
						emit('callback.enter', detail);
						if (kind !== 'willSave') return;
						const descriptor = Object.getOwnPropertyDescriptor(event, 'waitUntil');
						if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function'
							|| !(descriptor.writable || descriptor.configurable)) { gap('waitUntilDescriptor'); return; }
						const original = waitMethods.get(descriptor.value) ?? descriptor.value;
						const wait = function (this: unknown, ...waitArgs: any[]) {
							const result = Reflect.apply(original, this, waitArgs);
							safe(() => observe(waitArgs[0], owner, invocation, detail.uriId));
							return result;
						};
						waitMethods.set(wait, original);
						const installedDescriptor = { ...descriptor, value: wait };
						Object.defineProperty(event, 'waitUntil', installedDescriptor);
						restore = () => {
							const current = Object.getOwnPropertyDescriptor(event, 'waitUntil');
							if (current && (['configurable', 'enumerable', 'writable', 'value', 'get', 'set'] as const).every(field =>
								Object.hasOwn(current, field) === Object.hasOwn(installedDescriptor, field) && current[field] === installedDescriptor[field])) {
								Object.defineProperty(event, 'waitUntil', descriptor);
							}
							else gap('waitUntilReplaced');
						};
					});
					try { const result = Reflect.apply(handler, this, callbackArgs); status = 'returned'; return result; }
					finally {
						safe(() => restore?.());
						safe(() => { emit('callback.exit', { ...detail, status }); release(key, owner); });
					}
				};
				try {
					const subscription = Reflect.apply(register, this, [callback, ...args.slice(1)]);
					safe(() => { subscriptions.set(subscription, owner.listenerId); emit('listener.registered', { listenerId: owner.listenerId, creatorTest: owner.creatorTest }); });
					return subscription;
				} catch (error) { safe(() => { owner.retired = true; prune(owner); }); throw error; }
			};
		},
		retire(subscription: vscode.Disposable) {
			safe(() => {
				const listener = listeners.get(subscriptions.get(subscription)!);
				if (listener) { listener.retired = true; emit('listener.retired', { listenerId: listener.listenerId, creatorTest: listener.creatorTest }); prune(listener); }
			});
		},
		flush() {
			const batch = { version: 1, testId, testName, entries, outstanding: [...pending.values()].map(value => ({ ...value, retired: listeners.get(value.listenerId)?.retired ?? true })),
				dropped, gaps: { ...gaps }, cumulativeDropped, cumulativeGaps: { ...cumulativeGaps } };
			entries = []; dropped = 0; testName = ''; gaps = { ...baselineGaps };
			return batch;
		},
	};
};

suite('Sidecar .kql.json strategy', () => {
	const originalInitializeWebviewPanel = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
	const originalResolveKqlxEditor = (KqlxEditorProvider as any).prototype.resolveCustomTextEditor;
	const originalResolveKqlCompatEditor = (KqlCompatEditorProvider as any).prototype.resolveCustomTextEditor;
	const originalResolveSqlCompatEditor = (SqlCompatEditorProvider as any).prototype.resolveCustomTextEditor;
	const originalHandle = (QueryEditorProvider as any).prototype.handleWebviewMessage;
	const originalInfer = (QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery;
	const originalOnDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument;
	const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
	const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
	const workspaceSubscriptions: vscode.Disposable[] = [];
	const liveDocuments = createLiveTextDocumentTestFacade();
	const nativeSaveTrace = createNativeSaveParticipantTrace(process.env.KW_NATIVE_SAVE_PARTICIPANT_TRACE === '1');
	const trackWorkspaceEvent = (register: (...args: any[]) => vscode.Disposable, kind?: 'willSave' | 'didSave') => {
		const observed = kind ? nativeSaveTrace?.wrap(register, kind) ?? register : register;
		return (...args: any[]) => {
			const subscription = observed.apply(vscode.workspace, args);
			workspaceSubscriptions.push(subscription);
			return subscription;
		};
	};

	setup(function () { nativeSaveTrace?.beginTest(this.currentTest?.fullTitle() ?? ''); });

	suiteSetup(() => {
		liveDocuments.install();
		(KqlxEditorProvider as any).prototype.resolveCustomTextEditor = function (
			this: KqlxEditorProvider,
			document: vscode.TextDocument,
			panel: vscode.WebviewPanel,
			token: vscode.CancellationToken,
		) {
			adaptMainWebviewStartupTestPanel(panel);
			adaptKqlxDocumentViewTestPanel(panel);
			liveDocuments.register(document);
			return originalResolveKqlxEditor.call(this, document, panel, token);
		};
		(KqlCompatEditorProvider as any).prototype.resolveCustomTextEditor = function (
			this: KqlCompatEditorProvider,
			document: vscode.TextDocument,
			panel: vscode.WebviewPanel,
			token: vscode.CancellationToken,
		) {
			adaptMainWebviewStartupTestPanel(panel);
			adaptCompatibilityPersistenceTestPanel(panel);
			liveDocuments.register(document);
			return originalResolveKqlCompatEditor.call(this, document, panel, token);
		};
		(SqlCompatEditorProvider as any).prototype.resolveCustomTextEditor = function (
			this: SqlCompatEditorProvider,
			document: vscode.TextDocument,
			panel: vscode.WebviewPanel,
			token: vscode.CancellationToken,
		) {
			adaptMainWebviewStartupTestPanel(panel);
			adaptCompatibilityPersistenceTestPanel(panel);
			liveDocuments.register(document);
			return originalResolveSqlCompatEditor.call(this, document, panel, token);
		};
		(QueryEditorProvider as any).prototype.initializeWebviewPanel = async (
			panel: vscode.WebviewPanel,
			options: any,
		) => {
			registerCompatibilityPersistenceTestBootstrap(panel, options?.compatibilityPersistence);
			// no-op
		};
		(QueryEditorProvider as any).prototype.handleWebviewMessage = async () => {
			// no-op
		};
		(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = async () => undefined;
		(vscode.workspace as any).onDidChangeTextDocument = trackWorkspaceEvent(originalOnDidChangeTextDocument as any);
		(vscode.workspace as any).onWillSaveTextDocument = trackWorkspaceEvent(originalOnWillSaveTextDocument as any, 'willSave');
		(vscode.workspace as any).onDidSaveTextDocument = trackWorkspaceEvent(originalOnDidSaveTextDocument as any, 'didSave');
	});

	teardown(() => {
		for (const subscription of workspaceSubscriptions.splice(0)) {
			try { subscription.dispose(); nativeSaveTrace?.retire(subscription); } catch { /* ignore */ }
		}
		liveDocuments.clear();
		if (nativeSaveTrace) {
			try { console.log('[kw-native-save-participants]' + JSON.stringify(nativeSaveTrace.flush())); } catch { /* diagnostic only */ }
		}
	});

	suiteTeardown(() => {
		liveDocuments.dispose();
		(KqlxEditorProvider as any).prototype.resolveCustomTextEditor = originalResolveKqlxEditor;
		(KqlCompatEditorProvider as any).prototype.resolveCustomTextEditor = originalResolveKqlCompatEditor;
		(SqlCompatEditorProvider as any).prototype.resolveCustomTextEditor = originalResolveSqlCompatEditor;
		(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitializeWebviewPanel;
		(QueryEditorProvider as any).prototype.handleWebviewMessage = originalHandle;
		(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = originalInfer;
		(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChangeTextDocument;
		(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
		(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
	});

	test('retired owned edit cancellation preserves a later identical edit registration', () => {
		const tracker = new OwnedDocumentEditTracker();
		const cancelFirst = tracker.begin('same source');
		assert.strictEqual(tracker.observe('same source'), true);
		const cancelSecond = tracker.begin('same source');
		cancelFirst();
		assert.strictEqual(tracker.observe('same source'), true);
		cancelSecond();
		assert.strictEqual(tracker.observe('same source'), false);
		const cancelThird = tracker.begin('same source');
		tracker.begin('same source');
		cancelThird();
		assert.strictEqual(tracker.observe('same source'), true);
		assert.strictEqual(tracker.observe('same source'), false);
	});

	test('opening .kql uses linked sibling .kql.json sidecar when present', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');
		const kqlxPath = path.join(tmpDir, 'test.kql.json');

		try {
			fs.writeFileSync(kqlPath, 'MyTable | take 5', 'utf8');
			fs.writeFileSync(
				kqlxPath,
				JSON.stringify({
					kind: 'kqlx',
					version: 1,
					state: {
						sections: [
							{ type: 'query', linkedQueryPath: 'test.kql' },
							{ type: 'markdown', title: 'Notes', text: 'hello' }
						]
					}
				}),
				'utf8'
			);

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any
			} as any;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'MyTable | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'MyTable | take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				}
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				visible: true,
				onDidDispose: () => ({ dispose() {} } as DisposableLike),
				onDidChangeViewState: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler, 'expected webview message handler');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const docMsg = posted.find((m) => m && m.type === 'documentData');
			assert.ok(docMsg, 'expected a documentData message');
			assert.strictEqual(docMsg.compatibilityMode, false);
			assert.ok(docMsg.state && Array.isArray(docMsg.state.sections));
			assert.strictEqual(docMsg.state.sections[0].type, 'query');
			assert.strictEqual(docMsg.state.sections[0].query, 'MyTable | take 5');
			assert.strictEqual(docMsg.state.sections[1].type, 'markdown');
		} finally {
			// best-effort cleanup
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('KQL companion close materializes a committed Run All result when confirmation persistence is lost', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kql-companion-run-all-'));
		const kqlPath = path.join(tmpDir, 'test.kql');
		const sidecarPath = path.join(tmpDir, 'test.kql.json');
		const queryText = 'print First=1; print Second=2';
		fs.writeFileSync(kqlPath, queryText, 'utf8');
		fs.writeFileSync(sidecarPath, JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'compat_primary_query', type: 'query', linkedQueryPath: 'test.kql', runMode: 'runAll',
			}] },
		}), 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		let blockCloseRepair = false;
		let closeRepairBlocked = false;
		let markCloseRepairStarted!: () => void;
		let releaseCloseRepair!: () => void;
		const closeRepairStarted = new Promise<void>(resolve => { markCloseRepairStarted = resolve; });
		const closeRepairGate = new Promise<void>(resolve => { releaseCloseRepair = resolve; });
		try {
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				if (blockCloseRepair && !closeRepairBlocked) {
					closeRepairBlocked = true;
					markCloseRepairStarted();
					await closeRepairGate;
				}
				return publish(state);
			};
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlCompatEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, undefined, undefined, undefined, resultRegistry,
			) as KqlCompatEditorProvider;
			const document = {
				uri: vscode.Uri.file(kqlPath), getText: () => queryText, isDirty: false,
				lineCount: 1, lineAt: () => ({ text: queryText } as any),
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				visible: false,
				onDidChangeViewState: () => ({ dispose() {} }),
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const projection = posted.find(message => message?.type === 'documentData' && message.ok === true);
			const boxId = String(projection?.state?.sections?.[0]?.id || '');
			assert.ok(boxId);
			const owner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!owner) throw new Error('KQL companion result owner was not created.');
			const session = owner.openPanel('companion-run-all-result-test');
			session.openSection(boxId, 'companion-run-all-instance');
			session.adoptTarget({
				boxId, sectionInstanceId: 'companion-run-all-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const,
				boxId, sectionInstanceId: 'companion-run-all-instance', targetGeneration: 1,
				executionId: 'companion-run-all-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: queryText, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'companion-run-all',
				},
				result: {
					columns: ['First'], rows: [[1]], metadata: {}, additionalResults: {
						version: 1,
						sets: [{ resultIndex: 1, columns: ['Second'], rows: [[2]], metadata: {} }],
					},
				},
			};
			assert.strictEqual(session.beginExecution(terminal), true);
			assert.ok(session.stagePublication('companion-run-all-publication', terminal));
			assert.strictEqual(session.commitPublication('companion-run-all-publication'), true);

			blockCloseRepair = true;
			for (const dispose of disposeHandlers) dispose();
			await closeRepairStarted;
			const rapidReopenLease = resultRegistry.acquire(normalizeWorkbenchUriKey(document.uri));
			assert.strictEqual(
				rapidReopenLease.owner,
				owner,
				'Rapid reopen must share the committed result owner until companion repair completes',
			);
			rapidReopenLease.release();
			releaseCloseRepair();
			await waitForCondition(() => {
				const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
				return !!sidecar.state.sections[0]?.resultJson;
			}, 'KQL companion Run All result should reach sidecar bytes');
		} finally {
			releaseCloseRepair?.();
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const scenario of [
		{ name: 'preserves resolved matching', accountResolved: true, resultKind: 'matching' },
		{ name: 'preserves unresolved matching', accountResolved: false, resultKind: 'matching' },
		{ name: 'preserves mismatched', accountResolved: true, resultKind: 'mismatched' },
		{ name: 'preserves malformed', accountResolved: true, resultKind: 'malformed' },
	] as const) {
		test(`${scenario.name} legacy Kusto results in native KQLX and KQL sidecars`, async () => {
			const originalApplyEdit = vscode.workspace.applyEdit;
			const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
			let completedPublications = 0;
			let activeDocumentUri = '';
			let activeDocumentText = '';
			let activeDocumentVersion = 1;
			let activeDocumentDirty = false;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kw-legacy-result-${scenario.resultKind}-`));
			const connection = {
				id: 'legacy-owner', name: 'Legacy owner', clusterUrl: 'https://legacy.kusto.windows.net',
			};
			const accountId = 'legacy-account';
			const resultJson = scenario.resultKind === 'malformed'
				? '{"rows":'
				: JSON.stringify({
					columns: [{ name: 'Value', type: 'long' }], rows: [[42]],
					metadata: {
						cluster: scenario.resultKind === 'mismatched' ? 'other' : 'legacy', database: 'Db',
					},
				});

			try {
				(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async function (
					this: QueryEditorProvider,
					state: any,
					publish: (sanitizedState: any) => Promise<unknown>,
				) {
					try {
						return await originalPublish.call(this, state, publish);
					} finally {
						completedPublications++;
					}
				};
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const entry = edit.entries().find(([uri]) => uri.toString() === activeDocumentUri);
					const replacement = entry?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return originalApplyEdit.call(vscode.workspace, edit);
					activeDocumentText = replacement;
					activeDocumentVersion++;
					activeDocumentDirty = true;
					return true;
				};

				for (const variant of ['native', 'sidecar'] as const) {
					let receiveHandler: ((message: any) => unknown) | undefined;
					const posted: any[] = [];
					const primaryPath = path.join(tmpDir, `${variant}.kql`);
					const persistedPath = variant === 'native'
						? path.join(tmpDir, `${variant}.kqlx`)
						: path.join(tmpDir, `${variant}.kql.json`);
					const section = {
						id: variant === 'native' ? 'legacy_native' : 'compat_primary_query',
						type: 'query' as const,
						...(variant === 'native' ? { query: 'print Value=42' } : { linkedQueryPath: `${variant}.kql` }),
						clusterUrl: connection.clusterUrl,
						connectionIdHint: connection.id,
						database: 'Db',
						resultJson,
					};
					const originalBytes = stringifyKqlxFile({
						kind: 'kqlx', version: 1, state: { sections: [section] },
					});
					if (variant === 'sidecar') fs.writeFileSync(primaryPath, 'print Value=42', 'utf8');
					fs.writeFileSync(persistedPath, originalBytes, 'utf8');

					const preferences = scenario.accountResolved
						? { [connection.id]: { mode: 'automatic', lastSuccessfulAccountId: accountId } }
						: undefined;
					const context = {
						subscriptions: [],
						workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: {
							get: (key: string) => key === 'kusto.auth.connectionPreferences.v1' ? preferences : undefined,
							update: async () => undefined,
						},
						globalStorageUri: vscode.Uri.file(tmpDir),
					} as any;
					const accountPartition = KustoAuthPreferenceService.getInstance(context)
						.getAccountPartition(undefined, accountId);
					const provider = variant === 'native'
						? new (KqlxEditorProvider as any)(
							context, vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
							connectionManagerStub({ getConnections: () => [connection] }), sqlWorkbenchStub(),
						) as KqlxEditorProvider
						: new (KqlCompatEditorProvider as any)(
							context, vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
							connectionManagerStub({ getConnections: () => [connection] }), sqlWorkbenchStub(),
						) as KqlCompatEditorProvider;
					activeDocumentText = variant === 'native' ? originalBytes : 'print Value=42';
					activeDocumentUri = vscode.Uri.file(variant === 'native' ? persistedPath : primaryPath).toString();
					activeDocumentVersion = 1;
					activeDocumentDirty = false;
					const document = {
						uri: vscode.Uri.file(variant === 'native' ? persistedPath : primaryPath),
						getText: () => activeDocumentText,
						get version() { return activeDocumentVersion; },
						get isDirty() { return activeDocumentDirty; },
						eol: vscode.EndOfLine.LF,
						positionAt: (_offset: number) => new vscode.Position(0, 0),
						save: async () => {
							if (variant === 'native') fs.writeFileSync(persistedPath, activeDocumentText, 'utf8');
							activeDocumentDirty = false;
							return true;
						},
						lineCount: 1,
						lineAt: () => ({ text: 'print Value=42' }),
					} as any;
					const panel = {
						visible: true,
						webview: {
							options: {},
							postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
							onDidReceiveMessage: (handler: (message: any) => unknown) => {
								receiveHandler = handler;
								return { dispose() {} };
							},
						},
						onDidDispose: () => ({ dispose() {} }),
						onDidChangeViewState: () => ({ dispose() {} }),
					} as any;

					await provider.resolveCustomTextEditor(document, panel, {} as any);
					assert.ok(receiveHandler, `expected ${variant} message handler`);
					await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
					await new Promise<void>(resolve => setImmediate(resolve));

					const persistedBytes = fs.readFileSync(persistedPath, 'utf8');
					const persistedSection = JSON.parse(persistedBytes).state.sections[0];
					assert.strictEqual(persistedSection.resultJson, resultJson);
					const projection = [...posted].reverse().find(message => message?.type === 'documentData' && message.ok === true);
					assert.ok(projection, `expected ${variant} document projection`);
					const projectedSection = projection.state.sections[0];
					assert.strictEqual(projectedSection.resultJson, resultJson);
					assert.strictEqual(persistedBytes, originalBytes);
					assert.ok(!Object.prototype.hasOwnProperty.call(persistedSection, 'kustoAccountPartition'));
					assert.ok(!Object.prototype.hasOwnProperty.call(persistedSection, 'kustoLeaveNoTraceRevision'));
					assert.ok(!Object.prototype.hasOwnProperty.call(projectedSection, 'kustoAccountPartition'));
					assert.ok(!Object.prototype.hasOwnProperty.call(projectedSection, 'kustoLeaveNoTraceRevision'));
				}
			} finally {
				(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
				(vscode.workspace as any).applyEdit = originalApplyEdit;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});
	}

	test('known-incompatible KQL and SQL companions open read-only without overwrite or byte changes', async () => {
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-incompatible-'));
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, primaryText: 'print primary = 1',
				sidecarKind: 'mdx', requestType: 'requestUpgradeToKqlx', invalidId: 'query_invalid_kql',
				sections: [
					{ id: 'query_invalid_kql', type: 'query', linkedQueryPath: 'sample-0.kql' },
					{ id: 'future_kql', type: 'future-section', payload: { keep: true } },
				],
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryText: 'SELECT 1',
				sidecarKind: 'kqlx', requestType: 'requestUpgradeToSqlx', invalidId: 'query_invalid_sql',
				sections: [
					{ id: 'sql_primary', type: 'sql', linkedQueryPath: 'sample-1.sql' },
					{ id: 'query_invalid_sql', type: 'query', query: 'print 1' },
					{ id: 'future_sql', type: 'future-section', payload: { keep: true } },
				],
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryText: 'SELECT 2',
				sidecarKind: 'sqlx', requestType: 'requestUpgradeToSqlx', invalidId: 'linkedQueryPath',
				sections: [
					{ id: 'sql_malformed', type: 'sql', linkedQueryPath: ['sample-2.sql'] },
					{ id: 'future_sql_malformed', type: 'future-section', payload: { keep: true } },
				],
			},
		] as const;
		const informationMessages: string[] = [];
		const warningMessages: string[] = [];
		const errorMessages: string[] = [];

		try {
			(vscode.window as any).showInformationMessage = async (message: unknown) => { informationMessages.push(String(message)); return undefined; };
			(vscode.window as any).showWarningMessage = async (message: unknown) => { warningMessages.push(String(message)); return undefined; };
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errorMessages.push(String(message)); return undefined; };

			for (const [index, variant] of variants.entries()) {
				const primaryPath = path.join(tmpDir, `sample-${index}${variant.extension}`);
				const sidecarPath = `${primaryPath}.json`;
				const sidecarText = JSON.stringify({
					kind: variant.sidecarKind, version: 1, futureRoot: { keep: index },
					state: { futureState: 'opaque', sections: variant.sections },
				}, null, 2) + '\n';
				fs.writeFileSync(primaryPath, variant.primaryText, 'utf8');
				fs.writeFileSync(sidecarPath, sidecarText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(primaryPath), getText: () => variant.primaryText, lineCount: 1,
					lineAt: () => ({ text: variant.primaryText }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const documentDataMessages = posted.filter(message => message?.type === 'documentData');
				assert.strictEqual(
					documentDataMessages.length,
					1,
					`${variant.extension} incompatible companion should apply one stable error projection`,
				);
				const documentData = documentDataMessages[0];
				const persistenceMode = posted.filter(message => message?.type === 'persistenceMode').at(-1);
				assert.strictEqual(documentData?.ok, false);
				assert.ok(String(documentData?.error || '').includes(variant.invalidId));
				assert.deepStrictEqual(persistenceMode?.allowedSectionKinds, []);
				assert.strictEqual(persistenceMode?.firstSectionPinned, false);
				assert.strictEqual(persistenceMode?.documentMutationAllowed, false);
				assert.strictEqual(documentData?.documentMutationAllowed, false);
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `forged-snapshot-${index}`, editRevision: 1,
					state: { sections: [{
						type: variant.extension === '.sql' ? 'sql' : 'query', query: 'FORGED PRIMARY MUTATION',
					}] },
				}));
				await Promise.resolve(receiveHandler!({ type: variant.requestType, addKind: 'markdown', editRevision: 0 }));
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
					&& message?.snapshotId === `forged-snapshot-${index}`));
				assert.strictEqual(fs.readFileSync(primaryPath, 'utf8'), variant.primaryText);
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), sidecarText);
			}

			assert.deepStrictEqual(informationMessages, []);
			assert.deepStrictEqual(warningMessages, []);
			assert.strictEqual(errorMessages.length, variants.length);
		} finally {
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('plain KQL and SQL projections pin their primary before tool or UI removal', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-plain-primary-pin-'));
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, primaryText: 'print 1', documentKind: 'kql' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, primaryText: 'SELECT 1', documentKind: 'sql' },
		] as const;
		try {
			for (const [index, variant] of variants.entries()) {
				const primaryPath = path.join(tmpDir, `plain-${index}${variant.extension}`);
				fs.writeFileSync(primaryPath, variant.primaryText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-plain-pin-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(primaryPath), getText: () => variant.primaryText, lineCount: 1,
					lineAt: () => ({ text: variant.primaryText }), eol: vscode.EndOfLine.LF, isDirty: false,
					save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const persistenceMode = posted.filter(message => message?.type === 'persistenceMode').at(-1);
				const documentData = posted.filter(message => message?.type === 'documentData').at(-1);
				assert.deepStrictEqual(persistenceMode && {
					documentKind: persistenceMode.documentKind,
					compatibilityMode: persistenceMode.compatibilityMode,
					firstSectionPinned: persistenceMode.firstSectionPinned,
					documentMutationAllowed: persistenceMode.documentMutationAllowed,
				}, {
					documentKind: variant.documentKind, compatibilityMode: true,
					firstSectionPinned: true, documentMutationAllowed: true,
				});
				assert.strictEqual(documentData?.firstSectionPinned, true);
				assert.strictEqual(documentData?.documentMutationAllowed, true);
			}
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('plain KQL and SQL reject forged section-zero replacement before source edits', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-plain-primary-forged-'));
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, primaryText: 'print primary = 1',
				primaryKind: 'query', forgedKind: 'markdown', forgedText: 'print forged = 2',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryText: 'SELECT 1',
				primaryKind: 'sql', forgedKind: 'markdown', forgedText: 'SELECT 2',
			},
		] as const;

		try {
			for (const [index, variant] of variants.entries()) {
				const primaryPath = path.join(tmpDir, `plain-forged-${index}${variant.extension}`);
				fs.writeFileSync(primaryPath, variant.primaryText, 'utf8');
				let primaryText: string = variant.primaryText;
				let applyEditCalls = 0;
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-plain-forged-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(primaryPath), getText: () => primaryText, isDirty: false, save: async () => true,
					get lineCount() { return primaryText.split(/\r?\n/).length; },
					lineAt: (line: number) => ({ text: primaryText.split(/\r?\n/)[line] || '' }), eol: vscode.EndOfLine.LF,
				} as any;
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const entry = edit.entries()[0];
					if (entry?.[0]?.toString() === document.uri.toString()) {
						applyEditCalls++;
						primaryText = String(entry[1]?.[0]?.newText ?? primaryText);
						return true;
					}
					return originalApplyEdit(edit);
				};
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const documentData = posted.filter(message => message?.type === 'documentData').at(-1);
				const sourceGeneration = Number(documentData?.sourceGeneration);
				assert.ok(Number.isSafeInteger(sourceGeneration));
				const projectedPrimary = documentData?.state?.sections?.[0];
				assert.strictEqual(projectedPrimary?.type, variant.primaryKind);
				assert.ok(String(projectedPrimary?.id || '').startsWith('compat_primary_'));
				applyEditCalls = 0;
				const snapshotId = `plain-forged-${index}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId, sourceGeneration, editRevision: 1,
					state: { sections: [{
						id: 'forged_secondary', type: variant.forgedKind, query: variant.forgedText,
					}] },
				}));

				assert.strictEqual(applyEditCalls, 0);
				assert.strictEqual(primaryText, variant.primaryText);
				assert.strictEqual(fs.readFileSync(primaryPath, 'utf8'), variant.primaryText);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message?.snapshotId === snapshotId));

				const extraSnapshotId = `plain-extra-${index}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: extraSnapshotId, sourceGeneration, editRevision: 2,
					state: { sections: [
						{ id: projectedPrimary.id, type: variant.primaryKind, query: variant.forgedText },
						{ id: 'discarded_markdown', type: 'markdown', text: 'must not disappear' },
					] },
				}));
				assert.strictEqual(applyEditCalls, 0);
				assert.strictEqual(primaryText, variant.primaryText);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
					&& message?.snapshotId === extraSnapshotId));
				assert.ok(!fs.existsSync(`${primaryPath}.json`));

				const validText = variant.primaryKind === 'sql' ? 'SELECT 3' : 'print valid = 3';
				const validSnapshotId = `plain-valid-${index}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: validSnapshotId, sourceGeneration, editRevision: 3,
					state: { sections: [{
						id: projectedPrimary.id, type: variant.primaryKind, query: validText,
					}] },
				}));

				assert.strictEqual(applyEditCalls, 1);
				assert.strictEqual(primaryText, validText);
				assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
					&& message?.snapshotId === validSnapshotId));
				assert.strictEqual(fs.readFileSync(primaryPath, 'utf8'), variant.primaryText,
					'WorkspaceEdit must not bypass the normal VS Code save boundary');
			}
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('valid KQL and SQL companions reject forged invalid snapshots before mutating either file', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-forged-invalid-'));
		const variants = [
			{
				name: 'SQL incompatible section', extension: '.sql', Provider: SqlCompatEditorProvider,
				kind: 'sqlx', primaryKind: 'sql', primaryText: 'SELECT 1', forgedText: 'SELECT 999',
				extraSections: [{ id: 'query_in_sql', type: 'query', query: 'print 1' }],
			},
			{
				name: 'duplicate section IDs', extension: '.kql', Provider: KqlCompatEditorProvider,
				kind: 'kqlx', primaryKind: 'query', primaryText: 'print primary = 2', forgedText: 'print forged = 2',
				primaryId: 'duplicate', extraSections: [{ id: 'duplicate', type: 'markdown', text: 'duplicate' }],
			},
			{
				name: 'malformed known field', extension: '.kql', Provider: KqlCompatEditorProvider,
				kind: 'kqlx', primaryKind: 'query', primaryText: 'print primary = 3', forgedText: 'print forged = 3',
				extraSections: [{ id: 'chart_malformed', type: 'chart', yColumns: [null] }],
			},
			{
				name: 'removed KQL primary owner', extension: '.kql', Provider: KqlCompatEditorProvider,
				kind: 'kqlx', primaryKind: 'query', primaryText: 'print primary = 4', forgedText: 'print secondary = 4',
				baselineExtraSections: [{ id: 'secondary_query', type: 'query' }],
				forgedSections: [{ id: 'secondary_query', type: 'query', query: 'print secondary = 4' }],
				extraSections: [],
			},
			{
				name: 'removed SQL primary owner', extension: '.sql', Provider: SqlCompatEditorProvider,
				kind: 'sqlx', primaryKind: 'sql', primaryText: 'SELECT 4', forgedText: 'SELECT 444',
				baselineExtraSections: [{ id: 'secondary_sql', type: 'sql' }],
				forgedSections: [{ id: 'secondary_sql', type: 'sql', query: 'SELECT 444' }],
				extraSections: [],
			},
		] as const;

		try {
			(vscode.window as any).showErrorMessage = async () => undefined;
			for (const [index, variant] of variants.entries()) {
				const primaryPath = path.join(tmpDir, `valid-${index}${variant.extension}`);
				const sidecarPath = `${primaryPath}.json`;
				const primaryId = 'primaryId' in variant ? variant.primaryId : `primary_${index}`;
				const sidecarText = stringifyKqlxFile({
					kind: variant.kind, version: 1, state: { sections: [
						{ id: primaryId, type: variant.primaryKind, linkedQueryPath: path.basename(primaryPath) },
						...('baselineExtraSections' in variant ? variant.baselineExtraSections : []),
					] },
				} as any);
				let primaryText: string = variant.primaryText;
				let applyEditCalls = 0;
				fs.writeFileSync(primaryPath, variant.primaryText, 'utf8');
				fs.writeFileSync(sidecarPath, sidecarText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-forged-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(primaryPath), getText: () => primaryText, isDirty: false, save: async () => true,
					get lineCount() { return primaryText.split(/\r?\n/).length; },
					lineAt: (line: number) => ({ text: primaryText.split(/\r?\n/)[line] || '' }),
					eol: vscode.EndOfLine.LF,
				} as any;
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const entry = edit.entries()[0];
					if (entry?.[0]?.toString() === document.uri.toString()) {
						applyEditCalls++;
						primaryText = String(entry[1]?.[0]?.newText ?? primaryText);
						return true;
					}
					return originalApplyEdit(edit);
				};
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				applyEditCalls = 0;
				const snapshotId = `forged-valid-${index}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId, editRevision: 1,
					state: { sections: 'forgedSections' in variant ? variant.forgedSections : [
						{ id: primaryId, type: variant.primaryKind, query: variant.forgedText },
						...variant.extraSections,
					] },
				}));

				assert.strictEqual(applyEditCalls, 0, `${variant.name}: primary edit must not be attempted`);
				assert.strictEqual(primaryText, variant.primaryText, `${variant.name}: in-memory primary changed`);
				assert.strictEqual(fs.readFileSync(primaryPath, 'utf8'), variant.primaryText, `${variant.name}: primary bytes changed`);
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), sidecarText, `${variant.name}: sidecar bytes changed`);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message?.snapshotId === snapshotId),
					`${variant.name}: forged snapshot was acknowledged`);
			}
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('legacy id-less KQL and SQL companions reject secondary primary substitution byte-exact', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-idless-primary-'));
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, kind: 'kqlx', primaryKind: 'query',
				primaryText: 'print primary = 1', forgedText: 'print secondary = 2',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, kind: 'sqlx', primaryKind: 'sql',
				primaryText: 'SELECT 1', forgedText: 'SELECT 2',
			},
		] as const;

		try {
			(vscode.window as any).showErrorMessage = async () => undefined;
			for (const [index, variant] of variants.entries()) {
				const primaryPath = path.join(tmpDir, `idless-${index}${variant.extension}`);
				const sidecarPath = `${primaryPath}.json`;
				const legacySidecarText = stringifyKqlxFile({
					kind: variant.kind, version: 1, state: { sections: [
						{ type: variant.primaryKind, linkedQueryPath: path.basename(primaryPath) },
						{ type: variant.primaryKind },
					] },
				} as any);
				let primaryText: string = variant.primaryText;
				let applyEditCalls = 0;
				fs.writeFileSync(primaryPath, variant.primaryText, 'utf8');
				fs.writeFileSync(sidecarPath, legacySidecarText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-idless-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(primaryPath), getText: () => primaryText, isDirty: false, save: async () => true,
					get lineCount() { return primaryText.split(/\r?\n/).length; },
					lineAt: (line: number) => ({ text: primaryText.split(/\r?\n/)[line] || '' }), eol: vscode.EndOfLine.LF,
				} as any;
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const entry = edit.entries()[0];
					if (entry?.[0]?.toString() === document.uri.toString()) {
						applyEditCalls++;
						primaryText = String(entry[1]?.[0]?.newText ?? primaryText);
						return true;
					}
					return originalApplyEdit(edit);
				};
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projection = posted.filter(message => message?.type === 'documentData' && message?.ok === true).at(-1);
				const bootstrap = getCompatibilityPersistenceTestBootstrap(panel);
				assert.ok(projection && bootstrap);
				const acceptedSidecarText = fs.readFileSync(sidecarPath, 'utf8');
				applyEditCalls = 0;
				const snapshotId = `idless-forged-${index}`;
				await Promise.resolve(receiveHandler!({
					...bootstrap,
					type: 'persistDocument', snapshotId, editRevision: 1,
					sourceGeneration: projection.sourceGeneration,
					state: { sections: [{ type: variant.primaryKind, query: variant.forgedText }] },
				}));

				assert.strictEqual(applyEditCalls, 0);
				assert.strictEqual(primaryText, variant.primaryText);
				assert.strictEqual(fs.readFileSync(primaryPath, 'utf8'), variant.primaryText);
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), acceptedSidecarText);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message?.snapshotId === snapshotId));
			}
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility upgrades validate forged state before creating or overwriting companions', async () => {
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-forged-upgrade-'));
		const variants = [
			{
				name: 'SQL absent companion', extension: '.sql', Provider: SqlCompatEditorProvider,
				requestType: 'requestUpgradeToSqlx', primaryKind: 'sql', kind: 'sqlx', primaryText: 'SELECT 1',
				extraSections: [{ id: 'query_in_sql', type: 'query', query: 'print 1' }], existingUnlinked: false,
			},
			{
				name: 'KQL unlinked companion', extension: '.kql', Provider: KqlCompatEditorProvider,
				requestType: 'requestUpgradeToKqlx', primaryKind: 'query', kind: 'kqlx', primaryText: 'print 1',
				extraSections: [{ id: 'duplicate', type: 'markdown', text: 'duplicate' }], existingUnlinked: true,
			},
		] as const;

		try {
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			(vscode.window as any).showWarningMessage = async () => 'Overwrite sidecar';
			(vscode.window as any).showErrorMessage = async () => undefined;
			for (const [index, variant] of variants.entries()) {
				const primaryPath = path.join(tmpDir, `upgrade-invalid-${index}${variant.extension}`);
				const sidecarPath = `${primaryPath}.json`;
				const existingText = variant.existingUnlinked ? stringifyKqlxFile({
					kind: variant.kind, version: 1, state: { sections: [{
						id: 'existing_primary', type: variant.primaryKind, linkedQueryPath: `other-${index}${variant.extension}`,
					}] },
				} as any) : undefined;
				fs.writeFileSync(primaryPath, variant.primaryText, 'utf8');
				if (existingText !== undefined) fs.writeFileSync(sidecarPath, existingText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-upgrade-invalid-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(primaryPath), getText: () => variant.primaryText, lineCount: 1,
					lineAt: () => ({ text: variant.primaryText }), eol: vscode.EndOfLine.LF, isDirty: false,
					save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const primaryId = variant.existingUnlinked ? 'duplicate' : 'primary';
				await Promise.resolve(receiveHandler!({
					type: variant.requestType, addKind: 'markdown', editRevision: 0,
					state: { sections: [
						{ id: primaryId, type: variant.primaryKind, query: variant.primaryText },
						...variant.extraSections,
					] },
				}));

				assert.strictEqual(fs.readFileSync(primaryPath, 'utf8'), variant.primaryText, `${variant.name}: primary bytes changed`);
				if (existingText === undefined) assert.ok(!fs.existsSync(sidecarPath), `${variant.name}: invalid sidecar was created`);
				else assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), existingText, `${variant.name}: sidecar bytes changed`);
				assert.ok(!posted.some(message => message?.type === 'enabledKqlxSidecar' || message?.type === 'enabledSqlSidecar'),
					`${variant.name}: invalid upgrade was enabled`);
			}
		} finally {
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('persistDocument updates sidecar .kql.json without duplicating query', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let onDidSaveHandler: ((doc: vscode.TextDocument) => unknown) | undefined;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');
		const kqlxPath = path.join(tmpDir, 'test.kql.json');
		let primaryText = 'StormEvents | take 1';

		const originalOnDidSave = (vscode.workspace as any).onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		try {
			// Capture the save handler registered by the provider so we can simulate a save.
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				onDidSaveHandler = handler;
				return { dispose() {} } as DisposableLike;
			};

			fs.writeFileSync(kqlPath, primaryText, 'utf8');
			// Pre-create a linked sidecar so the compat editor enters sidecar mode without prompting.
			fs.writeFileSync(
				kqlxPath,
				JSON.stringify({
					kind: 'kqlx',
					version: 1,
					state: { sections: [{ type: 'query', linkedQueryPath: 'test.kql' }] }
				}),
				'utf8'
			);

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any
			} as any;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => primaryText,
				isDirty: false,
				save: async () => true,
				lineCount: 1,
				lineAt: () => ({ text: primaryText } as any)
			} as any;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				if (entry?.[0]?.toString() === document.uri.toString()) {
					primaryText = String(entry[1]?.[0]?.newText ?? primaryText);
					return true;
				}
				return originalApplyEdit(edit);
			};

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				}
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				visible: true,
				onDidDispose: () => ({ dispose() {} } as DisposableLike),
				onDidChangeViewState: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await Promise.resolve(
				receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument',
					state: {
						sections: [
							{ type: 'query', query: 'StormEvents | take 2' },
							{ type: 'markdown', title: 'Notes', text: 'hello' }
						]
					}
				}))
			);

			// Sidecar changes are deferred until the user saves the .kql document.
			const beforeSaveSidecarText = fs.readFileSync(kqlxPath, 'utf8');
			assert.ok(!beforeSaveSidecarText.includes('"markdown"'), 'expected sidecar not to be updated until save');

			assert.ok(onDidSaveHandler, 'expected onDidSaveTextDocument handler to be registered');
			await Promise.resolve(onDidSaveHandler!(document));

			const newSidecarText = fs.readFileSync(kqlxPath, 'utf8');
			assert.ok(newSidecarText.includes('"linkedQueryPath"'));
			assert.ok(!newSidecarText.includes('"query":'), 'expected no inline query text in sidecar');
			assert.ok(newSidecarText.includes('"markdown"'));
		} finally {
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			// best-effort cleanup
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('creating sidecar preserves selected cluster/db and persisted results', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');
		const kqlxPath = path.join(tmpDir, 'test.kql.json');
		fs.writeFileSync(kqlPath, 'StormEvents | take 1', 'utf8');

		const originalShowInfo = (vscode.window as any).showInformationMessage;
		try {
			// Auto-accept the modal prompt.
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			const selectedClusterUrl = 'https://example.kusto.windows.net';
			const selectedConnection = { id: 'kusto-public', name: 'Public', clusterUrl: selectedClusterUrl };
			const selectedAccountId = 'account-public';

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => key === 'kusto.auth.connectionPreferences.v1'
						? { [selectedConnection.id]: { mode: 'automatic', lastSuccessfulAccountId: selectedAccountId } }
						: undefined,
					update: async () => undefined,
				} as any,
			} as any;
			const accountPartition = KustoAuthPreferenceService.getInstance(fakeContext)
				.getAccountPartition(undefined, selectedAccountId);

			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub({ getConnections: () => [selectedConnection] }),
				sqlWorkbenchStub(),
				undefined,
				undefined,
				undefined,
				undefined,
				resultRegistry,
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'StormEvents | take 1',
				isDirty: false,
				save: async () => true,
				lineCount: 1,
				lineAt: () => ({ text: 'StormEvents | take 1' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				}
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				visible: true,
				onDidDispose: () => ({ dispose() {} } as DisposableLike),
				onDidChangeViewState: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const selectedDatabase = 'MyDb';
			const resultObj = { columns: [{ name: 'x', type: 'int' }], rows: [[1]] };
			const resultJson = JSON.stringify(resultObj);
			const persistedState = {
				sections: [
					{
						type: 'query',
						id: 'compat_primary_query',
						favoritesMode: true,
						query: 'StormEvents | take 1',
						clusterUrl: selectedClusterUrl,
						connectionIdHint: selectedConnection.id,
						database: selectedDatabase,
						resultJson,
						kustoAccountPartition: accountPartition,
						kustoLeaveNoTraceRevision: 0,
					},
				],
			};

			await Promise.resolve(
				receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument',
					state: persistedState,
				}, { replaceExistingId: true }))
			);
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(resultOwner);
			resultOwner.admitCanonicalSource('sidecar-host-owned-result', persistedState);

			await Promise.resolve(receiveHandler!({ type: 'requestUpgradeToKqlx', addKind: 'chart', editRevision: 0 }));

			const sidecarText = fs.readFileSync(kqlxPath, 'utf8');
			assert.ok(sidecarText.includes('"linkedQueryPath"'));
			assert.ok(sidecarText.includes(selectedClusterUrl));
			assert.ok(sidecarText.includes(selectedDatabase));
			assert.ok(sidecarText.includes('"resultJson"'));
			assert.ok(sidecarText.includes('"favoritesMode"'));
			assert.ok(!sidecarText.includes('"query":'), 'expected no inline query text in sidecar');
		} finally {
			(vscode.window as any).showInformationMessage = originalShowInfo;
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('upgrading to sidecar right after execution preserves host-owned results with fresh editor state', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');
		const kqlxPath = path.join(tmpDir, 'test.kql.json');
		fs.writeFileSync(kqlPath, 'StormEvents | take 1', 'utf8');

		const originalShowInfo = (vscode.window as any).showInformationMessage;
		try {
			// Auto-accept the modal prompt.
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			const selectedClusterUrl = 'https://example.kusto.windows.net';
			const selectedConnection = { id: 'kusto-public', name: 'Public', clusterUrl: selectedClusterUrl };
			const selectedAccountId = 'account-public';

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => key === 'kusto.auth.connectionPreferences.v1'
						? { [selectedConnection.id]: { mode: 'automatic', lastSuccessfulAccountId: selectedAccountId } }
						: undefined,
					update: async () => undefined,
				} as any,
			} as any;
			const accountPartition = KustoAuthPreferenceService.getInstance(fakeContext)
				.getAccountPartition(undefined, selectedAccountId);

			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub({ getConnections: () => [selectedConnection] }),
				sqlWorkbenchStub(),
				undefined, undefined, undefined, undefined, resultRegistry,
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'StormEvents | take 1',
				isDirty: false,
				save: async () => true,
				lineCount: 1,
				lineAt: () => ({ text: 'StormEvents | take 1' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				}
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				visible: true,
				onDidDispose: () => ({ dispose() {} } as DisposableLike),
				onDidChangeViewState: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// Simulate: results are visible in the UI but the debounced persistDocument hasn't fired yet.
			// The webview now includes a full state snapshot in the upgrade request.
			const selectedDatabase = 'MyDb';
			const resultObj = { columns: [{ name: 'x', type: 'int' }], rows: [[1]] };
			const resultJson = JSON.stringify(resultObj);
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(resultOwner);
			resultOwner.admitCanonicalSource('immediate-upgrade-host-result', {
				sections: [{
					type: 'query', id: 'compat_primary_query', resultJson,
					clusterUrl: selectedClusterUrl, connectionIdHint: selectedConnection.id,
					database: selectedDatabase,
					kustoAccountPartition: accountPartition, kustoLeaveNoTraceRevision: 0,
				}],
			});

			await Promise.resolve(
				receiveHandler!({
					type: 'requestUpgradeToKqlx',
					addKind: 'chart',
					editRevision: 0,
					state: {
						sections: [
							{
								type: 'query',
								id: 'compat_primary_query',
								query: 'StormEvents | take 1',
								clusterUrl: selectedClusterUrl,
								connectionIdHint: selectedConnection.id,
								database: selectedDatabase,
							}
						]
					}
				})
			);

			const sidecarText = fs.readFileSync(kqlxPath, 'utf8');
			assert.ok(sidecarText.includes('"linkedQueryPath"'));
			assert.ok(sidecarText.includes(selectedClusterUrl));
			assert.ok(sidecarText.includes(selectedDatabase));
			assert.ok(sidecarText.includes('"resultJson"'));
			assert.ok(!sidecarText.includes('"query":'), 'expected no inline query text in sidecar');
		} finally {
			(vscode.window as any).showInformationMessage = originalShowInfo;
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('persistDocument with only cluster/database change should not dirty a .kql file without companion', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const appliedEdits: vscode.WorkspaceEdit[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = (vscode.workspace as any).onDidChangeTextDocument;
		try {
			// Track edits applied by the extension.
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				appliedEdits.push(edit);
				return true;
			};
			(vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} } as DisposableLike);

			fs.writeFileSync(kqlPath, 'StormEvents | take 5', 'utf8');

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any
			} as any;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'StormEvents | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'StormEvents | take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; }
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// Simulate: user picks a cluster and database, but query text is unchanged.
			await Promise.resolve(
				receiveHandler!({
					type: 'persistDocument',
					state: {
						sections: [{
							type: 'query',
							query: 'StormEvents | take 5',
							clusterUrl: 'https://example.kusto.windows.net',
							database: 'MyDb'
						}]
					}
				})
			);

			assert.strictEqual(appliedEdits.length, 0, 'no edit should be applied when only cluster/database changed');
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('persistDocument with only EOL difference should not dirty a .kql file without companion', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const appliedEdits: vscode.WorkspaceEdit[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = (vscode.workspace as any).onDidChangeTextDocument;
		try {
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				appliedEdits.push(edit);
				return true;
			};
			(vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} } as DisposableLike);

			// File on disk has CRLF line endings (typical Windows).
			fs.writeFileSync(kqlPath, 'StormEvents\r\n| take 5', 'utf8');

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any
			} as any;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			// Simulate TextDocument with CRLF.
			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'StormEvents\r\n| take 5',
				lineCount: 2,
				lineAt: (line: number) => ({ text: line === 0 ? 'StormEvents' : '| take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; }
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// Monaco normalizes CRLF to LF. The persist sends LF-only text.
			await Promise.resolve(
				receiveHandler!({
					type: 'persistDocument',
					state: {
						sections: [{
							type: 'query',
							query: 'StormEvents\n| take 5'  // LF only (Monaco normalization)
						}]
					}
				})
			);

			assert.strictEqual(appliedEdits.length, 0, 'no edit should be applied for EOL-only difference');
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('persistDocument should never replace non-empty .kql content with empty text', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const appliedEdits: vscode.WorkspaceEdit[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = (vscode.workspace as any).onDidChangeTextDocument;
		try {
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				appliedEdits.push(edit);
				return true;
			};
			(vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} } as DisposableLike);

			fs.writeFileSync(kqlPath, 'StormEvents | take 5', 'utf8');

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any
			} as any;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'StormEvents | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'StormEvents | take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; }
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// Simulate: webview sends empty query (e.g., Monaco not loaded yet, race condition).
			await Promise.resolve(
				receiveHandler!({
					type: 'persistDocument',
					state: {
						sections: [{
							type: 'query',
							query: '',
							clusterUrl: 'https://example.kusto.windows.net',
							database: 'MyDb'
						}]
					}
				})
			);

			assert.strictEqual(appliedEdits.length, 0, 'should never replace non-empty content with empty text');
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('.kqlx-format .kql.json with linkedQueryPath hydrates query text from linked file', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const linkedKqlPath = path.join(tmpDir, 'test.kql');
		const kqlxPath = path.join(tmpDir, 'test.kql.json');

		try {
			fs.writeFileSync(linkedKqlPath, 'StormEvents | take 10', 'utf8');
			fs.writeFileSync(
				kqlxPath,
				JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', linkedQueryPath: 'test.kql' }] } }),
				'utf8'
			);

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any,
				globalStorageUri: vscode.Uri.file('C:/tmp')
			} as any;

			const provider = new (KqlxEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub()
			) as KqlxEditorProvider;

			const kqlxText = fs.readFileSync(kqlxPath, 'utf8');
			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlxPath),
				getText: () => kqlxText,
				eol: vscode.EndOfLine.LF
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				}
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			const token: vscode.CancellationToken = {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, token);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const docMsg = posted.find((m) => m && m.type === 'documentData' && m.ok === true);
			assert.ok(docMsg);
			assert.strictEqual(docMsg.state.sections[0].query, 'StormEvents | take 10');
			const generatedId = String(docMsg.state.sections[0].id || '');
			assert.ok(generatedId, 'id-less section should receive a projected ID');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const documentMessages = posted.filter((message) => message?.type === 'documentData' && message.ok === true);
			assert.strictEqual(
				documentMessages.at(-1)?.state.sections[0].id,
				generatedId,
				'repeated projection of the same raw revision must reuse the generated section ID',
			);
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('unchanged projected native sections never materialize on a persist echo', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-projected-noop-'));
		const originalApplyEdit = vscode.workspace.applyEdit;
		try {
			for (const [index, sections] of [
				[],
				[{ type: 'query', query: 'print Historical=1' }],
			].entries()) {
				const notebookPath = path.join(tmpDir, `historical-${index}.kqlx`);
				const originalText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } });
				fs.writeFileSync(notebookPath, originalText, 'utf8');
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(notebookPath));
				let applyEditCalls = 0;
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					if (edit.entries().some(([uri]) => uri.toString() === document.uri.toString())) applyEditCalls++;
					return originalApplyEdit(edit);
				};
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projection = [...posted].reverse().find(message => message?.type === 'documentData' && message.ok === true);
				assert.ok(projection);
				assert.strictEqual(projection.state.sections.length, 1);
				assert.ok(String(projection.state.sections[0].id || '').startsWith('section_'));
				const snapshotId = `native-projected-noop-${index}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId, editRevision: 1,
					sourceGeneration: projection.sourceGeneration, state: projection.state,
				}));
				await waitForCondition(
					() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === snapshotId),
					'unmodified projected native state should acknowledge without an edit',
				);
				assert.strictEqual(applyEditCalls, 0, 'opening an ID-less notebook must not apply an edit');
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(document.getText(), originalText);
				assert.strictEqual(fs.readFileSync(notebookPath, 'utf8'), originalText);
			}
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked CRLF query stays clean for EOL-only persistence and accepts subsequent edits', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-crlf-'));
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const notebookPath = path.join(tmpDir, 'linked.kqlx');
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		try {
			fs.writeFileSync(linkedPath, 'StormEvents\r\n| take 5', 'utf8');
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			const notebookDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(notebookPath));
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(notebookDocument, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const activeProjection = () => [...posted].reverse().find(message => message?.type === 'documentData');

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'linked-crlf-5', editRevision: 1,
				sourceGeneration: activeProjection().sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'StormEvents\n| take 5' },
				] },
			}));
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'linked-crlf-5'),
				'linked CRLF no-op persistence should acknowledge',
			);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'StormEvents\r\n| take 5');
			const linkedUri = vscode.Uri.file(linkedPath);
			const residentLinkedDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === linkedUri.toString());
			if (residentLinkedDocument) {
				assert.strictEqual(residentLinkedDocument.isDirty, false, 'EOL-only persistence must not dirty a resident linked document');
				assert.strictEqual(
					residentLinkedDocument.getText().replace(/\r\n?/g, '\n'),
					'StormEvents\n| take 5',
					'EOL-only persistence must preserve equivalent linked-buffer text',
				);
			}

			for (const [index, count] of [6, 7].entries()) {
				const snapshotId = `linked-crlf-${count}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId, editRevision: index + 2,
					sourceGeneration: activeProjection().sourceGeneration, state: { sections: [
						{ id: 'query_1', type: 'query', query: `StormEvents\n| take ${count}` },
					] },
				}));
				await waitForCondition(
					() => posted.some(message => message?.type === 'persistDocumentAck'
						&& message.snapshotId === snapshotId),
					`linked edit ${count} should acknowledge`,
				);
				const linkedDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(linkedPath));
				await waitForCondition(() => linkedDocument.getText().includes(`take ${count}`), `linked edit ${count} should apply`);
			}
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linkedQueryPath remains owned by its section when opaque content precedes it', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-opaque-'));
		const linkedKqlPath = path.join(tmpDir, 'linked.kql');
		const kqlxPath = path.join(tmpDir, 'session.kqlx');

		try {
			fs.writeFileSync(linkedKqlPath, 'StormEvents | take 17', 'utf8');
			const kqlxText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'future_1', type: 'future-section', payload: { keep: true } },
					{ id: 'query_linked', type: 'copilotQuery', linkedQueryPath: 'linked.kql' },
					{ id: 'query_other', type: 'query', query: 'print other = 1' },
				] },
			});
			fs.writeFileSync(kqlxPath, kqlxText, 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(kqlxPath));

			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [],
					workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file('C:/tmp'),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const webview = {
				options: {},
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				},
			} as any;
			const panel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const documentData = posted.find(message => message?.type === 'documentData' && message.ok === true);
			assert.ok(documentData);
			assert.strictEqual(documentData.state.sections[0].id, 'future_1');
			assert.strictEqual(documentData.state.sections[1].id, 'query_linked');
			assert.strictEqual(documentData.state.sections[1].query, 'StormEvents | take 17');
			assert.strictEqual(documentData.state.sections[2].query, 'print other = 1');
			const activeProjection = () => posted.filter(message => message?.type === 'documentData').at(-1);

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'opaque-linked-update', editRevision: 1,
				sourceGeneration: activeProjection().sourceGeneration,
				state: { sections: [
					{ id: 'query_other', type: 'query', query: 'print other = 99' },
					{ id: 'query_linked', type: 'query', query: 'StormEvents | take 23' },
				] },
			}));
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'opaque-linked-update'),
				'opaque linked-query update should acknowledge',
			);

			const linkedDocument = vscode.workspace.textDocuments.find(candidate =>
				candidate.uri.toString() === vscode.Uri.file(linkedKqlPath).toString(),
			);
			assert.ok(linkedDocument);
			assert.strictEqual(linkedDocument.getText(), 'StormEvents | take 23');
			const persisted = JSON.parse(fs.readFileSync(kqlxPath, 'utf8'));
			assert.ok(persisted.state.sections.some((section: any) => section.id === 'future_1'));
			const persistedLinked = persisted.state.sections.find((section: any) => section.id === 'query_linked');
			assert.strictEqual(persistedLinked.linkedQueryPath, 'linked.kql');
			assert.strictEqual(persistedLinked.query, undefined);

			const externalEdit = new vscode.WorkspaceEdit();
			externalEdit.replace(
				linkedDocument.uri,
				new vscode.Range(linkedDocument.positionAt(0), linkedDocument.positionAt(linkedDocument.getText().length)),
				'StormEvents | take 999',
			);
			assert.strictEqual(await vscode.workspace.applyEdit(externalEdit), true);
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'opaque-linked-conflict', editRevision: 2,
				sourceGeneration: activeProjection().sourceGeneration,
				state: { sections: [
					{ id: 'query_other', type: 'query', query: 'print other = 100' },
					{ id: 'query_linked', type: 'query', query: 'StormEvents | take 31' },
				] },
			}));
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'opaque-linked-conflict'));
			assert.strictEqual(linkedDocument.getText(), 'StormEvents | take 999');
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('unsafe linked query introduced after open is rejected before linked I/O', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-unsafe-reload-'));
		const filePath = path.join(tmpDir, 'reload.kqlx');
		let documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ id: 'query_1', type: 'query', query: 'print safe = 1' }] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		try {
			fs.writeFileSync(filePath, documentText, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [],
					workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => documentText, eol: vscode.EndOfLine.LF,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(posted.some(message => message?.type === 'documentData' && message.ok === true));

			documentText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [{ id: 'query_1', type: 'query', linkedQueryPath: 'reload.kqlx' }] },
			});
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const latest = posted.filter(message => message?.type === 'documentData').at(-1);
			assert.strictEqual(latest?.ok, false);
			assert.match(String(latest?.error || ''), /cannot target the notebook itself/);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8').includes('print safe'), true);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('missing linked query cannot overwrite a file that appears before reload', async function () {
		this.timeout(5_000);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-missing-link-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'recovered.kql');
		const documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'recovered.kql' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		try {
			fs.writeFileSync(filePath, documentText, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor({
				uri: vscode.Uri.file(filePath), getText: () => documentText, eol: vscode.EndOfLine.LF,
			} as any, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			fs.writeFileSync(linkedPath, 'RECOVERED_SENTINEL', 'utf8');

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'missing-link-appeared', sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'not allowed' }] },
			}));

			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'missing-link-appeared'));
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'RECOVERED_SENTINEL');
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked write remains blocked after failed document hydration until reload', async () => {
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-delayed-linked-open-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'old.kql');
		const documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'old.kql' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let openAttempts = 0;
		let applyEditCalls = 0;
		const applyEdit = async () => { applyEditCalls++; return true; };

		try {
			fs.writeFileSync(filePath, documentText, 'utf8');
			fs.writeFileSync(linkedPath, 'OLD_BASELINE', 'utf8');
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
				if (uri.toString() !== vscode.Uri.file(linkedPath).toString()) return originalOpenTextDocument(uri);
				openAttempts++;
				throw new Error('linked document unavailable');
			};
			(vscode.workspace as any).applyEdit = applyEdit;
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => documentText, eol: vscode.EndOfLine.LF,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'failed-hydration-stale', sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'STALE_WRITE' }] },
			}));

			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'failed-hydration-stale'));
			assert.strictEqual(openAttempts, 1, 'unowned persistence must not retry document hydration');
			assert.strictEqual(applyEditCalls, 0, 'stale linked write must not reach applyEdit');
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'OLD_BASELINE');
		} finally {
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked write rolls back when ownership changes during delayed applyEdit', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-delayed-linked-apply-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const oldLinkedPath = path.join(tmpDir, 'old.kql');
		const newLinkedPath = path.join(tmpDir, 'new.kql');
		const notebook = (target: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: target },
			] },
		}, null, 2) + '\n';
		let documentText = notebook('old.kql');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let markApplyStarted!: () => void;
		let releaseApply!: () => void;
		const applyStarted = new Promise<void>(resolve => { markApplyStarted = resolve; });
		const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
		let delayOldApply = true;
		let rejectFirstRollback = true;
		const appliedTexts: string[] = [];

		try {
			fs.writeFileSync(filePath, documentText, 'utf8');
			fs.writeFileSync(oldLinkedPath, 'OLD_BASELINE', 'utf8');
			fs.writeFileSync(newLinkedPath, 'NEW_BASELINE', 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => documentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const activeProjection = () => posted.filter(message => message?.type === 'documentData').at(-1);

			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const target = edit.entries()[0]?.[0];
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement === 'string') appliedTexts.push(replacement);
				if (delayOldApply && target?.toString() === vscode.Uri.file(oldLinkedPath).toString()) {
					delayOldApply = false;
					markApplyStarted();
					await applyGate;
				}
				if (rejectFirstRollback && target?.toString() === vscode.Uri.file(oldLinkedPath).toString()
					&& replacement === 'OLD_BASELINE' && oldLinkedDocumentForTest?.getText() === 'STALE_WRITE') {
					rejectFirstRollback = false;
					return false;
				}
				return originalApplyEdit(edit);
			};
			const oldLinkedDocumentForTest = vscode.workspace.textDocuments.find(candidate =>
				candidate.uri.toString() === vscode.Uri.file(oldLinkedPath).toString(),
			);
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'delayed-old-target', editRevision: 1,
				sourceGeneration: activeProjection().sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'STALE_WRITE' },
				] },
			}));
			await Promise.race([
				applyStarted,
				stalePersist.then(
					() => { throw new Error('stale linked persist settled before applying'); },
					error => { throw error; },
				),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stale linked apply did not start')), 2_000)),
			]);
			documentText = notebook('new.kql');
			await Promise.race([
				Promise.resolve(receiveHandler!({ type: 'requestDocument' })),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('retarget reload did not settle')), 2_000)),
			]);
			releaseApply();
			await Promise.race([
				stalePersist,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stale linked persist did not settle')), 2_000)),
			]);

			const oldLinkedDocument = vscode.workspace.textDocuments.find(candidate =>
				candidate.uri.toString() === vscode.Uri.file(oldLinkedPath).toString(),
			);
			assert.ok(oldLinkedDocument);
			assert.strictEqual(oldLinkedDocument.getText(), 'OLD_BASELINE', `rollback buffer dirty=${oldLinkedDocument.isDirty}; edits=${JSON.stringify(appliedTexts)}`);
			assert.strictEqual(oldLinkedDocument.isDirty, false, 'stale rollback must not leave the old target dirty');
			assert.strictEqual(rejectFirstRollback, false, 'stale rollback should retry one rejected edit');
			assert.strictEqual(fs.readFileSync(oldLinkedPath, 'utf8'), 'OLD_BASELINE');
			const newTargetSnapshotId = 'delayed-new-target';
			await Promise.race([
				Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: newTargetSnapshotId, editRevision: 2,
					sourceGeneration: activeProjection().sourceGeneration, state: { sections: [
						{ id: 'query_1', type: 'query', query: 'NEW_WRITE' },
					] },
				})),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('new-target linked persist did not settle')), 2_000)),
			]);
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === newTargetSnapshotId),
				'new-target linked persistence should acknowledge',
			);
			assert.strictEqual(fs.readFileSync(oldLinkedPath, 'utf8'), 'OLD_BASELINE');
			const newLinkedDocument = vscode.workspace.textDocuments.find(candidate =>
				candidate.uri.toString() === vscode.Uri.file(newLinkedPath).toString(),
			);
			assert.ok(newLinkedDocument);
			assert.strictEqual(newLinkedDocument.getText(), 'NEW_WRITE');
		} finally {
			releaseApply();
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('stale linked rollback never overwrites a same-path physical replacement', async function () {
		this.timeout(5_000);
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-stale-rollback-retarget-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const displacedPath = path.join(tmpDir, 'linked-original.kql');
		let notebookText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
		] } }, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let releaseApply!: () => void;
		let markApplyStarted!: () => void;
		const applyStarted = new Promise<void>(resolve => { markApplyStarted = resolve; });
		const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, 'BASELINE', 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global')) } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = { uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF, positionAt: () => new vscode.Position(0, 0), isDirty: false } as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (replacement === 'STALE') {
					markApplyStarted();
					await applyGate;
					const applied = await originalApplyEdit(edit);
					fs.renameSync(linkedPath, displacedPath);
					fs.writeFileSync(linkedPath, 'EXTERNAL_REPLACEMENT', 'utf8');
					return applied;
				}
				return originalApplyEdit(edit);
			};
			const sourceGeneration = posted.find(message => message?.type === 'documentData')?.sourceGeneration;
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'physical-replacement-stale', editRevision: 1,
				sourceGeneration, state: { sections: [{ id: 'query_1', type: 'query', query: 'STALE' }] },
			}));
			await applyStarted;
			notebookText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id: 'query_1', type: 'query', query: 'DETACHED' }] } });
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			releaseApply();
			await stalePersist;
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'EXTERNAL_REPLACEMENT');
			assert.strictEqual(fs.readFileSync(displacedPath, 'utf8'), 'BASELINE');
		} finally {
			releaseApply();
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save fails when the final snapshot is unavailable', async () => {
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-snapshot-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const documentUri = vscode.Uri.file(notebookPath);
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		const willSaveHandlers: Array<(event: any) => unknown> = [];
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, 'BASELINE', 'utf8');
			(vscode.window as any).showErrorMessage = async () => undefined;
			const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandlers.push(handler);
				return { dispose() {} };
			};
			try {
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				const document = {
					uri: documentUri, getText: () => notebookText, eol: vscode.EndOfLine.LF,
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return message?.type !== 'requestFinalPersist';
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				assert.ok(willSaveHandlers.length > 0);
				const waited: Promise<unknown>[] = [];
				const event = { document, waitUntil: (value: Promise<unknown>) => { waited.push(Promise.resolve(value)); } };
				for (const handler of willSaveHandlers) handler(event);
				assert.ok(waited.length > 0, 'native Save should contribute a preparation barrier');
				await assert.rejects(
					Promise.all(waited),
					/Cannot save a linked-query notebook without its final editor snapshot/,
				);
				assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'BASELINE');
			} finally {
				(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			}
		} finally {
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(documentUri, 2_000);
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save rejects a final snapshot from the previous target generation', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-retarget-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedAPath = path.join(tmpDir, 'a.kql');
		const linkedBPath = path.join(tmpDir, 'b.kql');
		const notebook = (target: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: target },
			] },
		});
		let notebookText = notebook('a.kql');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let finalRequestId = '';
		let finalRequestSourceGeneration = 0;
		let markFinalRequested!: () => void;
		const finalRequested = new Promise<void>(resolve => { markFinalRequested = resolve; });
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedAPath, 'A_BASELINE', 'utf8');
			fs.writeFileSync(linkedBPath, 'B_BASELINE', 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalRequestId = String(message.requestId || '');
							finalRequestSourceGeneration = sourceGeneration;
							markFinalRequested();
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(willSaveHandler);
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Thenable<vscode.TextEdit[]>) => { waited = Promise.resolve(value); } });
			await finalRequested;

			notebookText = notebook('b.kql');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', flushRequestId: finalRequestId, snapshotId: 'stale-final', editRevision: 1,
				sourceGeneration: finalRequestSourceGeneration,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'A_STALE' }] },
			}));

			await assert.rejects(waited!, /target changed while Save was waiting/);
			assert.strictEqual(fs.readFileSync(linkedAPath, 'utf8'), 'A_BASELINE');
			assert.strictEqual(fs.readFileSync(linkedBPath, 'utf8'), 'B_BASELINE');
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save rejects after the retargeted document fails to open', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-retarget-open-failure-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedAPath = path.join(tmpDir, 'a.kql');
		const linkedBPath = path.join(tmpDir, 'b.kql');
		const notebook = (target: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: target },
			] },
		}, null, 2) + '\n';
		let notebookText = notebook('a.kql');
		let linkedAText = 'A_BASELINE';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let finalPersistRequests = 0;
		let linkedApplyCalls = 0;
		const linkedAUri = vscode.Uri.file(linkedAPath);
		const linkedBUri = vscode.Uri.file(linkedBPath);
		const linkedADocument = {
			uri: linkedAUri, getText: () => linkedAText,
			positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedAPath, linkedAText, 'utf8');
			fs.writeFileSync(linkedBPath, 'B_BASELINE', 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
				if (uri.toString() === linkedAUri.toString()) return linkedADocument;
				if (uri.toString() === linkedBUri.toString()) throw new Error('retargeted document open failed');
				return originalOpenTextDocument(uri);
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				if (entry?.[0]?.toString() === linkedAUri.toString()
					|| entry?.[0]?.toString() === linkedBUri.toString()) linkedApplyCalls++;
				return originalApplyEdit(edit);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalPersistRequests++;
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'failed-retarget-open', sourceGeneration,
								editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'STALE_A_QUERY' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			notebookText = notebook('b.kql');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			assert.ok(willSaveHandler);
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			await assert.rejects(waited!, /linked query file could not be updated/);
			assert.strictEqual(finalPersistRequests, 0, 'failed retarget hydration must reject before final persistence');
			assert.strictEqual(linkedApplyCalls, 0, 'failed retarget hydration must not edit either target');
			assert.strictEqual(linkedAText, 'A_BASELINE');
			assert.strictEqual(fs.readFileSync(linkedAPath, 'utf8'), 'A_BASELINE');
			assert.strictEqual(fs.readFileSync(linkedBPath, 'utf8'), 'B_BASELINE');
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save rolls back a durable write when the target retargets during save', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFsOpen = fs.promises.open;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-durable-save-retarget-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedAPath = path.join(tmpDir, 'a.kql');
		const linkedBPath = path.join(tmpDir, 'b.kql');
		const notebook = (target: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: target },
			] },
		});
		let notebookText = notebook('a.kql');
		let linkedAText = 'A_BASELINE';
		let linkedBText = 'B_BASELINE';
		let linkedADirty = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let markLinkedSaveStarted!: () => void;
		let releaseLinkedSave!: () => void;
		const linkedSaveStarted = new Promise<void>(resolve => { markLinkedSaveStarted = resolve; });
		const linkedSaveGate = new Promise<void>(resolve => { releaseLinkedSave = resolve; });
		const linkedAUri = vscode.Uri.file(linkedAPath);
		const linkedBUri = vscode.Uri.file(linkedBPath);
		const linkedADocument = {
			uri: linkedAUri, getText: () => linkedAText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			get isDirty() { return linkedADirty; },
			save: async () => true,
		} as any;
		const linkedBDocument = {
			uri: linkedBUri, getText: () => linkedBText,
			positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			save: async () => true,
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedAPath, linkedAText, 'utf8');
			fs.writeFileSync(linkedBPath, linkedBText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
				if (uri.toString() === linkedAUri.toString()) return linkedADocument;
				if (uri.toString() === linkedBUri.toString()) return linkedBDocument;
				return originalOpenTextDocument(uri);
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (entry[0].toString() === linkedAUri.toString()) {
					linkedAText = replacement;
					linkedADirty = true;
					return true;
				}
				if (entry[0].toString() === linkedBUri.toString()) {
					linkedBText = replacement;
					return true;
				}
				return false;
			};
			(fs.promises as any).open = async (target: fs.PathLike, flags: string, ...args: any[]) => {
				if (path.resolve(String(target)).toLowerCase() === path.resolve(linkedAPath).toLowerCase() && flags === 'r+') {
					markLinkedSaveStarted();
					await linkedSaveGate;
				}
				return (originalFsOpen as any)(target, flags, ...args);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = message.sourceGeneration;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'durable-retarget', sourceGeneration,
								editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'A_CANDIDATE' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(willSaveHandler);
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			await linkedSaveStarted;

			notebookText = notebook('b.kql');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			releaseLinkedSave();

			await assert.rejects(waited!, /target changed during durable Save/);
			assert.strictEqual(linkedAText, 'A_BASELINE');
			assert.strictEqual(linkedBText, 'B_BASELINE');
			assert.strictEqual(fs.readFileSync(linkedAPath, 'utf8'), 'A_BASELINE');
			assert.strictEqual(fs.readFileSync(linkedBPath, 'utf8'), 'B_BASELINE');
		} finally {
			releaseLinkedSave();
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(fs.promises as any).open = originalFsOpen;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const fixture of [
		{ name: 'same-length immediate', candidate: 'print Value=2', delayMs: 0 },
		{ name: 'different-length immediate', candidate: 'print Value=222222', delayMs: 0 },
		{ name: 'same-length delayed', candidate: 'print Value=2', delayMs: 1500 },
		{ name: 'different-length delayed', candidate: 'print Value=222222', delayMs: 1500 },
		{ name: 'direct edit during native Save', candidate: 'print Value=222222', delayMs: 0, concurrentEdit: true },
		{ name: 'direct edit during clean native Save', candidate: 'print Value=222222', delayMs: 0, concurrentEdit: true, skipPublication: true },
	]) {
		test(`owned linked publication synchronizes a native dirty buffer (${fixture.name})`, async () => {
			const { publishOwnedFileText } = await import('../../src/host/ownedFilePublication.js');
			const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-owned-native-buffer-'));
			const uri = vscode.Uri.file(path.join(root, 'query.kql'));
			const initial = 'print Value=1';
			let participant: vscode.Disposable | undefined;
			let releaseParticipant: (() => void) | undefined;
			try {
				fs.writeFileSync(uri.fsPath, initial, 'utf8');
				const document = await vscode.workspace.openTextDocument(uri);
				const config = vscode.workspace.getConfiguration('files', uri);
				assert.strictEqual(config.get('insertFinalNewline'), false, 'probe requires no formatter-created newline');
				const originalStat = fs.statSync(uri.fsPath);
				const edit = new vscode.WorkspaceEdit();
				edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), fixture.candidate);
				assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
				assert.strictEqual(document.getText(), fixture.candidate);
				assert.strictEqual(document.isDirty, true);
				await new Promise<void>(resolve => setTimeout(resolve, 20));
				if (!('skipPublication' in fixture && fixture.skipPublication)) {
					const handle = await fs.promises.open(uri.fsPath, 'r+');
					try {
						await publishOwnedFileText(handle, { device: originalStat.dev, inode: originalStat.ino }, initial, document.getText());
					} finally { await handle.close(); }
				}
				if (fixture.delayMs) await new Promise<void>(resolve => setTimeout(resolve, fixture.delayMs));
				assert.strictEqual(document.isDirty, true, 'the native Save must not be a clean-document no-op');
				const publishedStat = fs.statSync(uri.fsPath);
				const versionBefore = document.version;
				let concurrentEdit: Promise<void> | undefined;
				const newerDraft = 'print Unsaved=333333333';
				if ('concurrentEdit' in fixture && fixture.concurrentEdit) {
					let participantStarted!: () => void;
					const started = new Promise<void>(resolve => { participantStarted = resolve; });
					const held = new Promise<void>(resolve => { releaseParticipant = resolve; });
					participant = vscode.workspace.onWillSaveTextDocument(event => {
						if (event.document !== document) return;
						event.waitUntil(held);
						participantStarted();
					});
					concurrentEdit = started.then(async () => {
						const directEdit = new vscode.WorkspaceEdit();
						directEdit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), newerDraft);
						assert.strictEqual(await vscode.workspace.applyEdit(directEdit), true);
						releaseParticipant!();
					});
				}
				const saved = await document.save();
				await concurrentEdit;
				console.log(JSON.stringify({ probe: fixture.name, saved, dirty: document.isDirty, versionBefore, versionAfter: document.version, priorMtime: originalStat.mtimeMs, publishedMtime: publishedStat.mtimeMs, priorSize: originalStat.size, publishedSize: publishedStat.size }));
				if (concurrentEdit) {
					assert.strictEqual(document.getText(), newerDraft);
					if ('skipPublication' in fixture && fixture.skipPublication) {
						assert.strictEqual(saved, true);
						assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), newerDraft, 'native Save includes direct edits made while participants are running');
						assert.strictEqual(document.isDirty, false);
					} else {
						assert.strictEqual(saved, false);
						assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), fixture.candidate, 'a native Save conflict must preserve the accepted durable candidate');
						assert.strictEqual(document.isDirty, true, 'a native Save conflict must keep the concurrent draft dirty');
					}
					return;
				}
				assert.strictEqual(saved, true, 'native Save after an owned write must not conflict, including different-length publication');
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), fixture.candidate);
				assert.strictEqual(document.getText(), fixture.candidate);
			} finally {
				releaseParticipant?.();
				participant?.dispose();
				console.log(`Retained native buffer probe for delayed local-history capture: ${root}`);
			}
		});
	}

	for (const initiallyDirty of [false, true]) {
	test(`user Save persists a linked query with an initially ${initiallyDirty ? 'dirty' : 'clean'} native notebook`, async () => {
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalShowError = vscode.window.showErrorMessage;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-clean-linked-user-save-'));
		const notebookUri = vscode.Uri.file(path.join(tmpDir, 'notebook.kqlx'));
		const linkedUri = vscode.Uri.file(path.join(tmpDir, 'linked.kql'));
		const resultJson = JSON.stringify({ columns: [{ name: 'Value', type: 'long' }], rows: [[7]] });
		const initialText = JSON.stringify({
			futureRoot: { keep: true }, kind: 'kqlx', version: 1, state: { sections: [
				{ futureSection: 42, id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql', resultJson },
			] },
		}, null, 2) + '\n';
		let notebookText = initialText;
		let savedNotebookText = initiallyDirty ? initialText.replace('"keep": true', '"keep": false') : initialText;
		let linkedText = 'print Value=1';
		let savedLinkedText = linkedText;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let sourceGeneration = 0;
		const posted: any[] = [];
		const errors: string[] = [];
		const disposeHandlers: Array<() => void> = [];
		let formatLinkedOnSave = false;
		let failLinkedSave = false;
		let linkedSaveCalls = 0;
		let holdLinkedSave: Promise<void> | undefined;
		let markLinkedSaveStarted: (() => void) | undefined;
		let releaseLinkedSave: (() => void) | undefined;
		const linkedDocument = {
			uri: linkedUri, getText: () => linkedText,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			get isDirty() { return linkedText !== savedLinkedText; },
			save: async () => {
				linkedSaveCalls++;
				const durableText = fs.readFileSync(linkedUri.fsPath, 'utf8');
				assert.ok(durableText === savedLinkedText || (initiallyDirty && linkedSaveCalls === 1 && durableText === linkedText), 'only the first dirty-notebook transaction may already have published its linked bytes');
				markLinkedSaveStarted?.();
				await holdLinkedSave;
				if (failLinkedSave) return false;
				if (formatLinkedOnSave) linkedText = linkedText.trimEnd() + '\n';
				fs.writeFileSync(linkedUri.fsPath, linkedText, 'utf8');
				savedLinkedText = linkedText;
				await Promise.resolve(didSaveHandler?.(linkedDocument as any));
				return true;
			},
		};
		const document = {
			uri: notebookUri, getText: () => notebookText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			get isDirty() { return notebookText !== savedNotebookText; },
			save: async () => {
				if (!document.isDirty) return true;
				let preparation: Promise<vscode.TextEdit[]> = Promise.resolve([]);
				willSaveHandler?.({ document, waitUntil: (value: Thenable<vscode.TextEdit[]>) => { preparation = Promise.resolve(value); } });
				const edits = await preparation;
				if (edits.length) notebookText = edits[0].newText;
				fs.writeFileSync(notebookUri.fsPath, notebookText, 'utf8');
				savedNotebookText = notebookText;
				await Promise.resolve(didSaveHandler?.(document as any));
				return true;
			},
		};
		try {
			fs.writeFileSync(notebookUri.fsPath, savedNotebookText, 'utf8');
			fs.writeFileSync(linkedUri.fsPath, linkedText, 'utf8');
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) =>
				uri.toString() === linkedUri.toString() ? linkedDocument : originalOpenTextDocument(uri);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (entry[0].toString() === linkedUri.toString()) linkedText = replacement;
				else if (entry[0].toString() === notebookUri.toString()) notebookText = replacement;
				else return false;
				return true;
			};
			(vscode.window as any).showErrorMessage = async (message: string) => { errors.push(message); };
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => { willSaveHandler = handler; return { dispose() {} }; };
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => { didSaveHandler = handler; return { dispose() {} }; };
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') sourceGeneration = message.sourceGeneration;
						if (message?.reloadRequestId) await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: Number(message.editRevision || 0),
						}));
						if (message?.type === 'requestFinalPersist') await Promise.resolve(receiveHandler?.({
							type: 'persistDocument', flushRequestId: message.requestId, sourceGeneration,
							state: { sections: [{ id: 'query_1', type: 'query', query: linkedText, linkedQueryPath: 'linked.kql', resultJson }] },
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document as any, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const persistQuery = (revision: number, query: string, userSave = true) => Promise.resolve(receiveHandler!({
				type: 'persistDocument', ...(userSave ? { reason: 'user-save', flush: true } : {}),
				snapshotId: `clean-linked-user-save-${revision}`, sourceGeneration, editRevision: revision,
				state: { sections: [{ id: 'query_1', type: 'query', query, linkedQueryPath: 'linked.kql', resultJson }] },
			}));
			for (const revision of [1, 2, 3]) {
				const query = `print Value=${String(revision + 1).repeat(revision + 1)}`;
				formatLinkedOnSave = revision === 2;
				const expectedLinkedText = query + (formatLinkedOnSave ? '\n' : '');
				const priorSourceGeneration = sourceGeneration;
				const snapshotId = `clean-linked-user-save-${revision}`;
				await persistQuery(revision, query);
				if (initiallyDirty && revision === 1) await waitForCondition(() => !linkedDocument.isDirty, 'confirmed notebook commit must synchronize its exact linked buffer');
				assert.ok(posted.some(message => message.type === 'persistDocumentAck' && message.snapshotId === snapshotId));
				assert.strictEqual(notebookText, initialText, 'a linked-only snapshot must leave the notebook source unchanged');
				assert.deepStrictEqual(errors, []);
				assert.strictEqual(fs.readFileSync(linkedUri.fsPath, 'utf8'), expectedLinkedText, 'user Save must publish a linked-only edit even when the notebook is clean');
				assert.strictEqual(linkedText, expectedLinkedText);
				assert.strictEqual(linkedDocument.isDirty, false, 'the saved linked document must be clean');
				assert.strictEqual(fs.readFileSync(notebookUri.fsPath, 'utf8'), initialText);
				assert.strictEqual(notebookText, initialText);
				assert.strictEqual(document.isDirty, false);
				if (formatLinkedOnSave) {
					await waitForCondition(() => sourceGeneration > priorSourceGeneration, 'formatted linked text must reproject before the next edit');
				}
			}
			assert.strictEqual(linkedSaveCalls, 3);
			const linkedSaveStarted = new Promise<void>(resolve => { markLinkedSaveStarted = resolve; });
			holdLinkedSave = new Promise<void>(resolve => { releaseLinkedSave = resolve; });
			const savingAcceptedQuery = persistQuery(4, 'print Accepted=444444');
			await linkedSaveStarted;
			const laterEdit = persistQuery(5, 'print Unsaved=5555555', false);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(linkedText, 'print Accepted=444444', 'the newer edit must queue behind the accepted Save');
			assert.ok(releaseLinkedSave);
			releaseLinkedSave();
			await Promise.all([savingAcceptedQuery, laterEdit]);
			holdLinkedSave = undefined;
			markLinkedSaveStarted = undefined;
			assert.deepStrictEqual(errors, []);
			assert.strictEqual(fs.readFileSync(linkedUri.fsPath, 'utf8'), 'print Accepted=444444');
			assert.strictEqual(linkedText, 'print Unsaved=5555555');
			assert.strictEqual(linkedDocument.isDirty, true);
			failLinkedSave = true;
			await persistQuery(6, 'print SaveFailed=66666666');
			assert.strictEqual(errors.length, 1);
			assert.strictEqual(fs.readFileSync(linkedUri.fsPath, 'utf8'), 'print Accepted=444444');
			assert.strictEqual(linkedText, 'print SaveFailed=66666666');
			assert.strictEqual(linkedDocument.isDirty, true);
			failLinkedSave = false;
			const callsBeforeExternalChange = linkedSaveCalls;
			fs.writeFileSync(linkedUri.fsPath, 'print External=7', 'utf8');
			await persistQuery(7, 'print MustNotOverwrite=777777777');
			assert.strictEqual(errors.length, 2);
			assert.strictEqual(linkedSaveCalls, callsBeforeExternalChange, 'an external durable change must reject before native Save');
			assert.strictEqual(fs.readFileSync(linkedUri.fsPath, 'utf8'), 'print External=7');
			assert.strictEqual(fs.readFileSync(notebookUri.fsPath, 'utf8'), initialText);
		} finally {
			releaseLinkedSave?.();
			for (const dispose of disposeHandlers) dispose();
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.window as any).showErrorMessage = originalShowError;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
	}

	test('linked notebook Save cannot publish a newer queued linked edit', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-content-owner-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		}, null, 2) + '\n';
		let linkedText = 'BASELINE';
		let linkedDirty = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let newerPersist: Promise<unknown> | undefined;
		const posted: any[] = [];
		const unsupportedEdits: string[] = [];
		const linkedUri = vscode.Uri.file(linkedPath);
		const linkedDocument = {
			uri: linkedUri, getText: () => linkedText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			get isDirty() { return linkedDirty; },
			save: async () => true,
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) =>
				uri.toString() === linkedUri.toString() ? linkedDocument : originalOpenTextDocument(uri);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (entry?.[0]?.toString() !== linkedUri.toString() || typeof replacement !== 'string') {
					unsupportedEdits.push(entry?.[0]?.toString() ?? 'missing target');
					return false;
				}
				linkedText = replacement;
				linkedDirty = true;
				if (replacement === 'CANDIDATE' && !newerPersist) {
					newerPersist = Promise.resolve().then(() => receiveHandler!({
						type: 'persistDocument', snapshotId: 'content-owner-newer', editRevision: 2,
						sourceGeneration, state: { sections: [
							{ id: 'query_1', type: 'query', query: 'NEWER' },
						] },
					}));
				}
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'content-owner', sourceGeneration, editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'CANDIDATE' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(willSaveHandler);
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			const notebookEdits = await waited! as vscode.TextEdit[];
			assert.strictEqual(notebookEdits.length, 0, 'query-only linked Save must start from canonical notebook bytes');
			await newerPersist;
			assert.strictEqual(linkedText, 'NEWER');
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'content-owner-newer'),
				`newer queued linked edit should acknowledge; unsupported edits: ${JSON.stringify(unsupportedEdits)}`,
			);
			const committedNotebookText = notebookEdits[0]?.newText ?? notebookText;
			fs.writeFileSync(notebookPath, committedNotebookText, 'utf8');
			await new Promise<void>(resolve => setTimeout(resolve, 1_100));
			await Promise.resolve(didSaveHandler!({ ...document, getText: () => committedNotebookText } as any));
			await new Promise<void>(resolve => setTimeout(resolve, 100));

			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'CANDIDATE');
			assert.strictEqual(linkedText, 'NEWER');
			assert.strictEqual(linkedDirty, true);
			assert.deepStrictEqual(unsupportedEdits, []);
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save restores durable bytes after a concurrent direct buffer edit', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFsOpen = fs.promises.open;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-direct-edit-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		let linkedText = 'BASELINE';
		let linkedDirty = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let markCandidateSynced!: () => void;
		let releaseCandidateSync!: () => void;
		const candidateSynced = new Promise<void>(resolve => { markCandidateSynced = resolve; });
		const candidateSyncGate = new Promise<void>(resolve => { releaseCandidateSync = resolve; });
		const linkedUri = vscode.Uri.file(linkedPath);
		const linkedDocument = {
			uri: linkedUri, getText: () => linkedText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			get isDirty() { return linkedDirty; },
			save: async () => true,
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) =>
				uri.toString() === linkedUri.toString() ? linkedDocument : originalOpenTextDocument(uri);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (entry?.[0]?.toString() !== linkedUri.toString() || typeof replacement !== 'string') return false;
				linkedText = replacement;
				linkedDirty = true;
				return true;
			};
			let gated = false;
			(fs.promises as any).open = async (target: fs.PathLike, flags: string, ...args: any[]) => {
				const handle = await (originalFsOpen as any)(target, flags, ...args);
				if (!gated && path.resolve(String(target)).toLowerCase() === path.resolve(linkedPath).toLowerCase() && flags === 'r+') {
					gated = true;
					const originalSync = handle.sync.bind(handle);
					(handle as any).sync = async () => {
						await originalSync();
						markCandidateSynced();
						await candidateSyncGate;
					};
				}
				return handle;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'direct-edit', sourceGeneration, editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'CANDIDATE' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			await candidateSynced;
			const directEdit = new vscode.WorkspaceEdit();
			directEdit.replace(
				linkedUri,
				new vscode.Range(linkedDocument.positionAt(0), linkedDocument.positionAt(linkedText.length)),
				'NEWER',
			);
			assert.strictEqual(await vscode.workspace.applyEdit(directEdit), true);
			releaseCandidateSync();

			await assert.rejects(waited!, /target changed during durable Save/);
			assert.strictEqual(linkedText, 'NEWER');
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'BASELINE');
		} finally {
			releaseCandidateSync();
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(fs.promises as any).open = originalFsOpen;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save rejects a same-path physical target replacement during save', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFsOpen = fs.promises.open;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-physical-retarget-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const displacedPath = path.join(tmpDir, 'linked-original.kql');
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		}, null, 2) + '\n';
		let linkedText = 'BASELINE';
		let linkedDirty = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let markLinkedSaveStarted!: () => void;
		let releaseLinkedSave!: () => void;
		const linkedSaveStarted = new Promise<void>(resolve => { markLinkedSaveStarted = resolve; });
		const linkedSaveGate = new Promise<void>(resolve => { releaseLinkedSave = resolve; });
		const linkedUri = vscode.Uri.file(linkedPath);
		const linkedDocument = {
			uri: linkedUri, getText: () => linkedText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			get isDirty() { return linkedDirty; },
			save: async () => true,
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
				if (uri.toString() === linkedUri.toString()) return linkedDocument;
				return originalOpenTextDocument(uri);
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (entry?.[0]?.toString() !== linkedUri.toString() || typeof replacement !== 'string') return false;
				linkedText = replacement;
				linkedDirty = true;
				return true;
			};
			(fs.promises as any).open = async (target: fs.PathLike, flags: string, ...args: any[]) => {
				if (path.resolve(String(target)).toLowerCase() === path.resolve(linkedPath).toLowerCase() && flags === 'r+') {
					markLinkedSaveStarted();
					await linkedSaveGate;
				}
				return (originalFsOpen as any)(target, flags, ...args);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'physical-retarget', sourceGeneration, editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'CANDIDATE' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(willSaveHandler);
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			await linkedSaveStarted;

			fs.renameSync(linkedPath, displacedPath);
			fs.writeFileSync(linkedPath, 'EXTERNAL_REPLACEMENT', 'utf8');
			releaseLinkedSave();

			await assert.rejects(waited!, /linked query file could not be saved/);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'EXTERNAL_REPLACEMENT');
			assert.strictEqual(fs.readFileSync(displacedPath, 'utf8'), 'BASELINE');
			assert.ok(!notebookText.includes('CANDIDATE'));
		} finally {
			releaseLinkedSave();
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(fs.promises as any).open = originalFsOpen;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save rejects in-place external linked bytes before editing', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-byte-cas-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let applyCalls = 0;
		const linkedUri = vscode.Uri.file(linkedPath);
		const linkedDocument = {
			uri: linkedUri, getText: () => 'BASELINE',
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			isDirty: false, save: async () => true,
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, 'BASELINE', 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) =>
				uri.toString() === linkedUri.toString() ? linkedDocument : originalOpenTextDocument(uri);
			(vscode.workspace as any).applyEdit = async () => { applyCalls++; return true; };
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'byte-cas', sourceGeneration, editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'CANDIDATE' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			fs.writeFileSync(linkedPath, 'EXTERNAL_IN_PLACE', 'utf8');
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });

			await assert.rejects(waited!, /changed on disk before Save/);
			assert.strictEqual(applyCalls, 0);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'EXTERNAL_IN_PLACE');
			assert.ok(!notebookText.includes('CANDIDATE'));
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('abandoned linked Save restores disk without overwriting a newer buffer', async function () {
		this.timeout(15000);
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-abandoned-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		}, null, 2) + '\n';
		let linkedText = 'BASELINE';
		let linkedDirty = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let sourceGeneration = 0;
		let failFinalSnapshot = false;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		const linkedUri = vscode.Uri.file(linkedPath);
		const linkedDocument = {
			uri: linkedUri, getText: () => linkedText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			get isDirty() { return linkedDirty; },
			save: async () => {
				fs.writeFileSync(linkedPath, linkedText, 'utf8');
				linkedDirty = false;
				return true;
			},
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) =>
				uri.toString() === linkedUri.toString() ? linkedDocument : originalOpenTextDocument(uri);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (entry?.[0]?.toString() !== linkedUri.toString() || typeof replacement !== 'string') return false;
				linkedText = replacement;
				linkedDirty = true;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							if (failFinalSnapshot) return true;
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'abandoned-save', sourceGeneration, editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'CANDIDATE' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const notebookWillSave = willSaveHandler!;
			const notebookDidSave = didSaveHandler!;
			let waited: Promise<unknown> | undefined;
			notebookWillSave({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			const notebookEdits = await waited as vscode.TextEdit[];
			assert.strictEqual(notebookEdits.length, 0);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'CANDIDATE');

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'abandoned-save-newer', editRevision: 2,
				sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'NEWER' },
				] },
			}));
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'abandoned-save-newer'),
				'abandoned Save successor edit should acknowledge',
			);
			assert.strictEqual(linkedText, 'NEWER');
			await waitForCondition(
				() => fs.readFileSync(linkedPath, 'utf8') === 'BASELINE' && linkedText === 'NEWER',
				'abandoned linked Save should restore disk without replacing the newer buffer',
				2_000,
			);

			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'BASELINE');
			failFinalSnapshot = true;
			let newerSave: Promise<unknown> | undefined;
			notebookWillSave({ document, waitUntil: (value: Promise<unknown>) => { newerSave = value; } });
			await assert.rejects(newerSave!, /final editor snapshot/);
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			await Promise.resolve(notebookDidSave(document));
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
			assert.strictEqual(linkedText, 'NEWER');
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'BASELINE');
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save followed by immediate close preserves a commit after rollback', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-save-confirmed-close-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		}, null, 2) + '\n';
		let linkedText = 'BASELINE';
		let linkedDirty = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		const willSaveHandlers: Array<(event: any) => unknown> = [];
		const didSaveHandlers: Array<(document: vscode.TextDocument) => unknown> = [];
		const disposeHandlers: Array<() => void> = [];
		let finalSnapshotRequests = 0;
		let sourceGeneration = 0;
		const linkedUri = vscode.Uri.file(linkedPath);
		const linkedDocument = {
			uri: linkedUri, getText: () => linkedText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			get isDirty() { return linkedDirty; },
			save: async () => {
				fs.writeFileSync(linkedPath, linkedText, 'utf8');
				linkedDirty = false;
				return true;
			},
		} as any;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				didSaveHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) =>
				uri.toString() === linkedUri.toString() ? linkedDocument : originalOpenTextDocument(uri);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (entry?.[0]?.toString() !== linkedUri.toString() || typeof replacement !== 'string') return false;
				linkedText = replacement;
				linkedDirty = true;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalSnapshotRequests++;
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'confirmed-close', sourceGeneration, editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'CONFIRMED' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			let waited: Promise<vscode.TextEdit[]> | undefined;
			for (const handler of willSaveHandlers) {
				let candidate: Promise<vscode.TextEdit[]> | undefined;
				const requestsBefore = finalSnapshotRequests;
				handler({ document, waitUntil: (value: Thenable<vscode.TextEdit[]>) => { candidate = Promise.resolve(value); } });
				await new Promise<void>(resolve => setImmediate(resolve));
				if (finalSnapshotRequests > requestsBefore) {
					waited = candidate;
					break;
				}
			}
			assert.ok(waited, 'the owning notebook save listener must provide a preparation');
			const edits = await waited!;
			if (edits.length > 0) notebookText = edits[0].newText;
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'CONFIRMED');

			for (const dispose of disposeHandlers) dispose();
			await new Promise<void>(resolve => setTimeout(resolve, 650));
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			for (const handler of didSaveHandlers) handler(document);
			await waitForCondition(
				() => fs.readFileSync(linkedPath, 'utf8') === 'CONFIRMED' && linkedText === 'CONFIRMED',
				'late notebook commit should restore the linked candidate after close rollback',
				2_000,
			);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'CONFIRMED');
			assert.strictEqual(linkedText, 'CONFIRMED');
			assert.strictEqual(linkedDirty, false, 'a confirmed late commit with no newer draft must leave the linked document clean');
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('newer baseline persist repairs an older delayed notebook edit', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-delayed-apply-revert-'));
		const filePath = path.join(tmpDir, 'revert.kqlx');
		const baselineQuery = 'print baseline = 0';
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: baselineQuery },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let markApplyStarted!: () => void;
		let releaseApply!: () => void;
		const applyStarted = new Promise<void>(resolve => { markApplyStarted = resolve; });
		const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
		let applyCalls = 0;
		let delayNextApply = false;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				applyCalls++;
				if (delayNextApply) {
					delayNextApply = false;
					markApplyStarted();
					await applyGate;
				}
				currentText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			applyCalls = 0;
			delayNextApply = true;
			const oldPersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'delayed-old-edit', editRevision: 1,
				sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print old = 1' },
				] },
			}));
			await Promise.race([
				applyStarted,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('old persistence edit did not start')), 2_000)),
			]);
			const baselinePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'newer-baseline-repair', editRevision: 2,
				sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: baselineQuery },
				] },
			}));
			releaseApply();
			await Promise.race([
				Promise.all([oldPersist, baselinePersist]),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('serialized persistence requests did not settle')), 2_000)),
			]);
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'newer-baseline-repair'),
				'newer baseline repair should acknowledge',
			);

			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, baselineQuery);
			assert.strictEqual(applyCalls, 2, 'newer baseline must repair the older applied text');
		} finally {
			releaseApply();
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('host-owned Transformation command rejects an ambiguous future-field overlay conflict', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-ambiguous-save-'));
		const filePath = path.join(tmpDir, 'ambiguous-save.kqlx');
		const baseState = { sections: [{
			id: 'transformation_1', type: 'transformation', aggregations: [
				{ name: '', function: 'sum', column: 'A', futureAggregation: 'first' },
				{ name: '', function: 'sum', column: 'A', futureAggregation: 'second' },
			],
		}] };
		const editedState = { sections: [{
			id: 'transformation_1', type: 'transformation', aggregations: [
				{ name: '', function: 'max', column: 'B' },
				{ name: '', function: 'min', column: 'C' },
			],
		}] };
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: baseState }, null, 2);
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		let commandResult: any;

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') projection = message;
						if (message?.type === 'markdownDocumentCommandResult') commandResult = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(projection);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'ambiguous-transformation-patch',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'transformation_1', expectedSectionRevision: 0,
					patch: editedState.sections[0],
				},
			}));
			await waitForCondition(() => !!commandResult, 'ambiguous Transformation command should settle');
			assert.strictEqual(commandResult.ok, false);
			assert.match(
				String(commandResult.error?.message || ''),
				/Cannot safely preserve future fields for an ambiguously edited nested array/,
			);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), text);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native save final snapshot bypasses an active persistence decision', async () => {
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-reentrant-save-'));
		const filePath = path.join(tmpDir, 'reorder.kqlx');
		const state = { sections: [{
			id: 'query_1', type: 'query', query: 'print value = 1',
			resultJson: '{"columns":[{"name":"Value","type":"long"}],"rows":[[1]]}',
		}] };
		let currentText = JSON.stringify({ kind: 'kqlx', version: 1, state }, null, 2);
		let dirty = true;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		const changeHandlers: Array<(event: vscode.TextDocumentChangeEvent) => unknown> = [];
		let saveCalls = 0;
		let pausePersist = false;
		let markPersistStarted!: () => void;
		let releasePersist!: () => void;
		const persistStarted = new Promise<void>(resolve => { markPersistStarted = resolve; });
		const persistGate = new Promise<void>(resolve => { releasePersist = resolve; });

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
				changeHandlers.push(handler);
				return { dispose() {} };
			};
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (value: unknown) => value;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (value: unknown) => {
				if (pausePersist) {
					pausePersist = false;
					markPersistStarted();
					await persistGate;
				}
				return value;
			};
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				value: unknown, publish: (state: unknown) => Promise<unknown>,
			) => publish(value);
			(vscode.workspace as any).onWillSaveTextDocument = (
				handler: (event: vscode.TextDocumentWillSaveEvent) => unknown,
			) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (
				handler: (document: vscode.TextDocument) => unknown,
			) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				dirty = true;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				get isDirty() { return dirty; },
				get version() { return 1; },
				save: async () => {
					saveCalls++;
					let barrier: Promise<vscode.TextEdit[]> | undefined;
					willSaveHandler!({
						document,
						waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); },
					} as any);
					const edits = await barrier!;
					if (edits.length > 0) currentText = edits[edits.length - 1].newText;
					dirty = false;
					await Promise.resolve(didSaveHandler?.(document));
					return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', state, flush: true, reason: 'save',
								flushRequestId: message.requestId, sourceGeneration,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			dirty = true;
			pausePersist = true;
			const changedState = { sections: [{ ...state.sections[0], query: 'print value = 2' }] };
			const activePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'reentrant-active-edit', editRevision: 1,
				sourceGeneration, state: changedState, reason: 'edit',
			}));
			await persistStarted;
			await Promise.race([
				document.save(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reentrant native save timed out')), 2_000)),
			]);
			releasePersist();
			await activePersist;
			await waitForCondition(
				() => !dirty,
				'canonical result restoration should finish its controlled Save',
				2_000,
			);

			assert.ok(saveCalls >= 1 && saveCalls <= 2, `expected one native save plus at most one canonical restore, got ${saveCalls}`);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'print value = 1');
			assert.strictEqual(dirty, false, 'retired ordinary persistence must not dirty the saved final snapshot');
			assert.ok(currentText.includes('resultJson'), 'admitted persisted results must survive reentrant save');
		} finally {
			releasePersist();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native save preserves multiple near-limit results and metadata edits across reopen', async function () {
		this.timeout(10_000);
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-large-native-save-'));
		const filePath = path.join(tmpDir, 'large.kqlx');
		const largeCell = 'x'.repeat(4_100_000);
		const resultJson = JSON.stringify({
			columns: [{ name: 'Payload', type: 'string' }], rows: [[largeCell]],
		});
		const initialState = { sections: [
			{ id: 'query_1', type: 'query', name: 'Before Save', query: 'print One=1', resultJson },
			{ id: 'query_2', type: 'query', name: 'Second', query: 'print Two=2', resultJson },
		] };
		const finalState = { sections: [
			{ ...initialState.sections[0], name: 'After Save' },
			initialState.sections[1],
		] };
		let currentText = JSON.stringify({ kind: 'kqlx', version: 1, state: initialState });
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (value: unknown) => value;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (value: unknown) => value;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				value: unknown, publish: (state: unknown) => Promise<unknown>,
			) => publish(value);
			(vscode.workspace as any).onWillSaveTextDocument = (
				handler: (event: vscode.TextDocumentWillSaveEvent) => unknown,
			) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (
				handler: (document: vscode.TextDocument) => unknown,
			) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', state: finalState,
								sourceGeneration, flush: true, reason: 'save',
								flushRequestId: message.requestId,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
			} as any);
			const edits = await saveBarrier!;
			if (edits.length > 0) currentText = edits[edits.length - 1].newText;
			fs.writeFileSync(filePath, currentText, 'utf8');
			await Promise.resolve(didSaveHandler?.(document));

			const reopened = parseKqlxText(fs.readFileSync(filePath, 'utf8'));
			if (!reopened.ok) assert.fail(reopened.error);
			const first = reopened.file.state.sections[0] as { name?: string; resultJson?: string };
			const second = reopened.file.state.sections[1] as { resultJson?: string };
			assert.strictEqual(first.name, 'After Save');
			assert.strictEqual(reopened.file.state.sections.length, 2);
			assert.strictEqual(first.resultJson?.length, resultJson.length);
			assert.strictEqual(second.resultJson?.length, resultJson.length);
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 5_000), true);
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('same-path linked target replacement after hydration is rejected before edit', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-identity-replacement-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const documentUri = vscode.Uri.file(filePath);
		const documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, documentText, 'utf8');
			fs.writeFileSync(linkedPath, 'LINKED_BASELINE', 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor({
				uri: documentUri, getText: () => documentText, eol: vscode.EndOfLine.LF,
			} as any, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			fs.renameSync(linkedPath, path.join(tmpDir, 'linked-original.kql'));
			fs.writeFileSync(linkedPath, 'REPLACEMENT_SENTINEL', 'utf8');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'same-path-replacement', editRevision: 1,
				sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'MUST_NOT_WRITE' },
				] },
			}));

			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'same-path-replacement'));
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), documentText);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'REPLACEMENT_SENTINEL');
		} finally {
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(documentUri, 2_000);
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('in-place linked target change after hydration is rejected before edit', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-content-replacement-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const documentUri = vscode.Uri.file(filePath);
		const documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, documentText, 'utf8');
			fs.writeFileSync(linkedPath, 'LINKED_BASELINE', 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor({
				uri: documentUri, getText: () => documentText, eol: vscode.EndOfLine.LF,
			} as any, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			fs.writeFileSync(linkedPath, 'EXTERNAL_IN_PLACE', 'utf8');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'in-place-replacement', editRevision: 1,
				sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'MUST_NOT_WRITE' },
				] },
			}));

			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'in-place-replacement'));
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), documentText);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'EXTERNAL_IN_PLACE');
		} finally {
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(documentUri, 2_000);
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked save completing during hydration advances the durable baseline', async () => {
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalRealpath = fs.promises.realpath;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-hydration-save-'));
		const globalStoragePath = path.join(tmpDir, 'global-storage');
		const filePath = path.join(globalStoragePath, 'session.kqlx');
		const linkedPath = path.join(globalStoragePath, 'linked.kql');
		const documentUri = vscode.Uri.file(filePath);
		const linkedUri = vscode.Uri.file(linkedPath);
		const documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		let linkedText = 'LINKED_BASELINE';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let blockLinkedSnapshot = false;
		let linkedSnapshotBlocked = false;
		let markLinkedSnapshotStarted!: () => void;
		let releaseLinkedSnapshot!: () => void;
		const linkedSnapshotStarted = new Promise<void>(resolve => { markLinkedSnapshotStarted = resolve; });
		const linkedSnapshotGate = new Promise<void>(resolve => { releaseLinkedSnapshot = resolve; });
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		const linkedDocument = {
			uri: linkedUri,
			getText: () => linkedText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			isDirty: false,
			save: async () => true,
		} as any;

		try {
			fs.mkdirSync(globalStoragePath, { recursive: true });
			fs.writeFileSync(filePath, documentText, 'utf8');
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) =>
				normalizeWorkbenchUriKey(uri) === normalizeWorkbenchUriKey(linkedUri)
					? linkedDocument
					: originalOpenTextDocument(uri);
			(vscode.workspace as any).onDidSaveTextDocument = (
				handler: (document: vscode.TextDocument) => unknown,
			) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(fs.promises as any).realpath = async (target: fs.PathLike) => {
				if (blockLinkedSnapshot && !linkedSnapshotBlocked
					&& path.resolve(String(target)).toLowerCase() === path.resolve(linkedPath).toLowerCase()) {
					linkedSnapshotBlocked = true;
					markLinkedSnapshotStarted();
					await linkedSnapshotGate;
				}
				return originalRealpath(target);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(globalStoragePath),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: documentUri, getText: () => documentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(didSaveHandler);

			blockLinkedSnapshot = true;
			const rehydration = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await linkedSnapshotStarted;
			linkedText = 'SAVED_DURING_HYDRATION';
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			await Promise.resolve(didSaveHandler!(linkedDocument));
			releaseLinkedSnapshot();
			await rehydration;

			const latestProjection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
			assert.strictEqual(latestProjection?.state?.sections?.[0]?.query, linkedText);
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'save-during-hydration', editRevision: 1,
				sourceGeneration: latestProjection?.sourceGeneration,
				state: latestProjection?.state,
			}));
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'save-during-hydration'),
				'persist should acknowledge the baseline advanced by the overlapping linked save',
			);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), linkedText);
		} finally {
			releaseLinkedSnapshot();
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(fs.promises as any).realpath = originalRealpath;
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(documentUri, 2_000);
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked notebook Save rejects a dirty open physical alias', async () => {
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-dirty-alias-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const openAliasPath = path.join(tmpDir, 'open-alias.kql');
		const linkedPath = path.join(tmpDir, 'linked-target.kql');
		const notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: path.basename(linkedPath) },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let sourceGeneration = 0;
		let aliasDocument: vscode.TextDocument | undefined;
		const disposeHandlers: Array<() => void> = [];

		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(openAliasPath, 'BASELINE', 'utf8');
			fs.linkSync(openAliasPath, linkedPath);
			aliasDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(openAliasPath));
			const dirtyAliasEdit = new vscode.WorkspaceEdit();
			dirtyAliasEdit.replace(
				aliasDocument.uri,
				new vscode.Range(aliasDocument.positionAt(0), aliasDocument.positionAt(aliasDocument.getText().length)),
				'DIRTY_ALIAS',
			);
			assert.strictEqual(await vscode.workspace.applyEdit(dirtyAliasEdit), true);
			assert.strictEqual(aliasDocument.isDirty, true);
			(vscode.workspace as any).onWillSaveTextDocument = (
				handler: (event: vscode.TextDocumentWillSaveEvent) => unknown,
			) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'dirty-alias-save', sourceGeneration, editRevision: 1,
								state: { sections: [{ id: 'query_1', type: 'query', query: 'CANDIDATE' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(willSaveHandler);
			let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
			} as any);

			await assert.rejects(saveBarrier!, /linked query file could not be updated|target changed during durable Save/i);
			assert.strictEqual(aliasDocument.getText(), 'DIRTY_ALIAS');
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'BASELINE');
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(vscode.Uri.file(notebookPath), 2_000);
			if (aliasDocument) {
				const restore = new vscode.WorkspaceEdit();
				restore.replace(
					aliasDocument.uri,
					new vscode.Range(aliasDocument.positionAt(0), aliasDocument.positionAt(aliasDocument.getText().length)),
					'BASELINE',
				);
				await vscode.workspace.applyEdit(restore);
				await aliasDocument.save();
			}
			const cleanupUriKeys = new Set([
				normalizeWorkbenchUriKey(vscode.Uri.file(openAliasPath)),
				normalizeWorkbenchUriKey(vscode.Uri.file(linkedPath)),
			]);
			const cleanupTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
				const input = tab.input;
				const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom
					? input.uri
					: undefined;
				return uri !== undefined && cleanupUriKeys.has(normalizeWorkbenchUriKey(uri));
			});
			if (cleanupTabs.length > 0 && typeof vscode.window.tabGroups.close === 'function') {
				await vscode.window.tabGroups.close([...new Set(cleanupTabs)], true);
			}
			process.once('exit', () => {
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			});
		}
	});

	test('newest notebook persist wins when older sanitation settles last', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = ['file', 'session'] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-persist-generation-'));

		try {
			for (const variant of variants) {
				const globalStoragePath = path.join(tmpDir, `${variant}-global`);
				fs.mkdirSync(globalStoragePath, { recursive: true });
				const filePath = variant === 'session'
					? path.join(globalStoragePath, 'session.kqlx')
					: path.join(tmpDir, `${variant}.kqlx`);
				let currentText = JSON.stringify({
					kind: 'kqlx', version: 1, state: { sections: [
						{ id: 'query_1', type: 'query', query: 'print initial = 0' },
					] },
				});
				fs.writeFileSync(filePath, currentText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				let gatePersists = false;
				let markOldStarted!: () => void;
				let releaseOld!: () => void;
				const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
				const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (gatePersists && state.sections?.[0]?.query === 'print old = 1') {
						markOldStarted();
						await oldGate;
					}
					return state;
				};
				(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
					state: any, publish: (value: any) => Promise<unknown>,
				) => publish(state);
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					return true;
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(globalStoragePath),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				const document = {
					uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
					.at(-1)?.sourceGeneration;
				gatePersists = true;
				const oldPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `${variant}-old-sanitization`, editRevision: 1,
					sourceGeneration, state: { sections: [
						{ id: 'query_1', type: 'query', query: 'print old = 1' },
					] },
				}));
				await oldStarted;
				const newestPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `${variant}-newest-sanitization`, editRevision: 2,
					sourceGeneration, state: { sections: [
						{ id: 'query_1', type: 'query', query: 'print newest = 2' },
					] },
				}));
				releaseOld();
				await Promise.all([oldPersist, newestPersist]);
				await waitForCondition(
					() => posted.some(message => message?.type === 'persistDocumentAck'
						&& message.snapshotId === `${variant}-newest-sanitization`),
					`${variant} newest sanitation should acknowledge`,
				);
				const finalText = variant === 'session' ? fs.readFileSync(filePath, 'utf8') : currentText;
				assert.strictEqual(JSON.parse(finalText).state.sections[0].query, 'print newest = 2');
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('adapter persistence and Markdown commands serialize without lost updates', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = ['file', 'session'] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-adapter-interleave-'));
		let releaseAdapter: (() => void) | undefined;

		try {
			for (const variant of variants) {
				const globalStoragePath = path.join(tmpDir, `${variant}-global`);
				fs.mkdirSync(globalStoragePath, { recursive: true });
				const filePath = variant === 'session'
					? path.join(globalStoragePath, 'session.kqlx')
					: path.join(tmpDir, `${variant}.kqlx`);
				let currentText = JSON.stringify({
					kind: 'kqlx', version: 1, state: { sections: [
						{ id: 'query_1', type: 'query', query: 'print initial = 0' },
						{ id: 'markdown_1', type: 'markdown', text: 'before', futureMarkdown: { keep: variant } },
					] },
				}, null, 2) + '\n';
				fs.writeFileSync(filePath, currentText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				let gateAdapter = false;
				let adapterPauseAvailable = true;
				let markAdapterStarted!: () => void;
				const adapterStarted = new Promise<void>(resolve => { markAdapterStarted = resolve; });
				const adapterGate = new Promise<void>(resolve => { releaseAdapter = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					const adapterQuery = state.sections?.find((section: any) => section?.id === 'query_1')?.query;
					if (gateAdapter && adapterPauseAvailable && adapterQuery === 'print adapter = 1') {
						adapterPauseAvailable = false;
						markAdapterStarted();
						await adapterGate;
					}
					return state;
				};
				(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
					state: any, publish: (value: any) => Promise<unknown>,
				) => publish(state);
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					return true;
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(globalStoragePath),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				const document = {
					uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projection = posted.find(message => message?.type === 'documentData' && message.ok === true);
				assert.ok(projection);
				gateAdapter = true;
				const adapterPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `${variant}-adapter`,
					sourceGeneration: projection.sourceGeneration, editRevision: 1,
					state: { sections: [
						{ id: 'query_1', type: 'query', query: 'print adapter = 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'stale adapter markdown' },
					] },
				}));
				await adapterStarted;
				let commandSettled = false;
				const markdownCommand = Promise.resolve(receiveHandler!({
					type: 'markdownDocumentCommand', commandId: `${variant}-markdown`,
					sourceGeneration: projection.sourceGeneration,
					expectedDocumentRevision: projection.documentRevision,
					command: {
						type: 'patch', sectionId: 'markdown_1',
						expectedSectionRevision: projection.markdownSectionRevisions.markdown_1,
						patch: { text: 'command markdown' },
					},
				})).then(() => { commandSettled = true; });
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(commandSettled, false, 'Markdown command must queue behind adapter persistence');
				releaseAdapter!();
				await Promise.all([adapterPersist, markdownCommand]);
				const finalText = variant === 'session' ? fs.readFileSync(filePath, 'utf8') : currentText;
				const finalFile = JSON.parse(finalText);
				assert.strictEqual(finalFile.state.sections[0].query, 'print adapter = 1');
				assert.strictEqual(finalFile.state.sections[1].text, 'command markdown');
				assert.deepStrictEqual(finalFile.state.sections[1].futureMarkdown, { keep: variant });
				assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
					&& message.commandId === `${variant}-markdown` && message.ok === true));
				releaseAdapter = undefined;
			}
		} finally {
			releaseAdapter?.();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX retries one rejected persistence edit before acknowledging canonical opaque order', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-rejected-edit-retry-'));
		const filePath = path.join(tmpDir, 'retry.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print initial = 0' },
				{ id: 'future_1', type: 'future-section', payload: { keep: true } },
				{
					id: 'transform_1', type: 'transformation', dataSourceId: 'query_1',
					transformationType: 'select',
				},
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let applyCalls = 0;
		let driftAfterApply = false;
		let driftCandidateApplied = false;
		let acceptedCandidateReads = 0;
		let directText = '';

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				applyCalls++;
				if (applyCalls === 1) return false;
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				if (driftAfterApply) {
					driftCandidateApplied = true;
					acceptedCandidateReads = 0;
				}
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => {
					if (driftCandidateApplied && ++acceptedCandidateReads === 2) {
						currentText = directText;
						driftAfterApply = false;
						driftCandidateApplied = false;
					}
					return currentText;
				}, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await new Promise<void>(resolve => setTimeout(resolve, 100));
			const sourceGeneration = posted.find(message => message?.type === 'documentData' && message.ok === true)
				?.sourceGeneration;
			posted.length = 0;
			applyCalls = 0;

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'rich-retry-1', sourceGeneration, editRevision: 1,
				state: { sections: [
					{
						id: 'transform_1', type: 'transformation', dataSourceId: 'query_1',
						transformationType: 'select',
					},
					{ id: 'query_1', type: 'query', query: 'print accepted = 1' },
				] },
			}));
			try {
				await waitForCondition(
					() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'rich-retry-1'),
					'rejected persistence edit should retry and acknowledge', 750,
				);
			} catch {
				assert.fail(JSON.stringify({
					applyCalls,
					query: JSON.parse(currentText).state.sections[0].query,
					posted: posted.map(message => ({ type: message?.type, snapshotId: message?.snapshotId })),
				}));
			}

			assert.strictEqual(applyCalls, 2);
			const acceptedSections = JSON.parse(currentText).state.sections;
			assert.strictEqual(
				acceptedSections.find((section: any) => section.id === 'query_1')?.query,
				'print accepted = 1',
			);
			assert.deepStrictEqual(
				acceptedSections.find((section: any) => section.id === 'future_1')?.payload,
				{ keep: true },
			);
			assert.deepStrictEqual(
				posted.filter(message => message?.type === 'persistDocumentAck'),
				[{
					type: 'persistDocumentAck', snapshotId: 'rich-retry-1', editRevision: 1,
					orderedSectionIds: acceptedSections.map((section: any) => section.id),
				}],
			);

			posted.length = 0;
			const directFile = JSON.parse(currentText);
			const directTransformation = directFile.state.sections.find((section: any) => section.id === 'transform_1');
			directTransformation.name = 'DIRECT EDIT';
			directText = JSON.stringify(directFile);
			driftAfterApply = true;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'rich-drift-2', sourceGeneration, editRevision: 2,
				state: { sections: [
					{
						id: 'transform_1', type: 'transformation', dataSourceId: 'query_1',
						transformationType: 'select',
					},
					{ id: 'query_1', type: 'query', query: 'print candidate = 2' },
				] },
			}));
			await new Promise<void>(resolve => setImmediate(resolve));

			assert.strictEqual(currentText, directText);
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'rich-drift-2'));
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('external reload retires an older delayed notebook persist', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-external-reload-fence-'));
		const filePath = path.join(tmpDir, 'external.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print initial = 0' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let gatePersist = false;
		let markPersistStarted!: () => void;
		let releasePersist!: () => void;
		const persistStarted = new Promise<void>(resolve => { markPersistStarted = resolve; });
		const persistGate = new Promise<void>(resolve => { releasePersist = resolve; });
		let applyCalls = 0;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
				if (gatePersist && state.sections?.[0]?.query === 'print stale = 1') {
					gatePersist = false;
					markPersistStarted();
					await persistGate;
				}
				return state;
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				applyCalls++;
				currentText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.find(message => message?.type === 'documentData' && message.ok === true)
				?.sourceGeneration;
			applyCalls = 0;
			gatePersist = true;
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'external-reload-stale', editRevision: 1,
				sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print stale = 1' },
				] },
			}));
			await persistStarted;
			currentText = JSON.stringify({
				kind: 'kqlx', version: 1, futureRoot: 'external', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print external = 2' },
				] },
			});
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const applyCallsAfterReload = applyCalls;
			releasePersist();
			await stalePersist;

			const finalFile = JSON.parse(currentText);
			assert.strictEqual(finalFile.futureRoot, 'external');
			assert.strictEqual(finalFile.state.sections[0].query, 'print external = 2');
			assert.strictEqual(applyCalls, applyCallsAfterReload, 'retired persistence must not edit after external reload');
		} finally {
			releasePersist();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('pending external projection rejects an old rich snapshot without rewriting saved results', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-pending-reload-fence-'));
		const filePath = path.join(tmpDir, 'pending-reload.kqlx');
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print initial = 1' },
				{ id: 'future_1', type: 'future-section', payload: { keep: true } },
				{
					id: 'transform_1', type: 'transformation', name: 'Initial',
					dataSourceId: 'query_1', transformationType: 'select',
				},
			] },
		});
		const externalText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{
					id: 'transform_1', type: 'transformation', name: 'Initial',
					dataSourceId: 'query_1', transformationType: 'select',
				},
				{ id: 'future_1', type: 'future-section', payload: { keep: true } },
				{ id: 'query_1', type: 'query', query: 'print external = 2' },
				{ id: 'sql_protected', type: 'sql', query: 'SELECT 1', resultJson: 'PROTECTED' },
			] },
		});
		let currentText = initialText;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let changeHandler: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
		let holdReload = false;
		let pendingReload: any;
		let applyCalls = 0;
		let delayCommandApply = false;
		let markCommandApplyStarted!: () => void;
		let releaseCommandApply!: () => void;
		const commandApplyStarted = new Promise<void>(resolve => { markCommandApplyStarted = resolve; });
		const commandApplyGate = new Promise<void>(resolve => { releaseCommandApply = resolve; });
		const posted: any[] = [];

		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
				state: any,
				onKustoSanitized?: (before: any, after: any, context: { snapshot: any }) => void,
			) => {
				onKustoSanitized?.(state, state, {
					snapshot: { clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {} },
				});
				return state;
			};
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish({
				...state,
				sections: state.sections.map((section: any) => {
					const next = { ...section };
					if (next.type === 'sql') delete next.resultJson;
					return next;
				}),
			});
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
				changeHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (delayCommandApply && replacement.includes('"name": "Command"')) {
					delayCommandApply = false;
					markCommandApplyStarted();
					await commandApplyGate;
				}
				applyCalls++;
				currentText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					extensionMode: vscode.ExtensionMode.Production,
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.reloadRequestId) {
							if (holdReload) pendingReload = message;
							else await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const initialProjection = posted.find(message => message?.type === 'documentData' && message?.ok === true);
			assert.ok(initialProjection);
			posted.length = 0;
			applyCalls = 0;
			delayCommandApply = true;
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'command-before-reload-ack',
				sourceGeneration: initialProjection.sourceGeneration,
				expectedDocumentRevision: initialProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'transform_1',
					expectedSectionRevision: initialProjection.sectionRevisions.transform_1,
					patch: { name: 'Command' },
				},
			}));
			await commandApplyStarted;

			holdReload = true;
			currentText = externalText;
			void Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
			await waitForCondition(() => !!pendingReload, 'external projection should wait for acknowledgement');
			assert.ok(invalidation.isSubscribed());
			releaseCommandApply();
			await command;
			assert.strictEqual(currentText, externalText);
			assert.strictEqual(
				posted.find(message => message?.commandId === 'command-before-reload-ack')?.ok,
				false,
			);
			applyCalls = 0;

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'old-before-reload-ack', editRevision: 1,
				sourceGeneration: initialProjection.sourceGeneration,
				state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print stale = 3' },
					{
						id: 'transform_1', type: 'transformation', name: 'Stale',
						dataSourceId: 'query_1', transformationType: 'select',
					},
				] },
			}));

			assert.strictEqual(currentText, externalText);
			assert.strictEqual(applyCalls, 0);
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'old-before-reload-ack'));

			const rejectedRequestId = pendingReload.reloadRequestId;
			pendingReload = undefined;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: rejectedRequestId,
				applied: false, editRevision: 1,
			}));
			await waitForCondition(
				() => !!pendingReload && pendingReload.reloadRequestId !== rejectedRequestId,
				'rejected direct projection should retry automatically',
			);
			const retryProjection = [...posted].reverse().find(message =>
				message?.type === 'documentData' && message?.reloadRequestId === pendingReload.reloadRequestId,
			);
			assert.ok(retryProjection);
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: pendingReload.reloadRequestId,
				applied: true, editRevision: 1,
			}));
			assert.strictEqual(
				JSON.parse(currentText).state.sections
					.find((section: any) => section.id === 'sql_protected')?.resultJson,
				'PROTECTED',
			);
			posted.length = 0;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'current-after-reload-retry', editRevision: 2,
				sourceGeneration: retryProjection.sourceGeneration,
				state: { sections: [
					{
						id: 'transform_1', type: 'transformation', name: 'Direct',
						dataSourceId: 'query_1', transformationType: 'select',
					},
					{ id: 'query_1', type: 'query', query: 'print external = 2' },
				] },
			}));
			assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'current-after-reload-retry'));
		} finally {
			invalidation.restore();
			releaseCommandApply?.();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich invalidation leaves a newer source authoritative after policy reconciliation', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-rich-repair-rebase-'));
		const sourcePath = path.join(tmpDir, 'repair.kqlx');
		const wrap = (query: string, resultJson?: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_1', type: 'query', query, ...(resultJson ? { resultJson } : {}),
			}] },
		});
		let currentText = wrap('INITIAL');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let changeHandler: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
		let gateRepair = false;
		let stalePublicationCalls = 0;
		let stalePublicationStarted = false;
		let newerPublicationStarted = false;
		let releaseSecondStalePublication!: () => void;
		const stalePublicationGate = new Promise<void>(resolve => { releaseSecondStalePublication = resolve; });
		let applyCalls = 0;
		let saveCalls = 0;
		try {
			fs.writeFileSync(sourcePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				const query = String(state?.sections?.[0]?.query || '');
				if (gateRepair && query === 'STALE_REPAIR') {
					stalePublicationCalls++;
					if (stalePublicationCalls === 1) {
						stalePublicationStarted = true;
						await stalePublicationGate;
					}
				}
				if (gateRepair && query === 'DIRECT_NEWER') {
					newerPublicationStarted = true;
				}
				return publish({
					...state,
					sections: state.sections.map((section: any) => {
						const next = { ...section };
						delete next.resultJson;
						return next;
					}),
				});
			};
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
				changeHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				applyCalls++;
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement === 'string') currentText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				get isDirty() { return false; },
				save: async () => { saveCalls++; return true; },
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(invalidation.isSubscribed());
			assert.ok(changeHandler);
			applyCalls = 0;
			currentText = wrap('STALE_REPAIR', '{"rows":[[1]]}');
			gateRepair = true;
			invalidation.fire();
			await waitForCondition(() => stalePublicationStarted, 'queued stale repair sanitation should start');

			currentText = wrap('DIRECT_NEWER');
			await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
			releaseSecondStalePublication();
			const queue = [...(provider as any).markdownDocumentQueues.values()][0];
			await queue.tail;
			assert.strictEqual(newerPublicationStarted, false);
			assert.strictEqual(applyCalls, 0, 'policy reconciliation must not rewrite saved source bytes');
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'DIRECT_NEWER');
			assert.strictEqual(saveCalls, 0, 'policy reconciliation must not autosave the newer source');
		} finally {
			releaseSecondStalePublication();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich invalidation does not overwrite an external source that wins during policy reconciliation', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-rich-repair-apply-race-'));
		const sourcePath = path.join(tmpDir, 'repair.kqlx');
		const wrap = (query: string, resultJson?: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_1', type: 'query', query, ...(resultJson ? { resultJson } : {}),
			}] },
		}, null, 2) + '\n';
		let currentText = wrap('REPAIR_ME', '{"rows":[[1]]}');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let changeHandler: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
		let markRepairApplyStarted!: () => void;
		let releaseRepairApply!: () => void;
		const repairApplyStarted = new Promise<void>(resolve => { markRepairApplyStarted = resolve; });
		const repairApplyGate = new Promise<void>(resolve => { releaseRepairApply = resolve; });
		let delayRepair = false;
		let externalRepairPublished = false;
		let saveCalls = 0;
		try {
			fs.writeFileSync(sourcePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				if (delayRepair && String(state?.sections?.[0]?.query || '') === 'REPAIR_ME') {
					delayRepair = false;
					markRepairApplyStarted();
					await repairApplyGate;
				}
				if (String(state?.sections?.[0]?.query || '') === 'EXTERNAL_AUTHORITY') {
					externalRepairPublished = true;
				}
				return publish({
					...state,
					sections: state.sections.map((section: any) => {
						const next = { ...section };
						delete next.resultJson;
						return next;
					}),
				});
			};
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
				changeHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				get isDirty() { return false; }, save: async () => { saveCalls++; return true; },
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(invalidation.isSubscribed() && changeHandler);
			currentText = wrap('REPAIR_ME', '{"rows":[[1]]}');
			delayRepair = true;
			invalidation.fire();
			await repairApplyStarted;

			currentText = wrap('EXTERNAL_AUTHORITY');
			await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
			releaseRepairApply();
			const queue = [...(provider as any).markdownDocumentQueues.values()][0];
			await queue.tail;
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'EXTERNAL_AUTHORITY');
			assert.strictEqual(externalRepairPublished, false);
			assert.strictEqual(saveCalls, 0);
		} finally {
			releaseRepairApply();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('policy reconciliation queues a Transformation command without rewriting saved results', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-privacy-transform-queue-'));
		const filePath = path.join(tmpDir, 'privacy-transform.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', resultJson: 'PROTECTED_SQL_RESULT' },
				{
					id: 'transform_1', type: 'transformation', name: 'Before',
					dataSourceId: 'sql_1', transformationType: 'select',
				},
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		let repairEnabled = false;
		let markRepairStarted!: () => void;
		let releaseRepair!: () => void;
		const repairStarted = new Promise<void>(resolve => { markRepairStarted = resolve; });
		const repairGate = new Promise<void>(resolve => { releaseRepair = resolve; });
		let gateRepair = true;
		let diskText = currentText;
		let dirty = false;
		let saveCalls = 0;
		let commandSettledBeforeDurability = false;
		let replaceSourceAfterFirstSave = true;
		const changeHandlers: Array<(event: vscode.TextDocumentChangeEvent) => unknown> = [];
		const posted: any[] = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
				changeHandlers.push(handler);
				return { dispose() {} };
			};
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				if (!repairEnabled) return publish(state);
				if (gateRepair) {
					gateRepair = false;
					markRepairStarted();
					await repairGate;
				}
				return publish({
					...state,
					sections: state.sections.map((section: any) => {
						const next = { ...section };
						if (next.type === 'sql') delete next.resultJson;
						return next;
					}),
				});
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				dirty = currentText !== diskText;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				get isDirty() { return dirty; },
				save: async () => {
					saveCalls++;
					if (saveCalls === 1) {
						if (replaceSourceAfterFirstSave) {
							replaceSourceAfterFirstSave = false;
							const replacement = JSON.parse(currentText);
							replacement.state.sections.find((section: any) => section.id === 'sql_1').resultJson = 'NEW_PROTECTED';
							currentText = JSON.stringify(replacement);
							dirty = true;
							for (const changeHandler of changeHandlers) {
								await Promise.resolve(changeHandler({ document, contentChanges: [{}] } as any));
							}
						}
						return false;
					}
					diskText = currentText;
					dirty = false;
					return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(projection && invalidation.isSubscribed());

			diskText = currentText;
			dirty = false;
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), currentText);
			repairEnabled = true;
			invalidation.fire();
			await repairStarted;
			let commandSettled = false;
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'transform-during-privacy-repair',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'transform_1',
					expectedSectionRevision: projection.sectionRevisions.transform_1,
					patch: { name: 'After' },
				},
			})).then(() => {
				commandSettledBeforeDurability = JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections
					.find((section: any) => section.id === 'sql_1').resultJson !== undefined;
				commandSettled = true;
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(commandSettled, false, 'Transformation command must queue behind privacy repair');
			releaseRepair();
			await command;

			const finalSections = JSON.parse(currentText).state.sections;
			assert.strictEqual(finalSections.find((section: any) => section.id === 'sql_1').resultJson, 'PROTECTED_SQL_RESULT');
			let commandResult = posted.find(message => message?.commandId === 'transform-during-privacy-repair');
			const queue = [...(provider as any).markdownDocumentQueues.values()][0];
			await queue.tail;
			assert.strictEqual(saveCalls, 0);
			assert.strictEqual(commandSettledBeforeDurability, true);
			assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections
				.find((section: any) => section.id === 'sql_1').resultJson, 'PROTECTED_SQL_RESULT');
			if (commandResult?.ok !== true) {
				await queue.tail;
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await waitForCondition(
					() => Number(projection?.sourceGeneration) > Number(commandResult?.sourceGeneration),
					'privacy replacement should publish a newer command owner',
				);
				const commandProjection = projection;
				await Promise.resolve(receiveHandler!({
					type: 'markdownDocumentCommand', commandId: 'transform-after-privacy-replacement',
					sourceGeneration: commandProjection.sourceGeneration,
					expectedDocumentRevision: commandProjection.documentRevision,
					command: {
						type: 'patch', sectionId: 'transform_1',
						expectedSectionRevision: commandProjection.sectionRevisions.transform_1,
						patch: { name: 'After' },
					},
				}));
				commandResult = posted.find(message => message?.commandId === 'transform-after-privacy-replacement');
			}
			assert.strictEqual(commandResult?.ok, true);
			assert.strictEqual(JSON.parse(currentText).state.sections
				.find((section: any) => section.id === 'transform_1').name, 'After');
		} finally {
			releaseRepair?.();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('policy reconciliation does not auto-save or rewrite an existing durable result', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-privacy-safe-replacement-'));
		const filePath = path.join(tmpDir, 'privacy-safe.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', resultJson: 'PROTECTED' },
				{
					id: 'transform_1', type: 'transformation', name: 'Before',
					dataSourceId: 'sql_1', transformationType: 'select',
				},
			] },
		});
		let diskText = currentText;
		let dirty = false;
		let saveCalls = 0;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		const changeHandlers: Array<(event: vscode.TextDocumentChangeEvent) => unknown> = [];
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
				changeHandlers.push(handler);
				return { dispose() {} };
			};
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish({
				...state,
				sections: state.sections.map((section: any) => {
					const next = { ...section };
					if (next.type === 'sql') delete next.resultJson;
					return next;
				}),
			});
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				dirty = currentText !== diskText;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				get isDirty() { return dirty; },
				save: async () => {
					saveCalls++;
					if (saveCalls === 1) {
						const replacement = JSON.parse(currentText);
						const sql = replacement.state.sections.find((section: any) => section.id === 'sql_1');
						delete sql.resultJson;
						sql.query = 'SELECT 2 AS safe_edit';
						currentText = JSON.stringify(replacement);
						dirty = true;
						for (const changeHandler of changeHandlers) {
							await Promise.resolve(changeHandler({ document, contentChanges: [{}] } as any));
						}
						return false;
					}
					diskText = currentText;
					dirty = false;
					return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(invalidation.isSubscribed());
			diskText = currentText;
			dirty = false;
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), currentText);
			invalidation.fire();
			const queue = [...(provider as any).markdownDocumentQueues.values()][0];
			await queue.tail;
			assert.strictEqual(saveCalls, 0);
			assert.strictEqual(dirty, false);
			assert.strictEqual(JSON.parse(currentText).state.sections
				.find((section: any) => section.id === 'sql_1').resultJson, 'PROTECTED');
			assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections
				.find((section: any) => section.id === 'sql_1').resultJson, 'PROTECTED');
		} finally {
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(vscode.Uri.file(filePath), 1_000);
			invalidation.restore();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('policy reconciliation during a held projection preserves source bytes before commands', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-privacy-held-projection-'));
		const filePath = path.join(tmpDir, 'privacy-held.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', resultJson: 'PROTECTED' },
				{
					id: 'transform_1', type: 'transformation', name: 'Before',
					dataSourceId: 'sql_1', transformationType: 'select',
				},
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		let holdNextReload = false;
		let heldReload: any;
		let repairEnabled = false;
		const posted: any[] = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(repairEnabled ? {
				...state,
				sections: state.sections.map((section: any) => {
					const next = { ...section };
					if (next.type === 'sql') delete next.resultJson;
					return next;
				}),
			} : state);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				save: async () => {
					fs.writeFileSync(filePath, currentText, 'utf8');
					return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							if (holdNextReload) {
								holdNextReload = false;
								heldReload = message;
							} else await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(projection && invalidation.isSubscribed());
			holdNextReload = true;
			const heldRequest = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!heldReload, 'same-source projection should wait for acknowledgement');

			repairEnabled = true;
			invalidation.fire();
			assert.ok(currentText.includes('PROTECTED'));
			const oldRequestId = heldReload.reloadRequestId;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: oldRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await heldRequest;
			assert.ok(projection?.state?.sections?.some((section: any) => section.resultJson === 'PROTECTED'));

			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'after-held-privacy-repair',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'transform_1',
					expectedSectionRevision: projection.sectionRevisions.transform_1,
					patch: { name: 'After' },
				},
			}));
			const commandResult = posted.find(message => message?.commandId === 'after-held-privacy-repair');
			assert.strictEqual(commandResult?.ok, true, JSON.stringify(commandResult));
			assert.strictEqual(JSON.parse(currentText).state.sections
				.find((section: any) => section.id === 'transform_1').name, 'After');
		} finally {
			invalidation.restore();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native policy invalidation fences reload with the last accepted edit revision', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-policy-edit-revision-'));
		const filePath = path.join(tmpDir, 'revision.kqlx');
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [{ id: 'query_1', type: 'query', query: 'print Value=1' }] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.expectedEditRevision ?? 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'revision-3', sourceGeneration, editRevision: 3,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'print Value=1' }] },
			}));
			posted.length = 0;
			invalidation.fire();
			await waitForCondition(
				() => posted.some(message => message?.type === 'documentData'),
				'policy invalidation should request a fenced reload',
			);
			const reload = posted.find(message => message?.type === 'documentData');
			assert.strictEqual(reload.expectedEditRevision, 3);
		} finally {
			invalidation.restore();
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('shared compatibility projection coordinator keeps B authoritative after a late A acknowledgement', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query',
				primaryId: 'compat_primary_query', sidecarKind: 'kqlx',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql',
				primaryId: 'compat_primary_sql', sidecarKind: 'sqlx',
			},
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-projection-coordinator-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			for (const [index, variant] of variants.entries()) {
				let currentText = 'A';
				const sourcePath = path.join(tmpDir, `source-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.sidecarKind,
					version: 1,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}, null, 2) + '\n', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				const held: any[] = [];
				let holdProjection = false;
				let coordinatorCreations = 0;
				let projectionCalls = 0;
				let persistAdmissionCalls = 0;
				(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
					didSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					return true;
				};
				const coordinatorFactory = (options: any) => {
					coordinatorCreations++;
					const coordinator = new CompatSidecarProjectionCoordinator(options) as any;
					const project = coordinator.project.bind(coordinator);
					const admitPersist = coordinator.admitPersist.bind(coordinator);
					coordinator.project = (...args: any[]) => {
						projectionCalls++;
						return project(...args);
					};
					coordinator.admitPersist = (...args: any[]) => {
						persistAdmissionCalls++;
						return admitPersist(...args);
					};
					return coordinator;
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					undefined, undefined, coordinatorFactory,
				);
				const lines = () => currentText.split(/\r?\n/);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
					get lineCount() { return lines().length; },
					lineAt: (line: number) => ({ text: lines()[line] || '' }),
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as vscode.TextDocument;
				const panel = {
					visible: true,
					webview: {
						options: {},
						postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								if (holdProjection) {
									holdProjection = false;
									held.push(message);
								} else {
									await Promise.resolve(receiveHandler?.({
										type: 'documentReloadResult', requestId: message.reloadRequestId,
										applied: true, editRevision: Number(message.editRevision || 0),
									}));
								}
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: () => ({ dispose() {} }),
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				holdProjection = true;
				const requestA = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await waitForCondition(() => held.length === 1, `${variant.extension} should hold projection A`);
				const projectionA = held[0];

				currentText = 'B';
				holdProjection = true;
				const requestB = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await waitForCondition(() => held.length === 2, `${variant.extension} should hold projection B`);
				const projectionB = held[1];
				await Promise.resolve(receiveHandler!({
					type: 'documentReloadResult', requestId: projectionA.reloadRequestId,
					applied: true, editRevision: 50,
				}));
				await requestA;

				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `stale-a-${index}`,
					sourceGeneration: projectionA.sourceGeneration, editRevision: 51,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, query: 'A_STALE' },
						{ id: 'markdown_1', type: 'markdown', text: 'A_MUST_NOT_PUBLISH' },
					] },
				}));
				assert.strictEqual(currentText, 'B');
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === `stale-a-${index}`));
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('A_MUST_NOT_PUBLISH'));

				await Promise.resolve(receiveHandler!({
					type: 'documentReloadResult', requestId: projectionB.reloadRequestId,
					applied: true, editRevision: 2,
				}));
				await requestB;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `current-b-${index}`,
					sourceGeneration: projectionB.sourceGeneration, editRevision: 3,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, query: 'B' },
						{ id: 'markdown_1', type: 'markdown', text: 'B_AUTHORITATIVE' },
					] },
				}));
				await waitForCondition(() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === `current-b-${index}`), `${variant.extension} should acknowledge B`);
				assert.ok(didSaveHandler);
				await Promise.resolve(didSaveHandler!(document));
				await waitForCondition(() => fs.readFileSync(sidecarPath, 'utf8').includes('B_AUTHORITATIVE'),
					`${variant.extension} should publish only B sidecar state`);
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('A_MUST_NOT_PUBLISH'));
				assert.strictEqual(currentText, 'B');
				assert.strictEqual(coordinatorCreations, 1, `${variant.extension} should create one projection coordinator`);
				assert.ok(projectionCalls >= 3, `${variant.extension} should route every projection through the coordinator`);
				assert.strictEqual(persistAdmissionCalls, 2, `${variant.extension} should route both snapshots through shared admission`);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidSaveTextDocument = originalDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	async function checkFirstPublicCompatibilityActivation(
		sourceText: string,
		holdAcknowledgement: boolean,
		ownedEditLanguage?: 'KQL' | 'SQL',
		overlappingOwnedEdits: boolean | 'external-between-writes' | 'metadata-only-B' = false,
	): Promise<void> {
		const prototype = (QueryEditorProvider as any).prototype;
		const scopedInitialize = prototype.initializeWebviewPanel;
		const scopedHandle = prototype.handleWebviewMessage;
		const originalExecuteCommand = vscode.commands.executeCommand;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const scopedDidChange = vscode.workspace.onDidChangeTextDocument;
		const sourceChanges = new vscode.EventEmitter<vscode.TextDocumentChangeEvent>();
		const isKql = ownedEditLanguage === 'KQL';
		const providerClass = isKql ? KqlCompatEditorProvider : SqlCompatEditorProvider;
		const primaryType = isKql ? 'query' : 'sql';
		const primaryId = isKql ? 'compat_primary_query' : 'compat_primary_sql';
		let sourceVersion = 1;
		let sourceDirty = false;
		const extensionModule = require('../../src/host/extension');
		const originalOrchestratorExport = Object.getOwnPropertyDescriptor(extensionModule, 'toolOrchestrator')!;
		const originalSingleton = Object.getOwnPropertyDescriptor(KustoWorkbenchToolOrchestrator, 'instance')!;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-first-public-compat-activation-'));
		const sourcePath = path.join(tmpDir, isKql ? 'first.kql' : 'first.sql');
		const sourceUri = vscode.Uri.file(sourcePath);
		const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../../..'));
		const subscriptions: vscode.Disposable[] = [];
		const secretChanges = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
		const cancellation = new vscode.CancellationTokenSource();
		const createMemento = () => {
			const values = new Map<string, unknown>();
			return {
				get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
				update: async (key: string, value: unknown) => { values.set(key, value); },
				keys: () => [...values.keys()], setKeysForSync: () => undefined,
			};
		};
		const context = {
			subscriptions, extensionUri, extensionPath: extensionUri.fsPath,
			extensionMode: overlappingOwnedEdits ? vscode.ExtensionMode.Production : vscode.ExtensionMode.Test,
			extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(extensionUri.fsPath, 'package.json'), 'utf8')) },
			globalState: createMemento(), workspaceState: createMemento(),
			globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global')),
			storageUri: vscode.Uri.file(path.join(tmpDir, 'storage')),
			logUri: vscode.Uri.file(path.join(tmpDir, 'logs')),
			asAbsolutePath: (relative: string) => path.join(extensionUri.fsPath, relative),
			secrets: {
				get: async () => undefined, store: async () => undefined, delete: async () => undefined,
				onDidChange: secretChanges.event,
			},
		} as unknown as vscode.ExtensionContext;
		let document = {
			uri: sourceUri, getText: () => sourceText, isClosed: false,
			get version() { return sourceVersion; }, get isDirty() { return sourceDirty; },
			eol: vscode.EndOfLine.LF, get lineCount() { return sourceText.split('\n').length; },
			lineAt: (line: number) => ({ text: sourceText.split('\n')[line] ?? '' }),
			positionAt: (offset: number) => {
				const lines = sourceText.slice(0, offset).split('\n');
				return new vscode.Position(lines.length - 1, lines.at(-1)!.length);
			},
		} as vscode.TextDocument;
		const posted: any[] = [];
		const received: any[] = [];
		const projections: any[] = [];
		const acknowledged = new Set<string>();
		const inboundWork = new Set<Promise<unknown>>();
		const transportErrors: unknown[] = [];
		const openCalls: Array<{ uri: vscode.Uri; editorId: string }> = [];
		const snapshots: Array<{ requestId: string; applied: boolean; error?: string }> = [];
		const reconciliations: Array<{ applied: boolean; sections: unknown[]; fromToolSnapshot: boolean }> = [];
		const pendingStateReplies: any[] = [];
		const projectionSettlements: Array<{ generation: number; applied: boolean }> = [];
		const disposalHandlers = new Set<() => unknown>();
		const viewHandlers = new Set<() => unknown>();
		const runtimeId = 'first-public-compatibility-runtime';
		const loadingError = 'This document is still loading and has no executable sections yet.';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let queryEditor: QueryEditorProvider | undefined;
		let coordinator: CompatSidecarProjectionCoordinator | undefined;
		let closeCoordinator: CompatSidecarCloseCoordinator | undefined;
		let session: CompatSidecarSession | undefined;
		let runtimeProjection: any;
		let runtimeApplied = false;
		let holdProjection = holdAcknowledgement;
		let panelDisposed = false;
		let initialRequest: Promise<unknown> | undefined;
		let activation: ReturnType<KustoWorkbenchToolOrchestrator['activateWorkbenchFile']> | undefined;
		let firstResult: Awaited<NonNullable<typeof activation>> | undefined;
		let firstSettledAt: number | undefined;
		let initialConnection: any;
		let coordinatorCreations = 0;
		let settlingToolSnapshot = false;
		let holdStateReply = false;
		let capturedReadiness: unknown;
		let capturedSnapshotIdentity: unknown;
		const sourceWrites: Array<{ previousText: string; nextText: string; version: number }> = [];
		let releaseFirstOwnedWrite!: () => void;
		const firstOwnedWrite = new Promise<void>(resolve => { releaseFirstOwnedWrite = resolve; });
		const send = (message: any): Promise<unknown> => {
			assert.ok(receiveHandler, 'setup: the actual startup gateway must install its receiver');
			received.push(message);
			const work = Promise.resolve(receiveHandler(message));
			inboundWork.add(work);
			void work.then(() => inboundWork.delete(work), error => {
				transportErrors.push(error);
				inboundWork.delete(work);
			});
			return work;
		};
		const acknowledge = async (projection: any): Promise<void> => {
			if (acknowledged.has(projection.reloadRequestId)) return;
			runtimeProjection = projection;
			runtimeApplied = true;
			const response = parseCompatibilityPersistenceWebviewMessage({
				protocolVersion: projection.protocolVersion, channel: projection.channel,
				viewSessionId: projection.viewSessionId, type: 'documentReloadResult',
				requestId: projection.reloadRequestId, applied: true, editRevision: projection.editRevision,
			}, isKql ? 'kql' : 'sql');
			assert.ok(response.ok, 'setup: the current projection ACK must pass canonical compatibility admission');
			acknowledged.add(projection.reloadRequestId);
			await send(response.value);
		};
		const panel = {
			viewType: providerClass.viewType, visible: true, active: true, reveal: () => undefined,
			webview: {
				options: {}, html: '', cspSource: 'vscode-webview://first-public-compatibility',
				asWebviewUri: (uri: vscode.Uri) => uri,
				postMessage: async (message: any) => {
					posted.push(message);
					if (message.type === 'documentData' && message.ok === true) {
						projections.push(message);
						if (!holdProjection) await acknowledge(message);
					} else if (message.type === 'mainWebviewDispatcherProbe') {
						assert.ok(message.probeId, 'setup: dispatcher probes must carry their actual ID');
						if (!runtimeApplied) {
							const bootstrap = getCompatibilityPersistenceTestBootstrap(panel)!;
							void send({
								...bootstrap, type: 'requestDocument',
								requestId: `dispatcher-document-${message.probeId}`, expectedEditRevision: 0,
							});
							}
						void send({ type: 'mainWebviewDispatcherReady', runtimeId, probeId: message.probeId });
					} else if (message.type === 'requestToolState') {
						const error = runtimeApplied ? undefined : loadingError;
						const response = createToolStateResponseMessage(
							message.requestId, runtimeApplied ? runtimeProjection.state.sections : [], error,
						);
						assert.ok(response.ok, 'setup: the real state waiter must receive a canonical response');
						snapshots.push({ requestId: message.requestId, applied: runtimeApplied, error });
						if (holdStateReply) pendingStateReplies.push(response.value);
						else void send(response.value);
					}
					return true;
				},
				onDidReceiveMessage: (handler: (message: any) => unknown) => {
					receiveHandler = handler;
					return new vscode.Disposable(() => { if (receiveHandler === handler) receiveHandler = undefined; });
				},
			},
			onDidDispose: (handler: () => unknown) => {
				disposalHandlers.add(handler);
				return new vscode.Disposable(() => { disposalHandlers.delete(handler); });
			},
			onDidChangeViewState: (handler: () => unknown) => {
				viewHandlers.add(handler);
				return new vscode.Disposable(() => { viewHandlers.delete(handler); });
			},
			dispose: () => {
				if (panelDisposed) return;
				panelDisposed = true;
				for (const handler of [...disposalHandlers]) handler();
			},
		} as unknown as vscode.WebviewPanel;

		try {
			fs.writeFileSync(sourcePath, sourceText, 'utf8');
			const sourceBytes = fs.readFileSync(sourcePath);
			if (overlappingOwnedEdits) {
				document = await vscode.workspace.openTextDocument(sourceUri);
				sourceText = document.getText();
				sourceVersion = document.version;
				sourceDirty = document.isDirty;
				subscriptions.push(scopedDidChange(event => {
					if (event.document.uri.toString() !== sourceUri.toString()) return;
					sourceText = event.document.getText();
					sourceVersion = event.document.version;
					sourceDirty = event.document.isDirty;
					sourceChanges.fire(event);
				}));
			}
			const initialSourceVersion = document.version;
			if (ownedEditLanguage) {
				(vscode.workspace as any).onDidChangeTextDocument = sourceChanges.event;
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const entries = edit.entries().filter(([uri]) => uri.toString() === sourceUri.toString());
					if (entries.length === 0) return originalApplyEdit(edit);
					assert.strictEqual(entries.length, 1);
					assert.strictEqual(entries[0][1].length, 1);
					const replacement = entries[0][1][0];
					assert.ok(replacement.range.start.isEqual(new vscode.Position(0, 0)));
					assert.ok(replacement.range.end.isEqual(document.positionAt(sourceText.length)),
						'the actual owned edit must replace the current source range');
					const previousText = sourceText;
					if (overlappingOwnedEdits) {
						assert.strictEqual(await originalApplyEdit(edit), true, 'setup: the actual SDK must physically apply the owned WorkspaceEdit');
						sourceText = document.getText();
						sourceVersion = document.version;
						sourceDirty = document.isDirty;
					} else {
						sourceText = replacement.newText;
						sourceVersion++;
						sourceDirty = true;
						sourceChanges.fire({ document, contentChanges: [{ range: replacement.range,
							rangeOffset: 0, rangeLength: replacement.range.end.character, text: sourceText }], reason: undefined });
					}
					sourceWrites.push({ previousText, nextText: sourceText, version: sourceVersion });
					if (overlappingOwnedEdits && sourceWrites.length === 1) await firstOwnedWrite;
					return true;
				};
			}
			const connections = connectionManagerStub();
			const sqlWorkbench = sqlWorkbenchStub();
			(KustoWorkbenchToolOrchestrator as any).instance = undefined;
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
				context, connections, () => sqlWorkbench.connectionManager, {} as any,
			);
			extensionModule.toolOrchestrator = orchestrator;
			prototype.handleWebviewMessage = originalHandle;
			prototype.initializeWebviewPanel = async function (this: QueryEditorProvider, targetPanel: vscode.WebviewPanel, options: any) {
				assert.strictEqual(targetPanel, panel);
				queryEditor = this;
				capturedReadiness = (this as any).workbenchToolMutationReadiness;
				capturedSnapshotIdentity = (this as any).workbenchToolSnapshotIdentity;
				registerCompatibilityPersistenceTestBootstrap(targetPanel, options.compatibilityPersistence);
				const toolSession = (this as any).workbenchToolSessionApplication;
				const settleStateRequest = toolSession.settleStateRequest;
				toolSession.settleStateRequest = function (...args: any[]) {
					const previous = settlingToolSnapshot;
					settlingToolSnapshot = true;
					try { return settleStateRequest.apply(this, args); }
					finally { settlingToolSnapshot = previous; }
				};
				const lifecycle = (this as any).sqlLifecycle;
				const reconcile = lifecycle.reconcileComparisonOwners;
				lifecycle.reconcileComparisonOwners = (...args: any[]) => {
					reconciliations.push({ applied: runtimeApplied, sections: args[0], fromToolSnapshot: settlingToolSnapshot });
					return reconcile.apply(lifecycle, args);
				};
				await originalInitializeWebviewPanel.call(this, targetPanel, options);
			};
			deferMainWebviewReadyForTest(panel);
			const provider = new (providerClass as any)(
				context, extensionUri, connections, sqlWorkbench, undefined,
				(options: any) => {
					session = options.session;
					closeCoordinator = new CompatSidecarCloseCoordinator(options);
					return closeCoordinator;
				},
				(options: any) => {
					coordinatorCreations++;
					assert.strictEqual(options.session, session);
					coordinator = new CompatSidecarProjectionCoordinator({
						...options,
						onProjectionSettled: async (attempt, applied) => {
							const result = await options.onProjectionSettled?.(attempt, applied);
							projectionSettlements.push({ generation: attempt.generation, applied });
							return result;
						},
					});
					return coordinator;
				},
			) as SqlCompatEditorProvider | KqlCompatEditorProvider;
			(vscode.commands as any).executeCommand = async (command: string, ...args: any[]) => {
				if (command !== 'vscode.openWith') return originalExecuteCommand(command, ...args);
				assert.strictEqual(args[0].toString(), sourceUri.toString());
				assert.strictEqual(args[1], providerClass.viewType);
				if (ownedEditLanguage && openCalls.length > 0) {
					assert.strictEqual((queryEditor as any).panel, panel);
					assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
					assert.strictEqual(panelDisposed, false);
					openCalls.push({ uri: args[0], editorId: args[1] });
					return;
				}
				assert.strictEqual(openCalls.length, 0, 'the first public activation must open this fixture exactly once');
				openCalls.push({ uri: args[0], editorId: args[1] });
				await provider.resolveCustomTextEditor(document, panel, cancellation.token);
				assert.ok(panel.webview.html.includes('data-kusto-document-loading="true"'),
					'setup: real asset-backed initialization must begin in the production loading state');
				const bootstrap = getCompatibilityPersistenceTestBootstrap(panel)!;
				assert.ok(bootstrap?.viewSessionId, 'setup: real initialization must expose the panel session identity');
				initialConnection = [...(orchestrator as any).liveConnections.values()][0];
				assert.strictEqual(initialConnection.documentUri, sourceUri.toString());
				initialRequest = send({ ...bootstrap, type: 'requestDocument', requestId: 'first-public-compatibility-document', expectedEditRevision: 0 });
				await send({ type: 'mainWebviewDispatcherReady', runtimeId });
				await waitForCondition(() => projections.length > 0, 'setup: the real provider must physically post documentData', 750);
				if (!holdAcknowledgement) await initialRequest;
			};
			const startedAt = Date.now();
			activation = orchestrator.activateWorkbenchFile({ targetFileUri: sourceUri.toString() }).then(result => {
				firstResult = result;
				firstSettledAt = Date.now();
				return result;
			});
			try {
				await waitForCondition(() => projections.length > 0 || firstSettledAt !== undefined,
					'setup: the first URI-only public call must reach its compatibility projection', 750);
			} catch (error) {
				if (overlappingOwnedEdits) console.log('[overlapping owned source compatibility parent]', JSON.stringify({
					phase: 'first-public-before-projection', language: ownedEditLanguage,
					activationSettled: firstSettledAt !== undefined, firstResult: firstResult ?? null,
					coordinatorCreations, initialized: coordinator?.isInitialized ?? null,
					activeGeneration: coordinator?.activeSourceGeneration ?? null, sourceWrites: sourceWrites.length,
					postedTypes: posted.map(message => message.type), receivedTypes: received.map(message => message.type),
					stateRequests: snapshots.length, pendingIngress: inboundWork.size,
				}));
				throw error;
			}
			assert.ok(projections.length > 0, `setup: activation did not project: ${JSON.stringify(firstResult)}`);
			for (let turn = 0; turn < 32; turn++) await new Promise<void>(resolve => setImmediate(resolve));
			await new Promise<void>(resolve => setTimeout(resolve, 25));
			const beforeAck = {
				settled: firstSettledAt !== undefined, result: firstResult,
				elapsedMs: firstSettledAt === undefined ? undefined : firstSettledAt - startedAt,
				initialized: coordinator!.isInitialized, activeGeneration: coordinator!.activeSourceGeneration,
				snapshots: [...snapshots], reconciliations: reconciliations.filter(entry => entry.fromToolSnapshot).length,
			};
			assert.strictEqual(coordinatorCreations, 1);
			assert.strictEqual((queryEditor as any).panel, panel);
			assert.strictEqual((queryEditor!.workbenchToolSessionApplication as any).connectionToken, initialConnection.token);
			assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
			assert.strictEqual(openCalls.length, 1);
			assert.strictEqual(openCalls[0].uri.toString(), sourceUri.toString());
			for (const projection of projections) {
				assert.strictEqual(projection.documentUri, sourceUri.toString());
				assert.strictEqual(projection.viewSessionId, getCompatibilityPersistenceTestBootstrap(panel)!.viewSessionId);
				assert.strictEqual(projection.state.sections[0].type, primaryType);
				assert.strictEqual(projection.state.sections[0].id, primaryId);
				assert.strictEqual(projection.state.sections[0].query, sourceText);
			}
			const probes = posted.filter(message => message.type === 'mainWebviewDispatcherProbe');
			assert.ok(probes.length > 0, 'setup: activation must use real dispatcher revalidation');
			for (const probe of probes) {
				assert.ok(received.some(message => message.type === 'mainWebviewDispatcherReady'
					&& message.probeId === probe.probeId && message.runtimeId === runtimeId));
				if (holdAcknowledgement) assert.ok(received.some(message => message.type === 'requestDocument'
					&& message.requestId === `dispatcher-document-${probe.probeId}`));
			}
			if (holdAcknowledgement) {
				assert.strictEqual(beforeAck.initialized, false);
				assert.strictEqual(beforeAck.activeGeneration, 0);
				assert.strictEqual(acknowledged.size, 0);
				assert.strictEqual(projectionSettlements.length, 0);
			}
			assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
			assert.strictEqual(document.getText(), sourceText);
			assert.strictEqual(document.version, initialSourceVersion);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(fs.existsSync(`${sourcePath}.json`), false);
			holdProjection = false;
			await acknowledge(projections.at(-1));
			await initialRequest;
			await waitForCondition(() => coordinator!.isInitialized && firstSettledAt !== undefined,
				'the current projection and the same first activation must settle after canonical ACK', 750);
			const result = await activation;
			assert.strictEqual(coordinator!.activeSourceGeneration, projections.at(-1).sourceGeneration);
			assert.ok(projectionSettlements.some(value => value.applied && value.generation === coordinator!.activeSourceGeneration));
			assert.strictEqual(session!.currentEditRevision, projections.at(-1).editRevision);
			assert.deepStrictEqual(transportErrors, []);
			assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
			assert.strictEqual(document.version, initialSourceVersion);
			assert.strictEqual(document.isDirty, false);
			console.log('[first public compatibility activation]', JSON.stringify({
				sourceText, holdAcknowledgement, beforeAck, result,
				postedTypes: posted.map(message => message.type), acceptedGeneration: coordinator!.activeSourceGeneration,
			}));
			if (holdAcknowledgement) {
				if (beforeAck.settled) assert.ok(beforeAck.elapsedMs! < 1_000, 'the observed failure must be loading, not a tool timeout');
				assert.strictEqual(beforeAck.settled, false,
					`first public activation must await accepted current projection and canonical commit; observed ${JSON.stringify(beforeAck)}`);
				assert.deepStrictEqual(beforeAck.snapshots, [], 'no tool snapshot may precede the current projection ACK');
				assert.strictEqual(beforeAck.reconciliations, 0, 'SQL reconciliation must not precede the current projection ACK');
			}
			assert.strictEqual(result.success, true, `the same first activation must succeed after ACK: ${JSON.stringify(result)}`);
			assert.ok(snapshots.length > 0);
			assert.ok(snapshots.every(snapshot => snapshot.applied && snapshot.error === undefined));
			assert.ok(reconciliations.some(entry => entry.fromToolSnapshot));
			if (overlappingOwnedEdits) {
				const originalText = sourceText;
				const acceptedGeneration = coordinator!.activeSourceGeneration;
				const initialProjectionCount = projections.length;
				const identity = () => (queryEditor as any).workbenchToolSnapshotIdentity();
				const beforeEditIdentity = identity();
				const ownedTexts = isKql ? ['print Value=2;\n', 'print Value=3;\n'] : ['SELECT 2 AS Value;\n', 'SELECT 3 AS Value;\n'];
				if (overlappingOwnedEdits === 'metadata-only-B') ownedTexts[1] = ownedTexts[0];
				const nativeTexts = ownedTexts.map(text => document.eol === vscode.EndOfLine.CRLF
					? text.replace(/\n/g, '\r\n') : text);
				const nodeMetadata = { opaqueText: ' \t\r\n ', nested: { empty: '', enabled: false, values: [null, 0, 'opaque'] } };
				holdStateReply = true;
				let oldSnapshotSettled = false;
				const oldSnapshot = initialConnection.stateGetter().then((value: unknown) => { oldSnapshotSettled = true; return value; });
				await waitForCondition(() => pendingStateReplies.length === 1,
					'the actual tool getter must hold the original source-version snapshot before A', 750);
				const rejectOldSnapshot = async (): Promise<void> => {
					assert.strictEqual(oldSnapshotSettled, false, 'the old snapshot must remain live until its late reply, not expire first');
					const previousReconciliations = reconciliations.filter(entry => entry.fromToolSnapshot).length;
					holdStateReply = false;
					await send(pendingStateReplies.shift());
					assert.strictEqual(await oldSnapshot, undefined, 'the changed source version must reject the old reply even under the same projection generation');
					assert.strictEqual(reconciliations.filter(entry => entry.fromToolSnapshot).length, previousReconciliations,
						'the old reply must be fenced before SQL owner reconciliation');
				};
				const persist = (text: string, editRevision: number, snapshotId?: string): Promise<unknown> => {
					const state = { ...runtimeProjection.state, sections: runtimeProjection.state.sections.map((section: any, index: number) =>
						index === 0 ? { ...section, query: text,
							nodeMetadata: overlappingOwnedEdits === 'metadata-only-B' ? { ...nodeMetadata, editRevision } : nodeMetadata } : section) };
					runtimeProjection = { ...runtimeProjection, state, editRevision };
					const parsed = parseCompatibilityPersistenceWebviewMessage({
						...getCompatibilityPersistenceTestBootstrap(panel), type: 'persistDocument',
						sourceGeneration: acceptedGeneration, editRevision, state,
						...(snapshotId === undefined ? {} : { snapshotId }),
					}, isKql ? 'kql' : 'sql');
					assert.ok(parsed.ok, 'both overlapping snapshots must enter through canonical compatibility admission');
					return send(parsed.value);
				};
				const firstPersist = persist(ownedTexts[0], 1, 'overlapping-owned-source-first');
				await waitForCondition(() => sourceWrites.length === 1, 'the actual first applyEdit must physically write A and remain pending', 750);
				const firstPersistGeneration = session!.generation;
				const secondPersist = persist(ownedTexts[1], 2, 'overlapping-owned-source-latest');
				await waitForCondition(() => session!.generation > firstPersistGeneration,
					'B must supersede A through the actual session while A applyEdit is pending', 750);
				assert.strictEqual(sourceWrites.length, 1, 'B must not unlock the physical source queue while A is pending');
				await send({ ...getCompatibilityPersistenceTestBootstrap(panel), type: 'documentReloadResult',
					requestId: projections[0].reloadRequestId, applied: true, editRevision: 1 });
				assert.strictEqual(sourceWrites.length, 1, 'a late old projection ACK must not unlock A or run B early');
				assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
				if (overlappingOwnedEdits === 'external-between-writes') {
					holdProjection = true;
					const externalText = isKql ? 'print ExternalValue=4;\n' : 'SELECT 4 AS ExternalValue;\n';
					const externalEdit = new vscode.WorkspaceEdit();
					externalEdit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), externalText);
					assert.strictEqual(await originalApplyEdit(externalEdit), true, 'setup: the SDK must physically apply external E between A and B');
					const exactExternalText = document.getText();
					await waitForCondition(() => projections.length > initialProjectionCount,
						'the real external source event must retire the old projection owner', 750);
					releaseFirstOwnedWrite();
					await Promise.all([firstPersist, secondPersist]);
					assert.deepStrictEqual(sourceWrites, [{ previousText: originalText, nextText: nativeTexts[0], version: initialSourceVersion + 1 }]);
					assert.strictEqual(document.getText(), exactExternalText, 'neither the superseded A nor queued B may overwrite external E');
					assert.strictEqual(document.version, initialSourceVersion + 2);
					assert.deepStrictEqual(posted.filter(message => message.type === 'persistDocumentAck'), []);
					await rejectOldSnapshot();
					const stateRequestsBeforeRejectedRead = snapshots.length;
					assert.strictEqual(await (capturedReadiness as () => Promise<boolean>)(), false);
					assert.strictEqual(await initialConnection.stateGetter(), undefined);
					assert.strictEqual(snapshots.length, stateRequestsBeforeRejectedRead, 'external drift must be rejected before a tool snapshot can reconcile owners');
					assert.strictEqual(await coordinator!.adoptOwnedSourceText(acceptedGeneration, originalText, exactExternalText), false);
					assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
					assert.strictEqual(coordinatorCreations, 1);
					assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
					assert.strictEqual(fs.existsSync(`${sourcePath}.json`), false);
					assert.deepStrictEqual(transportErrors, []);
					console.log('[overlapping owned source compatibility negative]', JSON.stringify({
						language: ownedEditLanguage, sourceWrites, externalText: exactExternalText,
						version: document.version, readiness: false, retainedOwner: true, acknowledgedSnapshots: [],
					}));
					return;
				}
				releaseFirstOwnedWrite();
				await Promise.all([firstPersist, secondPersist]);
				const expectedWrites = [{ previousText: originalText, nextText: nativeTexts[0], version: initialSourceVersion + 1 }];
				if (overlappingOwnedEdits !== 'metadata-only-B') {
					expectedWrites.push({ previousText: nativeTexts[0], nextText: nativeTexts[1], version: initialSourceVersion + 2 });
				}
				assert.deepStrictEqual(sourceWrites, expectedWrites, 'every exact source-only owned write must be verified before the readiness oracle');
				assert.strictEqual(document.getText(), nativeTexts[1]);
				assert.strictEqual(session!.currentStateEditRevision, 2);
				assert.deepStrictEqual(posted.filter(message => message.type === 'persistDocumentAck'), [
					{ ...getCompatibilityPersistenceTestBootstrap(panel), type: 'persistDocumentAck',
						snapshotId: 'overlapping-owned-source-latest', editRevision: 2 },
				]);
				assert.strictEqual(coordinator!.activeSourceGeneration, acceptedGeneration);
				assert.strictEqual(projections.length, initialProjectionCount);
				assert.notStrictEqual(identity(), beforeEditIdentity, 'the source-version snapshot fence must advance for B');
				assert.strictEqual((queryEditor as any).workbenchToolMutationReadiness, capturedReadiness);
				assert.strictEqual((queryEditor as any).workbenchToolSnapshotIdentity, capturedSnapshotIdentity);
				assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
				assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
				assert.strictEqual(fs.existsSync(`${sourcePath}.json`), false);
				await rejectOldSnapshot();
				const ready = await (capturedReadiness as () => Promise<boolean>)();
				console.log('[overlapping owned source compatibility]', JSON.stringify({
					language: ownedEditLanguage, sourceWrites, readiness: ready,
					acknowledgedSnapshots: posted.filter(message => message.type === 'persistDocumentAck'),
					activeGeneration: coordinator!.activeSourceGeneration, projectionGeneration: coordinator!.currentProjectionGeneration,
					stateEditRevision: session!.currentStateEditRevision,
				}));
				assert.strictEqual(ready, true, `${ownedEditLanguage} readiness must accept B after its verified overlapping owned source commit`);
				const latestSections = await initialConnection.stateGetter();
				assert.strictEqual(latestSections?.[0]?.query, ownedTexts[1]);
				assert.deepStrictEqual(JSON.parse(JSON.stringify(latestSections?.[0]?.nodeMetadata)),
					overlappingOwnedEdits === 'metadata-only-B' ? { ...nodeMetadata, editRevision: 2 } : nodeMetadata);
				const reactivated = await orchestrator.activateWorkbenchFile({ targetFileUri: sourceUri.toString() });
				assert.strictEqual(reactivated.success, true, `latest overlapping owned source must remain usable: ${JSON.stringify(reactivated)}`);
				assert.strictEqual(coordinatorCreations, 1);
				assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
				assert.deepStrictEqual(transportErrors, []);
			}
			if (ownedEditLanguage && !overlappingOwnedEdits) {
				const acceptedGeneration = coordinator!.activeSourceGeneration;
				const initialProjectionCount = projections.length;
				const ownedTexts = isKql ? ['print Value=2;\n', 'print Value=3;\n'] : ['SELECT 2 AS Value;\n', 'SELECT 3 AS Value;\n'];
				const identity = () => (queryEditor as any).workbenchToolSnapshotIdentity();
				for (const [index, text] of ownedTexts.entries()) {
					const beforeEditIdentity = identity();
					const generationBeforeStateEffects = coordinator!.activeSourceGeneration;
					const state = { ...runtimeProjection.state, sections: runtimeProjection.state.sections.map((section: any, sectionIndex: number) =>
						sectionIndex === 0 ? { ...section, query: text } : section) };
					runtimeProjection = { ...runtimeProjection, state, editRevision: index + 1 };
					await send({ ...getCompatibilityPersistenceTestBootstrap(panel), type: 'persistDocument',
						snapshotId: `owned-source-${index + 1}`, sourceGeneration: generationBeforeStateEffects,
						editRevision: index + 1, state });
					assert.strictEqual(document.getText(), text);
					assert.strictEqual(document.version, initialSourceVersion + index + 1);
					assert.strictEqual(document.isDirty, true);
					assert.strictEqual(session!.currentStateEditRevision, index + 1);
					assert.ok(posted.some(message => message.type === 'persistDocumentAck'
						&& message.snapshotId === `owned-source-${index + 1}` && message.editRevision === index + 1));
					assert.strictEqual(coordinator!.activeSourceGeneration, acceptedGeneration);
					assert.strictEqual(projections.length, initialProjectionCount, 'owned edits must not manufacture another projection');
					assert.notStrictEqual(identity(), beforeEditIdentity, 'the captured source-version fence must advance');
					assert.strictEqual((queryEditor as any).workbenchToolMutationReadiness, capturedReadiness);
					assert.strictEqual((queryEditor as any).workbenchToolSnapshotIdentity, capturedSnapshotIdentity);
					const sections = await initialConnection.stateGetter();
					assert.strictEqual(sections?.[0]?.query, text, 'the current actual state getter must accept the owned text');
					const reactivated = await orchestrator.activateWorkbenchFile({ targetFileUri: sourceUri.toString() });
					assert.strictEqual(reactivated.success, true, `owned-edit public reactivation failed: ${JSON.stringify(reactivated)}`);
					assert.strictEqual(openCalls.length, index + 2, 'each explicit public activation must issue one exact SDK reveal');
					assert.strictEqual(coordinatorCreations, 1, 'explicit reactivation must retain the original coordinator');
					assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
					assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes, 'buffer persistence must not rewrite the original durable baseline');
				}
				holdStateReply = true;
				const staleRead = initialConnection.stateGetter();
				await waitForCondition(() => pendingStateReplies.length === 1, 'the actual getter must capture the pre-drift snapshot', 750);
				const reconciliationsBeforeDrift = reconciliations.filter(entry => entry.fromToolSnapshot).length;
				const previousSourceIdentity = identity();
				holdProjection = true;
				sourceText = isKql ? 'print ExternalValue=4;\n' : 'SELECT 4 AS ExternalValue;\n';
				sourceVersion++;
				sourceChanges.fire({ document, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0),
					rangeOffset: 0, rangeLength: 0, text: sourceText }], reason: undefined });
				assert.notStrictEqual(identity(), previousSourceIdentity);
				await send(pendingStateReplies.shift());
				assert.strictEqual(await staleRead, undefined, 'external drift must reject the old captured snapshot');
				assert.strictEqual(reconciliations.filter(entry => entry.fromToolSnapshot).length, reconciliationsBeforeDrift,
					'the stale snapshot must be fenced before SQL state effects');
				await waitForCondition(() => projections.length > initialProjectionCount, 'external drift must request a current projection', 750);
				assert.strictEqual(coordinator!.activeSourceGeneration, acceptedGeneration);
				assert.ok(coordinator!.currentProjectionGeneration > acceptedGeneration);
				assert.strictEqual(await coordinator!.adoptOwnedSourceText(acceptedGeneration, ownedTexts[1], sourceText), false,
					'external drift must not be adopted as an owned commit');
				holdStateReply = false;
				holdProjection = false;
				await acknowledge(projections.at(-1));
				await waitForCondition(() => coordinator!.activeSourceGeneration === projections.at(-1).sourceGeneration,
					'only the new external projection ACK may replace the accepted owner', 750);
				assert.strictEqual((await initialConnection.stateGetter())?.[0]?.query, sourceText);
				assert.deepStrictEqual(transportErrors, []);
				assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
			}
		} finally {
			releaseFirstOwnedWrite();
			holdStateReply = false;
			holdProjection = false;
			if (receiveHandler) for (const projection of projections) await acknowledge(projection);
			panel.dispose();
			queryEditor?.disposePanel(panel);
			await closeCoordinator?.disposePanel();
			await Promise.all([...inboundWork]);
			await activation;
			for (const subscription of subscriptions) subscription.dispose();
			secretChanges.dispose();
			sourceChanges.dispose();
			cancellation.dispose();
			liveDocuments.retire(document);
			prototype.initializeWebviewPanel = scopedInitialize;
			prototype.handleWebviewMessage = scopedHandle;
			(vscode.commands as any).executeCommand = originalExecuteCommand;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = scopedDidChange;
			Object.defineProperty(extensionModule, 'toolOrchestrator', originalOrchestratorExport);
			Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', originalSingleton);
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	test('first public compatibility activation succeeds for an already-applied blank SQL projection', async () => {
		await checkFirstPublicCompatibilityActivation('', false);
	});

	for (const [label, sourceText] of [
		['blank', ''], ['whitespace', ' \t\n '], ['nonblank', 'SELECT 1 AS Value;\n'],
	]) {
		test(`first public compatibility activation waits for the current ${label} SQL projection ACK and commit`, async () => {
			await checkFirstPublicCompatibilityActivation(sourceText, true);
		});
	}

	for (const language of ['KQL', 'SQL'] as const) {
		test(`overlapping owned source compatibility preserves latest readiness for ${language}`, async () => {
			await checkFirstPublicCompatibilityActivation('original source\n', false, language, true);
		});
		for (const [label, text] of [['blank', ''], ['whitespace', ' \t\r\n ']]) {
			test(`overlapping owned source compatibility preserves latest readiness for ${label} ${language}`, async () => {
				await checkFirstPublicCompatibilityActivation(text, false, language, true);
			});
		}
		test(`overlapping owned source compatibility rejects external drift between writes for ${language}`, async function () {
			this.timeout(15_000);
			await checkFirstPublicCompatibilityActivation('original source\n', false, language, 'external-between-writes');
		});
		test(`overlapping owned source compatibility preserves readiness for metadata-only B ${language}`, async () => {
			await checkFirstPublicCompatibilityActivation('original source\n', false, language, 'metadata-only-B');
		});
		for (const [label, text] of [['blank', ''], ['whitespace', ' \t\n '], ['nonblank', 'original source\n']]) {
			test(`owned source compatibility lifecycle preserves getters and public reactivation for ${label} ${language}`, async () => {
				await checkFirstPublicCompatibilityActivation(text, false, language);
			});
		}
	}

	async function checkFirstPublicNativeActivation(
		queueRecovery: boolean,
		readinessBoundary?: 'held delivery' | 'deadline' | 'elapsed deadline' | 'disposed' | 'construction disposal',
		diagnosticMode?: 'throwing sink' | 'bounded transitions',
		sourceEnding: '' | '\n' | '\r\n' = '',
		heldAdmission: boolean | 'activation tail' = false,
		admissionBoundary?: 'coalesced deadline',
	): Promise<void> {
		const heldActivationTail = heldAdmission === 'activation tail';
		const prototype = (QueryEditorProvider as any).prototype;
		const scopedInitialize = prototype.initializeWebviewPanel;
		const scopedHandle = prototype.handleWebviewMessage;
		const originalExecuteCommand = vscode.commands.executeCommand;
		const extensionModule = require('../../src/host/extension');
		const originalOrchestratorExport = Object.getOwnPropertyDescriptor(extensionModule, 'toolOrchestrator')!;
		const originalSingleton = Object.getOwnPropertyDescriptor(KustoWorkbenchToolOrchestrator, 'instance')!;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-first-public-native-activation-'));
		const sourcePath = path.join(tmpDir, 'first.kqlx');
		const sourceUri = vscode.Uri.file(sourcePath);
		const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../../..'));
		const subscriptions: vscode.Disposable[] = [];
		const restorations: Array<() => void> = [];
		const secretChanges = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
		const cancellation = new vscode.CancellationTokenSource();
		const createMemento = () => {
			const values = new Map<string, unknown>();
			return {
				get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
				update: async (key: string, value: unknown) => { values.set(key, value); },
				keys: () => [...values.keys()], setKeysForSync: () => undefined,
			};
		};
		const context = {
			subscriptions, extensionUri, extensionPath: extensionUri.fsPath,
			extensionMode: vscode.ExtensionMode.Test,
			extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(extensionUri.fsPath, 'package.json'), 'utf8')) },
			globalState: createMemento(), workspaceState: createMemento(),
			globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global')),
			storageUri: vscode.Uri.file(path.join(tmpDir, 'storage')),
			logUri: vscode.Uri.file(path.join(tmpDir, 'logs')),
			asAbsolutePath: (relative: string) => path.join(extensionUri.fsPath, relative),
			secrets: {
				get: async () => undefined, store: async () => undefined, delete: async () => undefined,
				onDidChange: secretChanges.event,
			},
		} as unknown as vscode.ExtensionContext;
		const sourceText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_native_activation', type: 'query', query: 'print Value=1' },
			{ id: 'markdown_native_activation', type: 'markdown', text: 'Synthetic native activation fixture.' },
		] } }, null, 2) + sourceEnding;
		const document = {
			uri: sourceUri, getText: () => sourceText, version: 1, isDirty: false, isClosed: false,
			eol: vscode.EndOfLine.LF, lineCount: sourceText.split('\n').length,
			lineAt: (line: number) => ({ text: sourceText.split('\n')[line] ?? '' }),
			positionAt: (offset: number) => {
				const lines = sourceText.slice(0, offset).split('\n');
				return new vscode.Position(lines.length - 1, lines.at(-1)!.length);
			},
		} as vscode.TextDocument;
		const posted: any[] = [];
		const received: any[] = [];
		const projections: any[] = [];
		const acknowledged = new Set<string>();
		const inboundWork = new Set<Promise<unknown>>();
		const transportErrors: unknown[] = [];
		const openCalls: Array<{ uri: vscode.Uri; editorId: string }> = [];
		const recoveryRequests: string[] = [];
		const pendingStateReplies: any[] = [];
		const snapshots: Array<{ requestId: string; applied: boolean; sourceGeneration?: number; error?: string }> = [];
		const admissions: Array<{ captured: unknown; current: unknown; accepted: boolean }> = [];
		const reconciliations: Array<{ sourceGeneration?: number; fromToolSnapshot: boolean }> = [];
		const disposalHandlers = new Set<() => unknown>();
		const viewHandlers = new Set<() => unknown>();
		const runtimeId = 'first-public-native-runtime';
		const loadingError = 'This document is still loading and has no executable sections yet.';
		const startedAt = Date.now();
		let receiveHandler: ((message: any) => unknown) | undefined;
		let queryEditor: QueryEditorProvider | undefined;
		let initialConnection: any;
		let runtimeProjection: any;
		let runtimeApplied = false;
		let holdProjection = true;
		let holdStateReply = queueRecovery;
		let panelDisposed = false;
		let settlingToolSnapshot = false;
		let initialRequest: Promise<unknown> | undefined;
		let activation: ReturnType<KustoWorkbenchToolOrchestrator['activateWorkbenchFile']> | undefined;
		let firstResult: Awaited<NonNullable<typeof activation>> | undefined;
		let firstSettledAt: number | undefined;
		let reactivationResult: boolean | undefined;
		let capturedReadiness: (() => Promise<boolean>) | undefined;
		let capturedReadinessWork: Promise<boolean> | undefined;
		let capturedReadinessResult: boolean | undefined;
		let capturedReadinessSettlements = 0;
		const readinessErrors: unknown[] = [];
		const originalReadinessPromises: Promise<boolean>[] = [];
		const diagnosticEvents: Array<{ event: string; detail: Record<string, number | boolean> }> = [];
		let diagnosticFaultsThrown = 0;
		let captureReadinessDeadline = false;
		const readinessTimers: Array<{
			handle: ReturnType<typeof setTimeout>; delay: number; expire: () => void; cleared: boolean;
		}> = [];
		let releaseSdkDelivery!: () => void;
		const sdkDelivery = new Promise<void>(resolve => { releaseSdkDelivery = resolve; });
		let releaseConstruction!: () => void;
		const construction = new Promise<void>(resolve => { releaseConstruction = resolve; });
		let constructionEntered = false;
		let actualInitialization: Promise<void> | undefined;
		let admissionEnteredAt: number | undefined;
		let secondAdmissionEnteredAt: number | undefined;
		let admissionInvocationCount = 0;
		let heldAckWork: Promise<void> | undefined;
		let secondAckWork: Promise<void> | undefined;
		let replacementRequest: Promise<unknown> | undefined;
		let cleanupStarted = false;
		const sourceAdmissionResults: boolean[] = [];
		const reloadReservations: Array<{
			session: CompatSidecarSession; requestId: string; deadline: number; createdAt: number; settled?: boolean;
		}> = [];
		const reloadClaims: Array<{ requestId: string; claimedAt: number; accepted: boolean }> = [];
		const admittedRequestClocks: Array<{ requestId: string; admittedAt: number }> = [];
		let ownerClock = 0;
		let releaseAdmission!: () => void;
		const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
		let releaseSecondAdmission!: () => void;
		const secondAdmissionGate = new Promise<void>(resolve => { releaseSecondAdmission = resolve; });
		const identity = () => (queryEditor as any)?.workbenchToolSnapshotIdentity?.();
		const stage = (name: string, detail: Record<string, unknown> = {}) => {
			console.log('[tests/integration/kqlSidecar.test.ts:first public native activation]', JSON.stringify({
				stage: name, queueRecovery, readinessBoundary, elapsedMs: Date.now() - startedAt, fixtureUri: sourceUri.toString(),
				documentVersion: document.version, panelCurrent: (queryEditor as any)?.panel === panel,
				connectionToken: (queryEditor?.workbenchToolSessionApplication as any)?.connectionToken,
				transportIdentity: (queryEditor as any)?.messageTransportIdentity?.(),
				projectionObservationIdentity: identity(), runtimeApplied,
				runtimeSourceGeneration: runtimeProjection?.sourceGeneration,
				projectionGenerations: projections.map(message => message.sourceGeneration),
				acknowledged: [...acknowledged], ...detail,
			}));
		};
		const admissionObservation = () => Object.freeze({
			projectionCount: projections.length, recoveryCount: recoveryRequests.length,
			snapshotCount: snapshots.length, toolRequestCount: posted.filter(message => message.type === 'requestToolState').length,
			ackCount: acknowledged.size, admissionResults: Object.freeze([...sourceAdmissionResults]),
			firstSettled: firstSettledAt !== undefined, firstSuccess: firstResult?.success ?? null,
			panelCurrent: (queryEditor as any)?.panel === panel,
			connectionToken: (queryEditor?.workbenchToolSessionApplication as any)?.connectionToken,
			documentVersion: document.version, sourceCurrent: document.getText() === sourceText,
			runtimeId, runtimeSourceGeneration: runtimeProjection?.sourceGeneration,
		});
		const observe = async (name: string, detail: Record<string, unknown> = {}) => {
			const initialized = await KqlxEditorProvider.waitForOpenEditorInitialized(sourceUri, 0, panel);
			stage(name, { initialized, settled: firstSettledAt !== undefined, result: firstResult, ...detail });
			return { initialized, settled: firstSettledAt !== undefined, result: firstResult, identity: identity(),
				snapshots: [...snapshots], admissions: [...admissions],
				toolRequests: posted.filter(message => message.type === 'requestToolState'),
				toolReconciliations: reconciliations.filter(entry => entry.fromToolSnapshot) };
		};
		const wrapLocal = (owner: any, key: string, wrapper: (original: any) => any) => {
			const descriptor = Object.getOwnPropertyDescriptor(owner, key);
			assert.strictEqual(typeof owner[key], 'function', `setup: actual ${key} must be accessible for passive tracing`);
			owner[key] = wrapper(owner[key]);
			restorations.push(() => {
				if (descriptor) Object.defineProperty(owner, key, descriptor);
				else delete owner[key];
			});
		};
		const assertReadinessDiagnostics = (observed: boolean): void => {
			assert.ok(diagnosticEvents.some(entry => entry.event === 'readiness.start' && entry.detail.stateAvailable === false),
				'construction-entry diagnostics must not read owner variables before initialization');
			assert.ok(diagnosticEvents.some(entry => entry.event === 'readiness.settled' && entry.detail.observed === observed),
				'diagnostics must observe the actual boolean returned by the native waiter');
			assert.ok(diagnosticEvents.length <= 128);
			const allowedFields = new Set(['panelDisposed', 'stateAvailable', 'activeProjectionGeneration', 'postDocumentGeneration',
				'admittedDocumentRequests', 'pendingDocumentProjections', 'pendingProjectionActivationSize', 'initialRecovery',
				'pendingRecovery', 'sourceObservationSequence', 'elapsedMs', 'observed', 'diagnosticRecordCount',
				'diagnosticRecordLimit', 'diagnosticTerminalReserve', 'diagnosticTruncated', 'diagnosticSuppressedCount',
				'matchingActivation', 'applied', 'generation', 'accepted', 'completed', 'sourceAdmissionThrew',
				'ownerCommitConflict', 'retryEligible', 'retrySourceCurrent', 'remainingAttempts']);
			for (const [index, entry] of diagnosticEvents.entries()) {
				assert.strictEqual(entry.detail.diagnosticRecordCount, index + 1);
				assert.strictEqual(entry.detail.diagnosticRecordLimit, 128);
				assert.strictEqual(entry.detail.diagnosticTerminalReserve, 2);
				for (const [key, value] of Object.entries(entry.detail)) {
					assert.ok(allowedFields.has(key), `unexpected diagnostic field: ${key}`);
					assert.ok(typeof value === 'number' || typeof value === 'boolean', `non-scalar diagnostic field: ${key}`);
				}
			}
			if (diagnosticMode === 'throwing sink') assert.strictEqual(diagnosticFaultsThrown, diagnosticEvents.length);
		};
		const send = (message: any): Promise<unknown> => {
			assert.ok(receiveHandler, 'setup: the actual native startup gateway must install its receiver');
			if (admissionBoundary === 'coalesced deadline' && message.type === 'requestDocument') {
				if (String(message.requestId).startsWith('dispatcher-document-')) ownerClock = 2_000;
				admittedRequestClocks.push({ requestId: message.requestId, admittedAt: performance.now() });
			}
			received.push(message);
			const work = Promise.resolve(receiveHandler(message));
			inboundWork.add(work);
			void work.then(() => inboundWork.delete(work), error => {
				transportErrors.push(error);
				inboundWork.delete(work);
			});
			return work;
		};
		const acknowledge = async (projection: any): Promise<void> => {
			if (acknowledged.has(projection.reloadRequestId)) return;
			runtimeProjection = projection;
			runtimeApplied = true;
			const response = parseDocumentViewWebviewMessage({
				protocolVersion: projection.protocolVersion, channel: projection.channel,
				viewSessionId: projection.viewSessionId, type: 'documentReloadResult',
				requestId: projection.reloadRequestId, applied: true, editRevision: Number(projection.editRevision || 0),
			});
			assert.ok(response.ok, 'setup: native ACK must pass the canonical document-view parser');
			acknowledged.add(projection.reloadRequestId);
			stage('runtime.ACK.sent', { sourceGeneration: projection.sourceGeneration, reloadRequestId: projection.reloadRequestId });
			await send(response.value);
			stage('host.ACK.handler.completed', { sourceGeneration: projection.sourceGeneration });
		};
		const panel = {
			viewType: KqlxEditorProvider.viewType, visible: true, active: true,
			webview: {
				options: {}, html: '', cspSource: 'vscode-webview://first-public-native',
				asWebviewUri: (uri: vscode.Uri) => uri,
				postMessage: async (message: any) => {
					posted.push(message);
					if (message.type === 'documentData') {
						const parsed = parseDocumentViewHostMessage(message);
						assert.ok(parsed.ok, 'setup: the native provider must emit a canonical document-view projection');
						assert.strictEqual(message.ok, true, `setup: native fixture projection failed: ${JSON.stringify(message)}`);
						projections.push(message);
						stage('host.documentData.delivered', { sourceGeneration: message.sourceGeneration, requestId: message.requestId,
							viewSessionId: message.viewSessionId, sectionIds: message.state.sections.map((section: any) => section.id) });
						if (!holdProjection) await acknowledge(message);
						if (readinessBoundary && readinessBoundary !== 'construction disposal' && projections.length === 2) {
							await sdkDelivery;
						}
						if (admissionBoundary === 'coalesced deadline' && projections.length === 1) await sdkDelivery;
					} else if (message.type === 'mainWebviewDispatcherProbe') {
						assert.ok(message.probeId, 'setup: native dispatcher probes must carry their actual ID');
						if (queueRecovery && !runtimeApplied && recoveryRequests.length === 0) {
							const projection = projections[0];
							assert.ok(projection?.viewSessionId, 'setup: recovery must use the actual native panel session');
							const requestId = `dispatcher-document-${message.probeId}`;
							recoveryRequests.push(requestId);
							void send({ type: 'requestDocument', requestId, protocolVersion: projection.protocolVersion,
								channel: projection.channel, viewSessionId: projection.viewSessionId });
						}
						stage('runtime.dispatcher.READY', { probeId: message.probeId, runtimeId });
						void send({ type: 'mainWebviewDispatcherReady', runtimeId, probeId: message.probeId });
					} else if (message.type === 'requestToolState') {
						const error = runtimeApplied ? undefined : loadingError;
						const response = createToolStateResponseMessage(
							message.requestId, runtimeApplied ? runtimeProjection.state.sections : [], error,
						);
						assert.ok(response.ok, 'setup: the real native state waiter must receive a canonical response');
						snapshots.push({ requestId: message.requestId, applied: runtimeApplied,
							sourceGeneration: runtimeProjection?.sourceGeneration, error });
						stage('runtime.state.captured', { snapshot: snapshots.at(-1), held: holdStateReply });
						if (holdStateReply) pendingStateReplies.push(response.value);
						else void send(response.value);
					}
					return true;
				},
				onDidReceiveMessage: (handler: (message: any) => unknown) => {
					receiveHandler = handler;
					return new vscode.Disposable(() => { if (receiveHandler === handler) receiveHandler = undefined; });
				},
			},
			onDidDispose: (handler: () => unknown) => {
				disposalHandlers.add(handler);
				return new vscode.Disposable(() => { disposalHandlers.delete(handler); });
			},
			onDidChangeViewState: (handler: () => unknown) => {
				viewHandlers.add(handler);
				return new vscode.Disposable(() => { viewHandlers.delete(handler); });
			},
			dispose: () => {
				if (panelDisposed) return;
				panelDisposed = true;
				for (const handler of [...disposalHandlers]) handler();
			},
		} as unknown as vscode.WebviewPanel;

		try {
			fs.writeFileSync(sourcePath, sourceText, 'utf8');
			const sourceBytes = fs.readFileSync(sourcePath);
			if (admissionBoundary === 'coalesced deadline') wrapLocal(performance, 'now', () => () => ownerClock);
			if (heldAdmission || admissionBoundary === 'coalesced deadline') {
				wrapLocal(CompatSidecarSession.prototype, 'createReloadRequest', original => function (this: CompatSidecarSession,
					...args: Parameters<CompatSidecarSession['createReloadRequest']>) {
					const reload = original.apply(this, args);
					if (args[1]) {
						const reservation = { session: this, requestId: reload.requestId,
							deadline: args[1].absoluteCommitDeadline, createdAt: performance.now(), settled: undefined as boolean | undefined };
						reloadReservations.push(reservation);
						void reload.result.then((value: boolean) => { reservation.settled = value; });
						stage('host.reload.ownerDeadline', { requestId: reservation.requestId,
							operationStartedAt: reservation.deadline - 30_000, absoluteCommitDeadline: reservation.deadline,
							createdAt: reservation.createdAt, remainingMs: reservation.deadline - reservation.createdAt });
					}
					return reload;
				});
				wrapLocal(CompatSidecarSession.prototype, 'claimReloadRequest', original => function (this: CompatSidecarSession, requestId: string) {
					const accepted = original.call(this, requestId);
					reloadClaims.push({ requestId, claimedAt: performance.now(), accepted });
					stage('host.ACK.claimed', reloadClaims.at(-1)!);
					return accepted;
				});
			}
			if (readinessBoundary) {
				wrapLocal(globalThis, 'setTimeout', original => function (this: unknown,
					callback: (...args: any[]) => void, delay?: number, ...args: any[]) {
					const handle = original.call(this, callback, delay, ...args);
					if (captureReadinessDeadline) {
						assert.ok(typeof delay === 'number' && delay > 0 && delay <= 30_000,
							'the native logical waiter must use its original absolute 30-second deadline');
						readinessTimers.push({ handle, delay, expire: () => callback(...args), cleared: false });
					}
					return handle;
				});
				wrapLocal(globalThis, 'clearTimeout', original => function (this: unknown, handle: ReturnType<typeof setTimeout>) {
					const timer = readinessTimers.find(entry => entry.handle === handle);
					if (timer) timer.cleared = true;
					return original.call(this, handle);
				});
				wrapLocal(KqlxEditorProvider, 'waitForOpenEditorInitialized', original => function (this: unknown, ...args: any[]) {
					const previous = captureReadinessDeadline;
					captureReadinessDeadline = args[0]?.toString() === sourceUri.toString() && args[1] === 30_000;
					try {
						const work = original.apply(this, args);
						if (captureReadinessDeadline) originalReadinessPromises.push(work);
						return work;
					}
					finally { captureReadinessDeadline = previous; }
				});
			}
			const connections = connectionManagerStub();
			const sqlWorkbench = sqlWorkbenchStub();
			(KustoWorkbenchToolOrchestrator as any).instance = undefined;
			const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(
				context, connections, () => sqlWorkbench.connectionManager, {} as any,
			);
			extensionModule.toolOrchestrator = orchestrator;
			prototype.handleWebviewMessage = originalHandle;
			prototype.initializeWebviewPanel = async function (this: QueryEditorProvider, targetPanel: vscode.WebviewPanel, options: any) {
				assert.strictEqual(targetPanel, panel);
				queryEditor = this;
				if (heldAdmission) {
					wrapLocal(this, 'commitKustoSourceAdmissionFresh', original => async function (this: QueryEditorProvider,
						...args: Parameters<QueryEditorProvider['commitKustoSourceAdmissionFresh']>) {
						const invocation = ++admissionInvocationCount;
						if (admissionEnteredAt === undefined) {
							admissionEnteredAt = Date.now();
							stage('host.ACK.admission.held', { observation: admissionObservation() });
						}
						if (heldActivationTail && invocation === 2) {
							secondAdmissionEnteredAt = Date.now();
							stage('host.B.ACK.admission.held', { observation: admissionObservation() });
							await secondAdmissionGate;
						} else await admissionGate;
						stage('host.ACK.admission.original.entered', { invocation, heldMs: Date.now() - admissionEnteredAt });
						const accepted = await original.apply(this, args);
						sourceAdmissionResults.push(accepted);
						stage('host.ACK.admission.original.returned', { accepted, observation: admissionObservation() });
						return accepted;
					});
				}
				if (diagnosticMode) {
					wrapLocal(this.fileOpenTrace, 'mark', original => function (this: unknown, ...args: any[]) {
						if (args[0] === 'readiness.start' || args[0] === 'readiness.settled' || args[0] === 'notify.transitions'
							|| ['reload.acknowledgment', 'reload.admission', 'reload.settled', 'reload.failure'].includes(args[0])) {
							diagnosticEvents.push({ event: args[0], detail: args[1] });
							if (diagnosticMode === 'throwing sink') {
								diagnosticFaultsThrown++;
								throw new Error('native diagnostic sink fault');
							}
						}
						return original.apply(this, args);
					});
				}
				capturedReadiness = (this as any).workbenchToolMutationReadiness;
				assert.strictEqual(typeof capturedReadiness, 'function', 'the stable native readiness hook must exist before initialization');
				if (readinessBoundary || diagnosticMode) {
					capturedReadinessWork = capturedReadiness!();
					void capturedReadinessWork.then(value => {
						capturedReadinessResult = value;
						capturedReadinessSettlements++;
					}, error => { readinessErrors.push(error); });
				}
				wrapLocal(this, 'messageTransport', original => function (this: unknown, ...args: any[]) {
					const delivery = original.apply(this, args);
					if (args[0]?.type === 'requestToolState') void Promise.resolve(delivery).then(value => {
						stage('host.messageTransport.returned', { requestId: args[0].requestId, returned: value });
					}, error => { stage('host.messageTransport.rejected', { error: String(error) }); });
					return delivery;
				});
				wrapLocal(this, 'reactivateWorkbenchToolSession', original => function (this: unknown, ...args: any[]) {
					stage('host.reactivate.entered');
					const work = original.apply(this, args);
					void work.then((value: boolean) => {
						reactivationResult = value;
						stage('host.reactivate.returned', { returned: value });
					}, (error: unknown) => { stage('host.reactivate.rejected', { error: String(error) }); });
					return work;
				});
				const toolSession = this.workbenchToolSessionApplication as any;
				wrapLocal(toolSession.options, 'captureStateAdmission', original => function (this: unknown, ...args: any[]) {
					const admission = original.apply(this, args);
					const captured = identity();
					stage('host.captureStateAdmission.captured', { captured });
					return function (this: unknown, ...checks: any[]) {
						const accepted = admission.apply(this, checks);
						admissions.push({ captured, current: identity(), accepted });
						stage('host.captureStateAdmission.returned', admissions.at(-1)!);
						return accepted;
					};
				});
				wrapLocal(toolSession, 'settleStateRequest', original => function (this: unknown, ...args: any[]) {
					const previous = settlingToolSnapshot;
					settlingToolSnapshot = true;
					try { return original.apply(this, args); }
					finally { settlingToolSnapshot = previous; }
				});
				wrapLocal((this as any).sqlLifecycle, 'reconcileComparisonOwners', original => function (this: unknown, ...args: any[]) {
					reconciliations.push({ sourceGeneration: runtimeProjection?.sourceGeneration, fromToolSnapshot: settlingToolSnapshot });
					return original.apply(this, args);
				});
				actualInitialization = originalInitializeWebviewPanel.call(this, targetPanel, options);
				if (readinessBoundary === 'construction disposal') {
					constructionEntered = true;
					await construction;
				}
				return actualInitialization;
			};
			deferMainWebviewReadyForTest(panel);
			const provider = new (KqlxEditorProvider as any)(context, extensionUri, connections, sqlWorkbench) as KqlxEditorProvider;
			(vscode.commands as any).executeCommand = async (command: string, ...args: any[]) => {
				if (command !== 'vscode.openWith') return originalExecuteCommand(command, ...args);
				assert.strictEqual(args[0].toString(), sourceUri.toString());
				assert.strictEqual(args[1], KqlxEditorProvider.viewType);
				assert.strictEqual(openCalls.length, 0, 'the first public native activation must open this fixture exactly once');
				openCalls.push({ uri: args[0], editorId: args[1] });
				await provider.resolveCustomTextEditor(document, panel, cancellation.token);
				if (readinessBoundary === 'construction disposal') return;
				assert.ok(panel.webview.html.includes('data-kusto-document-loading="true"'),
					'setup: native asset-backed initialization must begin in the production loading state');
				initialConnection = [...(orchestrator as any).liveConnections.values()][0];
				assert.strictEqual(initialConnection.documentUri, sourceUri.toString());
				initialRequest = send({ type: 'requestDocument', requestId: 'first-public-native-document' });
				await send({ type: 'mainWebviewDispatcherReady', runtimeId });
				await waitForCondition(() => projections.length === 1, 'setup: the real native provider must physically post projection A', 750);
			};
			stage('fixture.authored', { fixture: 'result-free Query and Markdown; SDK open stub, real host composition' });
			activation = orchestrator.activateWorkbenchFile({ targetFileUri: sourceUri.toString() }).then(result => {
				firstResult = result;
				firstSettledAt = Date.now();
				stage('public.activation.returned', { result, cleanupStarted });
				return result;
			});
			if (readinessBoundary === 'construction disposal') {
				await waitForCondition(() => constructionEntered && capturedReadinessWork !== undefined,
					'setup: initialization must capture the actual native hook before the owner is constructed', 750);
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(capturedReadinessResult, undefined, 'construction must not default to healthy readiness');
				assert.strictEqual(readinessTimers.length, 1);
				assert.ok(readinessTimers[0].delay >= 29_990);
				panel.dispose();
				assert.strictEqual(await capturedReadinessWork, false, 'construction disposal must settle the captured hook false');
				const result = await activation;
				assert.strictEqual(result.isLiveWorkbench, false);
				assert.strictEqual(result.isReadOnlyFallback, true);
				releaseConstruction();
				await actualInitialization;
				assert.strictEqual(capturedReadinessSettlements, 1);
				assert.strictEqual(readinessTimers[0].cleared, true);
				assert.deepStrictEqual(readinessErrors, [], 'construction readiness must not read uninitialized owner variables');
				assert.deepStrictEqual(projections, []);
				assert.deepStrictEqual(snapshots, []);
				assert.deepStrictEqual(admissions, []);
				assert.deepStrictEqual(reconciliations.filter(entry => entry.fromToolSnapshot), []);
				assert.strictEqual(posted.filter(message => message.type === 'requestToolState').length, 0);
				assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
				assert.strictEqual(document.getText(), sourceText);
				assert.strictEqual(document.version, 1);
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(openCalls.length, 1);
				assert.strictEqual(capturedReadinessWork, originalReadinessPromises[0], 'diagnostics must return the original native promise');
				if (diagnosticMode) {
					assertReadinessDiagnostics(false);
					assert.ok(diagnosticEvents.some(entry => entry.event === 'readiness.settled' && entry.detail.panelDisposed === true));
					assert.ok(diagnosticEvents.every(entry => entry.detail.stateAvailable === false));
				}
				return;
			}
			await waitForCondition(() => posted.some(message => message.type === 'mainWebviewDispatcherProbe') || firstSettledAt !== undefined,
				'setup: first URI-only native activation must reach actual dispatcher revalidation', 750);
			assert.strictEqual(projections.length, 1, `setup: first activation did not reach A: ${JSON.stringify(firstResult)}`);
			const beforeA = await observe('A.beforeACK', { snapshots: [...snapshots] });
			assert.strictEqual(recoveryRequests.length, queueRecovery ? 1 : 0);
			if (heldAdmission) {
				assert.strictEqual(queueRecovery, false);
				heldAckWork = acknowledge(projections[0]);
				await waitForCondition(() => admissionEnteredAt !== undefined,
					'setup: the on-time canonical A ACK must reach the actual source-admission owner', 750);
				assert.ok(admissionEnteredAt! - startedAt < 5_000, 'setup: canonical ACK admission must precede the five-second lease expiry');
				if (heldActivationTail) {
					const projectionA = projections[0];
					const probe = posted.find(message => message.type === 'mainWebviewDispatcherProbe');
					assert.ok(probe?.probeId, 'setup: B must use a physically issued dispatcher probe correlation');
					const replacement = {
						type: 'requestDocument', requestId: `dispatcher-document-${probe.probeId}`, expectedEditRevision: 0,
						protocolVersion: projectionA.protocolVersion, channel: projectionA.channel, viewSessionId: projectionA.viewSessionId,
					};
					const replacementAdmittedAt = performance.now();
					replacementRequest = send(replacement);
					await waitForCondition(() => projections.length === 2, 'setup: the real provider must physically deliver B while A commit is held', 750);
					const projectionB = projections[1];
					assert.strictEqual(projectionB.requestId, replacement.requestId, 'B must belong to the separately admitted correlated request');
					secondAckWork = acknowledge(projectionB);
					await waitForCondition(() => reloadClaims.some(claim => claim.requestId === projectionB.reloadRequestId && claim.accepted),
						'the canonical B ACK must reserve before the prior A activation tail settles', 750);
					assert.strictEqual(admissionInvocationCount, 1, 'B source admission must still be behind the physical A activation');
					const reservationB = reloadReservations.find(reservation => reservation.requestId === projectionB.reloadRequestId)!;
					assert.ok(reservationB.deadline >= replacementAdmittedAt + 30_000);
					assert.ok(reservationB.deadline - replacementAdmittedAt < 30_250);
					await new Promise<void>(resolve => setTimeout(resolve, 5_200));
					stage('host.B.ACK.behindActivationTail.afterFiveSeconds', { observation: admissionObservation(),
						pending: reservationB.session.hasPendingReloadRequest(reservationB.requestId), deadline: reservationB.deadline });
					assert.strictEqual(reservationB.settled, undefined, 'B must remain reserved past its arrival window behind A');
					assert.strictEqual(reservationB.session.hasPendingReloadRequest(reservationB.requestId), true);
					assert.strictEqual(projections.length, 2, 'a claimed B ACK must not generate projection C while behind A');
					assert.strictEqual(admissionInvocationCount, 1);
					assert.strictEqual(snapshots.length, 0);
					assert.strictEqual(firstSettledAt, undefined);
					releaseAdmission();
					await heldAckWork;
					await waitForCondition(() => secondAdmissionEnteredAt !== undefined, 'B must enter its own actual commit after A physically settles', 750);
					assert.deepStrictEqual(sourceAdmissionResults, [false], 'superseded A must not commit when its physical admission resumes');
					await new Promise<void>(resolve => setTimeout(resolve, 5_200));
					stage('host.B.ACK.ownAdmission.afterFiveSeconds', { observation: admissionObservation(),
						pending: reservationB.session.hasPendingReloadRequest(reservationB.requestId), deadline: reservationB.deadline });
					assert.strictEqual(reservationB.settled, undefined);
					assert.strictEqual(reservationB.session.hasPendingReloadRequest(reservationB.requestId), true);
					assert.strictEqual(projections.length, 2);
					assert.strictEqual(admissionInvocationCount, 2);
					assert.strictEqual(snapshots.length, 0);
					assert.strictEqual(posted.filter(message => message.type === 'requestToolState').length, 0);
					assert.strictEqual(firstSettledAt, undefined);
					releaseSecondAdmission();
					await secondAckWork;
					await replacementRequest;
					assert.deepStrictEqual(sourceAdmissionResults, [false, true]);
					assert.strictEqual(reservationB.settled, true);
					assert.strictEqual(reloadClaims.filter(claim => claim.requestId === projectionB.reloadRequestId && claim.accepted).length, 1);
				} else {
				const held = admissionObservation();
				await new Promise<void>(resolve => setTimeout(resolve, 5_200));
				const afterDeadline = admissionObservation();
				stage('host.ACK.admission.afterFiveSeconds', { heldMs: Date.now() - admissionEnteredAt!, held, afterDeadline });
				releaseAdmission();
				await heldAckWork;
				stage('host.ACK.admission.released.beforeCleanup', { observation: admissionObservation() });
				assert.strictEqual(held.projectionCount, 1, 'setup: only the physically delivered A projection may enter admission');
				assert.strictEqual(held.ackCount, 1, 'setup: the actual canonical A ACK must already have arrived');
				assert.strictEqual(afterDeadline.projectionCount, held.projectionCount,
					'an on-time ACK must not cause a new projection while canonical host admission is held');
				assert.strictEqual(afterDeadline.recoveryCount, held.recoveryCount,
					'an on-time ACK must not cause recovery while canonical host admission is held');
				assert.strictEqual(afterDeadline.snapshotCount, 0, 'no snapshot may precede canonical admission');
				assert.strictEqual(afterDeadline.toolRequestCount, 0, 'no tool request may precede canonical admission');
				assert.strictEqual(afterDeadline.firstSettled, false, 'the same first activation must remain pending during host admission');
				assert.strictEqual(afterDeadline.panelCurrent, true);
				assert.strictEqual(afterDeadline.connectionToken, held.connectionToken);
				assert.strictEqual(afterDeadline.documentVersion, held.documentVersion);
				assert.strictEqual(afterDeadline.sourceCurrent, true);
				assert.strictEqual(afterDeadline.runtimeId, held.runtimeId);
				assert.strictEqual(afterDeadline.runtimeSourceGeneration, held.runtimeSourceGeneration);
				assert.deepStrictEqual(sourceAdmissionResults, [true],
					'the original canonical admission must commit the same on-time A ACK exactly once after release');
				assert.strictEqual(acknowledged.size, 1);
				}
			} else await acknowledge(projections[0]);
			if (admissionBoundary === 'coalesced deadline') {
				assert.strictEqual(admittedRequestClocks.length, 2, 'the correlated B request must already have joined initial A');
				assert.strictEqual(projections.length, 1, 'B must remain queued behind the actual A SDK promise');
				assert.strictEqual(firstSettledAt, undefined);
				assert.strictEqual(snapshots.length, 0);
				ownerClock = 20_000;
				releaseSdkDelivery();
			}
			await initialRequest;
			await observe('A.afterACK');
			let beforeB: Awaited<ReturnType<typeof observe>> | undefined;
			if (queueRecovery) {
				await waitForCondition(() => projections.length === 2, 'setup: the actual coalesced recovery must deliver projection B', 750);
				if (admissionBoundary === 'coalesced deadline') {
					assert.strictEqual(reloadReservations.length, 2);
					assert.strictEqual(reloadReservations[0].deadline, admittedRequestClocks[0].admittedAt + 30_000);
					assert.strictEqual(reloadReservations[1].deadline, admittedRequestClocks[1].admittedAt + 30_000,
						'joining initial A must not renew the separately admitted B operation deadline');
					assert.strictEqual(reloadReservations[1].deadline, 32_000);
					assert.strictEqual(reloadReservations[1].createdAt, 20_000);
					assert.strictEqual(reloadReservations[1].deadline - reloadReservations[1].createdAt, 12_000);
				}
				for (let turn = 0; turn < 32; turn++) await new Promise<void>(resolve => setImmediate(resolve));
				holdStateReply = false;
				for (const response of pendingStateReplies.splice(0)) await send(response);
				for (let turn = 0; turn < 32; turn++) await new Promise<void>(resolve => setImmediate(resolve));
				await new Promise<void>(resolve => setTimeout(resolve, 25));
				beforeB = await observe('B.beforeACK', { snapshots: [...snapshots], admissions: [...admissions], reactivationResult });
			}
			if (readinessBoundary) {
				assert.strictEqual(queueRecovery, true);
				assert.strictEqual(projections.length, 2);
				assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
				assert.strictEqual(capturedReadiness, (queryEditor as any).workbenchToolMutationReadiness,
					'the same hook captured before initialization must own current readiness');
				assert.strictEqual(capturedReadinessResult, undefined);
				assert.strictEqual(readinessTimers[0].cleared, false,
					'the construction-entry deadline must remain live across all owner rechecks');
				assert.ok(readinessTimers[0].delay >= 29_990);
				const timersBeforeAck = readinessTimers.length;
				if (readinessBoundary !== 'disposed') {
					await acknowledge(projections[1]);
					assert.strictEqual(identity(), `${projections[1].sourceGeneration}:2`,
						'the reentrant canonical B ACK must finish while SDK delivery remains held');
					const held = await observe('B.heldSDK.afterACK');
					assert.strictEqual(held.initialized, false, 'a full projection must settle before advertising readiness');
					assert.strictEqual(held.settled, false);
					assert.deepStrictEqual(held.snapshots, []);
					assert.deepStrictEqual(held.toolRequests, []);
					assert.deepStrictEqual(held.admissions, []);
					assert.deepStrictEqual(held.toolReconciliations, []);
					assert.strictEqual(capturedReadinessResult, undefined);
					assert.strictEqual(readinessTimers.length, timersBeforeAck, 'currentness rechecks must not rearm any logical deadline');
				}
				if (readinessBoundary === 'held delivery') {
					releaseSdkDelivery();
					assert.strictEqual(await capturedReadinessWork, true);
				} else {
					if (readinessBoundary === 'elapsed deadline') {
						wrapLocal(Date, 'now', () => () => startedAt + 31_000);
						releaseSdkDelivery();
					} else if (readinessBoundary === 'disposed') panel.dispose();
					else for (const timer of readinessTimers) if (!timer.cleared) timer.expire();
					assert.strictEqual(await capturedReadinessWork, false,
						'logical deadline or disposal must settle false without cancelling held physical delivery');
					const result = await activation;
					assert.strictEqual(result.success, false);
					assert.strictEqual(reactivationResult, false);
					releaseSdkDelivery();
					await Promise.allSettled([...inboundWork]);
					await acknowledge(projections[1]);
					await new Promise<void>(resolve => setImmediate(resolve));
					assert.strictEqual(capturedReadinessSettlements, 1, 'late physical settlement must not reopen the logical waiter');
					assert.strictEqual(capturedReadinessResult, false);
					assert.ok(readinessTimers.every(timer => timer.cleared));
					assert.deepStrictEqual(readinessErrors, []);
					assert.deepStrictEqual(snapshots, [], 'late delivery or ACK must not post a snapshot after logical failure');
					assert.deepStrictEqual(admissions, []);
					assert.deepStrictEqual(reconciliations.filter(entry => entry.fromToolSnapshot), []);
					assert.strictEqual(posted.filter(message => message.type === 'requestToolState').length, 0);
					assert.strictEqual(projections.length, 2, 'logical retirement must not duplicate or cancel canonical projection work');
					assert.strictEqual(received.filter(message => message.type === 'requestDocument').length, 2);
					assert.deepStrictEqual(transportErrors, []);
					assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
					assert.strictEqual(document.getText(), sourceText);
					assert.strictEqual(document.version, 1);
					assert.strictEqual(document.isDirty, false);
					assert.strictEqual(fs.existsSync(`${sourcePath}.json`), false);
					assert.strictEqual(openCalls.length, 1);
					return;
				}
			}
			if (!heldAdmission) {
				holdProjection = false;
				await acknowledge(projections.at(-1));
			}
			await waitForCondition(() => firstSettledAt !== undefined,
				'the same first public native activation must settle after the latest canonical ACK and commit', 750);
			const result = await activation;
			await observe('latest.afterACK', { result, reactivationResult, snapshots, admissions,
				toolReconciliations: reconciliations.filter(entry => entry.fromToolSnapshot), postedTypes: posted.map(message => message.type) });
			assert.strictEqual((queryEditor as any).panel, panel);
			assert.strictEqual((queryEditor!.workbenchToolSessionApplication as any).connectionToken, initialConnection.token);
			assert.strictEqual((orchestrator as any).liveConnections.get(initialConnection.token), initialConnection);
			assert.strictEqual(openCalls.length, 1);
			assert.strictEqual(received.filter(message => message.type === 'requestDocument').length, queueRecovery || heldActivationTail ? 2 : 1);
			assert.strictEqual(new Set(projections.map(message => message.reloadRequestId)).size, projections.length);
			for (const projection of projections) {
				assert.strictEqual(projection.documentUri, sourceUri.toString());
				assert.strictEqual(projection.viewSessionId, projections[0].viewSessionId);
				assert.deepStrictEqual(projection.state.sections.map((section: any) => [section.id, section.type]),
					[['query_native_activation', 'query'], ['markdown_native_activation', 'markdown']]);
				assert.strictEqual(projection.state.sections[0].query, 'print Value=1');
			}
			for (const probe of posted.filter(message => message.type === 'mainWebviewDispatcherProbe')) {
				assert.strictEqual(received.filter(message => message.type === 'mainWebviewDispatcherReady'
					&& message.probeId === probe.probeId && message.runtimeId === runtimeId).length, 1);
			}
			if (queueRecovery) {
				assert.strictEqual(projections[1].requestId, recoveryRequests[0]);
				assert.ok(projections[1].sourceGeneration > projections[0].sourceGeneration);
				assert.notStrictEqual(beforeB!.identity, beforeA.identity);
			}
			assert.deepStrictEqual(transportErrors, []);
			assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
			assert.strictEqual(document.getText(), sourceText);
			assert.strictEqual(document.version, 1);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(fs.existsSync(`${sourcePath}.json`), false);
			assert.strictEqual(beforeA.initialized, false);
			assert.strictEqual(beforeA.settled, false, `first public native activation must await A: ${JSON.stringify(beforeA)}`);
			for (const observation of [beforeA, ...(beforeB ? [beforeB] : [])]) {
				assert.strictEqual(observation.initialized, false,
					'no unresolved owned projection may advertise tool readiness');
				assert.strictEqual(observation.settled, false,
					`first public native activation must await the latest owned projection ACK and canonical commit: ${JSON.stringify(observation)}`);
				assert.deepStrictEqual(observation.snapshots, [], 'no tool snapshot may precede the latest owned projection ACK');
				assert.deepStrictEqual(observation.toolRequests, [], 'no tool request may precede the latest owned projection ACK');
				assert.deepStrictEqual(observation.admissions, [], 'no state admission may capture the old A owner before B settles');
				assert.deepStrictEqual(observation.toolReconciliations, [], 'SQL reconciliation must not precede the latest owned projection ACK');
			}
			assert.strictEqual(result.success, true, `the same first public native activation must succeed: ${JSON.stringify(result)}`);
			assert.strictEqual(result.isLiveWorkbench, true);
			assert.strictEqual(result.isReadOnlyFallback, false);
			assert.strictEqual(result.uri, sourceUri.toString());
			assert.strictEqual(reactivationResult, true);
			if (heldAdmission) {
				assert.ok(firstSettledAt! - startedAt < 30_000, 'the same first activation must succeed before its original deadline');
				assert.strictEqual(snapshots.length, 1, 'the admitted current owner must supply exactly one current snapshot');
				assert.deepStrictEqual(sourceAdmissionResults, heldActivationTail ? [false, true] : [true]);
				assert.strictEqual(received.filter(message => message.type === 'documentReloadResult').length, heldActivationTail ? 2 : 1);
			}
			assert.ok(snapshots.length > 0);
			assert.strictEqual(snapshots[0].sourceGeneration, projections.at(-1).sourceGeneration,
				'the first snapshot must capture the exact latest B projection, not an applied old A');
			assert.ok(admissions.length > 0);
			assert.strictEqual(Number(String(admissions[0].captured).split(':')[0]), projections.at(-1).sourceGeneration,
				'the first admission must capture the current native source generation');
			assert.ok(admissions.every(entry => entry.captured === identity() && entry.current === identity() && entry.accepted),
				'tool capture and settlement must retain the exact current native owner identity');
			assert.ok(snapshots.every(snapshot => snapshot.applied && snapshot.error === undefined));
			assert.ok(reconciliations.some(entry => entry.fromToolSnapshot));
			if (readinessBoundary) {
				assert.strictEqual(capturedReadinessSettlements, 1);
				assert.strictEqual(readinessTimers[0].cleared, true);
				assert.deepStrictEqual(readinessErrors, []);
				assert.strictEqual(capturedReadinessWork, originalReadinessPromises[0], 'diagnostics must not return an observer chain');
			}
			if (diagnosticMode === 'bounded transitions') {
				const originalSnapshotCount = snapshots.length;
				let initializedMarks = 0;
				wrapLocal(KqlxEditorProvider, 'markOpenEditorInitialized', original => function (this: unknown, ...args: any[]) {
					if (args[0]?.toString() === sourceUri.toString() && args[1] === panel) initializedMarks++;
					return original.apply(this, args);
				});
				const repeatSignal = (index: number) => send({ type: 'requestDocument', requestId: `native-diagnostic-${index}`,
					protocolVersion: projections[0].protocolVersion, channel: projections[0].channel,
					viewSessionId: projections[0].viewSessionId });
				for (let index = 0; index < 80; index++) await repeatSignal(index);
				assert.deepStrictEqual(await Promise.all([capturedReadiness!(), capturedReadiness!()]), [true, true]);
				assert.strictEqual(diagnosticEvents.length, 128, 'two terminal records must remain available after transition truncation');
				for (const terminal of diagnosticEvents.slice(-2)) {
					assert.strictEqual(terminal.event, 'readiness.settled');
					assert.strictEqual(terminal.detail.observed, true);
					assert.strictEqual(terminal.detail.diagnosticTruncated, true);
					assert.ok(typeof terminal.detail.diagnosticSuppressedCount === 'number' && terminal.detail.diagnosticSuppressedCount > 0);
				}
				await repeatSignal(80);
				assert.strictEqual(await capturedReadiness!(), true);
				assert.strictEqual(diagnosticEvents.length, 128);
				assert.ok(initializedMarks >= 81, 'logging exhaustion must never skip native initialization or notification');
				assert.strictEqual(snapshots.length, originalSnapshotCount);
				assert.deepStrictEqual(transportErrors, []);
				assert.deepStrictEqual(fs.readFileSync(sourcePath), sourceBytes);
				assert.strictEqual(document.getText(), sourceText);
				assert.strictEqual(document.version, 1);
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(fs.existsSync(`${sourcePath}.json`), false);
				assert.strictEqual(openCalls.length, 1);
			}
			if (diagnosticMode) assertReadinessDiagnostics(true);
		} finally {
			if (heldAdmission) stage('host.ACK.admission.beforeCleanup', { observation: admissionObservation() });
			cleanupStarted = true;
			releaseAdmission();
			releaseSecondAdmission();
			holdProjection = false;
			holdStateReply = false;
			releaseSdkDelivery();
			releaseConstruction();
			try {
				await heldAckWork;
				await secondAckWork;
				if (receiveHandler) {
					for (const projection of projections) await acknowledge(projection);
					for (const response of pendingStateReplies.splice(0)) await send(response);
				}
				panel.dispose();
				queryEditor?.disposePanel(panel);
				await Promise.allSettled([...inboundWork]);
				await capturedReadinessWork;
				await actualInitialization;
				await activation;
				const closed = await KqlxEditorProvider.waitForOpenEditorsClosed(sourceUri, 1_000);
				stage('cleanup.native.closed', { closed });
			} finally {
				for (const restore of restorations.reverse()) restore();
				for (const subscription of subscriptions) subscription.dispose();
				secretChanges.dispose();
				cancellation.dispose();
				liveDocuments.retire(document);
				prototype.initializeWebviewPanel = scopedInitialize;
				prototype.handleWebviewMessage = scopedHandle;
				(vscode.commands as any).executeCommand = originalExecuteCommand;
				Object.defineProperty(extensionModule, 'toolOrchestrator', originalOrchestratorExport);
				Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', originalSingleton);
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		}
	}

	test('first public native activation succeeds with a stable READY and accepted projection A', async () => {
		await checkFirstPublicNativeActivation(false);
	});

	test('first public native activation keeps an on-time ACK current through host admission', async function () {
		this.timeout(30_000);
		await checkFirstPublicNativeActivation(false, undefined, undefined, '', true);
	});

	test('first public native activation reserves an on-time ACK before the prior activation tail', async function () {
		this.timeout(30_000);
		await checkFirstPublicNativeActivation(false, undefined, undefined, '', 'activation tail');
	});

	test('first public native activation retains the deadline captured before a correlated initial join', async () => {
		await checkFirstPublicNativeActivation(true, undefined, undefined, '', false, 'coalesced deadline');
	});

	test('first public native activation waits for the latest projection after coalesced dispatcher recovery', async () => {
		await checkFirstPublicNativeActivation(true);
	});

	for (const boundary of ['held delivery', 'deadline', 'elapsed deadline', 'disposed', 'construction disposal'] as const) {
		test(`native tool readiness lifetime handles ${boundary} without a late snapshot`, async function () {
			this.timeout(10_000);
			await checkFirstPublicNativeActivation(boundary !== 'construction disposal', boundary);
		});
	}

	for (const boundary of ['held delivery', 'construction disposal'] as const) {
		test(`native tool readiness diagnostics contain throwing sink faults during ${boundary}`, async function () {
			this.timeout(10_000);
			await checkFirstPublicNativeActivation(boundary !== 'construction disposal', boundary, 'throwing sink');
		});
	}
	for (const [label, ending] of [['no final newline', ''], ['LF', '\n'], ['CRLF', '\r\n']] as const) {
		test(`native tool readiness diagnostics bound actual owner signals and preserve ${label} source`, async function () {
			this.timeout(10_000);
			await checkFirstPublicNativeActivation(false, undefined, 'bounded transitions', ending);
		});
	}

	test('shared compatibility persist coordinator gates final snapshot application before effects', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query',
				primaryId: 'compat_primary_query', sidecarKind: 'kqlx', marker: 'KQL_COORDINATED',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql',
				primaryId: 'compat_primary_sql', sidecarKind: 'sqlx', marker: 'SQL_COORDINATED',
			},
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-persist-coordinator-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			for (const [index, variant] of variants.entries()) {
				let currentText = 'A';
				const sourcePath = path.join(tmpDir, `source-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.sidecarKind,
					version: 1,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}, null, 2) + '\n', 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
				let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				let sourceEditCalls = 0;
				let sessionCommitCalls = 0;
				let finalSettlementCalls = 0;
				let coordinatorCreations = 0;
				let coordinatorCalls = 0;
				let releaseCoordinator!: () => void;
				const coordinatorGate = new Promise<void>(resolve => { releaseCoordinator = resolve; });

				(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
					didSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					sourceEditCalls++;
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					return true;
				};
				const closeCoordinatorFactory = (options: any) => {
					const session = options.session as any;
					for (const method of ['adoptRevision', 'setStateRevision', 'setMaterializedDirty'] as const) {
						const original = session[method].bind(session);
						session[method] = (...args: any[]) => {
							sessionCommitCalls++;
							return original(...args);
						};
					}
					const completeFinalPersist = session.completeFinalPersist.bind(session);
					session.completeFinalPersist = (...args: any[]) => {
						const completed = completeFinalPersist(...args);
						if (completed) finalSettlementCalls++;
						return completed;
					};
					return new CompatSidecarCloseCoordinator(options);
				};
				const persistCoordinatorFactory = (options: any) => {
					coordinatorCreations++;
					const Coordinator = require('../../src/host/compatSidecarPersistCoordinator')
						.CompatSidecarPersistCoordinator;
					const coordinator = new Coordinator(options);
					const persist = coordinator.persist.bind(coordinator);
					coordinator.persist = async (...args: any[]) => {
						coordinatorCalls++;
						await coordinatorGate;
						return persist(...args);
					};
					return coordinator;
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					undefined, closeCoordinatorFactory, undefined, persistCoordinatorFactory,
				);
				const lines = () => currentText.split(/\r?\n/);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
					get lineCount() { return lines().length; },
					lineAt: (line: number) => ({ text: lines()[line] || '' }),
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as vscode.TextDocument;
				const panel = {
					visible: true,
					webview: {
						options: {},
						postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: () => ({ dispose() {} }),
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projection = [...posted].reverse().find(message => message?.type === 'documentData' && message?.ok === true);
				assert.ok(projection, `${variant.extension} should publish an initial projection`);
				assert.ok(willSaveHandler, `${variant.extension} should register the existing will-save path`);
				assert.ok(didSaveHandler, `${variant.extension} should register the existing did-save path`);
				const bootstrap = getCompatibilityPersistenceTestBootstrap(panel);
				assert.ok(bootstrap, `${variant.extension} should expose its compatibility envelope`);
				const durableBeforePersist = fs.readFileSync(sidecarPath, 'utf8');
				sourceEditCalls = 0;
				sessionCommitCalls = 0;
				finalSettlementCalls = 0;
				posted.length = 0;

				let saveBarrier!: Promise<unknown>;
				willSaveHandler!({
					document,
					waitUntil: value => { saveBarrier = Promise.resolve(value); },
				} as vscode.TextDocumentWillSaveEvent);
				await waitForCondition(
					() => posted.some(message => message?.type === 'requestFinalPersist'),
					`${variant.extension} should create a real pending final request`,
				);
				const finalRequest = posted.find(message => message?.type === 'requestFinalPersist');
				let saveBarrierSettlements = 0;
				void saveBarrier.then(
					() => { saveBarrierSettlements++; },
					() => { saveBarrierSettlements++; },
				);
				const persistPromise = Promise.resolve(receiveHandler!({
					...bootstrap,
					type: 'persistDocument',
					sourceGeneration: projection.sourceGeneration,
					editRevision: 1,
					snapshotId: `coordinated-${index}`,
					flushRequestId: finalRequest.requestId,
					flush: true,
					reason: 'save',
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, query: 'B' },
						{ id: 'markdown_1', type: 'markdown', text: variant.marker },
					] },
				}));
				await waitForCondition(
					() => coordinatorCalls > 0 || sourceEditCalls > 0 || finalSettlementCalls > 0,
					`${variant.extension} should reach the held persist boundary`,
				);
				await Promise.resolve();
				assert.deepStrictEqual({
					coordinatorCreations,
					coordinatorCalls,
					sourceEditCalls,
					sessionCommitCalls,
					diffPublications: posted.filter(message => message?.type === 'changedSections').length,
					ackAttempts: posted.filter(message => message?.type === 'persistDocumentAck').length,
					finalSettlementCalls,
					saveBarrierSettlements,
					durableChanged: fs.readFileSync(sidecarPath, 'utf8') !== durableBeforePersist,
					currentText,
				}, {
					coordinatorCreations: 1,
					coordinatorCalls: 1,
					sourceEditCalls: 0,
					sessionCommitCalls: 0,
					diffPublications: 0,
					ackAttempts: 0,
					finalSettlementCalls: 0,
					saveBarrierSettlements: 0,
					durableChanged: false,
					currentText: 'A',
				}, `${variant.extension} must not apply a final snapshot before coordinator release`);

				releaseCoordinator();
				await persistPromise;
				await saveBarrier;
				assert.strictEqual(coordinatorCalls, 1, `${variant.extension} should coordinate once`);
				assert.strictEqual(sourceEditCalls, 1, `${variant.extension} should apply one source edit`);
				assert.ok(sessionCommitCalls > 0, `${variant.extension} should commit draft state after release`);
				assert.strictEqual(posted.filter(message => message?.type === 'persistDocumentAck').length, 1,
					`${variant.extension} should attempt one live acknowledgement`);
				assert.strictEqual(finalSettlementCalls, 1, `${variant.extension} should settle the final request once`);
				assert.strictEqual(saveBarrierSettlements, 1, `${variant.extension} should settle the save barrier once`);
				assert.strictEqual(currentText, 'B');
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), durableBeforePersist,
					`${variant.extension} must not durably write the sidecar before didSave`);

				await Promise.resolve(didSaveHandler!(document));
				await waitForCondition(
					() => fs.readFileSync(sidecarPath, 'utf8').includes(variant.marker),
					`${variant.extension} should durably write only through didSave`,
				);
				assert.strictEqual(coordinatorCalls, 1);
				assert.strictEqual(posted.filter(message => message?.type === 'persistDocumentAck').length, 1);
				assert.strictEqual(finalSettlementCalls, 1);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onWillSaveTextDocument = originalWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('overlapping native notebook snapshots replace the current EOF with real VS Code range edits', async function () {
		this.timeout(20_000);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-real-range-overlap-'));
		const uri = vscode.Uri.file(path.join(tmpDir, 'synthetic.kqlx'));
		const historicalProviderPath = process.env.KUSTO_WORKBENCH_HISTORICAL_PROVIDER_PATH;
		const includeSavedResults = process.env.KUSTO_WORKBENCH_HISTORICAL_SAVED_RESULTS === '1';
		const historical = historicalProviderPath ? require(historicalProviderPath) : undefined;
		const Provider = historical?.KqlxEditorProvider ?? KqlxEditorProvider;
		const historicalPrototype = historical?.QueryEditorProvider?.prototype;
		const historicalMethods = historicalPrototype ? {
			initializeWebviewPanel: historicalPrototype.initializeWebviewPanel,
			handleWebviewMessage: historicalPrototype.handleWebviewMessage,
			inferClusterDatabaseForKqlQuery: historicalPrototype.inferClusterDatabaseForKqlQuery,
		} : undefined;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const disposeHandlers: Array<() => void> = [];
		const posted: any[] = [];
		let receiveHandler: ((message: any) => unknown) | undefined;
		let releaseFirstEdit!: () => void;
		const firstEditGate = new Promise<void>(resolve => { releaseFirstEdit = resolve; });
		let firstEditStarted = false;
		let activeEdits = 0;
		let maxActiveEdits = 0;
		let finalSnapshotRequests = 0;
		const observedRanges: Array<{ removedLength: number; sourceLength: number }> = [];
		const invalidBuffers: number[] = [];
		let changeObserver: vscode.Disposable | undefined;
		let completed = false;
		try {
			if (historicalPrototype) {
				historicalPrototype.initializeWebviewPanel = async () => undefined;
				historicalPrototype.handleWebviewMessage = async () => undefined;
				historicalPrototype.inferClusterDatabaseForKqlQuery = async () => undefined;
			}
			const initialSections = Array.from({ length: 4 }, (_, index) => ({
				id: `query_overlap_${index}`, type: 'query', query: `print Value=${index}`,
				...(includeSavedResults ? {
					resultJson: JSON.stringify({
						columns: [{ name: 'Payload', type: 'string' }],
						rows: index === 0
							? Array.from({ length: 2578 }, (_, row) => [{ display: String(row), full: 'V'.repeat(2120) }])
							: [[{ display: String(index), full: 'S'.repeat(100) }]],
					}),
				} : {}),
			}));
			let snapshotState = { sections: initialSections };
			const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: initialSections } }, null, 2)
				.replace(/\n/g, '\r\n') + '\r\n';
			fs.writeFileSync(uri.fsPath, initialText, 'utf8');
			const document = await vscode.workspace.openTextDocument(uri);
			const provider = new (Provider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(),
				historical?.releaseTag === 'v4.7.4' ? undefined : sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						await reloadAwarePostMessage(() => receiveHandler, posted)(message);
						if (message?.type === 'requestFinalPersist') {
							finalSnapshotRequests++;
							const currentProjection = [...posted].reverse().find(entry => entry?.type === 'documentData' && entry.ok === true);
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', state: snapshotState, flush: true, reason: 'save',
								editRevision: 2, snapshotId: `real-range-save-${finalSnapshotRequests}`,
								flushRequestId: message.requestId, sourceGeneration: currentProjection?.sourceGeneration,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			if (historical) {
				adaptMainWebviewStartupTestPanel(panel);
				adaptKqlxDocumentViewTestPanel(panel);
			}
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const projection = [...posted].reverse().find(message => message?.type === 'documentData' && message.ok === true);
			assert.ok(projection);
			changeObserver = vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.toString() !== uri.toString() || !event.contentChanges.length) return;
				try { JSON.parse(event.document.getText()); } catch { invalidBuffers.push(event.document.version); }
			});
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacements = edit.entries().find(([target]) => target.toString() === uri.toString())?.[1];
				if (!replacements?.length) return originalApplyEdit.call(vscode.workspace, edit);
				activeEdits++;
				maxActiveEdits = Math.max(maxActiveEdits, activeEdits);
				try {
					if (!firstEditStarted) {
						firstEditStarted = true;
						await firstEditGate;
					}
					assert.strictEqual(replacements.length, 1);
					const replacement = replacements[0];
					assert.strictEqual(document.offsetAt(replacement.range.start), 0);
					const sourceLength = document.getText().length;
					const removedLength = document.offsetAt(replacement.range.end);
					observedRanges.push({ removedLength, sourceLength });
					assert.strictEqual(removedLength, sourceLength, 'Workbench must replace the current EOF, not an older range');
					return await originalApplyEdit.call(vscode.workspace, edit);
				} finally {
					activeEdits--;
				}
			};
			const grownSections = [...initialSections, {
				id: 'query_overlap_added', type: 'query', query: `print Added="${'X'.repeat(65_154)}"`,
			}];
			snapshotState = { sections: grownSections };
			const firstPersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'real-range-first', editRevision: 1,
				sourceGeneration: projection.sourceGeneration, state: { sections: grownSections },
			}));
			await waitForCondition(() => firstEditStarted, 'first real Workbench range edit should reach the gate');
			const newestSections = grownSections.map(section => section.id === 'query_overlap_0'
				? { ...section, query: 'print Newest=2' } : section);
			snapshotState = { sections: newestSections };
			const secondPersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'real-range-second', editRevision: 2,
				sourceGeneration: projection.sourceGeneration, state: { sections: newestSections },
			}));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(observedRanges.length, 0);
			assert.strictEqual(activeEdits, 1, 'the second snapshot must wait behind the first edit');
			releaseFirstEdit();
			await Promise.all([firstPersist, secondPersist]);
			if (typeof projection.sourceGeneration === 'number') {
				await waitForCondition(
					() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'real-range-second'),
					'newest overlapping snapshot should be acknowledged',
				);
			}
			assert.strictEqual(maxActiveEdits, 1);
			assert.strictEqual(observedRanges.length, 2);
			if (!includeSavedResults) assert.ok(observedRanges[1].sourceLength > observedRanges[0].sourceLength + 65_000);
			assert.deepStrictEqual(invalidBuffers, [], 'no intermediate document revision may contain a repeated suffix');
			const finalSections = JSON.parse(document.getText()).state.sections;
			assert.strictEqual(finalSections.length, 5);
			assert.strictEqual(finalSections[0].query, 'print Newest=2');
			assert.strictEqual(finalSections[4].query, grownSections[4].query);
			if (includeSavedResults) {
				for (let round = 0; round < 3; round++) {
					assert.strictEqual(await document.save(), true, `live Save ${round + 1} should succeed`);
					await waitForCondition(() => !document.isDirty, 'live Save and result restoration should settle');
					const savedText = fs.readFileSync(uri.fsPath, 'utf8');
					assert.strictEqual(savedText, document.getText());
					assert.strictEqual(JSON.parse(savedText).state.sections.length, 5);
					assert.deepStrictEqual(invalidBuffers, [], 'live Save must never append a suffix to the buffer');
				}
				if (historical?.releaseTag !== 'v4.7.4') assert.ok(finalSnapshotRequests >= 1, 'the live provider must request its final snapshot');
			}
			for (const dispose of disposeHandlers.splice(0)) dispose();
			if (historical?.releaseTag === 'v4.7.4') {
				await waitForCondition(() => !document.isDirty, '4.7.4 close-time Save should settle');
			}
			assert.strictEqual(await document.save(), true);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), document.getText());
			assert.strictEqual(JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')).state.sections.length, 5);
			console.log(JSON.stringify({
				release: historical?.releaseTag ?? 'workspace', observedRanges, maxActiveEdits,
				includeSavedResults, finalSnapshotRequests,
				invalidBuffers, finalSections: finalSections.length, diskMatchesBuffer: true,
				savedResultSections: JSON.parse(document.getText()).state.sections.filter((section: any) => typeof section.resultJson === 'string').length,
			}));
			completed = true;
		} finally {
			releaseFirstEdit();
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			changeObserver?.dispose();
			for (const dispose of disposeHandlers) dispose();
			if (historicalPrototype && historicalMethods) Object.assign(historicalPrototype, historicalMethods);
			if (completed) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
			else console.error(`Preserved failed real-range fixture: ${tmpDir}`);
		}
	});

	for (const scenario of ['overlap', 'serial control', 'unleased overlap', 'sibling target', 'sibling publication failure', 'direct lifecycle', 'webview user-save', 'post-commit source edit', 'post-commit source ABA', 'result-free serial control', 'retired publication', 'retired publication failure', 'sibling drained preparation failure', 'passive readback after sibling recovery'] as const) {
	test(`public Save joins the actual native commit after preparation (${scenario})`, async function () {
		this.timeout(15_000);
		const drainedFailure = scenario === 'sibling drained preparation failure';
		const passiveRecovery = scenario === 'passive readback after sibling recovery';
		const overlap = !scenario.endsWith('serial control') && !drainedFailure && !passiveRecovery;
		const sourceEdit = scenario.startsWith('post-commit source');
		const resultFree = sourceEdit || scenario === 'result-free serial control' || passiveRecovery;
		const retired = scenario.startsWith('retired');
		const sibling = retired || scenario.startsWith('sibling');
		const publicationFailure = scenario.endsWith('publication failure');
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSetLifecycle = prototype.setWorkbenchFileCloseLifecycle;
		const originalAttachResultSession = prototype.attachKustoResultPersistenceSession;
		const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
		const originalOpenFile = fs.promises.open;
		const originalRealpath = fs.promises.realpath;
		const originalShowError = vscode.window.showErrorMessage;
		const originalSingleton = Object.getOwnPropertyDescriptor(KustoWorkbenchToolOrchestrator, 'instance')!;
		const originalWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalTextDocuments = Object.getOwnPropertyDescriptor(vscode.workspace, 'textDocuments')!;
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-commit-join-'));
		const uri = vscode.Uri.file(path.join(root, 'probe.kqlx'));
		const events: Array<Record<string, string | number | boolean | undefined>> = [];
		let droppedEvents = 0;
		let recordErrors = 0;
		let recordingError: unknown;
		const record = (event: string, detail: () => Record<string, number | boolean | undefined> = () => ({}), status?: boolean) => {
			if (nativeSaveTrace) { nativeSaveTrace.record(event, status); return; }
			if (events.length >= 128) { droppedEvents++; return; }
			try { events.push({ event, at: new Date().toISOString(), tMs: performance.now(), ...detail() }); }
			catch (error) { if (recordErrors++ === 0) recordingError = error; }
		};
		const subscriptions: vscode.Disposable[] = [];
		let disposals: Array<() => void> = [];
		let lifecycle: { inspectDirty(): Promise<boolean>; save(): Promise<void> } | undefined;
		let document: vscode.TextDocument | undefined;
		let saveDocument: vscode.TextDocument | undefined;
		let reopened = false;
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		type SaveView = { receive?: typeof receive; projection?: any; lifecycle?: typeof lifecycle; disposals: Array<() => void>; willSave?: (event: any) => void };
		const views: SaveView[] = [];
		const tokens: number[] = [];
		let currentView: SaveView | undefined;
		let heldView: SaveView | undefined;
		let didSaveView: SaveView | undefined;
		let passiveView: SaveView | undefined;
		let finalPersistView: SaveView | undefined;
		let failFinalSnapshot = false;
		let captureTimers = false;
		const timers: Array<{ handle: ReturnType<typeof setTimeout>; expire(): void; cleared: boolean }> = [];
		let expiredPreparation: Promise<vscode.TextEdit[]> | undefined;
		const expiredWaiters: Array<Promise<unknown>> = [];
		const preparationReplies = new Set<Promise<void>>();
		const fixtureFailures: unknown[] = [];
		let restoreDocumentSave: (() => void) | undefined;
		let state: any = { sections: [{
			id: 'query_probe', type: 'query', query: 'print Probe1=1',
			clusterUrl: 'https://cluster.kusto.windows.net', authorityId: 'authority',
			connectionIdHint: 'connection-1', database: 'Db', futureSection: { keep: true },
		}] };
		let holdPreparation = false;
		let holdCommit = false;
		let releasePreparation!: () => void;
		let preparationReached!: () => void;
		const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
		const preparationStarted = new Promise<void>(resolve => { preparationReached = resolve; });
		let releaseCommit!: () => void;
		let commitReached!: () => void;
		const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
		const commitStarted = new Promise<void>(resolve => { commitReached = resolve; });
		let releasePublication!: () => void;
		let publicationReached!: () => void;
		const publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
		const publicationStarted = new Promise<void>(resolve => { publicationReached = resolve; });
		let finishPublication!: () => void;
		const publicationFinished = new Promise<void>(resolve => { finishPublication = resolve; });
		let publicationHeld = false;
		let retiredPublicationStarted = false;
		let returnedBeforePublication = false;
		let returnSnapshot: { result?: unknown; dirty: boolean; buffer: string; disk: string; commits: number; delegatedNativeSaves?: number } | undefined;
		let userDraft: string | undefined;
		let userDraftDirty = false;
		let nativeSave: Promise<boolean> | undefined;
		let publicSave: ReturnType<KustoWorkbenchToolOrchestrator['saveWorkbenchFile']> | undefined;
		let directSave: Promise<void> | undefined;
		let token: number | undefined;
		let orchestrator: KustoWorkbenchToolOrchestrator | undefined;
		let remainingPanelRegistrations: (() => number) | undefined;
		let completed = false;
		let bodyFailed = false;
		let commits = 0;
		let failedPublications = 0;
		let editRevision = 2;
		const saveErrors: string[] = [];
		const registry = new KustoResultPersistenceRegistry();
		const resultLease = registry.acquire(normalizeWorkbenchUriKey(uri));
		let resultSession: ReturnType<typeof resultLease.owner.openPanel> | undefined;
		const context = {
			subscriptions,
			workspaceState: { get: () => undefined, update: async () => undefined },
			globalState: { get: () => undefined, update: async () => undefined },
			globalStorageUri: vscode.Uri.file(path.join(root, 'global')),
		} as any;
		try {
			prototype.setWorkbenchFileCloseLifecycle = function (this: QueryEditorProvider, value: typeof lifecycle) {
				lifecycle = value;
				return originalSetLifecycle.call(this, value);
			};
			prototype.attachKustoResultPersistenceSession = function (this: QueryEditorProvider, value: typeof resultSession) {
				resultSession = value;
				return originalAttachResultSession.call(this, value);
			};
			prototype.publishSqlLeaveNoTraceStateFresh = async (value: unknown, publish: (value: unknown) => Promise<unknown>) => {
				if (!retired || commits === 0 || publicationHeld) return publish(value);
				publicationHeld = true;
				retiredPublicationStarted = true;
				record('publication.held');
				publicationReached();
				await publicationGate;
				try { return await publish(value); }
				finally { finishPublication(); }
			};
			(fs.promises as any).realpath = async (...args: any[]) => {
				const readbackView = didSaveView;
				const resolved = await (originalRealpath as any).apply(fs.promises, args);
				if (!publicationHeld && String(args[0]) === uri.fsPath
					&& ((sourceEdit && commits > 0) || (passiveRecovery && passiveView && readbackView === passiveView))) {
					publicationHeld = true;
					record('postCommit.readbackIdentityHeld', () => ({ passivePanel: !!passiveView && readbackView === passiveView }), !!passiveView && readbackView === passiveView);
					publicationReached();
					await publicationGate;
				}
				return resolved;
			};
			if (drainedFailure) {
				Object.defineProperty(vscode.workspace, 'textDocuments', { ...originalTextDocuments, get: () => {
					const documents = originalTextDocuments.get!.call(vscode.workspace) as vscode.TextDocument[];
					return saveDocument ? [...documents.filter(candidate => candidate.uri.toString() !== uri.toString()), saveDocument] : documents;
				} });
			}
			if (passiveRecovery) {
				(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: any) => void, ...args: any[]) => {
					if (currentView && !currentView.willSave) currentView.willSave = handler;
					return (originalWillSave as any).call(vscode.workspace, handler, ...args);
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (saved: vscode.TextDocument) => unknown, ...args: any[]) => {
					const view = currentView;
					return (originalDidSave as any).call(vscode.workspace, (saved: vscode.TextDocument) => {
						const previousView = didSaveView;
						didSaveView = view;
						try { return handler(saved); }
						finally { didSaveView = previousView; }
					}, ...args);
				};
				(globalThis as any).setTimeout = (callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
					const handle = originalSetTimeout(callback, delay, ...args);
					if (captureTimers && delay === 5_000) timers.push({ handle, expire: () => callback(...args), cleared: false });
					return handle;
				};
				(globalThis as any).clearTimeout = (handle: ReturnType<typeof setTimeout>) => {
					const timer = timers.find(candidate => candidate.handle === handle);
					if (timer) timer.cleared = true;
					return originalClearTimeout(handle);
				};
			}
			if (scenario === 'webview user-save') {
				(vscode.window as any).showErrorMessage = (message: string) => { saveErrors.push(message); return Promise.resolve(undefined); };
			}
			if (publicationFailure) {
				(fs.promises as any).open = (target: fs.PathLike, flags: any, ...args: any[]) => {
					if (commits > 0 && failedPublications === 0 && flags === 'r+' && String(target) === uri.fsPath) {
						failedPublications++;
						return Promise.reject(Object.assign(new Error('Native commit publication denied by fixture'), { code: 'EACCES' }));
					}
					return (originalOpenFile as any).call(fs.promises, target, flags, ...args);
				};
			}
			const connections = connectionManagerStub();
			const sqlWorkbench = sqlWorkbenchStub();
			(KustoWorkbenchToolOrchestrator as any).instance = undefined;
			orchestrator = KustoWorkbenchToolOrchestrator.getInstance(context, connections, () => sqlWorkbench.connectionManager, {} as any);
			const provider = new (KqlxEditorProvider as any)(context, vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connections, sqlWorkbench, undefined, registry) as KqlxEditorProvider;
			remainingPanelRegistrations = () => (provider as any).markdownPanelOwners.get(normalizeWorkbenchUriKey(uri))?.size ?? 0;
			fs.writeFileSync(uri.fsPath, JSON.stringify({ kind: 'kqlx', version: 1, futureRoot: { keep: true }, state }, null, 2));
			const open = async () => {
				await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { preview: false });
				document = await vscode.workspace.openTextDocument(uri);
				if (drainedFailure && reopened) saveDocument ??= Object.create(document) as vscode.TextDocument;
				const view: SaveView = { disposals: [] };
				currentView = view;
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => {
							if (message.type === 'documentData' && message.ok) {
								view.projection = message;
								if (currentView === view) projection = message;
							}
							if (message.reloadRequestId) {
								await Promise.resolve(view.receive!({
									type: 'documentReloadResult', requestId: message.reloadRequestId, applied: true,
									editRevision: Number(message.editRevision || 0), markdownCommandBarrierSupported: scenario !== 'unleased overlap',
								}));
							}
							if (message.type === 'requestMarkdownCommandBarrier') {
								record('barrier.accepted', () => ({ sourceGeneration: message.sourceGeneration }));
								void Promise.resolve(view.receive!({
									type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
									sourceGeneration: message.sourceGeneration, documentRevision: 0, accepted: true,
								}));
							}
							if (message.type === 'requestFinalPersist') {
								finalPersistView = view;
								if (failFinalSnapshot) {
									record('finalSnapshot.unavailable');
									return true;
								}
								const preparationReply = (async () => {
									if (holdPreparation) {
										heldView = view;
										record('preparation.held');
										preparationReached();
										await preparationGate;
									}
									await view.receive!({
										type: 'persistDocument', state, flush: true, reason: 'save', editRevision,
										snapshotId: `native-commit-${message.requestId}`, sourceGeneration: view.projection.sourceGeneration,
										flushRequestId: message.requestId,
									});
								})();
								const trackedPreparationReply = preparationReply.then(undefined, error => {
									try { fixtureFailures.push(error); }
									catch (recordError) { if (recordErrors++ === 0) recordingError = recordError; }
								}).finally(() => preparationReplies.delete(trackedPreparationReply));
								preparationReplies.add(trackedPreparationReply);
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { view.receive = handler; return { dispose() {} }; },
					},
					onDidDispose: (handler: () => void) => {
						disposals.push(handler);
						view.disposals.push(handler);
						return { dispose() {} };
					},
				} as any;
				await provider.resolveCustomTextEditor(saveDocument ?? document, panel, {} as any);
				receive = view.receive;
				view.lifecycle = lifecycle;
				await Promise.resolve(receive!({ type: 'requestDocument' }));
				assert.ok(lifecycle);
				assert.ok(resultSession);
				assert.strictEqual(resultSession.openSection('query_probe', 'native-commit-instance'), true);
				assert.strictEqual(resultSession.adoptTarget({ boxId: 'query_probe', sectionInstanceId: 'native-commit-instance',
					targetGeneration: 1, connectionId: 'connection-1', database: 'Db' }), true);
				token = orchestrator!.connect(() => true, async () => state.sections, async () => ({ schemas: [] }),
					uri.toString(), undefined, undefined, lifecycle);
				tokens.push(token);
				views.push(view);
			};
			await open();
			const publish = async (revision: number) => {
				if (resultFree) {
					state = { sections: [{ ...state.sections[0], name: `revision-${revision}` }] };
					await Promise.resolve(receive!({ type: 'persistDocument', state, editRevision: revision,
						snapshotId: `publish-${revision}`, sourceGeneration: projection.sourceGeneration }));
					assert.strictEqual(document!.isDirty, true);
					return;
				}
				const terminal = {
					type: 'queryResult' as const, engine: 'kusto' as const,
					boxId: 'query_probe', sectionInstanceId: 'native-commit-instance', targetGeneration: 1,
					executionId: `native-commit-${revision}`, connectionId: 'connection-1', database: 'Db',
					producer: 'manual' as const, query: 'print Probe1=1', reservationSequence: revision,
					dispatch: {
						dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
						connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
						clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
						accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: `native-commit-${revision}`,
					},
					result: { columns: ['Probe1'], rows: [[1]], metadata: {} },
				};
				assert.strictEqual(resultSession!.beginExecution(terminal), true);
				const assigned = resultSession!.stagePublication(`publication-${revision}`, terminal);
				assert.ok(assigned);
				assert.strictEqual(resultSession!.commitPublication(`publication-${revision}`), true);
				state = { sections: [{ ...state.sections[0], resultJson: JSON.stringify(assigned.result),
					resultArtifact: assigned.resultArtifactAssignment, kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0 }] };
				await Promise.resolve(receive!({ type: 'persistDocument', state, editRevision: revision,
					snapshotId: `publish-${revision}`, sourceGeneration: projection.sourceGeneration }));
				assert.strictEqual(document!.isDirty, true);
				assert.strictEqual(JSON.parse(document!.getText()).state.sections[0].resultArtifact.producer.executionId, terminal.executionId);
			};
			await publish(1);
			nativeSaveTrace?.record('initialNative.started');
			await lifecycle!.save();
			nativeSaveTrace?.record('initialNative.returned');
			assert.strictEqual(document!.isDirty, false);
			const oldText = fs.readFileSync(uri.fsPath, 'utf8');
			assert.strictEqual(document!.getText(), oldText);
			if (resultFree) assert.strictEqual(JSON.parse(oldText).state.sections[0].resultJson, undefined);
			else assert.strictEqual(JSON.parse(oldText).state.sections[0].resultArtifact.producer.executionId, 'native-commit-1');
			if (!nativeSaveTrace) fs.writeFileSync(path.join(root, 'old1-saved.json'), oldText);
			orchestrator.disconnectIfOwner(token!);
			for (const dispose of disposals.splice(0)) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true);
			views.length = 0;
			const initialTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
				tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
			assert.strictEqual(await vscode.window.tabGroups.close(initialTabs), true);
			reopened = true;
			await open();
			assert.strictEqual(document!.getText(), oldText);
			record('old1.reopened');
			await publish(2);
			assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), oldText);
			let newText = document!.getText();
			let newSection = JSON.parse(newText).state.sections[0];
			if (resultFree) assert.strictEqual(newSection.resultJson, undefined);
			else assert.notDeepStrictEqual(newSection.resultArtifact, JSON.parse(oldText).state.sections[0].resultArtifact);
			if (passiveRecovery) {
				passiveView = views[0];
				assert.ok(passiveView.willSave);
				captureTimers = true;
				passiveView.willSave!({ document, waitUntil: (work: Thenable<vscode.TextEdit[]>) => { expiredPreparation = Promise.resolve(work); } });
				await expiredPreparation!;
				captureTimers = false;
				const activeTimers = timers.filter(timer => !timer.cleared);
				assert.strictEqual(activeTimers.length, 1, 'A must retain the real five-second native commit lease');
				for (let index = 0; index < 2; index++) {
					expiredWaiters.push(passiveView.lifecycle!.inspectDirty().then(() => undefined, error => error));
				}
				await new Promise<void>(resolve => setImmediate(resolve));
				activeTimers[0].expire();
				const failures = await Promise.all(expiredWaiters);
				for (const failure of failures) {
					assert.ok(failure instanceof Error, 'Both original joiners must reject A\'s expired attempt');
					assert.match(failure.message, /native notebook Save/);
				}
				record('coordinatorA.expired', () => ({ originalWaiterErrors: failures.length }));
				assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), oldText);
				await open();
				await publish(3);
				editRevision = 3;
				newText = document!.getText();
				newSection = JSON.parse(newText).state.sections[0];
			}
			if (sibling) await open();
			subscriptions.push(vscode.workspace.onDidSaveTextDocument(saved => {
				if (saved.uri.toString() === uri.toString()) { commits++; record('native.committed', () => ({ commits })); }
			}));
			subscriptions.push(vscode.workspace.onWillSaveTextDocument(event => {
				if (event.document.uri.toString() !== uri.toString() || !holdCommit) return;
				event.waitUntil(commitGate);
				record('commit.held', () => ({ version: event.document.version, dirty: event.document.isDirty, commits }));
				commitReached();
			}));
			if (drainedFailure) {
				const initiatingView = views[0];
				const coordinatorView = views[1];
				token = orchestrator.connect(() => true, async () => state.sections, async () => ({ schemas: [] }),
					uri.toString(), undefined, undefined, initiatingView.lifecycle);
				tokens.push(token);
				const originalSave = document!.save;
				const descriptor = Object.getOwnPropertyDescriptor(saveDocument!, 'save');
				restoreDocumentSave = () => {
					if (descriptor) Object.defineProperty(saveDocument!, 'save', descriptor);
					else delete (saveDocument as any).save;
				};
				let delegatedNativeSaves = 0;
				Object.defineProperty(saveDocument!, 'save', { configurable: true, value: async () => {
					delegatedNativeSaves++;
					nativeSaveTrace?.record('native.started');
					nativeSave = Promise.resolve(originalSave.call(document));
					const saved = await nativeSave;
					record('native.returnHeld', () => ({ saved, delegatedNativeSaves }), saved);
					assert.strictEqual(saved, true, 'The original native Save must genuinely commit the fail-closed fallback');
					assert.strictEqual(finalPersistView, coordinatorView, 'B must prepare the native Save initiated through A');
					const registrations = [...(provider as any).markdownPanelOwners.get(normalizeWorkbenchUriKey(uri)).values()] as Array<{ waitForNativeSaveCompletion(reportFailure: boolean): Promise<void> }>;
					await Promise.all(registrations.map(registration => registration.waitForNativeSaveCompletion(false).catch(() => undefined)));
					await Promise.all(registrations.map(registration => registration.waitForNativeSaveCompletion(false)));
					assert.strictEqual(document!.isDirty, false);
					assert.strictEqual(document!.getText(), fs.readFileSync(uri.fsPath, 'utf8'));
					assert.deepStrictEqual(JSON.parse(document!.getText()).state.sections[0], JSON.parse(oldText).state.sections[0]);
					record('failedAttempt.bookkeepingDrained', () => ({ version: document!.version, dirty: document!.isDirty, commits }));
					for (const dispose of coordinatorView.disposals.splice(0)) {
						disposals = disposals.filter(candidate => candidate !== dispose);
						dispose();
					}
					await waitForCondition(() => remainingPanelRegistrations!() === 1, 'The failed sibling registration must retire before native Save returns');
					record('native.returnReleased', () => ({ saved, failedSiblingRetired: true }), saved);
					return saved;
				} });
				failFinalSnapshot = true;
				publicSave = orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() });
				const result = await publicSave;
				const atReturn = { result, dirty: document!.isDirty, buffer: document!.getText(), disk: fs.readFileSync(uri.fsPath, 'utf8'), commits, delegatedNativeSaves };
				returnSnapshot = atReturn;
				record('public.returned', () => ({ success: result.success, saved: result.saved, dirty: atReturn.dirty, commits, delegatedNativeSaves }), result.success);
				assert.strictEqual(delegatedNativeSaves, 1, 'The wrapper must delegate exactly one actual native Save');
				assert.strictEqual(commits, 1);
				assert.strictEqual(result.success, false, 'Public Save must report the drained sibling preparation failure despite a true native Save return');
				assert.match(result.error ?? '', /native notebook Save/);
				assert.strictEqual(atReturn.dirty, false);
				assert.strictEqual(atReturn.buffer, atReturn.disk);
				assert.deepStrictEqual(JSON.parse(atReturn.disk).futureRoot, { keep: true });
				restoreDocumentSave();
				restoreDocumentSave = undefined;
				failFinalSnapshot = false;
				await Promise.resolve(initiatingView.receive!({ type: 'persistDocument', state, editRevision: 3,
					snapshotId: 'retry-drained-failure', sourceGeneration: initiatingView.projection.sourceGeneration }));
				const retry = await orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() });
				record('freshSave.returned', () => ({ success: retry.success, saved: retry.saved, dirty: document!.isDirty, commits }), retry.success);
				assert.strictEqual(retry.success, true, 'A fresh Save must still retry NEW2 successfully');
				assert.strictEqual(document!.isDirty, false);
				assert.strictEqual(document!.getText(), fs.readFileSync(uri.fsPath, 'utf8'));
				assert.deepStrictEqual(JSON.parse(document!.getText()).state.sections[0], newSection);
				completed = true;
				return;
			}
			holdPreparation = overlap;
			holdCommit = overlap;
			nativeSaveTrace?.record('native.started');
			nativeSave = Promise.resolve(document!.save());
			if (overlap) await preparationStarted;
			else if (passiveRecovery) {
				assert.strictEqual(await nativeSave, true);
				await publicationStarted;
				assert.strictEqual(finalPersistView, views[1], 'B must coordinate the successful native Save');
				assert.strictEqual(document!.isDirty, false);
				assert.strictEqual(document!.getText(), newText);
				assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), newText);
				record('coordinatorB.saved', () => ({ commits, passiveReadbackHeld: publicationHeld }));
			} else { assert.strictEqual(await nativeSave, true); await lifecycle!.inspectDirty(); }
			if (sibling) {
				assert.ok(heldView);
				const targetView = views.find(view => view !== heldView);
				assert.ok(targetView?.lifecycle);
				token = orchestrator.connect(() => true, async () => state.sections, async () => ({ schemas: [] }),
					uri.toString(), undefined, undefined, targetView.lifecycle);
				tokens.push(token);
				record('public.targetedSibling', () => ({ targetDiffersFromNativeCoordinator: targetView !== heldView }));
			}
			if (retired) {
				nativeSaveTrace?.record('preparation.released');
				releasePreparation();
				await commitStarted;
				releaseCommit();
				assert.strictEqual(await nativeSave, true);
				await publicationStarted;
				assert.strictEqual(document!.isDirty, false);
				assert.strictEqual(document!.getText(), oldText);
				assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), oldText);
				for (const dispose of heldView!.disposals.splice(0)) {
					disposals = disposals.filter(candidate => candidate !== dispose);
					dispose();
				}
				record('coordinator.retired');
			}
			let atReturn: { dirty: boolean; buffer: string; disk: string; commits: number } | undefined;
			const captureReturn = (result?: unknown) => {
				atReturn = { dirty: document!.isDirty, buffer: document!.getText(), disk: fs.readFileSync(uri.fsPath, 'utf8'), commits };
				returnSnapshot = { result, ...atReturn };
				const returnResult = result as { success?: boolean; saved?: boolean } | undefined;
				record(scenario === 'direct lifecycle' ? 'lifecycle.returned' : scenario === 'webview user-save'
					? 'userSave.returned' : 'public.returned', () => ({ success: returnResult?.success, saved: returnResult?.saved, dirty: atReturn!.dirty, commits }), returnResult?.success);
			};
			nativeSaveTrace?.record('public.started');
			if (scenario === 'direct lifecycle') directSave = lifecycle!.save().then(() => captureReturn());
			else if (scenario === 'webview user-save') {
				editRevision = 3;
				directSave = Promise.resolve(receive!({ type: 'persistDocument', state, flush: true, reason: 'user-save',
					editRevision, snapshotId: 'native-overlap-user-save', sourceGeneration: projection.sourceGeneration,
				})).then(() => captureReturn());
			} else {
				publicSave = orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() }).then(result => {
					captureReturn(result);
					return result;
				});
			}
			if (passiveRecovery) {
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(atReturn, undefined, 'Fresh public Save must join A\'s passive readback');
				record('passiveReadback.released');
				releasePublication();
			} else if (retired) {
				nativeSaveTrace?.record('setContext.enter');
				await vscode.commands.executeCommand('setContext', 'kusto.nativeCommitJoinTest', undefined);
				nativeSaveTrace?.record('setContext.return');
				returnedBeforePublication = !!atReturn;
				record('publication.released', () => ({ returnedBeforePublication }));
				releasePublication();
			} else if (overlap) {
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(atReturn, undefined, 'Public Save must first join native preparation');
				nativeSaveTrace?.record('preparation.released');
				releasePreparation();
				await commitStarted;
				nativeSaveTrace?.record('setContext.enter');
				await vscode.commands.executeCommand('setContext', 'kusto.nativeCommitJoinTest', undefined);
				nativeSaveTrace?.record('setContext.return');
				record('commit.released');
				releaseCommit();
			}
			if (sourceEdit) {
				assert.strictEqual(await nativeSave, true);
				nativeSaveTrace?.record('native.returned', true);
				await publicationStarted;
				assert.strictEqual(document!.isDirty, false);
				assert.strictEqual(document!.getText(), newText);
				const committedVersion = document!.version;
				userDraft = document!.getText().replace('print Probe1=1', 'print UserDraft=3');
				const edit = new vscode.WorkspaceEdit();
				edit.replace(uri, new vscode.Range(document!.positionAt(0), document!.positionAt(document!.getText().length)), userDraft);
				assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
				if (scenario === 'post-commit source ABA') {
					userDraft = newText;
					const revert = new vscode.WorkspaceEdit();
					revert.replace(uri, new vscode.Range(document!.positionAt(0), document!.positionAt(document!.getText().length)), userDraft);
					assert.strictEqual(await vscode.workspace.applyEdit(revert), true);
					assert.ok(document!.version > committedVersion + 1, 'ABA must change the source version despite identical final bytes');
				}
				state = JSON.parse(userDraft).state;
				userDraftDirty = document!.isDirty;
				if (scenario !== 'post-commit source ABA') assert.strictEqual(userDraftDirty, true);
				assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), newText);
				if (!nativeSaveTrace) fs.writeFileSync(path.join(root, 'user-draft.json'), userDraft);
				record('source.userEdited', () => ({ version: document!.version, dirty: document!.isDirty }), document!.isDirty);
				releasePublication();
			}
			const result = await publicSave;
			await directSave;
			assert.strictEqual(await nativeSave, true, 'The original native Save must still succeed');
			if (retired) {
				await publicationFinished;
				if (publicationFailure) assert.strictEqual(failedPublications, 1, 'Retired publication must reach the actual backend failure');
				assert.strictEqual(returnedBeforePublication, false, 'A surviving panel must wait for the retired coordinator publication');
			}
			if (sourceEdit) {
				assert.strictEqual(result?.success, false, 'The waiting public Save must not save a newer user draft');
				assert.match(result?.error ?? '', /notebook changed while waiting for Save/);
				assert.ok(atReturn);
				assert.strictEqual(atReturn.dirty, userDraftDirty, 'The waiting Save must not change the newer draft dirty state');
				assert.strictEqual(atReturn.buffer, userDraft, 'The newer user draft must remain intact');
				assert.strictEqual(atReturn.disk, newText, 'The waiting Save must not publish the newer user draft');
				assert.strictEqual(atReturn.commits, 1, 'Joining must not save the newer draft');
				completed = true;
				return;
			}
			if (publicationFailure) {
				assert.strictEqual(failedPublications, 1, 'The actual canonical publication must reach the file-open failure');
				assert.strictEqual(result?.success, false, 'The other panel must not conceal a failed native result publication');
				assert.match(result?.error ?? '', /could not confirm the final saved query results/);
			} else if (result) assert.strictEqual(result.success, true, `Public Save must join the existing native commit: ${JSON.stringify(result)}`);
			if (passiveRecovery) assert.strictEqual(result?.saved, false, 'Joining the already-clean successful Save needs no extra commit');
			assert.ok(atReturn);
			assert.strictEqual(atReturn.dirty, false, 'The native buffer must be clean at public return');
			assert.strictEqual(atReturn.buffer, atReturn.disk, 'Buffer and disk must agree at public return');
			assert.deepStrictEqual(JSON.parse(atReturn.disk).state.sections[0], publicationFailure
				? JSON.parse(oldText).state.sections[0] : newSection, 'Public return must contain NEW2 on success and retain OLD1 on failed publication');
			assert.deepStrictEqual(JSON.parse(atReturn.disk).futureRoot, { keep: true });
			assert.strictEqual(atReturn.commits, 1, 'Joining must not issue a second native Save');
			assert.deepStrictEqual(saveErrors, [], 'The explicit user-save handler must not hide a recursive Save error');
			completed = true;
		} catch (error) {
			bodyFailed = true;
			throw error;
		} finally {
			captureTimers = false;
			releasePreparation();
			releaseCommit();
			releasePublication();
			try {
				for (const timer of timers.filter(candidate => !candidate.cleared)) {
					try { timer.expire(); } catch (error) { fixtureFailures.push(error); }
				}
				const settled = await Promise.allSettled([expiredPreparation, ...expiredWaiters, nativeSave, publicSave, directSave]);
				for (const result of settled) if (result.status === 'rejected') fixtureFailures.push(result.reason);
				while (preparationReplies.size) await Promise.allSettled([...preparationReplies]);
				if (retiredPublicationStarted) await publicationFinished;
				for (const connectionToken of tokens) {
					try { orchestrator?.disconnectIfOwner(connectionToken); } catch (error) { fixtureFailures.push(error); }
				}
				for (const dispose of disposals.splice(0)) {
					try { dispose(); } catch (error) { fixtureFailures.push(error); }
				}
				const closed = await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				record('cleanup.drained', () => ({ closed, remainingPanelRegistrations: remainingPanelRegistrations?.() }), closed);
				assert.strictEqual(closed, true, 'Native Save work must drain before panel cleanup completes');
				assert.strictEqual(remainingPanelRegistrations?.(), 0, 'Retired panel registrations must not remain after draining');
			} catch (error) { fixtureFailures.push(error); }
			finally {
				for (const restore of [
					() => restoreDocumentSave?.(),
					() => { if (saveDocument) liveDocuments.retire(saveDocument); },
					...subscriptions.map(subscription => () => subscription.dispose()),
					() => resultSession?.dispose(), () => resultLease.release(),
					() => { (fs.promises as any).open = originalOpenFile; },
					() => { (fs.promises as any).realpath = originalRealpath; },
					() => { (vscode.window as any).showErrorMessage = originalShowError; },
					() => { prototype.setWorkbenchFileCloseLifecycle = originalSetLifecycle; },
					() => { prototype.attachKustoResultPersistenceSession = originalAttachResultSession; },
					() => { prototype.publishSqlLeaveNoTraceStateFresh = originalPublish; },
					() => { (vscode.workspace as any).onWillSaveTextDocument = originalWillSave; },
					() => { (vscode.workspace as any).onDidSaveTextDocument = originalDidSave; },
					() => Object.defineProperty(vscode.workspace, 'textDocuments', originalTextDocuments),
					() => { (globalThis as any).setTimeout = originalSetTimeout; },
					() => { (globalThis as any).clearTimeout = originalClearTimeout; },
					() => Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', originalSingleton),
				]) { try { restore(); } catch (error) { fixtureFailures.push(error); } }
			}
			try {
				const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !tab.isDirty
					&& tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
				if (tabs.length) assert.strictEqual(await vscode.window.tabGroups.close(tabs), true);
			} catch (error) { fixtureFailures.push(error); }
			if (recordErrors) fixtureFailures.push(recordingError);
			if (!nativeSaveTrace) {
				try { if (document) fs.writeFileSync(path.join(root, 'final-buffer.json'), document.getText()); }
				catch (error) { fixtureFailures.push(error); }
				try {
					fs.writeFileSync(path.join(root, 'events.jsonl'), [...events, { event: 'diagnostic.receipt', droppedEvents, recordErrors, failures: fixtureFailures.length,
						completed, bodyFailed, crashBeforeFinallyMayLoseEvents: true }].map(entry => JSON.stringify(entry)).join('\n') + '\n');
				} catch (error) { fixtureFailures.push(error); }
			}
			try { console.log(`Retained ${completed && !fixtureFailures.length ? 'passed' : 'failed'} native commit fixture for local history: ${root}; events=${events.length}; dropped=${droppedEvents}; errors=${recordErrors}; cleanupFailures=${fixtureFailures.length}`); }
			catch (error) { fixtureFailures.push(error); }
			if (!nativeSaveTrace && (!completed || fixtureFailures.length) && returnSnapshot) {
				try { fs.writeFileSync(path.join(root, 'public-return.json'), JSON.stringify(returnSnapshot, null, 2)); }
				catch (error) { fixtureFailures.push(error); }
			}
			if (!bodyFailed && fixtureFailures.length) throw fixtureFailures[0];
		}
	});
	}

	const nativeSingleSaveTitle = 'native Save publishes new results without a post-commit buffer edit or second Save';
	const nativeSingleSaveRows = (label: string) => Array.from({ length: 17_000 }, (_, index) =>
		[index, `${label}-row-${index}-${'x'.repeat(80)}`]);
	for (const scenario of [
		{ title: nativeSingleSaveTitle, encoding: 'utf8', crlf: false, bom: false, large: false, rawDraft: false, toolSave: false, retryPublication: false },
		{ title: `${nativeSingleSaveTitle} for a large CRLF notebook`, encoding: 'utf8', crlf: true, bom: false, large: true, rawDraft: false, toolSave: false, retryPublication: false },
		{ title: `${nativeSingleSaveTitle} for a UTF-8 BOM notebook`, encoding: 'utf8bom', crlf: false, bom: true, large: false, rawDraft: false, toolSave: false, retryPublication: false },
		{ title: `${nativeSingleSaveTitle} while retaining a raw dirty draft`, encoding: 'utf8', crlf: false, bom: false, large: false, rawDraft: true, toolSave: false, retryPublication: false },
		{ title: `${nativeSingleSaveTitle} through the tool Save lifecycle`, encoding: 'utf8', crlf: false, bom: false, large: false, rawDraft: false, toolSave: true, retryPublication: false },
		{ title: `${nativeSingleSaveTitle} after retrying a failed publication`, encoding: 'utf8', crlf: false, bom: false, large: false, rawDraft: false, toolSave: false, retryPublication: true },
		{ title: `${nativeSingleSaveTitle} for a UTF-16 LE BOM notebook`, encoding: 'utf16le', crlf: false, bom: false, large: false, rawDraft: false, toolSave: false, retryPublication: false },
		{ title: `${nativeSingleSaveTitle} for a Windows-1252 non-ASCII notebook`, encoding: 'windows1252', crlf: false, bom: false, large: false, rawDraft: false, toolSave: false, retryPublication: false },
	] as const) test(scenario.title, async function () {
		this.timeout(scenario.large ? 30_000 : 20_000);
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const originalSetLifecycle = (QueryEditorProvider as any).prototype.setWorkbenchFileCloseLifecycle;
		const originalOpen = fs.promises.open;
		const originalShowWarning = vscode.window.showWarningMessage;
		let lifecycle: { inspectDirty(): Promise<boolean>; save(): Promise<void> } | undefined;
		const warnings: string[] = [];
		let faultArmed = false;
		let failedOpens = 0;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-single-save-'));
		const uri = vscode.Uri.file(path.join(tmpDir, 'single-save.kqlx'));
		const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
		const utf16LeBom = Buffer.from([0xff, 0xfe]);
		const nativeEncoding = scenario.encoding === 'utf16le' || scenario.encoding === 'windows1252';
		const savedTextDecoder = scenario.encoding === 'utf16le' ? new TextDecoder('utf-16le')
			: scenario.encoding === 'windows1252' ? new TextDecoder('windows-1252') : new TextDecoder();
		const readSavedText = () => savedTextDecoder.decode(fs.readFileSync(uri.fsPath));
		const waitMs = scenario.large ? 20_000 : 10_000;
		const nonAscii = 'caf\u00e9 \u20ac';
		const oldResult = JSON.stringify(scenario.large
			? { columns: ['Id', 'Old'], rows: nativeSingleSaveRows('old'), metadata: {} }
			: nativeEncoding ? { columns: ['Old', 'Label'], rows: [[7, `old ${nonAscii}`]], metadata: {} }
				: { columns: ['Old'], rows: [[7]], metadata: {} });
		const newResult = JSON.stringify(scenario.large
			? { columns: ['Id', 'New'], rows: nativeSingleSaveRows('new'), metadata: {} }
			: nativeEncoding ? { columns: ['New', 'Label'], rows: [[11, `new ${nonAscii}`]], metadata: {} }
				: { columns: ['New'], rows: [[11]], metadata: {} });
		const baseline = { sections: [
			{ id: 'query_old', type: 'query', query: 'print Old=7', resultJson: oldResult },
			{ id: 'query_new', type: 'query', query: 'print New=11' },
		] };
		const state = { sections: baseline.sections.map(section => section.id === 'query_new'
			? { ...section, name: 'Accepted result', resultJson: newResult } : section) };
		const posted: any[] = [];
		const disposals: Array<() => void> = [];
		const observers: vscode.Disposable[] = [];
		let receive: ((message: any) => unknown) | undefined;
		let nativeSaves = 0;
		let postCommitEdits = 0;
		const invalidVersions: number[] = [];
		let completed = false;
		let releasePublication!: () => void;
		const publicationGate = new Promise<void>(resolve => { releasePublication = resolve; });
		let publicationHeld = false;
		let publicationSettled = false;
		try {
			const fixtureText = JSON.stringify({ kind: 'kqlx', version: 1, state: baseline }, null, 2);
			let document: vscode.TextDocument;
			if (nativeEncoding) {
				let encoded = Buffer.from(await vscode.workspace.encode(fixtureText, { encoding: scenario.encoding }));
				if (scenario.encoding === 'utf16le' && !encoded.subarray(0, 2).equals(utf16LeBom)) {
					encoded = Buffer.concat([utf16LeBom, encoded]);
				}
				assert.strictEqual(await vscode.workspace.decode(encoded, { encoding: scenario.encoding }), fixtureText);
				fs.writeFileSync(uri.fsPath, encoded);
				document = await vscode.workspace.openTextDocument(uri, { encoding: scenario.encoding });
				await vscode.window.showTextDocument(document, { preview: false });
				assert.strictEqual(document.getText(), fixtureText);
			} else {
				const fixtureBytes = Buffer.from(scenario.crlf ? fixtureText.replace(/\n/g, '\r\n') : fixtureText, 'utf8');
				fs.writeFileSync(uri.fsPath, scenario.bom ? Buffer.concat([utf8Bom, fixtureBytes]) : fixtureBytes);
				await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { preview: false });
				document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString())!;
			}
			assert.ok(document);
			assert.strictEqual(document.encoding, scenario.encoding);
			assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab =>
				tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()),
			'The fixture must be shown in a text tab for its exact URI');
			if (scenario.crlf) assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				value: any, publish: (value: unknown) => Promise<unknown>,
			) => {
				if (!scenario.rawDraft || publicationHeld || nativeSaves === 0
					|| !value?.sections?.some((section: any) => section?.resultJson === newResult)) return publish(value);
				publicationHeld = true;
				await publicationGate;
				try { return await publish(value); } finally { publicationSettled = true; }
			};
			(QueryEditorProvider as any).prototype.setWorkbenchFileCloseLifecycle = function (this: unknown, value: any) {
				lifecycle = value;
				return originalSetLifecycle.call(this, value);
			};
			if (scenario.retryPublication) {
				faultArmed = true;
				(fs.promises as any).open = async (target: fs.PathLike, flags?: any, ...rest: any[]) => {
					if (faultArmed && nativeSaves > 0 && flags === 'r+' && String(target) === uri.fsPath) {
						faultArmed = false;
						failedOpens++;
						throw Object.assign(new Error(`EACCES: permission denied, open '${uri.fsPath}'`), { code: 'EACCES' });
					}
					return (originalOpen as any).call(fs.promises, target, flags, ...rest);
				};
				(vscode.window as any).showWarningMessage = (message: string) => {
					warnings.push(String(message));
					return Promise.resolve(undefined);
				};
			}
			const registry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)({
				subscriptions: observers,
				workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global')),
			}, vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			undefined, registry) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						await reloadAwarePostMessage(() => receive, posted)(message);
						if (message?.type === 'requestFinalPersist') {
							const projection = [...posted].reverse().find(candidate => candidate?.type === 'documentData' && candidate.ok);
							void Promise.resolve().then(() => receive!({
								type: 'persistDocument', state, flush: true, reason: 'save', editRevision: 1,
								snapshotId: 'single-save-final', sourceGeneration: projection?.sourceGeneration,
								flushRequestId: message.requestId,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receive = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposals.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receive!({ type: 'requestDocument' }));
			registry.get(normalizeWorkbenchUriKey(uri))!.admitCanonicalSource('single-save-new-result', state);
			const projection = [...posted].reverse().find(message => message?.type === 'documentData' && message.ok);
			await Promise.resolve(receive!({
				type: 'persistDocument', state, editRevision: 1, snapshotId: 'single-save-edited',
				sourceGeneration: projection.sourceGeneration,
			}));
			assert.strictEqual(document.isDirty, true);
			assert.strictEqual(JSON.parse(document.getText()).state.sections[1].resultJson, newResult);
			assert.strictEqual(JSON.parse(readSavedText()).state.sections[1].resultJson, undefined);
			observers.push(vscode.workspace.onDidSaveTextDocument(saved => {
				if (saved.uri.toString() === uri.toString()) nativeSaves++;
			}));
			observers.push(vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.toString() !== uri.toString()) return;
				try { JSON.parse(event.document.getText()); } catch (error) {
					invalidVersions.push(event.document.version);
					fs.writeFileSync(path.join(tmpDir, `invalid-buffer-${event.document.version}.txt`), event.document.getText(), 'utf8');
					console.error(JSON.stringify({ version: event.document.version, length: event.document.getText().length, encoding: event.document.encoding, error: String(error) }));
				}
			}));
			(vscode.workspace as any).applyEdit = (edit: vscode.WorkspaceEdit) => {
				if (nativeSaves > 0 && edit.has(uri)) postCommitEdits++;
				return originalApplyEdit.call(vscode.workspace, edit);
			};
			if (scenario.rawDraft) {
				const saveResult = await Promise.race([
					Promise.resolve(document.save()),
					new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), waitMs)),
				]);
				assert.strictEqual(saveResult, true, 'The first native Save must commit while canonical publication is held');
				await waitForCondition(() => publicationHeld, 'Canonical publication must start after the first native Save', waitMs);
				const rowFreeText = readSavedText();
				const rowFree = JSON.parse(rowFreeText).state.sections;
				assert.strictEqual(rowFree[0].resultJson, oldResult);
				assert.strictEqual(rowFree[1].resultJson, undefined);
				const sourceText = document.getText();
				assert.ok(sourceText.startsWith('{'));
				const insertion = `${document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'}  "kwOpaqueDraft": "raw-draft-${path.basename(tmpDir)}",`;
				const draftText = sourceText.slice(0, 1) + insertion + sourceText.slice(1);
				const draftEdit = new vscode.WorkspaceEdit();
				draftEdit.insert(uri, document.positionAt(1), insertion);
				assert.strictEqual(await originalApplyEdit.call(vscode.workspace, draftEdit), true);
				assert.strictEqual(document.getText(), draftText);
				assert.strictEqual(publicationSettled, false);
				releasePublication();
				await waitForCondition(() => publicationSettled, 'Held canonical publication must settle after release', waitMs);
				await (provider as any).markdownDocumentQueues.get(normalizeWorkbenchUriKey(uri))?.tail;
				assert.strictEqual(document.isDirty, true, 'The raw draft must remain dirty');
				assert.strictEqual(document.getText(), draftText, 'The raw draft must be retained exactly');
				assert.strictEqual(readSavedText(), rowFreeText, 'Held publication must not overwrite the row-free saved file');
				assert.strictEqual(JSON.parse(readSavedText()).state.sections[0].resultJson, oldResult);
				assert.strictEqual(postCommitEdits, 0, 'Saving results must never submit a post-commit WorkspaceEdit');
				assert.strictEqual(nativeSaves, 1, 'Saving results must not call native Save a second time');
				assert.deepStrictEqual(invalidVersions, []);
			} else {
				const assertDurableAtReturn = (label: string) => {
					assert.strictEqual(document.isDirty, false, `${label}: the notebook must be clean when Save returns`);
					const diskText = readSavedText();
					assert.strictEqual(document.getText(), diskText, `${label}: the buffer must match the published file`);
					const sections = JSON.parse(diskText).state.sections;
					assert.strictEqual(sections[0].resultJson, oldResult);
					assert.strictEqual(sections[1].resultJson, newResult);
				};
				if (scenario.toolSave) {
					assert.ok(lifecycle, 'The provider must register a Save lifecycle');
					await lifecycle!.save();
					assertDurableAtReturn('Tool Save');
				} else if (scenario.retryPublication) {
					assert.ok(lifecycle, 'The provider must register a Save lifecycle');
					await assert.rejects(() => lifecycle!.save(), /could not confirm/);
					assert.strictEqual(failedOpens, 1, 'The first publication must reach the injected open failure');
					const rowFreeText = readSavedText();
					const rowFree = JSON.parse(rowFreeText).state.sections;
					assert.strictEqual(rowFree[0].resultJson, oldResult);
					assert.strictEqual(rowFree[1].resultJson, undefined);
					assert.strictEqual(document.isDirty, false);
					assert.strictEqual(JSON.parse(document.getText()).state.sections[1].resultJson, undefined);
					assert.ok(warnings.some(message => /could not confirm the final saved query results/.test(message)),
						'The failed publication must warn the user');
					assert.strictEqual(nativeSaves, 1);
					faultArmed = false;
					(fs.promises as any).open = originalOpen;
					await lifecycle!.save();
					assertDurableAtReturn('Retried Save');
					assert.strictEqual(failedOpens, 1);
				} else {
					assert.strictEqual(await document.save(), true);
					await waitForCondition(() => {
						try {
							const diskText = readSavedText();
							return !document.isDirty && diskText === document.getText()
								&& JSON.parse(diskText).state.sections[1].resultJson === newResult;
						} catch { return false; }
					}, 'Native Save must publish permitted rows and reconcile its clean source without another edit', waitMs);
				}
				assert.strictEqual(postCommitEdits, 0, 'Saving results must never submit a post-commit WorkspaceEdit');
				assert.strictEqual(nativeSaves, 1, 'Saving results must not call native Save a second time');
				assert.deepStrictEqual(invalidVersions, []);
				const savedBytes = fs.readFileSync(uri.fsPath);
				assert.strictEqual(savedBytes.subarray(0, 3).equals(utf8Bom), scenario.bom, 'Publication must preserve the raw BOM prefix');
				assert.strictEqual(savedBytes.subarray(0, 2).equals(utf16LeBom), scenario.encoding === 'utf16le',
					'Publication must preserve the UTF-16 LE BOM prefix');
				if (scenario.encoding === 'utf16le') {
					assert.ok(!savedBytes.subarray(2, 4).equals(utf16LeBom), 'Publication must not duplicate the UTF-16 LE BOM');
				}
				if (scenario.encoding === 'windows1252') {
					assert.ok(savedBytes.includes(0xe9), 'Windows-1252 publication must write e-acute as raw byte 0xE9');
					assert.ok(savedBytes.includes(0x80), 'Windows-1252 publication must write the euro sign as raw byte 0x80');
					assert.ok(!savedBytes.includes(Buffer.from([0xc3, 0xa9])), 'Windows-1252 publication must not write UTF-8 e-acute');
					assert.ok(!savedBytes.includes(Buffer.from([0xe2, 0x82, 0xac])), 'Windows-1252 publication must not write a UTF-8 euro sign');
				}
				if (nativeEncoding) {
					assert.strictEqual(await vscode.workspace.decode(savedBytes, { encoding: scenario.encoding }), document.getText(),
						'The native buffer must match the published bytes decoded with its encoding');
				}
				assert.strictEqual(document.encoding, scenario.encoding, 'Publication must preserve the native document encoding');
				const savedText = savedTextDecoder.decode(savedBytes);
				if (scenario.crlf) assert.ok(!/(?<!\r)\n/.test(savedText), 'Publication must preserve CRLF line endings');
				const saved = JSON.parse(savedText).state.sections;
				assert.strictEqual(saved[0].resultJson, oldResult);
				assert.strictEqual(saved[1].resultJson, newResult);
				assert.strictEqual(saved[1].name, 'Accepted result');
			}
			completed = true;
		} finally {
			releasePublication();
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			for (const dispose of disposals) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const observer of observers) observer.dispose();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(QueryEditorProvider as any).prototype.setWorkbenchFileCloseLifecycle = originalSetLifecycle;
			faultArmed = false;
			(fs.promises as any).open = originalOpen;
			(vscode.window as any).showWarningMessage = originalShowWarning;
			for (const document of vscode.workspace.textDocuments.filter(candidate => candidate.uri.toString() === uri.toString())) {
				if (document.isDirty) await document.save();
			}
			const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
				!tab.isDirty && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
			if (tabs.length) await vscode.window.tabGroups.close(tabs);
			if (completed) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
			else console.error(`Preserved failed single-save fixture: ${tmpDir}`);
		}
	});

	let virtualSaveProbeCounter = 0;
	test('native Save publishes results through a writable virtual filesystem', async function () {
		this.timeout(20_000);
		const scheme = `save-probe-${Date.now().toString(36)}${++virtualSaveProbeCounter}`;
		const uri = vscode.Uri.from({ scheme, path: '/single-save.kqlx' });
		const rootUri = vscode.Uri.from({ scheme, path: '/' });
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const oldResult = JSON.stringify({ columns: ['Old'], rows: [[7]], metadata: {} });
		const newResult = JSON.stringify({ columns: ['New'], rows: [[11]], metadata: {} });
		const baseline = { sections: [
			{ id: 'query_old', type: 'query', query: 'print Old=7', resultJson: oldResult },
			{ id: 'query_new', type: 'query', query: 'print New=11' },
		] };
		const state = { sections: baseline.sections.map(section => section.id === 'query_new'
			? { ...section, name: 'Accepted result', resultJson: newResult } : section) };
		const changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
		const rootTime = Date.now();
		let fileEntry = { data: new Uint8Array(), ctime: rootTime, mtime: rootTime };
		let providerWrites = 0;
		const notFound = (target: vscode.Uri) => vscode.FileSystemError.FileNotFound(target);
		const fileSystem: vscode.FileSystemProvider = {
			onDidChangeFile: changeEmitter.event,
			watch: () => new vscode.Disposable(() => undefined),
			stat: target => {
				if (target.path === '/') return { type: vscode.FileType.Directory, ctime: rootTime, mtime: rootTime, size: 0 };
				if (target.path === uri.path) {
					return { type: vscode.FileType.File, ctime: fileEntry.ctime, mtime: fileEntry.mtime, size: fileEntry.data.byteLength };
				}
				throw notFound(target);
			},
			readDirectory: target => {
				if (target.path !== '/') throw notFound(target);
				return [['single-save.kqlx', vscode.FileType.File]];
			},
			createDirectory: target => { throw vscode.FileSystemError.NoPermissions(target); },
			readFile: target => {
				if (target.path !== uri.path) throw notFound(target);
				return fileEntry.data.slice();
			},
			writeFile: (target, content) => {
				if (target.path !== uri.path) throw vscode.FileSystemError.NoPermissions(target);
				fileEntry = { data: content.slice(), ctime: fileEntry.ctime, mtime: Math.max(Date.now(), fileEntry.mtime + 1) };
				providerWrites++;
				queueMicrotask(() => changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri: target }]));
			},
			delete: target => { throw vscode.FileSystemError.NoPermissions(target); },
			rename: target => { throw vscode.FileSystemError.NoPermissions(target); },
		};
		const decoder = new TextDecoder();
		const providerText = () => decoder.decode(fileEntry.data);
		const posted: any[] = [];
		const disposals: Array<() => void> = [];
		const observers: vscode.Disposable[] = [];
		let receive: ((message: any) => unknown) | undefined;
		let nativeSaves = 0;
		let postCommitEdits = 0;
		const invalidVersions: number[] = [];
		const globalStorage = path.join(os.tmpdir(), `kw-${scheme}-global`);
		let registration: vscode.Disposable | undefined;
		try {
			registration = vscode.workspace.registerFileSystemProvider(scheme, fileSystem, { isCaseSensitive: true });
			fileEntry = { ...fileEntry, data: new TextEncoder().encode(JSON.stringify({ kind: 'kqlx', version: 1, state: baseline }, null, 2)) };
			assert.strictEqual((await vscode.workspace.fs.stat(rootUri)).type, vscode.FileType.Directory);
			const document = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(document, { preview: false });
			assert.strictEqual(document.getText(), providerText());
			assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab =>
				tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()),
			'The virtual fixture must be shown in a text tab for its exact URI');
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				value: any, publish: (value: unknown) => Promise<unknown>,
			) => publish(value);
			const registry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)({
				subscriptions: observers,
				workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(globalStorage),
			}, vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			undefined, registry) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						await reloadAwarePostMessage(() => receive, posted)(message);
						if (message?.type === 'requestFinalPersist') {
							const projection = [...posted].reverse().find(candidate => candidate?.type === 'documentData' && candidate.ok);
							void Promise.resolve().then(() => receive!({
								type: 'persistDocument', state, flush: true, reason: 'save', editRevision: 1,
								snapshotId: 'virtual-save-final', sourceGeneration: projection?.sourceGeneration,
								flushRequestId: message.requestId,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receive = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposals.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receive!({ type: 'requestDocument' }));
			registry.get(normalizeWorkbenchUriKey(uri))!.admitCanonicalSource('virtual-save-new-result', state);
			const projection = [...posted].reverse().find(message => message?.type === 'documentData' && message.ok);
			await Promise.resolve(receive!({
				type: 'persistDocument', state, editRevision: 1, snapshotId: 'virtual-save-edited',
				sourceGeneration: projection.sourceGeneration,
			}));
			assert.strictEqual(document.isDirty, true);
			assert.strictEqual(JSON.parse(document.getText()).state.sections[1].resultJson, newResult);
			assert.strictEqual(JSON.parse(providerText()).state.sections[1].resultJson, undefined);
			observers.push(vscode.workspace.onDidSaveTextDocument(saved => {
				if (saved.uri.toString() === uri.toString()) nativeSaves++;
			}));
			observers.push(vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.toString() !== uri.toString()) return;
				try { JSON.parse(event.document.getText()); } catch { invalidVersions.push(event.document.version); }
			}));
			(vscode.workspace as any).applyEdit = (edit: vscode.WorkspaceEdit) => {
				if (nativeSaves > 0 && edit.has(uri)) postCommitEdits++;
				return originalApplyEdit.call(vscode.workspace, edit);
			};
			assert.strictEqual(await document.save(), true);
			await waitForCondition(() => {
				try {
					const text = providerText();
					return !document.isDirty && text === document.getText()
						&& JSON.parse(text).state.sections[1].resultJson === newResult;
				} catch { return false; }
			}, 'Native Save must publish results to the virtual provider and reload its clean source', 10_000);
			assert.strictEqual(postCommitEdits, 0, 'Saving results must never submit a post-commit WorkspaceEdit');
			assert.strictEqual(nativeSaves, 1, 'Saving results must not call native Save a second time');
			assert.deepStrictEqual(invalidVersions, []);
			assert.ok(providerWrites >= 1);
			const saved = JSON.parse(providerText()).state.sections;
			assert.strictEqual(saved[0].resultJson, oldResult);
			assert.strictEqual(saved[1].resultJson, newResult);
			assert.strictEqual(saved[1].name, 'Accepted result');
			assert.strictEqual(document.getText(), providerText());
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			for (const dispose of disposals) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const observer of observers) observer.dispose();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			for (const document of vscode.workspace.textDocuments.filter(candidate => candidate.uri.toString() === uri.toString())) {
				if (document.isDirty) await document.save();
			}
			const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
				!tab.isDirty && tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
			if (tabs.length) await vscode.window.tabGroups.close(tabs);
			fs.rmSync(globalStorage, { recursive: true, force: true, maxRetries: 3 });
			registration?.dispose();
			changeEmitter.dispose();
		}
	});

	test('source reload rolls back an already-started stale edit for rich and compatibility providers', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kqlx', Provider: KqlxEditorProvider, type: 'query', wrapped: true },
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query', wrapped: false },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql', wrapped: false },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-stale-edit-rollback-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			for (const [index, variant] of variants.entries()) {
				const wrap = (query: string) => variant.wrapped
					? JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
						{ id: 'primary_1', type: variant.type, query },
					] } })
					: query;
				let currentText = wrap('initial');
				const staleText = wrap('stale');
				const externalText = wrap('external');
				const sourcePath = path.join(tmpDir, `race-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				let delayStaleEdit = false;
				let releaseStale!: () => void;
				let staleStarted = false;
				let reloadDelivered = false;
				const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
				let expectReloadDelivery = false;
				let rejectedRollback = false;
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					if (delayStaleEdit && replacement.includes('stale')) {
						delayStaleEdit = false;
						staleStarted = true;
						await staleGate;
					}
					if (!rejectedRollback && currentText.includes('stale') && replacement.includes('external')) {
						rejectedRollback = true;
						return false;
					}
					currentText = replacement;
					return true;
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const lines = () => currentText.split(/\r?\n/);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
					get lineCount() { return lines().length; },
					lineAt: (line: number) => ({ text: lines()[line] || '' }),
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (expectReloadDelivery && message?.type === 'documentData') reloadDelivered = true;
							if (message?.reloadRequestId) {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true,
					onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
					.at(-1)?.sourceGeneration;
				delayStaleEdit = true;
				let stalePersistSettled = false;
				const stalePersist = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', snapshotId: `stale-rollback-${index}`,
					sourceGeneration, editRevision: 1,
					state: { sections: [{ id: 'primary_1', type: variant.type, query: 'stale' }] },
				}, { replaceExistingId: !variant.wrapped }))).finally(() => { stalePersistSettled = true; });
				await waitForCondition(() => staleStarted, `${variant.extension} stale edit should start`, 1_000);
				currentText = externalText;
				expectReloadDelivery = true;
				let reloadSettled = false;
				const reload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }))
					.finally(() => { reloadSettled = true; });
				await waitForCondition(() => reloadDelivered, `${variant.extension} reload should deliver documentData`, 1_000);
				releaseStale();
				await waitForCondition(() => stalePersistSettled, `${variant.extension} stale persist should settle`, 1_000);
				await waitForCondition(() => reloadSettled, `${variant.extension} reload should settle`, 1_000);
				await Promise.all([stalePersist, reload]);
				await waitForCondition(() => variant.wrapped
					? JSON.parse(currentText).state.sections[0].query === 'external'
					: currentText === externalText, `${variant.extension} must restore external reload text`);
				assert.strictEqual(rejectedRollback, true, `${variant.extension} should retry a rejected authority rollback`);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('newer direct text arriving during applyEdit is never acknowledged or overwritten', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kqlx', Provider: KqlxEditorProvider, type: 'query', wrapped: true },
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query', wrapped: false },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql', wrapped: false },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-direct-edit-during-apply-'));
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (state: any, publish: (value: any) => Promise<unknown>) => publish(state);
			for (const [index, variant] of variants.entries()) {
				const wrap = (query: string) => variant.wrapped
					? JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id: 'primary_1', type: variant.type, query }] } })
					: query;
				let currentText = wrap('initial');
				const directText = wrap('DIRECT_NEWER');
				const sourcePath = path.join(tmpDir, `direct-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					if (replacement.includes('STALE_CANDIDATE')) currentText = directText;
					return true;
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-direct-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const lines = () => currentText.split(/\r?\n/);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
					get lineCount() { return lines().length; }, lineAt: (line: number) => ({ text: lines()[line] || '' }),
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
					.at(-1)?.sourceGeneration;
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', snapshotId: `direct-${index}`, sourceGeneration, editRevision: 1,
					state: { sections: [{ id: 'primary_1', type: variant.type, query: 'STALE_CANDIDATE' }] },
				}, { replaceExistingId: !variant.wrapped })));
				await waitForCondition(() => variant.wrapped
					? JSON.parse(currentText).state.sections[0].query === 'DIRECT_NEWER'
					: currentText === directText, `${variant.extension} newer direct text should survive`);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === `direct-${index}`));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('exact owned source events do not hide an immediate unowned edit', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kqlx', Provider: KqlxEditorProvider, type: 'query', wrapped: true },
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query', wrapped: false },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql', wrapped: false },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-exact-owned-source-edit-'));
		let releaseCurrentApply: (() => void) | undefined;
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			for (const [index, variant] of variants.entries()) {
				const wrap = (query: string) => variant.wrapped
					? JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id: 'primary_1', type: variant.type, query }] } })
					: query;
				let currentText = wrap('initial');
				const directText = wrap('DIRECT_UNOWNED');
				const sourcePath = path.join(tmpDir, `owned-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let changeHandler: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
				let markOwnedApplied!: () => void;
				let releaseOwnedApply!: () => void;
				const ownedApplied = new Promise<void>(resolve => { markOwnedApplied = resolve; });
				const ownedApplyGate = new Promise<void>(resolve => { releaseOwnedApply = resolve; });
				releaseCurrentApply = releaseOwnedApply;
				const posted: any[] = [];
				(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
					changeHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
					if (replacement.includes('OWNED_CANDIDATE')) {
						markOwnedApplied();
						await ownedApplyGate;
					}
					return true;
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-owned-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const lines = () => currentText.split(/\r?\n/);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
					get lineCount() { return lines().length; }, lineAt: (line: number) => ({ text: lines()[line] || '' }),
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
					.at(-1)?.sourceGeneration;
				const persist = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', snapshotId: `owned-${index}`, sourceGeneration, editRevision: 1,
					state: { sections: [{ id: 'primary_1', type: variant.type, query: 'OWNED_CANDIDATE' }] },
				}, { replaceExistingId: !variant.wrapped })));
				await ownedApplied;
				currentText = directText;
				await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
				await waitForCondition(
					() => posted.some(message => message?.type === 'documentData'
						&& message?.state?.sections?.[0]?.query === 'DIRECT_UNOWNED'),
					`${variant.extension} should reload the immediate unowned edit`,
				);
				releaseOwnedApply();
				releaseCurrentApply = undefined;
				await persist;
				assert.strictEqual(currentText, directText);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === `owned-${index}`));
			}
		} finally {
			releaseCurrentApply?.();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('CRLF compatibility source events distinguish owned and immediate unowned text', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-crlf-owned-source-edit-'));
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			for (const [index, variant] of variants.entries()) {
				let currentText = 'initial\r\nsource';
				const sourcePath = path.join(tmpDir, `owned-crlf-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let changeHandler: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
				const posted: any[] = [];
				(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
					changeHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement.replace(/\n/g, '\r\n');
					await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
					return true;
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-owned-crlf-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const lines = () => currentText.split(/\r\n/);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.CRLF,
					get lineCount() { return lines().length; }, lineAt: (line: number) => ({ text: lines()[line] || '' }),
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', snapshotId: `owned-crlf-${index}`, editRevision: 1,
					state: { sections: [{ id: 'primary_1', type: variant.type, query: 'OWNED\nCANDIDATE' }] },
				}, { replaceExistingId: true })));
				await waitForCondition(
					() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === `owned-crlf-${index}`),
					`${variant.extension} should acknowledge its own CRLF-normalized edit`,
				);

				posted.length = 0;
				currentText = 'DIRECT\r\nUNOWNED';
				await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
				await waitForCondition(
					() => posted.some(message => message?.type === 'documentData'
						&& message?.state?.sections?.[0]?.query === 'DIRECT\r\nUNOWNED'),
					`${variant.extension} should reload the immediate unowned CRLF edit`,
				);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked write never rolls back a newer direct edit after applyEdit', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOpenTextDocument = vscode.workspace.openTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-newer-edit-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let linkedText = 'BASELINE';
		let rollbackCalls = 0;
		const linkedUri = vscode.Uri.file(linkedPath);
		const linkedDocument = {
			uri: linkedUri, getText: () => linkedText,
			positionAt: (_offset: number) => new vscode.Position(0, 0),
			isDirty: true, save: async () => true,
		} as any;

		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, linkedText, 'utf8');
			(vscode.workspace as any).openTextDocument = async (uri: vscode.Uri) => {
				if (uri.toString() === linkedUri.toString()) return linkedDocument;
				return originalOpenTextDocument(uri);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (entry?.[0]?.toString() !== linkedUri.toString() || typeof replacement !== 'string') return false;
				if (replacement === 'STALE_CANDIDATE') {
					linkedText = replacement;
					linkedText = 'DIRECT_NEWER';
					return true;
				}
				rollbackCalls++;
				linkedText = replacement;
				return true;
			};

			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'linked-direct-newer', editRevision: 1,
				sourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'STALE_CANDIDATE' },
				] },
			}));
			assert.strictEqual(linkedText, 'DIRECT_NEWER');
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'linked-direct-newer'));
			assert.strictEqual(rollbackCalls, 0, 'a newer direct linked edit must never be rolled back');
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).openTextDocument = originalOpenTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('exhausted source rollback blocks KQLX native Save', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-source-rollback-fence-'));
		const sourcePath = path.join(tmpDir, 'fenced.kqlx');
		const wrap = (query: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ id: 'query_1', type: 'query', query }] },
		});
		let currentText = wrap('initial');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let markStaleStarted!: () => void;
		let releaseStale!: () => void;
		let markReloadDelivered!: () => void;
		const staleStarted = new Promise<void>(resolve => { markStaleStarted = resolve; });
		const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
		const reloadDelivered = new Promise<void>(resolve => { markReloadDelivered = resolve; });
		let expectReloadDelivery = false;
		try {
			fs.writeFileSync(sourcePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (state: any, publish: (value: any) => Promise<unknown>) => publish(state);
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => { willSaveHandler = handler; return { dispose() {} }; };
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (replacement.includes('stale')) {
					markStaleStarted();
					await staleGate;
					currentText = replacement;
					return true;
				}
				if (replacement.includes('external') && currentText.includes('stale')) return false;
				currentText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (expectReloadDelivery && message?.type === 'documentData') markReloadDelivered();
						if (message?.reloadRequestId) {
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'exhausted-source-rollback', editRevision: 1,
				sourceGeneration, state: { sections: [{ id: 'query_1', type: 'query', query: 'stale' }] },
			}));
			await staleStarted;
			currentText = wrap('external');
			expectReloadDelivery = true;
			const reload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await reloadDelivered;
			let inFlightSave: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { inFlightSave = value; } });
			await assert.rejects(inFlightSave!, /source update is still settling/);
			releaseStale();
			await Promise.all([stalePersist, reload]);
			assert.ok(currentText.includes('stale'), 'failed rollback should leave the exact stale candidate fenced');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(currentText.includes('stale'), 'requestDocument must not clear the unresolved stale candidate');

			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			await assert.rejects(waited!, /external reload could not be restored/);
		} finally {
			releaseStale();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('exhausted CRLF compatibility rollback remains fenced through requestDocument', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-crlf-rollback-fence-'));
		let releaseCurrentStale: (() => void) | undefined;
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			for (const [index, variant] of variants.entries()) {
				let currentText = 'initial\r\nsource';
				const sourcePath = path.join(tmpDir, `fenced-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let willSaveHandler: ((event: any) => unknown) | undefined;
				const posted: any[] = [];
				let markStaleStarted!: () => void;
				let releaseStale!: () => void;
				let markReloadDelivered!: () => void;
				const staleStarted = new Promise<void>(resolve => { markStaleStarted = resolve; });
				const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
				const reloadDelivered = new Promise<void>(resolve => { markReloadDelivered = resolve; });
				releaseCurrentStale = releaseStale;
				let delayStale = true;
				let expectReloadDelivery = false;
				let rollbackAttempts = 0;
				(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					if (delayStale && replacement.includes('stale')) {
						delayStale = false;
						markStaleStarted();
						await staleGate;
						currentText = replacement.replace(/\n/g, '\r\n');
						return true;
					}
					if (replacement.includes('external') && currentText.replace(/\r\n/g, '\n').includes('stale')) {
						rollbackAttempts++;
						return false;
					}
					currentText = replacement;
					return true;
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-crlf-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const lines = () => currentText.split(/\r\n|\n/);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText, eol: vscode.EndOfLine.CRLF,
					get lineCount() { return lines().length; }, lineAt: (line: number) => ({ text: lines()[line] || '' }),
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (expectReloadDelivery && message?.type === 'documentData') markReloadDelivered();
							if (message?.reloadRequestId) {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return message?.type !== 'requestFinalPersist';
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const stalePersist = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 1,
					state: { sections: [{ id: 'primary_1', type: variant.type, query: 'stale\ncandidate' }] },
				}, { replaceExistingId: true })));
				await staleStarted;
				currentText = 'external\r\nauthority';
				expectReloadDelivery = true;
				const reload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await reloadDelivered;
				releaseStale();
				releaseCurrentStale = undefined;
				await Promise.all([stalePersist, reload]);
				assert.strictEqual(currentText.replace(/\r\n/g, '\n'), 'stale\ncandidate');
				assert.strictEqual(rollbackAttempts, 3, `${variant.extension} should exhaust rollback retries`);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				let waited: Promise<unknown> | undefined;
				willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
				await assert.rejects(waited!, /external reload could not be restored/);
			}
		} finally {
			releaseCurrentStale?.();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session acknowledges only after its storage write succeeds', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const originalOpen = fs.promises.open;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-write-failure-'));
		const storageUri = vscode.Uri.file(tmpDir);
		const sessionUri = vscode.Uri.joinPath(storageUri, 'session.kqlx');
		let storedText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		fs.writeFileSync(sessionUri.fsPath, storedText, 'utf8');
		let failNextSessionOpen = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			(fs.promises as any).open = async (...args: any[]) => {
				const requestedPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
				if (failNextSessionOpen && requestedPath === path.resolve(sessionUri.fsPath) && args[1] === 'r+') {
					failNextSessionOpen = false;
					throw new Error('blocked session storage write');
				}
				return (originalOpen as any)(...args);
			};

			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: storageUri,
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: sessionUri, getText: () => storedText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1)?.sourceGeneration;
			assert.ok(Number.isSafeInteger(sourceGeneration));
			posted.length = 0;
			const initialBytes = fs.readFileSync(sessionUri.fsPath, 'utf8');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-malformed', sourceGeneration, editRevision: 1,
				state: {},
			}));
			let accessorReads = 0;
			const accessorState = Object.defineProperty({}, 'sections', {
				enumerable: true,
				get: () => { accessorReads++; return []; },
			});
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-accessor', sourceGeneration, editRevision: 1,
				state: accessorState,
			}));
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: ['session-aliased'],
				sourceGeneration: String(sourceGeneration), editRevision: '1',
				state: { sections: [{ id: 'query_1', type: 'query', query: 'MUST_NOT_PERSIST' }] },
			}));
			await Promise.resolve(receiveHandler!(new Proxy({
				type: 'persistDocument', snapshotId: 'session-proxy',
				sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'MUST_NOT_PERSIST_PROXY' }] },
			}, {})));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(accessorReads, 0, 'native persistence admission must not invoke state accessors');
			assert.strictEqual(fs.readFileSync(sessionUri.fsPath, 'utf8'), initialBytes);
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& (message.snapshotId === 'session-malformed' || message.snapshotId === 'session-accessor'
					|| message.snapshotId === 'session-aliased' || message.snapshotId === 'session-proxy')));

			failNextSessionOpen = true;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-failed', sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'print failed = 1' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.strictEqual(failNextSessionOpen, false, 'the failed snapshot should reach its scoped storage write');
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'session-failed'));

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-retry', sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'print retry = 2' }] },
			}));
			try {
				await waitForCondition(() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'session-retry'), 'session retry should acknowledge');
			} catch {
				assert.fail(JSON.stringify({ storedText: fs.readFileSync(sessionUri.fsPath, 'utf8'), posted }));
			}
			storedText = fs.readFileSync(sessionUri.fsPath, 'utf8');
			assert.strictEqual(JSON.parse(storedText).state.sections[0].query, 'print retry = 2');

			const displacedSessionPath = path.join(tmpDir, 'accepted-session.kqlx');
			fs.renameSync(sessionUri.fsPath, displacedSessionPath);
			fs.writeFileSync(sessionUri.fsPath, storedText, 'utf8');
			posted.length = 0;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-identity-replaced', sourceGeneration, editRevision: 2,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'MUST_NOT_REPLACE_INODE' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'session-identity-replaced'));
			assert.strictEqual(fs.readFileSync(sessionUri.fsPath, 'utf8'), storedText);
			assert.strictEqual(fs.readFileSync(displacedSessionPath, 'utf8'), storedText);

			fs.writeFileSync(sessionUri.fsPath, JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [{ id: 'external_1', type: 'query', query: 'EXTERNAL' }] },
			}), 'utf8');
			posted.length = 0;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-repeat', sourceGeneration, editRevision: 2,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'print retry = 2' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'session-repeat'));
			storedText = fs.readFileSync(sessionUri.fsPath, 'utf8');
			assert.strictEqual(JSON.parse(storedText).state.sections[0].query, 'EXTERNAL');
		} finally {
			(fs.promises as any).open = originalOpen;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session persists result replacement and preserves it when a later snapshot omits attachments', async () => {
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-result-transition-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{
					id: 'sql_1', type: 'sql', query: 'select 1', resultJson: '{"rows":[["A"]]}',
					resultArtifact: {
						version: 1, artifactId: 'artifact-a', sourceBoxId: 'sql_1', revision: 1, createdAt: 1,
					},
				},
			] },
		});
		fs.writeFileSync(sessionPath, currentText, 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const diskAtAck = new Map<string, any>();
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (state: any, publish: (value: any) => Promise<unknown>) => publish(state);
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'persistDocumentAck') {
							diskAtAck.set(String(message.snapshotId), JSON.parse(fs.readFileSync(sessionPath, 'utf8')));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			posted.length = 0;

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'result-b', sourceGeneration, editRevision: 1,
				state: { sections: [{
					id: 'sql_1', type: 'sql', query: 'select 1', resultJson: '{"rows":[["B"]]}',
					resultArtifact: {
						version: 1, artifactId: 'artifact-b', sourceBoxId: 'sql_1', revision: 2, createdAt: 2,
					},
				}] },
			}));
			await waitForCondition(() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'result-b'), 'result B should acknowledge');
			assert.strictEqual(diskAtAck.get('result-b').state.sections[0].resultJson, '{"rows":[["B"]]}');
			assert.strictEqual(diskAtAck.get('result-b').state.sections[0].resultArtifact.artifactId, 'artifact-b');
			currentText = fs.readFileSync(sessionPath, 'utf8');
			assert.strictEqual(JSON.parse(currentText).state.sections[0].resultJson, '{"rows":[["B"]]}');

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'result-cleared', sourceGeneration, editRevision: 2,
				state: { sections: [{ id: 'sql_1', type: 'sql', query: 'select 1' }] },
			}));
			await waitForCondition(() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'result-cleared'), 'result removal should acknowledge');
			assert.strictEqual(diskAtAck.get('result-cleared').state.sections[0].resultJson, '{"rows":[["B"]]}');
			assert.strictEqual(diskAtAck.get('result-cleared').state.sections[0].resultArtifact.artifactId, 'artifact-b');
			currentText = fs.readFileSync(sessionPath, 'utf8');
			assert.strictEqual(JSON.parse(currentText).state.sections[0].resultJson, '{"rows":[["B"]]}');
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session close materializes a committed Run All result when confirmation persistence is lost', async () => {
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-run-all-result-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const querySection = {
			id: 'query_run_all', type: 'query', query: 'print First=1; print Second=2', runMode: 'runAll',
		};
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [querySection] },
		});
		fs.writeFileSync(sessionPath, currentText, 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(resultOwner);
			const result = {
				columns: ['First'], rows: [[1]], metadata: {},
				additionalResults: {
					version: 1,
					sets: [{ resultIndex: 1, columns: ['Second'], rows: [[2]], metadata: {} }],
				},
			};
			const resultSession = resultOwner.openPanel('run-all-result-test');
			resultSession.openSection('query_run_all', 'run-all-section-instance');
			resultSession.adoptTarget({
				boxId: 'query_run_all', sectionInstanceId: 'run-all-section-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const,
				boxId: 'query_run_all', sectionInstanceId: 'run-all-section-instance', targetGeneration: 1,
				executionId: 'run-all-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'run-all-activity',
				},
				result,
			};
			assert.strictEqual(resultSession.beginExecution(terminal), true);
			assert.ok(resultSession.stagePublication('run-all-publication', terminal));
			assert.strictEqual(resultSession.commitPublication('run-all-publication'), true);
			await Promise.resolve(receiveHandler!({
				type: 'requestDocument', requestId: 'routine-request-after-run-all-commit',
			}));
			assert.strictEqual(
				resultOwner.hasCommittedAttachments(),
				true,
				'Routine requestDocument must not retire a newer host result attachment',
			);

			for (const dispose of disposeHandlers) dispose();
			await waitForCondition(
				() => {
					const file = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
					return !!file.state.sections[0]?.resultJson;
				},
				'Run All result should reach disk during close',
			);

			const persistedSection = JSON.parse(fs.readFileSync(sessionPath, 'utf8')).state.sections[0];
			const persistedBatch = JSON.parse(String(persistedSection?.resultJson || '{}'));
			assert.strictEqual(persistedSection?.resultArtifact.producer.dispatch.clusterEndpoint, 'https://cluster.kusto.windows.net');
			assert.strictEqual(persistedSection?.resultArtifact.producer.dispatch.authorityId, 'authority');
			assert.strictEqual(persistedSection?.resultArtifact.producer.connectionId, 'connection-1');
			assert.strictEqual(persistedSection?.resultArtifact.producer.database, 'Db');
			assert.strictEqual(1 + (persistedBatch.additionalResults?.sets?.length || 0), 2);
			assert.strictEqual(persistedSection?.resultArtifact.artifactId, 'result:query_run_all:1');
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'Run All close recovery should fully release the session editor',
			);
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const closeNativeDocument of [false, true]) test(
		closeNativeDocument
			? 'ordinary rich close materializes a committed Run All result without editing after its native tab closes'
			: 'ordinary rich close materializes a committed Run All result when confirmation persistence is lost',
		async function () {
		this.timeout(20_000);
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFileOpen = fs.promises.open;
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-file-run-all-result-'));
		const filePath = path.join(tmpDir, 'workbook.kqlx');
		const uri = vscode.Uri.file(filePath);
		const querySection = {
			id: 'query_run_all', type: 'query', query: 'print First=1; print Second=2', runMode: 'runAll',
			name: 'Initial query',
		};
		fs.writeFileSync(filePath, JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [querySection] },
		}), 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		const posted: any[] = [];
		const sourceEdits: Array<{ closed: boolean; afterNativeTabClose: boolean; replacementLength: number }> = [];
		let nativeTabClosed = false;
		let privacyPublicationDepth = 0;
		const durablePublicationLocks: boolean[] = [];
		let completed = false;
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				privacyPublicationDepth++;
				try { return await publish(state); }
				finally { privacyPublicationDepth--; }
			};
			(fs.promises as any).open = async (...args: any[]) => {
				if (String(args[0]).toLowerCase() === filePath.toLowerCase() && args[1] === 'r+') {
					durablePublicationLocks.push(privacyPublicationDepth > 0);
				}
				return (originalFileOpen as any)(...args);
			};
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			if (closeNativeDocument) {
				await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { preview: false });
			}
			const document = closeNativeDocument
				? vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString())!
				: await vscode.workspace.openTextDocument(uri);
			assert.ok(document, 'PRECONDITION: the native text tab must expose its document');
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacements = edit.entries().find(([target]) => target.toString() === uri.toString())?.[1];
				if (replacements?.length) sourceEdits.push({
					closed: document.isClosed, afterNativeTabClose: nativeTabClosed, replacementLength: replacements[0].newText.length,
				});
				return originalApplyEdit.call(vscode.workspace, edit);
			};
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							const projection = [...posted].reverse().find(candidate => candidate?.type === 'documentData' && candidate.ok);
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', state: { sections: [querySection] }, flush: true, reason: 'save',
								editRevision: 1, snapshotId: 'run-all-close-save', flushRequestId: message.requestId,
								sourceGeneration: projection?.sourceGeneration,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			if (!closeNativeDocument) {
				const projection = [...posted].reverse().find(message => message?.type === 'documentData' && message.ok);
				querySection.name = 'Accepted query';
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', state: { sections: [querySection] }, editRevision: 1,
					snapshotId: 'run-all-close-control', sourceGeneration: projection?.sourceGeneration,
				}));
				assert.ok(sourceEdits.length > 0, 'PRECONDITION: observe a real provider edit before checking retired writes');
				assert.strictEqual(await document.save(), true);
				await waitForCondition(() => !document.isDirty, 'PRECONDITION: initial query edit must be saved');
			}
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!resultOwner) throw new Error('Ordinary KQLX result owner was not created.');
			const resultSession = resultOwner.openPanel('ordinary-run-all-result-test');
			resultSession.openSection(querySection.id, 'ordinary-run-all-instance');
			resultSession.adoptTarget({
				boxId: querySection.id, sectionInstanceId: 'ordinary-run-all-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const,
				boxId: querySection.id, sectionInstanceId: 'ordinary-run-all-instance', targetGeneration: 1,
				executionId: 'ordinary-run-all-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'ordinary-run-all',
				},
				result: {
					columns: ['First'], rows: [[1]], metadata: {},
					additionalResults: {
						version: 1,
						sets: [{ resultIndex: 1, columns: ['Second'], rows: [[2]], metadata: {} }],
					},
				},
			};
			assert.strictEqual(resultSession.beginExecution(terminal), true);
			assert.ok(resultSession.stagePublication('ordinary-run-all-publication', terminal));
			assert.strictEqual(resultSession.commitPublication('ordinary-run-all-publication'), true);

			if (closeNativeDocument) {
				const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
					tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
				assert.strictEqual(tabs.length, 1, 'PRECONDITION: exactly one task-owned native text tab');
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(await vscode.window.tabGroups.close(tabs), true);
				nativeTabClosed = true;
			}
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'Ordinary KQLX result close should fully release the editor',
			);
			assert.deepStrictEqual(sourceEdits.filter(edit => edit.closed), [],
				'Close materialization must not issue a WorkspaceEdit against its retired native document');
			assert.deepStrictEqual(sourceEdits.filter(edit => edit.afterNativeTabClose), [],
				'Close materialization must not issue a WorkspaceEdit after its last native tab closes');
			assert.deepStrictEqual(durablePublicationLocks, [true],
				'New close results must be written while fresh privacy publication remains locked');
			const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[0];
			const result = JSON.parse(persisted.resultJson);
			assert.strictEqual(persisted.query, querySection.query);
			assert.strictEqual(persisted.name, querySection.name);
			assert.strictEqual(result.columns[0].name ?? result.columns[0], 'First');
			assert.strictEqual(String(result.rows[0][0].full ?? result.rows[0][0]), '1');
			assert.strictEqual(result.additionalResults.sets[0].columns[0].name ?? result.additionalResults.sets[0].columns[0], 'Second');
			assert.strictEqual(String(result.additionalResults.sets[0].rows[0][0].full ?? result.additionalResults.sets[0].rows[0][0]), '2');
			assert.strictEqual(persisted.resultArtifact.artifactId, 'result:query_run_all:1');
			if (closeNativeDocument) {
				if (document.isClosed) assert.ok(!vscode.workspace.textDocuments.some(candidate => candidate.uri.toString() === uri.toString()),
					'Close materialization must not recreate a retired native document');
				assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab =>
					'uri' in (tab.input as object) && (tab.input as vscode.TabInputText).uri.toString() === uri.toString()),
					'Close materialization must not reopen the notebook');
			}
			completed = true;
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(fs.promises as any).open = originalFileOpen;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			for (const dispose of disposeHandlers) dispose();
			for (const candidate of vscode.workspace.textDocuments.filter(candidate => candidate.uri.toString() === uri.toString())) {
				if (candidate.isDirty) await candidate.save();
			}
			const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
				!tab.isDirty && 'uri' in (tab.input as object) && (tab.input as vscode.TabInputText).uri.toString() === uri.toString());
			if (tabs.length) await vscode.window.tabGroups.close(tabs);
			if (completed) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
			else console.error(`Preserved failed native-close fixture: ${tmpDir}`);
		}
	});

	test('ordinary rich close does not resurrect an explicitly removed result section', async () => {
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-file-result-close-section-removal-'));
		const filePath = path.join(tmpDir, 'workbook.kqlx');
		const querySection = { id: 'query_remove', type: 'query', query: 'print Value=1' };
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [querySection] } });
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const owner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!owner) throw new Error('Result owner was not created.');
			const session = owner.openPanel('explicit-removal-result');
			session.openSection(querySection.id, 'explicit-removal-instance');
			session.adoptTarget({
				boxId: querySection.id, sectionInstanceId: 'explicit-removal-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const, boxId: querySection.id,
				sectionInstanceId: 'explicit-removal-instance', targetGeneration: 1,
				executionId: 'explicit-removal-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1,
					clientActivityId: 'explicit-removal-close',
				},
				result: { columns: ['Value'], rows: [[1]], metadata: {} },
			};
			assert.strictEqual(session.beginExecution(terminal), true);
			assert.ok(session.stagePublication('explicit-removal-publication', terminal));
			assert.strictEqual(session.commitPublication('explicit-removal-publication'), true);
			assert.strictEqual(session.closeSection(querySection.id, 'explicit-removal-instance', false), true);

			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections, []);
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('ordinary rich close does not overwrite an external file replacement during result materialization', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-file-result-close-replacement-'));
		const filePath = path.join(tmpDir, 'workbook.kqlx');
		const displacedPath = path.join(tmpDir, 'workbook.accepted.kqlx');
		const querySection = { id: 'query_1', type: 'query', query: 'print Value=1' };
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [querySection] } });
		const externalText = JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot: 'external',
			state: { sections: [{ ...querySection, query: 'print External=2' }] },
		});
		let currentText = initialText;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let saveCalls = 0;
		let replaced = false;
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				if (!replaced && state.sections.some((section: any) => section.resultJson)) {
					replaced = true;
					fs.renameSync(filePath, displacedPath);
					fs.writeFileSync(filePath, externalText, 'utf8');
				}
				return publish(state);
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				return true;
			};
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
				save: async () => {
					saveCalls++;
					fs.writeFileSync(filePath, currentText, 'utf8');
					return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const owner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!owner) throw new Error('Result owner was not created.');
			const session = owner.openPanel('replacement-result');
			session.openSection(querySection.id, 'replacement-instance');
			session.adoptTarget({
				boxId: querySection.id, sectionInstanceId: 'replacement-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const, boxId: querySection.id,
				sectionInstanceId: 'replacement-instance', targetGeneration: 1,
				executionId: 'replacement-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'replacement-close',
				},
				result: { columns: ['Value'], rows: [[1]], metadata: {} },
			};
			assert.strictEqual(session.beginExecution(terminal), true);
			assert.ok(session.stagePublication('replacement-publication', terminal));
			assert.strictEqual(session.commitPublication('replacement-publication'), true);

			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
			assert.strictEqual(replaced, true, 'External replacement must occur at the actual result publication boundary');
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), externalText);
			assert.strictEqual(saveCalls, 0);
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('ordinary rich close does not overwrite a same-inode external edit during result materialization', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-file-result-close-in-place-'));
		const filePath = path.join(tmpDir, 'workbook.kqlx');
		const querySection = { id: 'query_1', type: 'query', query: 'print Value=1' };
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [querySection] } });
		const externalText = JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot: 'external',
			state: { sections: [{ ...querySection, query: 'print External=2' }] },
		});
		let currentText = initialText;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let saveCalls = 0;
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				return true;
			};
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
				save: async () => { saveCalls++; return true; },
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const owner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!owner) throw new Error('Result owner was not created.');
			const session = owner.openPanel('in-place-result');
			session.openSection(querySection.id, 'in-place-instance');
			session.adoptTarget({
				boxId: querySection.id, sectionInstanceId: 'in-place-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const, boxId: querySection.id,
				sectionInstanceId: 'in-place-instance', targetGeneration: 1,
				executionId: 'in-place-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'in-place-close',
				},
				result: { columns: ['Value'], rows: [[1]], metadata: {} },
			};
			assert.strictEqual(session.beginExecution(terminal), true);
			assert.ok(session.stagePublication('in-place-publication', terminal));
			assert.strictEqual(session.commitPublication('in-place-publication'), true);

			const identityBefore = await fs.promises.stat(filePath, { bigint: true });
			const externalHandle = await fs.promises.open(filePath, 'r+');
			try {
				await externalHandle.truncate(0);
				await externalHandle.writeFile(externalText, 'utf8');
				await externalHandle.sync();
			} finally {
				await externalHandle.close();
			}
			const identityAfter = await fs.promises.stat(filePath, { bigint: true });
			assert.strictEqual(identityAfter.ino, identityBefore.ino);

			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), externalText);
			assert.strictEqual(saveCalls, 0);
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('ordinary rich close materializes results after an accepted atomic save replaces the inode', async () => {
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-file-result-close-atomic-save-'));
		const filePath = path.join(tmpDir, 'workbook.kqlx');
		const displacedPath = path.join(tmpDir, 'workbook.previous.kqlx');
		const querySection = { id: 'query_atomic', type: 'query', query: 'print Value=1' };
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [querySection] } });
		let currentText = initialText;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				return true;
			};
			(vscode.workspace as any).onDidSaveTextDocument = (
				handler: (document: vscode.TextDocument) => unknown,
			) => { didSaveHandler = handler; return { dispose() {} }; };
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const owner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!owner) throw new Error('Result owner was not created.');
			const session = owner.openPanel('atomic-save-result');
			session.openSection(querySection.id, 'atomic-save-instance');
			session.adoptTarget({
				boxId: querySection.id, sectionInstanceId: 'atomic-save-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const, boxId: querySection.id,
				sectionInstanceId: 'atomic-save-instance', targetGeneration: 1,
				executionId: 'atomic-save-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'atomic-save-close',
				},
				result: { columns: ['Value'], rows: [[1]], metadata: {} },
			};
			assert.strictEqual(session.beginExecution(terminal), true);
			assert.ok(session.stagePublication('atomic-save-publication', terminal));
			assert.strictEqual(session.commitPublication('atomic-save-publication'), true);

			const originalIdentity = fs.statSync(filePath, { bigint: true });
			fs.renameSync(filePath, displacedPath);
			fs.writeFileSync(filePath, initialText, 'utf8');
			assert.notStrictEqual(fs.statSync(filePath, { bigint: true }).ino, originalIdentity.ino);
			assert.ok(didSaveHandler);
			void didSaveHandler!(document);
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
			assert.ok(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[0]?.resultJson);
		} finally {
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('ordinary rich close waits for committed Run All result durability', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOpen = fs.promises.open;
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-file-run-all-close-durability-'));
		const filePath = path.join(tmpDir, 'workbook.kqlx');
		const uri = vscode.Uri.file(filePath);
		const querySection = {
			id: 'query_run_all', type: 'query', query: 'print First=1; print Second=2', runMode: 'runAll',
		};
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [querySection] },
		});
		let durableText = currentText;
		let dirty = false;
		let saveCalls = 0;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let markWriteStarted!: () => void;
		let releaseWrite!: () => void;
		const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
		const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
		let gatePublication = true;
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, durableText, 'utf8');
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			(fs.promises as any).open = async (...args: any[]) => {
				if (gatePublication && args[1] === 'r+') {
					gatePublication = false;
					markWriteStarted();
					await writeGate;
				}
				return (originalOpen as any)(...args);
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				dirty = currentText !== durableText;
				return true;
			};
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri, getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				get isDirty() { return dirty; },
				save: async () => { saveCalls++; return true; },
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(uri));
			if (!resultOwner) throw new Error('Ordinary KQLX result owner was not created.');
			const resultSession = resultOwner.openPanel('ordinary-close-durability');
			resultSession.openSection(querySection.id, 'ordinary-close-instance');
			resultSession.adoptTarget({
				boxId: querySection.id, sectionInstanceId: 'ordinary-close-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db', connectionRevision: 1,
				connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const,
				boxId: querySection.id, sectionInstanceId: 'ordinary-close-instance', targetGeneration: 1,
				executionId: 'ordinary-close-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'ordinary-close',
				},
				result: {
					columns: ['First'], rows: [[1]], metadata: {},
					additionalResults: {
						version: 1,
						sets: [{ resultIndex: 1, columns: ['Second'], rows: [[2]], metadata: {} }],
					},
				},
			};
			assert.strictEqual(resultSession.beginExecution(terminal), true);
			assert.ok(resultSession.stagePublication('ordinary-close-publication', terminal));
			assert.strictEqual(resultSession.commitPublication('ordinary-close-publication'), true);

			for (const dispose of disposeHandlers) dispose();
			await writeStarted;
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 50),
				false,
				'Close must remain pending while the committed result save is not durable',
			);
			assert.ok(!JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[0]?.resultJson);
			releaseWrite();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 1_000), true);
			assert.ok(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[0]?.resultJson);
			assert.strictEqual(saveCalls, 0);
		} finally {
			releaseWrite?.();
			(fs.promises as any).open = originalOpen;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session close retains the previous result after an accepted rerun has no terminal', async () => {
		const originalSanitizeSync = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-rerun-result-removal-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const resultJson = JSON.stringify({
			columns: ['First'], rows: [[1]], metadata: {},
			additionalResults: {
				version: 1,
				sets: [{ resultIndex: 1, columns: ['Second'], rows: [[2]], metadata: {} }],
			},
		});
		const dispatch = {
			dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
			connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
			clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
			accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'rerun-activity',
		};
		const persistedSection = {
			id: 'query_run_all', type: 'query', query: 'print First=1; print Second=2', runMode: 'runAll',
			clusterUrl: dispatch.clusterEndpoint, authorityId: dispatch.authorityId,
			connectionIdHint: 'connection-1', database: 'Db', resultJson,
			resultArtifact: {
				version: 1, artifactId: 'result:query_run_all:1', sourceBoxId: 'query_run_all',
				revision: 1, createdAt: 1,
				producer: {
					engine: 'kusto', boxId: 'query_run_all', executionId: 'previous-execution',
					sectionInstanceId: 'previous-instance', targetGeneration: 1, reservationSequence: 1,
					connectionId: 'connection-1', database: 'Db', producer: 'manual', dispatch,
				},
				policy: {
					accountPartition: dispatch.accountPartition,
					authSessionGeneration: dispatch.authSessionGeneration,
					leaveNoTraceRevision: dispatch.leaveNoTraceRevision,
					connectionRevision: dispatch.connectionRevision,
					connectionIdentityKey: dispatch.connectionIdentityKey,
					exposeToActiveContent: true, sendToModel: true, shareToClipboard: true, exportToCsv: true,
				},
			},
			kustoAccountPartition: dispatch.accountPartition,
			kustoLeaveNoTraceRevision: dispatch.leaveNoTraceRevision,
		};
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [persistedSection] },
		});
		fs.writeFileSync(sessionPath, currentText, 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!resultOwner?.hasCommittedAttachments()) throw new Error('Persisted result owner was not restored.');

			resultOwner.clearForExecution('query_run_all');
			for (const dispose of disposeHandlers) dispose();
			await waitForCondition(
				() => {
					const file = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
					return file.state.sections[0]?.resultJson === resultJson;
				},
				'Previous Run All result should remain durable during close',
			);
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'Rerun result retention should fully release the session editor',
			);
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session close admits a delayed applied Kusto publication acknowledgement', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const suiteInitializeStub = prototype.initializeWebviewPanel;
		const suiteHandleStub = prototype.handleWebviewMessage;
		const originalSanitizeSync = prototype.sanitizeSqlLeaveNoTraceState;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-delayed-kusto-ack-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const querySection = {
			id: 'query_delayed_ack', type: 'query', query: 'print First=1; print Second=2', runMode: 'runAll',
			clusterUrl: 'https://cluster.kusto.windows.net', authorityId: 'authority',
			connectionIdHint: 'connection-1', database: 'Db',
		};
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [querySection] },
		});
		fs.writeFileSync(sessionPath, currentText, 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let queryEditor: QueryEditorProvider | undefined;
		let targetPanel: vscode.WebviewPanel | undefined;
		let nestedInitializeOptions: Record<string, unknown> | undefined;
		const disposeHandlers: Array<() => void> = [];
		let stagePosted = false;
		let commitPosted = false;
		try {
			prototype.handleWebviewMessage = originalHandle;
			prototype.initializeWebviewPanel = async function (this: QueryEditorProvider, ...args: any[]) {
				if (args[0] === targetPanel) {
					queryEditor = this;
					nestedInitializeOptions = args[1];
				}
				const result = await suiteInitializeStub.apply(this, args);
				if (args[0] === targetPanel) {
					(this as any)._panelDisposed = false;
					(this as any).panel = args[0];
				}
				return result;
			};
			prototype.sanitizeSqlLeaveNoTraceState = (state: any) => state;
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'kustoPublicationStage') {
							stagePosted = true;
							queueMicrotask(() => { void Promise.resolve((queryEditor as any)?.kustoSectionExecutionApplication.handleMessage({
								type: 'kustoPublicationAck', publicationId: message.publicationId,
								phase: 'staged', accepted: true,
							})); });
						}
						if (message?.type === 'kustoPublicationCommit') {
							commitPosted = true;
							setTimeout(() => { void Promise.resolve(receiveHandler?.({
								type: 'kustoPublicationAck', publicationId: message.publicationId,
								phase: 'applied', accepted: true,
							})); }, 700);
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			targetPanel = panel;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			if (!queryEditor) throw new Error('Nested QueryEditorProvider was not captured.');
			assert.strictEqual(nestedInitializeOptions?.registerDisposalHandler, false);
			const resultSession = (queryEditor as any).kustoResultPersistenceSession;
			resultSession.openSection(querySection.id, 'delayed-ack-instance');
			resultSession.adoptTarget({
				boxId: querySection.id, sectionInstanceId: 'delayed-ack-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db', connectionRevision: 1,
				connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
			});
			const terminal = {
				type: 'queryResult' as const, engine: 'kusto' as const,
				boxId: querySection.id, sectionInstanceId: 'delayed-ack-instance', targetGeneration: 1,
				executionId: 'delayed-ack-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: querySection.query, reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'delayed-ack',
				},
				result: {
					columns: ['First'], rows: [[1]], metadata: {},
					additionalResults: {
						version: 1,
						sets: [{ resultIndex: 1, columns: ['Second'], rows: [[2]], metadata: {} }],
					},
				},
			};
			assert.strictEqual(resultSession.beginExecution(terminal), true);
			const publishing = queryEditor.postKustoPublication(terminal);
			await waitForCondition(
				() => commitPosted,
				`Kusto publication commit should be posted (stagePosted=${stagePosted})`,
			);
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await publishing, true);
			await waitForCondition(
				() => {
					const file = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
					return !!file.state.sections[0]?.resultJson;
				},
				'Delayed applied publication should reach session disk',
			);
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'Delayed publication close should fully release the session editor',
			);
		} finally {
			prototype.initializeWebviewPanel = suiteInitializeStub;
			prototype.handleWebviewMessage = suiteHandleStub;
			prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked rich session saves linked bytes before acknowledging', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-session-durable-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		let sessionText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
		] } });
		fs.writeFileSync(sessionPath, sessionText, 'utf8');
		fs.writeFileSync(linkedPath, 'BASELINE', 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;
		let ackSawLinkedText = '';
		let conflictAcknowledged = false;
		const warnings: string[] = [];
		const disposeHandlers: Array<() => void> = [];
		try {
			(vscode.window as any).showWarningMessage = async (message: unknown) => {
				warnings.push(String(message));
				return undefined;
			};
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (state: any, publish: (value: any) => Promise<unknown>) => publish(state);
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => sessionText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'persistDocumentAck' && message.snapshotId === 'linked-session') {
							ackSawLinkedText = fs.readFileSync(linkedPath, 'utf8');
						}
						if (message?.type === 'persistDocumentAck' && message.snapshotId === 'linked-session-conflict') {
							conflictAcknowledged = true;
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				}, onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'linked-session', sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'DURABLE_LINKED' }] },
			}));
			await waitForCondition(() => ackSawLinkedText === 'DURABLE_LINKED',
				'linked bytes should be durable before acknowledgement');
			const liveLinkedDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === linkedPath);
			assert.strictEqual(ackSawLinkedText, 'DURABLE_LINKED', `linked bytes should be durable before acknowledgement; linkedDisk=${fs.readFileSync(linkedPath, 'utf8')}; sessionDisk=${fs.readFileSync(sessionPath, 'utf8')}; linkedBuffer=${liveLinkedDocument?.getText() ?? '(missing)'}`);
			sessionText = fs.readFileSync(sessionPath, 'utf8');
			assert.strictEqual(JSON.parse(sessionText).state.sections[0].linkedQueryPath, 'linked.kql');

			const externalSession = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [{ id: 'external_1', type: 'query', query: 'EXTERNAL' }] },
			});
			fs.writeFileSync(sessionPath, externalSession, 'utf8');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'linked-session-conflict', sourceGeneration, editRevision: 2,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'MUST_ROLLBACK' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.strictEqual(conflictAcknowledged, false);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'DURABLE_LINKED');
			assert.strictEqual(fs.readFileSync(sessionPath, 'utf8'), externalSession);
			assert.ok(warnings.some(message => message.includes('open or changed in another VS Code window')));
		} finally {
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(vscode.Uri.file(sessionPath), 1_000);
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('self-linked notebook opens read-only before it can overwrite itself', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-self-link-'));
		const filePath = path.join(tmpDir, 'self.kqlx');
		const text = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'self.kqlx' },
			] },
		});
		try {
			fs.writeFileSync(filePath, text, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [] } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			let receiveHandler: unknown;
			const webview = {
				options: {}, html: '',
				postMessage: async () => true,
				onDidReceiveMessage: (handler: unknown) => {
					receiveHandler = handler;
					return { dispose() { receiveHandler = undefined; } };
				},
			} as any;
			const panel = {
				webview,
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor({
				uri: vscode.Uri.file(filePath), getText: () => text,
			} as any, panel, {} as any);

			assert.strictEqual(webview.options.enableScripts, false);
			assert.ok(webview.html.includes('cannot target the notebook itself'));
			assert.strictEqual(receiveHandler, undefined);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), text);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native SQL links open read-only without losing linkedQueryPath or external bytes', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-sql-link-'));
		const variants = [
			{ extension: '.sqlx', kind: 'sqlx' },
			{ extension: '.kqlx', kind: 'kqlx' },
		] as const;
		try {
			for (const [index, variant] of variants.entries()) {
				const filePath = path.join(tmpDir, `linked-${index}${variant.extension}`);
				const linkedPath = path.join(tmpDir, `linked-${index}.sql`);
				const linkedText = 'SELECT 42 AS Value';
				const text = stringifyKqlxFile({
					kind: variant.kind, version: 1, state: { sections: [{
						id: 'sql_linked', type: 'sql', linkedQueryPath: path.basename(linkedPath),
					}] },
				} as any);
				fs.writeFileSync(filePath, text, 'utf8');
				fs.writeFileSync(linkedPath, linkedText, 'utf8');
				const provider = new (KqlxEditorProvider as any)(
					{ subscriptions: [] } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
					connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				let receiveHandler: unknown;
				const webview = {
					options: {}, html: '', postMessage: async () => true,
					onDidReceiveMessage: (handler: unknown) => {
						receiveHandler = handler;
						return { dispose() { receiveHandler = undefined; } };
					},
				} as any;
				const panel = { webview, onDidDispose: () => ({ dispose() {} }) } as any;

				await provider.resolveCustomTextEditor({
					uri: vscode.Uri.file(filePath), getText: () => text,
				} as any, panel, {} as any);

				assert.strictEqual(webview.options.enableScripts, false);
				assert.ok(webview.html.includes('do not support linkedQueryPath on SQL sections'));
				assert.strictEqual(receiveHandler, undefined);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), text);
				assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), linkedText);
			}
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('hardlink alias to the notebook is rejected as a physical self-link', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-hardlink-self-link-'));
		const filePath = path.join(tmpDir, 'self.kqlx');
		const aliasPath = path.join(tmpDir, 'alias.kql');
		const text = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'alias.kql' },
			] },
		});
		try {
			fs.writeFileSync(filePath, text, 'utf8');
			fs.linkSync(filePath, aliasPath);
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [] } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			let receiveHandler: unknown;
			const webview = {
				options: {}, html: '', postMessage: async () => true,
				onDidReceiveMessage: (handler: unknown) => {
					receiveHandler = handler;
					return { dispose() { receiveHandler = undefined; } };
				},
			} as any;
			await provider.resolveCustomTextEditor({
				uri: vscode.Uri.file(filePath), getText: () => text,
			} as any, {
				webview, onDidDispose: () => ({ dispose() {} }),
			} as any, {} as any);
			assert.ok(webview.html.includes('cannot target the notebook itself'));
			assert.strictEqual(receiveHandler, undefined);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), text);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('malformed KQLX opens without an interactive persistence channel', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-malformed-'));
		const filePath = path.join(tmpDir, 'malformed.kqlx');
		const malformedText = '{"kind":"kqlx","version":1,"state":';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let postedMessages = 0;
		let disposeRegistrations = 0;
		let disposeHandler: (() => void) | undefined;
		let revealCount = 0;

		try {
			fs.writeFileSync(filePath, malformedText, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [] } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath),
				getText: () => malformedText,
			} as any;
			const webview = {
				options: {}, html: '',
				postMessage: async () => { postedMessages++; return true; },
				onDidReceiveMessage: (handler: (message: any) => unknown) => {
					receiveHandler = handler;
					return { dispose() { receiveHandler = undefined; } };
				},
			} as any;
			const panel = {
				visible: true, active: true, webview,
				reveal: () => { revealCount++; },
				onDidDispose: (handler: () => void) => {
					disposeRegistrations++;
					disposeHandler ??= handler;
					let active = true;
					return { dispose() {
						if (!active) return;
						active = false;
						disposeRegistrations--;
					} };
				},
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);

			assert.strictEqual(webview.options.enableScripts, false);
			assert.ok(webview.html.includes('Read-only'));
			assert.strictEqual(receiveHandler, undefined, 'malformed content must not receive an editor message handler');
			assert.strictEqual(postedMessages, 0, 'malformed content must not receive editor state');
			assert.strictEqual(disposeRegistrations, 1, 'malformed content should register panel ownership cleanup');
			assert.strictEqual(
				await KqlxEditorProvider.revealOpenEditorWhenReady(document.uri, vscode.ViewColumn.One),
				true,
				'a malformed session tab should remain revealable',
			);
			assert.strictEqual(revealCount, 1);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), malformedText, 'malformed source bytes must remain untouched');
			disposeHandler?.();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 100), true);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('repeated KQLX suffix recovery refuses cancel, source changes, and existing destinations', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-recovery-'));
		const filePath = path.join(tmpDir, 'damaged.kqlx');
		const copyPath = path.join(tmpDir, 'recovered.kqlx');
		const valid = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print Value=1',
					resultJson: JSON.stringify({ columns: [{ name: 'Value', type: 'string' }], rows: [['R'.repeat(1800)]] }) },
			] },
		}, null, 2);
		const damaged = valid + valid.slice(-1200).repeat(3) + '\r\n';
		const originalWarning = vscode.window.showWarningMessage;
		const originalError = vscode.window.showErrorMessage;
		const originalPicker = vscode.window.showSaveDialog;
		let disposePanel: (() => void) | undefined;
		const warnings: string[] = [];
		const errors: string[] = [];
		let confirmation: string | undefined;
		let destination = vscode.Uri.file(copyPath);
		let pickerCalls = 0;
		try {
			fs.writeFileSync(filePath, damaged, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [] } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const webview = {
				options: {}, html: '', postMessage: async () => true,
				onDidReceiveMessage: () => ({ dispose() {} }),
			} as any;
			const uri = vscode.Uri.file(filePath);
			await provider.resolveCustomTextEditor({ uri, getText: () => damaged, isDirty: false } as any, {
				webview,
				onDidDispose: (handler: () => void) => { disposePanel = handler; return { dispose() {} }; },
			} as any, {} as any);
			assert.strictEqual(webview.options.enableScripts, false);
			assert.strictEqual(webview.options.localResourceRoots.length, 0);
			assert.strictEqual(webview.options.enableCommandUris.length, 1);
			assert.ok(webview.html.includes('Recover a Copy'));
			const command = webview.options.enableCommandUris[0] as string;
			(vscode.window as any).showWarningMessage = async (message: unknown) => {
				warnings.push(String(message));
				return confirmation;
			};
			(vscode.window as any).showErrorMessage = async (message: unknown) => {
				errors.push(String(message));
				return undefined;
			};
			(vscode.window as any).showSaveDialog = async () => { pickerCalls++; return destination; };

			await vscode.commands.executeCommand(command);
			assert.strictEqual(pickerCalls, 0, 'cancelling confirmation must not open Save As');
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), damaged);
			assert.strictEqual(fs.existsSync(copyPath), false);

			confirmation = 'Recover a Copy';
			destination = uri;
			await vscode.commands.executeCommand(command);
			assert.ok(warnings.some(message => message.includes('original file cannot be used')));
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), damaged);
			assert.strictEqual(fs.existsSync(copyPath), false);

			destination = vscode.Uri.file(copyPath);
			const externallyChanged = damaged + 'external change';
			(vscode.window as any).showSaveDialog = async () => {
				pickerCalls++;
				fs.writeFileSync(filePath, externallyChanged, 'utf8');
				return destination;
			};
			await vscode.commands.executeCommand(command);
			assert.ok(errors.some(message => message.includes('changed after it was opened')));
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), externallyChanged);
			assert.strictEqual(fs.existsSync(copyPath), false);

			fs.writeFileSync(filePath, damaged, 'utf8');
			fs.writeFileSync(copyPath, 'EXISTING COPY', 'utf8');
			(vscode.window as any).showSaveDialog = async () => { pickerCalls++; return destination; };
			await vscode.commands.executeCommand(command);
			assert.ok(errors.some(message => message.includes('already exists')));
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), damaged);
			assert.strictEqual(fs.readFileSync(copyPath, 'utf8'), 'EXISTING COPY');
		} finally {
			disposePanel?.();
			(vscode.window as any).showWarningMessage = originalWarning;
			(vscode.window as any).showErrorMessage = originalError;
			(vscode.window as any).showSaveDialog = originalPicker;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('known-incompatible MDX opens read-only with an actionable error', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-mdx-incompatible-'));
		const filePath = path.join(tmpDir, 'incompatible.mdx');
		const text = JSON.stringify({
			kind: 'mdx', version: 1, state: { sections: [
				{ id: 'query_invalid_mdx', type: 'query', query: 'print value = 1' },
				{ id: 'future_mdx', type: 'future-section', payload: { keep: true } },
			] },
		});
		let receiveHandler: unknown;
		let postedMessages = 0;

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [] } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const webview = {
				options: {}, html: '',
				postMessage: async () => { postedMessages++; return true; },
				onDidReceiveMessage: (handler: unknown) => {
					receiveHandler = handler;
					return { dispose() { receiveHandler = undefined; } };
				},
			} as any;
			await provider.resolveCustomTextEditor({
				uri: vscode.Uri.file(filePath), getText: () => text,
			} as any, {
				webview, onDidDispose: () => ({ dispose() {} }),
			} as any, {} as any);

			assert.strictEqual(webview.options.enableScripts, false);
			assert.ok(webview.html.includes('Invalid .mdx'));
			assert.ok(webview.html.includes('query_invalid_mdx'));
			assert.ok(webview.html.includes('incompatible known type &quot;query&quot;'));
			assert.ok(webview.html.includes('Read-only to prevent data loss'));
			assert.strictEqual(receiveHandler, undefined);
			assert.strictEqual(postedMessages, 0);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), text);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX close bounds non-persistence handlers that do not settle', async function () {
		this.timeout(5_000);
		const originalHandleWebviewMessage = (QueryEditorProvider as any).prototype.handleWebviewMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-close-timeout-'));
		const filePath = path.join(tmpDir, 'close-timeout.kqlx');
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		let releaseHandler!: () => void;
		const handlerGate = new Promise<void>(resolve => { releaseHandler = resolve; });

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			(QueryEditorProvider as any).prototype.handleWebviewMessage = async (message: any) => {
				if (message?.type === 'pauseNonPersistenceForCloseTest') await handlerGate;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text,
				eol: vscode.EndOfLine.LF, isDirty: false,
				positionAt: () => new vscode.Position(0, 0), save: async () => true,
			} as any;
			const panel = {
				visible: true, active: true,
				webview: {
					options: {}, postMessage: async () => true,
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(receiveHandler);
			void Promise.resolve(receiveHandler!({ type: 'pauseNonPersistenceForCloseTest' }));
			for (const dispose of disposeHandlers) dispose();

			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 3_000),
				true,
				'non-persistence work must not block close indefinitely',
			);
		} finally {
			releaseHandler();
			(QueryEditorProvider as any).prototype.handleWebviewMessage = originalHandleWebviewMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX close waits for every admitted webview handler', async () => {
		const originalHandleWebviewMessage = (QueryEditorProvider as any).prototype.handleWebviewMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-close-barrier-'));
		const filePath = path.join(tmpDir, 'close-barrier.kqlx');
		const text = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [{ id: 'query_1', type: 'query', query: 'print value=1' }] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		let handlerStarted = false;
		let releaseHandler!: () => void;
		const handlerGate = new Promise<void>(resolve => { releaseHandler = resolve; });

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			(QueryEditorProvider as any).prototype.handleWebviewMessage = async (message: any) => {
				if (message?.type !== 'pauseForCloseBarrierTest') return;
				handlerStarted = true;
				await handlerGate;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [],
					workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text,
				eol: vscode.EndOfLine.LF, isDirty: false,
				positionAt: () => new vscode.Position(0, 0), save: async () => true,
			} as any;
			const panel = {
				visible: true, active: true,
				webview: {
					options: {}, postMessage: async () => true,
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(receiveHandler);
			const inbound = Promise.resolve(receiveHandler!({ type: 'pauseForCloseBarrierTest' }));
			assert.strictEqual(handlerStarted, true, 'the admitted handler should start immediately');
			for (const dispose of disposeHandlers) dispose();

			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 50),
				false,
				'close finalization must remain pending while an admitted handler is running',
			);
			releaseHandler();
			await inbound;
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'close finalization should complete after the admitted handler settles',
			);
		} finally {
			releaseHandler();
			(QueryEditorProvider as any).prototype.handleWebviewMessage = originalHandleWebviewMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX native Save followed by immediate close preserves durable result attachments', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFresh = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalFailClosed = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-save-budget-'));
		const filePath = path.join(tmpDir, 'save-budget.kqlx');
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;
		const disposeHandlers: Array<() => void> = [];
		let releaseCanonicalPublish!: () => void;
		const canonicalPublishGate = new Promise<void>(resolve => { releaseCanonicalPublish = resolve; });
		let gateCanonicalPublish = false;
		const state = {
			sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', resultJson: 'PROTECTED_SQL_RESULT' },
				{ id: 'query_1', type: 'query', query: 'print value=1', resultJson: 'KEEP_KUSTO_RESULT' },
			],
		};
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state }, null, 2);
		let currentText = text;
		let diskText = text;
		let dirty = true;
		let documentVersion = 1;

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				documentVersion++;
				dirty = currentText !== diskText;
				return true;
			};
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (value: unknown) => value;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = (value: any) => ({
				...value,
				sections: value.sections.map((section: any) => {
					const clone = { ...section };
					delete clone.resultJson;
					return clone;
				}),
			});
			let canonicalPublishCalls = 0;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (value: any, publish: (sanitized: any) => Promise<unknown>) => {
				canonicalPublishCalls++;
				if (gateCanonicalPublish) await canonicalPublishGate;
				return publish({
					...value,
					sections: value.sections.map((section: any) => {
						if (section.type !== 'sql') return section;
						const clone = { ...section };
						delete clone.resultJson;
						return clone;
					}),
				});
			};

			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [],
					workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath),
				getText: () => currentText,
				get version() { return documentVersion; },
				eol: vscode.EndOfLine.LF,
				get isDirty() { return dirty; },
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				save: async () => {
					let nestedBarrier: Promise<vscode.TextEdit[]> | undefined;
					willSaveHandler!({ document, waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { nestedBarrier = Promise.resolve(thenable); } } as any);
					await nestedBarrier;
					diskText = currentText;
					dirty = false;
					await Promise.resolve(didSaveHandler!(document as any));
					return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: Number(message.editRevision || 0),
						}));
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'persistDocument', state,
								flush: true, reason: 'save', editRevision: 0,
								snapshotId: 'save-budget-snapshot', sourceGeneration,
								flushRequestId: message.requestId,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler && didSaveHandler && receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await new Promise<void>(resolve => setImmediate(resolve));
			const publicationsBeforeNativeSave = canonicalPublishCalls;
			let barrier: Promise<vscode.TextEdit[]> | undefined;
			const startedAt = Date.now();
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); },
			} as any);
			assert.ok(barrier);
			const edits = await barrier!;
			assert.ok(Date.now() - startedAt < 1_500, 'Fail-closed native Save must resolve inside the VS Code save budget');
			assert.strictEqual(edits.length, 1);
			const replacement = edits[0].newText;
			assert.ok(replacement.includes('PROTECTED_SQL_RESULT'));
			assert.ok(replacement.includes('KEEP_KUSTO_RESULT'));
			assert.strictEqual(canonicalPublishCalls, publicationsBeforeNativeSave);
			currentText = replacement;
			diskText = replacement;
			dirty = false;
			for (const dispose of disposeHandlers) dispose();
			await Promise.resolve(didSaveHandler!(document));
			releaseCanonicalPublish();
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'close finalization should complete after the durable Save settles',
			);
			assert.ok(currentText.includes('PROTECTED_SQL_RESULT'));
			assert.ok(diskText.includes('KEEP_KUSTO_RESULT'));
		} finally {
			releaseCanonicalPublish();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalFresh;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = originalFailClosed;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Kusto-only KQLX native Save is lock-free and selectively clears saved rows', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-kusto-save-lock-'));
		const filePath = path.join(tmpDir, 'kusto-save-lock.kqlx');
		const target = {
			clusterUrl: 'https://cluster.kusto.windows.net', connectionIdHint: 'kusto-1', database: 'Db',
			kustoAccountPartition: 'partition-current', kustoLeaveNoTraceRevision: 0,
		};
		const state = { sections: [
			{ id: 'query_1', type: 'query', query: 'print value=1', ...target, resultJson: 'KUSTO_RESULT' },
			{ id: 'query_clear', type: 'query', query: 'print clear=1', ...target, resultJson: 'CLEAR_RESULT' },
		] };
		const finalState = { sections: [
			{ ...state.sections[0], name: 'Saved Metadata' },
			{ id: 'query_clear', type: 'query', query: 'print clear=2', ...target },
		] };
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state }, null, 2);
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let canonicalPublishCalls = 0;
		let sourceGeneration = 0;
		const disposeHandlers: Array<() => void> = [];
		const resultRegistry = new KustoResultPersistenceRegistry();

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async () => {
				canonicalPublishCalls++;
				throw new Error('native Save must not acquire canonical locks');
			};

			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub({ getConnections: () => [{ id: 'kusto-1', name: 'Kusto', clusterUrl: 'https://cluster.kusto.windows.net' }] }),
				sqlWorkbenchStub(),
				undefined,
				resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text, eol: vscode.EndOfLine.LF, isDirty: true,
				positionAt: (_offset: number) => new vscode.Position(0, 0), save: async () => true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'persistDocument', state: finalState, flush: true, reason: 'save', editRevision: 0,
								snapshotId: 'kusto-save-lock', sourceGeneration, flushRequestId: message.requestId,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler && didSaveHandler && receiveHandler);
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			if (!resultOwner) throw new Error('Native Save result owner was not created.');
			resultOwner.admitCanonicalSource('explicit-clear-source', finalState, 'explicit-clear-revision');
			let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
			} as any);
			assert.ok(saveBarrier);
			const edits = await saveBarrier!;
			assert.strictEqual(edits.length, 1);
			assert.ok(edits[0].newText.includes('KUSTO_RESULT'));
			assert.ok(!edits[0].newText.includes('CLEAR_RESULT'));
			const saved = parseKqlxText(edits[0].newText);
			assert.strictEqual(saved.ok, true, saved.ok ? undefined : saved.error);
			assert.strictEqual((saved.ok ? saved.file.state.sections[0] as any : undefined)?.name, 'Saved Metadata');
			assert.ok(!(saved.ok ? saved.file.state.sections[1] as any : undefined)?.resultJson);
			assert.strictEqual(canonicalPublishCalls, 0);
			await Promise.resolve(didSaveHandler!(document));
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
		} finally {
			resultRegistry.dispose();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX native Save does not require a controlled restore for durable rows', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFailClosed = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-restore-failure-'));
		const filePath = path.join(tmpDir, 'restore-failure.kqlx');
		const state = { sections: [{
			id: 'query_1', type: 'query', query: 'print value=1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionIdHint: 'kusto-1', database: 'Db', resultJson: 'PUBLIC_RESULT',
		}] };
		const candidateText = JSON.stringify({ kind: 'kqlx', version: 1, state }, null, 2);
		let currentText = candidateText;
		let diskText = candidateText;
		let dirty = true;
		let documentVersion = 1;
		let controlledSaveCalls = 0;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;

		try {
			fs.writeFileSync(filePath, candidateText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				documentVersion++;
				dirty = currentText !== diskText;
				return true;
			};
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = (value: any) => ({
				...value, sections: value.sections.map((section: any) => {
					const clone = { ...section }; delete clone.resultJson; return clone;
				}),
			});
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (value: unknown, publish: (state: unknown) => Promise<unknown>) => publish(value);

			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				get version() { return documentVersion; },
				get isDirty() { return dirty; }, positionAt: (_offset: number) => new vscode.Position(0, 0),
				save: async () => { controlledSaveCalls++; return false; },
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: Number(message.editRevision || 0),
						}));
						if (message?.type === 'requestFinalPersist') void Promise.resolve().then(() => receiveHandler?.({
							type: 'persistDocument', state, flush: true, reason: 'save', editRevision: 0,
							snapshotId: 'restore-failure', sourceGeneration, flushRequestId: message.requestId,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler && didSaveHandler && receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			let barrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({ document, waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); } } as any);
			const edits = await barrier!;
			currentText = edits[0].newText;
			diskText = currentText;
			dirty = false;
			await Promise.resolve(didSaveHandler!(document));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(controlledSaveCalls, 0);
			assert.strictEqual(currentText, diskText);
			assert.ok(currentText.includes('PUBLIC_RESULT'));
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = originalFailClosed;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('overlapping KQLX native Saves restore only the newest admitted result generation', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFailClosed = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-overlap-save-'));
		const filePath = path.join(tmpDir, 'overlap.kqlx');
		const makeState = (resultJson: string) => ({ sections: [{
			id: 'query_1', type: 'query', query: 'print value=1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionIdHint: 'kusto-1', database: 'Db', resultJson,
		}] });
		let requestedState = makeState('RESULT_ONE');
		let currentText = JSON.stringify({ kind: 'kqlx', version: 1, state: requestedState }, null, 2);
		let diskText = currentText;
		let dirty = true;
		let version = 1;
		let publishCalls = 0;
		let gateFirstRestore = false;
		let restorePublishCalls = 0;
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => { willSaveHandler = handler; return { dispose() {} }; };
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => { didSaveHandler = handler; return { dispose() {} }; };
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement; version++; dirty = currentText !== diskText; return true;
			};
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = (value: any) => ({
				...value, sections: value.sections.map((section: any) => { const clone = { ...section }; delete clone.resultJson; return clone; }),
			});
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (value: unknown, publish: (state: unknown) => Promise<unknown>) => {
				publishCalls++;
				if (gateFirstRestore && ++restorePublishCalls === 1) await firstGate;
				const result = await publish(value);
				const saved = fs.readFileSync(filePath, 'utf8');
				if (!dirty && saved !== currentText) {
					diskText = saved;
					currentText = saved;
					version++;
				}
				return result;
			};
			const resultRegistry = new KustoResultPersistenceRegistry();
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(tmpDir) } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, get version() { return version; }, get isDirty() { return dirty; },
				eol: vscode.EndOfLine.LF, positionAt: (_offset: number) => new vscode.Position(0, 0),
				save: async () => {
					let nested: Promise<vscode.TextEdit[]> | undefined;
					willSaveHandler!({ document, waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { nested = Promise.resolve(thenable); } } as any);
					await nested; diskText = currentText; fs.writeFileSync(filePath, diskText, 'utf8'); dirty = false; await Promise.resolve(didSaveHandler!(document)); return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (message?.reloadRequestId) await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: Number(message.editRevision || 0),
						}));
						if (message?.type === 'requestFinalPersist') void Promise.resolve().then(() => receiveHandler?.({ type: 'persistDocument', state: requestedState, flush: true, reason: 'save', editRevision: 0, snapshotId: `overlap-${publishCalls}`, sourceGeneration, flushRequestId: message.requestId }));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler && didSaveHandler && receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await new Promise<void>(resolve => setImmediate(resolve));
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(resultOwner);
			const runNativeSave = async () => {
				let barrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({ document, waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); } } as any);
				const edits = await barrier!;
				if (edits[0]) { currentText = edits[0].newText; version++; }
				diskText = currentText; fs.writeFileSync(filePath, diskText, 'utf8'); dirty = false; await Promise.resolve(didSaveHandler!(document));
			};
			await runNativeSave();
			requestedState = makeState('RESULT_TWO');
			resultOwner.admitCanonicalSource('overlap-result-two', requestedState);
			await runNativeSave();
			releaseFirst();
			await waitForCondition(() => diskText.includes('RESULT_TWO'), 'newest result generation should reach disk');
			assert.ok(!diskText.includes('RESULT_ONE'));
		} finally {
			releaseFirst();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = originalFailClosed;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('canonical public-row restoration keeps a Transformation command queued until restore completes', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const scopedOnDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalFailClosed = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-canonical-transform-queue-'));
		const filePath = path.join(tmpDir, 'canonical-transform.kqlx');
		const state = { sections: [
			{
				id: 'query_1', type: 'query', query: 'print value=1',
				clusterUrl: 'https://cluster.kusto.windows.net', connectionIdHint: 'kusto-1', database: 'Db',
				resultJson: 'PUBLIC_RESULT',
			},
			{
				id: 'transform_1', type: 'transformation', name: 'Before',
				dataSourceId: 'query_1', transformationType: 'select',
			},
		] };
		let currentText = JSON.stringify({ kind: 'kqlx', version: 1, state }, null, 2);
		let diskText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: state.sections.map(section => {
			const baseline = { ...section };
			delete baseline.resultJson;
			return baseline;
		}) } }, null, 2);
		let dirty = true;
		let version = 1;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		const canonicalChangeHandlers: Array<(event: vscode.TextDocumentChangeEvent) => unknown> = [];
		const canonicalWillSaveHandlers: Array<(event: vscode.TextDocumentWillSaveEvent) => unknown> = [];
		const canonicalDidSaveHandlers: Array<(document: vscode.TextDocument) => unknown> = [];
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		let gateCanonicalRestore = false;
		let markCanonicalRestoreStarted!: () => void;
		let releaseCanonicalRestore!: () => void;
		const canonicalRestoreStarted = new Promise<void>(resolve => { markCanonicalRestoreStarted = resolve; });
		const canonicalRestoreGate = new Promise<void>(resolve => { releaseCanonicalRestore = resolve; });
		const posted: any[] = [];
		const savingDisposeHandlers: Array<() => void> = [];
		let survivorReceive: ((message: any) => unknown) | undefined;
		let survivorProjection: any;
		const survivorPosted: any[] = [];
		const resultRegistry = new KustoResultPersistenceRegistry();

		try {
			fs.writeFileSync(filePath, diskText, 'utf8');
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => {
				canonicalChangeHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				canonicalWillSaveHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				didSaveHandler = handler;
				canonicalDidSaveHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				version++;
				dirty = currentText !== diskText;
				for (const changeHandler of canonicalChangeHandlers) {
					await Promise.resolve(changeHandler({ document, contentChanges: [{}] } as any));
				}
				return true;
			};
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = (value: any) => ({
				...value,
				sections: value.sections.map((section: any) => {
					const next = { ...section };
					delete next.resultJson;
					return next;
				}),
			});
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				value: unknown, publish: (next: unknown) => Promise<unknown>,
			) => {
				if (gateCanonicalRestore) {
					gateCanonicalRestore = false;
					markCanonicalRestoreStarted();
					await canonicalRestoreGate;
				}
				const result = await publish(value);
				const savedText = fs.readFileSync(filePath, 'utf8');
				if (!dirty && savedText !== currentText) {
					diskText = savedText;
					currentText = savedText;
					version++;
					for (const changeHandler of canonicalChangeHandlers) {
						await Promise.resolve(changeHandler({ document, contentChanges: [{}] } as any));
					}
				}
				return result;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, resultRegistry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText,
				get version() { return version; },
				get isDirty() { return dirty; },
				eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0),
				save: async () => {
					const nestedBarriers: Promise<vscode.TextEdit[]>[] = [];
					for (const handler of canonicalWillSaveHandlers) {
						handler({
							document,
							waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
								nestedBarriers.push(Promise.resolve(thenable));
							},
						} as any);
					}
					await Promise.all(nestedBarriers);
					diskText = currentText;
					fs.writeFileSync(filePath, diskText, 'utf8');
					dirty = false;
					for (const handler of canonicalDidSaveHandlers) await Promise.resolve(handler(document));
					return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
						}));
						if (message?.type === 'requestMarkdownCommandBarrier') await Promise.resolve(receiveHandler?.({
							type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
							sourceGeneration: message.sourceGeneration,
							documentRevision: projection.documentRevision, accepted: true,
						}));
						if (message?.type === 'requestFinalPersist') void Promise.resolve().then(() => receiveHandler?.({
							type: 'persistDocument', state, flush: true, reason: 'save', editRevision: 0,
							snapshotId: 'canonical-transform-save', flushRequestId: message.requestId,
							sourceGeneration: projection.sourceGeneration,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => {
					savingDisposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(projection && willSaveHandler && didSaveHandler);
			const savingWillSaveHandler = willSaveHandler;
			const savingDidSaveHandler = didSaveHandler;
			const survivorPanel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						survivorPosted.push(message);
						if (message?.type === 'documentData') survivorProjection = message;
						if (message?.reloadRequestId) await Promise.resolve(survivorReceive?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { survivorReceive = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, survivorPanel, {} as any);
			await Promise.resolve(survivorReceive!({ type: 'requestDocument' }));
			assert.ok(survivorProjection);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(projection);
			const resultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(resultOwner);
			resultOwner.admitCanonicalSource('canonical-restore-new-result', state);

			let barrier: Promise<vscode.TextEdit[]> | undefined;
			savingWillSaveHandler({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); },
			} as any);
			const edits = await barrier!;
			assert.strictEqual(edits.length, 1);
			assert.ok(!edits[0].newText.includes('PUBLIC_RESULT'), 'the initial native Save must be row-free for this restoration test');
			currentText = edits[0].newText;
			version++;
			for (const changeHandler of canonicalChangeHandlers) {
				await Promise.resolve(changeHandler({ document, contentChanges: [{}] } as any));
			}
			diskText = currentText;
			fs.writeFileSync(filePath, diskText, 'utf8');
			dirty = false;
			gateCanonicalRestore = true;
			await Promise.resolve(savingDidSaveHandler(document));
			await canonicalRestoreStarted;
			for (const dispose of savingDisposeHandlers) dispose();
			const priorSurvivorGeneration = survivorProjection.sourceGeneration;
			await waitForCondition(
				() => survivorProjection.sourceGeneration !== priorSurvivorGeneration,
				'survivor should acknowledge replacement ownership after saving-panel disposal',
			);

			let commandSettled = false;
			const command = Promise.resolve(survivorReceive!({
				type: 'markdownDocumentCommand', commandId: 'transform-during-canonical-restore',
				sourceGeneration: survivorProjection.sourceGeneration,
				expectedDocumentRevision: survivorProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'transform_1',
					expectedSectionRevision: survivorProjection.sectionRevisions.transform_1,
					patch: { name: 'After' },
				},
			})).then(() => { commandSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(commandSettled, false, 'Transformation command must wait for canonical restoration');
			releaseCanonicalRestore();
			await waitForCondition(
				() => diskText.includes('PUBLIC_RESULT') || commandSettled,
				'canonical restoration should durably restore rows before releasing the survivor command',
			);
			assert.ok(currentText.includes('PUBLIC_RESULT'), 'rows must be restored before survivor command settlement');
			assert.ok(diskText.includes('PUBLIC_RESULT'), 'rows must be durable before survivor command settlement');
			await command;

			const finalSections = JSON.parse(currentText).state.sections;
			assert.strictEqual(finalSections.find((section: any) => section.id === 'query_1').resultJson, 'PUBLIC_RESULT');
			assert.strictEqual(finalSections.find((section: any) => section.id === 'transform_1').name, 'After');
			assert.strictEqual(
				survivorPosted.find(message => message?.commandId === 'transform-during-canonical-restore')?.ok,
				true,
			);
			assert.ok(diskText.includes('PUBLIC_RESULT'));
		} finally {
			releaseCanonicalRestore?.();
			resultRegistry.dispose();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = originalFailClosed;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.workspace as any).onDidChangeTextDocument = scopedOnDidChangeTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX Save preserves durable rows when the final webview snapshot is unavailable', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-save-unavailable-'));
		const filePath = path.join(tmpDir, 'save-unavailable.kqlx');
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', resultJson: 'PROTECTED_SQL_RESULT' },
				{ id: 'query_1', type: 'query', query: 'print 1', resultJson: 'KEEP_KUSTO_RESULT', kustoAccountPartition: 'partition-current', kustoLeaveNoTraceRevision: 0 },
			] },
		}, null, 2);
		const latestText = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 2 AS latest_edit', resultJson: 'PROTECTED_SQL_RESULT' },
				{ id: 'query_1', type: 'query', query: 'print 1', resultJson: 'KEEP_KUSTO_RESULT', kustoAccountPartition: 'partition-current', kustoLeaveNoTraceRevision: 0 },
			] },
		}, null, 2);

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText,
				eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset),
			} as any;
			const panel = {
				visible: true,
				webview: {
					options: {}, postMessage: async () => true,
					onDidReceiveMessage: () => ({ dispose() {} }),
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler);
			let barrier: Promise<vscode.TextEdit[]> | undefined;
			const startedAt = Date.now();
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); },
			} as any);
			currentText = latestText;

			const edits = await barrier!;
			assert.ok(Date.now() - startedAt < 1_500, 'unanswered snapshot fallback must stay inside the VS Code save budget');
			assert.strictEqual(edits.length, 1);
			assert.ok(edits[0].newText.includes('PROTECTED_SQL_RESULT'));
			assert.ok(edits[0].newText.includes('KEEP_KUSTO_RESULT'));
			assert.ok(edits[0].newText.includes('latest_edit'));
			assert.strictEqual(edits[0].range.end.character, latestText.length);
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const variant of [
		{
			name: 'native KQLX', extension: '.kqlx', Provider: KqlxEditorProvider,
			text: JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ type: 'query', id: 'query_startup', query: 'StartupTable | take 1' },
				] },
			}, null, 2),
			documentKind: 'kqlx', compatibilityMode: false,
		},
		{
			name: 'KQL compatibility', extension: '.kql', Provider: KqlCompatEditorProvider,
			text: 'StartupTable | take 1', documentKind: 'kql', compatibilityMode: true,
		},
		{
			name: 'SQL compatibility', extension: '.sql', Provider: SqlCompatEditorProvider,
			text: 'select top 1 * from StartupTable', documentKind: 'sql', compatibilityMode: true,
		},
	] as const) {
		test(`${variant.name} startup buffers both directions until explicit dispatcher readiness`, async () => {
			let receiveHandler: ((message: any) => unknown) | undefined;
			let queryEditor: QueryEditorProvider | undefined;
			let markInitializeEntered!: () => void;
			let releaseInitialize!: () => void;
			const initializeEntered = new Promise<void>(resolve => { markInitializeEntered = resolve; });
			const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve; });
			const posted: any[] = [];
			const delegatedInbound: string[] = [];
			const disposeHandlers: Array<() => unknown> = [];
			const previousInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const previousHandle = (QueryEditorProvider as any).prototype.handleWebviewMessage;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-main-startup-'));
			const filePath = path.join(tmpDir, `startup${variant.extension}`);
			let resolveEditor: Promise<void> | undefined;

			try {
				fs.writeFileSync(filePath, variant.text, 'utf8');
				(QueryEditorProvider as any).prototype.handleWebviewMessage = async (message: any) => {
					delegatedInbound.push(String(message?.type || ''));
				};
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (panel: vscode.WebviewPanel, options: any) {
					registerCompatibilityPersistenceTestBootstrap(panel, options?.compatibilityPersistence);
					queryEditor = this;
					(this as any).panel = panel;
					(this as any)._panelDisposed = false;
					assert.ok(receiveHandler, 'the panel listener must be installed before handler construction');
					void Promise.resolve(receiveHandler!({ type: 'getConnections' }));
					void Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
					const deliveries = [
						this.postMessage({ type: 'settingsUpdate', alternatingRowColor: 'startup-first' }),
						this.postMessage({ type: 'connectionsData', connections: [], sqlConnections: [] }),
					];
					markInitializeEntered();
					await initializeGate;
					await Promise.all(deliveries);
				};

				const fakeContext: vscode.ExtensionContext = {
					subscriptions: [],
					workspaceState: { get: () => undefined, update: async () => undefined } as any,
					globalState: { get: () => undefined, update: async () => undefined } as any,
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					extensionMode: vscode.ExtensionMode.Test,
				} as any;
				const provider = new (variant.Provider as any)(
					fakeContext,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
					connectionManagerStub(),
					sqlWorkbenchStub(),
				);
				const document: vscode.TextDocument = {
					uri: vscode.Uri.file(filePath),
					getText: () => variant.text,
					lineCount: 1,
					lineAt: () => ({ text: variant.text } as any),
					eol: vscode.EndOfLine.LF,
				} as any;
				const webview: vscode.Webview = {
					options: {} as any,
					postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = handler;
						return { dispose() {} } as DisposableLike;
					},
				} as any;
				const webviewPanel: vscode.WebviewPanel = {
					webview,
					visible: true,
					active: true,
					onDidDispose: (handler: () => unknown) => {
						disposeHandlers.push(handler);
						return { dispose() {} } as DisposableLike;
					},
					onDidChangeViewState: () => ({ dispose() {} } as DisposableLike),
				} as any;
				deferMainWebviewReadyForTest(webviewPanel);

				resolveEditor = Promise.resolve(provider.resolveCustomTextEditor(document, webviewPanel, {} as any));
				await initializeEntered;
				assert.strictEqual(posted.length, 0, 'host projections must wait for dispatcher readiness');

				await Promise.resolve(receiveHandler!({ type: 'mainWebviewDispatcherReady' }));
				await waitForCondition(() => posted.length === 2, 'readiness must drain both queued projections');
				assert.deepStrictEqual(posted.map(message => message.type), ['settingsUpdate', 'connectionsData']);

				releaseInitialize();
				await resolveEditor;
				assert.deepStrictEqual(delegatedInbound, ['getConnections']);
				const documentMessages = posted.filter(message => message?.type === 'documentData' && message.ok === true);
				assert.strictEqual(documentMessages.length, 1, 'the queued document request must apply exactly once');
				const persistenceMode = posted.find(message => message?.type === 'persistenceMode');
				assert.strictEqual(persistenceMode?.documentKind, variant.documentKind);
				assert.strictEqual(persistenceMode?.compatibilityMode, variant.compatibilityMode);
				assert.strictEqual(documentMessages[0].state.sections[0].query, variant.text.includes('StartupTable | take 1')
					? 'StartupTable | take 1'
					: 'select top 1 * from StartupTable');

				for (const dispose of disposeHandlers) dispose();
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const retiredDelivery = await queryEditor!.postMessage({
					type: 'settingsUpdate', alternatingRowColor: 'retired-panel',
				});
				assert.strictEqual(retiredDelivery, false, 'the retired panel transport must reject outbound traffic');
				assert.strictEqual(
					posted.filter(message => message?.type === 'documentData' && message.ok === true).length,
					1,
					'the retired panel listener must reject predecessor traffic',
				);
				assert.ok(!posted.some(message => message?.alternatingRowColor === 'retired-panel'));
			} finally {
				try { await Promise.resolve(receiveHandler?.({ type: 'mainWebviewDispatcherReady' })); } catch { /* ignore */ }
				releaseInitialize?.();
				try { await resolveEditor; } catch { /* preserve the original assertion */ }
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = previousInitialize;
				(QueryEditorProvider as any).prototype.handleWebviewMessage = previousHandle;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});

		if (variant.compatibilityMode) test(`${variant.name} forwards queued tool delivery guards through the initialized provider`, async () => {
			let receiveHandler: ((message: any) => unknown) | undefined;
			let queryEditor: QueryEditorProvider | undefined;
			let releaseHead!: (delivered: boolean) => void;
			let markHeadEntered!: () => void;
			const heldHead = new Promise<boolean>(resolve => { releaseHead = resolve; });
			const headEntered = new Promise<void>(resolve => { markHeadEntered = resolve; });
			const posted: any[] = [];
			const disposeHandlers: Array<() => unknown> = [];
			const previousInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const previousGatewayPost = MainWebviewStartupGateway.prototype.postMessage;
			let startupGateway: MainWebviewStartupGateway<unknown> | undefined;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-delivery-guard-'));
			const filePath = path.join(tmpDir, `guard${variant.extension}`);
			let head: Thenable<boolean> | undefined;
			try {
				fs.writeFileSync(filePath, variant.text, 'utf8');
				MainWebviewStartupGateway.prototype.postMessage = function (message, signal, isCurrent) {
					startupGateway = this;
					return previousGatewayPost.call(this, message, signal, isCurrent);
				};
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (panel: vscode.WebviewPanel, options: any) {
					queryEditor = this;
					(this as any).panel = panel;
					(this as any)._panelDisposed = false;
					await previousInitialize.call(this, panel, options);
				};
				const context = {
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					extensionMode: vscode.ExtensionMode.Test,
				} as unknown as vscode.ExtensionContext;
				const provider = new (variant.Provider as any)(context,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub());
				const document = {
					uri: vscode.Uri.file(filePath), version: 1, isClosed: false,
					getText: () => variant.text, lineCount: 1,
					lineAt: () => ({ text: variant.text }), eol: vscode.EndOfLine.LF,
				} as unknown as vscode.TextDocument;
				const postMessage = reloadAwarePostMessage(() => receiveHandler, posted);
				const panel = {
					visible: true, active: true,
					webview: {
						options: {},
						postMessage,
						onDidReceiveMessage: (handler: typeof receiveHandler) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => unknown) => {
						disposeHandlers.push(handler);
						return { dispose() {} };
					},
					onDidChangeViewState: () => ({ dispose() {} }),
				} as unknown as vscode.WebviewPanel;
				await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projections = posted.filter(message => message.type === 'documentData' && message.ok);
				assert.strictEqual(projections.length, 1);
				const primaryId = projections[0].state.sections[0].id;
				assert.ok(primaryId, 'the real provider must project its pinned primary');
				const snapshotIdentity = Reflect.get(queryEditor!, 'workbenchToolSnapshotIdentity') as () => unknown;
				const originalIdentity = snapshotIdentity();
				const gateway = startupGateway as MainWebviewStartupGateway<unknown> | undefined;
				assert.ok(gateway, 'the actual provider must use its startup gateway');
				head = gateway.postDocumentProjection({
					preflight: () => { markHeadEntered(); return heldHead; },
					prepare: () => ({ message: { type: 'settingsUpdate', alternatingRowColor: 'held-guard-head' } }),
				});
				await headEntered;
				let current = true;
				const request = { type: 'toolConfigureQuerySection', requestId: 'guarded-compat-tool', input: { sectionId: primaryId, execute: true } };
				const guarded = queryEditor!.postMessage(request, undefined, () => current);
				const follower = queryEditor!.postMessage({ type: 'settingsUpdate', alternatingRowColor: 'unguarded-follower' });
				assert.ok(!posted.some(message => message.requestId === request.requestId), 'the physical queue must still hold the tool message');
				current = false;
				releaseHead(true);
				await head;
				assert.strictEqual(await guarded, false, 'invalidated queued tool delivery must return false');
				assert.strictEqual(posted.filter(message => message.requestId === request.requestId).length, 0, 'invalidated tool messages must never reach the SDK');
				assert.strictEqual(await follower, true);
				assert.strictEqual(posted.filter(message => message.alternatingRowColor === 'unguarded-follower').length, 1);
				current = true;
				const positive = { ...request, requestId: 'current-compat-tool' };
				assert.strictEqual(await queryEditor!.postMessage(positive, undefined, () => current), true);
				assert.strictEqual(posted.filter(message => message.requestId === positive.requestId).length, 1);
				assert.strictEqual(snapshotIdentity(), originalIdentity, 'transport admission must not advance source or projection generations');
				assert.strictEqual(projections[0].state.sections[0].id, primaryId);
				assert.strictEqual(posted.filter(message => message.type === 'documentData' && message.ok).length, 1);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), variant.text);
			} finally {
				releaseHead(true);
				await head;
				for (const dispose of disposeHandlers) await dispose();
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = previousInitialize;
				MainWebviewStartupGateway.prototype.postMessage = previousGatewayPost;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
			}
		});
	}

	test('expired final-persist replies cannot mutate any main host mode', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-expired-final-persist-'));
		const variants = [
			{
				extension: '.kqlx', Provider: KqlxEditorProvider, kind: 'kqlx', primaryType: 'query',
				initialText: JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'query_expired', type: 'query', query: 'print original = 1' },
				] } }, null, 2),
				expiredQuery: 'print expired = 1',
			},
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, kind: 'kql', primaryType: 'query',
				initialText: 'print original = 1', expiredQuery: 'print expired = 1',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, kind: 'sql', primaryType: 'sql',
				initialText: 'SELECT 1 AS original', expiredQuery: 'SELECT 1 AS expired',
			},
		] as const;

		try {
			let activeText = '';
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				activeText = replacement;
				return true;
			};
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `expired-${index}${variant.extension}`);
				activeText = variant.initialText;
				fs.writeFileSync(sourcePath, activeText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => activeText,
					get lineCount() { return Math.max(1, activeText.split(/\r?\n/).length); },
					lineAt: (line: number) => ({ text: activeText.split(/\r?\n/)[line] ?? '' }),
					eol: vscode.EndOfLine.LF, isDirty: false,
					positionAt: (_offset: number) => new vscode.Position(0, 0), save: async () => true,
				} as any;
				const panel = {
					visible: true, active: true,
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
				assert.ok(projection);
				const message = {
					type: 'persistDocument', flushRequestId: `expired-flush-${index}`,
					snapshotId: `expired-snapshot-${index}`,
					sourceGeneration: projection.sourceGeneration, editRevision: 1,
					state: { sections: [{
						id: projection.state.sections[0].id,
						type: variant.primaryType,
						query: variant.expiredQuery,
					}] },
				};
				await Promise.resolve(receiveHandler!(message));
				assert.strictEqual(activeText, variant.initialText, `${variant.extension} must ignore an expired flush reply`);
			}
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('exact empty companions publish no section changes for their unchanged projected primary', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-empty-companion-section-status-'));
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, storedKind: 'mdx',
				primaryType: 'query', primaryId: 'compat_primary_query',
				webviewDefaults: {
					name: '', clusterUrl: '', database: '', expanded: true, resultsVisible: true,
					runMode: 'take100', cacheEnabled: true, cacheValue: 1, cacheUnit: 'days',
				},
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, storedKind: 'kqlx',
				primaryType: 'sql', primaryId: 'compat_primary_sql',
				webviewDefaults: { name: '', expanded: true },
			},
		] as const;

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			let savePromptCount = 0;
			(vscode.window as any).showWarningMessage = async () => {
				savePromptCount++;
				return 'Discard';
			};
			for (const [index, variant] of variants.entries()) {
				savePromptCount = 0;
				const sourcePath = path.join(tmpDir, `empty-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const sidecarText = JSON.stringify({
					kind: variant.storedKind, version: 1, futureRoot: { keep: variant.extension },
					state: { futureState: ['keep'], sections: [] },
				});
				fs.writeFileSync(sourcePath, '', 'utf8');
				fs.writeFileSync(sidecarPath, sidecarText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => '', lineCount: 1,
					lineAt: () => ({ text: '' }), eol: vscode.EndOfLine.LF, isDirty: false, save: async () => true,
				} as any;
				const panel = {
					visible: false, active: false,
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
				assert.strictEqual(projection?.state?.sections?.length, 1);
				assert.strictEqual(projection.state.sections[0].id, variant.primaryId);
				const forgedSnapshotId = `forged-empty-primary-${index}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: forgedSnapshotId,
					sourceGeneration: projection.sourceGeneration, editRevision: 1,
					state: { sections: [{ id: 'forged_primary', type: variant.primaryType, query: '' }] },
				}));
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === forgedSnapshotId), `${variant.extension} forged primary must not be acknowledged`);
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), sidecarText);
				assert.strictEqual(document.getText(), '');
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 2,
					state: { sections: [{ type: variant.primaryType, query: '', ...variant.webviewDefaults }] },
				})));

				const changedSections = posted.filter(message => message?.type === 'changedSections').at(-1);
				assert.deepStrictEqual(changedSections?.changes, [], `${variant.extension} projected primary must remain clean`);
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), sidecarText);
				for (const dispose of disposeHandlers) dispose();
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000), true);
				assert.strictEqual(savePromptCount, 0,
					`${variant.extension} default-rich primary must not prompt on close; changes=${JSON.stringify(changedSections)}`);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility close promotes pre-disposal beforeunload while ordinary startup work is blocked', async () => {
		const originalHandle = (QueryEditorProvider as any).prototype.handleWebviewMessage;
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-blocked-beforeunload-'));
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, kind: 'kqlx', primaryType: 'query', primaryId: 'compat_primary_query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, kind: 'sqlx', primaryType: 'sql', primaryId: 'compat_primary_sql' },
		] as const;
		let savePromptCount = 0;

		try {
			(vscode.window as any).showWarningMessage = async () => {
				savePromptCount++;
				return 'Save';
			};
			for (const [index, variant] of variants.entries()) {
				let markBlocked!: () => void;
				let releaseBlocked!: () => void;
				const blocked = new Promise<void>(resolve => { markBlocked = resolve; });
				const blockedGate = new Promise<void>(resolve => { releaseBlocked = resolve; });
				let finalSanitationStarted = false;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (JSON.stringify(state).includes('BLOCKED_FINAL_STATE')) finalSanitationStarted = true;
					return state;
				};
				(QueryEditorProvider as any).prototype.handleWebviewMessage = async (message: any) => {
					if (message?.type !== 'pauseStartupForBeforeUnloadTest') return;
					markBlocked();
					await blockedGate;
				};
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async (panel: vscode.WebviewPanel, options: any) => {
					registerCompatibilityPersistenceTestBootstrap(panel, options?.compatibilityPersistence);
					assert.ok(receiveHandler, 'listener-first startup must expose the receiver during initialization');
					void Promise.resolve(receiveHandler!({ type: 'pauseStartupForBeforeUnloadTest' }));
				};
				const sourcePath = path.join(tmpDir, `blocked-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false, save: async () => true,
				} as any;
				const panel = {
					visible: true,
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidChangeViewState: () => ({ dispose() {} }),
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				let resolvingSettled = false;
				const resolving = Promise.resolve(provider.resolveCustomTextEditor(document, panel, {} as any))
					.finally(() => { resolvingSettled = true; });
				await blocked;
				let finalInboundSettled = false;
				const finalInbound = Promise.resolve(receiveHandler!({
					type: 'persistDocument', reason: 'beforeunload', editRevision: 1,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'BLOCKED_FINAL_STATE' },
					] },
				})).finally(() => { finalInboundSettled = true; });
				for (const dispose of disposeHandlers) dispose();
				await waitForCondition(
					() => finalSanitationStarted,
					`${variant.extension} admitted beforeunload must start while startup remains blocked`,
					1_000,
				);
				await new Promise<void>(resolve => setTimeout(resolve, 650));
				releaseBlocked();
				await waitForCondition(
					() => resolvingSettled && finalInboundSettled,
					`${variant.extension} close stalled: resolving=${resolvingSettled}, finalInbound=${finalInboundSettled}`,
					1_000,
				);
				await Promise.all([resolving, finalInbound]);
				await waitForCondition(
					() => fs.readFileSync(sidecarPath, 'utf8').includes('BLOCKED_FINAL_STATE'),
					`${variant.extension} close must retain the admitted final state; savePrompts=${savePromptCount}`,
					1_000,
				);
			}
		} finally {
			(QueryEditorProvider as any).prototype.handleWebviewMessage = originalHandle;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility close retains beforeunload when disposal precedes handler installation', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-prehandler-beforeunload-'));
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, kind: 'kqlx', primaryType: 'query', primaryId: 'compat_primary_query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, kind: 'sqlx', primaryType: 'sql', primaryId: 'compat_primary_sql' },
		] as const;

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
				state: any,
				onKustoSanitized?: (before: any, after: any, context: { snapshot: any }) => void,
			) => {
				onKustoSanitized?.(state, state, {
					snapshot: { clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {} },
				});
				return state;
			};
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const [index, variant] of variants.entries()) {
				let markInitializeEntered!: () => void;
				let releaseInitialize!: () => void;
				const initializeEntered = new Promise<void>(resolve => { markInitializeEntered = resolve; });
				const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve; });
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async (panel: vscode.WebviewPanel, options: any) => {
					registerCompatibilityPersistenceTestBootstrap(panel, options?.compatibilityPersistence);
					markInitializeEntered();
					await initializeGate;
				};
				const sourcePath = path.join(tmpDir, `prehandler-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false, save: async () => true,
				} as any;
				const panel = {
					visible: true,
					webview: {
						options: {}, postMessage: async () => true,
						onDidReceiveMessage: (handler: (message: any) => unknown) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidChangeViewState: () => ({ dispose() {} }),
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				const resolving = Promise.resolve(provider.resolveCustomTextEditor(document, panel, {} as any));
				await initializeEntered;
				const finalInbound = Promise.resolve(receiveHandler!({
					type: 'persistDocument', reason: 'beforeunload', editRevision: 1,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'PREHANDLER_FINAL_STATE' },
					] },
				}));
				for (const dispose of disposeHandlers) dispose();
				releaseInitialize();
				await Promise.all([resolving, finalInbound]);
				await waitForCondition(
					() => fs.readFileSync(sidecarPath, 'utf8').includes('PREHANDLER_FINAL_STATE'),
					`${variant.extension} pre-handler close must retain final state`,
					1_000,
				);
			}
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility close resynchronizes visibility after delayed initialization', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-startup-visibility-'));
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, kind: 'kqlx', primaryType: 'query', primaryId: 'compat_primary_query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, kind: 'sqlx', primaryType: 'sql', primaryId: 'compat_primary_sql' },
		] as const;
		const finalStateSaved: boolean[] = [];

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const [index, variant] of variants.entries()) {
				let markInitializeEntered!: () => void;
				let releaseInitialize!: () => void;
				const initializeEntered = new Promise<void>(resolve => { markInitializeEntered = resolve; });
				const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve; });
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async (panel: vscode.WebviewPanel, options: any) => {
					registerCompatibilityPersistenceTestBootstrap(panel, options?.compatibilityPersistence);
					markInitializeEntered();
					await initializeGate;
				};
				const sourcePath = path.join(tmpDir, `visibility-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `visibility-global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					visible: false,
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidChangeViewState: () => ({ dispose() {} }),
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				const resolving = Promise.resolve(provider.resolveCustomTextEditor(document, panel, {} as any));
				await initializeEntered;
				panel.visible = true;
				releaseInitialize();
				await resolving;
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ type: variant.primaryType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'STARTUP_DIRTY' },
					] },
				})));

				setTimeout(() => {
					void Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
						type: 'persistDocument', reason: 'beforeunload', editRevision: 2,
						state: { sections: [
							{ type: variant.primaryType, query: 'select 1' },
							{ id: 'markdown_1', type: 'markdown', text: 'VISIBLE_FINAL_STATE' },
						] },
					})));
				}, 50);
				for (const dispose of disposeHandlers) dispose();
				await new Promise<void>(resolve => setTimeout(resolve, 700));
				finalStateSaved.push(fs.readFileSync(sidecarPath, 'utf8').includes('VISIBLE_FINAL_STATE'));
			}

			assert.deepStrictEqual(finalStateSaved, [true, true]);
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session close promotes pre-disposal beforeunload during handler construction', async () => {
		const previousInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-rich-early-close-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		let markInitializeEntered!: () => void;
		let releaseInitialize!: () => void;
		const initializeEntered = new Promise<void>(resolve => { markInitializeEntered = resolve; });
		const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve; });
		let resolveEditor: Promise<void> | undefined;

		try {
			fs.writeFileSync(sessionPath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (panel: vscode.WebviewPanel) {
				(this as any).panel = panel;
				(this as any)._panelDisposed = false;
				markInitializeEntered();
				await initializeGate;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			);
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => initialText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				visible: true, active: true,
				webview: {
					options: {}, postMessage: async () => true,
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			deferMainWebviewReadyForTest(panel);

			resolveEditor = Promise.resolve(provider.resolveCustomTextEditor(document, panel, {} as any));
			await initializeEntered;
			const inbound = Promise.resolve(receiveHandler!({
				type: 'persistDocument', reason: 'beforeunload', snapshotId: 'early-close',
				sourceGeneration: 0, editRevision: 1,
				state: { sections: [{ id: 'query_early', type: 'query', query: 'EARLY_FINAL_STATE' }] },
			}));
			for (const dispose of [...disposeHandlers]) dispose();
			releaseInitialize();
			await resolveEditor;
			await inbound;
			await waitForCondition(
				() => fs.readFileSync(sessionPath, 'utf8').includes('EARLY_FINAL_STATE'),
				'early beforeunload state should reach the session file',
			);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000), true);
		} finally {
			releaseInitialize?.();
			try { await resolveEditor; } catch { /* preserve the original assertion */ }
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = previousInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('non-session startup close drains Kusto owner traffic and drops ordinary traffic', async () => {
		const previousInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const previousHandle = (QueryEditorProvider as any).prototype.handleWebviewMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-rich-kusto-owner-close-'));
		const filePath = path.join(tmpDir, 'ordinary.kqlx');
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		const handledTypes: string[] = [];
		let markInitializeEntered!: () => void;
		let releaseInitialize!: () => void;
		const initializeEntered = new Promise<void>(resolve => { markInitializeEntered = resolve; });
		const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve; });

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (panel: vscode.WebviewPanel) {
				(this as any).panel = panel;
				(this as any)._panelDisposed = false;
				markInitializeEntered();
				await initializeGate;
			};
			(QueryEditorProvider as any).prototype.handleWebviewMessage = async (message: any) => {
				handledTypes.push(String(message?.type || ''));
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			);
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				visible: true, active: true,
				webview: {
					options: {}, postMessage: async () => true,
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			deferMainWebviewReadyForTest(panel);

			const resolving = Promise.resolve(provider.resolveCustomTextEditor(document, panel, {} as any));
			await initializeEntered;
			await Promise.resolve(receiveHandler!({ type: 'showInfo', message: 'drop ordinary startup traffic' }));
			await Promise.resolve(receiveHandler!({
				type: 'kustoSectionClose', boxId: 'query-1', sectionInstanceId: 'section-1',
			}));
			for (const dispose of [...disposeHandlers]) dispose();
			releaseInitialize();
			await resolving;
			await waitForCondition(() => handledTypes.includes('kustoSectionClose'), 'Kusto close traffic should drain');
			assert.deepStrictEqual(handledTypes, ['kustoSectionClose']);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000), true);
		} finally {
			releaseInitialize?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = previousInitialize;
			(QueryEditorProvider as any).prototype.handleWebviewMessage = previousHandle;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native close during initial file identity lookup completes close tracking', async () => {
		const originalRealpath = fs.promises.realpath;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-identity-close-'));
		const filePath = path.join(tmpDir, 'identity-close.kqlx');
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		let markIdentityStarted!: () => void;
		let releaseIdentity!: () => void;
		const identityStarted = new Promise<void>(resolve => { markIdentityStarted = resolve; });
		const identityGate = new Promise<void>(resolve => { releaseIdentity = resolve; });
		let gated = false;
		let resolveEditor: Promise<void> | undefined;

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			(fs.promises as any).realpath = async (candidate: string) => {
				if (!gated && path.resolve(candidate).toLowerCase() === path.resolve(filePath).toLowerCase()) {
					gated = true;
					markIdentityStarted();
					await identityGate;
				}
				return originalRealpath(candidate);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			);
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				visible: true, active: true,
				webview: {
					options: {}, postMessage: async () => true,
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			resolveEditor = Promise.resolve(provider.resolveCustomTextEditor(document, panel, {} as any));
			await identityStarted;
			assert.ok(receiveHandler);
			for (const dispose of [...disposeHandlers]) dispose();
			releaseIdentity();
			await resolveEditor;
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'close finalization must start even when disposal lands inside identity acquisition',
			);
			assert.ok(
				![...(provider as any).markdownPanelOwners.values()]
					.some((owners: Map<unknown, unknown>) => owners.has(panel)),
				'a panel disposed before Markdown owner registration must be retired after registration',
			);
		} finally {
			releaseIdentity?.();
			try { await resolveEditor; } catch { /* preserve the original assertion */ }
			(fs.promises as any).realpath = originalRealpath;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native linked-query validation installs disposal tracking before filesystem identity awaits', async () => {
		const originalRealpath = fs.promises.realpath;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-validation-close-'));
		const filePath = path.join(tmpDir, 'linked-validation.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const text = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_linked', type: 'query', query: 'print value = 1', linkedQueryPath: 'linked.kql',
			}] },
		});
		const disposeHandlers: Array<() => void> = [];
		let markValidationStarted!: () => void;
		let releaseValidation!: () => void;
		const validationStarted = new Promise<void>(resolve => { markValidationStarted = resolve; });
		const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
		let gated = false;
		let resolveEditor: Promise<void> | undefined;

		try {
			fs.writeFileSync(filePath, text, 'utf8');
			fs.writeFileSync(linkedPath, 'print value = 1', 'utf8');
			(fs.promises as any).realpath = async (candidate: string) => {
				if (!gated && path.resolve(candidate).toLowerCase() === path.resolve(filePath).toLowerCase()) {
					gated = true;
					markValidationStarted();
					await validationGate;
				}
				return originalRealpath(candidate);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			);
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				visible: true, active: true,
				webview: { options: {}, postMessage: async () => true, onDidReceiveMessage: () => ({ dispose() {} }) },
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;

			resolveEditor = Promise.resolve(provider.resolveCustomTextEditor(document, panel, {} as any));
			await validationStarted;
			assert.ok(disposeHandlers.length > 0, 'open-editor disposal tracking must precede linked-query validation');
			for (const dispose of [...disposeHandlers]) dispose();
			releaseValidation();
			await resolveEditor;
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000), true);
		} finally {
			releaseValidation?.();
			try { await resolveEditor; } catch { /* preserve the original assertion */ }
			(fs.promises as any).realpath = originalRealpath;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compat projections drop stale primary text after delayed sanitation', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-projection-race-'));

		try {
			for (const [index, variant] of variants.entries()) {
				let primaryText = 'select old';
				let receiveHandler: ((message: any) => unknown) | undefined;
				let markOldStarted!: () => void;
				let releaseOld!: () => void;
				const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
				const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					const query = String(state.sections?.[0]?.query || '');
					if (query === 'select old') {
						markOldStarted();
						await oldGate;
					}
					return state;
				};
				const sourcePath = path.join(tmpDir, `race-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, primaryText, 'utf8');
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => primaryText, lineCount: 1,
					lineAt: () => ({ text: primaryText }), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true,
					onDidDispose: () => ({ dispose() {} }),
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				const oldProjection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await oldStarted;
				primaryText = 'select new';
				const newerProjection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				releaseOld();
				await Promise.all([oldProjection, newerProjection]);
				await waitForCondition(
					() => posted.some(message => message?.type === 'documentData' && message.ok === true),
					`${variant.extension} should publish the newer source after sanitation retires the old request`,
				);

				const projections = posted.filter(message => message?.type === 'documentData' && message.ok === true);
				assert.ok(projections.length >= 1);
				assert.ok(projections.every(message => message.state.sections[0].query === 'select new'),
					`${variant.extension} must never publish the stale primary text`);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('initial projections leave a second changed source eligible after automatic recovery', async () => {
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kqlx', Provider: KqlxEditorProvider, type: 'query', wrapped: true },
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query', wrapped: false },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql', wrapped: false },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-initial-projection-retry-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const oldQuery = variant.type === 'sql' ? 'select old' : 'print old = 1';
				const middleQuery = variant.type === 'sql' ? 'select middle' : 'print middle = 2';
				const finalQuery = variant.type === 'sql' ? 'select final' : 'print final = 3';
				const wrap = (query: string) => variant.wrapped
					? JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
						{ id: 'query_1', type: variant.type, query },
					] } })
					: query;
				let sourceText = wrap(oldQuery);
				let receiveHandler: ((message: any) => unknown) | undefined;
				let changeHandler: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
				let markOldStarted!: () => void;
				let releaseOld!: () => void;
				let markMiddleStarted!: () => void;
				let releaseMiddle!: () => void;
				const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
				const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
				const middleStarted = new Promise<void>(resolve => { markMiddleStarted = resolve; });
				const middleGate = new Promise<void>(resolve => { releaseMiddle = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
					state: any,
					onKustoSanitized?: (before: any, after: any, context: { snapshot: any }) => void,
				) => {
					onKustoSanitized?.(state, state, {
						snapshot: { clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {} },
					});
					const query = String(state.sections?.[0]?.query || '');
					if (query === oldQuery) {
						markOldStarted();
						await oldGate;
					}
					if (query === middleQuery) {
						markMiddleStarted();
						await middleGate;
					}
					return state;
				};
				(vscode.workspace as any).onDidChangeTextDocument = (
					handler: (event: vscode.TextDocumentChangeEvent) => unknown,
				) => {
					changeHandler = handler;
					return { dispose() {} };
				};
				const sourcePath = path.join(tmpDir, `initial-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, sourceText, 'utf8');
				const context = {
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
				} as any;
				const provider = new (variant.Provider as any)(
					context, vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => sourceText, lineCount: 1,
					lineAt: () => ({ text: sourceText }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const posted: any[] = [];
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true,
					onDidDispose: () => ({ dispose() {} }),
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(changeHandler);
				const initialRequest = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await oldStarted;
				sourceText = wrap(middleQuery);
				await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
				releaseOld();
				await middleStarted;
				sourceText = wrap(finalQuery);
				await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
				const finalCoalescedRequest = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				releaseMiddle();
				await Promise.all([initialRequest, finalCoalescedRequest]);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await waitForCondition(
					() => posted.some(message => message?.type === 'documentData' && message.ok === true),
					`${variant.extension} should leave the second changed source eligible`,
				);

				const projections = posted.filter(message => message?.type === 'documentData' && message.ok === true);
				assert.strictEqual(projections.length, 1, `${variant.extension} should publish exactly one initial projection`);
				assert.strictEqual(projections[0].state.sections[0].query, finalQuery);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility initial projection retries a rejected delivery with unchanged source', async () => {
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, query: 'print value = 1' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, query: 'select 1' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-delivery-retry-'));
		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `retry-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, variant.query, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let documentDataAttempts = 0;
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => variant.query, lineCount: 1,
					lineAt: () => ({ text: variant.query }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.type !== 'documentData') return true;
							documentDataAttempts++;
							if (documentDataAttempts === 1) return false;
							if (message.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				assert.strictEqual(documentDataAttempts, 2, `${variant.extension} should retry one rejected delivery`);
			}
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('initial KQLX projection retries a rejected webview delivery', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-initial-delivery-retry-'));
		const sourcePath = path.join(tmpDir, 'delivery.kqlx');
		const sourceText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print delivery = 1' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		let documentDeliveries = 0;
		const forceReloadValues: boolean[] = [];

		try {
			fs.writeFileSync(sourcePath, sourceText, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => sourceText, eol: vscode.EndOfLine.LF,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type !== 'documentData') return true;
						documentDeliveries++;
						forceReloadValues.push(message.forceReload === true);
						if (documentDeliveries === 1) return false;
						if (message.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			assert.strictEqual(documentDeliveries, 2);
			assert.deepStrictEqual(forceReloadValues, [false, true]);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility reload retires delayed metadata persists', async () => {
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-reload-retire-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `reload-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				let primaryText = variant.primaryType === 'sql' ? 'select initial' : 'print initial = 0';
				fs.writeFileSync(sourcePath, primaryText, 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				let markStaleStarted!: () => void;
				let releaseStale!: () => void;
				const staleStarted = new Promise<void>(resolve => { markStaleStarted = resolve; });
				const staleGate = new Promise<void>(resolve => { releaseStale = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (state.sections?.some((section: any) => section.text === 'STALE')) {
						markStaleStarted();
						await staleGate;
					}
					return state;
				};
				(vscode.workspace as any).onDidSaveTextDocument = (
					handler: (document: vscode.TextDocument) => unknown,
				) => {
					didSaveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => primaryText, lineCount: 1,
					lineAt: () => ({ text: primaryText }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true,
					onDidDispose: () => ({ dispose() {} }),
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const stalePersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1, state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, query: primaryText },
						{ id: 'markdown_1', type: 'markdown', text: 'STALE' },
					] },
				}));
				await staleStarted;
				primaryText = variant.primaryType === 'sql' ? 'select external' : 'print external = 2';
				const reload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				releaseStale();
				await Promise.all([stalePersist, reload]);
				await Promise.resolve(didSaveHandler!(document));
				const afterStale = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
				assert.strictEqual(
					afterStale.state.sections.find((section: any) => section.id === 'markdown_1').text,
					'BASELINE',
					`${variant.extension} stale metadata must remain retired after reload`,
				);
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 2, state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, query: primaryText },
						{ id: 'markdown_1', type: 'markdown', text: 'NEW' },
					] },
				}));
				await Promise.resolve(didSaveHandler!(document));

				const saved = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
				assert.strictEqual(saved.state.sections.find((section: any) => section.id === 'markdown_1').text, 'NEW');
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('source generation rejects stale snapshots delivered after reload', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const variants = [
			{ extension: '.kqlx', Provider: KqlxEditorProvider, type: 'query', kind: 'kqlx', wrapped: true },
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query', kind: 'kqlx', wrapped: false },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql', kind: 'sqlx', wrapped: false },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-source-generation-fence-'));
		try {
			for (const [index, variant] of variants.entries()) {
				const initialQuery = variant.type === 'sql' ? 'select initial' : 'print initial = 0';
				const externalQuery = variant.type === 'sql' ? 'select external' : 'print external = 1';
				const wrap = (query: string) => variant.wrapped
					? JSON.stringify({ kind: variant.kind, version: 1, state: { sections: [
						{ id: 'primary_1', type: variant.type, query },
					] } }, null, 2) + '\n'
					: query;
				let sourceText = wrap(initialQuery);
				const sourcePath = path.join(tmpDir, `source-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, sourceText, 'utf8');
				if (!variant.wrapped) {
					fs.writeFileSync(sidecarPath, JSON.stringify({
						kind: variant.kind, version: 1, state: { sections: [
							{ id: 'primary_1', type: variant.type, linkedQueryPath: path.basename(sourcePath) },
							{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
						] },
					}, null, 2) + '\n', 'utf8');
				}
				let receiveHandler: ((message: any) => unknown) | undefined;
				let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				let applyCalls = 0;
				(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
					didSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).applyEdit = async () => { applyCalls++; return true; };
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => sourceText, lineCount: 1,
					lineAt: () => ({ text: sourceText }), eol: vscode.EndOfLine.LF, isDirty: false,
					positionAt: (_offset: number) => new vscode.Position(0, 0),
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const firstProjection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
				assert.ok(Number.isSafeInteger(firstProjection?.sourceGeneration));

				sourceText = wrap(externalQuery);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const latestProjection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
				assert.ok(latestProjection.sourceGeneration > firstProjection.sourceGeneration);
				const staleState = { sections: [
					{ id: 'primary_1', type: variant.type, query: initialQuery },
					...(!variant.wrapped ? [{ id: 'markdown_1', type: 'markdown', text: 'STALE' }] : []),
				] };
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `stale-generation-${index}`, editRevision: 1,
					sourceGeneration: firstProjection.sourceGeneration, state: staleState,
				}));
				if (didSaveHandler) await Promise.resolve(didSaveHandler(document));

				assert.strictEqual(applyCalls, 0, `${variant.extension} stale generation must not edit source text`);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === `stale-generation-${index}`));
				if (!variant.wrapped) {
					const saved = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
					assert.strictEqual(saved.state.sections.find((section: any) => section.id === 'markdown_1').text, 'BASELINE');
				}
			}
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rejected compatibility reload blocks the previous generation and restores bounded recovery', async () => {
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-reload-rejected-'));
		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `reload-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				let primaryText = variant.primaryType === 'sql' ? 'select initial' : 'print initial = 0';
				fs.writeFileSync(sourcePath, primaryText, 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let rejectedDeliveries = 0;
				const posted: any[] = [];
				const resultRegistry = variant.primaryType === 'query'
					? new KustoResultPersistenceRegistry()
					: undefined;
				const provider = variant.primaryType === 'query'
					? new (KqlCompatEditorProvider as any)(
						{
							subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
							globalState: { get: () => undefined, update: async () => undefined },
							globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
						} as any,
						vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
						undefined, undefined, undefined, undefined, resultRegistry,
					)
					: new (SqlCompatEditorProvider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
						vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => primaryText, lineCount: 1,
					lineAt: () => ({ text: primaryText }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type !== 'documentData') return true;
							if (rejectedDeliveries > 0) {
								rejectedDeliveries--;
								return false;
							}
							if (message.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const initialGeneration = Number(posted.find(message => message?.type === 'documentData')?.sourceGeneration);
				assert.ok(Number.isSafeInteger(initialGeneration));
				let kustoResultOwner: ReturnType<KustoResultPersistenceRegistry['get']>;
				if (resultRegistry) {
					const projection = posted.find(message => message?.type === 'documentData' && message.ok === true);
					const boxId = String(projection?.state?.sections?.[0]?.id || '');
					kustoResultOwner = resultRegistry.get(normalizeWorkbenchUriKey(document.uri));
					assert.ok(kustoResultOwner && boxId);
					const session = kustoResultOwner!.openPanel('rejected-compat-result');
					session.openSection(boxId, 'rejected-compat-instance');
					session.adoptTarget({
						boxId, sectionInstanceId: 'rejected-compat-instance', targetGeneration: 1,
						connectionId: 'connection-1', database: 'Db',
					});
					const terminal = {
						type: 'queryResult' as const, engine: 'kusto' as const, boxId,
						sectionInstanceId: 'rejected-compat-instance', targetGeneration: 1,
						executionId: 'rejected-compat-execution', connectionId: 'connection-1', database: 'Db',
						producer: 'manual' as const, query: primaryText, reservationSequence: 1,
						dispatch: {
							dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
							connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
							clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
							accountPartition: 'partition-a', authSessionGeneration: 1,
							clientActivityId: 'rejected-compat',
						},
						result: { columns: ['Value'], rows: [[1]], metadata: {} },
					};
					assert.strictEqual(session.beginExecution(terminal), true);
					assert.ok(session.stagePublication('rejected-compat-publication', terminal));
					assert.strictEqual(session.commitPublication('rejected-compat-publication'), true);
				}

				rejectedDeliveries = 1;
				primaryText = variant.primaryType === 'sql' ? 'select external' : 'print external = 1';
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				if (kustoResultOwner) {
					assert.ok((kustoResultOwner.overlaySnapshot({ sections: [{
						id: 'primary_1', type: 'query', query: primaryText,
					}] }).sections?.[0] as any).resultJson);
				}
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `stale-${index}`, sourceGeneration: initialGeneration,
					editRevision: 1, state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, query: 'STALE' },
						{ id: 'markdown_1', type: 'markdown', text: 'STALE' },
					] },
				}));

				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === `stale-${index}`));
				const saved = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
				assert.strictEqual(saved.state.sections.find((section: any) => section.id === 'markdown_1').text, 'BASELINE');

				const attemptsBeforeRecovery = posted.filter(message => message?.type === 'documentData').length;
				rejectedDeliveries = 1;
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const recoveryAttempts = posted.filter(message => message?.type === 'documentData').slice(attemptsBeforeRecovery);
				assert.strictEqual(recoveryAttempts.length, 2, `${variant.extension} should retry after a current reload failure`);
				assert.strictEqual(recoveryAttempts.at(-1)?.state?.sections?.[0]?.query,
					variant.primaryType === 'sql' ? 'select external' : 'print external = 1');
				if (kustoResultOwner) {
					assert.strictEqual((kustoResultOwner.overlaySnapshot({ sections: [{
						id: 'primary_1', type: 'query', query: primaryText,
					}] }).sections?.[0] as any).resultJson, undefined);
				}
				resultRegistry?.dispose();
			}
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility owner conflict reprojects the newer Kusto result before accepting edits', async function () {
		this.timeout(10_000);
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-owner-conflict-'));
		const sourcePath = path.join(tmpDir, 'owner-conflict.kql');
		const sidecarPath = `${sourcePath}.json`;
		const queryText = 'print Value=1';
		const registry = new KustoResultPersistenceRegistry();
		const persistTerminals: string[] = [];
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let heldReloadRequestId = '';
		let holdReload = false;

		try {
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			fs.writeFileSync(sourcePath, queryText, 'utf8');
			fs.writeFileSync(sidecarPath, JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'primary_1', type: 'query', linkedQueryPath: path.basename(sourcePath) },
					{ id: 'markdown_1', type: 'markdown', text: 'before conflict' },
				] },
			}), 'utf8');
			const provider = new (KqlCompatEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, undefined, undefined,
				(options: ConstructorParameters<typeof CompatSidecarPersistCoordinator>[0]) => {
					const coordinator = new CompatSidecarPersistCoordinator(options);
					return {
						persist: async (message: Parameters<typeof coordinator.persist>[0]) => {
							const result = await coordinator.persist(message);
							persistTerminals.push(result.terminal);
							return result;
						},
					};
				},
				registry,
			) as KqlCompatEditorProvider;
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => queryText, lineCount: 1,
				lineAt: () => ({ text: queryText }), eol: vscode.EndOfLine.LF, isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (!message?.reloadRequestId) return true;
						if (holdReload) {
							heldReloadRequestId = message.reloadRequestId;
							return true;
						}
						await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: Number(message.editRevision || 0),
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				visible: true,
				onDidChangeViewState: () => ({ dispose() {} }),
				onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const initialProjection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
			const boxId = String(initialProjection?.state?.sections?.[0]?.id || '');
			const owner = registry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(owner && boxId);
			const session = owner!.openPanel('compat-owner-conflict-panel');
			session.openSection(boxId, 'compat-owner-conflict-instance');
			session.adoptTarget({
				boxId, sectionInstanceId: 'compat-owner-conflict-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const terminal = (executionId: string, reservationSequence: number, value: number) => ({
				type: 'queryResult' as const, engine: 'kusto' as const, boxId,
				sectionInstanceId: 'compat-owner-conflict-instance', targetGeneration: 1,
				executionId, connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: queryText, reservationSequence,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1,
					clientActivityId: executionId,
				},
				result: { columns: ['Value'], rows: [[value]], metadata: {} },
			});
			const first = terminal('compat-owner-result-1', 1, 1);
			assert.strictEqual(session.beginExecution(first), true);
			assert.ok(session.stagePublication('compat-owner-publication-1', first));
			assert.strictEqual(session.commitPublication('compat-owner-publication-1'), true);

			const projectionCountBeforeConflict = posted.filter(message => message?.type === 'documentData').length;
			holdReload = true;
			const conflictedRequest = Promise.resolve(receiveHandler!({
				type: 'requestDocument', requestId: 'compat-owner-conflict-reload', expectedEditRevision: 4,
			}));
			await waitForCondition(() => !!heldReloadRequestId, 'compatibility conflict candidate should be posted');
			const conflictedProjection = posted.filter(message => message?.type === 'documentData').at(-1);
			assert.strictEqual(conflictedProjection.expectedEditRevision, 4);
			const second = terminal('compat-owner-result-2', 2, 2);
			assert.strictEqual(session.beginExecution(second), true);
			assert.ok(session.stagePublication('compat-owner-publication-2', second));
			assert.strictEqual(session.commitPublication('compat-owner-publication-2'), true);
			holdReload = false;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: heldReloadRequestId,
				applied: true, editRevision: Number(conflictedProjection?.editRevision || 0),
			}));
			await conflictedRequest;

			await waitForCondition(() => {
				const projections = posted.filter(message => message?.type === 'documentData' && message.ok === true);
				if (projections.length < projectionCountBeforeConflict + 2) return false;
				const section = projections.at(-1)?.state?.sections?.find((candidate: any) => candidate.id === boxId);
				try { return JSON.parse(String(section?.resultJson || '')).rows?.[0]?.[0] === 2; }
				catch { return false; }
			}, 'compatibility conflict retry should project the newer host result');
			const settledProjections = posted.filter(message => message?.type === 'documentData' && message.ok === true);
			assert.strictEqual(settledProjections.length, projectionCountBeforeConflict + 2);
			const retryProjection = settledProjections.at(-1);
			assert.ok(retryProjection.sourceGeneration > conflictedProjection.sourceGeneration);
			assert.strictEqual(retryProjection.expectedEditRevision, 4,
				'canonical-source conflict retry must retain the originating edit-revision fence');
			const editedState = {
				...retryProjection.state,
				sections: retryProjection.state.sections.map((section: any) => section.id === 'markdown_1'
					? { ...section, text: 'after conflict' }
					: section),
			};
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'compat-owner-conflict-edit',
				sourceGeneration: retryProjection.sourceGeneration,
				editRevision: Number(retryProjection.editRevision || 0) + 1,
				state: editedState,
			}));
			assert.deepStrictEqual(persistTerminals, ['applied']);
			assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'compat-owner-conflict-edit'));
			assert.strictEqual(owner!.getCommittedSummary(boxId)?.executionId, 'compat-owner-result-2');
		} finally {
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			registry.dispose();
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native conflict exhaustion releases retry lineage and gives changed bytes a fresh projection', async function () {
		this.timeout(10_000);
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-owner-conflict-exhaustion-'));
		const filePath = path.join(tmpDir, 'owner-conflict.kqlx');
		const queryText = 'print Value=1';
		let documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: queryText },
			] },
		});
		const changedQueryText = 'print Value=2';
		const changedDocumentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: changedQueryText },
			] },
		});
		const finalQueryText = 'print Value=3';
		const finalDocumentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: finalQueryText },
			] },
		});
		const registry = new KustoResultPersistenceRegistry();
		let receiveHandler: ((message: any) => unknown) | undefined;
		let conflictPhase: 'none' | 'exhaust-a' | 'conflict-b-first' | 'drift-b-second' = 'none';
		let conflictProjectionCount = 0;
		let bProjectionCount = 0;
		let publicationSequence = 0;
		let ownerSession: any;
		const disposeHandlers: Array<() => void> = [];
		const posted: any[] = [];

		try {
			fs.writeFileSync(filePath, documentText, 'utf8');
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, registry,
			);
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => documentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const terminal = (sequence: number, query = queryText) => ({
				type: 'queryResult' as const, engine: 'kusto' as const, boxId: 'query_1',
				sectionInstanceId: 'native-owner-conflict-instance', targetGeneration: 1,
				executionId: `native-owner-conflict-${sequence}`, connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query, reservationSequence: sequence,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1,
					clientActivityId: `native-owner-conflict-${sequence}`,
				},
				result: { columns: ['Value'], rows: [[sequence]], metadata: {} },
			});
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (!message?.reloadRequestId) return true;
						if (conflictPhase !== 'none') {
							const deliveredConflictPhase = conflictPhase;
							if (deliveredConflictPhase === 'exhaust-a') conflictProjectionCount++;
							else bProjectionCount++;
							if (deliveredConflictPhase !== 'drift-b-second') {
								publicationSequence++;
								const next = terminal(
									publicationSequence,
									deliveredConflictPhase === 'conflict-b-first' ? changedQueryText : queryText,
								);
								assert.strictEqual(ownerSession.beginExecution(next), true);
								assert.ok(ownerSession.stagePublication(`native-conflict-${publicationSequence}`, next));
								assert.strictEqual(ownerSession.commitPublication(`native-conflict-${publicationSequence}`), true);
							}
							if (deliveredConflictPhase === 'exhaust-a' && conflictProjectionCount === 3) {
								documentText = changedDocumentText;
								conflictPhase = 'conflict-b-first';
							} else if (deliveredConflictPhase === 'conflict-b-first') {
								conflictPhase = 'drift-b-second';
							} else if (deliveredConflictPhase === 'drift-b-second') {
								documentText = finalDocumentText;
								conflictPhase = 'none';
							}
						}
						await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: Number(message.editRevision || 0),
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const owner = registry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(owner);
			ownerSession = owner!.openPanel('native-owner-conflict-panel');
			ownerSession.openSection('query_1', 'native-owner-conflict-instance');
			ownerSession.adoptTarget({
				boxId: 'query_1', sectionInstanceId: 'native-owner-conflict-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});

			conflictPhase = 'exhaust-a';
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => posted.some(message => message?.type === 'documentData'
				&& message?.ok === true && message?.state?.sections?.[0]?.query === changedQueryText),
			'native source drift should receive one fresh projection budget');
			await waitForCondition(() => bProjectionCount === 2, 'B should conflict once before its retry drifts to C');
			await waitForCondition(
				() => (owner as any).preparedSourceOwnerRevisionByIdentity.size === 0,
				'exhausted B-to-C drift should release retry lineage',
			);

			assert.strictEqual(conflictProjectionCount, 3);
			assert.strictEqual(bProjectionCount, 2);
			assert.ok(!posted.some(message => message?.type === 'documentData'
				&& message?.ok === true && message?.state?.sections?.[0]?.query === finalQueryText));
			assert.strictEqual((owner as any).preparedSourceOwnerRevisionByIdentity.size, 0);
		} finally {
			ownerSession?.dispose?.();
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(vscode.Uri.file(filePath), 2_000);
			registry.dispose();
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility policy revocation rejects a cold result admission awaiting acknowledgement', async function () {
		this.timeout(10_000);
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-held-policy-'));
		const sourcePath = path.join(tmpDir, 'held-policy.kql');
		const sidecarPath = `${sourcePath}.json`;
		const queryText = 'print Value=1';
		const sourceRegistry = new KustoResultPersistenceRegistry();
		const sourceLease = sourceRegistry.acquire('fixture://compat-held-policy');
		const sourceSession = sourceLease.owner.openPanel('fixture-panel');
		sourceSession.openSection('primary_1', 'fixture-instance');
		sourceSession.adoptTarget({
			boxId: 'primary_1', sectionInstanceId: 'fixture-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		const terminal = {
			type: 'queryResult' as const, engine: 'kusto' as const, boxId: 'primary_1',
			sectionInstanceId: 'fixture-instance', targetGeneration: 1,
			executionId: 'fixture-execution', connectionId: 'connection-1', database: 'Db',
			producer: 'manual' as const, query: queryText, reservationSequence: 1,
			dispatch: {
				dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
				connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
				clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
				accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'fixture',
			},
			result: { columns: ['Value'], rows: [[1]], metadata: {} },
		};
		assert.strictEqual(sourceSession.beginExecution(terminal), true);
		assert.ok(sourceSession.stagePublication('fixture-publication', terminal));
		assert.strictEqual(sourceSession.commitPublication('fixture-publication'), true);
		const persistedState = sourceLease.owner.overlaySnapshot({
			sections: [{ id: 'primary_1', type: 'query', linkedQueryPath: path.basename(sourcePath) }],
		});
		const rowFreeState = {
			sections: [{ id: 'primary_1', type: 'query', query: queryText }],
		};
		const registry = new KustoResultPersistenceRegistry();
		let protectedNow = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		let heldReloadRequestId = '';
		let holdReload = true;
		const posted: any[] = [];
		let canonicalPolicySnapshot = {
			clusterKeys: [] as string[], globallyBlocked: false, version: 1,
			revocationGenerations: { 'cluster.kusto.windows.net': 0 },
		};
		const connectionManager = connectionManagerStub({
			runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: typeof canonicalPolicySnapshot) => unknown) =>
				await run(canonicalPolicySnapshot),
		});

		try {
			fs.writeFileSync(sourcePath, queryText, 'utf8');
			fs.writeFileSync(sidecarPath, JSON.stringify({ kind: 'kqlx', version: 1, state: persistedState }), 'utf8');
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
				state: any,
				onKustoSanitized?: (before: any, after: any, context: any) => void,
			) => {
				const sanitized = protectedNow ? {
					...state,
					sections: state.sections.map((section: any) => {
						if (section.id !== 'primary_1') return section;
						const {
							resultJson: _resultJson, resultArtifact: _resultArtifact,
							kustoAccountPartition: _partition,
							kustoLeaveNoTraceRevision: _revision,
							selectedResultIndex: _selection, ...clean
						} = section;
						return clean;
					}),
				} : state;
				onKustoSanitized?.(state, sanitized, { snapshot: canonicalPolicySnapshot });
				return sanitized;
			};
			prototype.publishSqlLeaveNoTraceStateFresh = async function (
				this: QueryEditorProvider,
				state: any,
				publish: (sanitizedState: any) => Promise<unknown>,
				onKustoSanitized?: (before: any, after: any, context: any) => void,
			) {
				return publish(await (this as any).sanitizeSqlLeaveNoTraceStateFresh(
					state,
					onKustoSanitized,
				));
			};
			const provider = new (KqlCompatEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManager, sqlWorkbenchStub(),
				undefined, undefined, undefined, undefined, registry,
			) as KqlCompatEditorProvider;
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => queryText, lineCount: 1,
				lineAt: () => ({ text: queryText }), eol: vscode.EndOfLine.LF, isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') latestProjection = message;
						if (!message?.reloadRequestId) return true;
						if (holdReload) { heldReloadRequestId = message.reloadRequestId; return true; }
						await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: Number(message.editRevision || 0),
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				visible: true, onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			const projection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!heldReloadRequestId, 'cold compatibility result should await acknowledgement');
			assert.ok(
				latestProjection.state.sections[0].resultJson,
				`cold compatibility projection lost fixture result: ${JSON.stringify(latestProjection.state)}`,
			);
			const projectionCountWithCandidate = posted.filter(
				message => message?.type === 'documentData' && message.ok === true,
			).length;
			const owner = registry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(owner && !owner.hasCommittedAttachments());
			protectedNow = true;
			canonicalPolicySnapshot = {
				clusterKeys: ['cluster.kusto.windows.net'], globallyBlocked: true, version: 2,
				revocationGenerations: { 'cluster.kusto.windows.net': 1 },
			};
			holdReload = false;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: heldReloadRequestId,
				applied: true, editRevision: Number(latestProjection.editRevision || 0),
			}));
			await projection;
			await waitForCondition(() => {
				const section = latestProjection?.state?.sections?.find((candidate: any) => candidate.id === 'primary_1');
				return section && !section.resultJson;
			}, 'policy conflict retry should project row-free compatibility state');
			assert.strictEqual(
				posted.filter(message => message?.type === 'documentData' && message.ok === true).length,
				projectionCountWithCandidate + 1,
			);
			assert.ok(!(owner!.overlaySnapshot(rowFreeState).sections?.[0] as any).resultJson);
			assert.strictEqual((owner as any).preparedSourceOwnerRevisionByIdentity.size, 0);
		} finally {
			sourceLease.release();
			sourceRegistry.dispose();
			registry.dispose();
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('fresh compatibility sanitation preserves a saved same-source Kusto attachment across policy changes', async function () {
		this.timeout(10_000);
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-kusto-privacy-owner-'));
		const sourcePath = path.join(tmpDir, 'privacy-owner.kql');
		const sidecarPath = `${sourcePath}.json`;
		const queryText = 'print Value=1';
		const documentUri = vscode.Uri.file(sourcePath);
		const resultRegistry = new KustoResultPersistenceRegistry();
		const seedLease = resultRegistry.acquire(normalizeWorkbenchUriKey(documentUri));
		const owner = seedLease.owner;
		const sidecarState = {
			sections: [{
				id: 'primary_1', type: 'query', linkedQueryPath: path.basename(sourcePath),
			}],
		};
		const seedSession = owner.openPanel('compat-privacy-seed-panel');
		seedSession.openSection('primary_1', 'compat-privacy-seed-instance');
		seedSession.adoptTarget({
			boxId: 'primary_1', sectionInstanceId: 'compat-privacy-seed-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		const terminal = {
			type: 'queryResult' as const, engine: 'kusto' as const, boxId: 'primary_1',
			sectionInstanceId: 'compat-privacy-seed-instance', targetGeneration: 1,
			executionId: 'compat-privacy-seed-execution', connectionId: 'connection-1', database: 'Db',
			producer: 'manual' as const, query: queryText, reservationSequence: 1,
			dispatch: {
				dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
				connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
				clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
				accountPartition: 'partition-a', authSessionGeneration: 1,
				clientActivityId: 'compat-privacy-seed',
			},
			result: { columns: ['Value'], rows: [[1]], metadata: {} },
		};
		assert.strictEqual(seedSession.beginExecution(terminal), true);
		assert.ok(seedSession.stagePublication('compat-privacy-seed-publication', terminal));
		assert.strictEqual(seedSession.commitPublication('compat-privacy-seed-publication'), true);
		let protectedNow = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		let canonicalPolicySnapshot = {
			clusterKeys: [] as string[], globallyBlocked: false, version: 0,
			revocationGenerations: {} as Record<string, number>,
		};
		const connectionManager = connectionManagerStub({
			runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: typeof canonicalPolicySnapshot) => unknown) =>
				await run(canonicalPolicySnapshot),
		});

		try {
			fs.writeFileSync(sourcePath, queryText, 'utf8');
			fs.writeFileSync(sidecarPath, JSON.stringify({
				kind: 'kqlx', version: 1, state: owner.overlaySnapshot(sidecarState),
			}), 'utf8');
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
				state: any,
				onKustoSanitized?: (before: any, after: any, context: any) => void,
			) => {
				if (!protectedNow) return state;
				const sanitized = {
					...state,
					sections: state.sections.map((section: any) => {
						if (section.id !== 'primary_1') return section;
						const {
							resultJson: _resultJson,
							resultArtifact: _resultArtifact,
							kustoAccountPartition: _accountPartition,
							kustoLeaveNoTraceRevision: _leaveNoTraceRevision,
							selectedResultIndex: _selectedResultIndex,
							...clean
						} = section;
						return clean;
					}),
				};
				onKustoSanitized?.(state, sanitized, {
					snapshot: canonicalPolicySnapshot,
				});
				return sanitized;
			};
			prototype.publishSqlLeaveNoTraceStateFresh = async function (
				this: QueryEditorProvider,
				state: any,
				publish: (sanitizedState: any) => Promise<unknown>,
				onKustoSanitized?: (before: any, after: any, context: any) => void,
			) {
				return publish(await (this as any).sanitizeSqlLeaveNoTraceStateFresh(
					state,
					onKustoSanitized,
				));
			};
			(vscode.workspace as any).onDidSaveTextDocument = (
				handler: (document: vscode.TextDocument) => unknown,
			) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			const provider = new (KqlCompatEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManager, sqlWorkbenchStub(),
				undefined, undefined, undefined, undefined, resultRegistry,
			) as KqlCompatEditorProvider;
			const document = {
				uri: documentUri, getText: () => queryText, lineCount: 1,
				lineAt: () => ({ text: queryText }), eol: vscode.EndOfLine.LF, isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = handler;
						return { dispose() {} };
					},
				},
				visible: true,
				onDidChangeViewState: () => ({ dispose() {} }),
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			seedLease.release();
			let projection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
			assert.ok(projection?.state?.sections?.[0]?.resultJson);
			protectedNow = true;
			canonicalPolicySnapshot = {
				clusterKeys: ['cluster.kusto.windows.net'], globallyBlocked: true, version: 1,
				revocationGenerations: { 'cluster.kusto.windows.net': 1 },
			};
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			projection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
			assert.ok(projection?.state?.sections?.[0]?.resultJson);
			assert.strictEqual(owner.hasCommittedAttachments(), true);
			assert.ok((owner.overlaySnapshot(sidecarState).sections?.[0] as any).resultJson);

			await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
				type: 'persistDocument', snapshotId: 'compat-privacy-persist',
				sourceGeneration: projection.sourceGeneration, editRevision: 1,
				state: projection.state,
			})));
			assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'compat-privacy-persist'));
			assert.ok(didSaveHandler);
			await Promise.resolve(didSaveHandler!(document));
			assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('resultJson'));
			for (const dispose of disposeHandlers) dispose();
		} finally {
			seedLease.release();
			resultRegistry.dispose();
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('cold open and close preserve saved Kusto attachments under a blocking policy', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cold-policy-preserve-'));
		const dispatch = {
			dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
			connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
			clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
			accountPartition: 'partition-a', authSessionGeneration: 1, clientActivityId: 'cold-policy',
		};
		try {
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
				state: any,
				onKustoSanitized?: (before: any, after: any, context: any) => void,
			) => {
				const rowFree = {
					...state,
					sections: state.sections.map((section: any) => {
						const next = { ...section };
						delete next.resultJson;
						delete next.resultArtifact;
						delete next.kustoAccountPartition;
						delete next.kustoLeaveNoTraceRevision;
						return next;
					}),
				};
				onKustoSanitized?.(state, rowFree, {
					snapshot: {
						clusterKeys: ['cluster.kusto.windows.net'], globallyBlocked: true,
						version: 1, revocationGenerations: { 'cluster.kusto.windows.net': 1 },
					},
				});
				return state;
			};
			for (const variant of ['native', 'companion'] as const) {
				const boxId = variant === 'native' ? 'query_native' : 'compat_primary_query';
				const sourcePath = path.join(tmpDir, variant === 'native' ? 'saved.kqlx' : 'saved.kql');
				const persistedPath = variant === 'native' ? sourcePath : `${sourcePath}.json`;
				const query = 'print Value=1';
				const section = {
					id: boxId, type: 'query',
					...(variant === 'native' ? { query } : { linkedQueryPath: path.basename(sourcePath) }),
					resultJson: JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} }),
					resultArtifact: {
						version: 1, artifactId: `result:${boxId}:1`, sourceBoxId: boxId, revision: 1, createdAt: 1,
						producer: {
							engine: 'kusto', boxId, executionId: 'saved-execution', sectionInstanceId: 'saved-instance',
							targetGeneration: 1, reservationSequence: 1, connectionId: 'connection-1',
							database: 'Db', producer: 'manual', dispatch,
						},
						policy: {
							accountPartition: dispatch.accountPartition, authSessionGeneration: dispatch.authSessionGeneration,
							leaveNoTraceRevision: dispatch.leaveNoTraceRevision, connectionRevision: dispatch.connectionRevision,
							connectionIdentityKey: dispatch.connectionIdentityKey,
							exposeToActiveContent: true, sendToModel: true, shareToClipboard: true, exportToCsv: true,
						},
					},
					kustoAccountPartition: dispatch.accountPartition,
					kustoLeaveNoTraceRevision: dispatch.leaveNoTraceRevision,
				};
				const persistedText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [section] } });
				if (variant === 'companion') fs.writeFileSync(sourcePath, query, 'utf8');
				fs.writeFileSync(persistedPath, persistedText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const disposeHandlers: Array<() => void> = [];
				const provider = variant === 'native'
					? new (KqlxEditorProvider as any)(
						{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-native')) } as any,
						vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					) as KqlxEditorProvider
					: new (KqlCompatEditorProvider as any)(
						{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-companion')) } as any,
						vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					) as KqlCompatEditorProvider;
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => variant === 'native' ? persistedText : query,
					eol: vscode.EndOfLine.LF, lineCount: 1, lineAt: () => ({ text: query }), isDirty: false,
					positionAt: (offset: number) => new vscode.Position(0, offset), save: async () => true,
				} as any;
				const panel = {
					visible: false,
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidChangeViewState: () => ({ dispose() {} }),
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				assert.ok(posted.some(message => message?.type === 'documentData'
					&& message?.state?.sections?.[0]?.resultJson));
				for (const dispose of disposeHandlers) dispose();
				if (variant === 'native') {
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
				} else {
					await new Promise<void>(resolve => setTimeout(resolve, 50));
				}
				assert.strictEqual(fs.readFileSync(persistedPath, 'utf8'), persistedText);
			}
		} finally {
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility close preserves a non-admissible modern result without projecting it', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-incomplete-modern-result-'));
		const sourcePath = path.join(tmpDir, 'saved.kql');
		const sidecarPath = `${sourcePath}.json`;
		const query = 'print Value=1';
		const section = {
			id: 'compat_primary_query', type: 'query', linkedQueryPath: path.basename(sourcePath),
			resultJson: JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} }),
			resultArtifact: {
				version: 1, artifactId: 'result:compat_primary_query:1',
				sourceBoxId: 'compat_primary_query', revision: 1, createdAt: 1,
			},
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		};
		const persistedText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [section] } });
		const resultRegistry = new KustoResultPersistenceRegistry();
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(sourcePath, query, 'utf8');
			fs.writeFileSync(sidecarPath, persistedText, 'utf8');
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const provider = new (KqlCompatEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, undefined, undefined, undefined, resultRegistry,
			) as KqlCompatEditorProvider;
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => query, lineCount: 1,
				lineAt: () => ({ text: query }), eol: vscode.EndOfLine.LF, isDirty: false,
			} as any;
			const panel = {
				visible: true,
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidChangeViewState: () => ({ dispose() {} }),
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const projection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
			assert.ok(projection);
			assert.ok(!projection.state.sections[0]?.resultJson);
			assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), persistedText);
			for (const dispose of disposeHandlers) dispose();
			await waitForCondition(
				() => !resultRegistry.get(normalizeWorkbenchUriKey(document.uri)),
				'Compatibility close should release the result owner after repair',
			);
			assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), persistedText);
		} finally {
			resultRegistry.dispose();
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('native close preserves a non-admissible modern result without projecting it', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-incomplete-modern-result-'));
		const filePath = path.join(tmpDir, 'saved.kqlx');
		const section = {
			id: 'query_native', type: 'query', query: 'print Value=1',
			resultJson: JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} }),
			resultArtifact: {
				version: 1, artifactId: 'result:query_native:1',
				sourceBoxId: 'query_native', revision: 1, createdAt: 1,
			},
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		};
		const persistedText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [section] } });
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, persistedText, 'utf8');
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const projection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
			assert.ok(projection);
			assert.ok(!projection.state.sections[0]?.resultJson);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), persistedText);
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), persistedText);
		} finally {
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rejected compatibility upgrade projection blocks stale active-generation snapshots', async () => {
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query', requestType: 'requestUpgradeToKqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql', requestType: 'requestUpgradeToSqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-upgrade-rejected-'));
		try {
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `upgrade-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const primaryText = variant.primaryType === 'sql' ? 'select initial' : 'print initial = 0';
				fs.writeFileSync(sourcePath, primaryText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let rejectUpgradeProjection = false;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => primaryText, lineCount: 1,
					lineAt: () => ({ text: primaryText }), eol: vscode.EndOfLine.LF, isDirty: false,
					save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type !== 'documentData') return true;
							if (rejectUpgradeProjection) return false;
							if (message.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const activeGeneration = Number(posted.find(message => message?.type === 'documentData')?.sourceGeneration);
				assert.ok(Number.isSafeInteger(activeGeneration));

				rejectUpgradeProjection = true;
				await Promise.resolve(receiveHandler!({
					type: variant.requestType, addKind: 'markdown', editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, query: primaryText },
						{ id: 'markdown_1', type: 'markdown', text: 'UPGRADE' },
					] },
				}));
				assert.ok(fs.existsSync(sidecarPath));
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `stale-upgrade-${index}`,
					sourceGeneration: activeGeneration, editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, query: primaryText },
						{ id: 'markdown_1', type: 'markdown', text: 'STALE' },
					] },
				}));

				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === `stale-upgrade-${index}`));
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('STALE'));

				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId: `newer-upgrade-${index}`,
					sourceGeneration: activeGeneration, editRevision: 2,
					state: { sections: [
						{ id: 'primary_1', type: variant.primaryType, query: primaryText },
						{ id: 'markdown_1', type: 'markdown', text: 'NEWER' },
					] },
				}));
				assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === `newer-upgrade-${index}`));
			}
		} finally {
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('remote linked query hydrates but remains non-writable without local identity', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const scheme = `cod1-remote-${Date.now()}`;
		const notebookUri = vscode.Uri.parse(`${scheme}:/work/notebook.kqlx`);
		const linkedUri = vscode.Uri.parse(`${scheme}:/work/linked.kql`);
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		let bufferText = notebookText;
		let notebookApplyEdits = 0;
		const posted: any[] = [];
		const writes: string[] = [];
		const fileChanges = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
		const registration = vscode.workspace.registerFileSystemProvider(scheme, {
			onDidChangeFile: fileChanges.event,
			watch: () => ({ dispose() {} }),
			stat: async () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 'REMOTE_QUERY'.length }),
			readDirectory: async () => [],
			createDirectory: async () => undefined,
			readFile: async uri => {
				if (uri.toString() === linkedUri.toString()) return new TextEncoder().encode('REMOTE_QUERY');
				if (uri.toString() === notebookUri.toString()) return new TextEncoder().encode(notebookText);
				throw vscode.FileSystemError.FileNotFound(uri);
			},
			writeFile: async (uri, bytes) => {
				writes.push(uri.toString());
				if (uri.toString() === notebookUri.toString()) notebookText = new TextDecoder().decode(bytes);
			},
			delete: async () => undefined,
			rename: async () => undefined,
		}, { isCaseSensitive: true });
		try {
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const entry = edit.entries()[0];
				const replacement = entry?.[1]?.[0]?.newText;
				if (entry?.[0]?.toString() !== notebookUri.toString() || typeof replacement !== 'string') return false;
				notebookApplyEdits++;
				bufferText = replacement;
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(os.tmpdir(), 'kw-remote-link-global')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			const document = {
				uri: notebookUri, getText: () => bufferText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			await provider.resolveCustomTextEditor(document,
				panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const projection = posted.find(message => message?.type === 'documentData' && message.ok === true);
			assert.ok(projection);
			assert.strictEqual(projection.state.sections[0].query, 'REMOTE_QUERY');
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'remote-markdown-patch',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after' },
				},
			}));
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'remote-markdown-patch' && message.ok === true));
			assert.strictEqual(JSON.parse(bufferText).state.sections[1].text, 'after');
			const linkedWritesBeforeMutation = writes.filter(uri => uri === linkedUri.toString()).length;
			const bufferBeforeMutation = bufferText;
			const notebookEditsBeforeMutation = notebookApplyEdits;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'remote-linked-write',
				sourceGeneration: projection.sourceGeneration, editRevision: 1, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'MUST_NOT_WRITE' },
				] },
			}));
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'remote-linked-write'));
			assert.strictEqual(
				writes.filter(uri => uri === linkedUri.toString()).length,
				linkedWritesBeforeMutation,
			);
			assert.strictEqual(bufferText, bufferBeforeMutation, 'denied remote query mutation must not rewrite notebook metadata');
			assert.strictEqual(notebookApplyEdits, notebookEditsBeforeMutation, 'denied remote query mutation must not apply a notebook edit');
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			registration.dispose();
			fileChanges.dispose();
		}
	});

	test('initial projection retries are bounded under continuous source churn', async () => {
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const variants = [
			{ extension: '.kqlx', Provider: KqlxEditorProvider, type: 'query', wrapped: true },
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query', wrapped: false },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql', wrapped: false },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-initial-projection-bounded-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const wrap = (query: string) => variant.wrapped
					? JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
						{ id: 'query_1', type: variant.type, query },
					] } })
					: query;
				let sourceText = wrap(`revision 0`);
				let receiveHandler: ((message: any) => unknown) | undefined;
				let changeHandler: ((event: vscode.TextDocumentChangeEvent) => unknown) | undefined;
				let projectionAttempts = 0;
				let acceptProjection = false;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
					state: any,
					onKustoSanitized?: (before: any, after: any, context: { snapshot: any }) => void,
				) => {
					onKustoSanitized?.(state, state, {
						snapshot: { clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {} },
					});
					return state;
				};
				(vscode.workspace as any).onDidChangeTextDocument = (
					handler: (event: vscode.TextDocumentChangeEvent) => unknown,
				) => {
					changeHandler = handler;
					return { dispose() {} };
				};
				const sourcePath = path.join(tmpDir, `bounded-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, sourceText, 'utf8');
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `bounded-global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const posted: any[] = [];
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type === 'documentData' && message?.ok === true) projectionAttempts++;
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: acceptProjection, editRevision: 0,
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					visible: true,
					onDidDispose: () => ({ dispose() {} }),
					onDidChangeViewState: () => ({ dispose() {} }),
				} as any;
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => sourceText, lineCount: 1,
					lineAt: () => ({ text: sourceText }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				assert.strictEqual(projectionAttempts, 3, `${variant.extension} should exhaust one three-attempt budget`);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				assert.strictEqual(
					projectionAttempts,
					3,
					`${variant.extension} duplicate request must not reset an exhausted source budget`,
				);

				acceptProjection = true;
				sourceText = wrap('revision 4');
				await Promise.resolve(changeHandler?.({ document, contentChanges: [{}] } as any));

				await waitForCondition(
					() => [...posted].reverse().some(message => message?.type === 'documentData' && message.ok === true
						&& message.state?.sections?.[0]?.query === 'revision 4'),
					`${variant.extension} should recover after a subsequent source edit`,
				);
				assert.strictEqual(projectionAttempts, 4, `${variant.extension} should use one fresh recovery attempt`);
				const projection = [...posted].reverse().find(message => message?.type === 'documentData'
					&& message.ok === true && message.state?.sections?.[0]?.query === 'revision 4');
				assert.strictEqual(projection.state.sections[0].query, 'revision 4');
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compat editors drain queued SQL sidecar sanitation before close cleanup', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-close-tail-'));

		try {
			(vscode.window as any).showWarningMessage = async () => 'Discard';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `close-tail-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind,
					version: 1,
					state: { sections: [
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'sql', id: 'sql-secret', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					return {
						...state,
						sections: state.sections.map((section: any) => {
							if (section.type !== 'sql') return section;
							const { result: _result, ...sanitized } = section;
							return sanitized;
						}),
					};
				};

				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const disposeHandlers: Array<() => void> = [];
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'persistDocument', editRevision: 0,
									snapshotId: `close-tail-${index}`, flushRequestId: message.requestId,
									state: { sections: [
										{ type: variant.firstType, query: 'select 1' },
										{ type: 'markdown', text: 'UNSAVED_DRAFT' },
									] },
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('retained'), `${variant.extension} open must preserve saved sidecar results`);
				assert.ok(invalidation.isSubscribed(), `expected ${variant.extension} invalidation subscription`);
				assert.ok(invalidation.isKustoSubscribed(), `expected ${variant.extension} Kusto invalidation subscription`);
				assert.ok(receiveHandler, `expected ${variant.extension} message handler`);
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument',
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'UNSAVED_DRAFT' },
					] },
				}));
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind,
					version: 1,
					state: { sections: [
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'EXTERNAL_COMMITTED' },
						{ type: 'sql', id: 'external-secret', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				}), 'utf8');
				invalidation.fire();
				for (const dispose of disposeHandlers) dispose();
				await waitForCondition(
					() => {
						const text = fs.readFileSync(sidecarPath, 'utf8');
						return invalidation.isDisposed()
							&& text.includes('EXTERNAL_COMMITTED')
							&& text.includes('retained');
					},
					`${variant.extension} close should drain the sanitized queued write`,
				);
				assert.strictEqual(invalidation.isDisposed(), true, `${variant.extension} close should dispose the invalidation subscription`);
				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes('EXTERNAL_COMMITTED'), `${variant.extension} must preserve newer committed sidecar content`);
				assert.ok(!finalText.includes('UNSAVED_DRAFT'), `${variant.extension} Discard must not write unsaved metadata`);
				assert.ok(finalText.includes('retained'), `${variant.extension} must preserve saved sidecar results during cleanup`);
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('privacy repair rebases a dirty compatibility sidecar draft over an external edit before close-time Save', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-save-rebase-'));

		try {
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `save-rebase-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'ORIGINAL' },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				}), 'utf8');

				let protectedNow = false;
				let protectedCalls = 0;
				let latestDraft = 'DRAFT_TO_SAVE';
				let markRepairPaused!: () => void;
				let releaseRepair!: () => void;
				const repairPaused = new Promise<void>(resolve => { markRepairPaused = resolve; });
				const repairGate = new Promise<void>(resolve => { releaseRepair = resolve; });
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (protectedNow && ++protectedCalls === 1) {
						markRepairPaused();
						await repairGate;
					}
					return {
						...state,
						sections: state.sections.map((section: any) => {
							if (!protectedNow || section.type !== 'sql') return section;
							const { result: _result, ...sanitized } = section;
							return sanitized;
						}),
					};
				};

				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const disposeHandlers: Array<() => void> = [];
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.(withProjectedCompatPrimary(posted, {
									type: 'persistDocument', editRevision: 0,
									snapshotId: `save-rebase-${index}`, flushRequestId: message.requestId,
									state: { sections: [
										{ type: variant.firstType, query: 'select 1' },
										{ type: 'markdown', text: latestDraft },
										{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
									] },
								})));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && invalidation.isSubscribed());
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument',
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'DRAFT_TO_SAVE' },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				})));
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, futureRoot: 'EXTERNAL_COMMITTED',
					state: { sections: [
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'ORIGINAL' },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				}), 'utf8');
				protectedNow = true;
				invalidation.fire();
				await repairPaused;
				latestDraft = 'LATEST_QUEUED_DRAFT';
				const newerPersist = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: latestDraft },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				})));
				releaseRepair();
				await newerPersist;
				for (const dispose of disposeHandlers) dispose();
				await waitForCondition(
					() => fs.readFileSync(sidecarPath, 'utf8').includes(latestDraft),
					`${variant.extension} close should save the rebased draft`,
				);

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.strictEqual(invalidation.isDisposed(), true, `${variant.extension} close should dispose the invalidation subscription`);
				assert.ok(finalText.includes(latestDraft), `${variant.extension} should save the rebased draft`);
				assert.ok(finalText.includes('EXTERNAL_COMMITTED'), `${variant.extension} should preserve the external edit`);
				assert.ok(finalText.includes('retained'), `${variant.extension} should preserve the saved SQL payload`);
				assert.ok(!fs.readdirSync(tmpDir).some(name => name.startsWith(path.basename(sidecarPath) + '.recovery-')),
					`${variant.extension} should not need conflict recovery for its own privacy repair`);
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('privacy repair recovers instead of overwriting a concurrent known sidecar edit', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-known-conflict-'));

		try {
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `known-conflict-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const initialState = { sections: [
					{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
					{ id: 'markdown_local', type: 'markdown', text: 'LOCAL_ORIGINAL' },
					{ id: 'markdown_external', type: 'markdown', text: 'EXTERNAL_ORIGINAL' },
					{ id: 'sql-sensitive', type: 'sql', result: { columns: ['secret'], rows: [['retained']] } },
				] };
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: initialState,
				}), 'utf8');

				let protectedNow = false;
				let markRepairEntered!: () => void;
				let releaseRepair!: () => void;
				const repairEntered = new Promise<void>(resolve => { markRepairEntered = resolve; });
				const repairGate = new Promise<void>(resolve => { releaseRepair = resolve; });
				let protectedCalls = 0;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (protectedNow && ++protectedCalls === 1) {
						markRepairEntered();
						await repairGate;
					}
					return {
						...state,
						sections: state.sections.map((section: any) => {
							if (!protectedNow || section.type !== 'sql') return section;
							const { result: _result, ...sanitized } = section;
							return sanitized;
						}),
					};
				};
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				let localState: any;
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const disposeHandlers: Array<() => void> = [];
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.(withProjectedCompatPrimary(posted, {
									type: 'persistDocument', editRevision: 1,
									snapshotId: `known-conflict-${index}`, flushRequestId: message.requestId,
									state: localState,
								})));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const projection = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1);
				assert.ok(projection);
				localState = structuredClone(projection.state);
				localState.sections.find((section: any) => section.id === 'markdown_local').text = 'LOCAL_DRAFT';
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 1, state: localState,
				})));
				const externalState = structuredClone(initialState);
				const externalSection = externalState.sections.find(section => section.id === 'markdown_external');
				if (!externalSection) throw new Error('External fixture section was not created.');
				externalSection.text = 'EXTERNAL_EDIT';
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: externalState,
				}), 'utf8');
				protectedNow = true;
				invalidation.fire();
				await repairEntered;
				releaseRepair();
				for (const dispose of disposeHandlers) dispose();
				await waitForCondition(
					() => fs.readdirSync(tmpDir).some(name => name.startsWith(path.basename(sidecarPath) + '.recovery-')),
					`${variant.extension} should recover the local draft after a concurrent known-field edit`,
				);
				const durableText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(durableText.includes('EXTERNAL_EDIT'), `${variant.extension} must preserve the external known-field edit`);
				assert.ok(!durableText.includes('LOCAL_DRAFT'), `${variant.extension} must not silently overwrite the external sidecar`);
				const recoveryName = fs.readdirSync(tmpDir)
					.find(name => name.startsWith(path.basename(sidecarPath) + '.recovery-'))!;
				assert.ok(fs.readFileSync(path.join(tmpDir, recoveryName), 'utf8').includes('LOCAL_DRAFT'));
				fs.rmSync(path.join(tmpDir, recoveryName), { force: true });
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility invalidation does not overwrite a newer external sidecar', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-external-race-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `external-race-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const variantMarker = `${path.basename(tmpDir)}-${index}`;
				const baselineMarker = `BASELINE_A_${variantMarker}`;
				const externalMarker = `EXTERNAL_B_${variantMarker}`;
				const sidecar = (marker: string) => JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: marker },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				});
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, sidecar(baselineMarker), 'utf8');
				const posted: any[] = [];

				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false,
				} as any;
				let receiveHandler: ((message: any) => unknown) | undefined;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				fs.writeFileSync(sidecarPath, sidecar(externalMarker), 'utf8');
				invalidation.fire();
				await new Promise<void>(resolve => setImmediate(resolve));

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes(externalMarker), `${variant.extension} repair must preserve the newer external commit`);
				assert.ok(!finalText.includes(baselineMarker), `${variant.extension} repair must not republish its stale baseline`);
				assert.ok(finalText.includes('retained'), `${variant.extension} reconciliation must preserve saved results`);
			}
		} finally {
			invalidation.restore();
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('initial companion creation preserves an external sidecar that appears during sanitation', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, requestType: 'requestUpgradeToKqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, requestType: 'requestUpgradeToSqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-create-race-'));

		try {
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errors.push(String(message)); return undefined; };
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `create-race-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const externalText = `EXTERNAL_B_${variant.extension}`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				let pauseCreation = false;
				let markPaused!: () => void;
				let release!: () => void;
				const sanitationPaused = new Promise<void>(resolve => { markPaused = resolve; });
				const sanitationGate = new Promise<void>(resolve => { release = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (pauseCreation) {
						pauseCreation = false;
						markPaused();
						await sanitationGate;
					}
					return state;
				};

				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				let receiveHandler: ((message: any) => unknown) | undefined;
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler);
				pauseCreation = true;
				const upgrade = Promise.resolve(receiveHandler!({ type: variant.requestType, addKind: 'markdown', editRevision: 0 }));
				await sanitationPaused;
				fs.writeFileSync(sidecarPath, externalText, 'utf8');
				release();
				await upgrade;

				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), externalText, `${variant.extension} must preserve the external sidecar`);
				assert.ok(
					errors.some(message => message.includes('changed while it was being created')),
					`${variant.extension} unexpected companion creation errors: ${JSON.stringify(errors)}`,
				);
				errors.length = 0;
			}
		} finally {
			restorePublisher();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compat editor disposal waits for an active companion upgrade', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const originalDrain = CompatSidecarStore.prototype.drain;
		const originalSettleClose = CompatSidecarSession.prototype.settleClose;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, requestType: 'requestUpgradeToKqlx', firstType: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, requestType: 'requestUpgradeToSqlx', firstType: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-close-upgrade-'));

		try {
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `close-upgrade-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				let markPaused!: () => void;
				let release!: () => void;
				const sanitationPaused = new Promise<void>(resolve => { markPaused = resolve; });
				const sanitationGate = new Promise<void>(resolve => { release = resolve; });
				let pauseUpgrade = false;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (pauseUpgrade) {
						pauseUpgrade = false;
						markPaused();
						await sanitationGate;
					}
					return state;
				};
				let drainStarted = false;
				let closeSettled = false;
				CompatSidecarStore.prototype.drain = async function () {
					drainStarted = true;
					await originalDrain.call(this);
				};
				CompatSidecarSession.prototype.settleClose = function () {
					originalSettleClose.call(this);
					closeSettled = true;
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					visible: false,
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler);
				pauseUpgrade = true;
				const upgrade = Promise.resolve(receiveHandler!({
					type: variant.requestType, addKind: 'markdown', editRevision: 1,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'UPGRADE_IN_PROGRESS' },
					] },
				}));
				await sanitationPaused;
				for (const dispose of disposeHandlers) dispose();
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(drainStarted, false, `${variant.extension} close must wait for the active upgrade`);

				release();
				await upgrade;
				await waitForCondition(() => drainStarted, `${variant.extension} close should drain after the upgrade finishes`);
				await waitForCondition(() => closeSettled, `${variant.extension} close should settle before the next case`);
				await new Promise<void>(resolve => setImmediate(resolve));
				CompatSidecarStore.prototype.drain = originalDrain;
				CompatSidecarSession.prototype.settleClose = originalSettleClose;
			}
		} finally {
			restorePublisher();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			CompatSidecarStore.prototype.drain = originalDrain;
			CompatSidecarSession.prototype.settleClose = originalSettleClose;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('a newer snapshot arriving during companion upgrade is serialized and wins on Save', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, requestType: 'requestUpgradeToKqlx', firstType: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, requestType: 'requestUpgradeToSqlx', firstType: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-upgrade-revision-'));

		try {
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `upgrade-revision-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				let markPaused!: () => void;
				let release!: () => void;
				const paused = new Promise<void>(resolve => { markPaused = resolve; });
				const gate = new Promise<void>(resolve => { release = resolve; });
				let didPause = false;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (!didPause && JSON.stringify(state).includes('UPGRADE_REVISION_1')) {
						didPause = true;
						markPaused();
						await gate;
					}
					return state;
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								const isUpgradeProjection = Number.isSafeInteger(Number(message.expectedEditRevision));
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: !isUpgradeProjection, editRevision: isUpgradeProjection ? 2 : 0,
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const activeSourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true).at(-1)?.sourceGeneration;
				assert.ok(Number.isSafeInteger(activeSourceGeneration));
				const upgrade = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: variant.requestType, addKind: 'markdown', editRevision: 1,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'UPGRADE_REVISION_1' },
					] },
				})));
				await paused;
				const bootstrap = getCompatibilityPersistenceTestBootstrap(panel);
				assert.ok(bootstrap);
				const revisionTwoMessage = {
					...bootstrap,
					type: 'persistDocument', sourceGeneration: activeSourceGeneration, editRevision: 2,
					snapshotId: `upgrade-revision-2-${index}`,
					state: { sections: [
						{ id: variant.firstType === 'query' ? 'compat_primary_query' : 'compat_primary_sql', type: variant.firstType, query: 'select 1' },
						{ id: 'compat_2_markdown', type: 'markdown', text: 'PERSIST_REVISION_2' },
					] },
				};
				const parsedRevisionTwo = parseCompatibilityPersistenceWebviewMessage(
					revisionTwoMessage,
					variant.firstType === 'query' ? 'kql' : 'sql',
				);
				assert.ok(parsedRevisionTwo.ok, parsedRevisionTwo.ok ? undefined : parsedRevisionTwo.error);
				const newerPersist = Promise.resolve(receiveHandler!(revisionTwoMessage));
				release();
				await Promise.all([upgrade, newerPersist]);
				assert.ok(posted.some(message => message?.type === 'documentData'
					&& message.expectedEditRevision === 1), `${variant.extension} upgrade reload must remain bound to revision 1`);
				assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
					&& message.editRevision === 2), `${variant.extension} revision 2 persist must acknowledge exactly once`);
				await Promise.resolve(saveHandler!(document));

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes('PERSIST_REVISION_2'));
				assert.ok(!finalText.includes('UPGRADE_REVISION_1'));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('queued multi-section snapshots reject when companion creation is cancelled or fails', async () => {
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, requestType: 'requestUpgradeToKqlx',
				primaryType: 'query', primaryId: 'compat_primary_query', enableMethod: 'enableSidecarKqlxForCompat',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, requestType: 'requestUpgradeToSqlx',
				primaryType: 'sql', primaryId: 'compat_primary_sql', enableMethod: 'enableSidecarForSqlCompat',
			},
		] as const;
		const outcomes = ['cancelled', 'failed'] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-upgrade-failure-'));

		try {
			for (const [variantIndex, variant] of variants.entries()) {
				for (const [outcomeIndex, outcome] of outcomes.entries()) {
					let markUpgradeBlocked!: () => void;
					let releaseUpgrade!: () => void;
					const upgradeBlocked = new Promise<void>(resolve => { markUpgradeBlocked = resolve; });
					const upgradeGate = new Promise<void>(resolve => { releaseUpgrade = resolve; });
					const prototype = (variant.Provider as any).prototype;
					const originalEnable = prototype[variant.enableMethod];
					if (outcome === 'cancelled') {
						(vscode.window as any).showInformationMessage = async () => {
							markUpgradeBlocked();
							await upgradeGate;
							return undefined;
						};
					} else {
						(vscode.window as any).showInformationMessage = async () => 'Create companion file';
						prototype[variant.enableMethod] = async () => {
							markUpgradeBlocked();
							await upgradeGate;
							return undefined;
						};
					}

					const sourcePath = path.join(tmpDir, `upgrade-${variantIndex}-${outcomeIndex}${variant.extension}`);
					const sidecarPath = `${sourcePath}.json`;
					fs.writeFileSync(sourcePath, 'select 1', 'utf8');
					let receiveHandler: ((message: any) => unknown) | undefined;
					const posted: any[] = [];
					const provider = new (variant.Provider as any)(
						{
							subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
							globalState: { get: () => undefined, update: async () => undefined },
							globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${variantIndex}-${outcomeIndex}`)),
						} as any,
						vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					);
					const document = {
						uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
						lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
					} as any;
					const panel = {
						visible: true,
						webview: {
							options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
							onDidReceiveMessage: (handler: (message: any) => unknown) => {
								receiveHandler = handler;
								return { dispose() {} };
							},
						},
						onDidChangeViewState: () => ({ dispose() {} }),
						onDidDispose: () => ({ dispose() {} }),
					} as any;

					try {
						await provider.resolveCustomTextEditor(document, panel, {} as any);
						await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
						const projection = posted.filter(message => message?.type === 'documentData' && message?.ok === true).at(-1);
						const bootstrap = getCompatibilityPersistenceTestBootstrap(panel);
						assert.ok(projection && bootstrap);
						const upgrade = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
							type: variant.requestType, addKind: 'markdown', editRevision: 1,
							state: { sections: [
								{ type: variant.primaryType, query: 'select 1' },
								{ type: 'markdown', text: 'UPGRADE_PENDING' },
							] },
						})));
						await upgradeBlocked;
						const rejectedSnapshotId = `failed-upgrade-${variantIndex}-${outcomeIndex}`;
						const queuedSnapshot = Promise.resolve(receiveHandler!({
							...bootstrap,
							type: 'persistDocument', sourceGeneration: projection.sourceGeneration,
							editRevision: 2, snapshotId: rejectedSnapshotId,
							state: { sections: [
								{ id: variant.primaryId, type: variant.primaryType, query: 'select 1' },
								{ id: 'compat_2_markdown', type: 'markdown', text: 'MUST_NOT_ADMIT' },
							] },
						}));
						releaseUpgrade();
						await Promise.all([upgrade, queuedSnapshot]);

						assert.strictEqual(fs.existsSync(sidecarPath), false);
						assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
							&& message.snapshotId === rejectedSnapshotId));
						const validSnapshotId = `plain-after-upgrade-${variantIndex}-${outcomeIndex}`;
						await Promise.resolve(receiveHandler!({
							...bootstrap,
							type: 'persistDocument', sourceGeneration: projection.sourceGeneration,
							editRevision: 1, snapshotId: validSnapshotId,
							state: { sections: [
								{ id: variant.primaryId, type: variant.primaryType, query: 'select 1' },
							] },
						}));
						assert.strictEqual(posted.filter(message => message?.type === 'persistDocumentAck'
							&& message.snapshotId === validSnapshotId).length, 1);
					} finally {
						prototype[variant.enableMethod] = originalEnable;
					}
				}
			}
		} finally {
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('dirty companion upgrade does not recursively save while holding the upgrade barrier', async () => {
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, requestType: 'requestUpgradeToKqlx', firstType: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, requestType: 'requestUpgradeToSqlx', firstType: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-dirty-upgrade-'));

		try {
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `dirty-upgrade-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveCalls = 0;
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select changed', lineCount: 1,
					lineAt: () => ({ text: 'select changed' }), isDirty: true,
					save: async () => { saveCalls += 1; return true; },
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler);
				await Promise.resolve(receiveHandler!({
					type: variant.requestType, addKind: 'markdown', editRevision: 1,
					state: { sections: [{ type: variant.firstType, query: 'select changed' }] },
				}));

				assert.strictEqual(saveCalls, 0, `${variant.extension} upgrade must not call document.save()`);
				assert.ok(fs.existsSync(`${sourcePath}.json`));
			}
		} finally {
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('late linked sidecar adoption records an exact baseline and rejects a newer external edit', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalShowInformationMessage = vscode.window.showInformationMessage;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, requestType: 'requestUpgradeToKqlx', firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, requestType: 'requestUpgradeToSqlx', firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-late-adoption-'));

		try {
			(vscode.window as any).showInformationMessage = async () => 'Create companion file';
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errors.push(String(message)); return undefined; };
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => ({
				...state,
				sections: state.sections.map((section: any) => {
					const { result: _result, resultJson: _resultJson, ...sanitized } = section;
					return sanitized;
				}),
			});
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `late-adoption-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				const sidecar = (marker: string, includeSecret = false) => JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: marker },
						...(includeSecret ? [{ type: 'sql', id: 'sql-sensitive', resultJson: 'RETAINED_SECRET' }] : []),
					] },
				});

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler);
				fs.writeFileSync(sidecarPath, sidecar('ADOPTED_BASELINE', true), 'utf8');
				await Promise.resolve(receiveHandler!({ type: variant.requestType, addKind: 'markdown', editRevision: 0 }));
				const adoptedText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(adoptedText.includes('ADOPTED_BASELINE'));
				assert.ok(adoptedText.includes('RETAINED_SECRET'), `${variant.extension} adoption must preserve saved payloads`);

				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument',
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'LOCAL_DRAFT' },
					] },
				})));
				const externalText = sidecar('EXTERNAL_NEWER');
				fs.writeFileSync(sidecarPath, externalText, 'utf8');
				await Promise.resolve(saveHandler!(document));

				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), externalText, `${variant.extension} must preserve the newer external edit`);
				assert.ok(errors.some(message => message.includes('changed in another window')), `${variant.extension} must report the external edit conflict`);
				errors.length = 0;
			}
		} finally {
			restorePublisher();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showInformationMessage = originalShowInformationMessage;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('sidecar enable handoff retains the lock-verified physical identity', async () => {
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, requestType: 'requestUpgradeToKqlx',
				enableMethod: 'enableSidecarKqlxForCompat', firstType: 'query', kind: 'kqlx',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, requestType: 'requestUpgradeToSqlx',
				enableMethod: 'enableSidecarForSqlCompat', firstType: 'sql', kind: 'sqlx',
			},
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-enable-identity-'));

		try {
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => {
				errors.push(String(message));
				return undefined;
			};
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `enable-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const displacedPath = `${sidecarPath}.accepted`;
				const sidecarFile = {
					kind: variant.kind, version: 1, state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				} as any;
				const sidecarText = stringifyKqlxFile(sidecarFile);
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				(provider as any)[variant.enableMethod] = async () => {
					fs.writeFileSync(sidecarPath, sidecarText, 'utf8');
					const accepted = await readCompatSidecarSnapshot(vscode.Uri.file(sidecarPath));
					fs.renameSync(sidecarPath, displacedPath);
					fs.writeFileSync(sidecarPath, sidecarText, 'utf8');
					return {
						uri: vscode.Uri.file(sidecarPath), file: sidecarFile, text: sidecarText,
						identity: accepted.identity,
					};
				};
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({
					type: variant.requestType, addKind: 'markdown', editRevision: 0,
					state: { sections: [{ id: 'primary_1', type: variant.firstType, query: 'select 1' }] },
				}));
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1, state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'LOCAL_EDIT' },
					] },
				}));
				await Promise.resolve(saveHandler!(document));

				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), sidecarText);
				assert.strictEqual(fs.readFileSync(displacedPath, 'utf8'), sidecarText);
				assert.ok(errors.some(message => /physical identity/i.test(message)), `${variant.extension} must report an identity conflict`);
				errors.length = 0;
			}
		} finally {
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('clean sidecar repair adopts external state before the next local Save', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-clean-repair-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => ({
				...state,
				sections: state.sections.map((section: any) => {
					const { result: _result, resultJson: _resultJson, ...sanitized } = section;
					return sanitized;
				}),
			});
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `clean-repair-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const sidecar = (marker: string, includeSecret = false) => JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: marker },
						...(includeSecret ? [{ type: 'sql', id: 'sql-sensitive', resultJson: 'RETAINED_SECRET' }] : []),
					] },
				});
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, sidecar('ORIGINAL'), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler && invalidation.isSubscribed());
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				fs.writeFileSync(sidecarPath, sidecar('EXTERNAL_CLEAN', true), 'utf8');
				invalidation.fire();
				await waitForCondition(
					() => JSON.stringify(posted.filter(message => message?.type === 'documentData').at(-1)?.state || {})
						.includes('EXTERNAL_CLEAN'),
					`${variant.extension} must reload repaired external state`,
				);
				const reloaded = posted.filter(message => message?.type === 'documentData').at(-1);
				assert.ok(JSON.stringify(reloaded?.state || {}).includes('EXTERNAL_CLEAN'), `${variant.extension} must reload repaired external state`);
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('RETAINED_SECRET'));

				const localState = structuredClone(reloaded.state);
				const markdown = localState.sections.find((section: any) => section.type === 'markdown');
				markdown.text = 'EXTERNAL_CLEAN + LOCAL_EDIT';
				await Promise.resolve(receiveHandler!({ type: 'persistDocument', state: localState }));
				await Promise.resolve(saveHandler!(document));

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes('EXTERNAL_CLEAN + LOCAL_EDIT'), `${variant.extension} must persist the local edit on the repaired baseline`);
				assert.ok(!finalText.includes('ORIGINAL'));
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('repair does not reload over a local edit revision that precedes debounced persistence', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-edit-revision-race-'));

		try {
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errors.push(String(message)); return undefined; };
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `edit-race-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const sidecar = (marker: string, includeSecret = false) => JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: marker },
						...(includeSecret ? [{ type: 'sql', id: 'sql-sensitive', resultJson: 'RETAINED_SECRET' }] : []),
					] },
				});
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, sidecar('BASELINE', true), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				let protectedNow = false;
				let protectedCalls = 0;
				let markRepairPaused!: () => void;
				let releaseRepair!: () => void;
				const repairPaused = new Promise<void>(resolve => { markRepairPaused = resolve; });
				const repairGate = new Promise<void>(resolve => { releaseRepair = resolve; });
				const posted: any[] = [];
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (protectedNow) protectedCalls += 1;
					if (protectedNow && protectedCalls === 1) {
						markRepairPaused();
						await repairGate;
					}
					return {
						...state,
						sections: state.sections.map((section: any) => {
							const { resultJson: _resultJson, ...sanitized } = section;
							return sanitized;
						}),
					};
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler && invalidation.isSubscribed());
				protectedNow = true;
				invalidation.fire();
				await repairPaused;
				const localPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'LOCAL_UNSAVED' },
					] },
				}));
				releaseRepair();
				await localPersist;
				assert.ok(!posted.some(message => message?.reloadRequestId), `${variant.extension} repair must not reload over revision 1`);
				await Promise.resolve(saveHandler!(document));
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('LOCAL_UNSAVED'));
				errors.length = 0;
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('edit revision before repair prevents old host state from being reloaded', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-edit-before-repair-'));

		try {
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errors.push(String(message)); return undefined; };
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => ({
				...state,
				sections: state.sections.map((section: any) => {
					const { resultJson: _resultJson, ...sanitized } = section;
					return sanitized;
				}),
			});
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `edit-before-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
						{ type: 'sql', id: 'sql-sensitive', resultJson: 'RETAINED_SECRET' },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler && invalidation.isSubscribed());
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'LOCAL_EDIT' },
					] },
				}));
				invalidation.fire();
				for (let attempt = 0; attempt < 50 && fs.readFileSync(sidecarPath, 'utf8').includes('RETAINED_SECRET'); attempt += 1) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
				assert.ok(!posted.some(message => message?.reloadRequestId), `${variant.extension} old state must not reload at revision 1`);

				await Promise.resolve(saveHandler!(document));
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('LOCAL_EDIT'));
				errors.length = 0;
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('persist sanitation completion is dropped after a newer edit revision', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-stale-persist-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `stale-persist-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				const baseline = JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				});
				fs.writeFileSync(sidecarPath, baseline, 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				let markPaused!: () => void;
				let release!: () => void;
				const paused = new Promise<void>(resolve => { markPaused = resolve; });
				const gate = new Promise<void>(resolve => { release = resolve; });
				let pause = false;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (pause) {
						pause = false;
						markPaused();
						await gate;
					}
					return state;
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler);
				pause = true;
				const persist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'STALE_REVISION_1' },
					] },
				}));
				await paused;
				const currentPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 2,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'CURRENT_REVISION_2' },
					] },
				}));
				release();
				await Promise.all([persist, currentPersist]);
				await Promise.resolve(saveHandler!(document));

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes('CURRENT_REVISION_2'));
				assert.ok(!finalText.includes('STALE_REVISION_1'));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('newer persist wins when an older revision pauses in second sanitation', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-overlapping-persist-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `overlap-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				let revisionOneCalls = 0;
				let markSecondSanitation!: () => void;
				let releaseSecondSanitation!: () => void;
				const secondSanitation = new Promise<void>(resolve => { markSecondSanitation = resolve; });
				const secondSanitationGate = new Promise<void>(resolve => { releaseSecondSanitation = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (JSON.stringify(state).includes('REVISION_ONE')) {
						revisionOneCalls += 1;
						if (revisionOneCalls === 2) {
							markSecondSanitation();
							await secondSanitationGate;
						}
					}
					return state;
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async () => true,
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler);
				const persistOne = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'REVISION_ONE' },
					] },
				}));
				await secondSanitation;
				const persistTwo = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 2,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'REVISION_TWO' },
					] },
				}));
				releaseSecondSanitation();
				await Promise.all([persistOne, persistTwo]);
				await Promise.resolve(saveHandler!(document));

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes('REVISION_TWO'));
				assert.ok(!finalText.includes('REVISION_ONE'));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Save and disposal join queued sidecar persists before selecting the revision to write', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const modes = ['save', 'dispose'] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-lifecycle-queue-'));

		try {
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const mode of modes) {
				for (const [index, variant] of variants.entries()) {
					const sourcePath = path.join(tmpDir, `${mode}-${index}${variant.extension}`);
					const sidecarPath = `${sourcePath}.json`;
					fs.writeFileSync(sourcePath, 'select 1', 'utf8');
					fs.writeFileSync(sidecarPath, JSON.stringify({
						kind: variant.kind, version: 1,
						state: { sections: [
							{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
							{ type: 'markdown', text: 'BASELINE' },
						] },
					}), 'utf8');

					let receiveHandler: ((message: any) => unknown) | undefined;
					let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
					const disposeHandlers: Array<() => void> = [];
					let revisionOneCalls = 0;
					let markPaused!: () => void;
					let release!: () => void;
					const paused = new Promise<void>(resolve => { markPaused = resolve; });
					const gate = new Promise<void>(resolve => { release = resolve; });
					(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
						state: any,
						onKustoSanitized?: (before: any, after: any, context: { snapshot: any }) => void,
					) => {
						onKustoSanitized?.(state, state, {
							snapshot: { clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {} },
						});
						if (JSON.stringify(state).includes('REVISION_ONE')) {
							revisionOneCalls += 1;
							if (revisionOneCalls === 2) {
								markPaused();
								await gate;
							}
						}
						return state;
					};
					(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
						saveHandler = handler;
						return { dispose() {} };
					};
					const provider = new (variant.Provider as any)(
						{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
						vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					);
					const document = {
						uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
						lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
					} as any;
					const panel = {
						webview: {
							options: {}, postMessage: async (message: any) => {
								if (message?.type === 'requestFinalPersist') {
									void Promise.resolve().then(() => receiveHandler?.({
										type: 'persistDocument', editRevision: 2,
										snapshotId: `lifecycle-${mode}-${index}`, flushRequestId: message.requestId,
										state: { sections: [
											{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
											{ type: 'markdown', text: 'REVISION_TWO' },
										] },
									}));
								}
								return true;
							},
							onDidReceiveMessage: (handler: (message: any) => unknown) => {
								receiveHandler = handler;
								return { dispose() {} };
							},
						},
						onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
					} as any;

					await provider.resolveCustomTextEditor(document, panel, {} as any);
					assert.ok(receiveHandler && saveHandler);
					const persistOne = Promise.resolve(receiveHandler!({
						type: 'persistDocument', editRevision: 1,
						state: { sections: [
							{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
							{ type: 'markdown', text: 'REVISION_ONE' },
						] },
					}));
					await paused;
					const persistTwo = Promise.resolve(receiveHandler!({
						type: 'persistDocument', editRevision: 2,
						state: { sections: [
							{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
							{ type: 'markdown', text: 'REVISION_TWO' },
						] },
					}));
					let lifecycle: Promise<unknown>;
					if (mode === 'save') {
						lifecycle = Promise.resolve(saveHandler!(document));
					} else {
						for (const dispose of disposeHandlers) dispose();
						lifecycle = waitForCondition(
							() => invalidation.isDisposed(),
							`${variant.extension} disposal must drain and clean up`,
						);
					}
					release();
					await Promise.all([persistOne, persistTwo, lifecycle]);
					if (mode === 'dispose') {
						await waitForCondition(
							() => fs.readFileSync(sidecarPath, 'utf8').includes('REVISION_TWO'),
							`${variant.extension} disposal must publish revision 2 before assertion`,
						);
					}

					const finalText = fs.readFileSync(sidecarPath, 'utf8');
					assert.ok(finalText.includes('REVISION_TWO'), `${mode} ${variant.extension} must persist revision 2`);
					assert.ok(!finalText.includes('REVISION_ONE'), `${mode} ${variant.extension} must not persist revision 1`);
				}
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			invalidation.restore();
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Save waits for the current compatibility snapshot before committing', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-will-save-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `will-save-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				let markerCalls = 0;
				let markPaused!: () => void;
				let release!: () => void;
				const paused = new Promise<void>(resolve => { markPaused = resolve; });
				const gate = new Promise<void>(resolve => { release = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (JSON.stringify(state).includes('QUEUED_SAVE')) {
						markerCalls += 1;
						if (markerCalls === 2) {
							markPaused();
							await gate;
						}
					}
					return state;
				};
				(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'persistDocument', editRevision: 1,
									snapshotId: 'save-final-snapshot', flushRequestId: message.requestId,
									state: { sections: [
										{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
										{ type: 'markdown', text: 'QUEUED_SAVE' },
									] },
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && willSaveHandler && saveHandler);
				const persist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'QUEUED_SAVE' },
					] },
				}));
				await paused;
				let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
				} as any);
				assert.ok(saveBarrier);
				let barrierResolved = false;
				void saveBarrier!.then(() => { barrierResolved = true; });
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(barrierResolved, false, `${variant.extension} Save must wait for the snapshot`);

				release();
				await Promise.all([persist, saveBarrier!]);
				await Promise.resolve(saveHandler!(document));
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('QUEUED_SAVE'));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('ordinary Save rejects a separately open dirty companion sidecar', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-dirty-open-save-'));
		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `dirty-open-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const baseline = JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				});
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, baseline, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
				(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'persistDocument', editRevision: 0,
									snapshotId: `dirty-open-${index}`, flushRequestId: message.requestId,
									state: { sections: [
										{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
										{ id: 'markdown_1', type: 'markdown', text: 'LOCAL_DRAFT' },
									] },
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && willSaveHandler);
				const dirtySidecar = await vscode.workspace.openTextDocument(vscode.Uri.file(sidecarPath));
				const dirtyEdit = new vscode.WorkspaceEdit();
				dirtyEdit.insert(dirtySidecar.uri, dirtySidecar.positionAt(0), ' ');
				assert.strictEqual(await vscode.workspace.applyEdit(dirtyEdit), true);
				assert.strictEqual(dirtySidecar.isDirty, true);
				let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
				} as any);
				assert.ok(saveBarrier);
				await assert.rejects(saveBarrier!, /companion metadata editor has unsaved changes/i);
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), baseline);
				await vscode.window.showTextDocument(dirtySidecar, { preview: false });
				const restoreEdit = new vscode.WorkspaceEdit();
				restoreEdit.delete(dirtySidecar.uri, new vscode.Range(dirtySidecar.positionAt(0), dirtySidecar.positionAt(1)));
				assert.strictEqual(await vscode.workspace.applyEdit(restoreEdit), true);
				assert.strictEqual(await dirtySidecar.save(), true);
				const sidecarTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
					const input = tab.input as { uri?: vscode.Uri };
					return input.uri?.toString() === dirtySidecar.uri.toString();
				});
				if (sidecarTabs.length > 0) await vscode.window.tabGroups.close(sidecarTabs);
			}
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Save fails visibly when the final compatibility snapshot cannot be delivered', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider },
			{ extension: '.sql', Provider: SqlCompatEditorProvider },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-save-delivery-failure-'));

		try {
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errors.push(String(message)); return undefined; };
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `save-failure-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
				(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => message?.type !== 'requestFinalPersist',
						onDidReceiveMessage: () => ({ dispose() {} }),
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(willSaveHandler);
				let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
				} as any);
				assert.ok(saveBarrier);
				await assert.rejects(saveBarrier!, /final .* metadata snapshot request was not delivered/i);
				assert.ok(errors.some(message => message.includes('snapshot request was not delivered')));
				errors.length = 0;
			}
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Save continues primary text when compatibility metadata is unavailable during restore', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider },
			{ extension: '.sql', Provider: SqlCompatEditorProvider },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-save-restore-'));

		try {
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errors.push(String(message)); return undefined; };
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `save-restore-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
				let pendingProjection: any;
				(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => {
							if (message?.type === 'documentData') pendingProjection = message;
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'persistDocument', state: { sections: [] },
									flushRequestId: message.requestId,
									flushUnavailableReason: 'restore-in-progress',
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(willSaveHandler && receiveHandler);
				const initialProjection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await waitForCondition(() => !!pendingProjection, `${variant.extension} initial projection was not posted`);
				let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
				} as any);

				await assert.doesNotReject(saveBarrier!);
				assert.deepStrictEqual(await saveBarrier!, []);
				assert.deepStrictEqual(errors, []);
				await Promise.resolve(receiveHandler!({
					type: 'documentReloadResult', requestId: pendingProjection.reloadRequestId,
					applied: true, editRevision: Number(pendingProjection.editRevision || 0),
				}));
				await initialProjection;
			}
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('E2E persistence suppression is identical for plain KQL and SQL editors', async () => {
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-e2e-suppression-'));
		const previousSuppression = process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE;

		try {
			process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE = '1';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `suppressed-${index}${variant.extension}`);
				const originalText = variant.extension === '.sql' ? 'SELECT 1' : 'print value=1';
				fs.writeFileSync(sourcePath, originalText, 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				const context = {
					extensionMode: vscode.ExtensionMode.Development,
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
				} as any;
				const provider = new (variant.Provider as any)(
					context, vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => originalText, lineCount: 1,
					lineAt: () => ({ text: originalText }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const documentData = posted.find(message => message?.type === 'documentData');
				assert.strictEqual(documentData?.suppressPersistenceForTest, true,
					`${variant.extension}: extensionMode=${context.extensionMode}; production=${vscode.ExtensionMode.Production}; env=${process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE}; posted=${JSON.stringify(posted.map(message => ({ type: message?.type, suppressPersistenceForTest: message?.suppressPersistenceForTest })))}`);

				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1, snapshotId: `suppressed-${index}`, testOnlyNoop: true,
					state: { sections: [{ type: variant.firstType, query: 'SHOULD_NOT_PERSIST' }] },
				}));

				assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === `suppressed-${index}` && message.editRevision === 1));
				assert.strictEqual(fs.readFileSync(sourcePath, 'utf8'), originalText);
				assert.strictEqual(fs.existsSync(`${sourcePath}.json`), false);
			}
		} finally {
			if (previousSuppression === undefined) delete process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE;
			else process.env.KUSTO_WORKBENCH_E2E_SUPPRESS_PERSISTENCE = previousSuppression;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Save timeout is bounded when final-snapshot delivery never settles', async function () {
		this.timeout(5_000);
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		try {
			let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
			(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			const sourcePath = path.join(os.tmpdir(), `never-delivery-${Date.now()}.sql`);
			const provider = new (SqlCompatEditorProvider as any)(
				{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			);
			const document = {
				uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
				lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: (message: any) => message?.type === 'requestFinalPersist'
						? new Promise<boolean>(() => undefined)
						: Promise.resolve(true),
					onDidReceiveMessage: () => ({ dispose() {} }),
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler);
			let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
			} as any);
			assert.ok(saveBarrier);
			const startedAt = Date.now();
			await assert.rejects(saveBarrier!, /Timed out waiting for the final SQL metadata snapshot/);
			assert.ok(Date.now() - startedAt < 5_000, 'Save timeout must not wait for the unresolved delivery promise');
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
		}
	});

	test('failed or superseded correlated snapshots do not acknowledge or satisfy Save', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-correlated-failure-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `correlated-failure-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(`${sourcePath}.json`, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
				const posted: any[] = [];
				let requestMode: 'failure' | 'superseded' = 'failure';
				let releaseOld!: () => void;
				let markOldEntered!: () => void;
				let oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
				let oldEntered = new Promise<void>(resolve => { markOldEntered = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (JSON.stringify(state).includes('FAIL_CORRELATED')) {
						throw new Error('correlated sanitation failed');
					}
					if (JSON.stringify(state).includes('OLD_CORRELATED')) {
						markOldEntered();
						await oldGate;
					}
					return state;
				};
				(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type === 'requestFinalPersist') {
								if (requestMode === 'failure') {
									void Promise.resolve().then(() => receiveHandler?.(withProjectedCompatPrimary(posted, {
										type: 'persistDocument', editRevision: 1,
										snapshotId: 'failed-snapshot', flushRequestId: message.requestId,
										state: { sections: [
											{ type: variant.firstType, query: 'select 1' },
											{ type: 'markdown', text: 'FAIL_CORRELATED' },
										] },
									})));
								} else {
									void (async () => {
										const oldPersist = Promise.resolve(receiveHandler?.(withProjectedCompatPrimary(posted, {
											type: 'persistDocument', editRevision: 2,
											snapshotId: 'old-snapshot', flushRequestId: message.requestId,
											state: { sections: [
												{ type: variant.firstType, query: 'select 1' },
												{ type: 'markdown', text: 'OLD_CORRELATED' },
											] },
										})));
										await oldEntered;
										const newerPersist = Promise.resolve(receiveHandler?.(withProjectedCompatPrimary(posted, {
											type: 'persistDocument', editRevision: 3,
											state: { sections: [
												{ type: variant.firstType, query: 'select 1' },
												{ type: 'markdown', text: 'NEWER' },
											] },
										})));
										releaseOld();
										await Promise.all([oldPersist, newerPersist]);
									})();
								}
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && willSaveHandler);
				const acceptedFile = JSON.parse(fs.readFileSync(`${sourcePath}.json`, 'utf8'));
				posted.push({ type: 'documentData', ok: true, state: acceptedFile.state });
				const requestSave = () => {
					let barrier: Promise<vscode.TextEdit[]> | undefined;
					willSaveHandler!({
						document,
						waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); },
					} as any);
					assert.ok(barrier);
					return barrier!;
				};

				await assert.rejects(requestSave(), /correlated sanitation failed/);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'failed-snapshot'));

				requestMode = 'superseded';
				oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
				oldEntered = new Promise<void>(resolve => { markOldEntered = resolve; });
				await assert.rejects(requestSave(), /superseded before admission/);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'old-snapshot'));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rejected primary text edit does not acknowledge or satisfy correlated Save', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', error: /rejected the final KQL text update/ },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', error: /rejected the final SQL text update/ },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-apply-edit-rejected-'));

		try {
			(vscode.workspace as any).applyEdit = async () => false;
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `apply-edit-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, 'select old', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
				const posted: any[] = [];
				(vscode.workspace as any).onWillSaveTextDocument = (handler: (event: vscode.TextDocumentWillSaveEvent) => unknown) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select old', lineCount: 1,
					lineAt: () => ({ text: 'select old' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.(withProjectedCompatPrimary(posted, {
									type: 'persistDocument', editRevision: 1,
									snapshotId: `rejected-edit-${index}`, flushRequestId: message.requestId,
									state: { sections: [{ type: variant.firstType, query: 'select new' }] },
								})));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && willSaveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				let barrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); },
				} as any);
				assert.ok(barrier);
				await assert.rejects(barrier!, variant.error);
				assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === `rejected-edit-${index}`));
			}
		} finally {
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('transient sidecar sanitation failure remains dirty and retries on Save', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-sanitize-retry-'));

		try {
			const errors: string[] = [];
			(vscode.window as any).showErrorMessage = async (message: unknown) => { errors.push(String(message)); return undefined; };
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `sanitize-retry-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				const baseline = JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				});
				fs.writeFileSync(sidecarPath, baseline, 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				const posted: any[] = [];
				let markerCalls = 0;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (JSON.stringify(state).includes('RETRY_DRAFT')) {
						markerCalls += 1;
						if (markerCalls === 2) throw new Error('transient sanitation failure');
					}
					return state;
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				const repairedBaseline = fs.readFileSync(sidecarPath, 'utf8');
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'RETRY_DRAFT' },
					] },
				})));
				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), repairedBaseline);
				assert.ok(errors.some(message => message.includes('transient sanitation failure')));

				await Promise.resolve(saveHandler!(document));
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('RETRY_DRAFT'));
				errors.length = 0;
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('sidecar publication never writes a pre-final protected payload', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const publicationPayloads: string[] = [];
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-final-publication-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (state: any, publish: (state: any) => Promise<unknown>) => {
				const sanitized = {
					...state,
					sections: state.sections.map((section: any) => {
						if (section.type !== 'sql') return section;
						const { resultJson: _resultJson, ...safe } = section;
						return safe;
					}),
				};
				publicationPayloads.push(JSON.stringify(sanitized));
				return publish(sanitized);
			};
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `final-publication-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
				(vscode.workspace as any).onDidSaveTextDocument = (handler: (document: vscode.TextDocument) => unknown) => {
					saveHandler = handler;
					return { dispose() {} };
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async () => true,
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler && saveHandler);
				publicationPayloads.length = 0;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
										{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'sql', id: 'sql-protected', resultJson: 'PROTECTED_INTERMEDIATE' },
					] },
				}));
				await Promise.resolve(saveHandler!(document));

				assert.ok(publicationPayloads.length > 0);
				assert.ok(publicationPayloads.every(payload => !payload.includes('PROTECTED_INTERMEDIATE')));
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('PROTECTED_INTERMEDIATE'));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('disposal drains a correlated final snapshot requested while the webview is live', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-close-delivery-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `close-delivery-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let finalRequestId = '';
				const disposeHandlers: Array<() => void> = [];
				const viewStateHandlers: Array<(event: { webviewPanel: any }) => void> = [];
				let webviewDisposed = false;
				let postsAfterDispose = 0;
				let resolvePrompt!: () => void;
				const promptSeen = new Promise<void>(resolve => { resolvePrompt = resolve; });
				(vscode.window as any).showWarningMessage = async () => {
					resolvePrompt();
					return 'Save';
				};
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					visible: true,
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (webviewDisposed) {
								postsAfterDispose++;
								throw new Error('Webview is disposed');
							}
							if (message?.type === 'requestFinalPersist') finalRequestId = String(message.requestId || '');
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidChangeViewState: (handler: (event: { webviewPanel: any }) => void) => {
						viewStateHandlers.push(handler);
						return { dispose() {} };
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler);
				panel.visible = false;
				for (const changeViewState of viewStateHandlers) changeViewState({ webviewPanel: panel });
				for (let attempt = 0; attempt < 50 && !finalRequestId; attempt += 1) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
				assert.ok(finalRequestId, `${variant.extension} hidden transition must request a final snapshot`);
				webviewDisposed = true;
				for (const dispose of disposeHandlers) dispose();
				await new Promise<void>(resolve => setTimeout(resolve, 600));
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					snapshotId: `close-snapshot-${index}`, flushRequestId: finalRequestId,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'FINAL_IN_TRANSIT' },
					] },
				}));
				await promptSeen;
				await waitForCondition(
					() => fs.readFileSync(sidecarPath, 'utf8').includes('FINAL_IN_TRANSIT'),
					`${variant.extension} final in-transit snapshot was not durable after disposal`,
				);
				assert.strictEqual(postsAfterDispose, 0, `${variant.extension} disposal must not post to the destroyed webview`);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('direct active disposal waits for a delayed inbound beforeunload snapshot', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-active-close-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `active-close-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				let webviewDisposed = false;
				let postsAfterDispose = 0;
				const posted: any[] = [];
				const provider = new (variant.Provider as any)(
					{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined } } as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false, save: async () => true,
				} as any;
				const panel = {
					visible: true,
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (webviewDisposed) {
								postsAfterDispose++;
								throw new Error('Webview is disposed');
							}
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidChangeViewState: () => ({ dispose() {} }),
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				webviewDisposed = true;
				setTimeout(() => {
					void Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
						type: 'persistDocument', reason: 'beforeunload', editRevision: 1,
						state: { sections: [
							{ type: variant.firstType, query: 'select 1' },
							{ type: 'markdown', text: 'FINAL_ACTIVE_CLOSE' },
						] },
					})));
				}, 50);
				for (const dispose of disposeHandlers) dispose();

				for (let attempt = 0; attempt < 100 && !fs.readFileSync(sidecarPath, 'utf8').includes('FINAL_ACTIVE_CLOSE'); attempt += 1) {
					await new Promise<void>(resolve => setTimeout(resolve, 10));
				}
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('FINAL_ACTIVE_CLOSE'));
				assert.strictEqual(postsAfterDispose, 0, `${variant.extension} direct close must not post to the destroyed webview`);
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility close coordinator drains reversed retained snapshots exactly once', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalShowWarningMessage = vscode.window.showWarningMessage;
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query',
				primaryId: 'compat_primary_query', kind: 'kqlx', forceRecovery: false,
			},
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query',
				primaryId: 'compat_primary_query', kind: 'kqlx', forceRecovery: true,
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql',
				primaryId: 'compat_primary_sql', kind: 'sqlx', forceRecovery: false,
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql',
				primaryId: 'compat_primary_sql', kind: 'sqlx', forceRecovery: true,
			},
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-close-coordinator-'));

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => ({
				...state,
				sections: Array.isArray(state?.sections) ? state.sections.map((section: any) => {
					const sanitized = { ...section };
					if (sanitized.resultJson === 'PROTECTED_CLOSE_ROW') delete sanitized.resultJson;
					return sanitized;
				}) : [],
			});
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `coordinated-close-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}, null, 2) + '\n', 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				const viewStateHandlers: Array<(event: { webviewPanel: any }) => void> = [];
				const posted: any[] = [];
				let finalRequestId = '';
				let coordinatorCreations = 0;
				let closeStarts = 0;
				let closeSettlements = 0;
				let saveDraftCalls = 0;
				let recoveryCalls = 0;
				let repairCalls = 0;
				let storeDrainCalls = 0;
				let closePromise: Promise<void> | undefined;
				let recoveryUri: vscode.Uri | undefined;
				const retainedAdmission: Array<{ reason: string; flushRequestId: string; allowed: boolean }> = [];
				const savedDrafts: any[] = [];
				const recoveredDrafts: any[] = [];
				const coordinatorFactory = (options: any) => {
					coordinatorCreations++;
					const delegate = new CompatSidecarCloseCoordinator(options);
					return {
						allowRetiredInbound(message: any) {
							const allowed = delegate.allowRetiredInbound(message);
							retainedAdmission.push({
								reason: String(message?.reason || ''),
								flushRequestId: String(message?.flushRequestId || ''),
								allowed,
							});
							return allowed;
						},
						isPendingFinalPersistReply: (message: any) => delegate.isPendingFinalPersistReply(message),
						configure(finalization: any) {
							delegate.configure({
								...finalization,
								saveDraft: async (draft: any) => {
									saveDraftCalls++;
									savedDrafts.push(draft);
									if (variant.forceRecovery) throw new Error('Forced close-time CAS conflict');
									await finalization.saveDraft(draft);
								},
								recoverDraft: async (draft: any) => {
									recoveryCalls++;
									recoveredDrafts.push(draft);
									recoveryUri = await finalization.recoverDraft(draft);
									return recoveryUri;
								},
								repair: async () => {
									repairCalls++;
									await finalization.repair();
								},
								drainStore: async () => {
									storeDrainCalls++;
									await finalization.drainStore();
								},
							});
						},
						failInitialization: (cleanup: any) => delegate.failInitialization(cleanup),
						disposePanel() {
							closeStarts++;
							closePromise = Promise.resolve(delegate.disposePanel()).then(() => {
								closeSettlements++;
							});
							return closePromise;
						},
					};
				};
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
					undefined, coordinatorFactory,
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false,
					save: async () => true,
				} as any;
				const panel = {
					visible: true,
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
								}));
							}
							if (message?.type === 'requestFinalPersist') finalRequestId = String(message.requestId || '');
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = handler;
							return { dispose() {} };
						},
					},
					onDidChangeViewState: (handler: (event: { webviewPanel: any }) => void) => {
						viewStateHandlers.push(handler);
						return { dispose() {} };
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receiveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 1, snapshotId: `dirty-${index}`,
					state: { sections: [
						{ type: variant.primaryType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'DIRTY_DRAFT' },
					] },
				})));
				panel.visible = false;
				for (const handler of viewStateHandlers) handler({ webviewPanel: panel });
				await waitForCondition(() => !!finalRequestId, `${variant.extension} must request a final snapshot before disposal`);
				panel.visible = true;
				for (const handler of viewStateHandlers) handler({ webviewPanel: panel });
				for (const dispose of disposeHandlers) dispose();

				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', reason: 'beforeunload', editRevision: 2,
					snapshotId: `beforeunload-${index}`,
					state: { sections: [
						{ type: variant.primaryType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'BEFOREUNLOAD_DRAFT' },
					] },
				})));
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 99, snapshotId: `ordinary-${index}`,
					state: { sections: [
						{ type: variant.primaryType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'REJECTED_ORDINARY' },
					] },
				})));
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', flushRequestId: finalRequestId, editRevision: 3,
					snapshotId: `final-${index}`,
					state: { sections: [
						{ type: variant.primaryType, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'FINAL_NEWEST_DRAFT' },
						{ id: 'sql_protected', type: 'sql', query: 'select secret', resultJson: 'PROTECTED_CLOSE_ROW' },
					] },
				})));
				if (closePromise) await closePromise;
				else await new Promise<void>(resolve => setTimeout(resolve, 700));

				assert.strictEqual(coordinatorCreations, 1, `${variant.extension} must create one panel close coordinator`);
				assert.strictEqual(closeStarts, 1, `${variant.extension} must start close exactly once`);
				assert.strictEqual(closeSettlements, 1, `${variant.extension} must settle close exactly once`);
				assert.strictEqual(saveDraftCalls, 1, `${variant.extension} must attempt one exact draft save`);
				assert.strictEqual(recoveryCalls, variant.forceRecovery ? 1 : 0);
				assert.strictEqual(repairCalls, 1, `${variant.extension} must run final repair once`);
				assert.strictEqual(storeDrainCalls, 1, `${variant.extension} must drain the exact store once`);
				assert.ok(JSON.stringify(savedDrafts[0]?.state).includes('FINAL_NEWEST_DRAFT'));
				assert.ok(!JSON.stringify(savedDrafts[0]?.state).includes('REJECTED_ORDINARY'));
				assert.ok(!JSON.stringify(savedDrafts[0]?.state).includes('PROTECTED_CLOSE_ROW'));
				assert.ok(retainedAdmission.some(entry => entry.reason === 'beforeunload' && entry.allowed));
				assert.ok(retainedAdmission.some(entry => entry.flushRequestId === finalRequestId && entry.allowed));
				assert.ok(retainedAdmission.some(entry => !entry.reason && !entry.flushRequestId && !entry.allowed));
				if (variant.forceRecovery) {
					assert.ok(recoveryUri);
					assert.ok(JSON.stringify(recoveredDrafts[0]?.state).includes('FINAL_NEWEST_DRAFT'));
					assert.ok(!JSON.stringify(recoveredDrafts[0]?.state).includes('PROTECTED_CLOSE_ROW'));
					assert.ok(fs.readFileSync(recoveryUri!.fsPath, 'utf8').includes('FINAL_NEWEST_DRAFT'));
					assert.ok(!fs.readFileSync(recoveryUri!.fsPath, 'utf8').includes('PROTECTED_CLOSE_ROW'));
				} else {
					assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('FINAL_NEWEST_DRAFT'));
				}
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('REJECTED_ORDINARY'));
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('PROTECTED_CLOSE_ROW'));
			}
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility persistence rejects malformed and predecessor panel traffic before successor effects', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const originalInitialize = prototype.initializeWebviewPanel;
		const originalSanitize = prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChangeTextDocument = vscode.workspace.onDidChangeTextDocument;
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-persistence-session-'));
		const variants = [
			{
				extension: '.kql', Provider: KqlCompatEditorProvider, primaryType: 'query',
				primaryId: 'compat_primary_query', kind: 'kqlx',
			},
			{
				extension: '.sql', Provider: SqlCompatEditorProvider, primaryType: 'sql',
				primaryId: 'compat_primary_sql', kind: 'sqlx',
			},
		] as const;
		type RegisteredHandler<T> = { active: boolean; handler: T };
		const changeHandlers: Array<RegisteredHandler<(event: vscode.TextDocumentChangeEvent) => unknown>> = [];
		const willSaveHandlers: Array<RegisteredHandler<(event: vscode.TextDocumentWillSaveEvent) => unknown>> = [];
		const didSaveHandlers: Array<RegisteredHandler<(document: vscode.TextDocument) => unknown>> = [];
		const bootstrapByPanel = new Map<object, any>();
		let attackSanitizations = 0;

		const register = <T>(handlers: Array<RegisteredHandler<T>>, handler: T): vscode.Disposable => {
			const registration = { active: true, handler };
			handlers.push(registration);
			return { dispose: () => { registration.active = false; } };
		};
		const envelope = (viewSessionId: string, message: Record<string, unknown>) => ({
			protocolVersion: 1,
			channel: 'compatibility-persistence',
			viewSessionId,
			...message,
		});

		try {
			prototype.initializeWebviewPanel = async (_panel: vscode.WebviewPanel, options: any) => {
				bootstrapByPanel.set(_panel as object, options?.compatibilityPersistence);
			};
			prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
				if (JSON.stringify(state).includes('ATTACK_')) attackSanitizations++;
				return state;
			};
			(vscode.workspace as any).onDidChangeTextDocument = (handler: any) => register(changeHandlers, handler);
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => register(willSaveHandlers, handler);
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => register(didSaveHandlers, handler);

			for (const [index, variant] of variants.entries()) {
				changeHandlers.length = 0;
				willSaveHandlers.length = 0;
				didSaveHandlers.length = 0;
				attackSanitizations = 0;
				const sourcePath = path.join(tmpDir, `session-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				let currentText = variant.primaryType === 'query' ? 'print original = 1' : 'SELECT 1 AS original';
				let applyEditCalls = 0;
				fs.writeFileSync(sourcePath, currentText, 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ id: variant.primaryId, type: variant.primaryType, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}, null, 2) + '\n', 'utf8');
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					applyEditCalls++;
					const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					return true;
				};

				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => currentText,
					get lineCount() { return Math.max(1, currentText.split(/\r?\n/).length); },
					lineAt: (line: number) => ({ text: currentText.split(/\r?\n/)[line] ?? '' }),
					eol: vscode.EndOfLine.LF, isDirty: false, save: async () => true,
				} as any;
				const createPanel = () => {
					let receive: ((message: any) => unknown) | undefined;
					const posted: any[] = [];
					const disposeHandlers: Array<() => void> = [];
					const panel = {
						visible: true, active: true,
						webview: {
							options: {}, postMessage: async (message: any) => { posted.push(message); return true; },
							onDidReceiveMessage: (handler: (message: any) => unknown) => {
								receive = handler;
								return { dispose() {} };
							},
						},
						onDidChangeViewState: () => ({ dispose() {} }),
						onDidDispose: (handler: () => void) => {
							disposeHandlers.push(handler);
							return { dispose() {} };
						},
					} as any;
					return { panel, posted, disposeHandlers, receive: () => receive };
				};
				const openPanel = async (label: string) => {
					const testPanel = createPanel();
					await provider.resolveCustomTextEditor(document, testPanel.panel, {} as any);
					const bootstrap = bootstrapByPanel.get(testPanel.panel as object);
					assert.strictEqual(bootstrap?.protocolVersion, 1, `${variant.extension} ${label} must receive a protocol version`);
					assert.strictEqual(bootstrap?.channel, 'compatibility-persistence');
					assert.ok(typeof bootstrap?.viewSessionId === 'string' && bootstrap.viewSessionId.length > 0);
					const requestId = `${label}-request-${index}`;
					let settled = false;
					const request = Promise.resolve(testPanel.receive()!(envelope(bootstrap.viewSessionId, {
						type: 'requestDocument', requestId,
					}))).then(() => { settled = true; });
					await waitForCondition(
						() => testPanel.posted.some(message => message?.type === 'documentData' && message?.requestId === requestId),
						`${variant.extension} ${label} did not receive its correlated projection`,
					);
					const projection = testPanel.posted.find(message => message?.type === 'documentData' && message?.requestId === requestId);
					assert.strictEqual(projection.viewSessionId, bootstrap.viewSessionId);
					assert.strictEqual(projection.channel, 'compatibility-persistence');
					await Promise.resolve(testPanel.receive()!(envelope(bootstrap.viewSessionId, {
						type: 'documentReloadResult', requestId: projection.reloadRequestId,
						applied: true, editRevision: Number(projection.editRevision || 0),
					})));
					await request;
					assert.strictEqual(settled, true);
					return { ...testPanel, bootstrap, projection };
				};

				const panelA = await openPanel('A');
				panelA.panel.visible = false;
				for (const dispose of panelA.disposeHandlers) dispose();
				await new Promise<void>(resolve => setImmediate(resolve));
				const panelB = await openPanel('B');
				assert.notStrictEqual(panelA.bootstrap.viewSessionId, panelB.bootstrap.viewSessionId);

				const projectionCount = panelB.posted.filter(message => message?.type === 'documentData').length;
				void Promise.resolve(panelB.receive()!(envelope(panelA.bootstrap.viewSessionId, {
					type: 'requestDocument', requestId: `B-predecessor-request-${index}`,
				})));
				void Promise.resolve(panelB.receive()!({
					protocolVersion: '1', channel: 'compatibility-persistence',
					viewSessionId: panelB.bootstrap.viewSessionId,
					type: 'requestDocument', requestId: `B-malformed-request-${index}`,
				}));
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(
					panelB.posted.filter(message => message?.type === 'documentData').length,
					projectionCount,
					`${variant.extension} B must not project for malformed or predecessor requests`,
				);

				const reloadRequestId = `B-reload-request-${index}`;
				let reloadSettled = false;
				const reload = Promise.resolve(panelB.receive()!(envelope(panelB.bootstrap.viewSessionId, {
					type: 'requestDocument', requestId: reloadRequestId,
				}))).then(() => { reloadSettled = true; });
				await waitForCondition(
					() => panelB.posted.some(message => message?.type === 'documentData' && message?.requestId === reloadRequestId),
					`${variant.extension} B did not publish the reload projection`,
				);
				const reloadProjection = panelB.posted.find(message => message?.type === 'documentData' && message?.requestId === reloadRequestId);
				await Promise.resolve(panelB.receive()!(envelope(panelA.bootstrap.viewSessionId, {
					type: 'documentReloadResult', requestId: reloadProjection.reloadRequestId,
					applied: true, editRevision: Number(reloadProjection.editRevision || 0),
				})));
				await Promise.resolve(panelB.receive()!({
					protocolVersion: 1, channel: 'compatibility-persistence',
					viewSessionId: panelB.bootstrap.viewSessionId,
					type: 'documentReloadResult', requestId: reloadProjection.reloadRequestId,
					applied: 'true', editRevision: Number(reloadProjection.editRevision || 0),
				}));
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(reloadSettled, false, `${variant.extension} B reload must remain pending`);
				await Promise.resolve(panelB.receive()!(envelope(panelB.bootstrap.viewSessionId, {
					type: 'documentReloadResult', requestId: reloadProjection.reloadRequestId,
					applied: true, editRevision: Number(reloadProjection.editRevision || 0),
				})));
				await reload;

				const attackState = (text: string) => ({ sections: [
					{ id: variant.primaryId, type: variant.primaryType, query: currentText },
					{ id: 'markdown_1', type: 'markdown', text },
				] });
				for (const attack of [
					envelope(panelA.bootstrap.viewSessionId, {
						type: 'persistDocument', state: attackState('ATTACK_PREDECESSOR'),
						sourceGeneration: reloadProjection.sourceGeneration, editRevision: 1,
						snapshotId: `predecessor-${index}`,
					}),
					{
						protocolVersion: 1, channel: 'compatibility-persistence',
						viewSessionId: panelB.bootstrap.viewSessionId,
						type: 'persistDocument', state: attackState('ATTACK_MALFORMED'),
						sourceGeneration: reloadProjection.sourceGeneration, editRevision: '1',
						snapshotId: `malformed-${index}`,
					},
					{
						protocolVersion: 1, channel: 'compatibility-persistence',
						viewSessionId: panelB.bootstrap.viewSessionId,
						type: 'persistDocument', state: { sections: [{}] },
						sourceGeneration: reloadProjection.sourceGeneration, editRevision: 99,
						snapshotId: `malformed-state-${index}`,
					},
				]) {
					await Promise.resolve(panelB.receive()!(attack));
				}
				assert.strictEqual(attackSanitizations, 0, `${variant.extension} B must not reserve attack persists`);
				assert.strictEqual(applyEditCalls, 0, `${variant.extension} B primary text must remain untouched`);
				assert.ok(!panelB.posted.some(message => message?.snapshotId === `predecessor-${index}`));
				assert.ok(!panelB.posted.some(message => message?.snapshotId === `malformed-${index}`));
				assert.ok(!panelB.posted.some(message => message?.snapshotId === `malformed-state-${index}`));

				const validSnapshotId = `valid-${index}`;
				await Promise.resolve(panelB.receive()!(envelope(panelB.bootstrap.viewSessionId, {
					type: 'persistDocument', state: attackState('B_VALID'),
					sourceGeneration: reloadProjection.sourceGeneration, editRevision: 1,
					snapshotId: validSnapshotId,
				})));
				assert.strictEqual(
					panelB.posted.filter(message => message?.type === 'persistDocumentAck' && message?.snapshotId === validSnapshotId).length,
					1,
				);

				const activeWillSave = [...willSaveHandlers].reverse().find(registration => registration.active);
				assert.ok(activeWillSave);
				let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
				activeWillSave.handler({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
				} as any);
				await waitForCondition(
					() => panelB.posted.some(message => message?.type === 'requestFinalPersist'),
					`${variant.extension} B did not request final persistence`,
				);
				const finalRequest = panelB.posted.find(message => message?.type === 'requestFinalPersist');
				assert.strictEqual(finalRequest.viewSessionId, panelB.bootstrap.viewSessionId);
				let saveSettled = false;
				const save = saveBarrier!.then(value => { saveSettled = true; return value; });
				await Promise.resolve(panelB.receive()!(envelope(panelA.bootstrap.viewSessionId, {
					type: 'persistDocument', state: attackState('ATTACK_FINAL_PREDECESSOR'),
					sourceGeneration: reloadProjection.sourceGeneration, editRevision: 2,
					snapshotId: `predecessor-final-${index}`, flushRequestId: finalRequest.requestId,
				})));
				await Promise.resolve(panelB.receive()!({
					protocolVersion: 1, channel: 'compatibility-persistence',
					viewSessionId: panelB.bootstrap.viewSessionId,
					type: 'persistDocument', state: null,
					sourceGeneration: reloadProjection.sourceGeneration, editRevision: 2,
					snapshotId: `malformed-final-${index}`, flushRequestId: finalRequest.requestId,
				}));
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(saveSettled, false, `${variant.extension} B final waiter must remain pending`);
				await Promise.resolve(panelB.receive()!(envelope(panelB.bootstrap.viewSessionId, {
					type: 'persistDocument', state: attackState('B_FINAL'),
					sourceGeneration: reloadProjection.sourceGeneration, editRevision: 2,
					snapshotId: `valid-final-${index}`, flushRequestId: finalRequest.requestId,
				})));
				assert.deepStrictEqual(await save, []);
				assert.strictEqual(
					panelB.posted.filter(message => message?.type === 'persistDocumentAck' && message?.snapshotId === `valid-final-${index}`).length,
					1,
				);
				const activeDidSave = [...didSaveHandlers].reverse().find(registration => registration.active);
				assert.ok(activeDidSave);
				await Promise.resolve(activeDidSave.handler(document));
				const persisted = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(persisted.includes('B_FINAL'));
				assert.ok(!persisted.includes('ATTACK_'));
			}
		} finally {
			prototype.initializeWebviewPanel = originalInitialize;
			prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChangeTextDocument;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility panel disposal cancels a never-settling initialization', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const originalInitialize = prototype.initializeWebviewPanel;
		const variants = [KqlCompatEditorProvider, SqlCompatEditorProvider] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-init-failure-'));

		try {
			for (const [index, Provider] of variants.entries()) {
				let initializationStarted!: () => void;
				const started = new Promise<void>(resolve => { initializationStarted = resolve; });
				const initialization = new Promise<void>(() => undefined);
				prototype.initializeWebviewPanel = async () => {
					initializationStarted();
					await initialization;
				};
				let inboundDisposals = 0;
				let panelSubscriptionDisposals = 0;
				const disposeHandlers: Array<() => void> = [];
				const sourcePath = path.join(tmpDir, `failed-${index}${index === 0 ? '.kql' : '.sql'}`);
				const provider = new (Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					visible: true,
					webview: {
						options: {}, postMessage: async () => true,
						onDidReceiveMessage: () => ({ dispose: () => { inboundDisposals++; } }),
					},
					onDidDispose: (handler: () => void) => {
						disposeHandlers.push(handler);
						return { dispose: () => { panelSubscriptionDisposals++; } };
					},
				} as any;

				const opening = provider.resolveCustomTextEditor(document, panel, {} as any);
				await started;
				for (const dispose of disposeHandlers) dispose();
				assert.strictEqual(await Promise.race([
					opening.then(() => true),
					new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
				]), true, `compatibility initialization ${index} should cancel on disposal`);

				assert.strictEqual(inboundDisposals, 1);
				assert.strictEqual(panelSubscriptionDisposals, 2);
			}
		} finally {
			prototype.initializeWebviewPanel = originalInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility initialization rejection disposes the live nested query provider', async () => {
		const prototype = (QueryEditorProvider as any).prototype;
		const originalInitialize = prototype.initializeWebviewPanel;
		const variants = [KqlCompatEditorProvider, SqlCompatEditorProvider] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-live-init-failure-'));

		try {
			for (const [index, Provider] of variants.entries()) {
				let nestedProvider: any;
				prototype.initializeWebviewPanel = async function (this: QueryEditorProvider, panel: vscode.WebviewPanel) {
					nestedProvider = this;
					(this as any).panel = panel;
					(this as any)._panelDisposed = false;
					(QueryEditorProvider as any).activeProviders.add(this);
					(this as any).registerPanelDisposal(panel);
					throw new Error(`live compat init failed ${index}`);
				};
				let inboundDisposals = 0;
				let panelSubscriptionDisposals = 0;
				const sourcePath = path.join(tmpDir, `live-failed-${index}${index === 0 ? '.kql' : '.sql'}`);
				const provider = new (Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `live-global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					visible: true,
					webview: {
						options: {}, postMessage: async () => true,
						onDidReceiveMessage: () => ({ dispose: () => { inboundDisposals++; } }),
					},
					onDidDispose: () => ({ dispose: () => { panelSubscriptionDisposals++; } }),
				} as any;

				await assert.rejects(
					provider.resolveCustomTextEditor(document, panel, {} as any),
					new RegExp(`live compat init failed ${index}`),
				);

				assert.ok(nestedProvider);
				assert.strictEqual(nestedProvider._panelDisposed, true);
				assert.strictEqual(nestedProvider.panel, undefined);
				assert.strictEqual(nestedProvider.authPreferenceSubscription, undefined);
				assert.strictEqual((QueryEditorProvider as any).activeProviders.has(nestedProvider), false);
				assert.strictEqual(inboundDisposals, 1);
				assert.strictEqual(panelSubscriptionDisposals, 3);
			}
		} finally {
			prototype.initializeWebviewPanel = originalInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('compatibility close ignores ordinary snapshots delivered after disposal', async () => {
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, type: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, type: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-close-admission-'));
		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `close-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, JSON.stringify({
					kind: variant.kind, version: 1, state: { sections: [
						{ id: 'primary_1', type: variant.type, linkedQueryPath: path.basename(sourcePath) },
						{ id: 'markdown_1', type: 'markdown', text: 'BASELINE' },
					] },
				}, null, 2) + '\n', 'utf8');
				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				const provider = new (variant.Provider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, `global-${index}`)),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				);
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), eol: vscode.EndOfLine.LF, isDirty: false,
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					}, visible: true, onDidChangeViewState: () => ({ dispose() {} }),
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				for (const dispose of disposeHandlers) dispose();
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ id: 'primary_1', type: variant.type, query: 'select 1' },
						{ id: 'markdown_1', type: 'markdown', text: 'STALE_ORDINARY' },
					] },
				}));
				await new Promise<void>(resolve => setTimeout(resolve, 600));
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('STALE_ORDINARY'));
			}
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session close drains an admitted beforeunload snapshot', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-rich-beforeunload-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		fs.writeFileSync(sessionPath, initialText, 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let sourceGeneration = 0;
		const disposeHandlers: Array<() => void> = [];
		let webviewDisposed = false;
		let postsAfterDispose = 0;

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => initialText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') sourceGeneration = Number(message.sourceGeneration || 0);
						if (webviewDisposed) { postsAfterDispose++; throw new Error('disposed'); }
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			let settleInbound!: () => void;
			const inbound = new Promise<void>(resolve => { settleInbound = resolve; });
			webviewDisposed = true;
			setTimeout(() => {
				void Promise.resolve(receiveHandler!({
					type: 'persistDocument', reason: 'beforeunload', snapshotId: 'rich-beforeunload',
					sourceGeneration, editRevision: 1,
					state: { sections: [{ id: 'query_1', type: 'query', query: 'FINAL_RICH_CLOSE' }] },
				})).finally(settleInbound);
			}, 50);
			for (const dispose of disposeHandlers) dispose();
			await inbound;
			await waitForCondition(() => fs.readFileSync(sessionPath, 'utf8').includes('FINAL_RICH_CLOSE'), 'rich beforeunload snapshot should reach disk');
			assert.strictEqual(postsAfterDispose, 0);
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session ignores a beforeunload snapshot after the close admission grace', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-rich-beforeunload-expired-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		fs.writeFileSync(sessionPath, initialText, 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(sessionPath), getText: () => initialText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = posted.filter(message => message?.type === 'documentData' && message.ok === true)
				.at(-1)?.sourceGeneration;
			for (const dispose of disposeHandlers) dispose();
			await new Promise<void>(resolve => setTimeout(resolve, 600));

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', reason: 'beforeunload', snapshotId: 'expired-beforeunload',
				sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'TOO_LATE' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			const persistedText = fs.readFileSync(sessionPath, 'utf8');
			assert.deepStrictEqual(JSON.parse(persistedText).state.sections, []);
			assert.ok(!persistedText.includes('TOO_LATE'));
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('saveLastSelection caches file connection for .kql without sidecar', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-fileconn-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		try {
			fs.writeFileSync(kqlPath, 'MyTable | take 5', 'utf8');

			const globalStateStore: Record<string, unknown> = {};
			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => globalStateStore[key],
					update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
				} as any
			} as any;

			const { ConnectionManager } = await import('../../src/host/connectionManager.js');
			const connManager = new ConnectionManager(fakeContext);
			// Add a connection so saveLastSelection can resolve the connectionId.
			await connManager.addConnection({ name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' });
			const conn = connManager.getConnections()[0];

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connManager,
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'MyTable | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'MyTable | take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				}
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler, 'expected webview message handler');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// Simulate user manually changing the connection via dropdown.
			await Promise.resolve(receiveHandler!({
				type: 'saveLastSelection',
				connectionId: conn.id,
				database: 'MyDB'
			}));

			// Verify the connection was cached for this specific file.
			const cached = connManager.getFileConnection(kqlPath);
			assert.ok(cached, 'expected cached file connection');
			assert.strictEqual(cached!.clusterUrl, 'https://mycluster.kusto.windows.net');
			assert.strictEqual(cached!.database, 'MyDB');
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('saveLastSelection waits for cache write so immediate requestDocument sees the new connection', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-fileconn-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		try {
			fs.writeFileSync(kqlPath, 'MyTable | take 5', 'utf8');

			const globalStateStore: Record<string, unknown> = {};
			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => globalStateStore[key],
					update: async (key: string, value: unknown) => {
						// Simulate slow persistence to reproduce quick-switch race conditions.
						if (key === 'kusto.fileConnectionCache') {
							await new Promise((resolve) => setTimeout(resolve, 30));
						}
						globalStateStore[key] = value;
					}
				} as any
			} as any;

			const { ConnectionManager } = await import('../../src/host/connectionManager.js');
			const connManager = new ConnectionManager(fakeContext);
			const connA = await connManager.addConnection({ name: 'ClusterA', clusterUrl: 'https://cluster-a.kusto.windows.net' });
			await connManager.setFileConnection(kqlPath, connA.clusterUrl, 'DBA', { connectionIdHint: connA.id });
			await connManager.addConnection({ name: 'ClusterC', clusterUrl: 'https://cluster-c.kusto.windows.net' });
			const connC = connManager.getConnections().find(c => c.clusterUrl === 'https://cluster-c.kusto.windows.net')!;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connManager,
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'MyTable | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'MyTable | take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; }
			} as any;
			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);

			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const firstDoc = posted.filter((m) => m && m.type === 'documentData').pop();
			assert.ok(firstDoc);
			assert.strictEqual(firstDoc.state.sections[0].clusterUrl, 'https://cluster-a.kusto.windows.net');

			// User changes to connection C and we immediately ask for the document again.
			// If saveLastSelection doesn't await the cache write, this can still return A.
			await Promise.resolve(receiveHandler!({
				type: 'saveLastSelection',
				connectionId: connC.id,
				database: 'DBC'
			}));

			posted.length = 0;
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const secondDoc = posted.filter((m) => m && m.type === 'documentData').pop();
			assert.ok(secondDoc);
			assert.strictEqual(secondDoc.state.sections[0].clusterUrl, 'https://cluster-c.kusto.windows.net');
			assert.strictEqual(secondDoc.state.sections[0].database, 'DBC');
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('persistDocument does NOT cache connections (only saveLastSelection does)', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-fileconn-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		try {
			fs.writeFileSync(kqlPath, 'MyTable | take 5', 'utf8');

			const globalStateStore: Record<string, unknown> = {};
			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => globalStateStore[key],
					update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
				} as any
			} as any;

			const { ConnectionManager } = await import('../../src/host/connectionManager.js');
			const connManager = new ConnectionManager(fakeContext);

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connManager,
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'MyTable | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'MyTable | take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler),
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; }
			} as any;
			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// persistDocument with a connection should NOT cache it.
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument',
				state: {
					sections: [{
						type: 'query',
						query: 'MyTable | take 5',
						clusterUrl: 'https://auto-selected.kusto.windows.net',
						database: 'AutoDB'
					}]
				}
			}));

			assert.strictEqual(connManager.getFileConnection(kqlPath), undefined,
				'persistDocument should not cache connections');
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('cached file connection is restored on next open and takes priority over query-based inference', async () => {
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-fileconn-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		try {
			fs.writeFileSync(kqlPath, 'StormEvents | take 10', 'utf8');

			// Pre-populate the file connection cache.
			const globalStateStore: Record<string, unknown> = {};
			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => globalStateStore[key],
					update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
				} as any
			} as any;

			const { ConnectionManager } = await import('../../src/host/connectionManager.js');
			const connManager = new ConnectionManager(fakeContext);
			const cachedConnection = await connManager.addConnection({ name: 'Cached Cluster', clusterUrl: 'https://cached-cluster.kusto.windows.net' });
			await connManager.setFileConnection(kqlPath, cachedConnection.clusterUrl, 'CachedDB', { connectionIdHint: cachedConnection.id });

			// Set up the inferClusterDatabaseForKqlQuery mock to return a DIFFERENT connection
			// to verify the cached one wins.
			let inferCalled = false;
			const origInfer = (QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery;
			(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = async () => {
				inferCalled = true;
				return { clusterUrl: 'https://inferred-cluster.kusto.windows.net', database: 'InferredDB' };
			};

			try {
				const provider = new (KqlCompatEditorProvider as any)(
					fakeContext,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
					connManager,
					sqlWorkbenchStub()
				) as KqlCompatEditorProvider;

				const document: vscode.TextDocument = {
					uri: vscode.Uri.file(kqlPath),
					getText: () => 'StormEvents | take 10',
					lineCount: 1,
					lineAt: () => ({ text: 'StormEvents | take 10' } as any)
				} as any;

				let receiveHandler: ((message: any) => unknown) | undefined;
				const webview: vscode.Webview = {
					options: {} as any,
					postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = handler;
						return { dispose() {} } as DisposableLike;
					}
				} as any;

				const webviewPanel: vscode.WebviewPanel = {
					webview,
					onDidDispose: () => ({ dispose() {} } as DisposableLike)
				} as any;

				await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
				assert.ok(receiveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

				const docMsg = posted.find((m) => m && m.type === 'documentData');
				assert.ok(docMsg, 'expected a documentData message');
				assert.ok(docMsg.state && Array.isArray(docMsg.state.sections));
				const section = docMsg.state.sections[0];
				// The cached connection should win over inference.
				assert.strictEqual(section.clusterUrl, 'https://cached-cluster.kusto.windows.net',
					'expected cached cluster URL, not inferred');
				assert.strictEqual(section.database, 'CachedDB',
					'expected cached database, not inferred');
				// Inference should NOT have been called since we had a cached connection.
				assert.strictEqual(inferCalled, false,
					'inferClusterDatabaseForKqlQuery should not be called when a cached connection exists');
			} finally {
				(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = origInfer;
			}
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('query-based inference is used as fallback when no cached file connection exists', async () => {
		const posted: any[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-fileconn-'));
		const kqlPath = path.join(tmpDir, 'neveropened.kql');

		try {
			fs.writeFileSync(kqlPath, 'StormEvents | take 10', 'utf8');

			const globalStateStore: Record<string, unknown> = {};
			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => globalStateStore[key],
					update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
				} as any
			} as any;

			const { ConnectionManager } = await import('../../src/host/connectionManager.js');
			const connManager = new ConnectionManager(fakeContext);
			// No cached connection set — inference should be used.

			let inferCalled = false;
			const origInfer = (QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery;
			(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = async () => {
				inferCalled = true;
				return { clusterUrl: 'https://inferred-cluster.kusto.windows.net', database: 'InferredDB' };
			};

			try {
				const provider = new (KqlCompatEditorProvider as any)(
					fakeContext,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
					connManager,
					sqlWorkbenchStub()
				) as KqlCompatEditorProvider;

				const document: vscode.TextDocument = {
					uri: vscode.Uri.file(kqlPath),
					getText: () => 'StormEvents | take 10',
					lineCount: 1,
					lineAt: () => ({ text: 'StormEvents | take 10' } as any)
				} as any;

				let receiveHandler: ((message: any) => unknown) | undefined;
				const webview: vscode.Webview = {
					options: {} as any,
					postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = handler;
						return { dispose() {} } as DisposableLike;
					}
				} as any;

				const webviewPanel: vscode.WebviewPanel = {
					webview,
					onDidDispose: () => ({ dispose() {} } as DisposableLike)
				} as any;

				await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
				assert.ok(receiveHandler);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

				const docMsg = posted.find((m) => m && m.type === 'documentData');
				assert.ok(docMsg, 'expected a documentData message');
				const section = docMsg.state.sections[0];
				assert.strictEqual(section.clusterUrl, 'https://inferred-cluster.kusto.windows.net');
				assert.strictEqual(section.database, 'InferredDB');
				assert.strictEqual(inferCalled, true,
					'inferClusterDatabaseForKqlQuery should be called when no cached connection exists');
			} finally {
				(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = origInfer;
			}
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('saveLastSelection on one file does not contaminate another file', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-fileconn-'));
		const kqlPathA = path.join(tmpDir, 'a.kql');
		const kqlPathB = path.join(tmpDir, 'b.kql');

		try {
			fs.writeFileSync(kqlPathA, 'TableA | take 5', 'utf8');
			fs.writeFileSync(kqlPathB, 'TableB | take 5', 'utf8');

			const globalStateStore: Record<string, unknown> = {};
			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => globalStateStore[key],
					update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
				} as any
			} as any;

			const { ConnectionManager } = await import('../../src/host/connectionManager.js');
			const connManager = new ConnectionManager(fakeContext);
			await connManager.addConnection({ name: 'ClusterA', clusterUrl: 'https://cluster-a.kusto.windows.net' });
			await connManager.addConnection({ name: 'ClusterB', clusterUrl: 'https://cluster-b.kusto.windows.net' });
			const conns = connManager.getConnections();
			const connA = conns.find(c => c.clusterUrl === 'https://cluster-a.kusto.windows.net')!;
			const connB = conns.find(c => c.clusterUrl === 'https://cluster-b.kusto.windows.net')!;

			const createEditorForPath = async (kqlPath: string, queryText: string) => {
				const provider = new (KqlCompatEditorProvider as any)(
					fakeContext,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
					connManager,
					sqlWorkbenchStub()
				) as KqlCompatEditorProvider;

				const doc: vscode.TextDocument = {
					uri: vscode.Uri.file(kqlPath),
					getText: () => queryText,
					lineCount: 1,
					lineAt: () => ({ text: queryText } as any)
				} as any;

				let handler: ((msg: any) => unknown) | undefined;
				const webview: vscode.Webview = {
					options: {} as any,
					postMessage: reloadAwarePostMessage(() => handler),
					onDidReceiveMessage: (h: any) => { handler = h; return { dispose() {} } as DisposableLike; }
				} as any;
				const panel: vscode.WebviewPanel = {
					webview,
					onDidDispose: () => ({ dispose() {} } as DisposableLike)
				} as any;

				await provider.resolveCustomTextEditor(doc, panel, {} as any);
				assert.ok(handler);
				await Promise.resolve(handler!({ type: 'requestDocument' }));
				return handler!;
			};

			const handlerA = await createEditorForPath(kqlPathA, 'TableA | take 5');
			const handlerB = await createEditorForPath(kqlPathB, 'TableB | take 5');

			// User changes connection on file A.
			await Promise.resolve(handlerA({ type: 'saveLastSelection', connectionId: connA.id, database: 'DBA' }));

			// File A should be cached.
			const cachedA = connManager.getFileConnection(kqlPathA);
			assert.ok(cachedA, 'file A should be cached after saveLastSelection');
			assert.strictEqual(cachedA!.clusterUrl, 'https://cluster-a.kusto.windows.net');

			// File B should NOT be cached (no action taken on B).
			assert.strictEqual(connManager.getFileConnection(kqlPathB), undefined,
				'file B should not be affected by file A\'s connection change');

			// User changes connection on file B to a different cluster.
			await Promise.resolve(handlerB({ type: 'saveLastSelection', connectionId: connB.id, database: 'DBB' }));

			// File B should now be cached with its own connection.
			const cachedB = connManager.getFileConnection(kqlPathB);
			assert.ok(cachedB, 'file B should be cached after its own saveLastSelection');
			assert.strictEqual(cachedB!.clusterUrl, 'https://cluster-b.kusto.windows.net');

			// File A should still have its original cached connection.
			const cachedA2 = connManager.getFileConnection(kqlPathA);
			assert.ok(cachedA2);
			assert.strictEqual(cachedA2!.clusterUrl, 'https://cluster-a.kusto.windows.net');
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('saveLastSelection updates inferredSelection so postDocument reflects latest connection', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-fileconn-'));
		const kqlPath = path.join(tmpDir, 'test.kql');

		try {
			fs.writeFileSync(kqlPath, 'MyTable | take 5', 'utf8');

			const globalStateStore: Record<string, unknown> = {};
			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: {
					get: (key: string) => globalStateStore[key],
					update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
				} as any
			} as any;

			const { ConnectionManager } = await import('../../src/host/connectionManager.js');
			const connManager = new ConnectionManager(fakeContext);
			// Pre-populate with connection A.
			const connA = await connManager.addConnection({ name: 'ClusterA', clusterUrl: 'https://cluster-a.kusto.windows.net' });
			await connManager.setFileConnection(kqlPath, connA.clusterUrl, 'DBA', { connectionIdHint: connA.id });
			await connManager.addConnection({ name: 'ClusterC', clusterUrl: 'https://cluster-c.kusto.windows.net' });
			const connC = connManager.getConnections().find(c => c.clusterUrl === 'https://cluster-c.kusto.windows.net')!;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connManager,
				sqlWorkbenchStub()
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlPath),
				getText: () => 'MyTable | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'MyTable | take 5' } as any)
			} as any;

			let receiveHandler: ((message: any) => unknown) | undefined;
			const posted: any[] = [];
			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; }
			} as any;
			const webviewPanel: vscode.WebviewPanel = {
				webview,
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);

			// Initial requestDocument — should show connection A.
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const initialDoc = posted.filter((m) => m && m.type === 'documentData').pop();
			assert.ok(initialDoc);
			assert.strictEqual(initialDoc.state.sections[0].clusterUrl, 'https://cluster-a.kusto.windows.net',
				'initial load should show connection A from cache');

			// User changes connection to C via saveLastSelection.
			await Promise.resolve(receiveHandler!({
				type: 'saveLastSelection',
				connectionId: connC.id,
				database: 'DBC'
			}));

			// Simulate requestDocument being called again (e.g., webview reconstructed).
			posted.length = 0;
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const secondDoc = posted.filter((m) => m && m.type === 'documentData').pop();
			assert.ok(secondDoc, 'expected a second documentData message');
			assert.strictEqual(secondDoc.state.sections[0].clusterUrl, 'https://cluster-c.kusto.windows.net',
				'after changing to C, postDocument should send C, not the stale A');
			assert.strictEqual(secondDoc.state.sections[0].database, 'DBC');

			// Also verify the cache was updated.
			const cached = connManager.getFileConnection(kqlPath);
			assert.ok(cached);
			assert.strictEqual(cached!.clusterUrl, 'https://cluster-c.kusto.windows.net');
			assert.strictEqual(cached!.database, 'DBC');
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('ConnectionManager.getFileConnection / setFileConnection round-trip', async () => {
		const globalStateStore: Record<string, unknown> = {};
		const fakeContext: vscode.ExtensionContext = {
			subscriptions: [],
			workspaceState: { get: () => undefined, update: async () => undefined } as any,
			globalState: {
				get: (key: string) => globalStateStore[key],
				update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
			} as any
		} as any;

		const { ConnectionManager } = await import('../../src/host/connectionManager.js');
		const connManager = new ConnectionManager(fakeContext);

		// Initially empty.
		assert.strictEqual(connManager.getFileConnection('/some/path.kql'), undefined);

		// Set and retrieve.
		await connManager.setFileConnection('/some/path.kql', 'https://cluster.kusto.windows.net', 'TestDB');
		const cached = connManager.getFileConnection('/some/path.kql');
		assert.ok(cached);
		assert.strictEqual(cached!.clusterUrl, 'https://cluster.kusto.windows.net');
		assert.strictEqual(cached!.database, 'TestDB');

		// Update to a different connection.
		await connManager.setFileConnection('/some/path.kql', 'https://other.kusto.windows.net', 'OtherDB');
		const updated = connManager.getFileConnection('/some/path.kql');
		assert.ok(updated);
		assert.strictEqual(updated!.clusterUrl, 'https://other.kusto.windows.net');
		assert.strictEqual(updated!.database, 'OtherDB');

		// Different file path returns undefined.
		assert.strictEqual(connManager.getFileConnection('/other/file.csl'), undefined);

		// Empty cluster URL should not cache.
		await connManager.setFileConnection('/another/file.kql', '', 'DB');
		assert.strictEqual(connManager.getFileConnection('/another/file.kql'), undefined);
	});

	test('file connection cache entries expire after 30 days of inactivity', async () => {
		const globalStateStore: Record<string, unknown> = {};
		const fakeContext: vscode.ExtensionContext = {
			subscriptions: [],
			workspaceState: { get: () => undefined, update: async () => undefined } as any,
			globalState: {
				get: (key: string) => globalStateStore[key],
				update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
			} as any
		} as any;

		const { ConnectionManager } = await import('../../src/host/connectionManager.js');
		const connManager = new ConnectionManager(fakeContext);

		// Write an entry.
		await connManager.setFileConnection('/path/fresh.kql', 'https://cluster.kusto.windows.net', 'DB1');

		// Verify it exists right after writing.
		const fresh = connManager.getFileConnection('/path/fresh.kql');
		assert.ok(fresh, 'entry should exist right after writing');

		// Simulate 31 days passing by backdating the lastAccessedAt in stored data.
		const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1000;
		const cacheKey = 'kusto.fileConnectionCache';
		const rawCache = globalStateStore[cacheKey] as Record<string, any>;
		assert.ok(rawCache, 'expected cache in global state');

		// Find the entry (key is normalized, but we can iterate).
		const keys = Object.keys(rawCache);
		assert.ok(keys.length > 0, 'expected at least one cache entry');
		for (const k of keys) {
			if (rawCache[k]) {
				rawCache[k].lastAccessedAt = Date.now() - thirtyOneDaysMs;
			}
		}

		// Now reading should return undefined (expired).
		const expired = connManager.getFileConnection('/path/fresh.kql');
		assert.strictEqual(expired, undefined, 'entry should be undefined after expiry');

		// The expired entry should have been pruned from storage.
		const afterPrune = globalStateStore[cacheKey] as Record<string, any>;
		const remaining = afterPrune ? Object.keys(afterPrune).length : 0;
		assert.strictEqual(remaining, 0, 'expired entry should be pruned from storage');
	});

	test('reading a file connection entry does NOT touch lastAccessedAt (avoids write races)', async () => {
		const globalStateStore: Record<string, unknown> = {};
		const fakeContext: vscode.ExtensionContext = {
			subscriptions: [],
			workspaceState: { get: () => undefined, update: async () => undefined } as any,
			globalState: {
				get: (key: string) => globalStateStore[key],
				update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
			} as any
		} as any;

		const { ConnectionManager } = await import('../../src/host/connectionManager.js');
		const connManager = new ConnectionManager(fakeContext);

		await connManager.setFileConnection('/path/active.kql', 'https://cluster.kusto.windows.net', 'DB1');

		// Backdate to 20 days ago (within 30-day window).
		const twentyDaysMs = 20 * 24 * 60 * 60 * 1000;
		const cacheKey = 'kusto.fileConnectionCache';
		const rawCache = globalStateStore[cacheKey] as Record<string, any>;
		const backdatedTime = Date.now() - twentyDaysMs;
		for (const k of Object.keys(rawCache)) {
			if (rawCache[k]) {
				rawCache[k].lastAccessedAt = backdatedTime;
			}
		}

		// Read — should return the entry but NOT update lastAccessedAt.
		const result = connManager.getFileConnection('/path/active.kql');
		assert.ok(result, 'entry should still be valid at 20 days');

		// Verify the lastAccessedAt was NOT refreshed (should still be ~20 days ago).
		const updatedCache = globalStateStore[cacheKey] as Record<string, any>;
		const entry = Object.values(updatedCache)[0] as any;
		assert.strictEqual(entry.lastAccessedAt, backdatedTime,
			'getFileConnection should not touch lastAccessedAt to avoid write races');
	});

	test('concurrent getFileConnection and setFileConnection do not lose data', async () => {
		const globalStateStore: Record<string, unknown> = {};
		const fakeContext: vscode.ExtensionContext = {
			subscriptions: [],
			workspaceState: { get: () => undefined, update: async () => undefined } as any,
			globalState: {
				get: (key: string) => globalStateStore[key],
				update: async (key: string, value: unknown) => { globalStateStore[key] = value; }
			} as any
		} as any;

		const { ConnectionManager } = await import('../../src/host/connectionManager.js');
		const connManager = new ConnectionManager(fakeContext);

		// Pre-populate two files.
		await connManager.setFileConnection('/path/a.kql', 'https://cluster-a.kusto.windows.net', 'DBA');
		await connManager.setFileConnection('/path/b.kql', 'https://cluster-b.kusto.windows.net', 'DBB');

		// Simulate rapid switching: read A, then immediately write B.
		const resultA = connManager.getFileConnection('/path/a.kql');
		assert.ok(resultA);
		assert.strictEqual(resultA!.clusterUrl, 'https://cluster-a.kusto.windows.net');

		await connManager.setFileConnection('/path/b.kql', 'https://cluster-b2.kusto.windows.net', 'DBB2');

		// Both entries should be intact.
		const resultA2 = connManager.getFileConnection('/path/a.kql');
		assert.ok(resultA2, 'file A should still be cached after file B is updated');
		assert.strictEqual(resultA2!.clusterUrl, 'https://cluster-a.kusto.windows.net');

		const resultB = connManager.getFileConnection('/path/b.kql');
		assert.ok(resultB, 'file B should have the updated connection');
		assert.strictEqual(resultB!.clusterUrl, 'https://cluster-b2.kusto.windows.net');
	});
});

suite('.md compat persistence', () => {
	test('resource URI requests validate before plain-Markdown path effects', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		let disposeHandler: (() => void) | undefined;
		const posted: any[] = [];
		const convertedUris: vscode.Uri[] = [];
		let pathStringCoercions = 0;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-md-resource-uri-'));
		const mdPath = path.join(tmpDir, 'test.md');
		const imagePath = path.join(tmpDir, 'images', 'current.png');
		let resolveLocalConversion!: () => void;
		const localConversion = new Promise<void>(resolve => { resolveLocalConversion = resolve; });
		let awaitingLocalConversion = false;
		const originalOnDidChange = (vscode.workspace as any).onDidChangeTextDocument;
		try {
			(vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} } as DisposableLike);
			fs.writeFileSync(mdPath, '# Resource URI', 'utf8');
			fs.mkdirSync(path.dirname(imagePath), { recursive: true });
			fs.writeFileSync(imagePath, 'image', 'utf8');

			const fakeContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				extension: { packageJSON: { version: 'test' } },
			} as unknown as vscode.ExtensionContext;
			const extensionRoot = vscode.Uri.file(path.resolve(__dirname, '..', '..', '..'));
			const provider = new (MdCompatEditorProvider as any)(
				fakeContext, extensionRoot, {} as any,
			) as MdCompatEditorProvider;
			const document = {
				uri: vscode.Uri.file(mdPath),
				getText: () => '# Resource URI',
				lineCount: 1,
				lineAt: () => ({ text: '# Resource URI' }),
			} as unknown as vscode.TextDocument;
			const webview = {
				options: {},
				html: '',
				postMessage: async (message: unknown) => { posted.push(message); return true; },
				onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				},
				asWebviewUri: (uri: vscode.Uri) => {
					convertedUris.push(uri);
					if (awaitingLocalConversion) resolveLocalConversion();
					return vscode.Uri.parse('vscode-webview://resource/current.png');
				},
			} as unknown as vscode.Webview;
			const webviewPanel = {
				webview,
				visible: true,
				onDidDispose: (handler: () => void) => {
					disposeHandler = handler;
					return { dispose() {} } as DisposableLike;
				},
				onDidChangeViewState: () => ({ dispose() {} } as DisposableLike),
			} as unknown as vscode.WebviewPanel;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as vscode.CancellationToken);
			assert.ok(receiveHandler, 'expected webview message handler');
			const conversionCountBeforeRequest = convertedUris.length;
			await Promise.resolve(receiveHandler!({
				type: 'resolveResourceUri', requestId: 'malformed-resource',
				path: {
					toString: () => {
						pathStringCoercions += 1;
						return './images/forged.png';
					},
				},
				baseUri: '',
			}));
			await Promise.resolve();
			assert.strictEqual(pathStringCoercions, 0, 'malformed request must not coerce its path');
			assert.strictEqual(
				convertedUris.length,
				conversionCountBeforeRequest,
				'malformed request must not convert a URI',
			);
			assert.strictEqual(
				posted.some(message => message?.requestId === 'malformed-resource'),
				false,
				'malformed request must not publish a result',
			);

			await Promise.resolve(receiveHandler!({
				type: 'resolveResourceUri', requestId: 'empty-resource', path: '', baseUri: '',
			}));
			await Promise.resolve(receiveHandler!({
				type: 'resolveResourceUri', requestId: 'passthrough-resource',
				path: '  https://example.test/current.png  ',
			}));
			assert.deepStrictEqual(
				posted.filter(message => message?.type === 'resolveResourceUriResult'),
				[
					{
						type: 'resolveResourceUriResult', requestId: 'empty-resource',
						ok: false, error: 'Empty path.',
					},
					{
						type: 'resolveResourceUriResult', requestId: 'passthrough-resource',
						ok: true, uri: 'https://example.test/current.png',
					},
				],
			);
			assert.strictEqual(convertedUris.length, conversionCountBeforeRequest);

			awaitingLocalConversion = true;
			await Promise.resolve(receiveHandler!({
				type: 'resolveResourceUri', requestId: 'local-resource',
				path: 'images/current.png', baseUri: document.uri.toString(),
			}));
			await localConversion;
			assert.strictEqual(convertedUris.length, conversionCountBeforeRequest + 1);
			assert.strictEqual(
				path.normalize(convertedUris.at(-1)!.fsPath).toLowerCase(),
				path.normalize(imagePath).toLowerCase(),
				'plain Markdown must resolve relative paths from the document directory',
			);
			assert.deepStrictEqual(
				posted.find(message => message?.requestId === 'local-resource'),
				{
					type: 'resolveResourceUriResult', requestId: 'local-resource',
					ok: true, uri: 'vscode-webview://resource/current.png',
				},
			);
		} finally {
			disposeHandler?.();
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('persistDocument with changed markdown text should dirty a .md file', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const appliedEdits: vscode.WorkspaceEdit[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-md-persist-'));
		const mdPath = path.join(tmpDir, 'test.md');

		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = (vscode.workspace as any).onDidChangeTextDocument;
		try {
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				appliedEdits.push(edit);
				return true;
			};
			(vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} } as DisposableLike);

			fs.writeFileSync(mdPath, '# Hello\n\nOriginal content', 'utf8');

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any,
				extension: { packageJSON: { version: 'test' } } as any
			} as any;

			const extensionRoot = vscode.Uri.file(path.resolve(__dirname, '..', '..', '..'));
			const provider = new (MdCompatEditorProvider as any)(
				fakeContext,
				extensionRoot,
				{} as any
			) as MdCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(mdPath),
				getText: () => '# Hello\n\nOriginal content',
				lineCount: 3,
				lineAt: (line: number) => ({ text: ['# Hello', '', 'Original content'][line] || '' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				html: '',
				postMessage: async (msg: any) => { posted.push(msg); return true; },
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; },
				asWebviewUri: (uri: any) => uri,
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				visible: true,
				onDidDispose: () => ({ dispose() {} } as DisposableLike),
				onDidChangeViewState: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler, 'expected webview message handler');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// Simulate: user edits the markdown text.
			await Promise.resolve(
				receiveHandler!({
					type: 'persistDocument',
					state: {
						sections: [{
							type: 'markdown',
							text: '# Hello\n\nEdited content'
						}]
					}
				})
			);

			assert.strictEqual(appliedEdits.length, 1, 'an edit should be applied when markdown text changed');
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('persistDocument with identical markdown text should NOT dirty a .md file', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const appliedEdits: vscode.WorkspaceEdit[] = [];

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-md-nodirty-'));
		const mdPath = path.join(tmpDir, 'test.md');

		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnDidChange = (vscode.workspace as any).onDidChangeTextDocument;
		try {
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				appliedEdits.push(edit);
				return true;
			};
			(vscode.workspace as any).onDidChangeTextDocument = () => ({ dispose() {} } as DisposableLike);

			fs.writeFileSync(mdPath, '# Same content', 'utf8');

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any,
				extension: { packageJSON: { version: 'test' } } as any
			} as any;

			const extensionRoot = vscode.Uri.file(path.resolve(__dirname, '..', '..', '..'));
			const provider = new (MdCompatEditorProvider as any)(
				fakeContext,
				extensionRoot,
				{} as any
			) as MdCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(mdPath),
				getText: () => '# Same content',
				lineCount: 1,
				lineAt: () => ({ text: '# Same content' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				html: '',
				postMessage: async (msg: any) => { posted.push(msg); return true; },
				onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} } as DisposableLike; },
				asWebviewUri: (uri: any) => uri,
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview,
				visible: true,
				onDidDispose: () => ({ dispose() {} } as DisposableLike),
				onDidChangeViewState: () => ({ dispose() {} } as DisposableLike)
			} as any;

			await provider.resolveCustomTextEditor(document, webviewPanel, {} as any);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			// Simulate: persist fires but markdown text is identical to what's on disk.
			await Promise.resolve(
				receiveHandler!({
					type: 'persistDocument',
					state: {
						sections: [{
							type: 'markdown',
							text: '# Same content'
						}]
					}
				})
			);

			assert.strictEqual(appliedEdits.length, 0, 'no edit should be applied when markdown text is unchanged');
		} finally {
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});
