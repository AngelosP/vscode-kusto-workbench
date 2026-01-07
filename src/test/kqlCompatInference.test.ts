import * as assert from 'assert';
import * as vscode from 'vscode';

import { KqlCompatEditorProvider } from '../kqlCompatEditorProvider';
import { QueryEditorProvider } from '../queryEditorProvider';

type DisposableLike = { dispose(): void };

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
				return { clusterUrl: 'https://cluster.example.kusto.windows.net', database: 'MyDb' };
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

			const extensionUri = vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench');

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				extensionUri,
				{} as any // ConnectionManager not needed for this test (webview init is stubbed)
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
					return true;
				},
				onDidReceiveMessage: (handler: any) => {
					receiveHandler = handler;
					return { dispose() {} } as DisposableLike;
				}
			} as any;

			const webviewPanel: vscode.WebviewPanel = {
				webview
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
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitializeWebviewPanel;
			(QueryEditorProvider as any).prototype.inferClusterDatabaseForKqlQuery = originalInfer;
			(QueryEditorProvider as any).prototype.handleWebviewMessage = originalHandle;
		}
	});
});
