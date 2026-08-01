import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

import { KqlCompatEditorProvider } from '../../src/host/kqlCompatEditorProvider';
import { QueryEditorProvider } from '../../src/host/queryEditorProvider';

type DisposableLike = { dispose(): void };

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
		client: {}, runtime: { onDidChangeProcessManager: () => ({ dispose() {} }) }, queryService: {},
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

suite('KQL compat editor - inferred cluster/db wiring', () => {
	test('includes inferred clusterUrl/database in documentData for .kql files', async () => {
		const originalInitializeWebviewPanel = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalInfer = (QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery;
		const originalHandle = (QueryEditorProvider as any).prototype.handleWebviewMessage;

		let receiveHandler: ((message: any) => unknown) | undefined;
		const posted: any[] = [];

		try {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => {
				// no-op for this regression test
			};
			(QueryEditorProvider as any).prototype.handleWebviewMessage = async () => {
				// no-op
			};
			(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = async (queryText: string) => {
				assert.ok(queryText.includes('MyTable'), 'expected query text to be passed to inference');
				return {
					clusterUrl: 'https://cluster.example.kusto.windows.net',
					database: 'MyDb',
					authorityId: 'resource.onmicrosoft.com',
					connectionIdHint: 'guest-connection',
				};
			};

			const fakeContext: vscode.ExtensionContext = {
				subscriptions: [],
				workspaceState: {
					get: () => undefined,
					update: async () => undefined
				} as any,
				globalState: {
					get: () => undefined,
					update: async () => undefined
				} as any
			} as any;

			const extensionUri = vscode.Uri.file(path.resolve(__dirname, '..', '..', '..'));
			const changeEmitter = new vscode.EventEmitter<unknown>();

			const sqlWorkbench = sqlWorkbenchStub();
			sqlWorkbench.refreshLeaveNoTracePolicy = async () => { throw new Error('corrupt SQL privacy state'); };
			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				extensionUri,
				{
					getConnections: () => [],
					onDidChangeConnections: changeEmitter.event,
				} as any,
				sqlWorkbench
			) as KqlCompatEditorProvider;

			const document: vscode.TextDocument = {
				uri: vscode.Uri.file('C:/tmp/test.kql'),
				getText: () => 'MyTable | take 5',
				lineCount: 1,
				lineAt: () => ({ text: 'MyTable | take 5' } as any)
			} as any;

			const webview: vscode.Webview = {
				options: {} as any,
				postMessage: async (msg: any) => {
					posted.push(msg);
					if (msg?.reloadRequestId) {
						await Promise.resolve(receiveHandler?.({
							type: 'documentReloadResult', requestId: msg.reloadRequestId,
							applied: true, editRevision: Number(msg.editRevision || 0),
						}));
					}
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

			assert.ok(receiveHandler, 'expected webview message handler to be registered');
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));

			const docMsg = posted.find((m) => m && m.type === 'documentData');
			assert.ok(docMsg, 'expected a documentData message to be posted');
			assert.ok(docMsg.state && Array.isArray(docMsg.state.sections), 'expected documentData.state.sections');
			assert.strictEqual(docMsg.state.sections[0].clusterUrl, 'https://cluster.example.kusto.windows.net');
			assert.strictEqual(docMsg.state.sections[0].database, 'MyDb');
			assert.strictEqual(docMsg.state.sections[0].authorityId, 'resource.onmicrosoft.com');
			assert.strictEqual(docMsg.state.sections[0].connectionIdHint, 'guest-connection');
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitializeWebviewPanel;
			(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = originalInfer;
			(QueryEditorProvider as any).prototype.handleWebviewMessage = originalHandle;
		}
	});
});
