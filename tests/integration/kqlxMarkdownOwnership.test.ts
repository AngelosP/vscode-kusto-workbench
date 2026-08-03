import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { CompatSidecarSession } from '../../src/host/compatSidecarSession';
import { KqlxEditorProvider } from '../../src/host/kqlxEditorProvider';
import { QueryEditorProvider } from '../../src/host/queryEditorProvider';

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

	test('Python-only Save before projection acknowledgement fails closed', async () => {
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
						if (message?.type === 'requestFinalPersist') {
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
				onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			const request = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!reloadRequestId, 'Python projection candidate should be posted', 1_000);
			assert.ok(willSaveHandler);
			let savePreparation: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { savePreparation = Promise.resolve(thenable); },
			} as any);
			assert.ok(savePreparation);
			let preparedText = currentText;
			try {
				const edits = await savePreparation!;
				if (edits.length > 0) preparedText = edits.at(-1)!.newText;
			} catch (error) {
				assert.match(error instanceof Error ? error.message : String(error), /projection was acknowledged/);
			}
			const prepared = JSON.parse(preparedText);
			assert.deepStrictEqual(prepared.state.sections, JSON.parse(currentText).state.sections);

			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await request;
			assert.strictEqual(JSON.parse(currentText).state.sections[0].code, 'print(1)');
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

	test('Chart-only Save before projection acknowledgement fails closed', async () => {
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
				onDidDispose: () => ({ dispose() {} }),
			} as any;

			await provider.resolveCustomTextEditor(document, panel, {} as any);
			const request = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !!reloadRequestId, 'Chart projection candidate should be posted', 1_000);
			assert.ok(willSaveHandler);
			let savePreparation: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { savePreparation = Promise.resolve(thenable); },
			} as any);
			assert.ok(savePreparation);
			let preparedText = currentText;
			const edits = await savePreparation!;
			if (edits.length > 0) preparedText = edits.at(-1)!.newText;
			assert.strictEqual(finalSnapshotRequests, 0);
			assert.deepStrictEqual(JSON.parse(preparedText).state.sections, JSON.parse(currentText).state.sections);
			assert.deepStrictEqual(JSON.parse(currentText).state.sections, JSON.parse(fs.readFileSync(filePath, 'utf8')).state.sections);

			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await request;
			assert.strictEqual(JSON.parse(currentText).state.sections[0].chartTitle, 'Owned chart');
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	});

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
			await Promise.resolve(second.receive({
				type: 'documentReloadResult', requestId: second.reloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
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

	test('Chart, Python, URL, and Markdown host commands survive stale DOM state, view recreation, and lossless save', async () => {
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
						id: 'future_opaque', type: 'future-section',
						payload: { keep: ['opaque', 42] },
					},
					{ id: 'devnotes_owner', type: 'devnotes', entries: [] },
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

			await firstView.dispose();

			const recreatedView = createPanel();
			await provider.resolveCustomTextEditor(document, recreatedView.panel, {} as vscode.CancellationToken);
			await recreatedView.receive({ type: 'requestDocument' });
			const recreatedProjection = recreatedView.posted.find(message => message?.type === 'documentData' && message.ok === true);
			assert.ok(recreatedProjection, 'recreated view must receive a projection');
			assert.strictEqual(recreatedProjection.documentRevision, 12);
			assert.deepStrictEqual(recreatedProjection.markdownSectionRevisions, { markdown_original: 1 });
			assert.deepStrictEqual(recreatedProjection.sectionRevisions, {
				markdown_original: 1, url_original: 1, python_original: 1, chart_original: 1,
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
				'markdown_original', 'url_original', 'python_original', 'chart_original', 'future_opaque', 'devnotes_owner',
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
			assert.deepStrictEqual(saved.state.sections[4], fixture.state.sections[4]);
			assert.strictEqual(saved.state.sections[5].entries[0].content, 'adapter-owned note');
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

	test('session close drains an admitted Markdown command after panel disposal', async () => {
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
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'session-close-command', sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_session',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_session,
					patch: { text: 'after close' },
				},
			}));
			for (const dispose of disposeHandlers) dispose();
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
			const survivingPersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print survives rejection = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'adapter markdown' },
				] },
			}));
			await survivingAdapterStarted;
			rejectNextReload = true;
			const rejectedReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await waitForCondition(() => !rejectNextReload, 'projection rejection should be delivered', 1_000);
			releaseSurvivingAdapter();
			await Promise.all([survivingPersist, rejectedReload]);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].query, 'print survives rejection = 1');
			const stalePersist = Promise.resolve(receiveHandler!({
				type: 'persistDocument', state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print stale = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'stale adapter markdown' },
				] },
			}));
			await adapterStarted;
			await Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
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

	test('projection activation retires an adapter lease acquired after reload starts', async () => {
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
		let markStaleApplyStarted!: () => void;
		let releaseStaleApply!: () => void;
		const candidatePosted = new Promise<void>(resolve => { markCandidatePosted = resolve; });
		const staleApplyStarted = new Promise<void>(resolve => { markStaleApplyStarted = resolve; });
		const staleApplyGate = new Promise<void>(resolve => { releaseStaleApply = resolve; });

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
					markStaleApplyStarted();
					await staleApplyGate;
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
				type: 'persistDocument', sourceGeneration: initialProjection.sourceGeneration,
				state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print stale adapter = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'stale adapter markdown' },
				] },
			}));
			await staleApplyStarted;
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: pendingReloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			let commandSettled = false;
			const command = Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'late-lease-command',
				sourceGeneration: latestProjection.sourceGeneration,
				expectedDocumentRevision: latestProjection.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: latestProjection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after reload' },
				},
			})).then(() => { commandSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(commandSettled, false, 'late stale adapter must physically settle before the command runs');
			releaseStaleApply();
			await Promise.all([stalePersist, command, reload]);
			assert.strictEqual(commandSettled, true);
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
			currentText = notebook('print source drift = 4', 'after reload');
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: pendingReloadRequestId,
				applied: true, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await driftReload;
			assert.strictEqual([...((provider as any).markdownDocuments.values())][0], activeOwner);
			await Promise.resolve(receiveHandler!({
				type: 'markdownDocumentCommand', commandId: 'post-drift-command',
				sourceGeneration: activeCommandResult.sourceGeneration,
				expectedDocumentRevision: activeCommandResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: activeCommandResult.projection.markdownSectionRevisions.markdown_1,
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
			CompatSidecarSession.prototype.createReloadRequest = function () {
				return originalCreateReloadRequest.call(this, 20);
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
				type: 'markdownDocumentCommand', commandId: 'post-expired-ack-command',
				sourceGeneration: postDriftResult.sourceGeneration,
				expectedDocumentRevision: postDriftResult.documentRevision,
				command: {
					type: 'patch', sectionId: 'markdown_1',
					expectedSectionRevision: postDriftResult.projection.markdownSectionRevisions.markdown_1,
					patch: { text: 'after expired acknowledgement' },
				},
			}));
			assert.ok(posted.some(message => message?.type === 'markdownDocumentCommandResult'
				&& message.commandId === 'post-expired-ack-command' && message.ok === true));
		} finally {
			releaseStaleApply?.();
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

	test('native Save fences a Markdown command still in transport', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
		const originalOnWillSave = vscode.workspace.onWillSaveTextDocument;
		const originalOnDidSave = vscode.workspace.onDidSaveTextDocument;
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
		let commandResult: any;
		let holdReloadAcknowledgement = false;
		let pendingReloadRequestId = '';
		let markPendingProjectionPosted!: () => void;
		const pendingProjectionPosted = new Promise<void>(resolve => { markPendingProjectionPosted = resolve; });
		let holdFinalPersist = false;
		let rejectNextBarrier = false;
		let raceCommandAfterBarrierResponse = false;
		let heldFinalPersistRequestId = '';
		let finalPersistRequestCount = 0;

		try {
			fs.writeFileSync(filePath, currentText, 'utf8');
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = async () => undefined;
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
							if (commandResult) {
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
							if (pendingBarrier) {
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
			await Promise.resolve(didSaveHandler!(document));

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
			holdFinalPersist = false;

			const activeOwner = [...((provider as any).markdownDocuments.values())][0];
			currentText = JSON.stringify({
				kind: 'kqlx', version: 1, state: { sections: [
					{ id: 'markdown_1', type: 'markdown', text: 'unacknowledged source' },
				] },
			}, null, 2) + '\n';
			holdReloadAcknowledgement = true;
			const pendingReload = Promise.resolve(receiveHandler!({ type: 'requestDocument' }));
			await pendingProjectionPosted;
			let pendingSourceSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { pendingSourceSave = Promise.resolve(thenable); },
			} as any);
			await pendingSourceSave;
			assert.strictEqual([...((provider as any).markdownDocuments.values())][0], activeOwner);
			await Promise.resolve(didSaveHandler!(document));
			await Promise.resolve(receiveHandler!({
				type: 'documentReloadResult', requestId: pendingReloadRequestId,
				applied: false, editRevision: 0, markdownCommandBarrierSupported: true,
			}));
			await pendingReload;

			holdReloadAcknowledgement = false;
			currentText = activeOwner.sourceText;
			holdFinalPersist = true;
			let disposedSave: Promise<vscode.TextEdit[]> | undefined;
			willSaveHandler!({
				document,
				waitUntil: (thenable: Thenable<vscode.TextEdit[]>) => { disposedSave = Promise.resolve(thenable); },
			} as any);
			await waitForCondition(() => finalPersistRequestCount === 4, 'disposal Save should reserve the queue');
			for (const dispose of disposeHandlers) dispose();
			await assert.rejects(disposedSave!);
			const queue = [...((provider as any).markdownDocumentQueues.values())][0] as { tail: Promise<void> };
			await Promise.race([
				queue.tail,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error('disposed Save lease did not settle')), 1_000)),
			]);
		} finally {
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
			(vscode.workspace as any).onWillSaveTextDocument = originalOnWillSave;
			(vscode.workspace as any).onDidSaveTextDocument = originalOnDidSave;
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
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

	test('panel disposal rolls back only the in-flight file command', async () => {
		const originalInitialize = (QueryEditorProvider as any).prototype.initializeWebviewPanel;
		const originalApplyEdit = vscode.workspace.applyEdit;
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
			assert.strictEqual(currentText, firstText);
			assert.strictEqual(JSON.parse(currentText).state.sections[0].text, 'first command');
		} finally {
			releaseSecond?.();
			(QueryEditorProvider as any).prototype.initializeWebviewPanel = originalInitialize;
			(vscode.workspace as any).applyEdit = originalApplyEdit;
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
			let adapterSettled = false;
			const adapter = Promise.resolve(receiveHandler!({
				type: 'persistDocument', sourceGeneration: projection.sourceGeneration,
				state: { sections: [
					{ id: 'query_1', type: 'query', query: 'print adapter = 1' },
					{ id: 'markdown_1', type: 'markdown', text: 'stale adapter' },
				] },
			})).then(() => { adapterSettled = true; });
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.strictEqual(adapterSettled, false, 'adapter persistence must wait for the in-flight command owner');
			releaseCommand();
			await Promise.all([command, adapter]);
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
});
