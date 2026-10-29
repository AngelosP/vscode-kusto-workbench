import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { CompatSidecarSession } from '../../src/host/compatSidecarSession';
import { KqlxEditorProvider, withKqlxDocumentWriteLock } from '../../src/host/kqlxEditorProvider';
import { KustoResultPersistenceRegistry } from '../../src/host/kustoResultPersistenceOwner';
import { KustoWorkbenchToolOrchestrator } from '../../src/host/kustoWorkbenchTools';
import { MainWebviewStartupGateway } from '../../src/host/mainWebviewStartupGateway';
import { QueryEditorProvider } from '../../src/host/queryEditorProvider';
import type { SqlEditorLanguageService, SqlEditorLifecycleCoordinatorOptions } from '../../src/host/sql/sqlEditorLifecycleCoordinator';
import { normalizeWorkbenchUriKey } from '../../src/host/workbenchFileTypes';
import * as workbenchLogger from '../../src/host/workbenchLogger';
import { MarkdownDocumentAggregate } from '../../src/shared/markdownDocumentAggregate';
import { createPrimaryResultArtifactIdentity, publicationFromPersistedResultArtifact } from '../../src/shared/resultArtifact';
import { createToolStateResponseMessage } from '../../src/shared/toolStateSnapshotProtocol';
import { adaptMainWebviewStartupTestPanel, deferMainWebviewReadyForTest } from './mainWebviewStartupTestAdapter';
import { createLiveTextDocumentTestFacade } from './liveTextDocumentTestFacade';

type DisposableLike = { dispose(): void };

async function waitForCondition(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) assert.fail(message);
		await new Promise<void>(resolve => setTimeout(resolve, 25));
	}
}

const documentViewWebviewMessageTypes = new Set([
	'documentReloadResult',
	'markdownDocumentCommand',
	'markdownDocumentCommandBarrierResult',
]);

function latestDocumentViewHostMessage(messages: readonly any[]): any {
	return [...messages].reverse().find(message => message?.channel === 'document-view');
}

function wrapDocumentViewTestReceiver(
	handler: (message: any) => unknown,
	getHostMessage: () => any,
): (message: any) => unknown {
	return message => {
		if (!documentViewWebviewMessageTypes.has(String(message?.type || ''))
			|| message?.protocolVersion !== undefined
			|| message?.channel !== undefined
			|| message?.viewSessionId !== undefined) return handler(message);
		const hostMessage = getHostMessage();
		if (hostMessage?.channel !== 'document-view') return handler(message);
		return handler({
			protocolVersion: hostMessage.protocolVersion,
			channel: hostMessage.channel,
			viewSessionId: hostMessage.viewSessionId,
			...message,
		});
	};
}

function connectionManagerStub(): any {
	const leaveNoTraceSnapshot = {
		clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {},
	};
	return {
		getConnections: () => [],
		addConnection: async () => undefined,
		onDidChangeConnections: () => ({ dispose() {} }),
		runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: unknown) => unknown) => run(leaveNoTraceSnapshot),
	};
}

function sqlWorkbenchStub(): any {
	const ownerSnapshot = {
		policy: { connectionIds: [], version: 0, globallyBlocked: false, revocationGenerations: {} },
		connections: [], connectionVersion: 0, accountsByServer: {}, principalVersion: 0,
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
		dispatchSqlOwnerSnapshot: async (dispatch: (snapshot: unknown) => unknown) => dispatch(ownerSnapshot),
		runWithSqlOwnerSnapshotLock: async (run: (snapshot: unknown) => unknown) => run(ownerSnapshot),
		tryDispatchSqlOwnerSnapshot: async (dispatch: (snapshot: unknown) => unknown) => ({
			acquired: true, value: await dispatch(ownerSnapshot),
		}),
		tryRunWithSqlOwnerSnapshotLock: async (run: (snapshot: unknown) => unknown) => ({
			acquired: true, value: await run(ownerSnapshot),
		}),
		retrySqlOwnerSnapshotAcquisition: async (attempt: () => Promise<any>) => {
			const result = await attempt();
			if (!result.acquired) throw new Error('Expected the SQL owner snapshot lock to be available.');
			return result.value;
		},
		ready: async () => undefined,
	};
}

suite('KQLX host-owned Markdown lifecycle', () => {
	const originalResolveCustomTextEditor = (KqlxEditorProvider as any).prototype.resolveCustomTextEditor;
	const liveDocuments = createLiveTextDocumentTestFacade();

	suiteSetup(() => {
		liveDocuments.install();
		(KqlxEditorProvider as any).prototype.resolveCustomTextEditor = function (
			this: KqlxEditorProvider,
			document: vscode.TextDocument,
			panel: vscode.WebviewPanel,
			token: vscode.CancellationToken,
		) {
			adaptMainWebviewStartupTestPanel(panel);
			liveDocuments.register(document);
			return originalResolveCustomTextEditor.call(this, document, panel, token);
		};
	});

	teardown(() => {
		liveDocuments.clear();
	});

	suiteTeardown(() => {
		liveDocuments.dispose();
		(KqlxEditorProvider as any).prototype.resolveCustomTextEditor = originalResolveCustomTextEditor;
	});

	test('noncanonical fourteen-section hydration preserves native bytes without an ordering-only edit', async function () {
		this.timeout(15_000);
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-order-only-hydration-'));
		const filePath = path.join(tmpDir, 'noncanonical.kqlx');
		const uri = vscode.Uri.file(filePath);
		const sections: Array<Record<string, unknown>> = [
			...Array.from({ length: 5 }, (_, index) => ({
				id: `markdown_order_${index}`, type: 'markdown', title: `Notes ${index}`,
				text: `Synthetic notes ${index}`, tab: 'preview', mode: 'preview', expanded: false,
				futureSection: { second: 2, first: 1 },
			})),
			...Array.from({ length: 5 }, (_, index) => ({
				id: `query_order_${index}`, type: 'query', name: `Query ${index}`,
				clusterUrl: '', database: '', query: `print Synthetic=${index}`,
				expanded: true, resultsVisible: false, runMode: 'take100',
				cacheEnabled: true, cacheValue: 1, cacheUnit: 'days',
			})),
			...Array.from({ length: 4 }, (_, index) => ({
				id: `chart_order_${index}`, type: 'chart', name: `Chart ${index}`,
				dataSourceId: 'query_order_0', chartType: 'bar', xColumn: 'Category',
				yColumn: 'Value', yColumns: ['Value', 'Count'], editorHeightPx: 182, expanded: false,
			})),
		];
		const authoredBytes = Buffer.from(JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot: { second: 2, first: 1 }, state: { sections },
		}, null, 2) + '\n', 'utf8');
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		const subscriptions: vscode.Disposable[] = [];
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		let ownedEdits = 0;
		let sourceChanges = 0;
		let dirtyObserved = false;
		let document: vscode.TextDocument | undefined;
		try {
			fs.writeFileSync(filePath, authoredBytes);
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit, ...args: unknown[]) => {
				if (edit.entries().some(([target]) => target.toString() === uri.toString())) ownedEdits++;
				return originalApplyEdit.call(vscode.workspace, edit, ...args as []);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			document = await vscode.workspace.openTextDocument(uri);
			assert.strictEqual(liveDocuments.register(document), false);
			const initialVersion = document.version;
			subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document !== document) return;
				sourceChanges++;
				if (event.document.isDirty) dirtyObserved = true;
			}));
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) await Promise.resolve(receive?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: 0,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receive!({ type: 'requestDocument' }));
			assert.strictEqual(projection.state.sections.length, 14);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
			const state = JSON.parse(authoredBytes.toString('utf8')).state;
			state.sections = state.sections.map((section: Record<string, unknown>) =>
				Object.fromEntries(Object.keys(section).reverse().map(key => [key, section[key]])));
			assert.deepStrictEqual(state.sections, sections);
			await Promise.resolve(receive!({
				type: 'persistDocument', snapshotId: 'ordering-only-hydration', editRevision: 0,
				sourceGeneration: projection.sourceGeneration, state,
			}));
			assert.ok(posted.some(message => message.type === 'persistDocumentAck'
				&& message.snapshotId === 'ordering-only-hydration'));
			assert.strictEqual(ownedEdits, 0);
			assert.strictEqual(sourceChanges, 0);
			assert.strictEqual(dirtyObserved, false);
			assert.strictEqual(document.version, initialVersion);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(document.getText(), authoredBytes.toString('utf8'));
			assert.deepStrictEqual(fs.readFileSync(filePath), authoredBytes);

			state.sections[5].query = 'print Synthetic=99';
			await Promise.resolve(receive!({
				type: 'persistDocument', snapshotId: 'genuine-query-change', editRevision: 1,
				sourceGeneration: projection.sourceGeneration, state,
			}));
			assert.ok(posted.some(message => message.type === 'persistDocumentAck'
				&& message.snapshotId === 'genuine-query-change'));
			assert.ok(ownedEdits > 0, 'the real native edit interception must observe genuine authoring');
			assert.strictEqual(JSON.parse(document.getText()).state.sections[5].query, 'print Synthetic=99');
			assert.strictEqual(document.isDirty, true);
			await document.save();
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[5].query, 'print Synthetic=99');
		} finally {
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const subscription of subscriptions) subscription.dispose();
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			if (document?.isDirty) await document.save();
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const { acknowledgeFirst, retirement } of [
		{ acknowledgeFirst: true, retirement: 'none' },
		{ acknowledgeFirst: false, retirement: 'none' },
		{ acknowledgeFirst: false, retirement: 'source change' },
		{ acknowledgeFirst: false, retirement: 'same-byte version' },
		{ acknowledgeFirst: false, retirement: 'disposal' },
	] as const) {
		test(`retained native reload survives dispatcher overlap (acknowledge first=${acknowledgeFirst})${retirement === 'none' ? '' : ` with ${retirement}`}`, async function () {
			this.timeout(10_000);
			const originalInitialize = QueryEditorProvider.prototype.initializeWebviewPanel;
			const originalWait = KqlxEditorProvider.waitForOpenEditorInitialized;
			const originalSetTimeout = globalThis.setTimeout;
			const extensionModule = require('../../src/host/extension') as { toolOrchestrator?: KustoWorkbenchToolOrchestrator };
			const originalOrchestrator = Object.getOwnPropertyDescriptor(extensionModule, 'toolOrchestrator')!;
			const originalSingleton = Object.getOwnPropertyDescriptor(KustoWorkbenchToolOrchestrator, 'instance')!;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-retained-read-overlap-'));
			const uri = vscode.Uri.file(path.join(tmpDir, 'retained.kqlx'));
			const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../../..'));
			const subscriptions: vscode.Disposable[] = [];
			const secretChanges = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
			const cancellation = new vscode.CancellationTokenSource();
			const memento = () => {
				const values = new Map<string, unknown>();
				return {
					get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
					update: async (key: string, value: unknown) => { values.set(key, value); },
					keys: () => [...values.keys()], setKeysForSync: () => undefined,
				};
			};
			const context = {
				subscriptions, extensionUri, extensionPath: extensionUri.fsPath, extensionMode: vscode.ExtensionMode.Test,
				extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(extensionUri.fsPath, 'package.json'), 'utf8')) },
				globalState: memento(), workspaceState: memento(),
				globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global')),
				storageUri: vscode.Uri.file(path.join(tmpDir, 'storage')),
				logUri: vscode.Uri.file(path.join(tmpDir, 'logs')),
				asAbsolutePath: (relative: string) => path.join(extensionUri.fsPath, relative),
				secrets: { get: async () => undefined, store: async () => undefined,
					delete: async () => undefined, onDidChange: secretChanges.event },
			} as unknown as vscode.ExtensionContext;
			const note = { id: 'retained_note', created: '2026-10-07T00:00:00.000Z', updated: '2026-10-07T00:00:00.000Z',
				category: 'usage-note', content: 'Keep the original note readable.', source: 'agent' };
			const authoredBytes = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'retained_query', type: 'query', query: 'print Amount=10.5', expanded: false,
					resultJson: JSON.stringify({ columns: [{ name: 'Amount', type: 'real' }], rows: [[10.5]] }) },
				{ id: 'retained_notes', type: 'devnotes', entries: [note] },
				{ id: 'retained_html', type: 'html', code: '<p>Retained dashboard</p>', mode: 'preview', expanded: false },
			] } }, null, 2) + '\n');
			const disposalHandlers = new Set<() => unknown>();
			const viewHandlers = new Set<() => unknown>();
			const incoming = new Set<Promise<unknown>>();
			const transportErrors: unknown[] = [];
			const projections: Array<{ reloadRequestId: string; sourceGeneration: number; state: { sections: unknown[] } }> = [];
			const probes: string[] = [];
			let receive: ((message: unknown) => unknown) | undefined;
			let queryEditor: QueryEditorProvider | undefined;
			let runtimeProjection: typeof projections[number] | undefined;
			let armed = false;
			let sanitationCalls = 0;
			let sanitationHeld = false;
			let holdProbe = false;
			let revealCount = 0;
			let disposed = false;
			let sourceChanges = 0;
			let document: vscode.TextDocument | undefined;
			let failed = false;
			let captureReadTimer = false;
			const nativeReadTimers: Array<{ handle: ReturnType<typeof setTimeout>; expire(): void }> = [];
			let releaseSanitation!: () => void;
			const sanitation = new Promise<void>(resolve => { releaseSanitation = resolve; });
			const send = (message: unknown): Promise<unknown> => {
				assert.ok(receive, 'the actual gateway must install its listener');
				const work = Promise.resolve(receive(message));
				incoming.add(work);
				void work.then(() => incoming.delete(work), error => { transportErrors.push(error); incoming.delete(work); });
				return work;
			};
			const panelState = { visible: true, active: true };
			const panel = {
				viewType: KqlxEditorProvider.viewType,
				get visible() { return panelState.visible; }, get active() { return panelState.active; },
				reveal: () => { revealCount++; },
				webview: {
					options: {}, html: '', cspSource: 'vscode-webview://retained-read-overlap', asWebviewUri: (value: vscode.Uri) => value,
					postMessage: async (message: Record<string, unknown>) => {
						if (message.type === 'documentData') {
							assert.strictEqual(message.ok, true, 'the unchanged fixture must have a valid projection');
							runtimeProjection = message as unknown as typeof projections[number];
							projections.push(runtimeProjection);
							await send({ type: 'documentReloadResult', requestId: message.reloadRequestId, applied: true, editRevision: 0 });
						} else if (message.type === 'mainWebviewDispatcherProbe') {
							assert.strictEqual(typeof message.probeId, 'string');
							probes.push(message.probeId as string);
							if (!holdProbe) await send({ type: 'mainWebviewDispatcherReady', runtimeId: 'retained-runtime', probeId: message.probeId });
						} else if (message.type === 'requestToolState') {
							assert.ok(runtimeProjection, 'state replies must derive from the actually delivered projection');
							assert.ok(typeof message.requestId === 'string');
							const response = createToolStateResponseMessage(message.requestId, runtimeProjection.state.sections);
							assert.ok(response.ok);
							await send(response.value);
						} else if (message.type === 'toolGetHtmlDashboardContext') {
							assert.ok(runtimeProjection);
							const html = runtimeProjection.state.sections.find(section =>
								(section as { id?: string }).id === message.sectionId) as { id: string; code: string };
							assert.ok(html);
							await send({ type: 'toolResponse', requestId: message.requestId, result: {
								success: true, sectionId: html.id, code: html.code, hasProvenance: false,
								bindingCount: 0, dataSources: [], factColumns: [],
							} });
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
						receive = wrapDocumentViewTestReceiver(handler, () => runtimeProjection);
						return new vscode.Disposable(() => { receive = undefined; });
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
					if (disposed) return;
					disposed = true;
					for (const handler of [...disposalHandlers]) handler();
				},
			} as unknown as vscode.WebviewPanel;
			const setVisible = (visible: boolean) => {
				panelState.visible = visible;
				panelState.active = visible;
				for (const handler of viewHandlers) handler();
			};
			try {
				fs.writeFileSync(uri.fsPath, authoredBytes);
				document = await vscode.workspace.openTextDocument(uri);
				assert.strictEqual(liveDocuments.register(document), false);
				const version = document.version;
				subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
					if (event.document === document && event.contentChanges.length > 0) sourceChanges++;
				}));
				QueryEditorProvider.prototype.initializeWebviewPanel = async function (targetPanel, options) {
					assert.strictEqual(targetPanel, panel);
					queryEditor = this;
					const originalSanitize = this.sanitizeSqlLeaveNoTraceStateFresh.bind(this);
					this.sanitizeSqlLeaveNoTraceStateFresh = async (state, onKustoSanitized) => {
						const result = await originalSanitize(state, onKustoSanitized);
						if (armed && ++sanitationCalls === 2) {
							sanitationHeld = true;
							await sanitation;
						}
						return result;
					};
					await originalInitialize.call(this, targetPanel, options);
				};
				const connections = connectionManagerStub();
				const sqlWorkbench = sqlWorkbenchStub();
				Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', { ...originalSingleton, value: undefined });
				const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(context, connections,
					() => sqlWorkbench.connectionManager, {} as never);
				extensionModule.toolOrchestrator = orchestrator;
				const readAccess = () => Promise.all([
					orchestrator.manageDevelopmentNotes({ action: 'view', targetFileUri: uri.toString() }),
					orchestrator.validateHtmlDashboard({ sectionId: 'retained_html', targetFileUri: uri.toString() }),
				]);
				deferMainWebviewReadyForTest(panel);
				const provider = new (KqlxEditorProvider as any)(context, extensionUri, connections, sqlWorkbench) as KqlxEditorProvider;
				await provider.resolveCustomTextEditor(document, panel, cancellation.token);
				await send({ type: 'mainWebviewDispatcherReady', runtimeId: 'retained-runtime' });
				await send({ type: 'requestDocument' });
				assert.ok(queryEditor);
				assert.strictEqual(projections.length, 1);
				const expectedState = createToolStateResponseMessage('expected-retained-state', runtimeProjection!.state.sections);
				assert.ok(expectedState.ok);
				assert.deepStrictEqual(await queryEditor.requestSectionsFromWebview(), expectedState.value.sections);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
				const baseline = await readAccess();
				assert.strictEqual(baseline[0].success, true);
				assert.deepStrictEqual(JSON.parse(JSON.stringify(baseline[0].notes)), [note]);
				assert.strictEqual(baseline[1].success, true);
				assert.strictEqual(baseline[1].valid, false, 'the fixture has no provenance or active-content permission');
				assert.ok(baseline[1].issues.length > 0);
				setVisible(false);
				armed = true;
				const reload = send({ type: 'requestDocument', requestId: 'retained-source-reconciliation' });
				await waitForCondition(() => sanitationHeld, 'the established reload must reach final sanitation', 1_000);
				holdProbe = true;
				setVisible(true);
				const probeId = probes.at(-1)!;
				setVisible(false);
				if (!acknowledgeFirst) {
					releaseSanitation();
					for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve));
				}
				const expectedQuery = retirement === 'source change' ? 'print Amount=20.5' : 'print Amount=10.5';
				if (retirement === 'source change' || retirement === 'same-byte version') {
					const replaceQuery = async (query: string) => {
						assert.ok(document);
						const text = document.getText();
						const current = JSON.parse(text).state.sections[0].query as string;
						const offset = text.indexOf(current);
						assert.ok(offset >= 0);
						const edit = new vscode.WorkspaceEdit();
						edit.replace(uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + current.length)), query);
						assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
					};
					await replaceQuery('print Amount=20.5');
					if (retirement === 'same-byte version') await replaceQuery('print Amount=10.5');
					assert.ok(document.version > version);
				}
				const expectedVersion = document.version;
				const expectedDirty = document.isDirty;
				const expectedText = document.getText();
				const acknowledge = receive!;
				if (retirement === 'disposal') panel.dispose();
				await acknowledge({ type: 'mainWebviewDispatcherReady', runtimeId: 'retained-runtime', probeId });
				holdProbe = false;
				releaseSanitation();
				await reload;
				if (retirement === 'disposal') {
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
					assert.strictEqual(projections.length, 1, 'late readiness cannot deliver a retired projection');
					assert.deepStrictEqual(fs.readFileSync(uri.fsPath), authoredBytes);
					assert.strictEqual(document.getText(), authoredBytes.toString('utf8'));
					assert.strictEqual(document.version, version);
					assert.strictEqual(document.isDirty, false);
					assert.strictEqual(sourceChanges, 0);
					assert.strictEqual(revealCount, 0);
					assert.deepStrictEqual(transportErrors, []);
					return;
				}
				if (retirement !== 'none') {
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 2_000, panel), true);
					assert.ok(runtimeProjection!.sourceGeneration > 2, 'the old queued generation must not be revived');
					assert.strictEqual((runtimeProjection!.state.sections[0] as { query: string }).query, expectedQuery);
				}
				const ready = await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel);
				globalThis.setTimeout = ((callback: (...parameters: unknown[]) => void, delay?: number, ...parameters: unknown[]) => {
					const handle = originalSetTimeout(callback, delay, ...parameters);
					if (captureReadTimer) {
						assert.ok(typeof delay === 'number' && delay > 0 && delay <= 30_000);
						nativeReadTimers.push({ handle, expire: () => callback(...parameters) });
					}
					return handle;
				}) as typeof setTimeout;
				KqlxEditorProvider.waitForOpenEditorInitialized = (...args) => {
					const previous = captureReadTimer;
					captureReadTimer = args[0].toString() === uri.toString() && (args[1] ?? 30_000) > 0;
					try { return originalWait(...args); }
					finally { captureReadTimer = previous; }
				};
				let readsSettled = false;
				const after = readAccess().then(result => { readsSettled = true; return result; });
				await waitForCondition(() => readsSettled || nativeReadTimers.length > 0,
					'the exact public reads must settle or reach the native readiness deadline', 1_000);
				for (const timer of nativeReadTimers) timer.expire();
				const observed = await after;
				console.log('[retained-native-read-overlap]', JSON.stringify({ acknowledgeFirst, retirement, ready,
					projections: projections.length, nativeReadDeadlines: nativeReadTimers.length,
					notes: { success: observed[0].success, error: observed[0].error },
					dashboard: { success: observed[1].success, valid: observed[1].valid, error: observed[1].error } }));
				assert.deepStrictEqual(fs.readFileSync(uri.fsPath), authoredBytes);
				assert.strictEqual(document.getText(), expectedText);
				assert.strictEqual(document.version, expectedVersion);
				assert.strictEqual(document.isDirty, expectedDirty);
				assert.strictEqual(sourceChanges, retirement === 'source change' ? 1 : retirement === 'same-byte version' ? 2 : 0);
				assert.strictEqual(panel.visible, false);
				assert.strictEqual(revealCount, 0);
				assert.deepStrictEqual(transportErrors, []);
				assert.deepStrictEqual(observed, baseline, 'the first public note and dashboard reads must remain available');
				assert.strictEqual(ready, true, 'the acknowledged dispatcher must not strand the unchanged native document generation');
				const expectedSections = expectedState.value.sections.map(section => section.id === 'retained_query'
					? { ...section, query: expectedQuery } : section);
				const currentExpected = createToolStateResponseMessage('expected-current-retained-state', expectedSections);
				assert.ok(currentExpected.ok);
				assert.deepStrictEqual(await queryEditor.requestSectionsFromWebview(), currentExpected.value.sections);
				assert.strictEqual(projections.length, 2, 'the same reload must finish without a replacement request or retry');
			} catch (error) {
				failed = true;
				throw error;
			} finally {
				try {
					releaseSanitation();
					panel.dispose();
					await Promise.allSettled([...incoming]);
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true,
						`native close must finish before fixture deletion; retained at ${tmpDir}`);
				} finally {
					QueryEditorProvider.prototype.initializeWebviewPanel = originalInitialize;
					KqlxEditorProvider.waitForOpenEditorInitialized = originalWait;
					globalThis.setTimeout = originalSetTimeout;
					for (const timer of nativeReadTimers) clearTimeout(timer.handle);
					Object.defineProperty(extensionModule, 'toolOrchestrator', originalOrchestrator);
					Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', originalSingleton);
					for (const subscription of subscriptions) subscription.dispose();
					secretChanges.dispose();
					cancellation.dispose();
				}
				if (document?.isDirty) assert.strictEqual(await document.save(), true);
				const ownedTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
					(tab.input as { uri?: vscode.Uri }).uri?.toString() === uri.toString());
				assert.ok(ownedTabs.every(tab => !tab.isDirty), 'cleanup cannot discard an authored private fixture');
				if (ownedTabs.length) assert.strictEqual(await vscode.window.tabGroups.close(ownedTabs), true);
				if (failed) console.log('[retained-native-read-overlap] retained failed fixture:', tmpDir);
				else if (retirement === 'source change' || retirement === 'same-byte version') {
					console.log('[retained-native-read-overlap] retained authored fixture for native history:', tmpDir);
				}
				else fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			}
		});
	}

	for (const { fileType, configureOnly } of [
		{ fileType: 'kqlx', configureOnly: false },
		{ fileType: 'sqlx', configureOnly: false },
		{ fileType: 'sqlx', configureOnly: true },
	] as const) {
		test(`background-created ${fileType} ${configureOnly ? 'configuration-only' : 'first removal'} survives native Save and reopen`, async function () {
			this.timeout(15_000);
			const originalExecuteCommand = Object.getOwnPropertyDescriptor(vscode.commands, 'executeCommand')!;
			const originalInitialize = Object.getOwnPropertyDescriptor(QueryEditorProvider.prototype, 'initializeWebviewPanel')!;
			const extensionModule = require('../../src/host/extension') as { toolOrchestrator?: KustoWorkbenchToolOrchestrator };
			const originalOrchestrator = Object.getOwnPropertyDescriptor(extensionModule, 'toolOrchestrator')!;
			const originalSingleton = Object.getOwnPropertyDescriptor(KustoWorkbenchToolOrchestrator, 'instance')!;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-background-first-removal-'));
			const uri = vscode.Uri.file(path.join(tmpDir, `report.${fileType}`));
			const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../../..'));
			const subscriptions: vscode.Disposable[] = [];
			const secretChanges = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
			const cancellation = new vscode.CancellationTokenSource();
			const initialTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
			const documents = new Set<vscode.TextDocument>();
			const panels: vscode.WebviewPanel[] = [];
			const incoming = new Set<Promise<unknown>>();
			const transportErrors: unknown[] = [];
			const memento = () => {
				const values = new Map<string, unknown>();
				return {
					get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
					update: async (key: string, value: unknown) => { values.set(key, value); },
					keys: () => [...values.keys()], setKeysForSync: () => undefined,
				};
			};
			const context = {
				subscriptions, extensionUri, extensionPath: extensionUri.fsPath, extensionMode: vscode.ExtensionMode.Test,
				extension: { packageJSON: JSON.parse(fs.readFileSync(path.join(extensionUri.fsPath, 'package.json'), 'utf8')) },
				globalState: memento(), workspaceState: memento(),
				globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global')),
				storageUri: vscode.Uri.file(path.join(tmpDir, 'storage')),
				logUri: vscode.Uri.file(path.join(tmpDir, 'logs')),
				asAbsolutePath: (relative: string) => path.join(extensionUri.fsPath, relative),
				secrets: { get: async () => undefined, store: async () => undefined,
					delete: async () => undefined, onDidChange: secretChanges.event },
			} as unknown as vscode.ExtensionContext;
			type FixtureState = { sections: Array<{ id?: string; type: string; query?: string; [key: string]: unknown }> };
			type FixtureProjection = {
				state: FixtureState; reloadRequestId: string; sourceGeneration: number;
				documentRevision: number; viewSessionId: string;
			};
			let revealCount = 0;
			let openCount = 0;
			let failed = false;
			const languageOpens: Array<{ boxId: string; text: string }> = [];
			const languageConnections: Array<{ boxId: string; database: string }> = [];
			try {
				assert.strictEqual(fs.existsSync(uri.fsPath), false, 'the fixture must never overwrite an existing file');
				const connections = connectionManagerStub();
				const sqlWorkbench = sqlWorkbenchStub();
				const sqlConnection = { id: 'sql-native-configure', name: 'Native SQL', serverUrl: 'native-sql.example',
					dialect: 'mssql', authType: 'sql-login', username: 'fixture' };
				if (configureOnly) {
					sqlWorkbench.connectionManager.getConnections = () => [{ ...sqlConnection }];
					sqlWorkbench.connectionManager.getConnection = (id: string) => id === sqlConnection.id ? { ...sqlConnection } : undefined;
					sqlWorkbench.connectionManager.assertConnectionCurrent = async () => undefined;
					sqlWorkbench.serverAccountMap = { refresh: async () => undefined, getAccountsByServer: () => ({}) };
					sqlWorkbench.leaveNoTracePolicy = { getRevocationGeneration: () => 0 };
					sqlWorkbench.dispatchSqlOwnerAllowed = async (_connection: unknown, _principal: string, _revocation: number, dispatch: () => unknown) => dispatch();
					sqlWorkbench.runtime.getProcessManager = async () => ({ offline: true });
					const createLanguageService = (): SqlEditorLanguageService => ({
						onDiagnostics: () => undefined,
						getCompletions: async () => { throw new Error('Unexpected completion request'); },
						getHover: async () => { throw new Error('Unexpected hover request'); },
						getSignatureHelp: async () => { throw new Error('Unexpected signature request'); },
						openDocument: async (boxId, text, connection, owner) => {
							assert.deepStrictEqual(connection, sqlConnection);
							assert.ok(owner?.sectionInstanceId);
							languageOpens.push({ boxId, text });
							return vscode.Uri.file(path.join(tmpDir, `${boxId}.sql`)).toString();
						},
						connectDocument: async (boxId, connection, database, owner) => {
							assert.deepStrictEqual(connection, sqlConnection);
							assert.ok(owner?.sectionInstanceId);
							languageConnections.push({ boxId, database });
						},
						changeDocument: async () => undefined,
						closeDocumentForOwner: () => true, closeDocumentUriForOwner: () => true,
						dispose: () => undefined,
					});
					Object.defineProperty(QueryEditorProvider.prototype, 'initializeWebviewPanel', {
						...originalInitialize,
						value: function (this: QueryEditorProvider, ...args: unknown[]) {
							const options = Reflect.get(Reflect.get(this, 'sqlLifecycle'), 'options') as SqlEditorLifecycleCoordinatorOptions;
							if (options.context === context) options.createLanguageService = createLanguageService;
							return originalInitialize.value.apply(this, args);
						},
					});
				}
				Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', { ...originalSingleton, value: undefined });
				const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(context, connections,
					() => sqlWorkbench.connectionManager, {} as never);
				extensionModule.toolOrchestrator = orchestrator;
				const provider = new (KqlxEditorProvider as unknown as new (...args: unknown[]) => KqlxEditorProvider)(
					context, extensionUri, connections, sqlWorkbench, undefined, undefined,
					(target: vscode.Uri) => orchestrator.isHostOwnedBackgroundFile(target),
					(target: vscode.Uri) => orchestrator.transferBackgroundOwnershipOnUserInteraction(target),
				);
				const openFixture = async () => {
					const document = await vscode.workspace.openTextDocument(uri);
					documents.add(document);
					assert.strictEqual(liveDocuments.register(document), false, 'the backing document must be native');
					const posted: Array<Record<string, unknown>> = [];
					const disposalHandlers = new Set<() => unknown>();
					let receive: ((message: unknown) => unknown) | undefined;
					let projection: FixtureProjection | undefined;
					let state: FixtureState | undefined;
					let editRevision = 0;
					let snapshotSequence = 0;
					const removalResponses = new Map<string, string>();
					let disposed = false;
					const runtimeId = `background-removal-${fileType}-${panels.length}`;
					const send = (message: unknown): Promise<unknown> => {
						assert.ok(receive, 'the actual startup gateway must install its listener');
						const work = Promise.resolve(receive(message));
						incoming.add(work);
						void work.then(() => incoming.delete(work), error => { transportErrors.push(error); incoming.delete(work); });
						return work;
					};
					const persist = async (flushRequestId?: unknown, toolRequestId?: string) => {
						assert.ok(projection);
						assert.ok(state);
						const snapshotId = `${runtimeId}-${++snapshotSequence}`;
						if (toolRequestId) removalResponses.set(snapshotId, toolRequestId);
						await send({
							type: 'persistDocument', state: structuredClone(state),
							sourceGeneration: projection.sourceGeneration, editRevision, snapshotId,
							...(typeof flushRequestId === 'string' ? { flushRequestId } : {}),
						});
						const acknowledgement = posted.find(message => message.type === 'persistDocumentAck'
							&& message.snapshotId === snapshotId);
						assert.ok(acknowledgement, 'the native owner must admit the exact simulated webview snapshot');
						return acknowledgement;
					};
					const panel = {
						viewType: KqlxEditorProvider.viewType, visible: false, active: false,
						reveal: () => { revealCount++; },
						webview: {
							options: {}, html: '', cspSource: 'vscode-webview://background-first-removal',
							asWebviewUri: (value: vscode.Uri) => value,
							postMessage: async (message: Record<string, unknown>) => {
								posted.push(message);
								if (message.type === 'documentData') {
									assert.strictEqual(message.ok, true);
									projection = message as unknown as FixtureProjection;
									state = structuredClone(projection.state);
									await send({ type: 'documentReloadResult', requestId: projection.reloadRequestId,
										applied: true, editRevision, markdownCommandBarrierSupported: true });
								} else if (message.type === 'mainWebviewDispatcherProbe') {
									await send({ type: 'mainWebviewDispatcherReady', runtimeId, probeId: message.probeId });
								} else if (message.type === 'requestToolState') {
									assert.ok(state);
									assert.strictEqual(typeof message.requestId, 'string');
									const response = createToolStateResponseMessage(message.requestId as string, state.sections);
									assert.ok(response.ok);
									await send(response.value);
								} else if (message.type === 'toolRemoveSection') {
									assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), false,
										'the real orchestrator must transfer ownership before its first live removal');
									assert.ok(state);
									const index = state.sections.findIndex(section => section.id === message.sectionId);
									assert.ok(index >= 0, 'removal must target an actually delivered native section ID');
									state.sections.splice(index, 1);
									editRevision++;
									void persist(undefined, String(message.requestId)).catch(error => { transportErrors.push(error); });
								} else if (configureOnly && message.type === 'toolConfigureSqlSection') {
									assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), false);
									assert.ok(state);
									const input = message.input as { sectionId: string; name: string; execute: boolean };
									assert.strictEqual(input.execute, false);
									assert.strictEqual(typeof input.name, 'string');
									const section = state.sections.find(candidate => candidate.id === input.sectionId && candidate.type === 'sql');
									assert.ok(section, 'live configuration must target the exact restored SQL section');
									section.name = input.name;
									editRevision++;
									void persist(undefined, String(message.requestId)).catch(error => { transportErrors.push(error); });
								} else if (message.type === 'persistDocumentAck') {
									const requestId = removalResponses.get(String(message.snapshotId));
									if (requestId) {
										removalResponses.delete(String(message.snapshotId));
										await send({ type: 'toolResponse', requestId, result: { success: true } });
									}
								} else if (message.type === 'requestMarkdownCommandBarrier') {
									assert.ok(projection);
									await send({ type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
										sourceGeneration: projection.sourceGeneration,
										documentRevision: projection.documentRevision, accepted: true });
								} else if (message.type === 'requestFinalPersist') {
									await persist(message.requestId);
								}
								return true;
							},
							onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
								receive = wrapDocumentViewTestReceiver(handler, () => projection);
								return new vscode.Disposable(() => { receive = undefined; });
							},
						},
						onDidDispose: (handler: () => unknown) => {
							disposalHandlers.add(handler);
							return new vscode.Disposable(() => { disposalHandlers.delete(handler); });
						},
						onDidChangeViewState: () => new vscode.Disposable(() => undefined),
						dispose: () => {
							if (disposed) return;
							disposed = true;
							for (const handler of [...disposalHandlers]) handler();
						},
					} as unknown as vscode.WebviewPanel;
					panels.push(panel);
					deferMainWebviewReadyForTest(panel);
					await provider.resolveCustomTextEditor(document, panel, cancellation.token);
					await send({ type: 'mainWebviewDispatcherReady', runtimeId });
					await send({ type: 'requestDocument' });
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
					if (configureOnly) {
						assert.ok(state);
						for (const section of state.sections) {
							if (section.type !== 'sql') continue;
							assert.ok(section.id);
							const sectionInstanceId = `${runtimeId}-${section.id}`;
							await send({ type: 'sqlSectionOpen', boxId: section.id, sectionInstanceId });
							await send({ type: 'stsDidOpen', boxId: section.id, sectionInstanceId, text: section.query ?? '' });
							if (!section.connectionIdHint || !section.database) continue;
							await send({ type: 'stsConnect', boxId: section.id, sectionInstanceId,
								sqlConnectionId: section.connectionIdHint, database: section.database, targetGeneration: 1 });
							assert.ok(posted.some(message => message.type === 'stsConnectionState' && message.boxId === section.id
								&& message.sectionInstanceId === sectionInstanceId && message.state === 'ready'
								&& typeof message.ownerToken === 'string' && message.ownerToken.length > 0),
								'the real restored SQL lifecycle must publish a ready owner');
						}
					}
					return {
						document, panel, posted, send,
						get state() { assert.ok(state); return state; },
						get projection() { assert.ok(projection); return projection; },
					};
				};
				let current: Awaited<ReturnType<typeof openFixture>> | undefined;
				Object.defineProperty(vscode.commands, 'executeCommand', {
					...originalExecuteCommand,
					value: async (command: string, ...args: unknown[]) => {
						if (command !== 'vscode.openWith') return originalExecuteCommand.value.call(vscode.commands, command, ...args);
						assert.strictEqual((args[0] as vscode.Uri).toString(), uri.toString());
						assert.strictEqual(args[1], KqlxEditorProvider.viewType);
						assert.deepStrictEqual(args[2], { preview: false, preserveFocus: true });
						openCount++;
						current = await openFixture();
						return undefined;
					},
				});
				const seedQuery = fileType === 'sqlx' ? 'SELECT 7 AS Value' : 'print Value=7';
				const created = await orchestrator.createFile({ fileType, filePath: uri.fsPath, initialContent: seedQuery, reveal: false });
				assert.strictEqual(created.success, true, JSON.stringify(created));
				assert.strictEqual(created.openRequested, true);
				assert.strictEqual(created.warning, undefined, JSON.stringify(created));
				assert.ok(current);
				const first = current;
				assert.strictEqual(first.state.sections.length, 1);
				assert.strictEqual(first.state.sections[0].query, seedQuery);
				const createdBytes = fs.readFileSync(uri.fsPath);
				const createdVersion = first.document.version;
				const saved = await orchestrator.saveWorkbenchFile({ targetFileUri: uri.toString() });
				assert.strictEqual(saved.success, true, JSON.stringify(saved));
				assert.ok(saved.openFileId);
				const listed = await orchestrator.listSections();
				const liveFile = listed.openFiles?.find(file => file.openFileId === saved.openFileId);
				assert.ok(liveFile);
				assert.strictEqual(liveFile.isLiveWorkbench, true);
				assert.strictEqual(liveFile.isReadOnlyFallback, false);
				const sectionId = liveFile.sections?.[0]?.id;
				assert.ok(sectionId);
				assert.strictEqual(sectionId, first.state.sections[0].id, 'LIST must expose the exact delivered native section ID');
				assert.deepStrictEqual(liveFile.sections?.map(section => section.id), [sectionId]);
				if (fileType === 'sqlx') assert.deepStrictEqual(liveFile.sections, [{ id: sectionId, type: 'sql' }]);
				assert.ok(first.posted.some(message => message.type === 'requestToolState'));
				assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), true, 'Save and live listing must not transfer ownership');
				assert.strictEqual(first.document.version, createdVersion);
				assert.strictEqual(first.document.isDirty, false);
				assert.deepStrictEqual(fs.readFileSync(uri.fsPath), createdBytes);
				const unownedSnapshotId = `unowned-${fileType}-automatic-snapshot`;
				await first.send({
					type: 'persistDocument', state: { ...structuredClone(first.state), sections: [] },
					sourceGeneration: first.projection.sourceGeneration, editRevision: 1,
					snapshotId: unownedSnapshotId, reason: 'section-remove',
				});
				assert.strictEqual(first.posted.some(message => message.type === 'persistDocumentAck'
					&& message.snapshotId === unownedSnapshotId), false, 'an automatic snapshot cannot claim background ownership');
				assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), true);
				assert.strictEqual(first.document.version, createdVersion);
				assert.strictEqual(first.document.isDirty, false);
				assert.strictEqual(first.document.getText(), createdBytes.toString('utf8'));
				assert.deepStrictEqual(fs.readFileSync(uri.fsPath), createdBytes);
				assert.strictEqual(first.posted.some(message => message.type === 'requestFinalPersist'
					|| message.type === 'requestMarkdownCommandBarrier'), false, 'background Save must remain source-only');
				if (configureOnly) {
					assert.strictEqual(JSON.parse(first.document.getText()).state.sections[0].id, undefined);
					assert.deepStrictEqual(await orchestrator.configureSqlSection({ openFileId: saved.openFileId, sectionId,
						query: seedQuery, execute: false }), { success: true });
					assert.strictEqual(first.document.version, createdVersion, 'a no-op cannot materialize the native ID');
					assert.strictEqual(first.document.isDirty, false);
					assert.strictEqual(first.document.getText(), createdBytes.toString('utf8'));
					assert.deepStrictEqual(await orchestrator.configureSqlSection({ openFileId: saved.openFileId, sectionId,
						name: 'Configured probe', connectionId: sqlConnection.id, database: 'ProbeDb', execute: false }), { success: true });
					const configured = JSON.parse(first.document.getText()).state.sections[0];
					assert.strictEqual(configured.id, sectionId, 'a source mutation must persist the exact public native ID');
					assert.strictEqual(configured.query, seedQuery);
					assert.strictEqual(configured.name, 'Configured probe');
					assert.strictEqual(configured.connectionIdHint, sqlConnection.id);
					assert.strictEqual(configured.serverUrl, sqlConnection.serverUrl);
					assert.strictEqual(configured.database, 'ProbeDb');
					const other = await orchestrator.addSection({ openFileId: saved.openFileId, type: 'sql', name: 'Untouched peer' });
					assert.ok(other.sectionId);
					assert.deepStrictEqual(await orchestrator.configureSqlSection({ openFileId: saved.openFileId,
						sectionId: other.sectionId, query: 'SELECT 2 AS Other', execute: false }), { success: true });
					const savedConfiguration = await orchestrator.saveWorkbenchFile({ openFileId: saved.openFileId });
					assert.strictEqual(savedConfiguration.success, true, JSON.stringify(savedConfiguration));
					assert.strictEqual(savedConfiguration.saved, true);
					assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), true, 'configure-only and Save cannot transfer ownership');
					assert.strictEqual(first.document.isDirty, false);
					const configuredBytes = fs.readFileSync(uri.fsPath);
					assert.strictEqual(first.document.getText(), configuredBytes.toString('utf8'));
					const savedSections = JSON.parse(configuredBytes.toString('utf8')).state.sections;
					assert.deepStrictEqual(savedSections.map((section: { id: string }) => section.id), [sectionId, other.sectionId]);
					assert.deepStrictEqual(savedSections[0], configured);
					assert.strictEqual(savedSections[1].query, 'SELECT 2 AS Other');
					assert.deepStrictEqual(languageOpens, []);
					assert.deepStrictEqual(languageConnections, []);
					assert.strictEqual(first.posted.some(message => message.type === 'toolConfigureSqlSection'
						|| message.type === 'toolRemoveSection'), false);
					const firstViewSession = first.projection.viewSessionId;
					first.panel.dispose();
					await orchestrator.handleTabsClosed([{
						input: new vscode.TabInputCustom(uri, KqlxEditorProvider.viewType),
					} as vscode.Tab]);
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true);
					assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), false,
						'closing the exact SQL tab must retire background ownership before reopen');
					assert.deepStrictEqual(fs.readFileSync(uri.fsPath), configuredBytes);
					await vscode.commands.executeCommand('vscode.openWith', uri, KqlxEditorProvider.viewType,
						{ preview: false, preserveFocus: true });
					assert.ok(current);
					const reopened = current;
					assert.notStrictEqual(reopened.projection.viewSessionId, firstViewSession);
					assert.deepStrictEqual(reopened.state.sections.map(section => section.id), [sectionId, other.sectionId]);
					assert.strictEqual(reopened.state.sections[0].id, sectionId, 'reopen must preserve the ID originally advertised by LIST');
					assert.strictEqual(reopened.state.sections[0].query, seedQuery);
					assert.strictEqual(reopened.state.sections[0].name, 'Configured probe');
					assert.strictEqual(reopened.document.getText(), configuredBytes.toString('utf8'));
					assert.strictEqual(reopened.document.isDirty, false);
					assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), false);
					assert.deepStrictEqual(languageOpens, [{ boxId: sectionId, text: seedQuery }]);
					assert.deepStrictEqual(languageConnections, [{ boxId: sectionId, database: 'ProbeDb' }]);
					const stateRequests = reopened.posted.filter(message => message.type === 'requestToolState').length;
					assert.deepStrictEqual(await orchestrator.configureSqlSection({ openFileId: saved.openFileId, sectionId,
						name: 'Configured after reopen', execute: false }), { success: true });
					assert.deepStrictEqual(reopened.state.sections[0], { ...configured, name: 'Configured after reopen' });
					assert.deepStrictEqual(reopened.state.sections[1], savedSections[1]);
					assert.strictEqual(reopened.posted.filter(message => message.type === 'requestToolState').length, stateRequests,
						'an ordinary persisted ID must not need another structural proof');
					const savedAgain = await orchestrator.saveWorkbenchFile({ openFileId: saved.openFileId });
					assert.strictEqual(savedAgain.success, true, JSON.stringify(savedAgain));
					assert.strictEqual(savedAgain.saved, true);
					const finalBytes = fs.readFileSync(uri.fsPath, 'utf8');
					assert.strictEqual(reopened.document.getText(), finalBytes);
					assert.strictEqual(reopened.document.isDirty, false);
					const finalSections = JSON.parse(finalBytes).state.sections;
					assert.strictEqual(finalSections.length, 2);
					assert.deepStrictEqual(finalSections[0], { ...configured, name: 'Configured after reopen' });
					assert.deepStrictEqual(finalSections[1], savedSections[1], 'later configuration cannot change another section');
					assert.strictEqual(orchestrator.isHostOwnedBackgroundFile(uri), false);
					const liveConfigurations = reopened.posted.filter(message => message.type === 'toolConfigureSqlSection');
					assert.strictEqual(liveConfigurations.length, 1);
					assert.strictEqual((liveConfigurations[0].input as { sectionId: string }).sectionId, sectionId);
					assert.strictEqual(reopened.posted.some(message => message.type === 'toolRemoveSection'), false);
					assert.ok(first.posted.some(message => message.type === 'requestFinalPersist'), 'SQL-only native Save retains its adapter snapshot');
					assert.ok(reopened.posted.some(message => message.type === 'requestFinalPersist'), 'post-reopen Save retains its adapter snapshot');
					assert.strictEqual(openCount, 2);
					assert.strictEqual(revealCount, 0);
					assert.deepStrictEqual(transportErrors, []);
					return;
				}
				const removed = await orchestrator.removeSection({ openFileId: saved.openFileId, sectionId });
				assert.strictEqual(removed.success, true);
				const savedRemoval = await orchestrator.saveWorkbenchFile({ openFileId: saved.openFileId });
				assert.strictEqual(savedRemoval.success, true, JSON.stringify(savedRemoval));
				assert.strictEqual(savedRemoval.saved, true, 'public Save must commit the acknowledged removal');
				assert.strictEqual(first.document.isDirty, false);
				assert.deepStrictEqual(JSON.parse(first.document.getText()).state.sections, []);
				assert.deepStrictEqual(JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')).state.sections, []);
				assert.deepStrictEqual(first.state.sections, []);
				assert.strictEqual(first.posted.filter(message => message.type === 'toolRemoveSection').length, 1);
				assert.ok(first.posted.some(message => message.type === 'requestMarkdownCommandBarrier'));
				assert.ok(first.posted.some(message => message.type === 'requestFinalPersist'));
				const emptyBytes = fs.readFileSync(uri.fsPath);
				const firstViewSession = first.projection.viewSessionId;
				first.panel.dispose();
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true);
				assert.deepStrictEqual(fs.readFileSync(uri.fsPath), emptyBytes);
				await vscode.commands.executeCommand('vscode.openWith', uri, KqlxEditorProvider.viewType,
					{ preview: false, preserveFocus: true });
				assert.ok(current);
				const reopened = current;
				assert.notStrictEqual(reopened.projection.viewSessionId, firstViewSession);
				assert.strictEqual(reopened.state.sections.length, 1, 'an authored empty notebook projects its implicit starter');
				const starter = reopened.state.sections[0];
				assert.strictEqual(starter.type, fileType === 'sqlx' ? 'sql' : 'query');
				assert.strictEqual(starter.query ?? '', '', 'the removed seed must not return on reopen');
				assert.strictEqual(reopened.document.isDirty, false);
				assert.deepStrictEqual(fs.readFileSync(uri.fsPath), emptyBytes, 'starter hydration must not rewrite authored empty bytes');
				assert.ok(starter.id);
				assert.strictEqual((await orchestrator.removeSection({ openFileId: saved.openFileId, sectionId: starter.id })).success, true);
				const savedAgain = await orchestrator.saveWorkbenchFile({ openFileId: saved.openFileId });
				assert.strictEqual(savedAgain.success, true, JSON.stringify(savedAgain));
				assert.deepStrictEqual(JSON.parse(fs.readFileSync(uri.fsPath, 'utf8')).state.sections, []);
				assert.strictEqual(reopened.document.isDirty, false);
				assert.strictEqual(openCount, 2);
				assert.strictEqual(revealCount, 0, 'no operation may activate or reveal either mock panel');
				assert.deepStrictEqual(transportErrors, []);
			} catch (error) {
				failed = true;
				throw error;
			} finally {
				try {
					for (const panel of panels) panel.dispose();
					await Promise.allSettled([...incoming]);
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true,
						`native close must finish before fixture deletion; retained at ${tmpDir}`);
				} finally {
					Object.defineProperty(vscode.commands, 'executeCommand', originalExecuteCommand);
					Object.defineProperty(extensionModule, 'toolOrchestrator', originalOrchestrator);
					Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', originalSingleton);
					if (configureOnly) Object.defineProperty(QueryEditorProvider.prototype, 'initializeWebviewPanel', originalInitialize);
					for (const subscription of subscriptions) subscription.dispose();
					secretChanges.dispose();
					cancellation.dispose();
				}
				for (const document of documents) {
					if (!document.isClosed && document.isDirty) assert.strictEqual(await document.save(), true);
				}
				const ownedTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
					!initialTabs.has(tab) && (tab.input as { uri?: vscode.Uri }).uri?.toString() === uri.toString());
				assert.ok(ownedTabs.every(tab => !tab.isDirty), 'cleanup must not discard fixture edits');
				if (ownedTabs.length) assert.strictEqual(await vscode.window.tabGroups.close(ownedTabs), true);
				if (failed) console.log('[background-native-first-removal] retained failed fixture:', tmpDir);
				else fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			}
		});
	}

	for (const { accepted, transport, expectedAttempts } of [
		{ accepted: true, transport: 'false then true', expectedAttempts: 2 },
		{ accepted: false, transport: 'false then true', expectedAttempts: 2 },
		{ accepted: true, transport: 'throw then true', expectedAttempts: 2 },
		{ accepted: false, transport: 'throw then true', expectedAttempts: 2 },
		{ accepted: true, transport: 'success', expectedAttempts: 1 },
		{ accepted: true, transport: 'late initial success', expectedAttempts: 1 },
		{ accepted: true, transport: 'false twice then true', expectedAttempts: 3 },
		{ accepted: true, transport: 'permanent false', expectedAttempts: 3 },
		{ accepted: true, transport: 'permanent throw', expectedAttempts: 3 },
		{ accepted: true, transport: 'dispose after false', expectedAttempts: 1 },
		{ accepted: true, transport: 'source retirement after false', expectedAttempts: 1 },
		{ accepted: true, transport: 'deadline', expectedAttempts: 2 },
	] as const) {
		test(`command result transport ${transport} preserves the ${accepted ? 'accepted' : 'rejected'} terminal without another mutation`, async () => {
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalOpen = fs.promises.open;
			const originalPostMessage = MainWebviewStartupGateway.prototype.postMessage;
			const originalTransition = MarkdownDocumentAggregate.prototype.transition;
			const originalGetLogger = workbenchLogger.getWorkbenchLogger;
			const originalSetTimeout = global.setTimeout;
			const originalClearTimeout = global.clearTimeout;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-command-result-transport-'));
			const filePath = path.join(tmpDir, 'session.kqlx');
			const uri = vscode.Uri.file(filePath);
			const initialText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'markdown_transport', type: 'markdown', text: 'Retained section' },
				] },
			}, null, 2) + '\n';
			let receiveHandler: ((message: any) => unknown) | undefined;
			let projection: any;
			let durableWrites = 0;
			let transitions = 0;
			let captureDeliveryTimers = false;
			let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
			let deadlineCleared = false;
			let expireDelivery: (() => void) | undefined;
			let settleTransport: ((delivered: boolean) => void) | undefined;
			const terminals: any[] = [];
			const gatewayTerminals: unknown[] = [];
			const terminalSnapshots: string[] = [];
			const transportWarnings: unknown[][] = [];
			const deliveryDelays: number[] = [];
			const disposeHandlers: Array<() => void> = [];
			try {
				fs.writeFileSync(filePath, initialText, 'utf8');
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
				MainWebviewStartupGateway.prototype.postMessage = function (message: unknown) {
					if ((message as any)?.type === 'markdownDocumentCommandResult') gatewayTerminals.push(message);
					return originalPostMessage.call(this, message);
				};
				MarkdownDocumentAggregate.prototype.transition = function (...args: Parameters<typeof originalTransition>) {
					transitions++;
					return originalTransition.apply(this, args);
				};
				(workbenchLogger as any).getWorkbenchLogger = () => {
					const logger = originalGetLogger();
					return {
						...logger,
						warn: (message: string, ...args: unknown[]) => {
							if (message === '[kusto] webview message failed:') transportWarnings.push([message, ...args]);
							else logger.warn(message, ...args);
						},
					};
				};
				global.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
					const handle = originalSetTimeout(callback, delay, ...args);
					if (captureDeliveryTimers && (delay === 50 || delay === 500)) {
						deliveryDelays.push(delay);
						if (delay === 500 && !expireDelivery) {
							deadlineHandle = handle;
							expireDelivery = () => callback(...args);
						}
					}
					return handle;
				}) as typeof setTimeout;
				global.clearTimeout = timeout => {
					if (timeout === deadlineHandle) deadlineCleared = true;
					originalClearTimeout(timeout);
				};
				fs.promises.open = async (...args: Parameters<typeof fs.promises.open>) => {
					const handle = await originalOpen(...args);
					if (String(args[0]) === uri.fsPath && args[1] === 'r+') {
						const originalSync = handle.sync.bind(handle);
						handle.sync = async () => {
							await originalSync();
							durableWrites++;
						};
					}
					return handle;
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				const document = {
					uri, getText: () => initialText, eol: vscode.EndOfLine.LF,
					positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false, version: 1,
				} as any;
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => {
							if (message?.type === 'documentData') projection = message;
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: Number(message.editRevision || 0),
									markdownCommandBarrierSupported: true,
								}));
							}
							if (message?.type === 'markdownDocumentCommandResult') {
								terminals.push(message);
								terminalSnapshots.push(JSON.stringify(message));
								if (transport === 'dispose after false') {
									captureDeliveryTimers = false;
									for (const dispose of disposeHandlers) dispose();
									captureDeliveryTimers = true;
									return false;
								}
								if (transport === 'source retirement after false') {
									captureDeliveryTimers = false;
									await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
									captureDeliveryTimers = true;
									return false;
								}
								if (transport === 'deadline' || transport === 'late initial success') {
									if (transport === 'deadline' && terminals.length === 1) return false;
									queueMicrotask(() => {
										expireDelivery?.();
										if (transport === 'late initial success') settleTransport?.(true);
									});
									return new Promise<boolean>(resolve => { settleTransport = resolve; });
								}
								if (transport === 'permanent throw' || (transport === 'throw then true' && terminals.length === 1)) {
									throw new Error('Transport detail must not appear in the permanent-failure warning.');
								}
								return transport !== 'permanent false'
									&& (transport === 'success' || terminals.length >= expectedAttempts);
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
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
				const initialRevision = projection.documentRevision;
				const initialGeneration = projection.sourceGeneration;
				durableWrites = 0;
				transitions = 0;
				captureDeliveryTimers = true;
				await Promise.resolve(receiveHandler!({
					type: 'markdownDocumentCommand', commandId: 'python-add-6',
					sourceGeneration: initialGeneration,
					expectedDocumentRevision: initialRevision + (accepted ? 0 : 1),
					command: { type: 'add', section: { id: 'python_transport', type: 'python', code: 'print(6)' } },
				}));
				captureDeliveryTimers = false;
				settleTransport?.(true);
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(terminals.length, expectedAttempts, 'only known non-delivery may retry while the owner remains live');
				assert.strictEqual(gatewayTerminals.length, expectedAttempts);
				for (const terminal of gatewayTerminals) {
					assert.strictEqual(terminal, gatewayTerminals[0], 'gateway retries must reuse one result object');
					assert.strictEqual(Object.isFrozen(terminal), true, 'the admitted result must be immutable');
				}
				assert.deepStrictEqual(terminalSnapshots, Array(expectedAttempts).fill(terminalSnapshots[0]));
				assert.strictEqual(transitions, 1, 'transport retries must never reenter the command transition');
				assert.strictEqual(terminals[0].commandId, 'python-add-6');
				assert.strictEqual(terminals[0].ok, accepted);
				assert.strictEqual(terminals[0].sourceGeneration, initialGeneration);
				assert.strictEqual(terminals[0].documentRevision, initialRevision + (accepted ? 1 : 0));
				assert.strictEqual(durableWrites, accepted ? 1 : 0, 'transport retry must not repeat the durable write');
				const retryUnnecessary = transport === 'success' || transport === 'late initial success'
					|| transport === 'dispose after false' || transport === 'source retirement after false';
				if (retryUnnecessary) assert.deepStrictEqual(deliveryDelays, [], 'successful delivery or retirement must not start a retry budget');
				else assert.strictEqual(deliveryDelays[0], 500, 'the retry deadline must stay below the existing five-second client deadline');
				assert.ok(deliveryDelays.filter(delay => delay === 50).length <= 2, 'retry delays must total at most 100 ms');
				if (deadlineHandle) assert.strictEqual(deadlineCleared, true, 'every terminal path must clear its deadline');
				const permanentFailure = transport === 'permanent false' || transport === 'permanent throw' || transport === 'deadline';
				assert.strictEqual(transportWarnings.length, permanentFailure ? 1 : 0);
				if (permanentFailure) {
					assert.strictEqual(transportWarnings[0].length, 2);
					assert.ok(transportWarnings[0][1] instanceof Error);
					assert.strictEqual((transportWarnings[0][1] as Error).message, 'Command result delivery failed (python-add-6).');
				}
				if (transport === 'source retirement after false') assert.ok(projection.sourceGeneration > initialGeneration);
				assert.deepStrictEqual(
					JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections.map((section: any) => section.id),
					accepted ? ['markdown_transport', 'python_transport'] : ['markdown_transport'],
				);
			} finally {
				captureDeliveryTimers = false;
				settleTransport?.(false);
				for (const dispose of disposeHandlers) dispose();
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				fs.promises.open = originalOpen;
				MainWebviewStartupGateway.prototype.postMessage = originalPostMessage;
				MarkdownDocumentAggregate.prototype.transition = originalTransition;
				(workbenchLogger as any).getWorkbenchLogger = originalGetLogger;
				global.setTimeout = originalSetTimeout;
				global.clearTimeout = originalClearTimeout;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	}

	test('Power BI compensation cannot mutate a same-ID HTML replacement and cleanup follows host projection', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-html-publish-cas-'));
		const filePath = path.join(tmpDir, 'publish-cas.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'html_publish', type: 'html', code: '<main>original</main>' },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		let queryEditor: any;
		const posted: any[] = [];
		const cleanup = async () => { cleanupCalls++; return true; };
		let cleanupCalls = 0;
		const publishInfo = {
			workspaceId: 'workspace-created', semanticModelId: 'model-created', reportId: 'report-created',
			reportName: 'Created report', reportUrl: 'https://app.powerbi.com/created', dataMode: 'import',
		} as const;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (panel: vscode.WebviewPanel) {
				queryEditor = this;
				queryEditor.panel = panel;
				queryEditor._panelDisposed = false;
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
					extensionMode: vscode.ExtensionMode.Test,
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
						posted.push(message);
						if (message?.type === 'documentData' || message?.type === 'markdownDocumentCommandResult') {
							projection = message;
						}
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(
							handler, () => latestDocumentViewHostMessage(posted),
						);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(queryEditor!, 'native provider must create its query editor adapter');
			const timer = setTimeout(() => undefined, 60_000);
			queryEditor!.dashboardApplication.pendingPowerBiPublishAcks.set('publish-cas', {
				cleanup, timer, boxId: 'html_publish', publishInfo: Object.freeze({ ...publishInfo }),
				applicationState: 'idle', cleanupRequested: false, finalizationInProgress: false,
			});

			const sendCommand = async (message: any) => {
				const beforeCount = posted.length;
				await Promise.resolve(receiveHandler!(message));
				const result = posted.slice(beforeCount).find(candidate =>
					candidate?.type === 'markdownDocumentCommandResult'
					&& candidate.commandId === message.commandId,
				);
				assert.ok(result, `host must settle ${message.commandId}`);
				projection = result;
				return result;
			};
			const applied = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'publish-apply',
				publishRequestId: 'publish-cas', publishApplicationPhase: 'apply',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'html_publish',
					expectedSectionRevision: projection.sectionRevisions.html_publish,
					patch: { pbiPublishInfo: publishInfo },
				},
			});
			assert.strictEqual(applied.ok, true);

			const removed = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'remove-published-html',
				sourceGeneration: applied.sourceGeneration,
				expectedDocumentRevision: applied.documentRevision,
				command: {
					type: 'remove', sectionId: 'html_publish',
					expectedSectionRevision: applied.projection.sectionRevisions.html_publish,
				},
			});
			assert.strictEqual(removed.ok, true);
			const replacement = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'recreate-published-html',
				sourceGeneration: removed.sourceGeneration,
				expectedDocumentRevision: removed.documentRevision,
				command: {
					type: 'add', section: {
						id: 'html_publish', type: 'html', code: '<main>replacement</main>',
					},
				},
			});
			assert.strictEqual(replacement.ok, true);

			const compensation = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'stale-publish-compensation',
				publishRequestId: 'publish-cas', publishApplicationPhase: 'compensate',
				sourceGeneration: replacement.sourceGeneration,
				expectedDocumentRevision: replacement.documentRevision,
				command: {
					type: 'patch', sectionId: 'html_publish',
					expectedSectionRevision: replacement.projection.sectionRevisions.html_publish,
					patch: { pbiPublishInfo: null },
				},
			});
			assert.strictEqual(compensation.ok, false);
			assert.strictEqual(compensation.error?.code, 'publish-workflow-retired');
			await Promise.resolve(receiveHandler!({
				type: 'publishToPowerBIAck', requestId: 'publish-cas', accepted: true,
			}));

			assert.strictEqual(cleanupCalls, 1, 'cleanup must run once after the old tuple is absent');
			const finalSection = JSON.parse(currentText).state.sections.find(
				(section: any) => section.id === 'html_publish',
			);
			assert.strictEqual(finalSection.type, 'html');
			assert.strictEqual(finalSection.code, '<main>replacement</main>');
			assert.strictEqual(finalSection.pbiPublishInfo, undefined);
			assert.strictEqual(queryEditor!.dashboardApplication.pendingPowerBiPublishAcks.has('publish-cas'), false);
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('same-URI reopen during close cleanup preserves owner and queue identity', async () => {
		const originalOnDidClose = vscode.workspace.onDidCloseTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-reopen-cleanup-'));
		const uri = vscode.Uri.file(path.join(tmpDir, 'reopen.kqlx'));
		let closeHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let releaseQueue!: () => void;
		const queueGate = new Promise<void>(resolve => { releaseQueue = resolve; });
		let reopenedRegistration: ReturnType<typeof KqlxEditorProvider.trackOpenEditor> | undefined;

		try {
			(vscode.workspace as any).onDidCloseTextDocument = (handler: any) => {
				closeHandler = handler;
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
			assert.ok(closeHandler);
			const key = (KqlxEditorProvider as any).panelKey(uri);
			const queue = {
				tail: queueGate,
				pendingCommands: 0,
				activePersistenceLeases: new Set(),
			};
			const owner = {
				document: { revision: 3 },
				sourceText: '{"kind":"kqlx","version":1,"state":{"sections":[]}}',
				queue,
			};
			(provider as any).markdownDocuments.set(key, owner);
			(provider as any).markdownDocumentQueues.set(key, queue);

			void closeHandler!({ uri } as vscode.TextDocument);
			await new Promise<void>(resolve => setImmediate(resolve));
			reopenedRegistration = KqlxEditorProvider.trackOpenEditor(uri, {} as vscode.WebviewPanel);
			releaseQueue();
			await new Promise<void>(resolve => setImmediate(resolve));

			assert.strictEqual((provider as any).markdownDocuments.get(key), owner);
			assert.strictEqual((provider as any).markdownDocumentQueues.get(key), queue);
			assert.strictEqual((provider as any).markdownDocuments.get(key).document.revision, 3);

			reopenedRegistration.finishClosing();
			reopenedRegistration = undefined;
			void closeHandler!({ uri } as vscode.TextDocument);
			await waitForCondition(
				() => !(provider as any).markdownDocuments.has(key)
					&& !(provider as any).markdownDocumentQueues.has(key),
				'URI-owned state should be released after the reopened editor closes',
				1_000,
			);
		} finally {
			releaseQueue?.();
			reopenedRegistration?.finishClosing();
			(vscode.workspace as any).onDidCloseTextDocument = originalOnDidClose;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked validation installs the receiver first and disposal cancels startup', async () => {
		const originalRealpath = fs.promises.realpath;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-startup-dispose-'));
		const filePath = path.join(tmpDir, 'linked-startup.kqlx');
		const linkedPath = path.join(tmpDir, 'query.kql');
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: '', linkedQueryPath: 'query.kql' },
			] },
		}, null, 2) + '\n';
		let releaseRealpath!: () => void;
		const realpathGate = new Promise<void>(resolve => { releaseRealpath = resolve; });
		let receiverInstalled = false;
		let disposePanel!: () => void;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			fs.writeFileSync(linkedPath, 'print value = 1\n', 'utf8');
			(fs.promises as any).realpath = async (target: fs.PathLike) => {
				await realpathGate;
				return originalRealpath(target as any);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as vscode.TextDocument;
			const disposalHandlers: Array<() => void> = [];
			const panel = {
				webview: {
					options: {}, html: '', postMessage: async () => true,
					onDidReceiveMessage: () => {
						receiverInstalled = true;
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => {
					disposalHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;
			disposePanel = () => disposalHandlers.forEach(handler => handler());

			const resolving = provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(receiverInstalled, true, 'gateway receiver must precede linked-file validation');
			disposePanel();
			assert.strictEqual(await Promise.race([
				resolving.then(() => true),
				new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
			]), true, 'panel disposal must cancel blocked linked-file startup');
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 250), true);
		} finally {
			disposePanel?.();
			releaseRealpath?.();
			(fs.promises as any).realpath = originalRealpath;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('panel disposal cancels a never-settling native webview initialization', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-init-dispose-'));
		const filePath = path.join(tmpDir, 'blocked.kqlx');
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		const disposeHandlers: Array<() => void> = [];
		try {
			fs.writeFileSync(filePath, text, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = () => new Promise<void>(() => undefined);
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
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: { options: {}, postMessage: async () => true, onDidReceiveMessage: () => ({ dispose() {} }) },
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;

			const resolving = provider.resolveCustomTextEditor(document, panel, {} as any);
			await new Promise<void>(resolve => setImmediate(resolve));
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await Promise.race([
				resolving.then(() => true),
				new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
			]), true);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 500), true);
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Python-only Save waits for projection acknowledgement and preserves owned state', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-python-pre-ack-save-'));
		const filePath = path.join(tmpDir, 'python-only.kqlx');
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot: { keep: true }, state: {
				sections: [{
					id: 'python_only', type: 'python', name: 'Python', code: 'print(1)',
					output: 'one', expanded: true, editorHeightPx: 180,
				}],
			},
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let reloadRequestId = '';
		let projection: any;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let request: Promise<unknown> | undefined;
		let savePreparation: Promise<vscode.TextEdit[]> | undefined;
		let settled = false;
		let barrierRequests = 0;
		let finalSnapshotRequests = 0;
		const disposers: Array<() => void> = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
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
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true, version: 1,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') {
							projection = message;
							reloadRequestId = String(message.reloadRequestId || '');
						}
						if (message?.type === 'requestMarkdownCommandBarrier') {
							barrierRequests++;
							await Promise.resolve(receiveHandler?.({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration, documentRevision: projection.documentRevision, accepted: true,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalSnapshotRequests++;
							await Promise.resolve(receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration,
								state: { sections: [] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposers.push(handler); return { dispose() {} }; },
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			request = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!reloadRequestId, 'Python projection candidate should be posted', 1_000);
			assert.ok(willSaveHandler);
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { savePreparation = Promise.resolve(thenable); void savePreparation.then(() => { settled = true; }, () => { settled = true; }); },
			} as any);
			assert.ok(savePreparation);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(settled, false);
			assert.strictEqual(barrierRequests, 0);
			assert.strictEqual(finalSnapshotRequests, 0);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), currentText);
			assert.deepStrictEqual(JSON.parse(currentText).state.sections,
				JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections);

			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await request;
			const edits = await savePreparation;
			assert.ok(edits.length <= 1);
			const saved = JSON.parse(edits.at(-1)?.newText ?? currentText);
			assert.strictEqual(saved.state.sections[0].code, 'print(1)');
			assert.strictEqual(saved.state.sections[0].output, 'one');
			assert.strictEqual(saved.state.sections[0].editorHeightPx, 180);
			assert.strictEqual(saved.futureRoot.keep, true);
			assert.strictEqual(barrierRequests, 1);
			assert.strictEqual(finalSnapshotRequests, 1);
		} finally {
			for (const dispose of disposers) dispose();
			await savePreparation?.catch(() => undefined);
			await request?.catch(() => undefined);
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Chart-only Save waits for projection acknowledgement and preserves owned state', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-chart-pre-ack-save-'));
		const filePath = path.join(tmpDir, 'chart-only.kqlx');
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot: { keep: true }, state: {
				sections: [{
					id: 'chart_only', type: 'chart', name: 'Chart', mode: 'preview', expanded: true,
					dataSourceId: 'query_source', chartType: 'line', xColumn: 'Day', yColumns: ['Value'],
					xAxisSettings: { customLabel: 'Date' }, chartTitle: 'Owned chart',
				}],
			},
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let reloadRequestId = '';
		let projection: any;
		let finalSnapshotRequests = 0;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let request: Promise<unknown> | undefined;
		let savePreparation: Promise<vscode.TextEdit[]> | undefined;
		let settled = false;
		let barrierRequests = 0;
		const disposers: Array<() => void> = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
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
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true, version: 1,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') {
							projection = message;
							reloadRequestId = String(message.reloadRequestId || '');
						}
						if (message?.type === 'requestMarkdownCommandBarrier') {
							barrierRequests++;
							await Promise.resolve(receiveHandler?.({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration, documentRevision: projection.documentRevision, accepted: true,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalSnapshotRequests++;
							await Promise.resolve(receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration,
								state: { sections: [{ id: 'chart_only', type: 'chart', chartTitle: 'Stale DOM' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposers.push(handler); return { dispose() {} }; },
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			request = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!reloadRequestId, 'Chart projection candidate should be posted', 1_000);
			assert.ok(willSaveHandler);
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { savePreparation = Promise.resolve(thenable); void savePreparation.then(() => { settled = true; }, () => { settled = true; }); },
			} as any);
			assert.ok(savePreparation);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(settled, false);
			assert.strictEqual(barrierRequests, 0);
			assert.strictEqual(finalSnapshotRequests, 0);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), currentText);
			assert.deepStrictEqual(JSON.parse(currentText).state.sections, JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections);

			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await request;
			const edits = await savePreparation;
			assert.ok(edits.length <= 1);
			const saved = JSON.parse(edits.at(-1)?.newText ?? currentText);
			assert.strictEqual(saved.state.sections[0].chartTitle, 'Owned chart');
			assert.strictEqual(saved.state.sections[0].dataSourceId, 'query_source');
			assert.strictEqual(saved.futureRoot.keep, true);
			assert.strictEqual(barrierRequests, 1);
			assert.strictEqual(finalSnapshotRequests, 1);
		} finally {
			for (const dispose of disposers) dispose();
			await savePreparation?.catch(() => undefined);
			await request?.catch(() => undefined);
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('initial projection readiness is scoped to the requested editor panel', async () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), 'kw-panel-projection-readiness.kqlx'));
		const firstPanel = {} as vscode.WebviewPanel;
		const secondPanel = {} as vscode.WebviewPanel;
		const first = KqlxEditorProvider.trackOpenEditor(uri, firstPanel);
		const second = KqlxEditorProvider.trackOpenEditor(uri, secondPanel);
		try {
			const secondReadiness = KqlxEditorProvider.waitForOpenEditorInitialized(uri, 2_000, secondPanel);
			(KqlxEditorProvider as any).markOpenEditorInitialized(uri, firstPanel);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), true);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, secondPanel), false);
			second.beginClosing();
			assert.strictEqual(await secondReadiness, false);
		} finally {
			second.finishClosing();
			first.finishClosing();
		}
	});

	for (const outcome of ['accepted', 'webview rejection', 'host rejection', 'disposed', 'ordinary owner projection'] as const) {
		test(`current native projection readiness requires its exact accepted acknowledgement (${outcome})`, async function () {
			this.timeout(10_000);
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalCommit = QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-current-projection-readiness-'));
			const filePath = path.join(tmpDir, 'current.kqlx');
			const uri = vscode.Uri.file(filePath);
			const authoredFile = {
				kind: 'kqlx', version: 1, futureRoot: { keep: true }, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print Value=1', expanded: false },
					{ id: 'markdown_1', type: 'markdown', text: '# Authored state', mode: 'preview' },
				] },
			};
			const authoredBytes = Buffer.from(JSON.stringify(authoredFile, null, 2) + '\n', 'utf8');
			let receiveHandler: ((message: any) => unknown) | undefined;
			let queryEditor: QueryEditorProvider | undefined;
			let rejectHostAdmission = false;
			let capabilityReadiness: Promise<boolean> | undefined;
			let sampleCapabilityReadiness = false;
			const projections: any[] = [];
			const requests: Promise<unknown>[] = [];
			const disposeHandlers: Array<() => void> = [];
			const subscriptions: vscode.Disposable[] = [];
			let releaseOrdinaryProjection!: () => void;
			const ordinaryProjectionDelivery = new Promise<void>(resolve => { releaseOrdinaryProjection = resolve; });
			const acknowledge = (projection: any, applied: boolean) => Promise.resolve(receiveHandler!({
				protocolVersion: projection.protocolVersion,
				channel: projection.channel,
				viewSessionId: projection.viewSessionId,
				type: 'documentReloadResult', requestId: projection.reloadRequestId,
				applied, editRevision: 0,
			}));

			try {
				fs.writeFileSync(filePath, authoredBytes);
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (this: QueryEditorProvider) {
					queryEditor = this;
				};
				QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = async function (fingerprint, commit) {
					if (this === queryEditor && rejectHostAdmission) return false;
					return originalCommit.call(this, fingerprint, commit);
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				const document = await vscode.workspace.openTextDocument(uri);
				const originalVersion = document.version;
				assert.strictEqual(liveDocuments.register(document), false, 'the fixture must be a real native TextDocument');
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (sampleCapabilityReadiness && message?.type === 'persistenceMode') {
								capabilityReadiness = KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel);
							}
							if (message?.type === 'documentData') {
								projections.push(message);
								if (outcome === 'ordinary owner projection' && projections.length === 2) await ordinaryProjectionDelivery;
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receiveHandler = wrapDocumentViewTestReceiver(handler, () => projections.at(-1));
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				const assertAuthoredStateUnchanged = () => {
					assert.deepStrictEqual(fs.readFileSync(filePath), authoredBytes);
					assert.strictEqual(document.getText(), authoredBytes.toString('utf8'));
					assert.deepStrictEqual(JSON.parse(document.getText()), authoredFile);
					assert.strictEqual(document.version, originalVersion);
					assert.strictEqual(document.isDirty, false);
				};

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				const initialRequest = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				requests.push(initialRequest);
				await waitForCondition(() => projections.length === 1, 'initial native projection must be posted', 1_000);
				const initialProjection = projections[0];
				await acknowledge(initialProjection, true);
				await initialRequest;
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
				assertAuthoredStateUnchanged();

				sampleCapabilityReadiness = true;
				rejectHostAdmission = outcome === 'host rejection';
				const requestId = 'native-current-projection';
				let currentRequest: Promise<unknown>;
				if (outcome === 'ordinary owner projection') {
					const registration = (provider as any).markdownPanelOwners.get(normalizeWorkbenchUriKey(uri))?.get(panel);
					assert.strictEqual(typeof registration?.requestProjection, 'function', 'the canonical URI owner must provide its actual projection callback');
					registration.requestProjection();
					capabilityReadiness = KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel);
					currentRequest = KqlxEditorProvider.waitForOpenEditorInitialized(uri, 2_000, panel);
				} else {
					currentRequest = Promise.resolve(receiveHandler!({ type: 'requestDocument', requestId }));
				}
				requests.push(currentRequest);
				await waitForCondition(() => projections.length === 2 && capabilityReadiness !== undefined,
					'the correlated native projection must be posted without its acknowledgement', 1_000);
				sampleCapabilityReadiness = false;
				assert.strictEqual(await capabilityReadiness, false,
					'a fresh request must revoke historical readiness before capabilities are sent');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
				const currentProjection = projections[1];
				assert.strictEqual(currentProjection.requestId, outcome === 'ordinary owner projection' ? undefined : requestId);
				assert.strictEqual(currentProjection.forceReload, true);
				assert.ok(currentProjection.sourceGeneration > initialProjection.sourceGeneration);
				assert.strictEqual(currentProjection.viewSessionId, initialProjection.viewSessionId);
				assert.strictEqual(currentProjection.documentRevision, initialProjection.documentRevision);
				assertAuthoredStateUnchanged();

				await acknowledge(initialProjection, true);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
					'an old acknowledgement must not make the current projection ready');
				await acknowledge({ ...currentProjection, reloadRequestId: `${currentProjection.reloadRequestId}-stale` }, true);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
					'a mismatched acknowledgement must not consume current projection readiness');
				const initialized = KqlxEditorProvider.waitForOpenEditorInitialized(uri, 2_000, panel);
				if (outcome === 'disposed') {
					for (const dispose of disposeHandlers) dispose();
					await acknowledge(currentProjection, true);
				} else {
					const attempts = outcome === 'host rejection' ? 3 : 1;
					for (let attempt = 1; attempt <= attempts; attempt++) {
						await waitForCondition(() => projections.length === attempt + 1,
							`current native projection attempt ${attempt} must be posted`, 1_000);
						assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
						await acknowledge(projections[attempt], outcome !== 'webview rejection');
					}
				}
				if (outcome === 'ordinary owner projection') {
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
						'the ordinary canonical projection must fully settle after ACK before advertising readiness');
					assert.strictEqual((queryEditor as any).workbenchToolSnapshotIdentity(), `${currentProjection.sourceGeneration}:2`,
						'the canonical ACK must re-enter and commit while its physical SDK delivery remains held');
					releaseOrdinaryProjection();
				}
				await currentRequest;
				const accepted = outcome === 'accepted' || outcome === 'ordinary owner projection';
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), accepted,
					'only the exact host-accepted current projection can restore readiness');
				assertAuthoredStateUnchanged();
				if (accepted) assert.strictEqual(await initialized, true);
				for (const dispose of disposeHandlers) dispose();
				if (!accepted) assert.strictEqual(await initialized, false);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true);
				await acknowledge(initialProjection, true);
				await acknowledge(projections.at(-1), true);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
				assertAuthoredStateUnchanged();
			} finally {
				releaseOrdinaryProjection();
				for (const dispose of disposeHandlers) dispose();
				await Promise.allSettled(requests);
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				for (const subscription of subscriptions) subscription.dispose();
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = originalCommit;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});
	}

	for (const scenario of ['BASELINE', 'RACE'] as const) test(`initial native mutation readiness survives queued projection acknowledgement (${scenario})`, async function () {
		const originalInitialize = QueryEditorProvider.prototype.initializeWebviewPanel;
		const originalPublish = QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh;
		const originalCommit = QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-pending-activation-invalidation-'));
		const filePath = path.join(tmpDir, 'pending.kqlx');
		const uri = vscode.Uri.file(filePath);
		const authoredBytes = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_1', type: 'query', query: 'print Value=1', expanded: false },
			{ id: 'markdown_1', type: 'markdown', text: '# Authored state', mode: 'preview' },
		] } }, null, 2) + '\n', 'utf8');
		const subscriptions: vscode.Disposable[] = [];
		const disposers: Array<() => void> = [];
		const requests: Promise<unknown>[] = [];
		const projections: any[] = [];
		const admissions: boolean[] = [];
		const readinessStates: Readonly<Record<string, unknown>>[] = [];
		let queryEditor: QueryEditorProvider | undefined;
		let receive: ((message: any) => unknown) | undefined;
		let invalidatePersistence: (() => void) | undefined;
		let originalInvalidationEvent: vscode.Event<void> | undefined;
		let trace: { mark(event: string, detail?: Readonly<Record<string, unknown>>): void } | undefined;
		let originalTraceMark: NonNullable<typeof trace>['mark'] | undefined;
		let firstReadiness: Promise<boolean> | undefined;
		let firstReadinessResult: boolean | undefined;
		let revealCount = 0;
		let holdRefresh = false;
		let refreshPrepared = false;
		let preparationCount = 0;
		let initialPosted!: () => void;
		let secondPosted!: () => void;
		const initialProjectionPosted = new Promise<void>(resolve => { initialPosted = resolve; });
		const secondProjectionPosted = new Promise<void>(resolve => { secondPosted = resolve; });
		let beginPreparation!: () => void;
		let releasePreparation!: () => void;
		let finishRefresh!: () => void;
		const preparationStarted = new Promise<void>(resolve => { beginPreparation = resolve; });
		const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
		const refreshDrained = new Promise<void>(resolve => { finishRefresh = resolve; });
		try {
			fs.writeFileSync(filePath, authoredBytes);
			QueryEditorProvider.prototype.initializeWebviewPanel = async function () {
				queryEditor = this;
				const subscribe = this.onDidInvalidateKustoPersistence;
				originalInvalidationEvent = subscribe;
				const captureInvalidation: vscode.Event<void> = (listener, thisArgs, disposables) => {
					invalidatePersistence = listener;
					return subscribe(listener, thisArgs, disposables);
				};
				(this as any).onDidInvalidateKustoPersistence = captureInvalidation;
				trace = this.fileOpenTrace;
				assert.ok(trace);
				originalTraceMark = trace.mark;
				trace.mark = function (event, detail) {
					originalTraceMark!.call(this, event, detail);
					if (event === 'notify.transitions' && detail) {
						readinessStates.push(detail);
						if (refreshPrepared) finishRefresh();
					}
				};
			};
			QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh = async function (state, publish, observer) {
				if (this !== queryEditor || !holdRefresh) return originalPublish.bind(this)(state, publish, observer);
				holdRefresh = false;
				preparationCount++;
				beginPreparation();
				await preparationGate;
				const result = await originalPublish.bind(this)(state, publish, observer);
				refreshPrepared = true;
				return result;
			};
			QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = async function (fingerprint, commit) {
				const result = await originalCommit.call(this, fingerprint, commit);
				if (this === queryEditor) admissions.push(result);
				return result;
			};
			const provider = new (KqlxEditorProvider as any)({
				subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
			}, vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub()) as KqlxEditorProvider;
			const document = await vscode.workspace.openTextDocument(uri);
			assert.strictEqual(liveDocuments.register(document), false, 'the fixture must use a real native TextDocument');
			const originalVersion = document.version;
			assert.strictEqual(originalVersion, 1);
			const activeTextEditor = vscode.window.activeTextEditor;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') {
							projections.push(message);
							if (projections.length === 1) initialPosted();
							if (projections.length === 2) secondPosted();
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projections.at(-1));
						return { dispose() {} };
					},
				},
				reveal: () => { revealCount++; },
				onDidDispose: (handler: () => void) => { disposers.push(handler); return { dispose() {} }; },
			} as any;
			const acknowledge = (projection: any) => Promise.resolve(receive!({
				type: 'documentReloadResult', requestId: projection.reloadRequestId, applied: true, editRevision: 0,
				protocolVersion: projection.protocolVersion, channel: projection.channel, viewSessionId: projection.viewSessionId,
			}));
			const assertAuthoredStateUnchanged = () => {
				assert.deepStrictEqual(fs.readFileSync(filePath), authoredBytes);
				assert.strictEqual(document.getText(), authoredBytes.toString('utf8'));
				assert.strictEqual(document.version, originalVersion);
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(vscode.window.activeTextEditor, activeTextEditor);
				assert.strictEqual(revealCount, 0);
			};
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(queryEditor);
			assert.strictEqual(typeof invalidatePersistence, 'function', 'capture the provider callback registered with the real invalidation event');
			const readinessCallback = (queryEditor as any).workbenchToolMutationReadiness as (() => Promise<boolean>);
			assert.strictEqual(typeof readinessCallback, 'function');
			firstReadiness = readinessCallback();
			void firstReadiness.then(result => { firstReadinessResult = result; });
			const initialRequest = Promise.resolve(receive!({ type: 'requestDocument' }));
			requests.push(initialRequest);
			await initialProjectionPosted;
			assert.strictEqual(projections[0].requestId, undefined);
			assert.strictEqual(projections[0].sourceGeneration, 1);
			const requestId = 'queued-native-readiness';
			requests.push(Promise.resolve(receive!({ type: 'requestDocument', requestId })));
			assert.strictEqual(firstReadinessResult, undefined);
			await acknowledge(projections[0]);
			await initialRequest;
			await secondProjectionPosted;
			const secondProjection = projections[1];
			assert.strictEqual(secondProjection.requestId, requestId, 'the second request must not coalesce with the anonymous request');
			assert.strictEqual(secondProjection.sourceGeneration, 2);
			assert.strictEqual(secondProjection.viewSessionId, projections[0].viewSessionId);
			assert.deepStrictEqual(admissions, [true], 'ACK1 must complete canonical host admission before the race');
			assert.strictEqual(firstReadinessResult, undefined, 'the first readiness call must still be waiting for ACK2');
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
			assertAuthoredStateUnchanged();
			const queue = (provider as any).markdownDocumentQueues.get(normalizeWorkbenchUriKey(uri)) as { tail: Promise<void> };
			assert.ok(queue);
			if (scenario === 'RACE') {
				const previousTail = queue.tail;
				holdRefresh = true;
				invalidatePersistence!();
				const refreshTail = queue.tail;
				assert.notStrictEqual(refreshTail, previousTail, 'the real invalidation callback must reserve the document queue');
				await preparationStarted;
				assert.strictEqual(projections.length, 2);
				assert.deepStrictEqual(admissions, [true], 'ACK2 remains withheld during invalidation preparation');
				releasePreparation();
				await refreshDrained;
				await refreshTail;
				assert.strictEqual(preparationCount, 1);
				assert.strictEqual(queue.tail, refreshTail);
				assert.strictEqual(projections.length, 2, 'queued invalidation must skip a new projection while generation 2 awaits activation');
				assert.strictEqual(readinessStates.at(-1)?.pendingDocumentProjections, 1);
				assert.strictEqual(readinessStates.at(-1)?.pendingProjectionActivationSize, 1);
				assert.strictEqual(firstReadinessResult, undefined);
			}
			await acknowledge(secondProjection);
			await Promise.all(requests);
			await queue.tail;
			assert.deepStrictEqual(admissions, [true, true], 'both exact positive ACKs must complete real canonical host admission');
			assert.strictEqual(projections.length, 2);
			const drained = readinessStates.at(-1);
			assert.ok(drained, 'read the actual provider counters emitted by its readiness notifier');
			assert.deepStrictEqual({
				active: drained.activeProjectionGeneration, posted: drained.postDocumentGeneration,
				requests: drained.admittedDocumentRequests, projections: drained.pendingDocumentProjections,
				activations: drained.pendingProjectionActivationSize,
				initialRecovery: drained.initialRecovery, pendingRecovery: drained.pendingRecovery,
			}, { active: 2, posted: 2, requests: 0, projections: 0, activations: 0, initialRecovery: false, pendingRecovery: false });
			assert.strictEqual((queryEditor as any).workbenchToolSnapshotIdentity().split(':')[0], '2');
			assertAuthoredStateUnchanged();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true,
				'the exact panel must initialize after both accepted ACKs and all queued work drain');
			assert.strictEqual(await firstReadiness, true, 'the same first mutation-readiness promise must resolve true');
		} finally {
			releasePreparation();
			try {
				for (const dispose of disposers.splice(0)) dispose();
				await Promise.allSettled(requests);
				await firstReadiness;
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true);
			} finally {
				try {
					for (const subscription of subscriptions) subscription.dispose();
				} finally {
					if (queryEditor && originalInvalidationEvent) (queryEditor as any).onDidInvalidateKustoPersistence = originalInvalidationEvent;
					if (trace && originalTraceMark) trace.mark = originalTraceMark;
					QueryEditorProvider.prototype.initializeWebviewPanel = originalInitialize;
					QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
					QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = originalCommit;
				}
			}
		}
	});

	for (const scenario of ['physical settlement', 'Kusto policy changed', 'SQL policy changed', 'SQL-produced comparison',
		'projected state changed', 'runtime replaced', 'owner replaced', 'disposed', 'source version ABA', 'third invalidation',
		'consumed source-change follow-up'] as const) test(`deferred native invalidation proves its exact current projection (${scenario})`, async function () {
		const originalInitialize = QueryEditorProvider.prototype.initializeWebviewPanel;
		const originalPublish = QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh;
		const originalCommit = QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh;
		const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-deferred-invalidation-'));
		const uri = vscode.Uri.file(path.join(tmpDir, 'deferred.kqlx'));
		const sqlArtifact = {
			version: 1 as const, ...createPrimaryResultArtifactIdentity('query_comparison', 1, 1)!,
			producer: { engine: 'sql', boxId: 'query_comparison', connectionId: 'sql_deferred', query: 'SELECT 1 AS Value' },
		};
		const authoredBytes = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_1', type: 'query', query: 'print Value=1', expanded: false },
			{ id: 'markdown_1', type: 'markdown', text: '# Retained state', mode: 'preview' },
			...(scenario === 'SQL policy changed' || scenario === 'SQL-produced comparison'
				? [{ id: scenario === 'SQL-produced comparison' ? 'sql_original' : 'sql_1', type: 'sql', query: 'SELECT 1 AS Value' }] : []),
			...(scenario === 'SQL-produced comparison' ? [{ id: 'query_comparison', type: 'query', query: 'print Value=1',
				comparisonSourceBoxId: 'sql_original', resultArtifact: sqlArtifact,
				resultJson: JSON.stringify({ columns: [{ name: 'Value', dataType: 'int' }], rows: [[1]] }),
			}] : []),
		] } }, null, 2) + '\n');
		const subscriptions: vscode.Disposable[] = [];
		const disposers: Array<() => void> = [];
		const requests: Promise<unknown>[] = [];
		const posted: any[] = [];
		const projections: any[] = [];
		const admissions: boolean[] = [];
		const proofResults: unknown[] = [];
		const reloads: Array<{ requestId: string; deadline: number | undefined }> = [];
		const readinessStates: Readonly<Record<string, unknown>>[] = [];
		const settlements: Readonly<Record<string, unknown>>[] = [];
		const sourceChanges: vscode.TextDocumentChangeEvent[] = [];
		const policy = { clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {} };
		const connections = connectionManagerStub();
		connections.runWithLeaveNoTraceSnapshotLock = async (work: (snapshot: typeof policy) => unknown) => work(policy);
		const sqlPolicy = { connectionIds: [], version: 0, globallyBlocked: false, revocationGenerations: {} };
		const sqlSnapshot = { policy: sqlPolicy, connections: [], connectionVersion: 0, accountsByServer: {}, principalVersion: 0 };
		const sqlPolicyAdmissions: number[] = [];
		const sqlWorkbench = sqlWorkbenchStub();
		sqlWorkbench.tryRunWithSqlOwnerSnapshotLock = async (work: (snapshot: typeof sqlSnapshot) => unknown) => {
			sqlPolicyAdmissions.push(sqlPolicy.version);
			return { acquired: true, value: await work(sqlSnapshot) };
		};
		let queryEditor: QueryEditorProvider | undefined;
		let nativeDocument: vscode.TextDocument | undefined;
		let receive: ((message: any) => unknown) | undefined;
		let trace: { mark(event: string, detail?: Readonly<Record<string, unknown>>): void } | undefined;
		let originalTraceMark: NonNullable<typeof trace>['mark'] | undefined;
		let firstReadiness: Promise<boolean> | undefined;
		let firstReadinessResult: boolean | undefined;
		let holdRefresh = false;
		let holdProof = false;
		let holdNextPreparation = false;
		let proofEntered = false;
		let physicalSettled = false;
		let revealCount = 0;
		let rejectRenewedDelivery = false;
		let beginPreparation!: () => void;
		let releasePreparation!: () => void;
		let beginProof!: () => void;
		let releaseProof!: () => void;
		let beginNextPreparation!: () => void;
		let releaseNextPreparation!: () => void;
		let releasePhysical!: () => void;
		const preparationStarted = new Promise<void>(resolve => { beginPreparation = resolve; });
		const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
		const proofStarted = new Promise<void>(resolve => { beginProof = resolve; });
		const proofGate = new Promise<void>(resolve => { releaseProof = resolve; });
		const nextPreparationStarted = new Promise<void>(resolve => { beginNextPreparation = resolve; });
		const nextPreparationGate = new Promise<void>(resolve => { releaseNextPreparation = resolve; });
		const physicalGate = new Promise<void>(resolve => { releasePhysical = resolve; });
		try {
			fs.writeFileSync(uri.fsPath, authoredBytes);
			if (scenario === 'consumed source-change follow-up') {
				(vscode.workspace as any).onDidChangeTextDocument = (
					listener: (event: vscode.TextDocumentChangeEvent) => unknown,
					thisArgs?: unknown,
					eventDisposables?: vscode.Disposable[],
				) => originalOnDidChange(event => {
					if (event.document === nativeDocument && event.contentChanges.length > 0) sourceChanges.push(event);
					else listener.call(thisArgs, event);
				}, undefined, eventDisposables);
			}
			if (scenario === 'SQL-produced comparison') {
				assert.strictEqual(publicationFromPersistedResultArtifact(sqlArtifact, 'query_comparison')?.producer?.engine, 'sql');
			}
			QueryEditorProvider.prototype.initializeWebviewPanel = async function () {
				if (queryEditor) return;
				queryEditor = this;
				trace = this.fileOpenTrace;
				assert.ok(trace);
				originalTraceMark = trace.mark;
				trace.mark = function (event, detail) {
					originalTraceMark!.call(this, event, detail);
					if (event === 'notify.transitions' && detail) readinessStates.push(detail);
					if (event === 'reload.settled' && detail) settlements.push(detail);
				};
			};
			QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh = async function (state, publish, observer) {
				if (this !== queryEditor) return originalPublish.bind(this)(state, publish, observer);
				if (holdRefresh) {
					holdRefresh = false;
					beginPreparation();
					await preparationGate;
				} else if (holdProof) {
					holdProof = false;
					const waitForProof = async () => {
						proofEntered = true;
						beginProof();
						await proofGate;
					};
					const finishProof = async (sanitized: typeof state) => {
						const candidate = scenario === 'projected state changed' ? { ...sanitized,
							sections: sanitized.sections?.map(section => {
								const record = section as Record<string, unknown>;
								return record.id === 'query_1' ? { ...record, expanded: true } : section;
							}),
						} as typeof sanitized : sanitized;
						const result = await publish(candidate);
						proofResults.push(result);
						return result;
					};
					if (scenario === 'Kusto policy changed' || scenario === 'SQL policy changed'
						|| scenario === 'SQL-produced comparison' || scenario === 'owner replaced' || scenario === 'third invalidation'
						|| scenario === 'consumed source-change follow-up') {
						await waitForProof();
						return originalPublish.bind(this)(state, finishProof, observer);
					}
					return originalPublish.bind(this)(state, async sanitized => {
						await waitForProof();
						return finishProof(sanitized);
					}, observer);
				} else if (holdNextPreparation) {
					holdNextPreparation = false;
					beginNextPreparation();
					await nextPreparationGate;
				}
				return originalPublish.bind(this)(state, publish, observer);
			};
			QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = async function (fingerprint, commit) {
				const result = await originalCommit.call(this, fingerprint, commit);
				if (this === queryEditor) admissions.push(result);
				return result;
			};
			CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
				const reload = originalCreateReload.call(this, timeoutMs, options);
				reloads.push({ requestId: reload.requestId, deadline: options?.absoluteCommitDeadline });
				return reload;
			};
			const provider = new (KqlxEditorProvider as any)({
				subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
			}, vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connections, sqlWorkbench) as KqlxEditorProvider;
			const document = await vscode.workspace.openTextDocument(uri);
			nativeDocument = document;
			assert.strictEqual(liveDocuments.register(document), false);
			const version = document.version;
			const activeTextEditor = vscode.window.activeTextEditor;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') {
							projections.push(message);
							if (projections.length === 2 && scenario === 'physical settlement') {
								await physicalGate;
								physicalSettled = true;
							}
							if (rejectRenewedDelivery) return false;
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projections.at(-1));
						return { dispose() {} };
					},
				},
				reveal: () => { revealCount++; },
				onDidDispose: (handler: () => void) => { disposers.push(handler); return { dispose() {} }; },
			} as any;
			const acknowledge = (projection: any) => Promise.resolve(receive!({
				type: 'documentReloadResult', requestId: projection.reloadRequestId, applied: true, editRevision: 0,
				protocolVersion: projection.protocolVersion, channel: projection.channel, viewSessionId: projection.viewSessionId,
			}));
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(queryEditor);
			firstReadiness = (queryEditor as any).workbenchToolMutationReadiness();
			void firstReadiness!.then(result => { firstReadinessResult = result; });
			requests.push(Promise.resolve(receive!({ type: 'requestDocument' })));
			await waitForCondition(() => projections.length === 1, 'initial deferred-control projection must be posted', 1_000);
			requests.push(Promise.resolve(receive!({ type: 'requestDocument', requestId: 'deferred-control' })));
			await acknowledge(projections[0]);
			await waitForCondition(() => projections.length === 2, 'queued deferred-control projection must be posted', 1_000);
			const secondProjection = projections[1];
			if (scenario === 'SQL-produced comparison') {
				const comparison = secondProjection.state.sections.find((section: any) => section.id === 'query_comparison');
				assert.strictEqual(comparison?.resultArtifact?.producer?.engine, 'sql');
				assert.strictEqual(comparison.resultJson, JSON.stringify({ columns: [{ name: 'Value', dataType: 'int' }], rows: [[1]] }));
			}
			const originalDeadline = reloads.find(reload => reload.requestId === secondProjection.reloadRequestId)?.deadline;
			assert.strictEqual(typeof originalDeadline, 'number');
			const queue = (provider as any).markdownDocumentQueues.get(normalizeWorkbenchUriKey(uri)) as { tail: Promise<void> };
			if (scenario === 'consumed source-change follow-up') {
				const changeSource = async (value: number) => {
					const text = authoredBytes.toString('utf8').replace('print Value=1', `print Value=${value}`);
					const edit = new vscode.WorkspaceEdit();
					edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
					assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
					assert.strictEqual(document.getText(), text);
					assert.strictEqual(document.version, version + value - 1);
					assert.strictEqual(document.isDirty, true);
				};
				await changeSource(2);
				await acknowledge(secondProjection);
				await waitForCondition(() => projections.length === 3, 'the first source change must consume its one follow-up', 1_000);
				const followUp = projections[2];
				assert.strictEqual(followUp.state.sections[0].query, 'print Value=2');
				assert.strictEqual(reloads[2].deadline, originalDeadline);
				holdRefresh = true;
				(queryEditor as any).persistedResultSanitizationApplication.invalidateKustoPersistence();
				await preparationStarted;
				const preparationTail = queue.tail;
				releasePreparation();
				await preparationTail;
				assert.strictEqual(projections.length, 3);
				holdProof = true;
				await acknowledge(followUp);
				await proofStarted;
				assert.deepStrictEqual(admissions, [true, true]);
				assert.strictEqual(firstReadinessResult, undefined);
				policy.version++;
				releaseProof();
				await waitForCondition(() => proofResults.length === 1, 'the changed policy must fail the deferred fresh proof', 1_000);
				assert.deepStrictEqual(proofResults, [false]);
				await waitForCondition(() => projections.length === 4, 'the failed proof must use its existing attempt budget', 1_000);
				const fallback = projections[3];
				assert.strictEqual(fallback.state.sections[0].query, 'print Value=2');
				assert.strictEqual(reloads[3].deadline, originalDeadline);
				await changeSource(3);
				rejectRenewedDelivery = true;
				await acknowledge(fallback);
				await Promise.all(requests);
				await queue.tail;
				await waitForCondition(() => readinessStates.at(-1)?.pendingDocumentProjections === 0
					&& readinessStates.at(-1)?.pendingProjectionActivationSize === 0,
					'the second source change must settle without another pending delivery', 1_000);
				const settlement = settlements.find(detail => detail.generation === fallback.sourceGeneration);
				assert.ok(settlement);
				assert.deepStrictEqual({ eligible: settlement.retryEligible, sourceCurrent: settlement.retrySourceCurrent,
					remainingAttempts: settlement.remainingAttempts }, { eligible: true, sourceCurrent: false, remainingAttempts: 1 });
				assert.ok(performance.now() < originalDeadline!, 'the exhausted follow-up must be tested before its original deadline');
				assert.ok(reloads.slice(1).every(reload => reload.deadline === originalDeadline));
				console.log('[native deferred consumed follow-up]', JSON.stringify({ projections: projections.length,
					renewedProjections: projections.length - 4, reloads: reloads.length,
					remainingAttempts: settlement.remainingAttempts, deadlineRetained: true }));
				assert.strictEqual(projections.length, 4, 'a deferred fallback must not renew a consumed source-change follow-up or its three-attempt budget');
				assert.strictEqual(reloads.length, 4);
				assert.strictEqual(sourceChanges.length, 2);
				assert.deepStrictEqual(admissions, [true, true]);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
				assert.strictEqual(firstReadinessResult, undefined);
				assert.deepStrictEqual(fs.readFileSync(uri.fsPath), authoredBytes);
				assert.strictEqual(vscode.window.activeTextEditor, activeTextEditor);
				assert.strictEqual(revealCount, 0);
				return;
			}
			holdRefresh = true;
			(queryEditor as any).persistedResultSanitizationApplication.invalidateKustoPersistence();
			await preparationStarted;
			const preparationTail = queue.tail;
			releasePreparation();
			await preparationTail;
			assert.strictEqual(projections.length, 2);
			holdProof = true;
			await acknowledge(secondProjection);
			assert.deepStrictEqual(admissions, [true, true]);
			if (scenario === 'physical settlement') {
				assert.strictEqual(physicalSettled, false);
				assert.strictEqual(proofEntered, false, 'logical ACK completion must not start a proof before SDK settlement');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
				releasePhysical();
			}
			await proofStarted;
			await Promise.all(requests);
			assert.strictEqual(firstReadinessResult, undefined, 'the first waiter must remain pending while fresh proof is held');
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
			if (scenario === 'Kusto policy changed') policy.version++;
			if (scenario === 'SQL policy changed' || scenario === 'SQL-produced comparison') sqlPolicy.version++;
			if (scenario === 'runtime replaced') {
				await Promise.resolve(receive!({ type: 'mainWebviewDispatcherReady', runtimeId: 'deferred-replacement-runtime' }));
				const probe = posted.filter(message => message.type === 'mainWebviewDispatcherProbe').at(-1);
				if (probe) await Promise.resolve(receive!({ type: 'mainWebviewDispatcherReady', runtimeId: 'deferred-replacement-runtime', probeId: probe.probeId }));
			}
			if (scenario === 'owner replaced') {
				let replacementReceive: ((message: any) => unknown) | undefined;
				let replacementProjection: any;
				const replacementPanel = {
					webview: {
						options: {},
						postMessage: async (message: any) => { if (message?.type === 'documentData') replacementProjection = message; return true; },
						onDidReceiveMessage: (handler: any) => {
							replacementReceive = wrapDocumentViewTestReceiver(handler, () => replacementProjection);
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposers.push(handler); return { dispose() {} }; },
				} as any;
				await provider.resolveCustomTextEditor(document, replacementPanel, {} as any);
				const replacementRequest = Promise.resolve(replacementReceive!({ type: 'requestDocument' }));
				requests.push(replacementRequest);
				await waitForCondition(() => !!replacementProjection, 'the replacement owner must project through its own panel', 1_000);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, replacementPanel), false);
				await Promise.resolve(replacementReceive!({ type: 'documentReloadResult', requestId: replacementProjection.reloadRequestId,
					applied: true, editRevision: 0, protocolVersion: replacementProjection.protocolVersion,
					channel: replacementProjection.channel, viewSessionId: replacementProjection.viewSessionId }));
				await replacementRequest;
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, replacementPanel), true,
					'only the replacement panel\'s own accepted projection may initialize it');
			}
			if (scenario === 'disposed') for (const dispose of disposers.splice(0)) dispose();
			if (scenario === 'source version ABA') {
				for (const text of [authoredBytes.toString('utf8') + ' ', authoredBytes.toString('utf8')]) {
					const edit = new vscode.WorkspaceEdit();
					edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
					assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
				}
				assert.ok(document.version > version);
			}
			if (scenario === 'third invalidation') {
				policy.version++;
				holdNextPreparation = true;
				(queryEditor as any).persistedResultSanitizationApplication.invalidateKustoPersistence();
				releaseProof();
				await nextPreparationStarted;
				assert.deepStrictEqual(proofResults, [false], 'the superseded proof must reject its own stale sequence');
				assert.strictEqual(firstReadinessResult, undefined);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
					'the old finally must not clear the newest pending requirement');
				releaseNextPreparation();
				await waitForCondition(() => projections.length === 3, 'changed policy requires a new actual projection', 1_000);
				assert.strictEqual(reloads.find(reload => reload.requestId === projections[2].reloadRequestId)?.deadline, originalDeadline,
					'a third invalidation must not restart the original attempt deadline');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
				await acknowledge(projections[2]);
			} else {
				releaseProof();
				await waitForCondition(() => proofResults.length === 1, 'the exact fresh proof must settle', 1_000);
				assert.deepStrictEqual(proofResults, [scenario === 'physical settlement']);
				if (scenario === 'disposed') {
					assert.strictEqual(await firstReadiness, false);
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
					assert.strictEqual(projections.length, 2);
					return;
				}
				if (scenario !== 'physical settlement') {
					await waitForCondition(() => projections.length > 2
						&& (scenario !== 'source version ABA' || projections.at(-1).sourceGeneration === readinessStates.at(-1)?.postDocumentGeneration),
						'the stale proof requires an actual current projection', 1_000);
					assert.ok(projections.at(-1).sourceGeneration > secondProjection.sourceGeneration);
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
					assert.strictEqual(firstReadinessResult, undefined);
					if (scenario !== 'source version ABA') {
						assert.strictEqual(reloads.find(reload => reload.requestId === projections.at(-1).reloadRequestId)?.deadline, originalDeadline);
					}
					await acknowledge(projections.at(-1));
				}
			}
			await queue.tail;
			await waitForCondition(() => readinessStates.at(-1)?.pendingDocumentProjections === 0,
				'all exact deferred-control work must physically drain', 1_000);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
			assert.strictEqual(await firstReadiness, true);
			assert.deepStrictEqual(admissions, scenario === 'physical settlement' ? [true, true] : [true, true, true]);
			if (scenario !== 'source version ABA') assert.strictEqual(projections.length, scenario === 'physical settlement' ? 2 : 3);
			if (scenario === 'SQL policy changed' || scenario === 'SQL-produced comparison') {
				assert.strictEqual(policy.version, 0, 'SQL policy changes must be independent of the Kusto fingerprint');
				assert.ok(sqlPolicyAdmissions.includes(1), 'the fresh publisher must acquire the changed canonical SQL policy');
			}
			assert.deepStrictEqual(fs.readFileSync(uri.fsPath), authoredBytes);
			assert.strictEqual(document.getText(), authoredBytes.toString('utf8'));
			if (scenario !== 'source version ABA') {
				assert.strictEqual(document.version, version);
				assert.strictEqual(document.isDirty, false);
			}
			assert.strictEqual(vscode.window.activeTextEditor, activeTextEditor);
			assert.strictEqual(revealCount, 0);
		} finally {
			releasePreparation();
			releaseProof();
			releaseNextPreparation();
			releasePhysical();
			try {
				for (const dispose of disposers.splice(0)) dispose();
				await Promise.allSettled(requests);
				await firstReadiness;
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true);
			} finally {
				for (const subscription of subscriptions) subscription.dispose();
				if (trace && originalTraceMark) trace.mark = originalTraceMark;
				QueryEditorProvider.prototype.initializeWebviewPanel = originalInitialize;
				QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
				QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = originalCommit;
				CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
				(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			}
			if (nativeDocument?.isDirty) assert.strictEqual(await nativeDocument.save(), true);
		}
	});

	for (const scenario of ['retained', 'policy changed', 'policy changed before preparation', 'preparation failed', 'runtime replaced', 'explicit rejection first', 'superseded', 'disposed', 'source version ABA', 'local persist'] as const) test(`automatic revision-rejected refresh retains an unchanged accepted native view (${scenario})`, async function () {
		this.timeout(10_000);
		const originalInitialize = QueryEditorProvider.prototype.initializeWebviewPanel;
		const originalPublish = QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh;
		const originalCommit = QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-conditional-refresh-readiness-'));
		const filePath = path.join(tmpDir, 'conditional.kqlx');
		const uri = vscode.Uri.file(filePath);
		const authoredBytes = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_1', type: 'query', query: 'print Value=1', expanded: false },
			{ id: 'markdown_1', type: 'markdown', text: '# Authored state', mode: 'preview' },
		] } }, null, 2) + '\n');
		const subscriptions: vscode.Disposable[] = [];
		const disposers: Array<() => void> = [];
		const projections: any[] = [];
		const posted: any[] = [];
		const policy = { clusterKeys: [], version: 0, globallyBlocked: false, revocationGenerations: {} };
		const connections = connectionManagerStub();
		connections.runWithLeaveNoTraceSnapshotLock = async (work: (snapshot: typeof policy) => unknown) => work(policy);
		let queryEditor: QueryEditorProvider | undefined;
		let receive: ((message: any) => unknown) | undefined;
		let holdRefresh = false;
		let beginPreparation!: () => void;
		let releasePreparation!: () => void;
		const preparationStarted = new Promise<void>(resolve => { beginPreparation = resolve; });
		const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve; });
		let holdRecovery = false;
		let captureRecovery = false;
		const recoveryResults: boolean[] = [];
		let beginRecovery!: () => void;
		let releaseRecovery!: () => void;
		const recoveryStarted = new Promise<void>(resolve => { beginRecovery = resolve; });
		const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve; });
		let holdNextPreparation = false;
		let beginNextPreparation!: () => void;
		let releaseNextPreparation!: () => void;
		const nextPreparationStarted = new Promise<void>(resolve => { beginNextPreparation = resolve; });
		const nextPreparationGate = new Promise<void>(resolve => { releaseNextPreparation = resolve; });
		let recoveryAcknowledgement: Promise<unknown> | undefined;
		let initialRequest: Promise<unknown> | undefined;
		try {
			fs.writeFileSync(filePath, authoredBytes);
			QueryEditorProvider.prototype.initializeWebviewPanel = async function () { queryEditor = this; };
			QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh = async function (state, publish, observer) {
				if (this === queryEditor && holdNextPreparation) {
					holdNextPreparation = false;
					beginNextPreparation();
					await nextPreparationGate;
				}
				if (this === queryEditor && holdRefresh) {
					holdRefresh = false;
					beginPreparation();
					await preparationGate;
					if (scenario === 'preparation failed') throw new Error('Policy preparation unavailable');
				}
				return originalPublish.bind(this)(state, publish, observer);
			};
			QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = async function (fingerprint, commit) {
				if (this === queryEditor && holdRecovery) {
					holdRecovery = false;
					beginRecovery();
					await recoveryGate;
				}
				const result = await originalCommit.call(this, fingerprint, commit);
				if (captureRecovery) recoveryResults.push(result);
				return result;
			};
			const provider = new (KqlxEditorProvider as any)({
				subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
			}, vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connections, sqlWorkbenchStub()) as KqlxEditorProvider;
			const document = await vscode.workspace.openTextDocument(uri);
			const version = document.version;
			assert.strictEqual(liveDocuments.register(document), false);
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => { posted.push(message); if (message?.type === 'documentData') projections.push(message); return true; },
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projections.at(-1));
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposers.push(handler); return { dispose() {} }; },
			} as any;
			const acknowledge = (projection: any, applied: boolean, editRevision: number) => Promise.resolve(receive!({
				type: 'documentReloadResult', requestId: projection.reloadRequestId, applied, editRevision,
				protocolVersion: projection.protocolVersion, channel: projection.channel, viewSessionId: projection.viewSessionId,
			}));
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			initialRequest = Promise.resolve(receive!({ type: 'requestDocument' }));
			await waitForCondition(() => projections.length === 1, 'initial projection must be posted', 1_000);
			const accepted = projections[0];
			await acknowledge(accepted, true, 0);
			await initialRequest;
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
			const acceptedSnapshotIdentity = (queryEditor as any).workbenchToolSnapshotIdentity();
			if (scenario === 'runtime replaced') {
				await Promise.resolve(receive!({ type: 'mainWebviewDispatcherReady', runtimeId: 'replacement-runtime' }));
				const probe = posted.filter(message => message.type === 'mainWebviewDispatcherProbe').at(-1);
				if (probe) await Promise.resolve(receive!({ type: 'mainWebviewDispatcherReady', runtimeId: 'replacement-runtime', probeId: probe.probeId }));
			}
			if (scenario === 'explicit rejection first') {
				const explicit = Promise.resolve(receive!({ type: 'requestDocument', requestId: 'explicit-rejected-refresh', expectedEditRevision: 0 }));
				await waitForCondition(() => projections.length === 2, 'explicit conditional request must be posted', 1_000);
				await acknowledge(projections[1], false, 0);
				await explicit;
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
			}
			const priorProjectionCount = projections.length;
			holdRefresh = true;
			(queryEditor as any).persistedResultSanitizationApplication.invalidateKustoPersistence();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
				'automatic invalidation must revoke cached readiness before its queued work starts');
			await preparationStarted;
			const localEditRevision = 1;
			if (scenario === 'policy changed before preparation') policy.version++;
			releasePreparation();
			if (scenario === 'preparation failed') {
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.strictEqual(projections.length, priorProjectionCount, 'failed preparation must not post a projection');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
					'failed automatic preparation must not advertise historical readiness');
				assert.deepStrictEqual(fs.readFileSync(filePath), authoredBytes);
				assert.strictEqual(document.version, version);
				assert.strictEqual(document.isDirty, false);
				return;
			}
			await waitForCondition(() => projections.length === priorProjectionCount + 1, 'automatic conditional refresh must be posted', 1_000);
			const rejected = projections.at(-1);
			assert.strictEqual(rejected.forceReload, true);
			assert.strictEqual(rejected.expectedEditRevision, 0);
			assert.ok(rejected.sourceGeneration > accepted.sourceGeneration);
			assert.strictEqual(rejected.viewSessionId, accepted.viewSessionId);
			assert.notStrictEqual(rejected.expectedEditRevision, localEditRevision);
			if (scenario === 'policy changed') policy.version++;
			if (scenario === 'disposed') for (const dispose of disposers) dispose();
			if (scenario === 'source version ABA') {
				for (const text of [authoredBytes.toString('utf8') + ' ', authoredBytes.toString('utf8')]) {
					const edit = new vscode.WorkspaceEdit();
					edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
					assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
				}
				assert.ok(document.version > version);
			}
			holdRecovery = scenario === 'superseded';
			captureRecovery = true;
			recoveryAcknowledgement = acknowledge(rejected, false, localEditRevision);
			if (scenario === 'superseded') {
				await recoveryStarted;
				holdNextPreparation = true;
				(queryEditor as any).persistedResultSanitizationApplication.invalidateKustoPersistence();
				await nextPreparationStarted;
				assert.strictEqual(projections.length, priorProjectionCount + 1, 'new invalidation has not issued another generation yet');
				releaseRecovery();
			}
			await recoveryAcknowledgement;
			if (scenario === 'superseded' || scenario === 'policy changed before preparation') {
				assert.deepStrictEqual(recoveryResults, [false], 'the old proof itself must fail independently of pending counters');
			}
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepStrictEqual(fs.readFileSync(filePath), authoredBytes);
			assert.strictEqual(document.getText(), authoredBytes.toString('utf8'));
			if (scenario !== 'source version ABA') {
				assert.strictEqual(document.version, version);
				assert.strictEqual(document.isDirty, false);
			}
			const retained = scenario === 'retained' || scenario === 'local persist';
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), retained,
				'only a rejected automatic refresh with an unchanged accepted owner may retain readiness');
			const retainedSnapshotIdentity = (queryEditor as any).workbenchToolSnapshotIdentity();
			assert.strictEqual(retainedSnapshotIdentity.split(':')[0], acceptedSnapshotIdentity.split(':')[0],
				'the rejected generation must not replace the accepted runtime');
			assert.notStrictEqual(retainedSnapshotIdentity, acceptedSnapshotIdentity,
				'the attempted refresh must still invalidate older snapshot observations');
			if (retained) assert.strictEqual(await (queryEditor as any).workbenchToolMutationReadiness(), true);
			if (scenario === 'local persist') {
				const state = JSON.parse(JSON.stringify(accepted.state));
				state.sections.find((section: any) => section.id === 'query_1').query = 'print Value=2';
				await Promise.resolve(receive!({ type: 'persistDocument', snapshotId: 'retained-local-persist', editRevision: 1,
					sourceGeneration: accepted.sourceGeneration, state }));
				assert.ok(posted.some(message => message.type === 'persistDocumentAck' && message.snapshotId === 'retained-local-persist'));
				assert.strictEqual(JSON.parse(document.getText()).state.sections[0].query, 'print Value=2');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
				assert.strictEqual(await (queryEditor as any).workbenchToolMutationReadiness(), true);
			}
		} finally {
			releasePreparation();
			releaseRecovery();
			releaseNextPreparation();
			for (const dispose of disposers) dispose();
			await recoveryAcknowledgement?.catch(() => undefined);
			await initialRequest?.catch(() => undefined);
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const subscription of subscriptions) subscription.dispose();
			QueryEditorProvider.prototype.initializeWebviewPanel = originalInitialize;
			QueryEditorProvider.prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = originalCommit;
		}
	});

	for (const outcome of ['accepted', 'host retry', 'webview rejection', 'host rejection', 'disposed'] as const) {
		test(`initial projection initialization waiter handles ${outcome}`, async () => {
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalCommit = QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-initial-projection-budget-'));
			const filePath = path.join(tmpDir, 'bounded.kqlx');
			const uri = vscode.Uri.file(filePath);
			const otherUri = vscode.Uri.file(path.join(tmpDir, 'other.kqlx'));
			const currentText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print Value=1' },
				] },
			});
			let receiveHandler: ((message: any) => unknown) | undefined;
			let latestProjection: any;
			let projectionCount = 0;
			let admissionAttempts = 0;
			let revealCount = 0;
			let queryEditor: QueryEditorProvider | undefined;
			let initialized: boolean | undefined;
			let initializing: Promise<boolean> | undefined;
			const disposeHandlers: Array<() => void> = [];
			const listeners = (KqlxEditorProvider as unknown as {
				panelChangeListenersByUri: Map<string, Set<() => void>>;
			}).panelChangeListenersByUri;
			const key = normalizeWorkbenchUriKey(uri);
			const accepted = outcome === 'accepted' || outcome === 'host retry';
			const expectedAttempts = outcome === 'host retry' ? 2
				: outcome === 'webview rejection' || outcome === 'host rejection' ? 3 : 1;

			try {
				fs.writeFileSync(filePath, currentText, 'utf8');
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (this: QueryEditorProvider) {
					queryEditor = this;
				};
				QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = async function (fingerprint, commit) {
					if (this === queryEditor) {
						admissionAttempts++;
						if (outcome === 'host rejection' || (outcome === 'host retry' && admissionAttempts === 1)) {
							return false;
						}
					}
					return originalCommit.call(this, fingerprint, commit);
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
					uri, getText: () => currentText, eol: vscode.EndOfLine.LF,
					positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
				} as any;
				const panel = {
					reveal: () => { revealCount++; },
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.type === 'documentData') {
								projectionCount++;
								latestProjection = message;
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => {
						disposeHandlers.push(handler);
						return { dispose() {} };
					},
				} as any;

				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), false);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, -1), false);
				initializing = KqlxEditorProvider.waitForOpenEditorInitialized(uri, 2_000).then(value => {
					initialized = value;
					return value;
				});
				assert.strictEqual(listeners.get(key)?.size, 1);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 1), false);
				assert.strictEqual(listeners.get(key)?.size, 1, 'an expired waiter must not remove another waiter');
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.strictEqual(initialized, undefined, 'panel registration must not initialize the editor');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), false);
				const request = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				for (let attempt = 1; attempt <= expectedAttempts; attempt++) {
					await waitForCondition(() => projectionCount === attempt, `projection ${attempt} must be posted`, 1_000);
					assert.strictEqual(latestProjection.sourceGeneration, attempt);
					assert.strictEqual(initialized, undefined, 'sent projections and rejected admissions must remain uninitialized');
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), false);
					if (outcome === 'disposed') {
						for (const dispose of disposeHandlers) dispose();
					}
					await Promise.resolve(receiveHandler!({
						type: 'documentReloadResult', requestId: latestProjection.reloadRequestId,
						applied: outcome !== 'webview rejection', editRevision: 0,
					}));
				}
				await request;
				assert.strictEqual(await initializing, accepted);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), accepted);
				assert.strictEqual(projectionCount, expectedAttempts, 'initial recovery must retain the three-attempt total budget');
				assert.strictEqual(admissionAttempts, outcome === 'webview rejection' || outcome === 'disposed' ? 0 : expectedAttempts);
				assert.strictEqual(listeners.has(key), false, 'settled waiters must release their listeners');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(otherUri, 1), false);
				assert.strictEqual(listeners.has(normalizeWorkbenchUriKey(otherUri)), false);
				for (const dispose of disposeHandlers) dispose();
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), false);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000), true);
				const replacement = KqlxEditorProvider.trackOpenEditor(uri, {} as vscode.WebviewPanel);
				try {
					await Promise.resolve(receiveHandler!({
						type: 'documentReloadResult', requestId: latestProjection.reloadRequestId,
						applied: true, editRevision: 0,
					}));
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), false);
					replacement.beginClosing();
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0), false);
				} finally {
					replacement.dispose();
				}
				assert.strictEqual(revealCount, 0, 'initialization waiting must not reveal or focus the panel');
			} finally {
				for (const dispose of disposeHandlers) dispose();
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				await initializing;
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = originalCommit;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});
	}

	for (const outcome of ['fresh recovery', 'failed request deduplication', 'pending settlement', 'bounded correlations', 'issued challenge', 'regular read'] as const) {
		test(`native initial recovery handles ${outcome} without changing its source`, async function () {
			this.timeout(20_000);
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalRead = (KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument;
			const originalSetInbound = MainWebviewStartupGateway.prototype.setInboundHandler;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-initial-recovery-'));
			const filePath = path.join(tmpDir, 'recovery.kqlx');
			const uri = vscode.Uri.file(filePath);
			const authoredFile = {
				kind: 'kqlx', version: 1, futureRoot: { keep: true }, state: { sections: [
					{ id: 'query_canary', type: 'query', query: 'print Canary=10', expanded: false },
					{ id: 'markdown_authored', type: 'markdown', text: '# Authored note\n+ Keep this marker\n', mode: 'preview' },
				] },
			};
			const authoredBytes = Buffer.from(JSON.stringify(authoredFile, null, 2) + '\n', 'utf8');
			let document: vscode.TextDocument | undefined;
			let queryEditor: QueryEditorProvider | undefined;
			let receiveHandler: ((message: any) => unknown) | undefined;
			let nativeMessageHandler: ((message: any) => void | PromiseLike<void>) | undefined;
			let gateway: MainWebviewStartupGateway<unknown> | undefined;
			const runtimeId = `native-recovery-runtime-${outcome}`;
			const dispatcherProbes: string[] = [];
			const admittedRequestIds: Array<string | undefined> = [];
			let documentRecoveryProbeId: string | undefined;
			let runtimeProjection: any;
			let snapshotProjection: any;
			let documentDeliveryAvailable = false;
			let holdSettlement = false;
			let settlementHeld = false;
			let releaseSettlement!: () => void;
			const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve; });
			const projections: any[] = [];
			const requests: Promise<unknown>[] = [];
			const disposeHandlers: Array<() => void> = [];
			const subscriptions: vscode.Disposable[] = [];
			let snapshotRequests = 0;
			let revealCount = 0;
			const readRecovery = outcome === 'issued challenge' || outcome === 'regular read';
			const requestDocument = (requestId?: string) => {
				const handler = outcome === 'pending settlement' && requestId !== undefined
					? nativeMessageHandler! : receiveHandler!;
				const request = Promise.resolve(handler({ type: 'requestDocument', requestId }));
				requests.push(request);
				return request;
			};
			const acknowledge = (projection: any, applied = true) => {
				if (applied && documentDeliveryAvailable && projection === projections.at(-1)) runtimeProjection = projection;
				return Promise.resolve(receiveHandler!({
					protocolVersion: projection.protocolVersion, channel: projection.channel,
					viewSessionId: projection.viewSessionId, type: 'documentReloadResult',
					requestId: projection.reloadRequestId, applied, editRevision: 0,
				}));
			};

			try {
				fs.writeFileSync(filePath, authoredBytes);
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (
					this: QueryEditorProvider, panel: vscode.WebviewPanel,
				) {
					queryEditor = this;
					(this as any).panel = panel;
					(this as any)._panelDisposed = false;
				};
				MainWebviewStartupGateway.prototype.setInboundHandler = function (handler) {
					gateway = this;
					nativeMessageHandler = message => {
						if (message?.type === 'requestDocument') admittedRequestIds.push(message.requestId);
						return handler(message);
					};
					return originalSetInbound.call(this, nativeMessageHandler);
				};
				(KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument = async function (
					this: KqlxEditorProvider, sourceDocument: vscode.TextDocument, isSessionFile: boolean,
				) {
					const text = await originalRead.call(this, sourceDocument, isSessionFile);
					if (sourceDocument === document && holdSettlement) {
						holdSettlement = false;
						settlementHeld = true;
						await settlementGate;
					}
					return text;
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				document = await vscode.workspace.openTextDocument(uri);
				const originalVersion = document.version;
				assert.strictEqual(liveDocuments.register(document), false, 'recovery must use a real native TextDocument');
				const panel = {
					visible: false, active: false,
					reveal: () => { revealCount++; },
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.type === 'mainWebviewDispatcherProbe') {
								dispatcherProbes.push(message.probeId);
								if (!runtimeProjection && documentRecoveryProbeId !== message.probeId) {
									documentRecoveryProbeId = message.probeId;
									void requestDocument(`dispatcher-document-${message.probeId}`);
								}
								await Promise.resolve(receiveHandler!({ type: 'mainWebviewDispatcherReady', runtimeId, probeId: message.probeId }));
							}
							if (message?.type === 'documentData') {
								projections.push(message);
								if (outcome === 'pending settlement' && projections.length === 3) holdSettlement = true;
								return documentDeliveryAvailable;
							}
							if (message?.type === 'requestToolState') {
								snapshotRequests++;
								snapshotProjection = runtimeProjection;
								assert.ok(snapshotProjection, 'a snapshot must come from an applied runtime projection');
								const response = createToolStateResponseMessage(message.requestId, snapshotProjection.state.sections);
								assert.ok(response.ok, 'the runtime must emit a canonical typed tool-state response');
								await Promise.resolve(receiveHandler!(response.value));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receiveHandler = wrapDocumentViewTestReceiver(handler, () => projections.at(-1));
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				const assertSourceUnchanged = () => {
					assert.deepStrictEqual(fs.readFileSync(filePath), authoredBytes);
					assert.strictEqual(document!.getText(), authoredBytes.toString('utf8'));
					assert.deepStrictEqual(JSON.parse(document!.getText()), authoredFile);
					assert.strictEqual(document!.version, originalVersion);
					assert.strictEqual(document!.isDirty, false);
					for (const projection of projections) {
						assert.strictEqual(projection.state.sections[0].query, 'print Canary=10');
						assert.strictEqual(projection.state.sections[1].text, authoredFile.state.sections[1].text);
					}
				};

				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'mainWebviewDispatcherReady', runtimeId }));
				const initialRequest = requestDocument();
				if (outcome === 'pending settlement') {
					await waitForCondition(() => settlementHeld, 'the old failed run must be held at its settlement read', 1_000);
				} else await initialRequest;
				assert.strictEqual(projections.length, 3, 'initial delivery failure must exhaust exactly three attempts');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
				assertSourceUnchanged();

				const beforeUnissuedRequests = admittedRequestIds.length;
				for (let repeat = 0; repeat < 2; repeat++) {
					await Promise.resolve(receiveHandler!({ type: 'requestDocument', requestId: 'dispatcher-document-unissued-recovery' }));
				}
				assert.strictEqual(admittedRequestIds.length, beforeUnissuedRequests, 'unissued prefix-only requests must be dropped before provider effects');
				assert.strictEqual(projections.length, 3, 'unissued requests must not rearm native recovery');
				assertSourceUnchanged();

				if (outcome === 'bounded correlations') {
					for (let requestIndex = 0; requestIndex < 64; requestIndex++) {
						await requestDocument(`native-bounded-${requestIndex}`);
						assert.strictEqual(projections.length, 3 + (requestIndex + 1) * 3,
							'each admitted fresh correlation must have only its own three-attempt budget');
					}
					documentDeliveryAvailable = true;
					await requestDocument('native-bounded-overflow');
					await requestDocument('native-bounded-0');
					await requestDocument();
					assert.strictEqual(projections.length, 195, 'the bounded ledger must neither evict tombstones nor admit overflow');
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
					assertSourceUnchanged();
					return;
				}

				if (outcome === 'failed request deduplication') {
					const failedRequestId = 'native-failed-recovery';
					await requestDocument(failedRequestId);
					assert.strictEqual(projections.length, 6, 'a fresh failed request must get exactly three deliveries');
					assert.ok(projections.slice(3).every(projection => projection.requestId === failedRequestId));
					await requestDocument(failedRequestId);
					await requestDocument();
					assert.strictEqual(projections.length, 6, 'a duplicate or automatic request must never rearm exhausted recovery');
					await acknowledge(projections.at(-1));
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
					assertSourceUnchanged();
				}

				documentDeliveryAvailable = true;
				let requestId = `native-recovery-${outcome}`;
				const beforeRecovery = projections.length;
				if (outcome === 'regular read') {
					assert.strictEqual(gateway!.isDispatcherReady, true,
						'ordinary recovery must start with cached READY after failed projection hydration');
					assert.strictEqual(panel.active, false);
					assert.strictEqual(panel.visible, false);
				}
				const recovery = readRecovery
					? queryEditor!.requestSectionsFromWebview() : requestDocument(requestId);
				if (readRecovery) requests.push(recovery);
				let recoverySettled = false;
				void recovery.then(() => { recoverySettled = true; });
				if (outcome === 'pending settlement') {
					await new Promise<void>(resolve => setImmediate(resolve));
					assert.strictEqual(projections.length, beforeRecovery, 'fresh recovery must coalesce until the old run settles');
					assert.strictEqual(recoverySettled, false, 'fresh recovery must not settle with the old failed run');
					releaseSettlement();
				}
				await waitForCondition(() => projections.length === beforeRecovery + 1,
					'a fresh explicit request must recover the unchanged source after initial exhaustion', 1_000);
				const recoveredProjection = projections.at(-1);
				if (readRecovery) {
					assert.strictEqual(dispatcherProbes.length, 1, 'read preflight must issue one actual dispatcher challenge');
					requestId = `dispatcher-document-${dispatcherProbes[0]}`;
					const beforeReplay = admittedRequestIds.length;
					await Promise.resolve(receiveHandler!({ type: 'requestDocument', requestId: `${requestId}-stale` }));
					await Promise.resolve(receiveHandler!({ type: 'requestDocument', requestId }));
					assert.strictEqual(admittedRequestIds.length, beforeReplay, 'mismatched and repeated issued challenges must not reach the provider');
					assert.strictEqual(admittedRequestIds.filter(id => id === requestId).length, 1);
				}
				assert.strictEqual(recoveredProjection.requestId, requestId, 'recovery must carry the fresh runtime correlation');
				assert.strictEqual(recoveredProjection.viewSessionId, projections[0].viewSessionId);
				assert.ok(recoveredProjection.sourceGeneration > projections[0].sourceGeneration);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
					'delivery without the new acknowledgement must not restore readiness');
				await acknowledge(projections[0]);
				await acknowledge({ ...recoveredProjection, reloadRequestId: `${recoveredProjection.reloadRequestId}-stale` });
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false,
					'an old or mismatched acknowledgement must not accept the fresh projection');
				assertSourceUnchanged();
				assert.strictEqual(snapshotRequests, 0, 'read preflight must not post a snapshot before the current projection acknowledgement');
				await acknowledge(recoveredProjection);
				await recovery;
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true,
					'only the exact accepted fresh projection must restore readiness');
				const sections = readRecovery ? await recovery : await queryEditor!.requestSectionsFromWebview();
				assert.strictEqual(snapshotRequests, 1, 'the real snapshot API must reach the recovered runtime');
				assert.strictEqual(JSON.stringify(sections), JSON.stringify(recoveredProjection.state.sections));
				assert.strictEqual(snapshotProjection, recoveredProjection, 'the snapshot must capture the exact current applied projection');
				if (readRecovery) {
					const beforeRetiredReplay = admittedRequestIds.length;
					assert.ok(gateway);
					assert.strictEqual(await gateway.beginDispatcherRevalidation(), true);
					assert.strictEqual(dispatcherProbes.length, 2);
					await Promise.resolve(receiveHandler!({ type: 'requestDocument', requestId }));
					assert.strictEqual(admittedRequestIds.length, beforeRetiredReplay, 'an old episode challenge must be dropped before provider effects');
					assert.strictEqual(projections.length, beforeRecovery + 1);
					assert.strictEqual(snapshotRequests, 1);
				}
				assertSourceUnchanged();
				assert.strictEqual(revealCount, 0, 'ordinary read recovery must not reveal or activate the hidden panel');
			} finally {
				releaseSettlement();
				for (const dispose of disposeHandlers) dispose();
				await Promise.allSettled(requests);
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				for (const subscription of subscriptions) subscription.dispose();
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				(KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument = originalRead;
				MainWebviewStartupGateway.prototype.setInboundHandler = originalSetInbound;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});
	}

	test('retired view session cannot acknowledge, command, or release successor Save work', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-document-view-session-'));
		const filePath = path.join(tmpDir, 'session-fence.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
			] },
		}, null, 2) + '\n';
		const willSaveHandlers: Array<(event: vscode.TextDocumentWillSaveEvent) => unknown> = [];
		const didSaveHandlers: Array<(document: vscode.TextDocument) => unknown> = [];

		const document = {
			uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
		} as vscode.TextDocument;
		const createPanel = () => {
			let receiveHandler: ((message: any) => unknown) | undefined;
			let projection: any;
			let barrierRequest: any;
			const posted: any[] = [];
			const disposeHandlers: Array<() => void> = [];
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.type === 'requestMarkdownCommandBarrier') barrierRequest = message;
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as any;
			return {
				panel,
				posted,
				receive: (message: any) => receiveHandler!(message),
				dispose: async () => {
					for (const handler of disposeHandlers) handler();
					await new Promise<void>(resolve => setImmediate(resolve));
				},
				get projection() { return projection; },
				get barrierRequest() { return barrierRequest; },
			};
		};
		const stamp = (projection: any, message: Record<string, unknown>) => ({
			protocolVersion: projection.protocolVersion,
			channel: projection.channel,
			viewSessionId: projection.viewSessionId,
			...message,
		});

		let first: ReturnType<typeof createPanel> | undefined;
		let second: ReturnType<typeof createPanel> | undefined;
		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				return true;
			};
			(vscode.workspace as any).onWillSaveTextDocument = (
				handler: (event: vscode.TextDocumentWillSaveEvent) => unknown,
			) => {
				willSaveHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (
				handler: (savedDocument: vscode.TextDocument) => unknown,
			) => {
				didSaveHandlers.push(handler);
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

			first = createPanel();
			await provider.resolveCustomTextEditor(document, first.panel, {} as any);
			const firstRequest = Promise.resolve(first.receive({ type: 'requestDocument' }));
			await waitForCondition(() => !!first?.projection, 'first view projection should be posted', 1_000);
			assert.strictEqual(first.projection.protocolVersion, 1);
			assert.strictEqual(first.projection.channel, 'document-view');
			assert.ok(typeof first.projection.viewSessionId === 'string' && first.projection.viewSessionId.length > 0);
			await Promise.resolve(first.receive(stamp(first.projection, {
				type: 'documentReloadResult', requestId: first.projection.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			})));
			await firstRequest;
			const retiredViewSessionId = first.projection.viewSessionId;
			await first.dispose();

			second = createPanel();
			await provider.resolveCustomTextEditor(document, second.panel, {} as any);
			let secondRequestSettled = false;
			const secondRequest = Promise.resolve(second.receive({ type: 'requestDocument' }))
				.then(() => { secondRequestSettled = true; });
			await waitForCondition(() => !!second?.projection, 'successor view projection should be posted', 1_000);
			assert.notStrictEqual(second.projection.viewSessionId, retiredViewSessionId);
			await Promise.resolve(second.receive({
				...stamp(second.projection, {
					type: 'documentReloadResult', requestId: second.projection.reloadRequestId,
					applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
				}),
				viewSessionId: retiredViewSessionId,
			}));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(secondRequestSettled, false, 'retired acknowledgement must not activate the successor projection');
			await Promise.resolve(second.receive(stamp(second.projection, {
				type: 'documentReloadResult', requestId: second.projection.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			})));
			await secondRequest;

			const command = {
				type: 'markdownDocumentCommand', commandId: 'session-fenced-command',
				sourceGeneration: second.projection.sourceGeneration,
				expectedDocumentRevision: second.projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: second.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'current session' },
				},
			};
			await Promise.resolve(second.receive({
				...stamp(second.projection, command),
				viewSessionId: retiredViewSessionId,
			}));
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'before');
			assert.strictEqual(second.posted.filter(message => message?.commandId === command.commandId).length, 0);
			await Promise.resolve(second.receive(stamp(second.projection, command)));
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'current session');
			const commandResults = second.posted.filter(message => message?.commandId === command.commandId);
			assert.strictEqual(commandResults.length, 1);
			assert.strictEqual(commandResults[0].ok, true);

			let savePreparation: Promise<vscode.TextEdit[]> | undefined;
			for (const handler of willSaveHandlers) {
				handler({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
						assert.strictEqual(savePreparation, undefined, 'only the live successor may join Save');
						savePreparation = Promise.resolve(thenable);
					},
				} as any);
			}
			await waitForCondition(() => !!second?.barrierRequest, 'successor Save barrier should be posted', 1_000);
			assert.ok(savePreparation);
			let saveSettled = false;
			void savePreparation!.then(() => { saveSettled = true; });
			await Promise.resolve(second.receive({
				...stamp(second.projection, {
					type: 'markdownDocumentCommandBarrierResult',
					requestId: second.barrierRequest.requestId,
					sourceGeneration: second.barrierRequest.sourceGeneration,
					documentRevision: commandResults[0].documentRevision,
					accepted: true,
				}),
				viewSessionId: retiredViewSessionId,
			}));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(saveSettled, false, 'retired barrier traffic must not release successor Save');
			await Promise.resolve(second.receive(stamp(second.projection, {
				type: 'markdownDocumentCommandBarrierResult',
				requestId: second.barrierRequest.requestId,
				sourceGeneration: second.barrierRequest.sourceGeneration,
				documentRevision: commandResults[0].documentRevision,
				accepted: true,
			})));
			await savePreparation;

			let postSaveCommandSettled = false;
			const postSaveCommand = Promise.resolve(second.receive(stamp(second.projection, {
				type: 'markdownDocumentCommand', commandId: 'post-save-session-command',
				sourceGeneration: commandResults[0].sourceGeneration,
				expectedDocumentRevision: commandResults[0].documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: commandResults[0].projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after Save' },
				},
			}))).then(() => { postSaveCommandSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(postSaveCommandSettled, false, 'accepted Save must retain its queue lease until didSave');
			for (const handler of didSaveHandlers) await Promise.resolve(handler(document));
			await postSaveCommand;
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after Save');
			assert.strictEqual(second.posted.filter(message => message?.commandId === 'post-save-session-command').length, 1);
		} finally {
			await second?.dispose();
			await first?.dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('cold-start panels share one queue and only the canonical panel joins Save', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cold-panel-owner-'));
		const filePath = path.join(tmpDir, 'cold-panels.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
			] },
		}, null, 2) + '\n';
		const willSaveHandlers: Array<(event: vscode.TextDocumentWillSaveEvent) => unknown> = [];
		const didSaveHandlers: Array<(document: vscode.TextDocument) => unknown> = [];
		let markFirstApplyStarted!: () => void;
		let releaseFirstApply!: () => void;
		const firstApplyStarted = new Promise<void>(resolve => { markFirstApplyStarted = resolve; });
		const firstApplyGate = new Promise<void>(resolve => { releaseFirstApply = resolve; });
		let gateFirstApply = true;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				didSaveHandlers.push(handler);
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (gateFirstApply && replacement.includes('from first panel')) {
					gateFirstApply = false;
					markFirstApplyStarted();
					await firstApplyGate;
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
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const createPanel = () => {
				let receive: ((message: any) => unknown) | undefined;
				let projection: any;
				let reloadRequestId = '';
				const posted: any[] = [];
				const disposeHandlers: Array<() => void> = [];
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type === 'documentData') {
								projection = message;
								reloadRequestId = message.reloadRequestId;
							}
							if (message?.type === 'requestMarkdownCommandBarrier') {
								await Promise.resolve(receive?.({
									type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
									sourceGeneration: message.sourceGeneration,
									documentRevision: projection.documentRevision, accepted: true,
								}));
							}
							if (message?.type === 'requestFinalPersist') {
								await Promise.resolve(receive?.({
									type: 'persistDocument', flushRequestId: message.requestId,
									sourceGeneration: projection.sourceGeneration,
									state: JSON.parse(currentText).state,
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receive = wrapDocumentViewTestReceiver(handler, () => projection);
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => {
						disposeHandlers.push(handler);
						return { dispose() {} };
					},
				} as any;
				return {
					panel, posted, disposeHandlers,
					receive: (message: any) => receive!(message),
					get projection() { return projection; },
					get reloadRequestId() { return reloadRequestId; },
				};
			};
			const first = createPanel();
			const second = createPanel();
			await provider.resolveCustomTextEditor(document, first.panel, {} as any);
			await provider.resolveCustomTextEditor(document, second.panel, {} as any);
			const firstRequest = Promise.resolve(first.receive({ type: 'requestDocument' }));
			const secondRequest = Promise.resolve(second.receive({ type: 'requestDocument' }));
			await waitForCondition(
				() => !!first.reloadRequestId && !!second.reloadRequestId,
				'both cold-start projection candidates should be posted',
				1_000,
			);
			assert.strictEqual((provider as any).markdownDocumentQueues.size, 1);
			await Promise.resolve(first.receive({
				type: 'documentReloadResult', requestId: first.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await firstRequest;
			let saveParticipants = 0;
			const savePreparations: Promise<vscode.TextEdit[]>[] = [];
			for (const handler of willSaveHandlers) {
				handler({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
						saveParticipants++;
						savePreparations.push(Promise.resolve(thenable));
					},
				} as any);
			}
			assert.strictEqual(saveParticipants, 1, 'the unacknowledged panel must not join native Save');
			await Promise.all(savePreparations);
			for (const handler of didSaveHandlers) await Promise.resolve(handler(document));

			const firstCommand = Promise.resolve(first.receive({
				type: 'markdownDocumentCommand', commandId: 'cold-first-command',
				sourceGeneration: first.projection.sourceGeneration,
				expectedDocumentRevision: first.projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: first.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'from first panel' },
				},
			}));
			await firstApplyStarted;
			let secondRequestSettled = false;
			void secondRequest.then(() => { secondRequestSettled = true; });
			const acknowledgedSecondRequests = new Set<string>();
			for (let attempt = 0; attempt < 8; attempt++) {
				await waitForCondition(
					() => !!second.reloadRequestId && !acknowledgedSecondRequests.has(second.reloadRequestId),
					'second cold-start panel should post a current projection candidate',
					1_000,
				);
				const requestId = second.reloadRequestId;
				acknowledgedSecondRequests.add(requestId);
				await Promise.resolve(second.receive({
					type: 'documentReloadResult', requestId,
					applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
				}));
				await new Promise<void>(resolve => setImmediate(resolve));
				if (secondRequestSettled && acknowledgedSecondRequests.has(second.reloadRequestId)) break;
			}
			await secondRequest;
			let secondCommandSettled = false;
			const secondCommand = Promise.resolve(second.receive({
				type: 'markdownDocumentCommand', commandId: 'cold-second-command',
				sourceGeneration: second.projection.sourceGeneration,
				expectedDocumentRevision: second.projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: second.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'from second panel' },
				},
			})).then(() => { secondCommandSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(secondCommandSettled, false, 'replacement owner must share the cold-start physical queue');
			releaseFirstApply();
			await Promise.all([firstCommand, secondCommand]);
			assert.ok(first.posted.some(message => message?.commandId === 'cold-first-command' && message.ok === false));
			assert.ok(second.posted.some(message => message?.commandId === 'cold-second-command' && message.ok === true));
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'from second panel');
			const secondResult = second.posted.find(message => message?.commandId === 'cold-second-command');
			await Promise.resolve(second.receive({
				type: 'markdownDocumentCommand', commandId: 'cold-second-restore-command',
				sourceGeneration: secondResult.sourceGeneration,
				expectedDocumentRevision: secondResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: secondResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'before' },
				},
			}));
			const restoredResult = second.posted.find(message => message?.commandId === 'cold-second-restore-command');
			assert.strictEqual(restoredResult.ok, true);
			assert.strictEqual(restoredResult.documentRevision, 2);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'before');

			const firstGenerationBeforeHandoff = first.projection.sourceGeneration;
			for (const dispose of second.disposeHandlers) dispose();
			await Promise.resolve(first.receive({
				type: 'markdownDocumentCommand', commandId: 'cold-aba-command',
				sourceGeneration: first.projection.sourceGeneration,
				expectedDocumentRevision: first.projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: first.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'ABA stale overwrite' },
				},
			}));
			assert.ok(first.posted.some(message => message?.commandId === 'cold-aba-command' && message.ok === false));
			await waitForCondition(
				() => first.projection.sourceGeneration !== firstGenerationBeforeHandoff,
				'canonical disposal should reproject the acknowledged survivor',
				1_000,
			);
			await Promise.resolve(first.receive({
				type: 'documentReloadResult', requestId: first.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			assert.strictEqual(first.projection.documentRevision, 2, 'handoff projection must retain canonical revision history');
			let handoffSaveParticipants = 0;
			const handoffSavePreparations: Promise<vscode.TextEdit[]>[] = [];
			for (const handler of willSaveHandlers) {
				handler({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
						handoffSaveParticipants++;
						handoffSavePreparations.push(Promise.resolve(thenable));
					},
				} as any);
			}
			assert.strictEqual(handoffSaveParticipants, 1, 'only the handed-off survivor may join Save');
			await Promise.all(handoffSavePreparations);
			for (const handler of didSaveHandlers) await Promise.resolve(handler(document));
			await Promise.resolve(first.receive({
				type: 'markdownDocumentCommand', commandId: 'cold-handoff-command',
				sourceGeneration: first.projection.sourceGeneration,
				expectedDocumentRevision: first.projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: first.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after canonical handoff' },
				},
			}));
			assert.ok(first.posted.some(message => message?.commandId === 'cold-handoff-command' && message.ok === true));
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after canonical handoff');
			for (const dispose of first.disposeHandlers) dispose();
		} finally {
			releaseFirstApply?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Development Notes, HTML, Transformation, Chart, Python, URL, and Markdown host commands survive stale adapter state, view recreation, and lossless save', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-owner-'));
		const filePath = path.join(tmpDir, 'owner.kqlx');
		const fixture = {
			kind: 'kqlx',
			version: 1,
			futureRoot: { producer: 'future-root' },
			state: {
				futureState: { producer: 'future-state' },
				sections: [
					{
						id: 'markdown_original', type: 'markdown', title: 'Original', text: 'before',
						mode: 'markdown', expanded: true,
						futureMarkdown: { producer: 'future-markdown' },
					},
					{
						id: 'url_original', type: 'url', name: 'Original URL', url: 'https://example.com/before.png',
						expanded: true, outputHeightPx: 240, imageSizeMode: 'natural', imageAlign: 'left',
						imageOverflow: 'shrink', futureUrl: { producer: 'future-url' },
					},
					{
						id: 'python_original', type: 'python', name: 'Original Python', code: 'print("before")',
						output: 'before output', expanded: true, editorHeightPx: 180,
						futurePython: { producer: 'future-python' },
					},
					{
						id: 'chart_original', type: 'chart', name: 'Original Chart', mode: 'edit', expanded: true,
						editorHeightPx: 260, dataSourceId: 'query_source', chartType: 'bar', xColumn: 'Category',
						yColumns: ['Before'], yColumn: 'Before', tooltipColumns: ['Category', 'Before'],
						legendColumn: 'Series', legendPosition: 'right', stackMode: 'normal', labelColumn: 'Category',
						valueColumn: 'Before', sourceColumn: 'Source', targetColumn: 'Target', orient: 'LR',
						sankeyLeftMargin: 48, showDataLabels: false, labelMode: 'auto', labelDensity: 80,
						sortColumn: 'Before', sortDirection: 'desc',
						xAxisSettings: {
							sortDirection: 'asc', scaleType: 'category', labelDensity: 70, showAxisLabel: true,
							customLabel: 'Before X', titleGap: 20, futureXAxis: { keep: true },
						},
						yAxisSettings: {
							showAxisLabel: true, customLabel: 'Before Y', min: '1', max: '100',
							seriesColors: { Before: '#111111' }, titleGap: 22, sortDirection: 'asc',
							futureYAxis: { keep: true },
						},
						legendSettings: {
							position: 'right', stackMode: 'normal', gap: 12, sortMode: 'alpha-asc', topN: 5,
							title: 'Before legend', showEndLabels: false, futureLegend: { keep: true },
						},
						heatmapSettings: {
							visualMapPosition: 'right', visualMapGap: 10, showCellLabels: false,
							cellLabelMode: 'all', cellLabelN: 3, futureHeatmap: { keep: true },
						},
						chartTitle: 'Before chart', chartSubtitle: 'Before subtitle', chartTitleAlign: 'left',
						validation: { status: 'before' }, futureChart: { producer: 'future-chart' },
					},
					{
						id: 'transformation_original', type: 'transformation', name: 'Original Transformation',
						mode: 'edit', expanded: true, editorHeightPx: 300,
						dataSourceId: 'query_left', transformationType: 'join', distinctColumn: 'Country',
						groupByColumns: ['Region'], aggregations: [{
							name: 'RevenueTotal', column: 'Revenue', function: 'sum',
							futureAggregation: { keep: true },
						}],
						deriveColumns: [{
							name: 'Margin', expression: 'Revenue - Cost', futureDerive: { keep: true },
						}],
						deriveColumnName: 'LegacyMargin', deriveExpression: 'Revenue - Cost',
						pivotRowKeyColumn: 'Region', pivotColumnKeyColumn: 'Quarter',
						pivotValueColumn: 'Revenue', pivotAggregation: 'sum', pivotMaxColumns: 12,
						joinRightDataSourceId: 'query_right', joinKind: 'inner',
						joinKeys: [{
							left: 'CustomerId', right: 'CustomerId', futureJoinKey: { keep: true },
						}],
						joinOmitDuplicateColumns: false,
						futureTransformation: {
							inputBindings: ['query_left@7', 'query_right@4'],
							derivedLineage: ['query_left@7', 'query_right@4'],
						},
					},
					{
						id: 'html_original', type: 'html', name: 'Original HTML',
						code: '<main>before</main>', mode: 'code', expanded: true,
						editorHeightPx: 320, previewHeightPx: 480, previewHeightUserSet: true,
						dataSourceIds: ['query_left'],
						pbiPublishInfo: {
							workspaceId: 'workspace-before', workspaceName: 'Before workspace',
							semanticModelId: 'model-before', reportId: 'report-before',
							reportName: 'Before report', reportUrl: 'https://app.powerbi.com/before',
							dataMode: 'directQuery', futurePublish: { keep: true },
						},
						powerBiUpgradeNotice: {
							dismissedForSection: false, dismissedForVersion: 1,
							dismissedForSignature: 'before-signature', dismissedAt: '2026-08-01T00:00:00.000Z',
							futureNotice: { keep: true },
						},
						futureHtml: { producer: 'future-html' },
					},
					{
						id: 'future_opaque', type: 'future-section',
						payload: { keep: ['opaque', 42] },
					},
					{
						id: 'devnotes_owner', type: 'devnotes', futureDevnotes: { keep: true }, entries: [{
							id: 'note_original', created: '2026-08-02T00:00:00.000Z',
							updated: '2026-08-02T00:00:00.000Z', category: 'usage-note',
							content: 'before', source: 'user', futureEntry: { belongsTo: 'note_original' },
						}],
					},
				],
			},
		};
		let currentText = JSON.stringify(fixture, null, 2) + '\n';
		let documentVersion = 1;
		let dirty = false;
		const willSaveHandlers: Array<(event: vscode.TextDocumentWillSaveEvent) => unknown> = [];
		const workspaceSubscriptions: DisposableLike[] = [];

		const document = {
			uri: vscode.Uri.file(filePath),
			getText: () => currentText,
			eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset),
			get isDirty() { return dirty; },
			get version() { return documentVersion; },
		} as vscode.TextDocument;

		const createPanel = () => {
			let receiveHandler: ((message: any) => unknown) | undefined;
			const posted: any[] = [];
			const disposeHandlers: Array<() => void> = [];
			let markdownSerializeCalls = 0;
			let finalSnapshotRequests = 0;
			let documentRevision = 0;
			let sourceGeneration = 0;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') {
							documentRevision = Number(message.documentRevision || 0);
							sourceGeneration = Number(message.sourceGeneration || 0);
						}
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
								markdownCommandBarrierSupported: true,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalSnapshotRequests++;
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'stale-document-adapter', sourceGeneration, editRevision: 1,
								state: { sections: [
									{ id: 'markdown_original', type: 'markdown', text: 'stale DOM snapshot' },
									{
										id: 'url_original', type: 'url', name: 'Stale URL DOM',
										url: 'https://stale.invalid/adapter.png', expanded: true,
									},
									{
										id: 'url_temporary', type: 'url', name: 'Stale removed URL',
										url: 'https://stale.invalid/removed.png', expanded: true,
									},
									{
										id: 'python_original', type: 'python', name: 'Stale Python DOM',
										code: 'raise RuntimeError("stale serializer")', output: 'stale output',
										expanded: true, editorHeightPx: 999,
									},
									{
										id: 'python_temporary', type: 'python', name: 'Stale removed Python',
										code: 'print("removed")', output: 'removed output', expanded: true,
									},
									{
										id: 'chart_original', type: 'chart', name: 'Stale Chart DOM', mode: 'edit',
										expanded: true, dataSourceId: 'stale_source', chartType: 'pie',
										labelColumn: 'Stale label', valueColumn: 'Stale value',
									},
									{
										id: 'chart_temporary', type: 'chart', name: 'Stale removed Chart',
										expanded: true, dataSourceId: 'stale_removed_source', chartType: 'line',
									},
									{
										id: 'transformation_original', type: 'transformation',
										name: 'Stale Transformation DOM', mode: 'edit', expanded: true,
										dataSourceId: 'stale_left', transformationType: 'join',
										joinRightDataSourceId: 'stale_right', joinKind: 'leftouter',
										joinKeys: [{ left: 'StaleLeft', right: 'StaleRight' }],
									},
									{
										id: 'html_original', type: 'html', name: 'Stale HTML DOM',
										code: '<main>stale serializer</main>', mode: 'code', expanded: true,
										editorHeightPx: 999, previewHeightPx: 998, previewHeightUserSet: true,
										dataSourceIds: ['stale_source'],
										pbiPublishInfo: {
											workspaceId: 'stale-workspace', semanticModelId: 'stale-model',
											reportId: 'stale-report', reportName: 'Stale report',
											reportUrl: 'https://stale.invalid/report',
										},
									},
									{ id: 'devnotes_owner', type: 'devnotes', entries: [{
										id: 'note_saved', created: '2026-08-02T00:00:00.000Z',
										updated: '2026-08-02T00:00:00.000Z', category: 'usage-note',
										content: 'adapter-owned note', source: 'user',
									}] },
								] },
							}));
						}
						if (message?.type === 'requestMarkdownCommandBarrier') {
							await Promise.resolve(receiveHandler?.({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration, documentRevision, accepted: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = wrapDocumentViewTestReceiver(
							handler,
							() => latestDocumentViewHostMessage(posted),
						);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as unknown as vscode.WebviewPanel;
			return {
				panel,
				posted,
				receive: async (message: unknown) => {
					assert.ok(receiveHandler, 'webview message handler must be installed');
					await Promise.resolve(receiveHandler(message));
				},
				dispose: async () => {
					for (const handler of disposeHandlers) handler();
					await new Promise<void>(resolve => setImmediate(resolve));
				},
				getMarkdownSerializeCalls: () => markdownSerializeCalls,
				getFinalSnapshotRequests: () => finalSnapshotRequests,
			};
		};

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).onDidChangeTextDocument = () => {
				const subscription = { dispose() {} };
				workspaceSubscriptions.push(subscription);
				return subscription;
			};
			(vscode.workspace as any).onWillSaveTextDocument = (
				handler: (event: vscode.TextDocumentWillSaveEvent) => unknown,
			) => {
				willSaveHandlers.push(handler);
				const subscription = { dispose() {} };
				workspaceSubscriptions.push(subscription);
				return subscription;
			};
			(vscode.workspace as any).onDidSaveTextDocument = () => {
				const subscription = { dispose() {} };
				workspaceSubscriptions.push(subscription);
				return subscription;
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				documentVersion++;
				dirty = true;
				return true;
			};

			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					extensionMode: vscode.ExtensionMode.Test,
				} as unknown as vscode.ExtensionContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub(),
			) as KqlxEditorProvider;

			const firstView = createPanel();
			await provider.resolveCustomTextEditor(document, firstView.panel, {} as vscode.CancellationToken);
			await firstView.receive({ type: 'requestDocument' });
			const initialProjection = firstView.posted.find(message => message?.type === 'documentData' && message.ok === true);
			assert.ok(initialProjection, 'initial host projection must be delivered');
			assert.strictEqual(initialProjection.documentRevision, 0);
			assert.deepStrictEqual(initialProjection.markdownSectionRevisions, { markdown_original: 0 });
			assert.deepStrictEqual(initialProjection.sectionRevisions, {
				markdown_original: 0, url_original: 0, python_original: 0, chart_original: 0,
				transformation_original: 0, html_original: 0, devnotes_owner: 0,
			});

			const sendCommand = async (message: any) => {
				message.sourceGeneration ??= initialProjection.sourceGeneration;
				await firstView.receive(message);
				const result = firstView.posted.find(candidate =>
					candidate?.type === 'markdownDocumentCommandResult'
					&& candidate.commandId === message.commandId,
				);
				assert.ok(result, `host must settle Markdown command ${message.commandId}`);
				return result;
			};
			const retiredOwner = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'retired-owner',
				sourceGeneration: initialProjection.sourceGeneration - 1,
				expectedDocumentRevision: initialProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_original', expectedSectionRevision: 0,
					patch: { text: 'retired overwrite' },
				},
			});
			assert.strictEqual(retiredOwner.ok, false);
			assert.strictEqual(retiredOwner.error?.code, 'stale-document-owner');

			const added = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'add-1', expectedDocumentRevision: 0,
				command: {
					type: 'add', afterSectionId: 'markdown_original',
					section: { id: 'markdown_temporary', type: 'markdown', title: 'Temporary', text: 'remove me' },
				},
			});
			assert.deepStrictEqual(
				{ ok: added.ok, documentRevision: added.documentRevision, sectionRevision: added.sectionRevision },
				{ ok: true, documentRevision: 1, sectionRevision: 1 },
				JSON.stringify(added),
			);

			const stale = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'stale-patch', expectedDocumentRevision: 0,
				command: {
					type: 'patch', sectionId: 'markdown_original', expectedSectionRevision: 0,
					patch: { text: 'stale overwrite' },
				},
			});
			assert.strictEqual(stale.ok, false);
			assert.strictEqual(stale.error?.code, 'stale-document-revision');
			assert.strictEqual(stale.documentRevision, 1);

			const patched = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'patch-1', expectedDocumentRevision: 1,
				command: {
					type: 'patch', sectionId: 'markdown_original', expectedSectionRevision: 0,
					patch: {
						title: 'Host owned', text: 'after', mode: 'preview', expanded: false, editorHeightPx: 320,
					},
				},
			});
			assert.deepStrictEqual(
				{ ok: patched.ok, documentRevision: patched.documentRevision, sectionRevision: patched.sectionRevision },
				{ ok: true, documentRevision: 2, sectionRevision: 1 },
			);

			const removed = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'remove-1', expectedDocumentRevision: 2,
				command: { type: 'remove', sectionId: 'markdown_temporary', expectedSectionRevision: 1 },
			});
			assert.deepStrictEqual(
				{ ok: removed.ok, documentRevision: removed.documentRevision },
				{ ok: true, documentRevision: 3 },
			);

			const urlAdded = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'url-add', expectedDocumentRevision: 3,
				command: {
					type: 'add', afterSectionId: 'url_original',
					section: {
						id: 'url_temporary', type: 'url', name: 'Temporary URL',
						url: 'https://example.com/remove-me.csv', expanded: false,
					},
				},
			});
			assert.deepStrictEqual(
				{ ok: urlAdded.ok, documentRevision: urlAdded.documentRevision, sectionRevision: urlAdded.sectionRevision },
				{ ok: true, documentRevision: 4, sectionRevision: 1 },
				JSON.stringify(urlAdded),
			);

			const staleUrl = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'url-stale-patch', expectedDocumentRevision: 3,
				command: {
					type: 'patch', sectionId: 'url_original', expectedSectionRevision: 0,
					patch: { url: 'https://stale.invalid/overwrite.png' },
				},
			});
			assert.strictEqual(staleUrl.ok, false);
			assert.strictEqual(staleUrl.error?.code, 'stale-document-revision');
			assert.strictEqual(staleUrl.documentRevision, 4);
			assert.strictEqual(
				JSON.parse(currentText).state.sections.find((section: any) => section.id === 'url_original').url,
				'https://example.com/before.png',
				'a stale URL command must not mutate the document',
			);

			const urlPatched = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'url-patch', expectedDocumentRevision: 4,
				command: {
					type: 'patch', sectionId: 'url_original', expectedSectionRevision: 0,
					patch: {
						name: 'Host owned URL', url: 'https://example.com/after.png', expanded: false,
						outputHeightPx: 420, imageSizeMode: 'fill', imageAlign: 'center', imageOverflow: 'scroll',
					},
				},
			});
			assert.deepStrictEqual(
				{ ok: urlPatched.ok, documentRevision: urlPatched.documentRevision, sectionRevision: urlPatched.sectionRevision },
				{ ok: true, documentRevision: 5, sectionRevision: 1 },
				JSON.stringify(urlPatched),
			);

			const urlRemoved = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'url-remove', expectedDocumentRevision: 5,
				command: { type: 'remove', sectionId: 'url_temporary', expectedSectionRevision: 1 },
			});
			assert.deepStrictEqual(
				{ ok: urlRemoved.ok, documentRevision: urlRemoved.documentRevision },
				{ ok: true, documentRevision: 6 },
			);

			const pythonAdded = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'python-add', expectedDocumentRevision: 6,
				command: {
					type: 'add', afterSectionId: 'python_original',
					section: {
						id: 'python_temporary', type: 'python', name: 'Temporary Python',
						code: 'print("remove me")', output: 'remove me', expanded: false,
					},
				},
			});
			assert.deepStrictEqual(
				{
					ok: pythonAdded.ok, documentRevision: pythonAdded.documentRevision,
					sectionRevision: pythonAdded.sectionRevision,
				},
				{ ok: true, documentRevision: 7, sectionRevision: 1 },
				JSON.stringify(pythonAdded),
			);

			const stalePython = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'python-stale-patch', expectedDocumentRevision: 6,
				command: {
					type: 'patch', sectionId: 'python_original', expectedSectionRevision: 0,
					patch: { code: 'raise RuntimeError("stale overwrite")', output: 'stale overwrite' },
				},
			});
			assert.strictEqual(stalePython.ok, false);
			assert.strictEqual(stalePython.error?.code, 'stale-document-revision');
			assert.strictEqual(stalePython.documentRevision, 7);
			assert.strictEqual(
				JSON.parse(currentText).state.sections.find((section: any) => section.id === 'python_original').code,
				'print("before")',
				'a stale Python command must not mutate the document',
			);

			const pythonPatched = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'python-patch', expectedDocumentRevision: 7,
				command: {
					type: 'patch', sectionId: 'python_original', expectedSectionRevision: 0,
					patch: {
						name: 'Host owned Python', code: 'print("after")', output: 'after output',
						expanded: false, editorHeightPx: 360,
					},
				},
			});
			assert.deepStrictEqual(
				{
					ok: pythonPatched.ok, documentRevision: pythonPatched.documentRevision,
					sectionRevision: pythonPatched.sectionRevision,
				},
				{ ok: true, documentRevision: 8, sectionRevision: 1 },
				JSON.stringify(pythonPatched),
			);

			const pythonRemoved = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'python-remove', expectedDocumentRevision: 8,
				command: { type: 'remove', sectionId: 'python_temporary', expectedSectionRevision: 1 },
			});
			assert.deepStrictEqual(
				{ ok: pythonRemoved.ok, documentRevision: pythonRemoved.documentRevision },
				{ ok: true, documentRevision: 9 },
			);

			const chartAdded = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'chart-add', expectedDocumentRevision: 9,
				command: {
					type: 'add', afterSectionId: 'chart_original',
					section: {
						id: 'chart_temporary', type: 'chart', name: 'Temporary Chart', mode: 'edit',
						expanded: false, dataSourceId: 'query_source', chartType: 'line', xColumn: 'Day',
						yColumns: ['Value'],
					},
				},
			});
			assert.deepStrictEqual(
				{
					ok: chartAdded.ok, documentRevision: chartAdded.documentRevision,
					sectionRevision: chartAdded.sectionRevision,
				},
				{ ok: true, documentRevision: 10, sectionRevision: 1 },
				JSON.stringify(chartAdded),
			);

			const staleChart = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'chart-stale-patch', expectedDocumentRevision: 9,
				command: {
					type: 'patch', sectionId: 'chart_original', expectedSectionRevision: 0,
					patch: { dataSourceId: 'stale_source', chartTitle: 'Stale chart overwrite' },
				},
			});
			assert.strictEqual(staleChart.ok, false);
			assert.strictEqual(staleChart.error?.code, 'stale-document-revision');
			assert.strictEqual(staleChart.documentRevision, 10);
			assert.strictEqual(
				JSON.parse(currentText).state.sections.find((section: any) => section.id === 'chart_original').chartTitle,
				'Before chart',
				'a stale Chart command must not mutate the document',
			);

			const chartPatched = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'chart-patch', expectedDocumentRevision: 10,
				command: {
					type: 'patch', sectionId: 'chart_original', expectedSectionRevision: 0,
					patch: {
						name: 'Host owned Chart', mode: 'preview', expanded: false, editorHeightPx: 440,
						dataSourceId: 'transformation_source', chartType: 'heatmap', xColumn: 'Day',
						yColumns: ['Revenue', 'Cost'], yColumn: 'Revenue', tooltipColumns: ['Day', 'Revenue', 'Cost'],
						legendColumn: 'Region', legendPosition: 'bottom', stackMode: 'stacked100', labelColumn: 'Day',
						valueColumn: 'Revenue', sourceColumn: 'From', targetColumn: 'To', orient: 'TB',
						sankeyLeftMargin: 72, showDataLabels: true, labelMode: 'top10', labelDensity: 55,
						sortColumn: 'Revenue', sortDirection: 'asc',
						xAxisSettings: {
							sortDirection: 'desc', scaleType: 'continuous', labelDensity: 60,
							showAxisLabel: false, customLabel: 'Host X', titleGap: 28,
						},
						yAxisSettings: {
							showAxisLabel: false, customLabel: 'Host Y', min: '0', max: '1000',
							seriesColors: { Revenue: '#00ff00', Cost: '#ff0000' }, titleGap: 32,
							sortDirection: 'desc',
						},
						legendSettings: {
							position: 'bottom', stackMode: 'stacked100', gap: 18, sortMode: 'value-desc',
							topN: 8, title: 'Host legend', showEndLabels: true,
						},
						heatmapSettings: {
							visualMapPosition: 'left', visualMapGap: 16, showCellLabels: true,
							cellLabelMode: 'highest', cellLabelN: 7,
						},
						chartTitle: 'Host chart', chartSubtitle: 'After subtitle', chartTitleAlign: 'center',
						validation: { status: 'after' },
					},
				},
			});
			assert.deepStrictEqual(
				{
					ok: chartPatched.ok, documentRevision: chartPatched.documentRevision,
					sectionRevision: chartPatched.sectionRevision,
				},
				{ ok: true, documentRevision: 11, sectionRevision: 1 },
				JSON.stringify(chartPatched),
			);

			const chartRemoved = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'chart-remove', expectedDocumentRevision: 11,
				command: { type: 'remove', sectionId: 'chart_temporary', expectedSectionRevision: 1 },
			});
			assert.deepStrictEqual(
				{ ok: chartRemoved.ok, documentRevision: chartRemoved.documentRevision },
				{ ok: true, documentRevision: 12 },
			);

			const staleTransformation = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'transformation-stale-patch',
				expectedDocumentRevision: 12,
				command: {
					type: 'patch', sectionId: 'transformation_original', expectedSectionRevision: 1,
					patch: {
						dataSourceId: 'stale_left', joinRightDataSourceId: 'stale_right',
						joinKind: 'leftouter',
					},
				},
			});
			assert.strictEqual(staleTransformation.ok, false);
			assert.strictEqual(staleTransformation.error?.code, 'stale-section-revision');
			assert.strictEqual(staleTransformation.documentRevision, 12);
			assert.strictEqual(
				JSON.parse(currentText).state.sections.find(
					(section: any) => section.id === 'transformation_original',
				).dataSourceId,
				'query_left',
				'a stale Transformation command must not change its primary input binding',
			);

			const transformationPatched = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'transformation-patch',
				expectedDocumentRevision: 12,
				command: {
					type: 'patch', sectionId: 'transformation_original', expectedSectionRevision: 0,
					patch: {
						name: 'Host owned Transformation', mode: 'preview', expanded: false,
						editorHeightPx: 460, joinKind: 'fullouter',
						joinKeys: [{ left: 'CustomerId', right: 'AccountId' }],
						joinOmitDuplicateColumns: true,
					},
				},
			});
			assert.deepStrictEqual(
				{
					ok: transformationPatched.ok, documentRevision: transformationPatched.documentRevision,
					sectionRevision: transformationPatched.sectionRevision,
				},
				{ ok: true, documentRevision: 13, sectionRevision: 1 },
				JSON.stringify(transformationPatched),
			);

			const staleHtml = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'html-stale-patch',
				expectedDocumentRevision: 13,
				command: {
					type: 'patch', sectionId: 'html_original', expectedSectionRevision: 1,
					patch: { code: '<main>stale overwrite</main>', dataSourceIds: ['stale_source'] },
				},
			});
			assert.strictEqual(staleHtml.ok, false);
			assert.strictEqual(staleHtml.error?.code, 'stale-section-revision');
			assert.strictEqual(staleHtml.documentRevision, 13);
			assert.strictEqual(
				JSON.parse(currentText).state.sections.find((section: any) => section.id === 'html_original').code,
				'<main>before</main>',
				'a stale HTML command must not mutate authored code',
			);

			const htmlPatched = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'html-patch',
				expectedDocumentRevision: 13,
				command: {
					type: 'patch', sectionId: 'html_original', expectedSectionRevision: 0,
					patch: {
						name: 'Host owned HTML', code: '<main>after</main>', mode: 'preview', expanded: false,
						editorHeightPx: 520, previewHeightPx: 640, previewHeightUserSet: true,
						dataSourceIds: ['query_right', 'transformation_original'],
						pbiPublishInfo: {
							workspaceId: 'workspace-after', workspaceName: 'After workspace',
							semanticModelId: 'model-after', reportId: 'report-after',
							reportName: 'After report', reportUrl: 'https://app.powerbi.com/after',
							dataMode: 'import',
						},
						powerBiUpgradeNotice: {
							dismissedForSection: true, dismissedForVersion: 1,
							dismissedForSignature: 'after-signature', dismissedAt: '2026-08-04T00:00:00.000Z',
						},
					},
				},
			});
			assert.deepStrictEqual(
				{
					ok: htmlPatched.ok, documentRevision: htmlPatched.documentRevision,
					sectionRevision: htmlPatched.sectionRevision,
				},
				{ ok: true, documentRevision: 14, sectionRevision: 1 },
				JSON.stringify(htmlPatched),
			);

			const authoritativeNote = {
				id: 'note_authoritative', created: '2026-08-02T00:05:00.000Z',
				updated: '2026-08-02T00:05:00.000Z', category: 'clarification',
				content: 'host-owned note', source: 'agent', relatedSectionIds: ['markdown_original'],
			};
			const devnotesPatched = await sendCommand({
				type: 'markdownDocumentCommand', commandId: 'devnotes-patch',
				expectedDocumentRevision: 14,
				command: {
					type: 'patch', sectionId: 'devnotes_owner', expectedSectionRevision: 0,
					patch: { entries: [authoritativeNote] },
				},
			});
			assert.deepStrictEqual(
				{
					ok: devnotesPatched.ok, documentRevision: devnotesPatched.documentRevision,
					sectionRevision: devnotesPatched.sectionRevision,
				},
				{ ok: true, documentRevision: 15, sectionRevision: 1 },
				JSON.stringify(devnotesPatched),
			);

			await firstView.dispose();

			const recreatedView = createPanel();
			await provider.resolveCustomTextEditor(document, recreatedView.panel, {} as vscode.CancellationToken);
			await recreatedView.receive({ type: 'requestDocument' });
			const recreatedProjection = recreatedView.posted.find(message => message?.type === 'documentData' && message.ok === true);
			assert.ok(recreatedProjection, 'recreated view must receive a projection');
			assert.strictEqual(recreatedProjection.documentRevision, 15);
			assert.deepStrictEqual(recreatedProjection.markdownSectionRevisions, { markdown_original: 1 });
			assert.deepStrictEqual(recreatedProjection.sectionRevisions, {
				markdown_original: 1, url_original: 1, python_original: 1, chart_original: 1,
				transformation_original: 1, html_original: 1, devnotes_owner: 1,
			});
			assert.strictEqual(recreatedProjection.state.sections[0].text, 'after');
			assert.strictEqual(recreatedProjection.state.sections[0].title, 'Host owned');
			assert.deepStrictEqual(recreatedProjection.state.sections[1], {
				id: 'url_original', type: 'url', name: 'Host owned URL', url: 'https://example.com/after.png',
				expanded: false, outputHeightPx: 420, imageSizeMode: 'fill', imageAlign: 'center',
				imageOverflow: 'scroll',
			});
			assert.deepStrictEqual(recreatedProjection.state.sections[2], {
				id: 'python_original', type: 'python', name: 'Host owned Python', code: 'print("after")',
				output: 'after output', expanded: false, editorHeightPx: 360,
			});
			assert.deepStrictEqual(recreatedProjection.state.sections[3], {
				id: 'chart_original', type: 'chart', name: 'Host owned Chart', mode: 'preview', expanded: false,
				editorHeightPx: 440, dataSourceId: 'transformation_source', chartType: 'heatmap', xColumn: 'Day',
				yColumns: ['Revenue', 'Cost'], yColumn: 'Revenue', tooltipColumns: ['Day', 'Revenue', 'Cost'],
				legendColumn: 'Region', legendPosition: 'bottom', stackMode: 'stacked100', labelColumn: 'Day',
				valueColumn: 'Revenue', sourceColumn: 'From', targetColumn: 'To', orient: 'TB',
				sankeyLeftMargin: 72, showDataLabels: true, labelMode: 'top10', labelDensity: 55,
				sortColumn: 'Revenue', sortDirection: 'asc',
				xAxisSettings: {
					sortDirection: 'desc', scaleType: 'continuous', labelDensity: 60,
					showAxisLabel: false, customLabel: 'Host X', titleGap: 28,
				},
				yAxisSettings: {
					showAxisLabel: false, customLabel: 'Host Y', min: '0', max: '1000',
					seriesColors: { Revenue: '#00ff00', Cost: '#ff0000' }, titleGap: 32,
					sortDirection: 'desc',
				},
				legendSettings: {
					position: 'bottom', stackMode: 'stacked100', gap: 18, sortMode: 'value-desc',
					topN: 8, title: 'Host legend', showEndLabels: true,
				},
				heatmapSettings: {
					visualMapPosition: 'left', visualMapGap: 16, showCellLabels: true,
					cellLabelMode: 'highest', cellLabelN: 7,
				},
				chartTitle: 'Host chart', chartSubtitle: 'After subtitle', chartTitleAlign: 'center',
				validation: { status: 'after' },
			});
			assert.deepStrictEqual(recreatedProjection.state.sections[4], {
				id: 'transformation_original', type: 'transformation', name: 'Host owned Transformation',
				mode: 'preview', expanded: false, editorHeightPx: 460,
				dataSourceId: 'query_left', transformationType: 'join', distinctColumn: 'Country',
				groupByColumns: ['Region'],
				aggregations: [{ name: 'RevenueTotal', column: 'Revenue', function: 'sum' }],
				deriveColumns: [{ name: 'Margin', expression: 'Revenue - Cost' }],
				deriveColumnName: 'LegacyMargin', deriveExpression: 'Revenue - Cost',
				pivotRowKeyColumn: 'Region', pivotColumnKeyColumn: 'Quarter',
				pivotValueColumn: 'Revenue', pivotAggregation: 'sum', pivotMaxColumns: 12,
				joinRightDataSourceId: 'query_right', joinKind: 'fullouter',
				joinKeys: [{ left: 'CustomerId', right: 'AccountId' }],
				joinOmitDuplicateColumns: true,
			});
			assert.deepStrictEqual(recreatedProjection.state.sections[5], {
				id: 'html_original', type: 'html', name: 'Host owned HTML',
				code: '<main>after</main>', mode: 'preview', expanded: false,
				editorHeightPx: 520, previewHeightPx: 640, previewHeightUserSet: true,
				dataSourceIds: ['query_right', 'transformation_original'],
				pbiPublishInfo: {
					workspaceId: 'workspace-after', workspaceName: 'After workspace',
					semanticModelId: 'model-after', reportId: 'report-after',
					reportName: 'After report', reportUrl: 'https://app.powerbi.com/after',
					dataMode: 'import',
				},
				powerBiUpgradeNotice: {
					dismissedForSection: true, dismissedForVersion: 1,
					dismissedForSignature: 'after-signature', dismissedAt: '2026-08-04T00:00:00.000Z',
				},
			});
			assert.deepStrictEqual(recreatedProjection.state.sections[7], {
				id: 'devnotes_owner', type: 'devnotes', entries: [authoritativeNote],
			});

			const owningSaveHandler = willSaveHandlers.at(-1);
			assert.ok(owningSaveHandler, 'native Save handler must be installed for the recreated view');
			let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
			owningSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
			} as vscode.TextDocumentWillSaveEvent);
			assert.ok(saveBarrier, 'native Save must provide an exact snapshot barrier');
			const saveEdits = await saveBarrier!;
			if (saveEdits.length > 0) currentText = saveEdits.at(-1)!.newText;
			fs.writeFileSync(filePath, currentText, 'utf8');

			assert.strictEqual(recreatedView.getMarkdownSerializeCalls(), 0);
			assert.strictEqual(recreatedView.getFinalSnapshotRequests(), 1);
			const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			assert.deepStrictEqual(saved.futureRoot, fixture.futureRoot);
			assert.deepStrictEqual(saved.state.futureState, fixture.state.futureState);
			assert.deepStrictEqual(saved.state.sections.map((section: any) => section.id), [
				'markdown_original', 'url_original', 'python_original', 'chart_original', 'transformation_original',
				'html_original', 'future_opaque', 'devnotes_owner',
			]);
			assert.deepStrictEqual(saved.state.sections[0], {
				id: 'markdown_original', type: 'markdown', title: 'Host owned', text: 'after',
				mode: 'preview', expanded: false, editorHeightPx: 320,
				futureMarkdown: { producer: 'future-markdown' },
			});
			assert.deepStrictEqual(saved.state.sections[1], {
				id: 'url_original', type: 'url', name: 'Host owned URL', url: 'https://example.com/after.png',
				expanded: false, outputHeightPx: 420, imageSizeMode: 'fill', imageAlign: 'center',
				imageOverflow: 'scroll', futureUrl: { producer: 'future-url' },
			});
			assert.deepStrictEqual(saved.state.sections[2], {
				id: 'python_original', type: 'python', name: 'Host owned Python', code: 'print("after")',
				output: 'after output', expanded: false, editorHeightPx: 360,
				futurePython: { producer: 'future-python' },
			});
			assert.deepStrictEqual(saved.state.sections[3], {
				id: 'chart_original', type: 'chart', name: 'Host owned Chart', mode: 'preview', expanded: false,
				editorHeightPx: 440, dataSourceId: 'transformation_source', chartType: 'heatmap', xColumn: 'Day',
				yColumns: ['Revenue', 'Cost'], yColumn: 'Revenue', tooltipColumns: ['Day', 'Revenue', 'Cost'],
				legendColumn: 'Region', legendPosition: 'bottom', stackMode: 'stacked100', labelColumn: 'Day',
				valueColumn: 'Revenue', sourceColumn: 'From', targetColumn: 'To', orient: 'TB',
				sankeyLeftMargin: 72, showDataLabels: true, labelMode: 'top10', labelDensity: 55,
				sortColumn: 'Revenue', sortDirection: 'asc',
				xAxisSettings: {
					sortDirection: 'desc', scaleType: 'continuous', labelDensity: 60,
					showAxisLabel: false, customLabel: 'Host X', titleGap: 28,
					futureXAxis: { keep: true },
				},
				yAxisSettings: {
					showAxisLabel: false, customLabel: 'Host Y', min: '0', max: '1000',
					seriesColors: { Revenue: '#00ff00', Cost: '#ff0000' }, titleGap: 32,
					sortDirection: 'desc', futureYAxis: { keep: true },
				},
				legendSettings: {
					position: 'bottom', stackMode: 'stacked100', gap: 18, sortMode: 'value-desc',
					topN: 8, title: 'Host legend', showEndLabels: true, futureLegend: { keep: true },
				},
				heatmapSettings: {
					visualMapPosition: 'left', visualMapGap: 16, showCellLabels: true,
					cellLabelMode: 'highest', cellLabelN: 7, futureHeatmap: { keep: true },
				},
				chartTitle: 'Host chart', chartSubtitle: 'After subtitle', chartTitleAlign: 'center',
				validation: { status: 'after' }, futureChart: { producer: 'future-chart' },
			});
			assert.deepStrictEqual(saved.state.sections[4], {
				id: 'transformation_original', type: 'transformation', name: 'Host owned Transformation',
				mode: 'preview', expanded: false, editorHeightPx: 460,
				dataSourceId: 'query_left', transformationType: 'join', distinctColumn: 'Country',
				groupByColumns: ['Region'], aggregations: [{
					name: 'RevenueTotal', column: 'Revenue', function: 'sum',
					futureAggregation: { keep: true },
				}],
				deriveColumns: [{
					name: 'Margin', expression: 'Revenue - Cost', futureDerive: { keep: true },
				}],
				deriveColumnName: 'LegacyMargin', deriveExpression: 'Revenue - Cost',
				pivotRowKeyColumn: 'Region', pivotColumnKeyColumn: 'Quarter',
				pivotValueColumn: 'Revenue', pivotAggregation: 'sum', pivotMaxColumns: 12,
				joinRightDataSourceId: 'query_right', joinKind: 'fullouter',
				joinKeys: [{
					left: 'CustomerId', right: 'AccountId', futureJoinKey: { keep: true },
				}],
				joinOmitDuplicateColumns: true,
				futureTransformation: {
					inputBindings: ['query_left@7', 'query_right@4'],
					derivedLineage: ['query_left@7', 'query_right@4'],
				},
			});
			assert.deepStrictEqual(saved.state.sections[5], {
				id: 'html_original', type: 'html', name: 'Host owned HTML',
				code: '<main>after</main>', mode: 'preview', expanded: false,
				editorHeightPx: 520, previewHeightPx: 640, previewHeightUserSet: true,
				dataSourceIds: ['query_right', 'transformation_original'],
				pbiPublishInfo: {
					workspaceId: 'workspace-after', workspaceName: 'After workspace',
					semanticModelId: 'model-after', reportId: 'report-after',
					reportName: 'After report', reportUrl: 'https://app.powerbi.com/after',
					dataMode: 'import', futurePublish: { keep: true },
				},
				powerBiUpgradeNotice: {
					dismissedForSection: true, dismissedForVersion: 1,
					dismissedForSignature: 'after-signature', dismissedAt: '2026-08-04T00:00:00.000Z',
					futureNotice: { keep: true },
				},
				futureHtml: { producer: 'future-html' },
			});
			assert.deepStrictEqual(saved.state.sections[6], fixture.state.sections[6]);
			assert.deepStrictEqual(saved.state.sections[7], {
				id: 'devnotes_owner', type: 'devnotes', futureDevnotes: { keep: true },
				entries: [authoritativeNote],
			});
			assert.strictEqual((saved.state.sections[7].entries[0] as Record<string, unknown>).futureEntry, undefined);
			await recreatedView.dispose();
		} finally {
			for (const subscription of workspaceSubscriptions) subscription.dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('session Chart removal uses the durable baseline when the open TextDocument is stale', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-stale-buffer-remove-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const querySection = { id: 'query_session', type: 'query', query: 'print Value=1' };
		const staleBufferText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [querySection] },
		}, null, 2) + '\n';
		const durableText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				querySection,
				{
					id: 'chart_session', type: 'chart', dataSourceId: 'query_session',
					chartType: 'bar', xColumn: 'Value', yColumns: ['Value'], expanded: true,
				},
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];

		try {
			fs.writeFileSync(filePath, durableText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => staleBufferText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false, version: 1,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
								markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
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
			assert.deepStrictEqual(
				latestProjection.state.sections.map((section: any) => section.id),
				['query_session', 'chart_session'],
			);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'remove-stale-buffer-chart',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'remove', sectionId: 'chart_session',
					expectedSectionRevision: latestProjection.sectionRevisions.chart_session,
				},
			}));
			const result = posted.find(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'remove-stale-buffer-chart');
			assert.strictEqual(result?.ok, true, JSON.stringify(result));
			assert.deepStrictEqual(
				JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections.map((section: any) => section.id),
				['query_session'],
			);
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('session projection reads fail closed instead of using a stale TextDocument', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-read-failure-'));
		const missingPath = path.join(tmpDir, 'session.kqlx');
		const staleText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'chart_stale', type: 'chart', chartType: 'bar' },
			] },
		});
		try {
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(missingPath), getText: () => staleText,
			} as vscode.TextDocument;

			await assert.rejects(
				(provider as any).readProjectionSourceTextForDocument(document, true),
				/ENOENT|no such file|changed physical identity before projection|changed physical identity before reading/i,
			);
			assert.strictEqual(
				await (provider as any).readProjectionSourceTextForDocument(document, false),
				staleText,
			);

			const durablePath = path.join(tmpDir, 'durable-session.kqlx');
			const durableUri = vscode.Uri.file(durablePath);
			fs.writeFileSync(durablePath, staleText, 'utf8');
			let releaseWrite!: () => void;
			let markLocked!: () => void;
			const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
			const locked = new Promise<void>(resolve => { markLocked = resolve; });
			const writer = withKqlxDocumentWriteLock(durableUri, async () => {
				markLocked();
				await writeGate;
			});
			await locked;
			let readSettled = false;
			const lockedRead = (provider as any).readProjectionSourceTextForDocument({
				uri: durableUri, getText: () => 'stale buffer',
			} as vscode.TextDocument, true).finally(() => { readSettled = true; });
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.strictEqual(readSettled, false, 'session projection read must wait for the document write lock');
			releaseWrite();
			await writer;
			assert.strictEqual(await lockedRead, staleText);
		} finally {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('session close drains a stamped Markdown command delivered after panel disposal', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-session-close-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'markdown_session', type: 'markdown', text: 'before', futureMarkdown: { keep: true } },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		let sourceGeneration = 0;
		let latestProjection: any;

		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			const context = {
				subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
			} as unknown as vscode.ExtensionContext;
			const provider = new (KqlxEditorProvider as any)(
				context, vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => initialText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false, version: 1,
			} as unknown as vscode.TextDocument;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') {
							sourceGeneration = Number(message.sourceGeneration || 0);
							latestProjection = message;
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
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as unknown as vscode.WebviewPanel;

			await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
			assert.ok(receiveHandler);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'session-first-command', sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_session',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_session,
					patch: { text: 'after first' },
				},
			}));
			assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[0].text, 'after first');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.strictEqual(latestProjection.state.sections[0].text, 'after first');
			const closeCommand = {
				type: 'markdownDocumentCommand', commandId: 'session-close-command', sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_session',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_session,
					patch: { text: 'after close' },
				},
			};
			for (const dispose of disposeHandlers) dispose();
			const command = Promise.resolve(receiveHandler!(closeCommand));
			await command;
			await new Promise<void>(resolve => setTimeout(resolve, 650));

			const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			assert.strictEqual(saved.state.sections[0].text, 'after close');
			assert.deepStrictEqual(saved.state.sections[0].futureMarkdown, { keep: true });
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('session close drains two admitted messages when the first exceeds the grace window', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-session-close-chain-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_session', type: 'query', query: 'print adapter = "before"' },
				{ id: 'markdown_session', type: 'markdown', text: 'before' },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		let latestProjection: any;
		let gateCommand = false;
		let markCommandStarted!: () => void;
		let releaseCommand!: () => void;
		const commandStarted = new Promise<void>(resolve => { markCommandStarted = resolve; });
		const commandGate = new Promise<void>(resolve => { releaseCommand = resolve; });

		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any,
				publish: (value: any) => Promise<unknown>,
			) => {
				if (gateCommand && JSON.stringify(state).includes('markdown after grace')) {
					gateCommand = false;
					markCommandStarted();
					await commandGate;
				}
				return publish(state);
			};
			const context = {
				subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
			} as unknown as vscode.ExtensionContext;
			const provider = new (KqlxEditorProvider as any)(
				context, vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => initialText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false, version: 1,
			} as unknown as vscode.TextDocument;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.push(handler);
					return { dispose() {} };
				},
			} as unknown as vscode.WebviewPanel;

			await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			gateCommand = true;
			for (const dispose of disposeHandlers) dispose();
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'session-chain-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_session',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_session,
					patch: { text: 'markdown after grace' },
				},
			}));
			await commandStarted;
			const finalSnapshot = Promise.resolve(receiveHandler!({
				type: 'persistDocument', reason: 'beforeunload', snapshotId: 'session-close-chain', editRevision: 1,
				sourceGeneration: latestProjection.sourceGeneration,
				state: { sections: [
					{ id: 'query_session', type: 'query', query: 'print adapter = "after"' },
					{ id: 'markdown_session', type: 'markdown', text: 'stale adapter markdown' },
				] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 650));
			releaseCommand();
			await Promise.all([command, finalSnapshot]);
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);

			const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			assert.strictEqual(saved.state.sections[0].query, 'print adapter = "after"');
			assert.strictEqual(saved.state.sections[1].text, 'markdown after grace');
		} finally {
			releaseCommand?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('session URL burst commands reserve queue order before source reads', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalReadProjectionSourceText = (KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-url-session-burst-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'url_1', type: 'url', url: 'https://example.com/one.png', expanded: true },
				{ id: 'url_2', type: 'url', url: 'https://example.com/two.png', expanded: true },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		const posted: any[] = [];
		let gateCommandReads = false;
		let commandReadStarts = 0;
		let markFirstReadStarted!: () => void;
		let releaseFirstRead!: () => void;
		const firstReadStarted = new Promise<void>(resolve => { markFirstReadStarted = resolve; });
		const firstReadGate = new Promise<void>(resolve => { releaseFirstRead = resolve; });

		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument = async function (
				document: vscode.TextDocument,
				isSessionFile: boolean,
			) {
				if (gateCommandReads && document.uri.toString() === vscode.Uri.file(filePath).toString()) {
					commandReadStarts++;
					if (commandReadStarts === 1) {
						markFirstReadStarted();
						await firstReadGate;
					}
				}
				return originalReadProjectionSourceText.call(this, document, isSessionFile);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => initialText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false, version: 1,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			gateCommandReads = true;
			const first = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'url-burst-first',
				sourceGeneration: latestProjection.sourceGeneration, expectedDocumentRevision: 0,
				command: { type: 'patch', sectionId: 'url_1', expectedSectionRevision: 0, patch: { expanded: false } },
			}));
			await firstReadStarted;
			const second = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'url-burst-second',
				sourceGeneration: latestProjection.sourceGeneration, expectedDocumentRevision: 1,
				command: { type: 'patch', sectionId: 'url_2', expectedSectionRevision: 0, patch: { expanded: false } },
			}));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(commandReadStarts, 1, 'the second command must not read before the first queue slot settles');
			releaseFirstRead();
			await Promise.all([first, second]);

			assert.strictEqual(posted.find(message => message?.commandId === 'url-burst-first')?.ok, true);
			assert.strictEqual(posted.find(message => message?.commandId === 'url-burst-second')?.ok, true);
			const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			assert.deepStrictEqual(saved.state.sections.map((section: any) => section.expanded), [false, false]);
		} finally {
			releaseFirstRead?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument = originalReadProjectionSourceText;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('newer low-generation panel authority wins a delayed high-generation Transformation command', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-uri-authority-order-'));
		const filePath = path.join(tmpDir, 'authority.kqlx');
		const notebook = (query: string, order: 'source-first' | 'transform-first') => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: order === 'source-first' ? [
				{ id: 'query_1', type: 'query', query },
				{
					id: 'transform_1', type: 'transformation', name: 'Initial',
					dataSourceId: 'query_1', transformationType: 'select',
				},
			] : [
				{
					id: 'transform_1', type: 'transformation', name: 'Initial',
					dataSourceId: 'query_1', transformationType: 'select',
				},
				{ id: 'query_1', type: 'query', query },
			] },
		}, null, 2) + '\n';
		let currentText = notebook('print initial = 1', 'source-first');
		let markCommandApplyStarted!: () => void;
		let releaseCommandApply!: () => void;
		const commandApplyStarted = new Promise<void>(resolve => { markCommandApplyStarted = resolve; });
		const commandApplyGate = new Promise<void>(resolve => { releaseCommandApply = resolve; });
		let delayCommandApply = false;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (delayCommandApply && replacement.includes('"name": "Stale command"')) {
					delayCommandApply = false;
					markCommandApplyStarted();
					await commandApplyGate;
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
			const createPanel = () => {
				let receive: ((message: any) => unknown) | undefined;
				let projection: any;
				let holdReload = false;
				let pendingReload: any;
				const posted: any[] = [];
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type === 'documentData') projection = message;
							if (message?.reloadRequestId) {
								if (holdReload) pendingReload = message;
								else await Promise.resolve(receive?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receive = wrapDocumentViewTestReceiver(handler, () => projection);
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				return {
					panel, posted,
					receive: (message: any) => receive!(message),
					get projection() { return projection; },
					get pendingReload() { return pendingReload; },
					holdNextReload() { holdReload = true; pendingReload = undefined; },
				};
			};
			const high = createPanel();
			const low = createPanel();
			await provider.resolveCustomTextEditor(document, high.panel, {} as any);
			await provider.resolveCustomTextEditor(document, low.panel, {} as any);
			await Promise.resolve(high.receive({ type: 'requestDocument' }));
			await Promise.resolve(low.receive({ type: 'requestDocument' }));
			for (let index = 0; index < 3; index++) {
				await Promise.resolve(high.receive({ type: 'requestDocument' }));
			}
			const owner = [...(provider as any).markdownDocuments.values()][0];
			const registrations = [...(provider as any).markdownPanelOwners.values()][0];
			const commandPanel = registrations?.get(high.panel)?.owner === owner ? high : low;
			const authorityPanel = commandPanel === high ? low : high;
			for (let index = 0; index < 3; index++) {
				await Promise.resolve(commandPanel.receive({ type: 'requestDocument' }));
			}
			assert.ok(commandPanel.projection.sourceGeneration > authorityPanel.projection.sourceGeneration);

			delayCommandApply = true;
			let commandId = '';
			let command!: Promise<unknown>;
			let sourceGeneration = commandPanel.projection.sourceGeneration;
			let expectedDocumentRevision = commandPanel.projection.documentRevision;
			let expectedSectionRevision = commandPanel.projection.sectionRevisions.transform_1;
			for (let attempt = 0; attempt < 3; attempt++) {
				commandId = `high-generation-stale-command-${attempt}`;
				command = Promise.resolve(commandPanel.receive({
					type: 'markdownDocumentCommand', commandId,
					sourceGeneration,
					expectedDocumentRevision,
					command: {
						type: 'patch', sectionId: 'transform_1', expectedSectionRevision,
						patch: { name: 'Stale command' },
					},
				}));
				const phase = await Promise.race([
					commandApplyStarted.then(() => 'started' as const),
					command.then(() => 'settled' as const),
				]);
				if (phase === 'started') break;
				const result = commandPanel.posted.find(message => message?.commandId === commandId);
				assert.strictEqual(result?.ok, false);
				sourceGeneration = result.sourceGeneration;
				expectedDocumentRevision = result.documentRevision;
				expectedSectionRevision = result.projection.sectionRevisions.transform_1;
			}
			await commandApplyStarted;

			const directText = notebook('print direct = 2', 'transform-first');
			currentText = directText;
			authorityPanel.holdNextReload();
			const lowReload = Promise.resolve(authorityPanel.receive({ type: 'requestDocument' }));
			await waitForCondition(() => !!authorityPanel.pendingReload, 'low-generation panel should capture direct authority');
			assert.ok(commandPanel.projection.sourceGeneration > authorityPanel.pendingReload.sourceGeneration);
			releaseCommandApply();
			await command;

			assert.strictEqual(currentText, directText);
			assert.strictEqual(
				commandPanel.posted.find(message => message?.commandId === commandId)?.ok,
				false,
			);
			await Promise.resolve(authorityPanel.receive({
				type: 'documentReloadResult', requestId: authorityPanel.pendingReload.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await lowReload;
		} finally {
			releaseCommandApply?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('a delayed stale panel source observation cannot replace newer URI authority', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalReadProjectionSourceText = (KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-source-observation-order-'));
		const filePath = path.join(tmpDir, 'observation.kqlx');
		const notebook = (query: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query },
				{
					id: 'transform_1', type: 'transformation', dataSourceId: 'query_1',
					transformationType: 'select',
				},
			] },
		});
		const sourceA = notebook('print A = 1');
		const sourceB = notebook('print B = 2');
		let currentText = sourceA;
		let delayNextRead = false;
		let markDelayedRead!: () => void;
		let releaseDelayedRead!: () => void;
		const delayedRead = new Promise<void>(resolve => { markDelayedRead = resolve; });
		const delayedReadGate = new Promise<void>(resolve => { releaseDelayedRead = resolve; });

		try {
			fs.writeFileSync(filePath, sourceA, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument = async function () {
				const observed = currentText;
				if (delayNextRead) {
					delayNextRead = false;
					markDelayedRead();
					await delayedReadGate;
				}
				return observed;
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
			const createPanel = () => {
				let receive: ((message: any) => unknown) | undefined;
				let projection: any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							if (message?.type === 'documentData') projection = message;
							if (message?.reloadRequestId) await Promise.resolve(receive?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receive = wrapDocumentViewTestReceiver(handler, () => projection);
							return { dispose() {} };
						},
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				return {
					panel,
					receive: (message: any) => receive!(message),
					get projection() { return projection; },
				};
			};
			const stalePanel = createPanel();
			const freshPanel = createPanel();
			await provider.resolveCustomTextEditor(document, stalePanel.panel, {} as any);
			await provider.resolveCustomTextEditor(document, freshPanel.panel, {} as any);
			await Promise.resolve(stalePanel.receive({ type: 'requestDocument' }));
			await Promise.resolve(freshPanel.receive({ type: 'requestDocument' }));

			delayNextRead = true;
			const staleRequest = Promise.resolve(stalePanel.receive({ type: 'requestDocument' }));
			await delayedRead;
			currentText = sourceB;
			await Promise.resolve(freshPanel.receive({ type: 'requestDocument' }));
			releaseDelayedRead();
			await staleRequest;

			const queue = [...(provider as any).markdownDocumentQueues.values()][0];
			assert.strictEqual(queue.latestAuthority.sourceText, sourceB);
			await Promise.resolve(stalePanel.receive({ type: 'requestDocument' }));
			assert.strictEqual(
				freshPanel.projection.state.sections.find((section: any) => section.id === 'query_1').query,
				'print B = 2',
			);

			currentText = sourceA;
			await Promise.all([
				Promise.resolve(stalePanel.receive({ type: 'requestDocument' })),
				Promise.resolve(freshPanel.receive({ type: 'requestDocument' })),
			]);
			assert.strictEqual(
				stalePanel.projection.state.sections.find((section: any) => section.id === 'query_1').query,
				'print A = 1',
			);
			assert.strictEqual(
				freshPanel.projection.state.sections.find((section: any) => section.id === 'query_1').query,
				'print A = 1',
			);

			currentText = sourceB;
			await Promise.all([
				Promise.resolve(stalePanel.receive({ type: 'requestDocument' })),
				Promise.resolve(freshPanel.receive({ type: 'requestDocument' })),
			]);
			assert.strictEqual(
				stalePanel.projection.state.sections.find((section: any) => section.id === 'query_1').query,
				'print B = 2',
			);
			assert.strictEqual(
				freshPanel.projection.state.sections.find((section: any) => section.id === 'query_1').query,
				'print B = 2',
			);
		} finally {
			releaseDelayedRead?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(KqlxEditorProvider as any).prototype.readProjectionSourceTextForDocument = originalReadProjectionSourceText;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('direct A fences a delayed command after admitted persistence advances A to B', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-authority-a-b-a-'));
		const filePath = path.join(tmpDir, 'aba.kqlx');
		const notebook = (query: string, name: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query },
				{
					id: 'transform_1', type: 'transformation', name,
					dataSourceId: 'query_1', transformationType: 'select',
				},
			] },
		}, null, 2) + '\n';
		const sourceA = notebook('print A = 1', 'Initial');
		let currentText = sourceA;
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		let holdReload = false;
		let pendingReload: any;
		let delayCommand = false;
		let markCommandStarted!: () => void;
		let releaseCommand!: () => void;
		const commandStarted = new Promise<void>(resolve => { markCommandStarted = resolve; });
		const commandGate = new Promise<void>(resolve => { releaseCommand = resolve; });
		const posted: any[] = [];

		try {
			fs.writeFileSync(filePath, sourceA, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (delayCommand && replacement.includes('"name": "Stale command"')) {
					delayCommand = false;
					markCommandStarted();
					await commandGate;
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
					options: {}, postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							if (holdReload) pendingReload = message;
							else await Promise.resolve(receive?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receive!({ type: 'requestDocument' }));
			await Promise.resolve(receive!({
				type: 'persistDocument', snapshotId: 'advance-to-b', editRevision: 1,
				sourceGeneration: projection.sourceGeneration,
				state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print B = 2' },
					{
						id: 'transform_1', type: 'transformation', name: 'Initial',
						dataSourceId: 'query_1', transformationType: 'select',
					},
				] },
			}));
			assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'advance-to-b'));
			assert.ok(currentText.includes('print B = 2'));

			delayCommand = true;
			const command = Promise.resolve(receive!({
				type: 'markdownDocumentCommand', commandId: 'aba-stale-command',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'transform_1',
					expectedSectionRevision: projection.sectionRevisions.transform_1,
					patch: { name: 'Stale command' },
				},
			}));
			await commandStarted;
			currentText = sourceA;
			holdReload = true;
			const reload = Promise.resolve(receive!({ type: 'requestDocument' }));
			await waitForCondition(() => !!pendingReload, 'direct A should start a new projection');
			releaseCommand();
			await command;

			assert.strictEqual(currentText, sourceA);
			assert.strictEqual(posted.find(message => message?.commandId === 'aba-stale-command')?.ok, false);
			await Promise.resolve(receive!({
				type: 'documentReloadResult', requestId: pendingReload.reloadRequestId,
				applied: true, editRevision: 1, markdownCommandBarrierSupported: true,
			}));
			await reload;
		} finally {
			releaseCommand?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('held same-token projection cannot roll aggregate revision back after Transformation ABA', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-projection-aba-epoch-'));
		const filePath = path.join(tmpDir, 'projection-aba.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'transform_1', type: 'transformation', name: 'A',
				dataSourceId: 'query_1', transformationType: 'select',
			}] },
		}, null, 2) + '\n';
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		let holdNextReload = false;
		let heldReload: any;
		const posted: any[] = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
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
							} else {
								await Promise.resolve(receive?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
								}));
							}
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receive!({ type: 'requestDocument' }));
			const initialProjection = projection;
			holdNextReload = true;
			const heldRequest = Promise.resolve(receive!({ type: 'requestDocument' }));
			await waitForCondition(() => !!heldReload, 'same-token projection should wait for acknowledgement');

			const sendPatch = async (
				commandId: string,
				name: string,
				expectedDocumentRevision: number,
				expectedSectionRevision: number,
				sourceGeneration = initialProjection.sourceGeneration,
			) => {
				await Promise.resolve(receive!({
					type: 'markdownDocumentCommand', commandId,
					sourceGeneration,
					expectedDocumentRevision,
					command: {
						type: 'patch', sectionId: 'transform_1', expectedSectionRevision,
						patch: { name },
					},
				}));
				const result = posted.find(message => message?.commandId === commandId);
				assert.strictEqual(result?.ok, true, `${commandId}: ${JSON.stringify(result)}`);
				return result;
			};
			const toB = await sendPatch('aba-to-b', 'B', 0, 0);
			const toA = await sendPatch('aba-to-a', 'A', toB.documentRevision, toB.sectionRevision);
			assert.strictEqual(toA.documentRevision, 2);

			await Promise.resolve(receive!({
				type: 'documentReloadResult', requestId: heldReload.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await heldRequest;
			await waitForCondition(
				() => projection?.documentRevision === 2 && projection?.reloadRequestId !== heldReload.reloadRequestId,
				'stale ABA activation should retry at the current aggregate revision',
			);

			const afterRetry = await sendPatch(
				'aba-after-retry', 'C', projection.documentRevision, projection.sectionRevisions.transform_1,
				projection.sourceGeneration,
			);
			assert.strictEqual(afterRetry.documentRevision, 3);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].name, 'C');
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('reload retires stale adapter sanitation before a new Markdown command', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-reload-preemption-'));
		const filePath = path.join(tmpDir, 'reload.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print baseline = 0' },
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		let rejectNextReload = false;
		let markSurvivingAdapterStarted!: () => void;
		let releaseSurvivingAdapter!: () => void;
		let markAdapterStarted!: () => void;
		let releaseAdapter!: () => void;
		const survivingAdapterStarted = new Promise<void>(resolve => { markSurvivingAdapterStarted = resolve; });
		const survivingAdapterGate = new Promise<void>(resolve => { releaseSurvivingAdapter = resolve; });
		const adapterStarted = new Promise<void>(resolve => { markAdapterStarted = resolve; });
		const adapterGate = new Promise<void>(resolve => { releaseAdapter = resolve; });

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
				const query = state.sections?.find((section: any) => section?.id === 'query_1')?.query;
				if (query === 'print survives rejection = 1') {
					markSurvivingAdapterStarted();
					await survivingAdapterGate;
				}
				if (query === 'print stale = 1') {
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
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							const applied = !rejectNextReload;
							rejectNextReload = false;
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied, editRevision: 0,
								markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const activeSourceGeneration = latestProjection.sourceGeneration;
			let survivingPersistSettled = false;
			const survivingPersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'survives-rejected-reload', editRevision: 1,
				sourceGeneration: activeSourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print survives rejection = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'adapter markdown' },
				] },
			})).finally(() => { survivingPersistSettled = true; });
			await survivingAdapterStarted;
			rejectNextReload = true;
			let rejectedReloadSettled = false;
			const rejectedReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }))
				.finally(() => { rejectedReloadSettled = true; });
			await waitForCondition(() => !rejectNextReload, 'projection rejection should be delivered', 1_000);
			releaseSurvivingAdapter();
			await waitForCondition(
				() => survivingPersistSettled && rejectedReloadSettled,
				'rejected same-source reload and surviving persistence should both settle',
				1_000,
			);
			await Promise.all([survivingPersist, rejectedReload]);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'print survives rejection = 1');
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'stale-before-accepted-reload', editRevision: 2,
				sourceGeneration: activeSourceGeneration, state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print stale = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'stale adapter markdown' },
				] },
			}));
			await adapterStarted;
			let acceptedReloadSettled = false;
			const acceptedReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }))
				.finally(() => { acceptedReloadSettled = true; });
			await waitForCondition(
				() => acceptedReloadSettled,
				'accepted reload should settle before the post-reload command',
				1_000,
			);
			await acceptedReload;
			let commandSettled = false;
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-reload-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after reload' },
				},
			})).then(() => { commandSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(commandSettled, false, 'Markdown command must wait for stale adapter physical settlement');
			releaseAdapter();
			let stalePersistSettled = false;
			let commandPromiseSettled = false;
			void stalePersist.finally(() => { stalePersistSettled = true; });
			void command.finally(() => { commandPromiseSettled = true; });
			await waitForCondition(
				() => stalePersistSettled && commandPromiseSettled,
				'stale persistence and queued command should settle after reload',
				1_000,
			);
			await Promise.all([stalePersist, command]);
			assert.strictEqual(commandSettled, true);
			const finalFile = JSON.parse(currentText);
			assert.strictEqual(finalFile.state.sections[0].query, 'print survives rejection = 1');
			assert.strictEqual(finalFile.state.sections[1].text, 'after reload');
		} finally {
			releaseSurvivingAdapter?.();
			releaseAdapter?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('pending projection rejects stale adapter persistence before lease acquisition', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const originalCreateReloadRequest = CompatSidecarSession.prototype.createReloadRequest;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-late-lease-'));
		const filePath = path.join(tmpDir, 'late-lease.kqlx');
		const notebook = (query: string, markdown: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query },
				{ id: 'markdown_1', type: 'markdown', text: markdown },
			] },
		}, null, 2) + '\n';
		let currentText = notebook('print baseline = 0', 'before');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		let initialProjection: any;
		let holdReloadAcknowledgement = false;
		let pendingReloadRequestId = '';
		let markCandidatePosted!: () => void;
		const candidatePosted = new Promise<void>(resolve => { markCandidatePosted = resolve; });
		let staleApplyCalls = 0;
		const acknowledgeCurrentProjection = async (
			request: Promise<unknown>,
			previousRequestId: string,
		): Promise<void> => {
			let settled = false;
			void request.then(() => { settled = true; });
			let acknowledgedRequestId = previousRequestId;
			for (let attempt = 0; attempt < 8; attempt++) {
				await waitForCondition(
					() => !!pendingReloadRequestId && pendingReloadRequestId !== acknowledgedRequestId,
					'current projection candidate should be posted',
					1_000,
				);
				acknowledgedRequestId = pendingReloadRequestId;
				await Promise.resolve(receiveHandler!({
					type: 'documentReloadResult', requestId: acknowledgedRequestId,
					applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
				}));
				await new Promise<void>(resolve => setImmediate(resolve));
				if (settled) break;
			}
			await request;
		};

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => publish(state);
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (replacement.includes('print stale adapter = 1')) {
					staleApplyCalls++;
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
			const posted: any[] = [];
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') {
							latestProjection = message;
							initialProjection ??= message;
						}
						if (message?.reloadRequestId) {
							if (holdReloadAcknowledgement) {
								pendingReloadRequestId = message.reloadRequestId;
								markCandidatePosted();
								return true;
							}
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
								markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			currentText = notebook('print reload = 2', 'before');
			holdReloadAcknowledgement = true;
			const reload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await candidatePosted;
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'pending-projection-stale', editRevision: 1,
				sourceGeneration: initialProjection.sourceGeneration,
				state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print stale adapter = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'stale adapter markdown' },
				] },
			}));
			await stalePersist;
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'pending-projection-stale'));
			assert.strictEqual(staleApplyCalls, 0, 'pending source authority must reject stale persistence before applyEdit');
			const ownerBeforeActivation = [...((provider as any).markdownDocuments.values())][0];
			assert.strictEqual(ownerBeforeActivation.queue.activePersistenceLeases.size, 0);
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: pendingReloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await reload;
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'late-lease-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after reload' },
				},
			}));
			const finalFile = JSON.parse(currentText);
			assert.strictEqual(finalFile.state.sections[0].query, 'print reload = 2');
			assert.strictEqual(finalFile.state.sections[1].text, 'after reload');
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'late-lease-command' && message.ok === true));

			const activeCommandResult = posted.find(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'late-lease-command');
			const activeOwner = [...((provider as any).markdownDocuments.values())][0];
			const previousRequestId = pendingReloadRequestId;
			currentText = notebook('print obsolete candidate = 3', 'after reload');
			const driftReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(
				() => pendingReloadRequestId !== previousRequestId,
				'obsolete projection candidate should be posted',
				1_000,
			);
			const obsoleteRequestId = pendingReloadRequestId;
			currentText = notebook('print source drift = 4', 'after reload');
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: obsoleteRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await driftReload;
			assert.strictEqual([...((provider as any).markdownDocuments.values())][0], activeOwner);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-drift-stale-command',
				sourceGeneration: activeCommandResult.sourceGeneration,
				expectedDocumentRevision: activeCommandResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: activeCommandResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after source drift' },
				},
			}));
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'post-drift-stale-command' && message.ok === false));
			const currentDriftReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await acknowledgeCurrentProjection(currentDriftReload, obsoleteRequestId);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-drift-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after source drift' },
				},
			}));
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'post-drift-command' && message.ok === true));
			const driftFile = JSON.parse(currentText);
			assert.strictEqual(driftFile.state.sections[0].query, 'print source drift = 4');
			assert.strictEqual(driftFile.state.sections[1].text, 'after source drift');

			const postDriftResult = posted.find(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'post-drift-command');
			const ownerBeforeExpiredAck = [...((provider as any).markdownDocuments.values())][0];
			CompatSidecarSession.prototype.createReloadRequest = function (_timeoutMs, options) {
				return originalCreateReloadRequest.call(this, 20, options);
			};
			const driftRequestId = pendingReloadRequestId;
			currentText = notebook('print expired candidate = 5', 'after source drift');
			const expiredReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(
				() => pendingReloadRequestId !== driftRequestId,
				'expiring projection candidate should be posted',
				1_000,
			);
			const expiredRequestId = pendingReloadRequestId;
			await expiredReload;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: expiredRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			assert.strictEqual([...((provider as any).markdownDocuments.values())][0], ownerBeforeExpiredAck);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-expired-stale-command',
				sourceGeneration: postDriftResult.sourceGeneration,
				expectedDocumentRevision: postDriftResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: postDriftResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after expired acknowledgement' },
				},
			}));
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'post-expired-stale-command' && message.ok === false));
			CompatSidecarSession.prototype.createReloadRequest = originalCreateReloadRequest;
			const recoveryRequestId = pendingReloadRequestId;
			const recoveryReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await acknowledgeCurrentProjection(recoveryReload, recoveryRequestId);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-expired-ack-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after expired acknowledgement' },
				},
			}));
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'post-expired-ack-command' && message.ok === true));
		} finally {
			CompatSidecarSession.prototype.createReloadRequest = originalCreateReloadRequest;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('an acknowledged reload rolls back an in-flight stale Markdown write', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-command-preemption-'));
		const filePath = path.join(tmpDir, 'command-preemption.kqlx');
		const notebook = (query: string, markdown: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query },
				{ id: 'markdown_1', type: 'markdown', text: markdown },
			] },
		}, null, 2) + '\n';
		let currentText = notebook('print baseline = 0', 'before');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		let markCommandApplyStarted!: () => void;
		let releaseCommandApply!: () => void;
		const commandApplyStarted = new Promise<void>(resolve => { markCommandApplyStarted = resolve; });
		const commandApplyGate = new Promise<void>(resolve => { releaseCommandApply = resolve; });
		let gateCommandApply = true;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				if (gateCommandApply && replacement.includes('stale command')) {
					gateCommandApply = false;
					markCommandApplyStarted();
					await commandApplyGate;
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
			const posted: any[] = [];
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
								markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'preempted-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'stale command' },
				},
			}));
			await commandApplyStarted;
			currentText = notebook('print reload = 2', 'reload wins');
			const previousGeneration = latestProjection.sourceGeneration;
			const reload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(
				() => latestProjection.sourceGeneration !== previousGeneration,
				'new projection should activate while the stale command write is paused',
				1_000,
			);
			releaseCommandApply();
			await Promise.all([command, reload]);
			const finalFile = JSON.parse(currentText);
			assert.strictEqual(finalFile.state.sections[0].query, 'print reload = 2');
			assert.strictEqual(finalFile.state.sections[1].text, 'reload wins');
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'preempted-command' && message.ok === false));
		} finally {
			releaseCommandApply?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('empty MDX accepts its default Markdown command after projection acknowledgement', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-empty-mdx-owner-'));
		const filePath = path.join(tmpDir, 'empty.mdx');
		let currentText = JSON.stringify({ kind: 'mdx', version: 1, state: { sections: [] } });
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let defaultSent = false;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
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
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.reloadRequestId) {
							const acknowledgement = Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
							let defaultCommand = Promise.resolve<unknown>(undefined);
							if (!defaultSent && message.ok === true && message.state.sections.length === 0) {
								defaultSent = true;
								defaultCommand = Promise.resolve(receiveHandler?.({
									type: 'markdownDocumentCommand', commandId: 'empty-mdx-default',
									sourceGeneration: message.sourceGeneration,
									expectedDocumentRevision: message.documentRevision,
									command: {
										type: 'add',
										section: { id: 'markdown_default', type: 'markdown', text: '' },
									},
								}));
							}
							await Promise.all([acknowledgement, defaultCommand]);
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(
							handler,
							() => latestDocumentViewHostMessage(posted),
						);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(defaultSent);
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'empty-mdx-default' && message.ok === true));
			const file = JSON.parse(currentText);
			assert.deepStrictEqual(file.state.sections.map((section: any) => section.id), ['markdown_default']);
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const editCount of [1, 9]) {
		test(`native Save preserves id-less SQL results after ${editCount} unsaved Markdown edits`, async () => {
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalApplyEdit = vscode.workspace.applyEdit;
			const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
			const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-idless-sql-save-'));
			const filePath = path.join(tmpDir, 'saved-results.sqlx');
			const uri = vscode.Uri.file(filePath);
			const resultJson = JSON.stringify({ columns: [{ name: 'Value', type: 'int' }], rows: [[7]] });
			const initialText = JSON.stringify({
				kind: 'sqlx', version: 1, state: { sections: [
					{ type: 'sql', query: 'SELECT 7 AS Value', resultJson },
					{ id: 'markdown_1', type: 'markdown', text: 'before' },
				] },
			}, null, 2) + '\n';
			let currentText = initialText;
			let receiveHandler: ((message: any) => unknown) | undefined;
			let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
			let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
			let projection: any;
			let commandResult: any;
			const disposeHandlers: Array<() => void> = [];
			const unsavedTexts = new Set<string>();
			const document = {
				uri, getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false, version: 1,
			} as any;
			try {
				fs.writeFileSync(filePath, initialText, 'utf8');
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
				(vscode.workspace as any).onWillSaveTextDocument = (handler: typeof willSaveHandler) => {
					willSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).onDidSaveTextDocument = (handler: typeof didSaveHandler) => {
					didSaveHandler = handler;
					return { dispose() {} };
				};
				(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
					const entries = edit.entries();
					assert.strictEqual(entries[0]?.[0].toString(), uri.toString());
					const replacement = entries[0]?.[1]?.[0]?.newText;
					if (typeof replacement !== 'string') return false;
					currentText = replacement;
					document.isDirty = true;
					document.version++;
					unsavedTexts.add(currentText);
					return true;
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => {
							if (message?.type === 'documentData') projection = message;
							if (message?.reloadRequestId) {
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
								}));
							}
							if (message?.type === 'markdownDocumentCommandResult') commandResult = message;
							if (message?.type === 'requestMarkdownCommandBarrier') {
								await Promise.resolve(receiveHandler?.({
									type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
									sourceGeneration: message.sourceGeneration,
									documentRevision: commandResult?.documentRevision ?? projection.documentRevision,
									accepted: true,
								}));
							}
							if (message?.type === 'requestFinalPersist') {
								await Promise.resolve(receiveHandler?.({
									type: 'persistDocument', flushRequestId: message.requestId,
									sourceGeneration: projection.sourceGeneration, state: JSON.parse(currentText).state,
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: (message: any) => unknown) => {
							receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
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
				const generatedSqlId = projection.state.sections[0].id;
				assert.ok(generatedSqlId);
				assert.strictEqual(projection.state.sections[0].resultJson, resultJson);
				for (let revision = 1; revision <= editCount; revision++) {
					await Promise.resolve(receiveHandler!({
						type: 'markdownDocumentCommand', commandId: `unsaved-markdown-${revision}`,
						sourceGeneration: projection.sourceGeneration,
						expectedDocumentRevision: commandResult?.documentRevision ?? projection.documentRevision,
						command: {
							type: 'patch', sectionId: 'markdown_1',
							expectedSectionRevision: (commandResult?.projection ?? projection).markdownSectionRevisions.markdown_1,
							patch: { text: `unsaved edit ${revision}` },
						},
					}));
					assert.strictEqual(commandResult?.ok, true);
					assert.strictEqual(JSON.parse(currentText).state.sections[0].id, generatedSqlId);
					assert.strictEqual(JSON.parse(currentText).state.sections[0].resultJson, resultJson);
				}
				assert.strictEqual(unsavedTexts.size, editCount);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
				let savePreparation: Promise<vscode.TextEdit[]> | undefined;
				assert.ok(willSaveHandler);
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { savePreparation = Promise.resolve(thenable); },
				} as any);
				assert.ok(savePreparation);
				const edits = await savePreparation!;
				const savedText = edits[0]?.newText ?? currentText;
				assert.strictEqual(JSON.parse(savedText).state.sections[0].resultJson, resultJson,
					'native Save must preserve the id-less disk attachment after unsaved source-cache churn');
				currentText = savedText;
				document.isDirty = false;
				document.version++;
				fs.writeFileSync(filePath, savedText, 'utf8');
				assert.ok(didSaveHandler);
				await Promise.resolve(didSaveHandler!(document));
				await (provider as any).markdownDocumentQueues.get(normalizeWorkbenchUriKey(uri)).tail;
				assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[0].resultJson, resultJson);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				assert.strictEqual(projection.state.sections[0].id, generatedSqlId);
				assert.strictEqual(projection.state.sections[0].resultJson, resultJson);
				assert.strictEqual(projection.state.sections[1].text, `unsaved edit ${editCount}`);
			} finally {
				for (const dispose of disposeHandlers) dispose();
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				(vscode.workspace as any).applyEdit = originalApplyEdit;
				(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
				(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
			}
		});
	}

	test('native Save waits for initial Markdown projection before preparing a dirty notebook', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-initial-save-'));
		const filePath = path.join(tmpDir, 'initial.kqlx');
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print 1' },
				{ id: 'markdown_1', type: 'markdown', title: 'Summary', text: '# Original' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let projection: any;
		let barrierRequests = 0;
		let preparation: Promise<vscode.TextEdit[]> | undefined;
		let settled = false;
		let preparationError: unknown;
		const disposeHandlers: Array<() => void> = [];
		const document = {
			uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true,
		} as any;
		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).onWillSaveTextDocument = (handler: typeof willSaveHandler) => {
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
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') projection = message;
						if (message?.type === 'requestMarkdownCommandBarrier') {
							barrierRequests++;
							await Promise.resolve(receiveHandler?.({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration,
								documentRevision: projection.documentRevision, accepted: true,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							await Promise.resolve(receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration,
								state: JSON.parse(currentText).state,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
					receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
					return { dispose() {} };
				},
				},
			onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler);
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					preparation = Promise.resolve(thenable);
					void preparation.then(() => { settled = true; }, error => { settled = true; preparationError = error; });
				},
			} as any);
			await waitForCondition(() => !!projection || settled,
				'Initial Save neither requested a Markdown projection nor settled', 1_000);
			assert.ok(projection, `Save must request the initial host Markdown projection before preparing edits: ${String(preparationError)}`);
			assert.strictEqual(settled, false, 'Save must wait for projection acknowledgement');
			assert.strictEqual(barrierRequests, 0);
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: projection.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			const edits = await preparation!;
			assert.strictEqual(barrierRequests, 1);
			const state = JSON.parse(edits[0]?.newText ?? currentText).state;
			assert.deepStrictEqual(state.sections.map((section: any) => section.id), ['query_1', 'markdown_1']);
			assert.strictEqual(state.sections[1].title, 'Summary');
			assert.strictEqual(state.sections[1].text, '# Original');
		} finally {
			for (const dispose of disposeHandlers) dispose();
			await preparation?.catch(() => undefined);
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('background native Save preserves tool-owned Markdown before foreground projection', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-background-markdown-save-'));
		const filePath = path.join(tmpDir, 'report.kqlx');
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ id: 'query_1', type: 'query', query: 'print 1' }] },
		});
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print 1' },
				{ id: 'markdown_1', type: 'markdown', title: 'Summary', text: '# Tool report' },
			] },
		});
		let adapterQuery = 'print 1';
		let backgroundOwned = true;
		let userInteractionTransfers = 0;
		let projection: any;
		let barrierRequests = 0;
		let finalPersistRequests = 0;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		const document = {
			uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true, version: 1,
		} as any;
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).onWillSaveTextDocument = (handler: typeof willSaveHandler) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: typeof didSaveHandler) => {
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
				undefined, undefined, () => backgroundOwned, () => {
					userInteractionTransfers++;
					backgroundOwned = false;
					return Promise.resolve();
				},
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') projection = message;
						if (message?.type === 'requestMarkdownCommandBarrier') {
							barrierRequests++;
							await Promise.resolve(receiveHandler?.({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration,
								documentRevision: projection.documentRevision, accepted: true,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalPersistRequests++;
							const state = JSON.parse(currentText).state;
							state.sections[0].query = adapterQuery;
							await Promise.resolve(receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration, state,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
					receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
					return { dispose() {} };
				},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler);
			const prepareSave = () => {
				let preparation: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { preparation = Promise.resolve(thenable); },
				} as any);
				assert.ok(preparation);
				return preparation!;
			};
			const backgroundEdits = await Promise.race([
				prepareSave(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Background Save waited for a webview')), 1_000)),
			]);
			assert.deepStrictEqual(backgroundEdits, []);
			assert.strictEqual(projection, undefined);
			assert.strictEqual(barrierRequests, 0);
			assert.strictEqual(finalPersistRequests, 0);
			fs.writeFileSync(filePath, currentText, 'utf8');
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections[1],
				{ id: 'markdown_1', type: 'markdown', title: 'Summary', text: '# Tool report' });

			const initialProjection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!projection, 'Background panel did not request its projection', 1_000);
			const backgroundProjection = projection as { reloadRequestId: string; viewSessionId: string } | undefined;
			assert.ok(backgroundProjection);
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: backgroundProjection.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await initialProjection;
			const acknowledgedBackgroundSave = prepareSave();
			document.version++;
			const acceptedEdits = await Promise.race([
				acknowledgedBackgroundSave,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Background Save waited for its active webview')), 1_000)),
			]);
			assert.deepStrictEqual(acceptedEdits, [], 'the background source must not return version-sensitive Save edits');
			assert.strictEqual(barrierRequests, 0);
			assert.strictEqual(finalPersistRequests, 0);

			await Promise.resolve(receiveHandler!({
				type: 'backgroundWorkbenchUserInteraction', viewSessionId: 'retired-session',
			}));
			assert.strictEqual(userInteractionTransfers, 0);
			assert.strictEqual(backgroundOwned, true);
			await Promise.resolve(receiveHandler!({
				type: 'backgroundWorkbenchUserInteraction', viewSessionId: backgroundProjection.viewSessionId,
			}));
			assert.strictEqual(userInteractionTransfers, 1);
			assert.strictEqual(backgroundOwned, false);
			adapterQuery = 'print EditedBeforeDebounce = 2';
			const foregroundSave = prepareSave();
			const foregroundEdits = await foregroundSave;
			assert.strictEqual(barrierRequests, 1);
			assert.strictEqual(finalPersistRequests, 1);
			assert.strictEqual(foregroundEdits.length, 1);
			fs.writeFileSync(filePath, foregroundEdits[0].newText, 'utf8');
			const restoredSections = JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections;
			assert.strictEqual(restoredSections[0].query, adapterQuery);
			assert.strictEqual(restoredSections[1].text, '# Tool report');

			currentText = foregroundEdits[0].newText;
			document.isDirty = false;
			document.version++;
			assert.ok(didSaveHandler);
			await Promise.resolve(didSaveHandler!(document));
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const [uri, replacements] = edit.entries()[0] ?? [];
				const replacement = replacements?.[0]?.newText;
				assert.strictEqual(uri?.toString(), document.uri.toString());
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				document.isDirty = true;
				document.version++;
				return true;
			};
			let userSaves = 0;
			document.save = async () => {
				userSaves++;
				const edits = await prepareSave();
				if (edits.length > 0) currentText = edits.at(-1)!.newText;
				fs.writeFileSync(filePath, currentText, 'utf8');
				document.isDirty = false;
				await Promise.resolve(didSaveHandler!(document));
				return true;
			};
			adapterQuery = 'print SavedWithoutDebounce = 3';
			const userState = JSON.parse(currentText).state;
			userState.sections[0].query = adapterQuery;
			const userProjection = projection as { sourceGeneration: number } | undefined;
			assert.ok(userProjection);
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: userState,
				sourceGeneration: userProjection.sourceGeneration, editRevision: 1,
				snapshotId: 'trusted-user-save-1', flush: true, reason: 'user-save',
			}));
			assert.strictEqual(userSaves, 1, 'an explicit webview Save must commit the accepted snapshot');
			const userSavedSections = JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections;
			assert.strictEqual(userSavedSections[0].query, adapterQuery);
			assert.strictEqual(userSavedSections[1].text, '# Tool report');
			assert.strictEqual(document.isDirty, false);
		} finally {
			for (const dispose of disposeHandlers) dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('first user Save waits for a background edit and rejects its stale snapshot', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-background-handoff-save-'));
		const filePath = path.join(tmpDir, 'handoff.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print Initial = 1' },
				{ id: 'markdown_1', type: 'markdown', text: '# Notes' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		let releaseBackgroundEdit!: () => void;
		const backgroundEdit = new Promise<void>(resolve => { releaseBackgroundEdit = resolve; });
		let backgroundOwned = true;
		let saveCalls = 0;
		let editCalls = 0;
		const saveErrors: string[] = [];
		const disposeHandlers: Array<() => void> = [];
		const document = {
			uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true, version: 1,
			save: async () => { saveCalls++; return true; },
		} as any;
		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async () => { editCalls++; return true; };
			(vscode.window as any).showErrorMessage = async (message: string) => { saveErrors.push(message); return undefined; };
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, undefined, () => backgroundOwned, () => {
					backgroundOwned = false;
					return backgroundEdit;
				},
		) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') {
							projection = message;
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(projection);
			await Promise.resolve(receiveHandler!({
				type: 'backgroundWorkbenchUserInteraction', viewSessionId: projection.viewSessionId,
			}));
			assert.strictEqual(backgroundOwned, false);
			const staleState = JSON.parse(currentText).state;
			staleState.sections[0].query = 'print StaleView = 2';
			const racedSave = Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: staleState,
				sourceGeneration: projection.sourceGeneration, editRevision: 1,
				snapshotId: 'user-save-before-background-edit', flush: true, reason: 'user-save',
			}));
			let settled = false;
			void racedSave.then(() => { settled = true; }, () => { settled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(settled, false, 'Save must await the in-flight background edit');
			assert.strictEqual(saveCalls, 0);
			assert.strictEqual(editCalls, 0);
			const newerFile = JSON.parse(currentText);
			newerFile.state.sections[0].query = 'print BackgroundTool = 3';
			currentText = JSON.stringify(newerFile);
			document.version++;
			releaseBackgroundEdit();
			await racedSave;
			assert.strictEqual(saveCalls, 0, 'stale user Save must not follow the background write');
			assert.strictEqual(editCalls, 0, 'stale user snapshot must not edit the newer document');
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'print BackgroundTool = 3');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: staleState,
				sourceGeneration: projection.sourceGeneration, editRevision: 2,
				snapshotId: 'user-save-after-background-edit', flush: true, reason: 'user-save',
			}));
			assert.strictEqual(saveCalls, 0, 'a later stale Save must wait for the new source projection');
			assert.strictEqual(editCalls, 0, 'the later stale snapshot must not replace the completed tool edit');
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'print BackgroundTool = 3');
			assert.strictEqual(saveErrors.length, 2, 'both declined Save requests must be visible to the user');
			assert.ok(saveErrors.every(error => error.includes('notebook changed during a background edit')));
		} finally {
			releaseBackgroundEdit();
			for (const dispose of disposeHandlers) dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('failed background handoff notifies on Save and permits a new explicit Save', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalShowErrorMessage = vscode.window.showErrorMessage;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-background-handoff-retry-'));
		const filePath = path.join(tmpDir, 'retry.kqlx');
		const currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print 1' },
				{ id: 'markdown_1', type: 'markdown', text: '# Notes' },
			] },
		});
		let backgroundOwned = true;
		let transferAttempts = 0;
		let saveCalls = 0;
		let persistAcks = 0;
		const saveErrors: string[] = [];
		let projection: any;
		let receiveHandler: ((message: any) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		const document = {
			uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true, version: 1,
			save: async () => { saveCalls++; return true; },
		} as any;
		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.window as any).showErrorMessage = async (message: string) => { saveErrors.push(message); return undefined; };
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
				undefined, undefined, () => backgroundOwned, () => {
					transferAttempts++;
					if (transferAttempts === 1) return Promise.reject(new Error('The background editor is still settling.'));
					backgroundOwned = false;
					return Promise.resolve();
				},
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'persistDocumentAck') persistAcks++;
						if (message?.type === 'documentData') {
							projection = message;
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						if (message?.type === 'requestMarkdownCommandBarrier') {
							await Promise.resolve(receiveHandler?.({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration,
								documentRevision: projection.documentRevision, accepted: true,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							await Promise.resolve(receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration, state: JSON.parse(currentText).state,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(projection);
			await Promise.resolve(receiveHandler!({
				type: 'backgroundWorkbenchUserInteraction', viewSessionId: projection.viewSessionId,
			}));
			const submitSave = (snapshotId: string, editRevision: number) => Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: JSON.parse(currentText).state,
				sourceGeneration: projection.sourceGeneration, snapshotId, editRevision,
				flush: true, reason: 'user-save',
			}));
			await submitSave('failed-handoff-save', 1);
			assert.strictEqual(transferAttempts, 1);
			assert.strictEqual(saveCalls, 0);
			assert.strictEqual(backgroundOwned, true);
			assert.strictEqual(saveErrors.length, 1, 'a failed intercepted Save must show an error');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: JSON.parse(currentText).state,
				sourceGeneration: projection.sourceGeneration, snapshotId: 'auto-after-failed-handoff',
				editRevision: 1, reason: 'query-edit',
			}));
			assert.strictEqual(persistAcks, 0, 'an automatic webview snapshot must not claim a background-owned document');
			await submitSave('new-explicit-save', 2);
			assert.strictEqual(transferAttempts, 2, 'the new user Save should retry ownership transfer once');
			assert.strictEqual(saveCalls, 1);
			assert.strictEqual(backgroundOwned, false);
			assert.strictEqual(saveErrors.length, 1);
		} finally {
			for (const dispose of disposeHandlers) dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('native Save waits for a background source edit to reach the active Markdown projection', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-background-save-projection-'));
		const filePath = path.join(tmpDir, 'background.kqlx');
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ id: 'query_1', type: 'query', query: 'print 1' }] },
		});
		let currentText = initialText;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let latestProjection: any;
		let deferredProjection: any;
		let barrierRequest: any;
		let barrierCount = 0;
		let advanceSourceOnBarrier = false;
		let holdProjection = false;
		let postedProjectionCount = 0;
		let savePreparation: Promise<vscode.TextEdit[]> | undefined;
		let blockedSave: Promise<vscode.TextEdit[]> | undefined;
		let markdownQueue: { pendingCommands: number } | undefined;
		const disposeHandlers: Array<() => void> = [];
		const document = {
			uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true,
		} as any;
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).onWillSaveTextDocument = (handler: typeof willSaveHandler) => {
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
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') {
							postedProjectionCount++;
							latestProjection = message;
							if (holdProjection) deferredProjection = message;
							else await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						if (message?.type === 'requestMarkdownCommandBarrier') {
							barrierRequest = message;
							barrierCount++;
							if (advanceSourceOnBarrier) {
								advanceSourceOnBarrier = false;
								currentText = JSON.stringify({
									kind: 'kqlx', version: 1,
									state: { sections: [
										{ id: 'query_1', type: 'query', query: 'print 3' },
										{ id: 'markdown_1', type: 'markdown', title: 'Summary', text: '# Most recent' },
									] },
								});
								await Promise.resolve(receiveHandler?.({ type: 'requestDocument' }));
							}
							await Promise.resolve(receiveHandler?.({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration,
								documentRevision: latestProjection.documentRevision, accepted: true,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							await Promise.resolve(receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: latestProjection.sourceGeneration,
								state: JSON.parse(currentText).state,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
					receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
					return { dispose() {} };
				},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(willSaveHandler);
			assert.strictEqual(barrierRequest, undefined, 'the baseline projection must not have a pending Save barrier');
			const firstGeneration = latestProjection.sourceGeneration;
			holdProjection = true;
			currentText = JSON.stringify({
				kind: 'kqlx', version: 1,
				state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print 2' },
					{ id: 'markdown_1', type: 'markdown', title: 'Summary', text: '# Updated' },
				] },
			});
			markdownQueue = (provider as any).markdownDocumentQueues.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(markdownQueue);
			markdownQueue.pendingCommands = 1;
			let blockedSaveSettled = false;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					blockedSave = Promise.resolve(thenable);
					void blockedSave.then(() => { blockedSaveSettled = true; }, () => { blockedSaveSettled = true; });
				},
			} as any);
			await waitForCondition(() => blockedSaveSettled || !!deferredProjection || !!barrierRequest,
				'Pending-command Save did not settle or try to replace the projection', 1_000);
			assert.deepStrictEqual(deferredProjection, undefined,
				'Save must not discard an in-flight Markdown command by replacing its projection');
			assert.strictEqual(barrierRequest, undefined);
			await assert.rejects(blockedSave!, /pending Markdown commands/);
			markdownQueue.pendingCommands = 0;
			const pendingRefresh = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!deferredProjection, 'Background source projection was not posted', 1_000);
			const pendingProjectionCount = postedProjectionCount;
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.strictEqual(postedProjectionCount, pendingProjectionCount,
				'The held source projection must stay stable before Save begins');
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { savePreparation = Promise.resolve(thenable); },
			} as any);
			assert.ok(deferredProjection, 'Save must project the latest background bytes before reserving a Markdown barrier');
			assert.strictEqual(barrierRequest, undefined, 'Save must not use the stale Markdown projection');
			const saveProjection = deferredProjection as unknown as { sourceGeneration: number; reloadRequestId: string };
			assert.notStrictEqual(saveProjection.sourceGeneration, firstGeneration);
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.strictEqual(postedProjectionCount, pendingProjectionCount,
				'Save must join the pending source projection instead of publishing another one');
			holdProjection = false;
			advanceSourceOnBarrier = true;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: saveProjection.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await pendingRefresh;
			assert.ok(savePreparation);
			const edits = await savePreparation!;
			assert.strictEqual(postedProjectionCount, pendingProjectionCount + 1);
			assert.strictEqual(barrierCount, 2, 'Save must reacquire a read-only barrier for the newer source');
			assert.ok(barrierRequest);
			const savedText = edits[0]?.newText ?? currentText;
			const sections = JSON.parse(savedText).state.sections;
			assert.deepStrictEqual(sections.map((section: any) => section.id), ['query_1', 'markdown_1']);
			assert.strictEqual(sections[0].query, 'print 3');
			assert.strictEqual(sections[1].title, 'Summary');
			assert.strictEqual(sections[1].text, '# Most recent');
		} finally {
			for (const dispose of disposeHandlers) dispose();
			if (markdownQueue) markdownQueue.pendingCommands = 0;
			await blockedSave?.catch(() => undefined);
			await savePreparation?.catch(() => undefined);
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	for (const scenario of ['lease expiry', 'unleased expiry', 'unleased final snapshot failure', 'different committed bytes', 'source changed', 'disposal', 'lease expiry recovery (controlled callbacks)'] as const) {
	test(`native commit join fails closed (${scenario})`, async function () {
		this.timeout(15_000);
		const recoveryCase = scenario === 'lease expiry recovery (controlled callbacks)';
		const prototype = (QueryEditorProvider as any).prototype;
		const originalInitialize = prototype.initializeWebviewPanel;
		const originalSetLifecycle = prototype.setWorkbenchFileCloseLifecycle;
		const originalWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const originalSingleton = Object.getOwnPropertyDescriptor(KustoWorkbenchToolOrchestrator, 'instance')!;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-commit-bound-'));
		const uri = vscode.Uri.file(path.join(root, 'probe.kqlx'));
		const baseline = JSON.stringify({ kind: 'kqlx', version: 1, futureRoot: { keep: true }, state: { sections: [{
			id: 'query_1', type: 'query', query: 'print Probe1=1', futureSection: 42,
			resultJson: JSON.stringify({ columns: ['Probe1'], rows: [[1]] }),
		}] } }, null, 2);
		let currentText = baseline.replace('"futureSection": 42', '"futureSection": 43');
		const document = {
			uri, getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: true,
		} as any;
		let receive: ((message: any) => unknown) | undefined;
		let willSave: ((event: any) => void) | undefined;
		let didSave: ((saved: vscode.TextDocument) => unknown) | undefined;
		let lifecycle: { inspectDirty(): Promise<boolean>; save(): Promise<void> } | undefined;
		let projection: any;
		let captureTimers = false;
		const timers: Array<{ handle: ReturnType<typeof setTimeout>; expire(): void; cleared: boolean }> = [];
		const disposals: Array<() => void> = [];
		let preparation: Promise<vscode.TextEdit[]> | undefined;
		let inspection: Promise<{ value?: boolean; error?: unknown }> | undefined;
		let siblingInspection: typeof inspection;
		let recovery: ReturnType<KustoWorkbenchToolOrchestrator['saveWorkbenchFile']> | undefined;
		let orchestrator: KustoWorkbenchToolOrchestrator | undefined;
		let connectionToken: number | undefined;
		let recoveryCommits = 0;
		let completed = false;
		try {
			fs.writeFileSync(uri.fsPath, baseline);
			prototype.initializeWebviewPanel = async () => undefined;
			prototype.setWorkbenchFileCloseLifecycle = function (this: QueryEditorProvider, value: typeof lifecycle) {
				lifecycle = value;
				return originalSetLifecycle.call(this, value);
			};
			(vscode.workspace as any).onWillSaveTextDocument = (handler: typeof willSave) => { willSave = handler; return { dispose() {} }; };
			(vscode.workspace as any).onDidSaveTextDocument = (handler: typeof didSave) => { didSave = handler; return { dispose() {} }; };
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
			const context = {
				subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
				globalState: { get: () => undefined, update: async () => undefined },
				globalStorageUri: vscode.Uri.file(path.join(root, 'global')),
			} as any;
			const connections = connectionManagerStub();
			const sqlWorkbench = sqlWorkbenchStub();
			const provider = new (KqlxEditorProvider as any)(context,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connections, sqlWorkbench) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message.type === 'documentData' && message.ok) projection = message;
						if (message.reloadRequestId) {
							await Promise.resolve(receive!({
								type: 'documentReloadResult', requestId: message.reloadRequestId, applied: true, editRevision: 0,
								markdownCommandBarrierSupported: !scenario.startsWith('unleased'),
							}));
						}
						if (message.type === 'requestMarkdownCommandBarrier') {
							await Promise.resolve(receive!({
								type: 'markdownDocumentCommandBarrierResult', requestId: message.requestId,
								sourceGeneration: message.sourceGeneration, documentRevision: 0, accepted: true,
							}));
						}
						if (message.type === 'requestFinalPersist' && scenario !== 'unleased final snapshot failure') {
							await Promise.resolve(receive!({ type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration, state: JSON.parse(currentText).state }));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposals.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receive!({ type: 'requestDocument' }));
			if (recoveryCase) {
				(KustoWorkbenchToolOrchestrator as any).instance = undefined;
				orchestrator = KustoWorkbenchToolOrchestrator.getInstance(context, connections, () => sqlWorkbench.connectionManager, {} as any);
				connectionToken = orchestrator.connect(() => true, async () => JSON.parse(currentText).state.sections,
					async () => ({ schemas: [] }), uri.toString(), undefined, undefined, lifecycle);
				document.save = async () => {
					let retryPreparation: Promise<vscode.TextEdit[]> | undefined;
					willSave!({ document, waitUntil: (work: Thenable<vscode.TextEdit[]>) => { retryPreparation = Promise.resolve(work); } });
					const retryEdits = await retryPreparation!;
					if (retryEdits.length) currentText = retryEdits[0].newText;
					fs.writeFileSync(uri.fsPath, currentText);
					document.isDirty = false;
					recoveryCommits++;
					await Promise.resolve(didSave!(document));
					return true;
				};
			}
			captureTimers = true;
			willSave!({ document, waitUntil: (work: Thenable<vscode.TextEdit[]>) => { preparation = Promise.resolve(work); } });
			const edits = await preparation!;
			captureTimers = false;
			if (edits.length) currentText = edits[0].newText;
			const preparedText = currentText;
			const activeTimers = timers.filter(timer => !timer.cleared);
			assert.strictEqual(activeTimers.length, 1, 'Every prepared native Save must retain the existing five-second commit lease');
			let settled = false;
			inspection = lifecycle!.inspectDirty().then(value => { settled = true; return { value }; }, error => {
				settled = true;
				return { error };
			});
			if (recoveryCase) siblingInspection = lifecycle!.inspectDirty().then(value => ({ value }), error => ({ error }));
			await new Promise<void>(resolve => setImmediate(resolve));
			if (scenario !== 'unleased final snapshot failure') {
				assert.strictEqual(settled, false, 'Preparation alone must not complete inspection without onDidSave');
			}
			let expectedDisk = baseline;
			if (scenario === 'different committed bytes') {
				currentText = JSON.stringify(JSON.parse(preparedText));
				expectedDisk = currentText;
				fs.writeFileSync(uri.fsPath, currentText);
				document.isDirty = false;
				await Promise.resolve(didSave!(document));
			} else if (scenario === 'source changed') {
				currentText = preparedText.replace('print Probe1=1', 'print UserDraft=2');
				await Promise.resolve(receive!({ type: 'requestDocument' }));
				await Promise.resolve(didSave!({ ...document, getText: () => preparedText }));
			} else if (scenario === 'disposal') {
				for (const dispose of disposals.splice(0)) dispose();
			} else if (scenario.endsWith('expiry') || recoveryCase) {
				activeTimers[0].expire();
			}
			if (recoveryCase) {
				assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), baseline);
				assert.strictEqual(document.isDirty, true);
				recovery = orchestrator!.saveWorkbenchFile({ targetFileUri: uri.toString() });
			}
			const outcome = await inspection;
			assert.ok(outcome.error instanceof Error, `${scenario}: inspection must reject, not silently retry native Save`);
			assert.match(outcome.error.message, /native notebook Save|Save lifecycle/);
			if (recoveryCase) {
				const siblingOutcome = await siblingInspection!;
				assert.ok(siblingOutcome.error instanceof Error, 'Every caller already joining the expired attempt must reject');
				const result = await recovery!;
				fs.writeFileSync(path.join(root, 'recovery.json'), JSON.stringify({ scenario, timing: 'controlled callbacks',
					originalError: outcome.error.message, siblingError: siblingOutcome.error.message, result,
					recoveryCommits, buffer: currentText, disk: fs.readFileSync(uri.fsPath, 'utf8'), dirty: document.isDirty }, null, 2));
				console.log(JSON.stringify({ scenario, result, recoveryCommits }));
				assert.strictEqual(result.success, true, 'A fresh public Save must not inherit an expired attempt failure');
				assert.strictEqual(result.saved, true);
				assert.strictEqual(recoveryCommits, 1);
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(currentText, preparedText);
				assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), preparedText);
				completed = true;
				return;
			}
			assert.strictEqual(fs.readFileSync(uri.fsPath, 'utf8'), expectedDisk, 'Failed joining must not replace durable bytes');
			assert.strictEqual(document.isDirty, scenario !== 'different committed bytes');
			assert.strictEqual(JSON.parse(currentText).state.sections[0].futureSection, 43);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].resultJson, JSON.parse(baseline).state.sections[0].resultJson);
			assert.deepStrictEqual(JSON.parse(currentText).futureRoot, { keep: true });
			if (scenario === 'source changed') assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'print UserDraft=2');
			fs.writeFileSync(path.join(root, 'outcome.json'), JSON.stringify({ scenario, error: outcome.error.message,
				buffer: currentText, disk: expectedDisk, dirty: document.isDirty, leaseTimeoutMs: 5_000 }, null, 2));
			completed = true;
		} finally {
			captureTimers = false;
			for (const timer of timers.filter(candidate => !candidate.cleared)) timer.expire();
			await preparation?.catch(() => undefined);
			await Promise.resolve(didSave?.(document));
			await inspection?.catch(() => undefined);
			await siblingInspection?.catch(() => undefined);
			await recovery?.catch(() => undefined);
			if (connectionToken !== undefined) orchestrator?.disconnectIfOwner(connectionToken);
			for (const dispose of disposals.splice(0)) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			prototype.initializeWebviewPanel = originalInitialize;
			prototype.setWorkbenchFileCloseLifecycle = originalSetLifecycle;
			(vscode.workspace as any).onWillSaveTextDocument = originalWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalDidSave;
			(globalThis as any).setTimeout = originalSetTimeout;
			(globalThis as any).clearTimeout = originalClearTimeout;
			if (recoveryCase) Object.defineProperty(KustoWorkbenchToolOrchestrator, 'instance', originalSingleton);
			console.log(`Retained ${completed ? 'passed' : 'failed'} native commit bound fixture: ${root}`);
		}
	});
	}

	test('native Save fences a Markdown command still in transport', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
		const originalFreshPublication = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		let holdFreshPublication = false;
		let blockedFreshPublications = 0;
		let releaseFreshPublication!: () => void;
		const freshPublicationGate = new Promise<void>(resolve => { releaseFreshPublication = resolve; });
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-in-transit-save-'));
		const filePath = path.join(tmpDir, 'in-transit.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		const disposeHandlers: Array<() => void> = [];
		let projection: any;
		let pendingBarrier: any;
		const capturedBarriers: any[] = [];
		let commandResult: any;
		let holdReloadAcknowledgement = false;
		let pendingReloadRequestId = '';
		let markPendingProjectionPosted!: () => void;
		const pendingProjectionPosted = new Promise<void>(resolve => { markPendingProjectionPosted = resolve; });
		let holdFinalPersist = false;
		let holdBarrierReply = false;
		let rejectNextBarrier = false;
		let raceCommandAfterBarrierResponse = false;
		let heldFinalPersistRequestId = '';
		let finalPersistRequestCount = 0;
		const sourceReplacements: string[] = [];
		let earlyCommitSave: Promise<vscode.TextEdit[]> | undefined;
		let earlyCommitCommand: Promise<void> | undefined;
		const additionalSavePreparations: Promise<vscode.TextEdit[]>[] = [];

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async function (...args: unknown[]) {
				if (holdFreshPublication) {
					blockedFreshPublications++;
					await freshPublicationGate;
				}
				return originalFreshPublication.apply(this, args);
			};
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				didSaveHandler = handler;
				return { dispose() {} };
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				sourceReplacements.push(replacement);
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
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: true,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							if (holdReloadAcknowledgement) {
								pendingReloadRequestId = message.reloadRequestId;
								markPendingProjectionPosted();
								return true;
							}
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						if (message?.type === 'requestMarkdownCommandBarrier') {
							pendingBarrier = message;
							capturedBarriers.push(message);
							if (commandResult && !holdBarrierReply) {
								const accepted = !rejectNextBarrier;
								rejectNextBarrier = false;
								const priorResult = commandResult;
								const barrierResponse = Promise.resolve(receiveHandler?.({
									type: 'markdownDocumentCommandBarrierResult', requestId: pendingBarrier.requestId,
									sourceGeneration: pendingBarrier.sourceGeneration,
									documentRevision: priorResult.documentRevision, accepted,
								}));
								if (raceCommandAfterBarrierResponse) {
									raceCommandAfterBarrierResponse = false;
									const racedCommand = Promise.resolve(receiveHandler?.({
										type: 'markdownDocumentCommand', commandId: 'barrier-response-race-command',
										sourceGeneration: priorResult.sourceGeneration,
										expectedDocumentRevision: priorResult.documentRevision,
										command: {
											type: 'patch', sectionId: 'markdown_1',
											expectedSectionRevision: priorResult.projection.markdownSectionRevisions.markdown_1,
											patch: { text: 'after barrier response race' },
										},
									}));
									await Promise.all([barrierResponse, racedCommand]);
								} else {
									await barrierResponse;
								}
							}
						}
						if (message?.type === 'markdownDocumentCommandResult') {
							commandResult = message;
							if (pendingBarrier && !holdBarrierReply) {
								await Promise.resolve(receiveHandler?.({
									type: 'markdownDocumentCommandBarrierResult', requestId: pendingBarrier.requestId,
									sourceGeneration: pendingBarrier.sourceGeneration,
									documentRevision: message.documentRevision, accepted: true,
								}));
							}
						}
						if (message?.type === 'requestFinalPersist') {
							if (holdFinalPersist) {
								heldFinalPersistRequestId = message.requestId;
								finalPersistRequestCount++;
								return true;
							}
							await Promise.resolve(receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: commandResult?.sourceGeneration ?? projection.sourceGeneration,
								state: { sections: [{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' }] },
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
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
			holdBarrierReply = true;
			let committedBeforeBarrier!: Promise<vscode.TextEdit[]>;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					committedBeforeBarrier = Promise.resolve(thenable);
					additionalSavePreparations.push(committedBeforeBarrier);
					void committedBeforeBarrier.catch(() => undefined);
				},
			} as any);
			await waitForCondition(() => !!pendingBarrier, 'native Save should request its barrier before a late reply');
			const lateBarrier = pendingBarrier;
			const queueBeforeBarrier = [...((provider as any).markdownDocumentQueues.values())][0];
			let preBarrierSettled = false;
			void committedBeforeBarrier.then(() => { preBarrierSettled = true; }, () => { preBarrierSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(preBarrierSettled, false, 'an uncommitted user preparation must remain pending');
			fs.writeFileSync(filePath, currentText, 'utf8');
			await Promise.resolve(didSaveHandler!(document));
			assert.deepStrictEqual(await Promise.race([
				committedBeforeBarrier,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('already committed Save still waits for an unacquired barrier')), 500)),
			]), []);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommandBarrierResult', requestId: lateBarrier.requestId,
				sourceGeneration: lateBarrier.sourceGeneration, documentRevision: projection.documentRevision, accepted: true,
			}));
			const beforeOverlappingBarriers = capturedBarriers.length;
			const overlappingPreparations: Promise<vscode.TextEdit[]>[] = [];
			let unleasedSettlements = 0;
			for (let index = 0; index < 2; index++) willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					const pending = Promise.resolve(thenable);
					overlappingPreparations.push(pending);
					additionalSavePreparations.push(pending);
					void pending.then(() => { unleasedSettlements++; }, () => { unleasedSettlements++; });
				},
			} as any);
			await waitForCondition(() => capturedBarriers.length === beforeOverlappingBarriers + 2, 'two unleased Saves must have distinct barriers');
			await Promise.resolve(didSaveHandler!(document));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(unleasedSettlements, 0, 'an ambiguous commit must not guess among unleased Saves');
			const firstUnleased = capturedBarriers[beforeOverlappingBarriers];
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommandBarrierResult', requestId: firstUnleased.requestId,
				sourceGeneration: firstUnleased.sourceGeneration, documentRevision: projection.documentRevision, accepted: false,
			}));
			await assert.rejects(overlappingPreparations[0], /pending Markdown commands did not settle/);
			await Promise.resolve(didSaveHandler!(document));
			assert.deepStrictEqual(await overlappingPreparations[1], []);
			const secondUnleased = capturedBarriers[beforeOverlappingBarriers + 1];
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommandBarrierResult', requestId: secondUnleased.requestId,
				sourceGeneration: secondUnleased.sourceGeneration, documentRevision: projection.documentRevision, accepted: true,
			}));
			holdBarrierReply = false;
			pendingBarrier = undefined;
			holdReloadAcknowledgement = true;
			currentText = currentText.replace('"before"', '"committed before projection"');
			const committedProjection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await pendingProjectionPosted;
			const barriersBeforeProjectionCommit = capturedBarriers.length;
			let committedBeforeProjection!: Promise<vscode.TextEdit[]>;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					committedBeforeProjection = Promise.resolve(thenable);
					additionalSavePreparations.push(committedBeforeProjection);
					void committedBeforeProjection.catch(() => undefined);
				},
			} as any);
			await new Promise<void>(resolve => setImmediate(resolve));
			fs.writeFileSync(filePath, currentText, 'utf8');
			await Promise.resolve(didSaveHandler!(document));
			holdReloadAcknowledgement = false;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: pendingReloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await committedProjection;
			assert.deepStrictEqual(await committedBeforeProjection, []);
			assert.strictEqual(capturedBarriers.length, barriersBeforeProjectionCommit, 'a committed projection waiter must not later reserve a Save lease');
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'in-transit-command',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after' },
				},
			}));
			assert.ok(willSaveHandler);
			let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
			} as any);
			await Promise.all([command, saveBarrier!]);
			assert.strictEqual(commandResult?.ok, true);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after');
			assert.ok(didSaveHandler);
			document.isDirty = false;
			holdFreshPublication = true;
			await Promise.resolve(didSaveHandler!(document));
			const queueAfterNoOpSave = [...((provider as any).markdownDocumentQueues.values())][0];
			await Promise.race([
				queueAfterNoOpSave.tail,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('identical committed results still hold the Save lease behind fresh publication')), 500)),
			]);
			assert.strictEqual(blockedFreshPublications, 0, 'identical committed bytes must not enter fresh result publication');
			holdFreshPublication = false;
			document.isDirty = true;

			rejectNextBarrier = true;
			let rejectedSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { rejectedSave = Promise.resolve(thenable); },
			} as any);
			await assert.rejects(rejectedSave!, /pending Markdown commands did not settle/);
			const postRejectedSaveCommand = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-rejected-save-command',
				sourceGeneration: commandResult.sourceGeneration,
				expectedDocumentRevision: commandResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: commandResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after rejected save' },
				},
			}));
			await postRejectedSaveCommand;
			assert.strictEqual(commandResult?.ok, true);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after rejected save');

			raceCommandAfterBarrierResponse = true;
			let racedSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { racedSave = Promise.resolve(thenable); },
			} as any);
			await racedSave;
			assert.strictEqual(commandResult?.commandId, 'barrier-response-race-command');
			assert.strictEqual(commandResult?.ok, true);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after barrier response race');
			await Promise.resolve(didSaveHandler!(document));

			holdFinalPersist = true;
			let reservedSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { reservedSave = Promise.resolve(thenable); },
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 1, 'first reserved Save should request its final snapshot');
			const firstReservedRequestId = heldFinalPersistRequestId;
			let overlappingSaveSettled = false;
			let overlappingSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					overlappingSave = Promise.resolve(thenable).then(edits => {
						overlappingSaveSettled = true;
						return edits;
					});
				},
			} as any);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(overlappingSaveSettled, false, 'overlapping Save must wait for the first Save lease');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', flushRequestId: firstReservedRequestId,
				sourceGeneration: commandResult.sourceGeneration,
				state: { sections: [{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' }] },
			}));
			await reservedSave;
			assert.strictEqual(overlappingSaveSettled, false, 'overlapping Save must wait for the first commit');
			await Promise.resolve(didSaveHandler!(document));
			await waitForCondition(() => finalPersistRequestCount === 2, 'overlapping Save should begin after the first commit');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', flushRequestId: heldFinalPersistRequestId,
				sourceGeneration: commandResult.sourceGeneration,
				state: { sections: [{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' }] },
			}));
			await overlappingSave;
			await Promise.resolve(didSaveHandler!(document));

			let commandRaceSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { commandRaceSave = Promise.resolve(thenable); },
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 3, 'command-race Save should request its final snapshot');
			let postBarrierCommandSettled = false;
			const postBarrierCommand = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-barrier-command',
				sourceGeneration: commandResult.sourceGeneration,
				expectedDocumentRevision: commandResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: commandResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after committed save' },
				},
			})).then(() => { postBarrierCommandSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(postBarrierCommandSettled, false, 'Save must reserve the owner queue after barrier acceptance');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', flushRequestId: heldFinalPersistRequestId,
				sourceGeneration: commandResult.sourceGeneration,
				state: { sections: [{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' }] },
			}));
			await commandRaceSave;
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(postBarrierCommandSettled, false, 'Save must retain the owner lease until commit');
			assert.ok(didSaveHandler);
			await Promise.resolve(didSaveHandler!(document));
			await postBarrierCommand;
			assert.strictEqual(postBarrierCommandSettled, true);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after committed save');
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					earlyCommitSave = Promise.resolve(thenable);
					void earlyCommitSave.catch(() => undefined);
				},
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 4, 'early-commit Save should request its final snapshot');
			const earlyCommitRequestId = heldFinalPersistRequestId;
			let earlyCommitCommandSettled = false;
			earlyCommitCommand = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-early-commit-command',
				sourceGeneration: commandResult.sourceGeneration,
				expectedDocumentRevision: commandResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: commandResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after early commit' },
				},
			})).then(() => { earlyCommitCommandSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(earlyCommitCommandSettled, false, 'early-commit Save must fence commands before commit');
			const replacementsBeforeEarlyCommit = sourceReplacements.length;
			await Promise.resolve(didSaveHandler!(document));
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', flushRequestId: earlyCommitRequestId,
				sourceGeneration: commandResult.sourceGeneration,
				state: { sections: [{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' }] },
			}));
			await waitForCondition(() => earlyCommitCommandSettled, 'command must settle after early native commit, not after lease timeout', 500);
			await assert.rejects(earlyCommitSave!, /changed while Save was waiting for the final snapshot/);
			assert.strictEqual(commandResult?.commandId, 'post-early-commit-command');
			assert.strictEqual(commandResult?.ok, true);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after early commit');
			assert.ok(sourceReplacements.slice(replacementsBeforeEarlyCommit).every(text =>
				JSON.parse(text).state.sections[0].text === 'after early commit'));
			let noCommandSave!: Promise<vscode.TextEdit[]>;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					noCommandSave = Promise.resolve(thenable);
					additionalSavePreparations.push(noCommandSave);
					void noCommandSave.catch(() => undefined);
				},
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 5, 'unmodified early-commit Save should request its final snapshot');
			await Promise.resolve(didSaveHandler!(document));
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', flushRequestId: heldFinalPersistRequestId,
				sourceGeneration: commandResult.sourceGeneration,
				state: { sections: [{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' }] },
			}));
			await assert.rejects(noCommandSave, /changed while Save was waiting for the final snapshot/);
			const queueAfterEarlyCommit = [...((provider as any).markdownDocumentQueues.values())][0];
			assert.strictEqual(queueAfterEarlyCommit.pendingOwnedMutation, undefined);
			const replacementsBeforeLateFailure = sourceReplacements.length;
			let lateFailedSave!: Promise<vscode.TextEdit[]>;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					lateFailedSave = Promise.resolve(thenable);
					additionalSavePreparations.push(lateFailedSave);
					void lateFailedSave.catch(() => undefined);
				},
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 6, 'late-failure Save should request its final snapshot');
			await Promise.resolve(didSaveHandler!(document));
			await assert.rejects(lateFailedSave, /timed out|timeout/i);
			assert.strictEqual(sourceReplacements.length, replacementsBeforeLateFailure);
			assert.strictEqual(queueAfterEarlyCommit.pendingOwnedMutation, undefined, 'late snapshot failure must not claim unapplied bytes');

			let mismatchedCommitSave!: Promise<vscode.TextEdit[]>;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					mismatchedCommitSave = Promise.resolve(thenable);
					additionalSavePreparations.push(mismatchedCommitSave);
				},
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 7, 'different-byte Save should request its final snapshot');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', flushRequestId: heldFinalPersistRequestId,
				sourceGeneration: commandResult.sourceGeneration,
				state: { sections: [{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' }] },
			}));
			await mismatchedCommitSave;
			let mismatchedCommitCommandSettled = false;
			const mismatchedCommitCommand = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-mismatched-commit-command',
				sourceGeneration: commandResult.sourceGeneration,
				expectedDocumentRevision: commandResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: commandResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after mismatched commit' },
				},
			})).then(() => { mismatchedCommitCommandSettled = true; });
			const committedText = JSON.stringify(JSON.parse(currentText));
			assert.notStrictEqual(committedText, currentText);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(mismatchedCommitCommandSettled, false, 'the user Save lease remains held until its native commit');
			await Promise.resolve(didSaveHandler!({ ...document, getText: () => committedText }));
			await waitForCondition(() => mismatchedCommitCommandSettled, 'actual native commit must release its lease even when its bytes differ', 500);
			await mismatchedCommitCommand;
			assert.strictEqual(commandResult?.ok, true);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'after mismatched commit');
			holdFinalPersist = false;

			const activeOwner = [...((provider as any).markdownDocuments.values())][0];
			currentText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'markdown_1', type: 'markdown', text: 'unacknowledged source' },
				] },
			}, null, 2) + '\n';
			holdReloadAcknowledgement = true;
			const previousReloadRequestId = pendingReloadRequestId;
			const pendingReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => pendingReloadRequestId !== previousReloadRequestId, 'newer source must post its own unacknowledged projection');
			let pendingSourceSave: Promise<vscode.TextEdit[]> | undefined;
			let pendingSourceSaveSettled = false;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => {
					pendingSourceSave = Promise.resolve(thenable);
					void pendingSourceSave.then(() => { pendingSourceSaveSettled = true; }, () => { pendingSourceSaveSettled = true; });
				},
			} as any);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(pendingSourceSaveSettled, false, 'Save must wait for the newer Markdown projection');
			assert.strictEqual([...((provider as any).markdownDocuments.values())][0], activeOwner);
			holdReloadAcknowledgement = false;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: pendingReloadRequestId,
				applied: false, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await assert.rejects(pendingSourceSave!, /latest notebook text was not accepted/);
			await pendingReload;
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'unacknowledged source');

			currentText = activeOwner.sourceText;
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			holdFinalPersist = true;
			let disposedSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { disposedSave = Promise.resolve(thenable); },
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 8, 'disposal Save should reserve the queue');
			for (const dispose of disposeHandlers) dispose();
			await assert.rejects(disposedSave!);
			const queue = [...((provider as any).markdownDocumentQueues.values())][0] as { tail: Promise<void> };
			await Promise.race([
				queue.tail,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('disposed Save lease did not settle')), 1_000)),
			]);
		} finally {
			releaseFreshPublication();
			holdFreshPublication = false;
			for (const dispose of disposeHandlers) dispose();
			await Promise.allSettled([earlyCommitSave, earlyCommitCommand, ...additionalSavePreparations]);
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalFreshPublication;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rejected native projection does not mutate Kusto result authority', async function () {
		this.timeout(10_000);
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-rejected-kusto-source-'));
		const filePath = path.join(tmpDir, 'rejected-source.kqlx');
		const resultJson = JSON.stringify({
			columns: [{ name: 'Value', type: 'long' }], rows: [[1]],
			metadata: { cluster: 'cluster', database: 'Db' },
		});
		const resultState = {
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_1', type: 'query', query: 'print Value=1',
				clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db', resultJson,
			}] },
		};
		const rowFreeState = {
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_1', type: 'query', query: 'print Value=2',
				clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db',
			}] },
		};
		let currentText = JSON.stringify(resultState);
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		const heldReloadRequestIds: string[] = [];
		let holdReload = false;
		let autoRejectReloads = 0;
		const disposeHandlers: Array<() => void> = [];
		const registry = new KustoResultPersistenceRegistry();

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(), sqlWorkbenchStub(), undefined, registry,
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							if (autoRejectReloads > 0) {
								autoRejectReloads--;
								await Promise.resolve(receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: false, editRevision: 0,
								}));
								return true;
							}
							if (holdReload) {
								heldReloadRequestIds.push(message.reloadRequestId);
								return true;
							}
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
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
			const owner = registry.get(normalizeWorkbenchUriKey(document.uri));
			assert.ok(owner);
			assert.strictEqual(
				(owner!.overlaySnapshot(rowFreeState.state).sections?.[0] as any).resultJson,
				resultJson,
			);

			currentText = JSON.stringify(rowFreeState);
			autoRejectReloads = 3;
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			autoRejectReloads = 0;

			assert.strictEqual(
				(owner!.overlaySnapshot(rowFreeState.state).sections?.[0] as any).resultJson,
				resultJson,
			);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const resultSession = owner!.openPanel('concurrent-result-panel');
			resultSession.openSection('query_1', 'concurrent-result-instance');
			resultSession.adoptTarget({
				boxId: 'query_1', sectionInstanceId: 'concurrent-result-instance', targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
			const newerTerminal = {
				type: 'queryResult' as const, engine: 'kusto' as const, boxId: 'query_1',
				sectionInstanceId: 'concurrent-result-instance', targetGeneration: 1,
				executionId: 'concurrent-result-execution', connectionId: 'connection-1', database: 'Db',
				producer: 'manual' as const, query: 'print Value=2', reservationSequence: 1,
				dispatch: {
					dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
					connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
					clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
					accountPartition: 'partition-a', authSessionGeneration: 1,
					clientActivityId: 'concurrent-result',
				},
				result: { columns: ['Value'], rows: [[2]], metadata: {} },
			};
			assert.strictEqual(resultSession.beginExecution(newerTerminal), true);
			holdReload = true;
			const heldBeforeConflict = heldReloadRequestIds.length;
			const conflictedProjection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(
				() => heldReloadRequestIds.length === heldBeforeConflict + 1,
				'conflicted reload should be posted',
			);
			assert.ok(resultSession.stagePublication('concurrent-result-publication', newerTerminal));
			assert.strictEqual(resultSession.commitPublication('concurrent-result-publication'), true);
			holdReload = false;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: heldReloadRequestIds[heldBeforeConflict],
				applied: true, editRevision: 0,
			}));
			await conflictedProjection;
			await waitForCondition(() => {
				const ownerResult = (owner!.overlaySnapshot(rowFreeState.state).sections?.[0] as any).resultJson;
				const projectedSection = latestProjection?.state?.sections?.find((value: any) => value.id === 'query_1');
				try {
					return JSON.parse(String(ownerResult || '')).rows?.[0]?.[0] === 2
						&& JSON.parse(String(projectedSection?.resultJson || '')).rows?.[0]?.[0] === 2;
				} catch {
					return false;
				}
			}, 'native conflict retry should activate the newer host result');
			const currentResult = (owner!.overlaySnapshot(rowFreeState.state).sections?.[0] as any).resultJson;
			assert.strictEqual(JSON.parse(currentResult).rows[0][0], 2);
			const projectedSection = latestProjection?.state?.sections?.find((value: any) => value.id === 'query_1');
			const projectedResult = projectedSection?.resultJson
				? JSON.parse(projectedSection.resultJson)
				: undefined;
			assert.strictEqual(
				projectedResult?.rows?.[0]?.[0],
				2,
				`fresh projection should carry the newer host result: ${JSON.stringify({
					projectedSection,
					ownerResult: JSON.parse(currentResult),
				})}`,
			);
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
		} finally {
			registry.dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('fresh native sanitation preserves a saved same-source Kusto attachment across policy changes', async function () {
		this.timeout(20_000);
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kusto-privacy-owner-'));
		const filePath = path.join(tmpDir, 'privacy-owner.kqlx');
		const documentUri = vscode.Uri.file(filePath);
		const registry = new KustoResultPersistenceRegistry();
		const seedLease = registry.acquire(normalizeWorkbenchUriKey(documentUri));
		const owner = seedLease.owner;
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Value=1' }],
		};
		const seedSession = owner.openPanel('privacy-seed-panel');
		seedSession.openSection('query_1', 'privacy-seed-instance');
		seedSession.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'privacy-seed-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		const terminal = {
			type: 'queryResult' as const, engine: 'kusto' as const, boxId: 'query_1',
			sectionInstanceId: 'privacy-seed-instance', targetGeneration: 1,
			executionId: 'privacy-seed-execution', connectionId: 'connection-1', database: 'Db',
			producer: 'manual' as const, query: 'print Value=1', reservationSequence: 1,
			dispatch: {
				dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
				connectionIdentityKey: 'https://cluster.kusto.windows.net|authority',
				clusterEndpoint: 'https://cluster.kusto.windows.net', authorityId: 'authority',
				accountPartition: 'partition-a', authSessionGeneration: 1,
				clientActivityId: 'privacy-seed',
			},
			result: { columns: ['Value'], rows: [[1]], metadata: {} },
		};
		assert.strictEqual(seedSession.beginExecution(terminal), true);
		assert.ok(seedSession.stagePublication('privacy-seed-publication', terminal));
		assert.strictEqual(seedSession.commitPublication('privacy-seed-publication'), true);
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: owner.overlaySnapshot(rowFreeState),
		});
		let protectedNow = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		let acknowledgedSourceGeneration = 0;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		let panelDisposed = false;
		const disposePanel = () => {
			if (panelDisposed) return;
			panelDisposed = true;
			for (const dispose of disposeHandlers) dispose();
		};
		let policySnapshot: {
			clusterKeys: string[];
			globallyBlocked: boolean;
			version: number;
			revocationGenerations: Record<string, number>;
		} = { clusterKeys: [], globallyBlocked: false, version: 0, revocationGenerations: {} };
		const connectionManager = {
			...connectionManagerStub(),
			runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: typeof policySnapshot) => unknown) =>
				await run(policySnapshot),
		};

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
				state: any,
				onKustoSanitized?: (before: any, after: any, context: any) => void,
			) => {
				if (!protectedNow) return state;
				const sanitized = {
					...state,
					sections: state.sections.map((section: any) => {
						if (section.id !== 'query_1') return section;
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
					snapshot: policySnapshot,
				});
				return sanitized;
			};
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				fs.writeFileSync(filePath, replacement, 'utf8');
				return true;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManager, sqlWorkbenchStub(), undefined, registry,
			) as KqlxEditorProvider;
			const document = {
				uri: documentUri, getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
							}));
							acknowledgedSourceGeneration = message.sourceGeneration;
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
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
			const initialSourceGeneration = latestProjection.sourceGeneration;
			seedLease.release();
			assert.ok(latestProjection.state.sections[0].resultJson);
			protectedNow = true;
			policySnapshot = {
				clusterKeys: ['cluster.kusto.windows.net'], globallyBlocked: true,
				version: 1, revocationGenerations: { 'cluster.kusto.windows.net': 1 },
			};
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			assert.ok(acknowledgedSourceGeneration > initialSourceGeneration);
			assert.strictEqual(acknowledgedSourceGeneration, latestProjection.sourceGeneration);
			assert.ok(latestProjection.state.sections[0].resultJson);
			assert.strictEqual(owner.hasCommittedAttachments(), true);
			assert.ok((owner.overlaySnapshot(rowFreeState).sections?.[0] as any).resultJson);
			assert.ok(currentText.includes('resultJson'));
			assert.ok(fs.readFileSync(filePath, 'utf8').includes('resultJson'));
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const revokedAttachmentPersist = {
				type: 'persistDocument', snapshotId: 'revoked-attachment', editRevision: 1,
				sourceGeneration: latestProjection.sourceGeneration,
				state: latestProjection.state,
			};
			await Promise.resolve(receiveHandler!(revokedAttachmentPersist));
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'revoked-attachment'),
				'revoked attachment persistence should acknowledge',
			);
			assert.ok(currentText.includes('resultJson'));
			assert.ok(fs.readFileSync(filePath, 'utf8').includes('resultJson'));
			disposePanel();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 2_000), true);
		} finally {
			disposePanel();
			await KqlxEditorProvider.waitForOpenEditorsClosed(documentUri, 2_000);
			seedLease.release();
			registry.dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('session policy revocation retries a cold result admission into an active writable projection', async function () {
		this.timeout(10_000);
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kusto-held-policy-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const documentUri = vscode.Uri.file(filePath);
		const sourceRegistry = new KustoResultPersistenceRegistry();
		const sourceLease = sourceRegistry.acquire('fixture://held-policy');
		const sourceSession = sourceLease.owner.openPanel('fixture-panel');
		sourceSession.openSection('query_1', 'fixture-instance');
		sourceSession.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'fixture-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		const terminal = {
			type: 'queryResult' as const, engine: 'kusto' as const, boxId: 'query_1',
			sectionInstanceId: 'fixture-instance', targetGeneration: 1,
			executionId: 'fixture-execution', connectionId: 'connection-1', database: 'Db',
			producer: 'manual' as const, query: 'print Value=1', reservationSequence: 1,
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
			sections: [
				{ id: 'query_1', type: 'query', query: 'print Value=1' },
				{ id: 'markdown_retry', type: 'markdown', text: 'remove after retry' },
			],
		});
		const rowFreeState = {
			sections: [
				{ id: 'query_1', type: 'query', query: 'print Value=1' },
				{ id: 'markdown_retry', type: 'markdown', text: 'remove after retry' },
			],
		};
		const currentText = JSON.stringify({ kind: 'kqlx', version: 1, state: persistedState });
		const registry = new KustoResultPersistenceRegistry();
		let protectedNow = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		const commandResults: any[] = [];
		let heldReloadRequestId = '';
		let holdReload = true;
		const disposeHandlers: Array<() => void> = [];
		let canonicalPolicySnapshot = {
			clusterKeys: [] as string[], globallyBlocked: false, version: 1,
			revocationGenerations: { 'cluster.kusto.windows.net': 0 },
		};
		const connectionManager = {
			...connectionManagerStub(),
			runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: typeof canonicalPolicySnapshot) => unknown) =>
				await run(canonicalPolicySnapshot),
		};

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (
				state: any,
				onKustoSanitized?: (before: any, after: any, context: any) => void,
			) => {
				const sanitized = protectedNow ? {
					...state,
					sections: state.sections.map((section: any) => {
						if (section.id !== 'query_1') return section;
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
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir),
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManager, sqlWorkbenchStub(), undefined, registry,
			) as KqlxEditorProvider;
			const document = {
				uri: documentUri, getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.type === 'markdownDocumentCommandResult') commandResults.push(message);
						if (!message?.reloadRequestId) return true;
						if (holdReload) { heldReloadRequestId = message.reloadRequestId; return true; }
						await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId,
							applied: true, editRevision: 0,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			const projection = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!heldReloadRequestId, 'cold result admission should await acknowledgement');
			assert.ok(latestProjection.state.sections[0].resultJson);
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
				applied: true, editRevision: 0,
			}));
			await projection;
			await waitForCondition(() => !latestProjection.state.sections[0].resultJson,
				'policy conflict retry should project row-free state');
			assert.ok(!(owner!.overlaySnapshot(rowFreeState).sections?.[0] as any).resultJson);
			assert.strictEqual((owner as any).preparedSourceOwnerRevisionByIdentity.size, 0);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'remove-after-policy-retry',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'remove', sectionId: 'markdown_retry',
					expectedSectionRevision: latestProjection.sectionRevisions.markdown_retry,
				},
			}));
			const removal = commandResults.find(result => result.commandId === 'remove-after-policy-retry');
			assert.strictEqual(removal?.ok, true, JSON.stringify(removal));
			assert.deepStrictEqual(
				JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections.map((section: any) => section.id),
				['query_1'],
			);
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 5_000), true);
		} finally {
			sourceLease.release();
			sourceRegistry.dispose();
			registry.dispose();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	async function verifySessionStableWriteObservation(mode: 'external' | 'replacement' | 'text-document'): Promise<void> {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalOnDidChange = vscode.workspace.onDidChangeTextDocument;
		const originalOpen = fs.promises.open;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-stable-write-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const uri = vscode.Uri.file(filePath);
		const initialState = {
			futureState: { keep: 'owned native write' },
			sections: [
				{ id: 'query_1', type: 'query', query: 'print Value=1' },
				{ id: 'sql_1', type: 'sql', query: 'select 1 as Value' },
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{ id: 'url_1', type: 'url', url: 'https://example.com/data.csv' },
				{ id: 'python_1', type: 'python', code: 'print(1)' },
				{ id: 'chart_1', type: 'chart', dataSourceId: 'query_1', chartType: 'bar' },
				{ id: 'transformation_1', type: 'transformation', dataSourceId: 'sql_1' },
				{ id: 'html_1', type: 'html', code: '<main>retained</main>' },
			],
		};
		const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: initialState }, null, 2) + '\n';
		const expectedText = initialText.replace('"text": "before"', '"text": "after"');
		let currentText = initialText;
		const document = {
			uri, getText: () => currentText, eol: vscode.EndOfLine.LF,
			positionAt: (offset: number) => new vscode.Position(0, offset), isDirty: false, version: 1,
		} as any;
		const changeHandlers = new Set<(event: vscode.TextDocumentChangeEvent) => unknown>();
		const pendingChanges: Promise<unknown>[] = [];
		const notifyChange = (text: string) => {
			const previousLength = currentText.length;
			currentText = text;
			for (const handler of changeHandlers) {
				pendingChanges.push(Promise.resolve(handler({
					document, reason: undefined, contentChanges: [{
						text, range: new vscode.Range(document.positionAt(0), document.positionAt(previousLength)),
						rangeOffset: 0, rangeLength: previousLength,
					}],
				})));
			}
		};
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		let holdWrite = false;
		let truncated = false;
		let completedWriteText: string | undefined;
		let completedWriteIdentity: fs.BigIntStats | undefined;
		let releaseWrite!: () => void;
		const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
		let command: Promise<unknown> | undefined;

		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			const initialIdentity = fs.statSync(filePath, { bigint: true });
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).onDidChangeTextDocument = (handler: (event: vscode.TextDocumentChangeEvent) => unknown) => {
				changeHandlers.add(handler);
				return { dispose: () => { changeHandlers.delete(handler); } };
			};
			fs.promises.open = async (...args: Parameters<typeof fs.promises.open>) => {
				const handle = await originalOpen(...args);
				if (String(args[0]) !== uri.fsPath || args[1] !== 'r+') return handle;
				const originalTruncate = handle.truncate;
				const originalSync = handle.sync;
				let heldHandle = false;
				handle.truncate = async (length?: number) => {
					await originalTruncate.call(handle, length);
					if (holdWrite) {
						holdWrite = false;
						heldHandle = true;
						truncated = true;
						notifyChange('');
						await writeGate;
					}
				};
				handle.sync = async () => {
					await originalSync.call(handle);
					if (heldHandle && completedWriteText === undefined) {
						completedWriteText = fs.readFileSync(filePath, 'utf8');
						completedWriteIdentity = fs.statSync(filePath, { bigint: true });
					}
				};
				return handle;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(mode === 'text-document' ? path.join(tmpDir, 'global-storage') : tmpDir),
					extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const sourceGeneration = latestProjection.sourceGeneration;
			const projectionCount = posted.filter(message => message?.type === 'documentData').length;
			const queue = [...(provider as any).markdownDocumentQueues.values()][0] as any;
			const authorityToken = queue.latestAuthority.token;
			if (mode === 'text-document') {
				notifyChange('');
				assert.notStrictEqual(queue.latestAuthority.token, authorityToken,
					'normal TextDocument changes must fence synchronously before their callback returns');
				assert.strictEqual(queue.latestAuthority.sourceText, '');
				await Promise.all(pendingChanges.splice(0));
				assert.notStrictEqual(latestProjection.sourceGeneration, sourceGeneration);
				assert.strictEqual(latestProjection.state.sections.length, 1);
				assert.strictEqual(latestProjection.state.sections[0].type, 'query');
				assert.strictEqual(latestProjection.state.sections[0].query, '');
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
				return;
			}
			holdWrite = true;
			command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'session-stable-write-command',
				sourceGeneration, expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after' },
				},
			}));
			await waitForCondition(() => truncated, 'owned command must reach its final native truncate before sync', 1_000);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), expectedText, 'the writer must not expose an empty file during publication');
			releaseWrite();
			await command;
			await Promise.all(pendingChanges.splice(0));
			assert.strictEqual(completedWriteText, expectedText, 'the original native handle must finish writing all sections');
			assert.strictEqual(completedWriteIdentity?.dev, initialIdentity.dev);
			assert.strictEqual(completedWriteIdentity?.ino, initialIdentity.ino);
			const result = posted.find(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'session-stable-write-command');
			assert.strictEqual(result?.ok, true,
				`a stale empty session notification during publication must not fence the owned command: ${JSON.stringify(result)}`);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'session-stable-write-next-command',
				sourceGeneration, expectedDocumentRevision: result.documentRevision,
				command: {
					type: 'patch', sectionId: 'html_1',
					expectedSectionRevision: result.projection.sectionRevisions.html_1,
					patch: { code: '<main>after</main>' },
				},
			}));
			const nextResult = posted.find(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'session-stable-write-next-command');
			assert.strictEqual(nextResult?.ok, true, JSON.stringify(nextResult));
			assert.strictEqual(nextResult.documentRevision, result.documentRevision + 1);
			const nextText = expectedText.replace('<main>retained</main>', '<main>after</main>');
			notifyChange(nextText);
			notifyChange(nextText);
			notifyChange(expectedText);
			notifyChange('');
			await Promise.all(pendingChanges.splice(0));
			await withKqlxDocumentWriteLock(uri, async () => undefined);
			assert.strictEqual(latestProjection.sourceGeneration, sourceGeneration);
			assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, projectionCount);
			assert.strictEqual(queue.latestAuthority.token, authorityToken);
			assert.strictEqual(queue.latestAuthority.sourceText, nextText);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), nextText);
			assert.deepStrictEqual(nextResult.projection.orderedSectionIds,
				['query_1', 'sql_1', 'markdown_1', 'url_1', 'python_1', 'chart_1', 'transformation_1', 'html_1']);
			if (mode === 'replacement') {
				fs.renameSync(filePath, path.join(tmpDir, 'replaced-session.kqlx'));
				fs.writeFileSync(filePath, nextText, 'utf8');
				assert.notStrictEqual(fs.statSync(filePath, { bigint: true }).ino, initialIdentity.ino);
				notifyChange(nextText);
				await Promise.all(pendingChanges.splice(0));
				assert.notStrictEqual(latestProjection.sourceGeneration, sourceGeneration,
					'identical bytes in a replacement file must not match the owned write identity');
				assert.deepStrictEqual(latestProjection.state, JSON.parse(nextText).state);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), nextText);
				return;
			}
			fs.writeFileSync(filePath, expectedText, 'utf8');
			notifyChange(nextText);
			await Promise.all(pendingChanges.splice(0));
			assert.notStrictEqual(latestProjection.sourceGeneration, sourceGeneration,
				'stable external bytes must override an older unobserved owned write even when the event text is stale');
			assert.strictEqual(latestProjection.state.sections.find((section: any) => section.id === 'html_1').code,
				'<main>retained</main>');
			const externalGeneration = latestProjection.sourceGeneration;
			const externalAuthorityToken = queue.latestAuthority.token;
			const externalProjectionCount = posted.filter(message => message?.type === 'documentData').length;
			notifyChange(expectedText);
			await Promise.all(pendingChanges.splice(0));
			assert.strictEqual(latestProjection.sourceGeneration, externalGeneration,
				'a duplicate accepted external snapshot must not publish another generation');
			assert.strictEqual(queue.latestAuthority.token, externalAuthorityToken);
			assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, externalProjectionCount);
			fs.writeFileSync(filePath, nextText, 'utf8');
			notifyChange(nextText);
			await Promise.all(pendingChanges.splice(0));
			assert.notStrictEqual(latestProjection.sourceGeneration, externalGeneration,
				'latest owned bytes from a retired source authority must reload as an external change');
			assert.strictEqual(latestProjection.state.sections.find((section: any) => section.id === 'html_1').code,
				'<main>after</main>');
			const restoredGeneration = latestProjection.sourceGeneration;
			fs.writeFileSync(filePath, '', 'utf8');
			notifyChange('');
			await Promise.all(pendingChanges.splice(0));
			await waitForCondition(() => latestProjection.sourceGeneration !== restoredGeneration
				&& latestProjection.state.sections.length === 1
				&& latestProjection.state.sections[0].type === 'query'
				&& latestProjection.state.sections[0].query === '',
			'real external empty bytes must reload the session with one Kusto starter');
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), '');
			const authorityBeforeDispose = queue.latestAuthority;
			const projectionsBeforeDispose = posted.filter(message => message?.type === 'documentData').length;
			fs.writeFileSync(filePath, expectedText, 'utf8');
			notifyChange(expectedText);
			for (const dispose of disposeHandlers.splice(0)) dispose();
			await Promise.all(pendingChanges.splice(0));
			assert.strictEqual(queue.latestAuthority, authorityBeforeDispose,
				'a session observation that resumes after disposal must not fence source authority');
			assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, projectionsBeforeDispose);
		} finally {
			releaseWrite();
			await command?.catch(() => undefined);
			await Promise.allSettled(pendingChanges);
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			fs.promises.open = originalOpen;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	}

	test('session stable-write observation preserves owned commands and reloads external empty bytes', async () => {
		await verifySessionStableWriteObservation('external');
	});

	test('session stable-write observation reloads identical bytes from a replacement physical file', async () => {
		await verifySessionStableWriteObservation('replacement');
	});

	test('session stable-write observation leaves normal TextDocument fencing synchronous', async () => {
		await verifySessionStableWriteObservation('text-document');
	});

	test('session publication yields to a newer acknowledged projection after writing', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-command-post-write-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const notebook = (markdown: string, future: string) => JSON.stringify({
			kind: 'kqlx', version: 1, state: {
				futureState: future,
				sections: [{ id: 'markdown_1', type: 'markdown', text: markdown }],
			},
		}, null, 2) + '\n';
		const initialText = notebook('before', 'initial');
		const reloadText = notebook('reload wins', 'reload');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let latestProjection: any;
		let gateCommandPublication = false;
		let markCandidateWritten!: () => void;
		let releaseCandidate!: () => void;
		const candidateWritten = new Promise<void>(resolve => { markCandidateWritten = resolve; });
		const candidateGate = new Promise<void>(resolve => { releaseCandidate = resolve; });

		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				const result = await publish(state);
				if (gateCommandPublication && state.sections?.[0]?.text === 'stale command') {
					gateCommandPublication = false;
					markCandidateWritten();
					await candidateGate;
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
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => initialText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const posted: any[] = [];
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') latestProjection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => latestProjection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			gateCommandPublication = true;
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'session-post-write-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'stale command' },
				},
			}));
			await candidateWritten;
			fs.writeFileSync(filePath, reloadText, 'utf8');
			const previousGeneration = latestProjection.sourceGeneration;
			const reload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(
				() => latestProjection.sourceGeneration !== previousGeneration,
				'session reload projection should activate while command publication is paused',
				1_000,
			);
			releaseCandidate();
			await Promise.all([command, reload]);
			const durable = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			assert.strictEqual(durable.state.futureState, 'reload');
			assert.strictEqual(durable.state.sections[0].text, 'reload wins');
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'session-post-write-command' && message.ok === false));
		} finally {
			releaseCandidate?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const hasSurvivingTextEditor of [true, false]) test(
		hasSurvivingTextEditor
			? 'panel disposal rolls back only the in-flight file command with a surviving text editor'
			: 'panel disposal never rolls back a landed edit after the last view retires',
		async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalVisibleEditors = Object.getOwnPropertyDescriptor(vscode.window, 'visibleTextEditors')!;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-disposal-rollback-'));
		const filePath = path.join(tmpDir, 'dispose.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		const disposeHandlers: Array<() => void> = [];
		const replacements: string[] = [];
		let gateSecond = false;
		let markSecondApplied!: () => void;
		let releaseSecond!: () => void;
		const secondApplied = new Promise<void>(resolve => { markSecondApplied = resolve; });
		const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				replacements.push(replacement);
				currentText = replacement;
				if (gateSecond && replacement.includes('second command')) {
					gateSecond = false;
					markSecondApplied();
					await secondGate;
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
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			Object.defineProperty(vscode.window, 'visibleTextEditors', {
				...originalVisibleEditors,
				get: () => hasSurvivingTextEditor ? [{ document }] : [],
			});
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'first-command',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'first command' },
				},
			}));
			const firstText = currentText;
			const firstResult = projection;
			gateSecond = true;
			const second = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'second-command',
				sourceGeneration: firstResult.sourceGeneration,
				expectedDocumentRevision: firstResult.documentRevision + 1,
				command: {
					type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 1,
					patch: { text: 'second command' },
				},
			}));
			await secondApplied;
			for (const dispose of disposeHandlers) dispose();
			releaseSecond();
			await second;
			if (hasSurvivingTextEditor) {
				assert.strictEqual(currentText, firstText);
				assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'first command');
				assert.strictEqual(replacements.length, 3);
			} else {
				assert.strictEqual(replacements.length, 2, 'A retired owner cannot repair an already-landed edit');
				assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'second command');
			}
		} finally {
			releaseSecond?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			Object.defineProperty(vscode.window, 'visibleTextEditors', originalVisibleEditors);
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('adapter persistence waits for an in-flight Markdown command owner', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-markdown-command-first-'));
		const filePath = path.join(tmpDir, 'command-first.kqlx');
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'print before = 0' },
				{ id: 'markdown_1', type: 'markdown', text: 'before', futureMarkdown: { keep: true } },
			] },
		}, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
		let projection: any;
		const posted: any[] = [];
		let markCommandApplied!: () => void;
		let releaseCommand!: () => void;
		const commandApplied = new Promise<void>(resolve => { markCommandApplied = resolve; });
		const commandGate = new Promise<void>(resolve => { releaseCommand = resolve; });
		let gateCommand = true;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			(vscode.workspace as any).applyEdit = async (edit: vscode.WorkspaceEdit) => {
				const replacement = edit.entries()[0]?.[1]?.[0]?.newText;
				if (typeof replacement !== 'string') return false;
				currentText = replacement;
				if (gateCommand && replacement.includes('command markdown')) {
					gateCommand = false;
					markCommandApplied();
					await commandGate;
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
				uri: vscode.Uri.file(filePath), getText: () => currentText, eol: vscode.EndOfLine.LF,
				positionAt: (_offset: number) => new vscode.Position(0, 0), isDirty: false,
			} as any;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receiveHandler = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'command-first',
				sourceGeneration: projection.sourceGeneration,
				expectedDocumentRevision: projection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'command markdown' },
				},
			}));
			await commandApplied;
			const adapter = Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'adapter-after-command', editRevision: 1,
				sourceGeneration: projection.sourceGeneration,
				state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print adapter = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' },
				] },
			}));
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'adapter-after-command'));
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'print before = 0');
			releaseCommand();
			await Promise.all([command, adapter]);
			await waitForCondition(
				() => posted.some(message => message?.type === 'persistDocumentAck'
					&& message.snapshotId === 'adapter-after-command'),
				'adapter persistence should acknowledge after the Markdown command settles',
			);
			const finalFile = JSON.parse(currentText);
			assert.strictEqual(finalFile.state.sections[0].query, 'print adapter = 1');
			assert.strictEqual(finalFile.state.sections[1].text, 'command markdown');
			assert.deepStrictEqual(finalFile.state.sections[1].futureMarkdown, { keep: true });
		} finally {
			releaseCommand?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const boundary of ['positive claim controls', 'owner expiry', 'disposal', 'mutable source drift',
		'source read throw', 'commit throw', 'arrival retry deadline'] as const) {
		test(`native ACK reservation background owner handles ${boundary}`, async function () {
			this.timeout(30_000);
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalCommit = QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh;
			const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
			const originalClaim = CompatSidecarSession.prototype.claimReloadRequest;
			const originalClock = Object.getOwnPropertyDescriptor(performance, 'now');
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-ack-owner-'));
			const filePath = path.join(tmpDir, 'owner.kqlx');
			const uri = vscode.Uri.file(filePath);
			const savedResult = JSON.stringify({ columns: ['Value'], rows: [[41]], rowCount: 1 });
			const initialText = JSON.stringify({ kind: 'kqlx', version: 1, futureRoot: { retained: true }, state: { sections: [
				{ id: 'query_ack_owner', type: 'query', query: 'print Synthetic=0', resultJson: savedResult },
				{ id: 'markdown_ack_owner', type: 'markdown', text: 'Retained owner notes.' },
			] } }, null, 2) + '\n';
			let currentText = initialText;
			let sourceVersion = 1;
			let ownerClock = 1_000;
			let sourceReadThrows = 0;
			let sourceReadFaults = 0;
			const document = {
				uri,
				getText: () => {
					if (sourceReadThrows > 0) {
						sourceReadThrows--;
						sourceReadFaults++;
						throw new Error('Controlled native source read failure.');
					}
					return currentText;
				},
				get version() { return sourceVersion; },
				get isDirty() { return currentText !== initialText; },
				isClosed: false, eol: vscode.EndOfLine.LF,
				get lineCount() { return currentText.split('\n').length; },
				lineAt: (line: number) => ({ text: currentText.split('\n')[line] ?? '' }),
				positionAt: (offset: number) => {
					const lines = currentText.slice(0, offset).split('\n');
					return new vscode.Position(lines.length - 1, lines.at(-1)!.length);
				},
			} as vscode.TextDocument;
			const posted: any[] = [];
			const projections: any[] = [];
			const claims: Array<{ requestId: string; accepted: boolean; claimedAt: number }> = [];
			const reloads: Array<{ session: CompatSidecarSession; requestId: string; deadline: number; settled?: boolean }> = [];
			const commitResults: boolean[] = [];
			const commitFailures: unknown[] = [];
			const disposeHandlers = new Set<() => void>();
			const subscriptions: vscode.Disposable[] = [];
			let receive: ((message: any) => unknown) | undefined;
			let queryEditor: QueryEditorProvider | undefined;
			let request: Promise<unknown> | undefined;
			let ack: Promise<unknown> | undefined;
			let requestSettled = false;
			let ackSettled = false;
			let admissionCalls = 0;
			let commitFaults = 0;
			let releaseAdmission!: () => void;
			const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
			let panelDisposed = false;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message.type === 'documentData') projections.push(message);
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projections.at(-1));
						return new vscode.Disposable(() => undefined);
					},
				},
				onDidDispose: (handler: () => void) => {
					disposeHandlers.add(handler);
					return new vscode.Disposable(() => { disposeHandlers.delete(handler); });
				},
				dispose: () => {
					if (panelDisposed) return;
					panelDisposed = true;
					for (const handler of [...disposeHandlers]) handler();
				},
			} as unknown as vscode.WebviewPanel;
			try {
				fs.writeFileSync(filePath, initialText, 'utf8');
				Object.defineProperty(performance, 'now', { configurable: true, value: () => ownerClock });
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (this: QueryEditorProvider) {
					queryEditor = this;
				};
				CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
					const reload = originalCreateReload.call(this, timeoutMs, options);
					if (options) {
						const observation = { session: this, requestId: reload.requestId, deadline: options.absoluteCommitDeadline,
							settled: undefined as boolean | undefined };
						reloads.push(observation);
						void reload.result.then(value => { observation.settled = value; });
					}
					return reload;
				};
				CompatSidecarSession.prototype.claimReloadRequest = function (requestId) {
					const accepted = originalClaim.call(this, requestId);
					claims.push({ requestId, accepted, claimedAt: performance.now() });
					return accepted;
				};
				QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = async function (this: QueryEditorProvider,
					...args: Parameters<QueryEditorProvider['commitKustoSourceAdmissionFresh']>) {
					if (this !== queryEditor) return originalCommit.apply(this, args);
					admissionCalls++;
					await admissionGate;
					try {
					if (boundary === 'commit throw' && commitFaults === 0) {
						commitFaults++;
						throw new Error('Controlled native canonical commit failure.');
					}
					const accepted = await originalCommit.apply(this, args);
					commitResults.push(accepted);
					return accepted;
					} catch (error) {
						commitFailures.push(error);
						throw error;
					}
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receive);
				request = Promise.resolve(receive({ type: 'requestDocument', requestId: 'native-background-owner' }))
					.finally(() => { requestSettled = true; });
				await waitForCondition(() => projections.length === 1, 'the actual background provider must deliver initial A', 750);
				assert.strictEqual(reloads[0].deadline, 31_000);
				let projection = projections[0];
				if (boundary === 'arrival retry deadline') {
					ownerClock = 20_000;
					assert.strictEqual(reloads[0].session.hasPendingReloadRequest(reloads[0].requestId), false);
					await waitForCondition(() => projections.length === 2, 'an expired arrival must spend one existing retry', 750);
					assert.strictEqual(reloads[0].settled, false);
					assert.strictEqual(reloads[1].deadline, 31_000, 'a retry must retain the original background operation deadline');
					projection = projections[1];
				}
				const acknowledgement = {
					protocolVersion: projection.protocolVersion, channel: projection.channel, viewSessionId: projection.viewSessionId,
					type: 'documentReloadResult', requestId: projection.reloadRequestId, applied: true, editRevision: 0,
				};
				const currentReload = reloads.at(-1)!;
				let getterCalls = 0;
				if (boundary === 'positive claim controls') {
					await Promise.resolve(receive({ ...acknowledgement, viewSessionId: 'wrong-native-session' }));
					await Promise.resolve(receive({ ...acknowledgement, applied: 'true' }));
					await Promise.resolve(receive({ ...acknowledgement, requestId: 'unknown-native-request' }));
					const accessor = { ...acknowledgement };
					Object.defineProperty(accessor, 'applied', { enumerable: true, get: () => { getterCalls++; return true; } });
					await Promise.resolve(receive(accessor));
					assert.strictEqual(getterCalls, 0);
					assert.strictEqual(claims.length, 0, 'malformed, wrong-session, and unknown ACKs must not reach reservation');
					assert.strictEqual(currentReload.settled, undefined);
					assert.strictEqual(admissionCalls, 0);
				}
				ownerClock += 97;
				ack = Promise.resolve(receive(acknowledgement)).finally(() => { ackSettled = true; });
				await waitForCondition(() => admissionCalls === 1, 'the canonical ACK must enter the actual held commit', 750);
				assert.strictEqual(claims.filter(claim => claim.accepted).length, 1);
				assert.strictEqual(currentReload.settled, undefined);
				if (boundary === 'positive claim controls') {
					await Promise.resolve(receive(acknowledgement));
					await Promise.resolve(receive({ ...acknowledgement, applied: false, editRevision: 99 }));
					assert.strictEqual(claims.filter(claim => claim.accepted).length, 1);
					assert.strictEqual(admissionCalls, 1);
					assert.strictEqual(currentReload.settled, undefined, 'duplicate positive and later false ACKs cannot consume a claimed positive');
					assert.strictEqual(currentReload.session.currentEditRevision, 0);
				}
				if (boundary === 'owner expiry') {
					ownerClock = 31_000;
					assert.strictEqual(currentReload.session.hasPendingReloadRequest(currentReload.requestId), false,
						'the owner operation must expire without a public readiness caller or timer flush');
					await request;
					assert.strictEqual(ackSettled, false, 'logical expiry must not finish the held physical commit');
					assert.strictEqual(requestSettled, true);
					assert.strictEqual(currentReload.settled, false);
					assert.deepStrictEqual(commitResults, []);
				} else if (boundary === 'disposal') {
					panel.dispose();
					await request;
					assert.strictEqual(currentReload.settled, false);
					assert.strictEqual(ackSettled, false);
				} else if (boundary === 'mutable source drift') {
					currentText = initialText.replace('print Synthetic=0', 'print Synthetic=1');
					sourceVersion++;
					ownerClock = 20_000;
					assert.notStrictEqual(document.getText(), initialText);
					assert.strictEqual(document.version, 2);
					assert.strictEqual(document.isDirty, true);
				} else if (boundary === 'source read throw') sourceReadThrows = 1;
				releaseAdmission();
				await ack;
				if (boundary === 'mutable source drift') {
					await waitForCondition(() => projections.length === 2, 'a genuine buffer drift may use one current-source follow-up', 750);
					assert.strictEqual(reloads[1].deadline, 31_000, 'source follow-up must not reset the native owner deadline');
					assert.strictEqual(projections[1].state.sections[0].query, 'print Synthetic=1');
					assert.strictEqual(projections[1].state.sections[0].resultJson, savedResult);
					ownerClock = 31_000;
					assert.strictEqual(reloads[1].session.hasPendingReloadRequest(reloads[1].requestId), false);
				}
				await request;
				assert.strictEqual(requestSettled, true);
				assert.strictEqual(currentReload.session.hasPendingReloadRequest(currentReload.requestId), false);
				const accepted = boundary === 'positive claim controls' || boundary === 'arrival retry deadline';
				assert.strictEqual(currentReload.settled, accepted);
				const exception = boundary === 'source read throw' || boundary === 'commit throw';
				assert.deepStrictEqual(commitResults, exception ? [] : [accepted]);
				assert.deepStrictEqual(commitFailures.map(error => (error as Error).message), exception
					? [boundary === 'source read throw' ? 'Controlled native source read failure.' : 'Controlled native canonical commit failure.']
					: []);
				assert.strictEqual(sourceReadFaults, boundary === 'source read throw' ? 1 : 0);
				assert.strictEqual(commitFaults, boundary === 'commit throw' ? 1 : 0);
				assert.strictEqual(projections.length, boundary === 'mutable source drift' || boundary === 'arrival retry deadline' ? 2 : 1,
					'only a valid current-source transition or arrival retry may start another native projection');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), accepted);
				const acceptedClaims = claims.filter(claim => claim.accepted).length;
				await Promise.resolve(receive(acknowledgement));
				assert.strictEqual(claims.filter(claim => claim.accepted).length, acceptedClaims, 'late ACK must be inert after exact waiter retirement');
				assert.strictEqual(admissionCalls, 1);
				assert.strictEqual(posted.filter(message => message.type === 'requestToolState').length, 0,
					'background owner validation must have no public snapshot observer');
				assert.strictEqual(document.getText(), currentText);
				assert.strictEqual(document.version, boundary === 'mutable source drift' ? 2 : 1);
				assert.strictEqual(document.isDirty, boundary === 'mutable source drift');
				assert.strictEqual(JSON.parse(document.getText()).state.sections[0].resultJson, savedResult);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
				console.log('[tests/integration/kqlxMarkdownOwnership.test.ts:native ACK owner]', JSON.stringify({
					boundary, deadline: reloads[0].deadline, claims, admissionCalls, commitResults,
					reloads: reloads.map(reload => ({ requestId: reload.requestId, deadline: reload.deadline, settled: reload.settled })),
					projections: projections.length, documentVersion: document.version, dirty: document.isDirty,
				}));
			} finally {
				sourceReadThrows = 0;
				ownerClock = Math.max(ownerClock, ...reloads.map(reload => reload.deadline));
				for (const reload of reloads) reload.session.hasPendingReloadRequest(reload.requestId);
				releaseAdmission();
				panel.dispose();
				await ack;
				await request;
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				for (const subscription of subscriptions) subscription.dispose();
				CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
				CompatSidecarSession.prototype.claimReloadRequest = originalClaim;
				QueryEditorProvider.prototype.commitKustoSourceAdmissionFresh = originalCommit;
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				if (originalClock) Object.defineProperty(performance, 'now', originalClock);
				else delete (performance as unknown as { now?: () => number }).now;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	}

	test('cold readiness starts the native reload lease only after a 5200 ms dispatcher ACK', async function () {
		this.timeout(15_000);
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSetInbound = MainWebviewStartupGateway.prototype.setInboundHandler;
		const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cold-start-native-'));
		const filePath = path.join(tmpDir, 'cold.kqlx');
		const uri = vscode.Uri.file(filePath);
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot: { retained: true }, state: { sections: [
				{ id: 'query_cold', type: 'query', query: 'print Synthetic=0' },
			] },
		}, null, 2) + '\n';
		const posted: any[] = [];
		const reloadLeases: Array<{ requestId: string; startedAt: number; timeoutMs: number }> = [];
		const disposeHandlers: Array<() => void> = [];
		const subscriptions: vscode.Disposable[] = [];
		let gateway: MainWebviewStartupGateway<unknown> | undefined;
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		let document: vscode.TextDocument | undefined;
		let request: Promise<unknown> | undefined;
		let adapterState = JSON.parse(initialText).state;
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			MainWebviewStartupGateway.prototype.setInboundHandler = function (handler) {
				gateway = this;
				return originalSetInbound.call(this, handler);
			};
			CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
				const reload = originalCreateReload.call(this, timeoutMs, options);
				reloadLeases.push({ requestId: reload.requestId, startedAt: Date.now(), timeoutMs: timeoutMs ?? 5_000 });
				return reload;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			document = await vscode.workspace.openTextDocument(uri);
			assert.strictEqual(liveDocuments.register(document), false);
			const initialVersion = document.version;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receive?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							await Promise.resolve(receive?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration, editRevision: 1,
								state: adapterState,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			deferMainWebviewReadyForTest(panel);
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(gateway);
			assert.ok(receive);
			const readiness = gateway.beginDispatcherRevalidation();
			const probe = posted.at(-1);
			assert.strictEqual(probe?.type, 'mainWebviewDispatcherProbe');
			request = Promise.resolve(receive({ type: 'requestDocument' }));
			await new Promise<void>(resolve => setTimeout(resolve, 5_200));
			assert.strictEqual(reloadLeases.length, 0,
				'the native five-second reload lease must not run while cold delivery is unavailable');
			assert.strictEqual(projection, undefined);
			const readyAt = Date.now();
			await Promise.resolve(receive({
				type: 'mainWebviewDispatcherReady', runtimeId: 'native-cold-runtime', probeId: probe.probeId,
			}));
			assert.strictEqual(await readiness, true);
			await request;
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
			const acceptedProjection = projection as {
				reloadRequestId: string; sourceGeneration: number; state: { sections: Array<{ query: string }> };
			} | undefined;
			assert.ok(acceptedProjection);
			assert.strictEqual(reloadLeases.length, 1, 'one cold projection must not become a replayed reload');
			assert.ok(reloadLeases[0].startedAt >= readyAt);
			assert.strictEqual(reloadLeases[0].timeoutMs, 5_000);
			assert.strictEqual(acceptedProjection.reloadRequestId, reloadLeases[0].requestId);
			assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, 1);
			assert.strictEqual(acceptedProjection.state.sections[0].query, 'print Synthetic=0');
			assert.strictEqual(document.version, initialVersion);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(document.getText(), initialText);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);

			adapterState = JSON.parse(initialText).state;
			adapterState.sections[0].query = 'print Synthetic=1';
			await Promise.resolve(receive({
				type: 'persistDocument', snapshotId: 'kw-cold-start-authored', editRevision: 1,
				sourceGeneration: acceptedProjection.sourceGeneration, state: adapterState,
			}));
			assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'kw-cold-start-authored'));
			assert.strictEqual(JSON.parse(document.getText()).state.sections[0].query, 'print Synthetic=1');
			assert.strictEqual(document.isDirty, true);
			await document.save();
			assert.strictEqual(document.isDirty, false);
			const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			assert.strictEqual(saved.state.sections[0].query, 'print Synthetic=1');
			assert.deepStrictEqual(saved.futureRoot, { retained: true });
		} finally {
			for (const dispose of disposeHandlers.splice(0)) dispose();
			await request?.catch(() => undefined);
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const subscription of subscriptions) subscription.dispose();
			MainWebviewStartupGateway.prototype.setInboundHandler = originalSetInbound;
			CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			if (document?.isDirty) await document.save();
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('queued native projection starts the reload lease only at physical delivery', async function () {
		this.timeout(15_000);
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalSetInbound = MainWebviewStartupGateway.prototype.setInboundHandler;
		const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-queued-native-projection-'));
		const filePath = path.join(tmpDir, 'queued.kqlx');
		const uri = vscode.Uri.file(filePath);
		const initialText = JSON.stringify({
			futureRoot: { retained: true }, kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_queued', type: 'query', query: 'print Synthetic=0' },
			] },
		}, null, 2) + '\n';
		const authoredText = initialText.replace('print Synthetic=0', 'print Synthetic=1');
		const posted: any[] = [];
		const reloadLeases: Array<{ requestId: string; startedAt: number; timeoutMs: number }> = [];
		const disposeHandlers: Array<() => void> = [];
		const subscriptions: vscode.Disposable[] = [];
		let markTransportStarted!: () => void;
		let releaseTransport!: () => void;
		const transportStarted = new Promise<void>(resolve => { markTransportStarted = resolve; });
		const transportGate = new Promise<void>(resolve => { releaseTransport = resolve; });
		let gateway: MainWebviewStartupGateway<unknown> | undefined;
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		let document: vscode.TextDocument | undefined;
		let readiness: Promise<unknown> | undefined;
		let request: Promise<unknown> | undefined;
		let adapterState = JSON.parse(initialText).state;
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			MainWebviewStartupGateway.prototype.setInboundHandler = function (handler) {
				gateway = this;
				return originalSetInbound.call(this, handler);
			};
			CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
				const reload = originalCreateReload.call(this, timeoutMs, options);
				reloadLeases.push({ requestId: reload.requestId, startedAt: Date.now(), timeoutMs: timeoutMs ?? 5_000 });
				return reload;
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			document = await vscode.workspace.openTextDocument(uri);
			assert.strictEqual(liveDocuments.register(document), false);
			const initialVersion = document.version;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'persistenceMode') {
							markTransportStarted();
							await transportGate;
						}
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receive?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							await Promise.resolve(receive?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								sourceGeneration: projection.sourceGeneration, editRevision: 1, state: adapterState,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			deferMainWebviewReadyForTest(panel);
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(gateway);
			assert.ok(receive);
			assert.strictEqual(gateway.isDispatcherReady, false);
			readiness = Promise.resolve(receive({
				type: 'mainWebviewDispatcherReady', runtimeId: 'native-queued-runtime',
			}));
			await transportStarted;
			request = Promise.resolve(receive({ type: 'requestDocument' }));
			await new Promise<void>(resolve => setTimeout(resolve, 5_200));
			assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, 0);
			assert.strictEqual(reloadLeases.length, 0,
				'the native reload lease must not run behind a blocked physical transport head');
			const releasedAt = Date.now();
			releaseTransport();
			await readiness;
			await request;
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
			assert.strictEqual(reloadLeases.length, 1);
			assert.ok(reloadLeases[0].startedAt >= releasedAt);
			assert.strictEqual(reloadLeases[0].timeoutMs, 5_000);
			assert.strictEqual(projection.reloadRequestId, reloadLeases[0].requestId);
			assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, 1);
			assert.strictEqual(document.version, initialVersion);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(document.getText(), initialText);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);

			adapterState = JSON.parse(initialText).state;
			adapterState.sections[0].query = 'print Synthetic=1';
			await Promise.resolve(receive({
				type: 'persistDocument', snapshotId: 'queued-native-authored', editRevision: 1,
				sourceGeneration: projection.sourceGeneration, state: adapterState,
			}));
			assert.ok(posted.some(message => message?.type === 'persistDocumentAck'
				&& message.snapshotId === 'queued-native-authored'));
			assert.strictEqual(document.getText(), authoredText);
			assert.strictEqual(document.isDirty, true);
			await document.save();
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(document.getText(), authoredText);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), authoredText);
		} finally {
			releaseTransport();
			for (const dispose of disposeHandlers.splice(0)) dispose();
			await readiness?.catch(() => undefined);
			await request?.catch(() => undefined);
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const subscription of subscriptions) subscription.dispose();
			MainWebviewStartupGateway.prototype.setInboundHandler = originalSetInbound;
			CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			if (document?.isDirty) await document.save();
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const transition of ['source bytes', 'source version ABA', 'malformed source', 'unsafe linked query'] as const) {
		test(`queued native projection fences ${transition} at physical delivery`, async function () {
			this.timeout(10_000);
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalPostProjection = MainWebviewStartupGateway.prototype.postDocumentProjection;
			const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-queued-native-fence-'));
			const filePath = path.join(tmpDir, 'queued.kqlx');
			const uri = vscode.Uri.file(filePath);
			const initialText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'query_queued', type: 'query', query: 'print Synthetic=0' },
				] },
			}, null, 2) + '\n';
			const newerText = initialText.replace('print Synthetic=0', 'print Synthetic=1');
			const unsafeText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'query_queued', type: 'query', query: '', linkedQueryPath: 'queued.kqlx' },
				] },
			}, null, 2) + '\n';
			const posted: any[] = [];
			const preparations: number[] = [];
			const reloadLeases: Array<{ requestId: string; startedAt: number; timeoutMs: number }> = [];
			const disposeHandlers: Array<() => void> = [];
			const subscriptions: vscode.Disposable[] = [];
			let markTransportStarted!: () => void;
			let releaseTransport!: () => void;
			let markProjectionQueued!: () => void;
			const transportStarted = new Promise<void>(resolve => { markTransportStarted = resolve; });
			const transportGate = new Promise<void>(resolve => { releaseTransport = resolve; });
			const projectionQueued = new Promise<void>(resolve => { markProjectionQueued = resolve; });
			let receive: ((message: any) => unknown) | undefined;
			let projection: any;
			let document: vscode.TextDocument | undefined;
			let readiness: Promise<unknown> | undefined;
			let request: Promise<unknown> | undefined;
			try {
				fs.writeFileSync(filePath, initialText, 'utf8');
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
				MainWebviewStartupGateway.prototype.postDocumentProjection = function (options) {
					const index = preparations.push(0) - 1;
					markProjectionQueued();
					return originalPostProjection.call(this, {
						preflight: options.preflight,
						prepare: () => { preparations[index]++; return options.prepare(); },
					});
				};
				CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
					const reload = originalCreateReload.call(this, timeoutMs, options);
					reloadLeases.push({ requestId: reload.requestId, startedAt: Date.now(), timeoutMs: timeoutMs ?? 5_000 });
					return reload;
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				document = await vscode.workspace.openTextDocument(uri);
				assert.strictEqual(liveDocuments.register(document), false);
				const initialVersion = document.version;
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type === 'persistenceMode') {
								markTransportStarted();
								await transportGate;
							}
							if (message?.type === 'documentData') projection = message;
							if (message?.reloadRequestId) await Promise.resolve(receive?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
							}));
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receive = wrapDocumentViewTestReceiver(handler, () => projection);
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				deferMainWebviewReadyForTest(panel);
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receive);
				readiness = Promise.resolve(receive({ type: 'mainWebviewDispatcherReady', runtimeId: 'native-queued-fence-runtime' }));
				await transportStarted;
				const replaceSource = async (text: string) => {
					const edit = new vscode.WorkspaceEdit();
					edit.replace(uri, new vscode.Range(document!.positionAt(0), document!.positionAt(document!.getText().length)), text);
					assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
				};
				const errorBranch = transition === 'malformed source' || transition === 'unsafe linked query';
				if (errorBranch) await replaceSource(transition === 'malformed source' ? '{ malformed' : unsafeText);
				request = Promise.resolve(receive({ type: 'requestDocument' }));
				await projectionQueued;
				if (!errorBranch) {
					await replaceSource(newerText);
					if (transition === 'source version ABA') await replaceSource(initialText);
				}
				const sourceText = document.getText();
				const sourceVersion = document.version;
				assert.ok(sourceVersion > initialVersion);
				assert.strictEqual(preparations[0], 0);
				assert.strictEqual(reloadLeases.length, 0);
				assert.strictEqual(posted.some(message => message?.type === 'documentData'), false);
				const releasedAt = Date.now();
				releaseTransport();
				await readiness;
				await request;
				assert.strictEqual(preparations[0], errorBranch ? 1 : 0,
					'a stale queued native candidate must never invoke its projection factory, including same-byte ABA');
				if (!projection) await Promise.resolve(receive({ type: 'requestDocument' }));
				assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, 1);
				assert.strictEqual(reloadLeases.length, 1);
				assert.strictEqual(reloadLeases[0].timeoutMs, 5_000);
				assert.ok(reloadLeases[0].startedAt >= releasedAt);
				assert.strictEqual(projection.reloadRequestId, reloadLeases[0].requestId);
				assert.strictEqual(projection.ok, !errorBranch);
				if (errorBranch) {
					assert.match(projection.error, transition === 'unsafe linked query' ? /linked query/i : /JSON|Unexpected|property|valid/i);
				} else {
					assert.ok(projection.sourceGeneration > 1);
					assert.strictEqual(projection.state.sections[0].query,
						transition === 'source version ABA' ? 'print Synthetic=0' : 'print Synthetic=1');
				}
				assert.strictEqual(document.version, sourceVersion);
				assert.strictEqual(document.getText(), sourceText);
				assert.strictEqual(document.isDirty, true);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
			} finally {
				releaseTransport();
				for (const dispose of disposeHandlers.splice(0)) dispose();
				await readiness?.catch(() => undefined);
				await request?.catch(() => undefined);
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				for (const subscription of subscriptions) subscription.dispose();
				MainWebviewStartupGateway.prototype.postDocumentProjection = originalPostProjection;
				CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				if (document?.isDirty) await document.save();
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});
	}

	for (const failure of ['undefined factory', 'throwing factory', 'failed canonical admission'] as const) {
		test(`queued native projection rejects ${failure} without leaking reload or Kusto source admission`, async () => {
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalPostProjection = MainWebviewStartupGateway.prototype.postDocumentProjection;
			const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-projection-failure-'));
			const filePath = path.join(tmpDir, 'failure.kqlx');
			const uri = vscode.Uri.file(filePath);
			const initialText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'query_failed', type: 'query', query: 'print Synthetic=0' },
				] },
			}, null, 2) + '\n';
			const registry = new KustoResultPersistenceRegistry();
			const admissions: Array<{ discarded: boolean; commit(): unknown }> = [];
			const reloads: Array<{ session: CompatSidecarSession; requestId: string }> = [];
			const posted: any[] = [];
			const disposeHandlers: Array<() => void> = [];
			const subscriptions: vscode.Disposable[] = [];
			let gateway: MainWebviewStartupGateway<unknown> | undefined;
			let receive: ((message: any) => unknown) | undefined;
			let restoreSourcePreparation: (() => void) | undefined;
			let factoryCalls = 0;
			try {
				fs.writeFileSync(filePath, initialText, 'utf8');
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
				MainWebviewStartupGateway.prototype.postDocumentProjection = function (options) {
					gateway = this;
					return originalPostProjection.call(this, {
						...options,
						preflight: options.preflight,
						prepare: () => {
							factoryCalls++;
							if (failure === 'undefined factory') return undefined;
							const prepared = options.prepare();
							assert.ok(prepared);
							if (failure === 'throwing factory') throw new Error('Native projection factory failed.');
							return { message: { ...(prepared.message as Record<string, unknown>), sourceGeneration: -1 } };
						},
					});
				};
				CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
					const reload = originalCreateReload.call(this, timeoutMs, options);
					reloads.push({ session: this, requestId: reload.requestId });
					return reload;
				};
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(), undefined, registry,
				) as KqlxEditorProvider;
				const document = await vscode.workspace.openTextDocument(uri);
				assert.strictEqual(liveDocuments.register(document), false);
				const initialVersion = document.version;
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => { posted.push(message); return true; },
						onDidReceiveMessage: (handler: any) => { receive = handler; return { dispose() {} }; },
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				const owner = registry.get(normalizeWorkbenchUriKey(uri));
				assert.ok(owner);
				const originalPrepare = owner.prepareCanonicalSource;
				owner.prepareCanonicalSource = (...args) => {
					const admission = originalPrepare.bind(owner)(...args);
					if (!admission) return admission;
					const receipt = { discarded: false, commit: () => admission.commit() };
					admissions.push(receipt);
					return { ...admission, discard: () => { receipt.discarded = true; admission.discard(); } };
				};
				restoreSourcePreparation = () => { owner.prepareCanonicalSource = originalPrepare; };
				assert.ok(receive);
				const requestedAt = Date.now();
				await Promise.resolve(receive({ type: 'requestDocument' }));
				assert.ok(Date.now() - requestedAt < 1_000, 'rejected preparation must not await an uncreated or five-second reload');
				assert.strictEqual(factoryCalls, 1, 'a failed factory or outbound admission must not replay');
				assert.strictEqual(admissions.length, failure === 'undefined factory' ? 0 : 1);
				assert.strictEqual(reloads.length, failure === 'undefined factory' ? 0 : 1);
				for (const admission of admissions) {
					assert.strictEqual(admission.discarded, true);
					assert.strictEqual(admission.commit(), false, 'a discarded canonical source must not activate later');
				}
				for (const reload of reloads) assert.strictEqual(reload.session.hasPendingReloadRequest(reload.requestId), false);
				assert.strictEqual(posted.some(message => message?.type === 'documentData'), false);
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
				assert.ok(gateway);
				assert.strictEqual(await gateway.postMessage({ type: 'afterRejectedProjection' }), true);
				assert.strictEqual(posted.at(-1)?.type, 'afterRejectedProjection');
				assert.strictEqual(document.version, initialVersion);
				assert.strictEqual(document.isDirty, false);
				assert.strictEqual(document.getText(), initialText);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
			} finally {
				for (const dispose of disposeHandlers.splice(0)) dispose();
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				for (const subscription of subscriptions) subscription.dispose();
				restoreSourcePreparation?.();
				MainWebviewStartupGateway.prototype.postDocumentProjection = originalPostProjection;
				CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});
	}

	test('queued session projection rechecks locked disk authority before creating its reload', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalPostProjection = MainWebviewStartupGateway.prototype.postDocumentProjection;
		const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-queued-session-projection-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const uri = vscode.Uri.file(filePath);
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_session', type: 'query', query: 'print Synthetic=0' },
			] },
		}, null, 2) + '\n';
		const newerText = initialText.replace('print Synthetic=0', 'print Synthetic=1');
		const posted: any[] = [];
		const preparations: number[] = [];
		const disposeHandlers: Array<() => void> = [];
		const subscriptions: vscode.Disposable[] = [];
		let markTransportStarted!: () => void;
		let releaseTransport!: () => void;
		let markProjectionQueued!: () => void;
		let markPreflightStarted!: () => void;
		let markWriteLockHeld!: () => void;
		let releaseWriteLock!: () => void;
		const transportStarted = new Promise<void>(resolve => { markTransportStarted = resolve; });
		const transportGate = new Promise<void>(resolve => { releaseTransport = resolve; });
		const projectionQueued = new Promise<void>(resolve => { markProjectionQueued = resolve; });
		const preflightStarted = new Promise<void>(resolve => { markPreflightStarted = resolve; });
		const writeLockHeld = new Promise<void>(resolve => { markWriteLockHeld = resolve; });
		const writeGate = new Promise<void>(resolve => { releaseWriteLock = resolve; });
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		let readiness: Promise<unknown> | undefined;
		let request: Promise<unknown> | undefined;
		let writer: Promise<void> | undefined;
		let firstPreflight: Promise<boolean> | undefined;
		let reloadLeases = 0;
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			MainWebviewStartupGateway.prototype.postDocumentProjection = function (options) {
				const index = preparations.push(0) - 1;
				markProjectionQueued();
				return originalPostProjection.call(this, {
					preflight: () => {
						const result = options.preflight();
						if (index === 0) {
							assert.ok(result instanceof Promise, 'the session send must perform an asynchronous locked fresh read');
							firstPreflight = Promise.resolve(result);
							markPreflightStarted();
						}
						return result;
					},
					prepare: () => { preparations[index]++; return options.prepare(); },
				});
			};
			CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
				reloadLeases++;
				return originalCreateReload.call(this, timeoutMs, options);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(tmpDir), extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = await vscode.workspace.openTextDocument(uri);
			assert.strictEqual(liveDocuments.register(document), false);
			const initialVersion = document.version;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'persistenceMode') { markTransportStarted(); await transportGate; }
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) await Promise.resolve(receive?.({
							type: 'documentReloadResult', requestId: message.reloadRequestId, applied: true, editRevision: 0,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			deferMainWebviewReadyForTest(panel);
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(receive);
			readiness = Promise.resolve(receive({ type: 'mainWebviewDispatcherReady', runtimeId: 'native-queued-session-runtime' }));
			await transportStarted;
			request = Promise.resolve(receive({ type: 'requestDocument' }));
			await projectionQueued;
			writer = withKqlxDocumentWriteLock(uri, async () => {
				markWriteLockHeld();
				await writeGate;
				fs.writeFileSync(filePath, newerText, 'utf8');
			});
			await writeLockHeld;
			releaseTransport();
			await preflightStarted;
			assert.strictEqual(document.version, initialVersion);
			assert.strictEqual(document.getText(), initialText);
			assert.strictEqual(reloadLeases, 0);
			assert.strictEqual(preparations[0], 0);
			assert.strictEqual(posted.some(message => message?.type === 'documentData'), false);
			releaseWriteLock();
			await writer;
			assert.strictEqual(await firstPreflight, false, 'the queued session candidate must see the newer locked disk bytes');
			await readiness;
			await request;
			assert.strictEqual(preparations[0], 0, 'a stale session source cannot materialize or start a reload');
			if (!projection) await Promise.resolve(receive({ type: 'requestDocument' }));
			assert.strictEqual(projection?.ok, true);
			assert.ok(projection.sourceGeneration > 1);
			assert.strictEqual(projection.state.sections[0].query, 'print Synthetic=1');
			assert.ok(preparations.every(count => count <= 1), 'one queued candidate must not replay its factory');
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), newerText);
		} finally {
			releaseTransport();
			releaseWriteLock();
			await writer?.catch(() => undefined);
			for (const dispose of disposeHandlers.splice(0)) dispose();
			await readiness?.catch(() => undefined);
			await request?.catch(() => undefined);
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const subscription of subscriptions) subscription.dispose();
			MainWebviewStartupGateway.prototype.postDocumentProjection = originalPostProjection;
			CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	for (const transition of ['source bytes', 'source version', 'disposal', 'cold expiry', 'native Save'] as const) {
		test(`cold readiness fences native ${transition}`, async function () {
			this.timeout(10_000);
			const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
			const originalWait = MainWebviewStartupGateway.prototype.waitForDispatcherReady;
			const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
			const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
			const originalSetTimeout = global.setTimeout;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cold-start-fence-'));
			const filePath = path.join(tmpDir, 'fenced.kqlx');
			const uri = vscode.Uri.file(filePath);
			const initialText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'query_cold', type: 'query', query: 'print Synthetic=0' },
					{ id: 'markdown_cold', type: 'markdown', text: 'Retained cold notes' },
				] },
			}, null, 2) + '\n';
			const newerText = initialText.replace('print Synthetic=0', 'print Synthetic=1');
			const posted: any[] = [];
			const disposeHandlers: Array<() => void> = [];
			const subscriptions: vscode.Disposable[] = [];
			let markWaiting!: () => void;
			const waiting = new Promise<void>(resolve => { markWaiting = resolve; });
			let gateway: MainWebviewStartupGateway<unknown> | undefined;
			let receive: ((message: any) => unknown) | undefined;
			let willSave: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
			let projection: any;
			let document: vscode.TextDocument | undefined;
			let request: Promise<unknown> | undefined;
			let expireColdWait: (() => void) | undefined;
			let coldTimers = 0;
			let reloadLeases = 0;
			let saveDeadline: ReturnType<typeof setTimeout> | undefined;
			try {
				fs.writeFileSync(filePath, initialText, 'utf8');
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
				MainWebviewStartupGateway.prototype.waitForDispatcherReady = function () {
					gateway = this;
					const readiness = originalWait.call(this);
					markWaiting();
					return readiness;
				};
				CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
					reloadLeases++;
					return originalCreateReload.call(this, timeoutMs, options);
				};
				if (transition === 'cold expiry') {
					global.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
						const handle = originalSetTimeout(callback, delay, ...args);
						if (delay === 30_000) {
							coldTimers++;
							expireColdWait = () => callback(...args);
						}
						return handle;
					}) as typeof setTimeout;
				}
				if (transition === 'native Save') {
					(vscode.workspace as any).onWillSaveTextDocument = (handler: typeof willSave) => {
						willSave = handler;
						return { dispose() {} };
					};
				}
				const provider = new (KqlxEditorProvider as any)(
					{
						subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
						globalState: { get: () => undefined, update: async () => undefined },
						globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
						extensionMode: vscode.ExtensionMode.Test,
					} as any,
					vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(),
				) as KqlxEditorProvider;
				document = await vscode.workspace.openTextDocument(uri);
				assert.strictEqual(liveDocuments.register(document), false);
				const initialVersion = document.version;
				const panel = {
					webview: {
						options: {},
						postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type === 'documentData') projection = message;
							if (message?.reloadRequestId) {
								await Promise.resolve(receive?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: true, editRevision: 0,
								}));
							}
							return true;
						},
						onDidReceiveMessage: (handler: any) => {
							receive = wrapDocumentViewTestReceiver(handler, () => projection);
							return { dispose() {} };
						},
					},
					onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
				} as any;
				deferMainWebviewReadyForTest(panel);
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				assert.ok(receive);
				request = Promise.resolve(receive({ type: 'requestDocument' }));
				await waiting;
				assert.ok(gateway);
				assert.strictEqual(gateway.isDispatcherReady, false);
				assert.strictEqual(reloadLeases, 0);
				assert.strictEqual(posted.some(message => message?.type === 'documentData'), false);

				if (transition === 'disposal' || transition === 'cold expiry') {
					let lateReady: Record<string, unknown> = { type: 'mainWebviewDispatcherReady', runtimeId: 'late-runtime' };
					if (transition === 'disposal') {
						for (const dispose of disposeHandlers.splice(0)) dispose();
					} else {
						const readiness = gateway.beginDispatcherRevalidation();
						const probe = posted.at(-1);
						assert.strictEqual(probe?.type, 'mainWebviewDispatcherProbe');
						lateReady = { ...lateReady, probeId: probe.probeId };
						assert.ok(expireColdWait);
						expireColdWait();
						assert.strictEqual(await readiness, false);
						assert.strictEqual(coldTimers, 1, 'native recovery must not renew the cold allowance');
					}
					await request;
					await Promise.resolve(receive(lateReady));
					assert.strictEqual(await gateway.waitForDispatcherReady(), false);
					assert.strictEqual(reloadLeases, 0);
					assert.strictEqual(posted.some(message => message?.type === 'documentData'), false);
					assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), false);
					assert.strictEqual(document.version, initialVersion);
					assert.strictEqual(document.isDirty, false);
					assert.strictEqual(document.getText(), initialText);
					assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
					return;
				}

				const replaceSource = async (text: string) => {
					const edit = new vscode.WorkspaceEdit();
					const currentText = document!.getText();
					edit.replace(uri, new vscode.Range(document!.positionAt(0), document!.positionAt(currentText.length)), text);
					assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
				};
				await replaceSource(newerText);
				if (transition === 'source version') await replaceSource(initialText);
				const currentText = document.getText();
				const currentVersion = document.version;
				assert.ok(currentVersion > initialVersion);
				assert.strictEqual(document.isDirty, true);
				if (transition === 'native Save') {
					assert.ok(willSave);
					let preparation: Promise<vscode.TextEdit[]> | undefined;
					willSave({
						document,
						waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { preparation = Promise.resolve(thenable); },
					} as vscode.TextDocumentWillSaveEvent);
					assert.ok(preparation);
					const outcome = await Promise.race([
						preparation.then(() => ({ kind: 'applied' as const }), error => ({ kind: 'rejected' as const, error })),
						new Promise<{ kind: 'timed-out' }>(resolve => {
							saveDeadline = setTimeout(() => resolve({ kind: 'timed-out' }), 1_000);
						}),
					]);
					assert.strictEqual(outcome.kind, 'rejected', 'native Save must not wait for the thirty-second cold allowance');
					assert.ok(outcome.kind === 'rejected');
					assert.match(String(outcome.error), /has not accepted its initial notebook projection/);
					assert.strictEqual(reloadLeases, 0);
					assert.strictEqual(posted.some(message => message?.type === 'requestFinalPersist'), false);
				}
				await Promise.resolve(receive({ type: 'mainWebviewDispatcherReady', runtimeId: 'native-initial-runtime' }));
				await request;
				await waitForCondition(() => projection?.ok === true,
					'the latest source must obtain one native projection after cold readiness');
				assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 1_000, panel), true);
				assert.strictEqual(reloadLeases, 1);
				assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, 1);
				assert.ok(projection.sourceGeneration > 1, 'a stale byte/version candidate must not activate');
				assert.strictEqual(projection.state.sections[0].query,
					transition === 'source version' ? 'print Synthetic=0' : 'print Synthetic=1');
				assert.strictEqual(document.version, currentVersion);
				assert.strictEqual(document.getText(), currentText);
				assert.strictEqual(document.isDirty, true);
				assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
			} finally {
				if (saveDeadline) clearTimeout(saveDeadline);
				for (const dispose of disposeHandlers.splice(0)) dispose();
				await request?.catch(() => undefined);
				await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
				for (const subscription of subscriptions) subscription.dispose();
				MainWebviewStartupGateway.prototype.waitForDispatcherReady = originalWait;
				CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
				global.setTimeout = originalSetTimeout;
				(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
				if (document?.isDirty) await document.save();
				try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
			}
		});
	}

	test('cold readiness rechecks the dispatcher before native reload delivery', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalWait = MainWebviewStartupGateway.prototype.waitForDispatcherReady;
		const originalCreateReload = CompatSidecarSession.prototype.createReloadRequest;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cold-start-handoff-'));
		const filePath = path.join(tmpDir, 'handoff.kqlx');
		const uri = vscode.Uri.file(filePath);
		const initialText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_cold', type: 'query', query: 'print Synthetic=0' },
			] },
		}, null, 2) + '\n';
		const posted: any[] = [];
		const disposeHandlers: Array<() => void> = [];
		const subscriptions: vscode.Disposable[] = [];
		let gateway: MainWebviewStartupGateway<unknown> | undefined;
		let receive: ((message: any) => unknown) | undefined;
		let projection: any;
		let request: Promise<unknown> | undefined;
		let revalidation: Promise<boolean> | undefined;
		let readinessCalls = 0;
		let reloadLeases = 0;
		try {
			fs.writeFileSync(filePath, initialText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
			MainWebviewStartupGateway.prototype.waitForDispatcherReady = function () {
				gateway = this;
				readinessCalls++;
				return originalWait.call(this).then(ready => {
					if (ready && !revalidation) revalidation = this.beginDispatcherRevalidation();
					return ready;
				});
			};
			CompatSidecarSession.prototype.createReloadRequest = function (timeoutMs, options) {
				reloadLeases++;
				return originalCreateReload.call(this, timeoutMs, options);
			};
			const provider = new (KqlxEditorProvider as any)(
				{
					subscriptions, workspaceState: { get: () => undefined, update: async () => undefined },
					globalState: { get: () => undefined, update: async () => undefined },
					globalStorageUri: vscode.Uri.file(path.join(tmpDir, 'global-storage')),
					extensionMode: vscode.ExtensionMode.Test,
				} as any,
				vscode.Uri.file(path.resolve(__dirname, '../../..')), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = await vscode.workspace.openTextDocument(uri);
			assert.strictEqual(liveDocuments.register(document), false);
			const initialVersion = document.version;
			const panel = {
				webview: {
					options: {},
					postMessage: async (message: any) => {
						posted.push(message);
						if (message?.type === 'documentData') projection = message;
						if (message?.reloadRequestId) {
							await Promise.resolve(receive?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: 0,
							}));
						}
						return true;
					},
					onDidReceiveMessage: (handler: any) => {
						receive = wrapDocumentViewTestReceiver(handler, () => projection);
						return { dispose() {} };
					},
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(receive);
			request = Promise.resolve(receive({ type: 'requestDocument' }));
			await waitForCondition(() => reloadLeases > 0 || readinessCalls > 1,
				'native preparation must either expose the stale lease or wait for current dispatcher readiness');
			assert.ok(gateway);
			assert.ok(revalidation);
			assert.strictEqual(gateway.isDispatcherReady, false);
			assert.strictEqual(reloadLeases, 0, 'a dispatcher lost during preparation must not start the ACK lease');
			assert.strictEqual(posted.some(message => message?.type === 'documentData'), false);
			const probe = posted.find(message => message?.type === 'mainWebviewDispatcherProbe');
			assert.ok(probe);
			await Promise.resolve(receive({
				type: 'mainWebviewDispatcherReady', runtimeId: 'native-handoff-runtime', probeId: probe.probeId,
			}));
			assert.strictEqual(await revalidation, true);
			await request;
			assert.strictEqual(await KqlxEditorProvider.waitForOpenEditorInitialized(uri, 0, panel), true);
			assert.strictEqual(reloadLeases, 1);
			assert.strictEqual(posted.filter(message => message?.type === 'documentData').length, 1);
			assert.strictEqual(document.version, initialVersion);
			assert.strictEqual(document.isDirty, false);
			assert.strictEqual(document.getText(), initialText);
			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), initialText);
		} finally {
			for (const dispose of disposeHandlers.splice(0)) dispose();
			await request?.catch(() => undefined);
			await KqlxEditorProvider.waitForOpenEditorsClosed(uri, 2_000);
			for (const subscription of subscriptions) subscription.dispose();
			MainWebviewStartupGateway.prototype.waitForDispatcherReady = originalWait;
			CompatSidecarSession.prototype.createReloadRequest = originalCreateReload;
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});
});
