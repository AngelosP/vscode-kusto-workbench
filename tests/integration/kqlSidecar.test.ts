import * as assert from 'assert';
import * as vscode from 'vscode';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { KqlCompatEditorProvider } from '../../src/host/kqlCompatEditorProvider';
import { KqlxEditorProvider } from '../../src/host/kqlxEditorProvider';
import { MdCompatEditorProvider } from '../../src/host/mdCompatEditorProvider';
import { QueryEditorProvider } from '../../src/host/queryEditorProvider';

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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{} as any
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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{} as any
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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				{} as any
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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				connManager
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
			await connManager.setFileConnection(kqlPath, 'https://cluster-a.kusto.windows.net', 'DBA');
			await connManager.addConnection({ name: 'ClusterC', clusterUrl: 'https://cluster-c.kusto.windows.net' });
			const connC = connManager.getConnections().find(c => c.clusterUrl === 'https://cluster-c.kusto.windows.net')!;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				connManager
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
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				connManager
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
			await connManager.setFileConnection(kqlPath, 'https://cached-cluster.kusto.windows.net', 'CachedDB');

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
					vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
					connManager
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
					vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
					connManager
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
					vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
					connManager
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
			await connManager.setFileConnection(kqlPath, 'https://cluster-a.kusto.windows.net', 'DBA');
			await connManager.addConnection({ name: 'ClusterC', clusterUrl: 'https://cluster-c.kusto.windows.net' });
			const connC = connManager.getConnections().find(c => c.clusterUrl === 'https://cluster-c.kusto.windows.net')!;

			const provider = new (KqlCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
				connManager
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

			const provider = new (MdCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
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
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
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

			const provider = new (MdCompatEditorProvider as any)(
				fakeContext,
				vscode.Uri.file('C:/Users/angelpe/source/my-tools/vscode-kusto-workbench'),
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
				onDidDispose: () => ({ dispose() {} } as DisposableLike)
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
