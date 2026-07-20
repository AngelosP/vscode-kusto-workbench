import * as assert from 'assert';
import * as vscode from 'vscode';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { KqlCompatEditorProvider } from '../../src/host/kqlCompatEditorProvider';
import { KqlxEditorProvider } from '../../src/host/kqlxEditorProvider';
import { MdCompatEditorProvider } from '../../src/host/mdCompatEditorProvider';
import { QueryEditorProvider } from '../../src/host/queryEditorProvider';
import { SqlCompatEditorProvider } from '../../src/host/sqlCompatEditorProvider';

type DisposableLike = { dispose(): void };
function connectionManagerStub(overrides: Record<string, unknown> = {}) {
	const changeEmitter = new vscode.EventEmitter<unknown>();
	return {
		getConnections: () => [],
		addConnection: async () => undefined,
		onDidChangeConnections: changeEmitter.event,
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
	let disposed = false;
	prototype.initializeWebviewPanel = async function (this: QueryEditorProvider, ...args: any[]) {
		const result = await originalInitialize.apply(this, args);
		(this as any).onDidInvalidateSqlPersistence = (next: () => void) => {
			listener = next;
			disposed = false;
			return { dispose: () => { disposed = true; } };
		};
		return result;
	};
	return {
		fire: () => {
			if (!listener) throw new Error('SQL persistence invalidation listener was not registered.');
			listener();
		},
		isSubscribed: () => !!listener,
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
	const originalHandle = (QueryEditorProvider as any).prototype.handleWebviewMessage;
	const originalInfer = (QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery;

	suiteSetup(() => {
		(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
			// no-op
		};
		(QueryEditorProvider as any).prototype.handleWebviewMessage = async () => {
			// no-op
		};
		(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = async () => undefined;
	});

	suiteTeardown(() => {
		(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitializeWebviewPanel;
		(QueryEditorProvider as any).prototype.handleWebviewMessage = originalHandle;
		(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = originalInfer;
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

	test('persistDocument updates sidecar .kql.json without duplicating query', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		let onDidSaveHandler: ((doc: vscode.TextDocument) => unknown) | undefined;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');
		const kqlxPath = path.join(tmpDir, 'test.kql.json');


		const originalOnDidSave = (vscode.workspace as any).onDidSaveTextDocument;
		try {
			// Capture the save handler registered by the provider so we can simulate a save.
			(vscode.workspace as any).onDidSaveTextDocument = (handler: any) => {
				onDidSaveHandler = handler;
				return { dispose() {} } as DisposableLike;
			};

			fs.writeFileSync(kqlPath, 'StormEvents | take 1', 'utf8');
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
			await Promise.resolve(
				receiveHandler!({
					type: 'persistDocument',
					state: {
						sections: [
							{ type: 'query', query: 'StormEvents | take 2' },
							{ type: 'markdown', title: 'Notes', text: 'hello' }
						]
					}
				})
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

			const selectedClusterUrl = 'https://example.kusto.windows.net';
			const selectedDatabase = 'MyDb';
			const resultObj = { columns: [{ name: 'x', type: 'int' }], rows: [[1]] };
			const resultJson = JSON.stringify(resultObj);

			await Promise.resolve(
				receiveHandler!({
					type: 'persistDocument',
					state: {
						sections: [
							{
								type: 'query',
								id: 'q1',
								favoritesMode: true,
								query: 'StormEvents | take 1',
								clusterUrl: selectedClusterUrl,
								database: selectedDatabase,
								resultJson
							}
						]
					}
				})
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
			const selectedClusterUrl = 'https://example.kusto.windows.net';
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
								database: selectedDatabase,
								resultJson
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
				postMessage: async (msg: any) => { posted.push(msg); return true; },
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
				postMessage: async (msg: any) => { posted.push(msg); return true; },
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
				postMessage: async (msg: any) => { posted.push(msg); return true; },
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
				postMessage: async (msg: any) => {
					posted.push(msg);
					return true;
				},
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
		} finally {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('.kqlx requestDocument sent during webview initialization is replayed', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const previousInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kqlx-startup-'));
		const kqlxPath = path.join(tmpDir, 'startup.kqlx');
		const kqlxText = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{ type: 'query', id: 'query_startup', query: 'StartupTable | take 1' }
				]
			}
		}, null, 2);

		try {
			fs.writeFileSync(kqlxPath, kqlxText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
				assert.ok(receiveHandler, 'expected early webview message handler');
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			};

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

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(kqlxPath),
				getText: () => kqlxText,
				eol: vscode.EndOfLine.LF
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: async (msg: any) => {
					posted.push(msg);
					return true;
				},
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

			const docMsg = posted.find((m) => m && m.type === 'documentData' && m.ok === true);
			assert.ok(docMsg, 'expected queued requestDocument to produce documentData');
			assert.strictEqual(docMsg.state.sections[0].query, 'StartupTable | take 1');
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = previousInitialize;
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('.kql requestDocument sent during webview initialization is replayed', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const previousInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-kql-startup-'));
		const kqlPath = path.join(tmpDir, 'startup.kql');

		try {
			fs.writeFileSync(kqlPath, 'StartupTable | take 1', 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
				assert.ok(receiveHandler, 'expected early webview message handler');
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			};

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
				getText: () => 'StartupTable | take 1',
				lineCount: 1,
				lineAt: () => ({ text: 'StartupTable | take 1' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: async (msg: any) => {
					posted.push(msg);
					return true;
				},
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

			const docMsg = posted.find((m) => m && m.type === 'documentData' && m.ok === true);
			assert.ok(docMsg, 'expected queued requestDocument to produce documentData');
			assert.strictEqual(docMsg.compatibilityMode, true);
			assert.strictEqual(docMsg.documentKind, 'kql');
			assert.strictEqual(docMsg.state.sections[0].query, 'StartupTable | take 1');
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = previousInitialize;
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
		}
	});

	test('.sql requestDocument sent during webview initialization is replayed', async () => {
		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];
		const previousInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-startup-'));
		const sqlPath = path.join(tmpDir, 'startup.sql');

		try {
			fs.writeFileSync(sqlPath, 'select top 1 * from StartupTable', 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
				assert.ok(receiveHandler, 'expected early webview message handler');
				await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			};

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: { get: () => undefined, update: async () => undefined } as any,
				globalState: { get: () => undefined, update: async () => undefined } as any
			} as any;

			const provider = new (SqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/repo/vscode-kusto-workbench'),
				connectionManagerStub(),
				sqlWorkbenchStub()
			) as SqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file(sqlPath),
				getText: () => 'select top 1 * from StartupTable',
				lineCount: 1,
				lineAt: () => ({ text: 'select top 1 * from StartupTable' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: async (msg: any) => {
					posted.push(msg);
					return true;
				},
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

			const docMsg = posted.find((m) => m && m.type === 'documentData' && m.ok === true);
			assert.ok(docMsg, 'expected queued requestDocument to produce documentData');
			assert.strictEqual(docMsg.compatibilityMode, true);
			assert.strictEqual(docMsg.documentKind, 'sql');
			assert.strictEqual(docMsg.state.sections[0].query, 'select top 1 * from StartupTable');
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = previousInitialize;
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				// ignore
			}
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
					() => invalidation.isDisposed(),
					`${variant.extension} cleanup should run after the queued write`,
				);
				assert.strictEqual(invalidation.isDisposed(), true, `${variant.extension} cleanup should run after the queued write`);
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
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'persistDocument', editRevision: 0,
									snapshotId: `save-rebase-${index}`, flushRequestId: message.requestId,
									state: { sections: [
										{ type: variant.firstType, query: 'select 1' },
										{ type: 'markdown', text: 'DRAFT_TO_SAVE' },
										{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
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
				assert.ok(receiveHandler && invalidation.isSubscribed());
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument',
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'DRAFT_TO_SAVE' },
						{ type: 'sql', id: 'sql-sensitive', result: { columns: ['secret'], rows: [['retained']] } },
					] },
				}));
				protectedNow = true;
				invalidation.fire();
				await waitForCondition(
					() => !fs.readFileSync(sidecarPath, 'utf8').includes('retained'),
					`${variant.extension} privacy repair should publish before close`,
				);
				for (const dispose of disposeHandlers) dispose();
				await waitForCondition(
					() => invalidation.isDisposed(),
					`${variant.extension} close should finish after saving the rebased draft`,
				);

				const finalText = fs.readFileSync(sidecarPath, 'utf8');
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
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'documentReloadResult', requestId: message.reloadRequestId,
									applied: false, editRevision: 2,
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
				const upgrade = Promise.resolve(receiveHandler!({
					type: variant.requestType, addKind: 'markdown', editRevision: 1,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'UPGRADE_REVISION_1' },
					] },
				}));
				await paused;
				const newerPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 2,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'PERSIST_REVISION_2' },
					] },
				}));
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: marker },
						...(includeSecret ? [{ type: 'sql', id: 'sql-sensitive', resultJson: 'RETAINED_SECRET' }] : []),
					] },
				});

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
				fs.writeFileSync(sidecarPath, sidecar('ADOPTED_BASELINE', true), 'utf8');
				await Promise.resolve(receiveHandler!({ type: variant.requestType, addKind: 'markdown', editRevision: 0 }));
				const adoptedText = fs.readFileSync(sidecarPath, 'utf8');
				assert.ok(adoptedText.includes('ADOPTED_BASELINE'));
				assert.ok(!adoptedText.includes('RETAINED_SECRET'), `${variant.extension} adoption must sanitize protected payloads`);

				await Promise.resolve(receiveHandler!({
					type: 'persistDocument',
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'LOCAL_DRAFT' },
					] },
				}));
				const externalText = sidecar('EXTERNAL_NEWER');
				fs.writeFileSync(sidecarPath, externalText, 'utf8');
				await Promise.resolve(saveHandler!(document));

				assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), externalText, `${variant.extension} must preserve the newer external edit`);
				assert.ok(errors.some(message => message.includes('changed in another window')));
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
				assert.ok(finalText.includes('EXTERNAL_CLEAN + LOCAL_EDIT'));
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
						{ type: variant.firstType, query: 'select 1' },
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
						{ type: variant.firstType, query: 'select 1' },
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
				pause = true;
				const persist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'STALE_REVISION_1' },
					] },
				}));
				await paused;
				const currentPersist = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 2,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'REVISION_ONE' },
					] },
				}));
				await secondSanitation;
				const persistTwo = Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 2,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
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
							{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
											{ type: variant.firstType, query: 'select 1' },
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
							{ type: variant.firstType, query: 'select 1' },
							{ type: 'markdown', text: 'REVISION_ONE' },
						] },
					}));
					await paused;
					const persistTwo = Promise.resolve(receiveHandler!({
						type: 'persistDocument', editRevision: 2,
						state: { sections: [
							{ type: variant.firstType, query: 'select 1' },
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
										{ type: variant.firstType, query: 'select 1' },
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
						{ type: variant.firstType, query: 'select 1' },
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
			{ extension: '.kql', Provider: KqlCompatEditorProvider, firstType: 'query' },
			{ extension: '.sql', Provider: SqlCompatEditorProvider, firstType: 'sql' },
		] as const;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-correlated-failure-'));

		try {
			for (const [index, variant] of variants.entries()) {
				const sourcePath = path.join(tmpDir, `correlated-failure-${index}${variant.extension}`);
				fs.writeFileSync(sourcePath, 'select 1', 'utf8');
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
									void Promise.resolve().then(() => receiveHandler?.({
										type: 'persistDocument', editRevision: 1,
										snapshotId: 'failed-snapshot', flushRequestId: message.requestId,
										state: { sections: [
											{ type: variant.firstType, query: 'select 1' },
											{ type: 'markdown', text: 'FAIL_CORRELATED' },
										] },
									}));
								} else {
									void (async () => {
										const oldPersist = Promise.resolve(receiveHandler?.({
											type: 'persistDocument', editRevision: 2,
											snapshotId: 'old-snapshot', flushRequestId: message.requestId,
											state: { sections: [
												{ type: variant.firstType, query: 'select 1' },
												{ type: 'markdown', text: 'OLD_CORRELATED' },
											] },
										}));
										await oldEntered;
										const newerPersist = Promise.resolve(receiveHandler?.({
											type: 'persistDocument', editRevision: 3,
											state: { sections: [
												{ type: variant.firstType, query: 'select 1' },
												{ type: 'markdown', text: 'NEWER' },
											] },
										}));
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
							if (message?.type === 'requestFinalPersist') {
								void Promise.resolve().then(() => receiveHandler?.({
									type: 'persistDocument', editRevision: 1,
									snapshotId: `rejected-edit-${index}`, flushRequestId: message.requestId,
									state: { sections: [{ type: variant.firstType, query: 'select new' }] },
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				});
				fs.writeFileSync(sidecarPath, baseline, 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				let saveHandler: ((document: vscode.TextDocument) => unknown) | undefined;
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
				const repairedBaseline = fs.readFileSync(sidecarPath, 'utf8');
				await Promise.resolve(receiveHandler!({
					type: 'persistDocument', editRevision: 1,
					state: { sections: [
						{ type: variant.firstType, query: 'select 1' },
						{ type: 'markdown', text: 'RETRY_DRAFT' },
					] },
				}));
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
						{ type: variant.firstType, query: 'select 1' },
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
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
						{ type: variant.firstType, query: 'select 1' },
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
						{ type: variant.firstType, linkedQueryPath: path.basename(sourcePath) },
						{ type: 'markdown', text: 'BASELINE' },
					] },
				}), 'utf8');

				let receiveHandler: ((message: any) => unknown) | undefined;
				const disposeHandlers: Array<() => void> = [];
				let webviewDisposed = false;
				let postsAfterDispose = 0;
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
						options: {}, postMessage: async () => {
							if (webviewDisposed) {
								postsAfterDispose++;
								throw new Error('Webview is disposed');
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
				webviewDisposed = true;
				setTimeout(() => {
					void Promise.resolve(receiveHandler!({
						type: 'persistDocument', reason: 'beforeunload', editRevision: 1,
						state: { sections: [
							{ type: variant.firstType, query: 'select 1' },
							{ type: 'markdown', text: 'FINAL_ACTIVE_CLOSE' },
						] },
					}));
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
				postMessage: async (msg: any) => {
					posted.push(msg);
					return true;
				},
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
				postMessage: async (msg: any) => { posted.push(msg); return true; },
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
				postMessage: async () => true,
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
					postMessage: async (msg: any) => {
						posted.push(msg);
						return true;
					},
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
					postMessage: async (msg: any) => {
						posted.push(msg);
						return true;
					},
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
					postMessage: async () => true,
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
				postMessage: async (msg: any) => { posted.push(msg); return true; },
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
