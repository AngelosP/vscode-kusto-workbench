import * as assert from 'assert';
import * as vscode from 'vscode';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { KqlCompatEditorProvider } from '../../src/host/kqlCompatEditorProvider';
import { KqlxEditorProvider } from '../../src/host/kqlxEditorProvider';
import { MdCompatEditorProvider } from '../../src/host/mdCompatEditorProvider';
import { QueryEditorProvider } from '../../src/host/queryEditorProvider';
import { KustoAuthPreferenceService } from '../../src/host/kustoAuthPreferenceService';
import { stringifyKqlxFile } from '../../src/host/kqlxFormat';
import { SqlCompatEditorProvider } from '../../src/host/sqlCompatEditorProvider';
import { CompatSidecarStore, readCompatSidecarSnapshot } from '../../src/host/compatSidecarStore';
import { CompatSidecarSession } from '../../src/host/compatSidecarSession';
import {
	adaptMainWebviewStartupTestPanel,
	deferMainWebviewReadyForTest,
} from './mainWebviewStartupTestAdapter';

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
	) {
		return publish(await (this as any).sanitizeSqlLeaveNoTraceStateFresh(state));
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
	const trackWorkspaceEvent = (register: (...args: any[]) => vscode.Disposable) => (...args: any[]) => {
		const subscription = register.apply(vscode.workspace, args);
		workspaceSubscriptions.push(subscription);
		return subscription;
	};

	suiteSetup(() => {
		(KqlxEditorProvider as any).prototype.resolveCustomTextEditor = function (
			this: KqlxEditorProvider,
			document: vscode.TextDocument,
			panel: vscode.WebviewPanel,
			token: vscode.CancellationToken,
		) {
			adaptMainWebviewStartupTestPanel(panel);
			adaptKqlxDocumentViewTestPanel(panel);
			return originalResolveKqlxEditor.call(this, document, panel, token);
		};
		(KqlCompatEditorProvider as any).prototype.resolveCustomTextEditor = function (
			this: KqlCompatEditorProvider,
			document: vscode.TextDocument,
			panel: vscode.WebviewPanel,
			token: vscode.CancellationToken,
		) {
			adaptMainWebviewStartupTestPanel(panel);
			return originalResolveKqlCompatEditor.call(this, document, panel, token);
		};
		(SqlCompatEditorProvider as any).prototype.resolveCustomTextEditor = function (
			this: SqlCompatEditorProvider,
			document: vscode.TextDocument,
			panel: vscode.WebviewPanel,
			token: vscode.CancellationToken,
		) {
			adaptMainWebviewStartupTestPanel(panel);
			return originalResolveSqlCompatEditor.call(this, document, panel, token);
		};
		(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
			// no-op
		};
		(QueryEditorProvider as any).prototype.handleWebviewMessage = async () => {
			// no-op
		};
		(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = async () => undefined;
		(vscode.workspace as any).onDidChangeTextDocument = trackWorkspaceEvent(originalOnDidChangeTextDocument as any);
		(vscode.workspace as any).onWillSaveTextDocument = trackWorkspaceEvent(originalOnWillSaveTextDocument as any);
		(vscode.workspace as any).onDidSaveTextDocument = trackWorkspaceEvent(originalOnDidSaveTextDocument as any);
	});

	teardown(() => {
		for (const subscription of workspaceSubscriptions.splice(0)) {
			try { subscription.dispose(); } catch { /* ignore */ }
		}
	});

	suiteTeardown(() => {
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
				const documentData = posted.filter(message => message?.type === 'documentData').at(-1);
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
				const acceptedSidecarText = fs.readFileSync(sidecarPath, 'utf8');
				applyEditCalls = 0;
				const snapshotId = `idless-forged-${index}`;
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', snapshotId, editRevision: 1,
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

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub({ getConnections: () => [selectedConnection] }),
				sqlWorkbenchStub()
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

			await Promise.resolve(
				receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument',
					state: {
						sections: [
							{
								type: 'query',
								id: 'q1',
								favoritesMode: true,
								query: 'StormEvents | take 1',
								clusterUrl: selectedClusterUrl,
								connectionIdHint: selectedConnection.id,
								database: selectedDatabase,
								resultJson,
								kustoAccountPartition: accountPartition,
								kustoLeaveNoTraceRevision: 0,
							}
						]
					}
				}, { replaceExistingId: true }))
			);

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

	test('upgrading to sidecar right after execution preserves results (state included in upgrade request)', async () => {
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

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub({ getConnections: () => [selectedConnection] }),
				sqlWorkbenchStub()
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

			await Promise.resolve(
				receiveHandler!({
					type: 'requestUpgradeToKqlx',
					addKind: 'chart',
					editRevision: 0,
					state: {
						sections: [
							{
								type: 'query',
								id: 'q1',
								query: 'StormEvents | take 1',
								clusterUrl: selectedClusterUrl,
								connectionIdHint: selectedConnection.id,
								database: selectedDatabase,
								resultJson,
								kustoAccountPartition: accountPartition,
								kustoLeaveNoTraceRevision: 0,
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(notebookDocument, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'StormEvents\n| take 5' },
				] },
			}));
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'StormEvents\r\n| take 5');
			assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.fsPath === linkedPath));

			for (const count of [6, 7]) {
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', state: { sections: [
						{ id: 'query_1', type: 'query', query: `StormEvents\n| take ${count}` },
					] },
				}));
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
			const document = {
				uri: vscode.Uri.file(kqlxPath),
				getText: () => kqlxText,
				eol: vscode.EndOfLine.LF,
			} as any;
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

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument',
				state: { sections: [
					{ id: 'query_other', type: 'query', query: 'print other = 99' },
					{ id: 'query_linked', type: 'query', query: 'StormEvents | take 23' },
				] },
			}));

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
				type: 'persistDocument',
				state: { sections: [
					{ id: 'query_other', type: 'query', query: 'print other = 100' },
					{ id: 'query_linked', type: 'query', query: 'StormEvents | take 31' },
				] },
			}));
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

	test('missing linked query cannot overwrite a file that appears before reload', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-missing-link-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'recovered.kql');
		const documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'recovered.kql' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor({
				uri: vscode.Uri.file(filePath), getText: () => documentText, eol: vscode.EndOfLine.LF,
			} as any, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			fs.writeFileSync(linkedPath, 'RECOVERED_SENTINEL', 'utf8');

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument',
				state: { sections: [{ id: 'query_1', type: 'query', query: 'not allowed' }] },
			}));

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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [{ id: 'query_1', type: 'query', query: 'STALE_WRITE' }] },
			}));

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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

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
				type: 'persistDocument', state: { sections: [
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
			await Promise.race([
				Promise.resolve(receiveHandler!({
					type: 'persistDocument', state: { sections: [
						{ id: 'query_1', type: 'query', query: 'NEW_WRITE' },
					] },
				})),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('new-target linked persist did not settle')), 2_000)),
			]);
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

	test('stale linked rollback never overwrites a same-path physical replacement', async () => {
		const originalApplyEdit = vscode.workspace.applyEdit;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-stale-rollback-retarget-'));
		const notebookPath = path.join(tmpDir, 'notebook.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const displacedPath = path.join(tmpDir, 'linked-original.kql');
		let notebookText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
		] } }, null, 2) + '\n';
		let receiveHandler: ((message: any) => unknown) | undefined;
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
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
			const stalePersist = Promise.resolve(receiveHandler!({ type: 'persistDocument', state: { sections: [{ id: 'query_1', type: 'query', query: 'STALE' }] } }));
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
		let notebookText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let receiveHandler: ((message: any) => unknown) | undefined;
		try {
			fs.writeFileSync(notebookPath, notebookText, 'utf8');
			fs.writeFileSync(linkedPath, 'BASELINE', 'utf8');
			(vscode.window as any).showErrorMessage = async () => undefined;
			const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
			(vscode.workspace as any).onWillSaveTextDocument = (handler: any) => {
				willSaveHandler = handler;
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
					uri: vscode.Uri.file(notebookPath), getText: () => notebookText, eol: vscode.EndOfLine.LF,
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
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				assert.ok(willSaveHandler);
				let waited: Promise<unknown> | undefined;
				willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
				await assert.rejects(waited!, /Cannot save a linked-query notebook without its final editor snapshot/);
				assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'BASELINE');
			} finally {
				(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			}
		} finally {
			(vscode.window as any).showErrorMessage = originalShowErrorMessage;
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
		let finalRequestId = '';
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
					options: {}, postMessage: async (message: any) => {
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							finalRequestId = String(message.requestId || '');
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
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'failed-retarget-open', sourceGeneration: message.sourceGeneration,
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
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'durable-retarget', editRevision: 1,
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
		});
		let linkedText = 'BASELINE';
		let linkedDirty = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let willSaveHandler: ((event: any) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let newerPersist: Promise<unknown> | undefined;
		let sourceGeneration = 0;
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
				if (entry?.[0]?.toString() !== linkedUri.toString() || typeof replacement !== 'string') return false;
				linkedText = replacement;
				linkedDirty = true;
				if (replacement === 'CANDIDATE' && !newerPersist) {
					newerPersist = Promise.resolve().then(() => receiveHandler!({
						type: 'persistDocument', state: { sections: [
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
			await newerPersist;
			const committedNotebookText = notebookEdits[0]?.newText ?? notebookText;
			fs.writeFileSync(notebookPath, committedNotebookText, 'utf8');
			await new Promise<void>(resolve => setTimeout(resolve, 1_100));
			await Promise.resolve(didSaveHandler!({ ...document, getText: () => committedNotebookText } as any));
			await new Promise<void>(resolve => setTimeout(resolve, 100));

			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'CANDIDATE');
			assert.strictEqual(linkedText, 'NEWER');
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
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'physical-retarget', editRevision: 1,
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
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'byte-cas', sourceGeneration: message.sourceGeneration, editRevision: 1,
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

	test('abandoned linked Save restores disk without overwriting a newer buffer', async () => {
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
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'abandoned-save', editRevision: 1,
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
			let waited: Promise<unknown> | undefined;
			willSaveHandler!({ document, waitUntil: (value: Promise<unknown>) => { waited = value; } });
			const notebookEdits = await waited as vscode.TextEdit[];
			const committedNotebookText = notebookEdits[0]?.newText ?? notebookText;
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'CANDIDATE');

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'NEWER' },
				] },
			}));
			assert.strictEqual(linkedText, 'NEWER');
			await waitForCondition(
				() => fs.readFileSync(linkedPath, 'utf8') === 'BASELINE' && linkedText === 'NEWER',
				'abandoned linked Save should restore disk without replacing the newer buffer',
				2_000,
			);

			await Promise.resolve(didSaveHandler!({ ...document, getText: () => committedNotebookText } as any));
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
			get isDirty() { return linkedDirty; }, save: async () => true,
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			applyCalls = 0;
			delayNextApply = true;
			const oldPersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print old = 1' },
				] },
			}));
			await Promise.race([
				applyStarted,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('old persistence edit did not start')), 2_000)),
			]);
			const baselinePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: baselineQuery },
				] },
			}));
			releaseApply();
			await Promise.race([
				Promise.all([oldPersist, baselinePersist]),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('serialized persistence requests did not settle')), 2_000)),
			]);

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
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler!({
								type: 'persistDocument', state, flush: true, reason: 'save',
								flushRequestId: message.requestId,
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
				type: 'persistDocument', state: changedState, reason: 'edit',
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
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('same-path linked target replacement after hydration is rejected before edit', async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-identity-replacement-'));
		const filePath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		const documentText = JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
			] },
		});
		let receiveHandler: ((message: any) => unknown) | undefined;
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor({
				uri: vscode.Uri.file(filePath), getText: () => documentText, eol: vscode.EndOfLine.LF,
			} as any, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			fs.unlinkSync(linkedPath);
			fs.writeFileSync(linkedPath, 'REPLACEMENT_SENTINEL', 'utf8');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'MUST_NOT_WRITE' },
				] },
			}));

			assert.strictEqual(fs.readFileSync(filePath, 'utf8'), documentText);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'REPLACEMENT_SENTINEL');
		} finally {
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
						if (message?.reloadRequestId) {
							await Promise.resolve(receiveHandler?.({
								type: 'documentReloadResult', requestId: message.reloadRequestId,
								applied: true, editRevision: Number(message.editRevision || 0),
							}));
						}
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'persistDocument', flushRequestId: message.requestId,
								snapshotId: 'dirty-alias-save', editRevision: 1,
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
			for (const openDocument of vscode.workspace.textDocuments.filter(candidate =>
				candidate.uri.toString() === vscode.Uri.file(openAliasPath).toString()
				|| candidate.uri.toString() === vscode.Uri.file(linkedPath).toString(),
			)) {
				await vscode.window.showTextDocument(openDocument, { preview: false });
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
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
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
						onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
					},
					onDidDispose: () => ({ dispose() {} }),
				} as any;
				await provider.resolveCustomTextEditor(document, panel, {} as any);
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
				gatePersists = true;
				const oldPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', state: { sections: [
						{ id: 'query_1', type: 'query', query: 'print old = 1' },
					] },
				}));
				await oldStarted;
				const newestPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', state: { sections: [
						{ id: 'query_1', type: 'query', query: 'print newest = 2' },
					] },
				}));
				releaseOld();
				await Promise.all([oldPersist, newestPersist]);
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
			posted.length = 0;
			applyCalls = 0;

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'rich-retry-1', editRevision: 1,
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
				type: 'persistDocument', snapshotId: 'rich-drift-2', editRevision: 2,
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			applyCalls = 0;
			gatePersist = true;
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
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

	test('pending external projection rejects an old rich snapshot before reload acknowledgement', async () => {
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
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
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
			await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
			await waitForCondition(() => !!pendingReload, 'external projection should wait for acknowledgement');
			assert.ok(invalidation.isSubscribed());
			invalidation.fire();
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
			await waitForCondition(
				() => JSON.parse(currentText).state.sections
					.find((section: any) => section.id === 'sql_protected')?.resultJson === undefined,
				'accepted pending projection should immediately consume its privacy obligation',
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

	test('rich privacy repair rebases after a newer source event during sanitation', async () => {
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
		let supersedeFirstDirectRepair = false;
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
					if (supersedeFirstDirectRepair) {
						supersedeFirstDirectRepair = false;
						currentText = wrap('DIRECT_LATEST', '{"rows":[[3]]}');
						void Promise.resolve(changeHandler?.({ document, contentChanges: [{}] } as any));
					}
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
			supersedeFirstDirectRepair = true;
			await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
			releaseSecondStalePublication();
			await waitForCondition(() => newerPublicationStarted, 'newer direct projection sanitation should start');
			await waitForCondition(
				() => JSON.parse(currentText).state.sections[0].query === 'DIRECT_LATEST'
					&& JSON.parse(currentText).state.sections[0].resultJson === undefined,
				'latest rapid direct source should survive and be privacy repaired',
			);
			assert.strictEqual(applyCalls, 1, 'only the latest-authority privacy repair may edit');
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'DIRECT_LATEST');
			assert.strictEqual(saveCalls, 0, 'stale privacy repair must not autosave the newer source');
		} finally {
			releaseSecondStalePublication();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChange;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich privacy repair rolls back when an external source wins during applyEdit', async () => {
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
				if (delayRepair && !replacement.includes('EXTERNAL_AUTHORITY')) {
					delayRepair = false;
					markRepairApplyStarted();
					await repairApplyGate;
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
			await waitForCondition(
				() => JSON.parse(currentText).state.sections[0].query === 'EXTERNAL_AUTHORITY',
				'external source should be restored after stale repair apply',
			);
			await waitForCondition(() => externalRepairPublished, 'newer-source privacy retry should publish');
			const queue = [...(provider as any).markdownDocumentQueues.values()][0];
			await queue.tail;
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

	test('privacy repair queues a Transformation command and preserves both mutations', async () => {
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
			assert.strictEqual(finalSections.find((section: any) => section.id === 'sql_1').resultJson, undefined);
			const commandResult = posted.find(message => message?.commandId === 'transform-during-privacy-repair');
			const queue = [...(provider as any).markdownDocumentQueues.values()][0];
			try {
				await waitForCondition(
					() => saveCalls === 1
						&& JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections
							.find((section: any) => section.id === 'sql_1').resultJson === undefined,
					'failed privacy save should sanitize disk before queue release',
				);
			} catch {
				assert.fail(JSON.stringify({
					saveCalls, commandSettled, dirty,
					pendingPrivacySave: !!queue?.pendingPrivacySave,
					privacyRepairNeeded: queue?.privacyRepairNeeded,
					latestMatchesCurrent: queue?.latestAuthority?.sourceText === currentText,
					currentResult: JSON.parse(currentText).state.sections.find((section: any) => section.id === 'sql_1').resultJson,
					diskResult: JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections.find((section: any) => section.id === 'sql_1').resultJson,
				}));
			}
			assert.strictEqual(commandSettledBeforeDurability, false);
			assert.strictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections
				.find((section: any) => section.id === 'sql_1').resultJson, undefined);
			if (commandResult?.ok !== true) {
				await Promise.resolve(receiveHandler!({
					type: 'markdownDocumentCommand', commandId: 'transform-after-privacy-replacement',
					sourceGeneration: projection.sourceGeneration,
					expectedDocumentRevision: projection.documentRevision,
					command: {
						type: 'patch', sectionId: 'transform_1',
						expectedSectionRevision: projection.sectionRevisions.transform_1,
						patch: { name: 'After' },
					},
				}));
				assert.strictEqual(
					posted.find(message => message?.commandId === 'transform-after-privacy-replacement')?.ok,
					true,
				);
			}
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

	test('failed privacy save sanitizes disk without auto-saving a safe replacement edit', async () => {
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
			try {
				await waitForCondition(
					() => saveCalls === 1 && dirty
						&& !JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections
							.find((section: any) => section.id === 'sql_1').resultJson,
					'safe replacement should stay dirty while disk is sanitized independently',
				);
			} catch {
				assert.fail(JSON.stringify({
					saveCalls, dirty,
					pendingPrivacySave: !!queue?.pendingPrivacySave,
					privacyRepairNeeded: queue?.privacyRepairNeeded,
					latestMatchesCurrent: queue?.latestAuthority?.sourceText === currentText,
					currentResult: JSON.parse(currentText).state.sections.find((section: any) => section.id === 'sql_1').resultJson,
					diskResult: JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections.find((section: any) => section.id === 'sql_1').resultJson,
				}));
			}
			assert.strictEqual(saveCalls, 1);
			assert.strictEqual(JSON.parse(currentText).state.sections
				.find((section: any) => section.id === 'sql_1').query, 'SELECT 2 AS safe_edit');
			await queue.pendingPrivacySave;
			await queue.tail;
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

	test('privacy repair during a held applied projection triggers a fresh projection before commands', async () => {
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
			await waitForCondition(() => !currentText.includes('PROTECTED'), 'privacy repair should change source bytes');
			const oldRequestId = heldReload.reloadRequestId;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: oldRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await heldRequest;
			await waitForCondition(
				() => projection?.reloadRequestId !== oldRequestId
					&& !projection?.state?.sections?.some((section: any) => section.resultJson === 'PROTECTED'),
				'stale applied projection should be replaced with repaired bytes',
			);

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
				delayStaleEdit = true;
				let stalePersistSettled = false;
				const stalePersist = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', editRevision: 1,
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
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', snapshotId: `direct-${index}`, editRevision: 1,
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
				const persist = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', snapshotId: `owned-${index}`, editRevision: 1,
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
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

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'STALE_CANDIDATE' },
				] },
			}));
			assert.strictEqual(linkedText, 'DIRECT_NEWER');
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
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [{ id: 'query_1', type: 'query', query: 'stale' }] },
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
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-session-write-failure-'));
		const storageUri = vscode.Uri.file(tmpDir);
		const sessionUri = vscode.Uri.joinPath(storageUri, 'session.kqlx');
		let storedText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [] } });
		fs.writeFileSync(sessionUri.fsPath, storedText, 'utf8');
		let failNextPublication = false;
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		try {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = async (
				state: any, publish: (value: any) => Promise<unknown>,
			) => {
				if (failNextPublication) { failNextPublication = false; throw new Error('blocked publication'); }
				return publish(state);
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
			failNextPublication = true;
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-failed', sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'print failed = 1' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.ok(!posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'session-failed'));

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'session-retry', sourceGeneration, editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'print retry = 2' }] },
			}));
			try {
				await waitForCondition(() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'session-retry'), 'session retry should acknowledge', 750);
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
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('rich session persists result replacement and removal before acknowledgement', async () => {
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
			posted.length = 0;

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'result-b', editRevision: 1,
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
				type: 'persistDocument', snapshotId: 'result-cleared', editRevision: 2,
				state: { sections: [{ id: 'sql_1', type: 'sql', query: 'select 1' }] },
			}));
			await waitForCondition(() => posted.some(message => message?.type === 'persistDocumentAck' && message.snapshotId === 'result-cleared'), 'result removal should acknowledge');
			assert.ok(!Object.prototype.hasOwnProperty.call(diskAtAck.get('result-cleared').state.sections[0], 'resultJson'));
			assert.ok(!Object.prototype.hasOwnProperty.call(diskAtAck.get('result-cleared').state.sections[0], 'resultArtifact'));
			currentText = fs.readFileSync(sessionPath, 'utf8');
			assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(currentText).state.sections[0], 'resultJson'));
		} finally {
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceState = originalSanitizeSync;
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('linked rich session saves linked bytes before acknowledging', async () => {
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-linked-session-durable-'));
		const sessionPath = path.join(tmpDir, 'session.kqlx');
		const linkedPath = path.join(tmpDir, 'linked.kql');
		let sessionText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
			{ id: 'query_1', type: 'query', linkedQueryPath: 'linked.kql' },
		] } });
		fs.writeFileSync(sessionPath, sessionText, 'utf8');
		fs.writeFileSync(linkedPath, 'BASELINE', 'utf8');
		let receiveHandler: ((message: any) => unknown) | undefined;
		let ackSawLinkedText = '';
		let conflictAcknowledged = false;
		const disposeHandlers: Array<() => void> = [];
		try {
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
				type: 'persistDocument', snapshotId: 'linked-session', editRevision: 1,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'DURABLE_LINKED' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 500));
			const liveLinkedDocument = vscode.workspace.textDocuments.find(candidate => candidate.uri.fsPath === linkedPath);
			assert.strictEqual(ackSawLinkedText, 'DURABLE_LINKED', `linked bytes should be durable before acknowledgement; linkedDisk=${fs.readFileSync(linkedPath, 'utf8')}; sessionDisk=${fs.readFileSync(sessionPath, 'utf8')}; linkedBuffer=${liveLinkedDocument?.getText() ?? '(missing)'}`);
			sessionText = fs.readFileSync(sessionPath, 'utf8');
			assert.strictEqual(JSON.parse(sessionText).state.sections[0].linkedQueryPath, 'linked.kql');

			const externalSession = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [{ id: 'external_1', type: 'query', query: 'EXTERNAL' }] },
			});
			fs.writeFileSync(sessionPath, externalSession, 'utf8');
			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', snapshotId: 'linked-session-conflict', editRevision: 2,
				state: { sections: [{ id: 'query_1', type: 'query', query: 'MUST_ROLLBACK' }] },
			}));
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.strictEqual(conflictAcknowledged, false);
			assert.strictEqual(fs.readFileSync(linkedPath, 'utf8'), 'DURABLE_LINKED');
			assert.strictEqual(fs.readFileSync(sessionPath, 'utf8'), externalSession);
		} finally {
			for (const dispose of disposeHandlers) dispose();
			await KqlxEditorProvider.waitForOpenEditorsClosed(vscode.Uri.file(sessionPath), 1_000);
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
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

	test('KQLX close bounds non-persistence handlers that do not settle', async () => {
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

	test('KQLX native Save followed by immediate close drains canonical public-row restoration', async () => {
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
		const disposeHandlers: Array<() => void> = [];
		let releaseCanonicalPublish!: () => void;
		const canonicalPublishGate = new Promise<void>(resolve => { releaseCanonicalPublish = resolve; });
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
				await canonicalPublishGate;
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
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'persistDocument', state,
								flush: true, reason: 'save', editRevision: 0,
								snapshotId: 'save-budget-snapshot', flushRequestId: message.requestId,
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
			assert.ok(willSaveHandler && didSaveHandler);
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
			assert.ok(!replacement.includes('PROTECTED_SQL_RESULT'));
			assert.ok(!replacement.includes('KEEP_KUSTO_RESULT'));
			assert.strictEqual(canonicalPublishCalls, 0);
			currentText = replacement;
			diskText = replacement;
			dirty = false;
			for (const dispose of disposeHandlers) dispose();
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 50),
				false,
				'immediate close must wait for onDidSave to queue canonical restoration',
			);
			await Promise.resolve(didSaveHandler!(document));
			await waitForCondition(() => canonicalPublishCalls === 1, 'canonical public-row admission should start');
			releaseCanonicalPublish();
			await waitForCondition(
				() => currentText.includes('KEEP_KUSTO_RESULT')
					&& diskText.includes('KEEP_KUSTO_RESULT'),
				'canonical public rows should be restored to the buffer and disk',
			);
			assert.strictEqual(
				await KqlxEditorProvider.waitForOpenEditorsClosed(document.uri, 1_000),
				true,
				'close finalization should complete after canonical restoration reaches disk',
			);
			assert.ok(!currentText.includes('PROTECTED_SQL_RESULT'));
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

	test('Kusto-only KQLX native Save is lock-free and strips embedded rows before completion', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSaveTextDocument = vscode.workspace.onDidSaveTextDocument;
		const originalPublish = (QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-kusto-save-lock-'));
		const filePath = path.join(tmpDir, 'kusto-save-lock.kqlx');
		const state = { sections: [{
			id: 'query_1', type: 'query', query: 'print value=1',
			clusterUrl: 'https://cluster.kusto.windows.net', connectionIdHint: 'kusto-1', database: 'Db',
			resultJson: 'KUSTO_RESULT',
		}] };
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state }, null, 2);
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let receiveHandler: ((message: any) => unknown) | undefined;
		let canonicalPublishCalls = 0;

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
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => text, eol: vscode.EndOfLine.LF, isDirty: true,
				positionAt: (_offset: number) => new vscode.Position(0, 0), save: async () => true,
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'requestFinalPersist') {
							void Promise.resolve().then(() => receiveHandler?.({
								type: 'persistDocument', state, flush: true, reason: 'save', editRevision: 0,
								snapshotId: 'kusto-save-lock', flushRequestId: message.requestId,
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
			assert.ok(willSaveHandler && didSaveHandler && receiveHandler);
			let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
			} as any);
			assert.ok(saveBarrier);
			const edits = await saveBarrier!;
			assert.strictEqual(edits.length, 1);
			assert.ok(!edits[0].newText.includes('KUSTO_RESULT'));
			assert.strictEqual(canonicalPublishCalls, 0);
			await Promise.resolve(didSaveHandler!(document));
		} finally {
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX controlled public-row restore rolls back when its observable save fails', async () => {
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
						if (message?.type === 'requestFinalPersist') void Promise.resolve().then(() => receiveHandler?.({
							type: 'persistDocument', state, flush: true, reason: 'save', editRevision: 0,
							snapshotId: 'restore-failure', flushRequestId: message.requestId,
						}));
						return true;
					},
					onDidReceiveMessage: (handler: (message: any) => unknown) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler && didSaveHandler);
			let barrier: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({ document, waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); } } as any);
			const edits = await barrier!;
			currentText = edits[0].newText;
			diskText = currentText;
			dirty = false;
			await Promise.resolve(didSaveHandler!(document));
			await waitForCondition(() => controlledSaveCalls === 1 && currentText === diskText, 'failed controlled save should roll back');
			assert.ok(!currentText.includes('PUBLIC_RESULT'));
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
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let didSaveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
		let receiveHandler: ((message: any) => unknown) | undefined;

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
				if (publishCalls === 1) await firstGate;
				return publish(value);
			};
			const provider = new (KqlxEditorProvider as any)(
				{ subscriptions: [], workspaceState: { get: () => undefined, update: async () => undefined }, globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: vscode.Uri.file(tmpDir) } as any,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'), connectionManagerStub(), sqlWorkbenchStub(),
			) as KqlxEditorProvider;
			const document = {
				uri: vscode.Uri.file(filePath), getText: () => currentText, get version() { return version; }, get isDirty() { return dirty; },
				eol: vscode.EndOfLine.LF, positionAt: (_offset: number) => new vscode.Position(0, 0),
				save: async () => {
					let nested: Promise<vscode.TextEdit[]> | undefined;
					willSaveHandler!({ document, waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { nested = Promise.resolve(thenable); } } as any);
					await nested; diskText = currentText; dirty = false; await Promise.resolve(didSaveHandler!(document)); return true;
				},
			} as any;
			const panel = {
				webview: {
					options: {}, postMessage: async (message: any) => {
						if (message?.type === 'requestFinalPersist') void Promise.resolve().then(() => receiveHandler?.({ type: 'persistDocument', state: requestedState, flush: true, reason: 'save', editRevision: 0, snapshotId: `overlap-${publishCalls}`, flushRequestId: message.requestId }));
						return true;
					},
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: () => ({ dispose() {} }),
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			assert.ok(willSaveHandler && didSaveHandler);
			const runNativeSave = async () => {
				let barrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({ document, waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); } } as any);
				const edits = await barrier!;
				if (edits[0]) { currentText = edits[0].newText; version++; }
				diskText = currentText; dirty = false; await Promise.resolve(didSaveHandler!(document));
			};
			await runNativeSave();
			requestedState = makeState('RESULT_TWO');
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
		let diskText = currentText;
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

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
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
				return publish(value);
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

			let barrier: Promise<vscode.TextEdit[]> | undefined;
			savingWillSaveHandler({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { barrier = Promise.resolve(thenable); },
			} as any);
			const edits = await barrier!;
			assert.strictEqual(edits.length, 1);
			currentText = edits[0].newText;
			version++;
			for (const changeHandler of canonicalChangeHandlers) {
				await Promise.resolve(changeHandler({ document, contentChanges: [{}] } as any));
			}
			diskText = currentText;
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
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFailClosed = originalFailClosed;
			(QueryEditorProvider as any).prototype.publishSqlLeaveNoTraceStateFresh = originalPublish;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSaveTextDocument;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSaveTextDocument;
			(vscode.workspace as any).onDidChangeTextDocument = originalOnDidChangeTextDocument;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('KQLX Save writes fail-closed text when the final webview snapshot is unavailable', async () => {
		const originalOnWillSaveTextDocument = vscode.workspace.onWillSaveTextDocument;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-save-unavailable-'));
		const filePath = path.join(tmpDir, 'save-unavailable.kqlx');
		let willSaveHandler: ((event: vscode.TextDocumentWillSaveEvent) => unknown) | undefined;
		let currentText = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', resultJson: 'PROTECTED_SQL_RESULT' },
				{ id: 'query_1', type: 'query', query: 'print 1', resultJson: 'KEEP_KUSTO_RESULT' },
			] },
		}, null, 2);
		const latestText = JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 2 AS latest_edit', resultJson: 'PROTECTED_SQL_RESULT' },
				{ id: 'query_1', type: 'query', query: 'print 1', resultJson: 'KEEP_KUSTO_RESULT' },
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
			assert.ok(!edits[0].newText.includes('PROTECTED_SQL_RESULT'));
			assert.ok(!edits[0].newText.includes('KEEP_KUSTO_RESULT'));
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
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async function (panel: vscode.WebviewPanel) {
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
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
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
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => state;
			(vscode.window as any).showWarningMessage = async () => 'Save';
			for (const [index, variant] of variants.entries()) {
				let markInitializeEntered!: () => void;
				let releaseInitialize!: () => void;
				const initializeEntered = new Promise<void>(resolve => { markInitializeEntered = resolve; });
				const initializeGate = new Promise<void>(resolve => { releaseInitialize = resolve; });
				(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
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
				type: 'persistDocument', reason: 'beforeunload', snapshotId: 'early-close', editRevision: 1,
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

	test('initial projections retry automatically when source changes during sanitation', async () => {
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
				const newQuery = variant.type === 'sql' ? 'select new' : 'print new = 2';
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
				const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
				const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (String(state.sections?.[0]?.query || '') === oldQuery) {
						markOldStarted();
						await oldGate;
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
				sourceText = wrap(newQuery);
				await Promise.resolve(changeHandler!({ document, contentChanges: [{}] } as any));
				releaseOld();
				await initialRequest;

				const projections = posted.filter(message => message?.type === 'documentData' && message.ok === true);
				assert.strictEqual(projections.length, 1, `${variant.extension} should publish exactly one initial projection`);
				assert.strictEqual(projections[0].state.sections[0].query, newQuery);
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

	test('rejected compatibility reload keeps the previous source generation blocked', async () => {
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
				let rejectReload = false;
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
				} as any;
				const panel = {
					webview: {
						options: {}, postMessage: async (message: any) => {
							posted.push(message);
							if (message?.type !== 'documentData') return true;
							if (rejectReload) return false;
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

				rejectReload = true;
				primaryText = variant.primaryType === 'sql' ? 'select external' : 'print external = 1';
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
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
			}
		} finally {
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
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'MUST_NOT_WRITE' },
				] },
			}));
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
				let sanitizeCalls = 0;
				let churn = true;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					sanitizeCalls++;
					if (churn) {
						sourceText = wrap(`revision ${sanitizeCalls}`);
						if (sanitizeCalls === 4) {
							churn = false;
							changeHandler?.({ document, contentChanges: [{}] } as any);
						}
					}
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
						options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler, posted),
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

				await waitForCondition(
					() => posted.some(message => message?.type === 'documentData' && message.ok === true),
					`${variant.extension} should recover from a change during the fourth attempt`,
				);
				assert.strictEqual(
					sanitizeCalls,
					variant.wrapped ? 6 : 5,
					`${variant.extension} should use one bounded follow-up projection`,
				);
				const projection = posted.find(message => message?.type === 'documentData' && message.ok === true);
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

				let releaseSanitize!: () => void;
				let markSanitizeStarted!: () => void;
				const sanitizeGate = new Promise<void>(resolve => { releaseSanitize = resolve; });
				const sanitizeStarted = new Promise<void>(resolve => { markSanitizeStarted = resolve; });
				let pauseExternalRepair = false;
				let receiveHandler: ((message: any) => unknown) | undefined;
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (pauseExternalRepair && JSON.stringify(state).includes('EXTERNAL_COMMITTED')) {
						pauseExternalRepair = false;
						markSanitizeStarted();
						await sanitizeGate;
					}
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
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('retained'), `${variant.extension} open must repair an unedited sidecar`);
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
				pauseExternalRepair = true;
				invalidation.fire();
				await sanitizeStarted;
				for (const dispose of disposeHandlers) dispose();
				await Promise.resolve();
				assert.strictEqual(invalidation.isDisposed(), false, `${variant.extension} cleanup must wait for the queued write`);

				releaseSanitize();
				await waitForCondition(
					() => {
						const text = fs.readFileSync(sidecarPath, 'utf8');
						return invalidation.isDisposed()
							&& text.includes('EXTERNAL_COMMITTED')
							&& !text.includes('retained');
					},
					`${variant.extension} close should drain the sanitized queued write`,
				);
				assert.strictEqual(invalidation.isDisposed(), true, `${variant.extension} close should dispose the invalidation subscription`);
				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes('EXTERNAL_COMMITTED'), `${variant.extension} must preserve newer committed sidecar content`);
				assert.ok(!finalText.includes('UNSAVED_DRAFT'), `${variant.extension} Discard must not write unsaved metadata`);
				assert.ok(!finalText.includes('retained'), `${variant.extension} sidecar must be sanitized before cleanup`);
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
			(vscode.window as any).showWarningMessage = originalShowWarningMessage;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('privacy repair rebases a dirty compatibility sidecar draft before close-time Save', async () => {
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
				let receiveHandler: ((message: any) => unknown) | undefined;
				const posted: any[] = [];
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => ({
					...state,
					sections: state.sections.map((section: any) => {
						if (!protectedNow || section.type !== 'sql') return section;
						const { result: _result, ...sanitized } = section;
						return sanitized;
					}),
				});

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
										{ type: 'markdown', text: 'DRAFT_TO_SAVE' },
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
				const acceptedFile = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
				posted.push({ type: 'documentData', ok: true, state: acceptedFile.state });
				await Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument',
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'DRAFT_TO_SAVE' },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				})));
				protectedNow = true;
				invalidation.fire();
				await waitForCondition(
					() => !fs.readFileSync(sidecarPath, 'utf8').includes('retained'),
					`${variant.extension} privacy repair should publish before close`,
				);
				for (const dispose of disposeHandlers) dispose();
				await waitForCondition(
					() => fs.readFileSync(sidecarPath, 'utf8').includes('DRAFT_TO_SAVE'),
					`${variant.extension} close should save the rebased draft`,
				);

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.strictEqual(invalidation.isDisposed(), true, `${variant.extension} close should dispose the invalidation subscription`);
				assert.ok(finalText.includes('DRAFT_TO_SAVE'), `${variant.extension} should save the rebased draft`);
				assert.ok(!finalText.includes('retained'), `${variant.extension} should keep protected SQL payload sanitized`);
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

	test('compatibility sidecar repair retries when an external write lands during sanitation', async () => {
		const invalidation = interceptSqlPersistenceInvalidation();
		const originalSanitize = (QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh;
		const restorePublisher = mirrorFreshSqlSanitizerIntoPublisher();
		const variants = [
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query', kind: 'kqlx' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql', kind: 'sqlx' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-external-race-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `external-race-${index}${variant.extension}`);
				const sidecarPath = `${sourcePath}.json`;
				const sidecar = (marker: string) => JSON.stringify({
					kind: variant.kind, version: 1,
					state: { sections: [
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: marker },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				});
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
				fs.writeFileSync(sidecarPath, sidecar('BASELINE_A'), 'utf8');

				let protectedNow = false;
				let protectedSanitizeCalls = 0;
				let markPaused!: () => void;
				let release!: () => void;
				const sanitizePaused = new Promise<void>(resolve => { markPaused = resolve; });
				const sanitizeGate = new Promise<void>(resolve => { release = resolve; });
				(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
					if (protectedNow) protectedSanitizeCalls += 1;
					if (protectedNow && protectedSanitizeCalls === 2 && JSON.stringify(state).includes('BASELINE_A')) {
						markPaused();
						await sanitizeGate;
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
				const document = {
					uri: vscode.Uri.file(sourcePath), getText: () => 'select 1', lineCount: 1,
					lineAt: () => ({ text: 'select 1' }), isDirty: false,
				} as any;
				let receiveHandler: ((message: any) => unknown) | undefined;
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
				protectedNow = true;
				invalidation.fire();
				await sanitizePaused;
				fs.writeFileSync(sidecarPath, sidecar('EXTERNAL_B'), 'utf8');
				release();
				await waitForCondition(() => {
					const text = fs.readFileSync(sidecarPath, 'utf8');
					return text.includes('EXTERNAL_B') && !text.includes('retained');
				}, `${variant.extension} repair should sanitize the newer external commit`);

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(finalText.includes('EXTERNAL_B'), `${variant.extension} repair must preserve the newer external commit`);
				assert.ok(!finalText.includes('BASELINE_A'), `${variant.extension} repair must not republish its stale baseline`);
				assert.ok(!finalText.includes('retained'), `${variant.extension} repair must sanitize the newer commit`);
			}
		} finally {
			restorePublisher();
			invalidation.restore();
			(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = originalSanitize;
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
				assert.ok(errors.some(message => message.includes('changed while it was being created')));
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
				const newerPersist = Promise.resolve(receiveHandler!(withProjectedCompatPrimary(posted, {
					type: 'persistDocument', sourceGeneration: activeSourceGeneration, editRevision: 2,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'PERSIST_REVISION_2' },
					] },
				})));
				release();
				await Promise.all([upgrade, newerPersist]);
				assert.ok(posted.some(message => message?.type === 'documentData'
					&& message.expectedEditRevision === 1), `${variant.extension} upgrade reload must remain bound to revision 1`);
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
				assert.ok(!adoptedText.includes('RETAINED_SECRET'), `${variant.extension} adoption must sanitize protected payloads`);

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
				assert.ok(!fs.readFileSync(sidecarPath, 'utf8').includes('RETAINED_SECRET'));

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
					if (protectedNow && protectedCalls === 2) {
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
				for (let attempt = 0; attempt < 50 && fs.readFileSync(sidecarPath, 'utf8').includes('RETAINED_SECRET'); attempt += 1) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
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
					(QueryEditorProvider as any).prototype.sanitizeSqlLeaveNoTraceStateFresh = async (state: any) => {
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
				let saveBarrier: Promise<vscode.TextEdit[]> | undefined;
				willSaveHandler!({
					document,
					waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { saveBarrier = Promise.resolve(thenable); },
				} as any);

				await assert.doesNotReject(saveBarrier!);
				assert.deepStrictEqual(await saveBarrier!, []);
				assert.deepStrictEqual(errors, []);
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
				for (let attempt = 0; attempt < 50 && !fs.readFileSync(sidecarPath, 'utf8').includes('FINAL_IN_TRANSIT'); attempt += 1) {
					await new Promise<void>(resolve => setImmediate(resolve));
				}
				assert.ok(fs.readFileSync(sidecarPath, 'utf8').includes('FINAL_IN_TRANSIT'));
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
					type: 'persistDocument', reason: 'beforeunload', snapshotId: 'rich-beforeunload', editRevision: 1,
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
					options: {}, postMessage: reloadAwarePostMessage(() => receiveHandler),
					onDidReceiveMessage: (handler: any) => { receiveHandler = handler; return { dispose() {} }; },
				},
				onDidDispose: (handler: () => void) => { disposeHandlers.push(handler); return { dispose() {} }; },
			} as any;
			await provider.resolveCustomTextEditor(document, panel, {} as any);
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			for (const dispose of disposeHandlers) dispose();
			await new Promise<void>(resolve => setTimeout(resolve, 600));

			await Promise.resolve(receiveHandler!({
				type: 'persistDocument', reason: 'beforeunload', snapshotId: 'expired-beforeunload', editRevision: 1,
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
