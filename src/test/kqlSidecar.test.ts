import * as assert from 'assert';
import * as vscode from 'vscode';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { KqlCompatEditorProvider } from '../kqlCompatEditorProvider';
import { KqlxEditorProvider } from '../kqlxEditorProvider';
import { QueryEditorProvider } from '../queryEditorProvider';

type DisposableLike = { dispose(): void };

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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{} as any
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

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sidecar-'));
		const kqlPath = path.join(tmpDir, 'test.kql');
		const kqlxPath = path.join(tmpDir, 'test.kql.json');


		try {
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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{} as any
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

			const newSidecarText = fs.readFileSync(kqlxPath, 'utf8');
			assert.ok(newSidecarText.includes('"linkedQueryPath"'));
			assert.ok(!newSidecarText.includes('"query":'), 'expected no inline query text in sidecar');
			assert.ok(newSidecarText.includes('"markdown"'));
		} finally {
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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{} as any
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

			await Promise.resolve(receiveHandler!({ type: 'requestUpgradeToKqlx', addKind: 'chart' }));

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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{} as any
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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{ getConnections: () => [], addConnection: async () => undefined } as any
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
});
