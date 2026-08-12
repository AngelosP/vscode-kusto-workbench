import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({ onDidChange: () => ({ dispose() {} }) }),
	},
}));

vi.mock('../../../src/host/kqlLanguageService/host', () => ({
	KqlLanguageServiceHost: class {},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {
		activate(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		startSession(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {},
	SQL_COPILOT_OWNER_CHANGED_MESSAGE: 'SQL section owner changed. Retry the request.',
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

vi.mock('../../../src/host/queryEditorHtml', () => ({
	getQueryEditorHtml: vi.fn(async () => '<html></html>'),
}));

vi.mock('../../../src/host/tutorials/embeddedTutorialWebviewHost', () => ({
	EmbeddedTutorialWebviewHost: class {},
	EmbeddedTutorialWebviewRegistry: {
		register: () => ({ dispose() {} }),
	},
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import { getQueryEditorHtml } from '../../../src/host/queryEditorHtml';

type StructuralCursorStatusHandler = {
	handleMessage: ReturnType<typeof vi.fn>;
	setPanelVisible: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function createProvider(
	editorCursorStatusBar: {
		update: ReturnType<typeof vi.fn>;
		getSnapshot: ReturnType<typeof vi.fn>;
		clearOwnerPrefix: ReturnType<typeof vi.fn>;
	},
	cursorStatusApplication: StructuralCursorStatusHandler,
	postMessage: ReturnType<typeof vi.fn>,
): QueryEditorProvider {
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{},
		{ extensionMode: vscode.ExtensionMode.Development },
		{},
		editorCursorStatusBar,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		cursorStatusApplication,
	]) as QueryEditorProvider;
	Object.assign(provider, {
		panel: {
			visible: true,
			webview: { postMessage },
		},
	});
	return provider;
}

describe('QueryEditorProvider editor cursor-status application', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('forwards the exact update and snapshot objects without touching the status adapter or provider transport', async () => {
		const editorCursorStatusBar = {
			update: vi.fn(),
			getSnapshot: vi.fn(() => ({ visible: true, text: 'Ln 8, Col 13' })),
			clearOwnerPrefix: vi.fn(),
		};
		const cursorStatusApplication: StructuralCursorStatusHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => message.type === 'editorCursorPositionChanged'
				? true
				: Promise.resolve()),
			setPanelVisible: vi.fn(),
			dispose: vi.fn(),
		};
		const postMessage = vi.fn(async () => true);
		const provider = createProvider(editorCursorStatusBar, cursorStatusApplication, postMessage);
		provider.documentUri = 'file:///tmp/favorites-source.kqlx';
		const update = {
			type: 'editorCursorPositionChanged',
			boxId: '  query_13  ',
			editorKind: 'kusto',
			line: 8,
			column: 13,
			visible: true,
			reason: 'selection',
		} satisfies IncomingWebviewMessage;
		const snapshot = {
			type: 'getEditorCursorStatusSnapshot',
			requestId: 'cursor-snapshot-13',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(update);
		await provider.handleWebviewMessage(snapshot);

		expect(provider.editorCursorStatusApplication).toBe(cursorStatusApplication);
		expect(provider.copilotAgentOpenApplication).not.toBe(cursorStatusApplication);
		expect(cursorStatusApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(cursorStatusApplication.handleMessage.mock.calls[0][0]).toBe(update);
		expect(cursorStatusApplication.handleMessage.mock.calls[1][0]).toBe(snapshot);
		expect(editorCursorStatusBar.update).not.toHaveBeenCalled();
		expect(editorCursorStatusBar.getSnapshot).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('consumes dispatcher readiness before application routing in every panel composition', async () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		const handleWebviewMessage = vi.fn(async () => undefined);
		provider.handleWebviewMessage = handleWebviewMessage;
		provider.fileOpenTrace = { mark: vi.fn() } as any;

		await provider.handlePanelWebviewMessage({ type: 'mainWebviewDispatcherReady' });
		expect(handleWebviewMessage).not.toHaveBeenCalled();

		const ordinaryMessage = { type: 'getConnections' } satisfies IncomingWebviewMessage;
		await provider.handlePanelWebviewMessage(ordinaryMessage);
		expect(handleWebviewMessage).toHaveBeenCalledOnce();
		expect(handleWebviewMessage).toHaveBeenCalledWith(ordinaryMessage);
	});

	it('retains only injection and panel lifecycle forwarding while the handler owns both routes', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/editorCursorStatusApplicationHandler.ts');
		const statusBarSource = readSource('src/host/editorCursorStatusBar.ts');
		const emitterSource = readSource('src/webview/shared/editor-cursor-status.ts');

		expect(providerSource).not.toContain("case 'editorCursorPositionChanged':");
		expect(providerSource).not.toContain("case 'getEditorCursorStatusSnapshot':");
		expect(providerSource).not.toContain('getCursorStatusOwnerId');
		expect(providerSource).not.toContain('postEditorCursorStatusSnapshot');
		expect(providerSource).not.toContain('clearCursorStatusForProvider');
		expect(providerSource).not.toContain('.clearOwnerPrefix(');
		expect(providerSource).not.toContain('.getSnapshot()');
		expect(providerSource).toContain('this.editorCursorStatusApplication.setPanelVisible(visible);');
		expect(providerSource).toContain('this.editorCursorStatusApplication.dispose();');

		expect(handlerSource).toContain("message.type === 'editorCursorPositionChanged'");
		expect(handlerSource).toContain("message.type === 'getEditorCursorStatusSnapshot'");
		expect(handlerSource).toContain("?? { visible: false, text: '' }");
		expect(handlerSource).toContain('this.options.statusBar?.clearOwnerPrefix(this.ownerPrefix);');
		expect(statusBarSource).toContain('const text = `Ln ${line}, Col ${column}`;');
		expect(statusBarSource).toContain('accessibilityInformation');
		expect(emitterSource).toContain("type: 'editorCursorPositionChanged'");
	});

	it('forwards initial, post-await, and hidden panel visibility to the injected handler', async () => {
		const editorCursorStatusBar = {
			update: vi.fn(),
			getSnapshot: vi.fn(() => ({ visible: false, text: '' })),
			clearOwnerPrefix: vi.fn(),
		};
		const cursorStatusApplication: StructuralCursorStatusHandler = {
			handleMessage: vi.fn(() => undefined),
			setPanelVisible: vi.fn(),
			dispose: vi.fn(),
		};
		const postMessage = vi.fn(async () => true);
		const provider = createProvider(editorCursorStatusBar, cursorStatusApplication, postMessage);
		provider.documentUri = 'file:///tmp/favorites-source.kqlx';
		let onDidChangeViewState!: () => void;
		const panel = {
			visible: true,
			active: true,
			viewType: 'kustoWorkbench.test',
			webview: {
				html: '',
				postMessage,
				onDidReceiveMessage: vi.fn(),
			},
			onDidDispose: vi.fn(() => ({ dispose() {} })),
			onDidChangeViewState: vi.fn((handler: () => void) => {
				onDidChangeViewState = handler;
				return { dispose() {} };
			}),
		} as unknown as vscode.WebviewPanel;

		await provider.initializeWebviewPanel(panel, { registerMessageHandler: false });

		expect(getQueryEditorHtml).toHaveBeenCalledWith(
			panel.webview,
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ documentTitle: 'favorites-source.kqlx' }),
		);
		expect(cursorStatusApplication.setPanelVisible).toHaveBeenNthCalledWith(1, true);
		expect(cursorStatusApplication.setPanelVisible).toHaveBeenNthCalledWith(2, true);
		(panel as unknown as { visible: boolean }).visible = false;
		onDidChangeViewState();
		expect(cursorStatusApplication.setPanelVisible).toHaveBeenLastCalledWith(false);
	});
});