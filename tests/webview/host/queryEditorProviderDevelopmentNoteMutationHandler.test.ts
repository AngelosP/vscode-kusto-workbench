import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const toolOrchestrator = vi.hoisted(() => ({
	handleWebviewResponse: vi.fn(),
}));

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({ onDidChange: () => ({ dispose() {} }) }),
	},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {},
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

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type DevelopmentNoteMutationResult = { success: boolean; error?: string };

type StructuralDevelopmentNoteMutationHandler = {
	updateDevelopmentNotes: ReturnType<typeof vi.fn>;
	handleMessage: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createProvider(
	developmentNoteMutationApplication: StructuralDevelopmentNoteMutationHandler,
): { provider: QueryEditorProvider; providerResolverMap: Map<string, unknown> } {
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: vi.fn(() => undefined), update: vi.fn(async () => undefined) } },
		{
			connectionManager: { getConnection: vi.fn(), getConnections: vi.fn(() => []) },
			client: { getDatabases: vi.fn(async () => [] as string[]) },
		},
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
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			handleMessage: vi.fn(() => undefined),
			getFavorites: vi.fn(() => []),
			dispose: vi.fn(),
		},
		{
			handleMessage: vi.fn(() => undefined),
			getFavorites: vi.fn(() => []),
			activate: vi.fn(),
			dispose: vi.fn(),
		},
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		{ handleMessage: vi.fn(() => undefined), dispose: vi.fn() },
		developmentNoteMutationApplication,
	]) as QueryEditorProvider;
	const providerResolverMap = new Map<string, unknown>();
	(provider as unknown as { panel: unknown }).panel = {};
	(provider as unknown as { postMessage(message: unknown): boolean }).postMessage = vi.fn(() => true);
	(provider as unknown as { webviewMutationResponseResolvers: Map<string, unknown> })
		.webviewMutationResponseResolvers = providerResolverMap;
	return { provider, providerResolverMap };
}

describe('QueryEditorProvider development-note mutation application', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		toolOrchestrator.handleWebviewResponse.mockReset();
	});

	it('delegates exact mutations, claims matching responses, and preserves unclaimed tool responses', async () => {
		vi.useFakeTimers();
		const mutationSettlement = deferred<DevelopmentNoteMutationResult>();
		const developmentNoteMutationApplication: StructuralDevelopmentNoteMutationHandler = {
			updateDevelopmentNotes: vi.fn((_message: Record<string, unknown>) => mutationSettlement.promise),
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				if (message.type !== 'toolResponse' || message.requestId !== 'copilot_devnotes_test_1') return false;
				mutationSettlement.resolve({
					success: false,
					error: 'Development notes require a companion metadata file.',
				});
				return true;
			}),
			dispose: vi.fn(),
		};
		const { provider, providerResolverMap } = createProvider(developmentNoteMutationApplication);
		const mutation = { action: 'add', entry: { id: 'note_1' } };

		const pendingMutation = provider.updateDevelopmentNotes(mutation);
		await Promise.resolve();

		expect(developmentNoteMutationApplication.updateDevelopmentNotes).toHaveBeenCalledTimes(1);
		expect(developmentNoteMutationApplication.updateDevelopmentNotes.mock.calls[0][0]).toBe(mutation);
		expect((provider as unknown as { developmentNoteMutationApplication: unknown })
			.developmentNoteMutationApplication).toBe(developmentNoteMutationApplication);

		const claimedResponse = {
			type: 'toolResponse',
			requestId: 'copilot_devnotes_test_1',
			result: { success: false },
			error: 'Development notes require a companion metadata file.',
		} satisfies IncomingWebviewMessage;
		await provider.handleWebviewMessage(claimedResponse);

		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(developmentNoteMutationApplication.handleMessage.mock.calls[0][0]).toBe(claimedResponse);
		await expect(pendingMutation).resolves.toEqual({
			success: false,
			error: 'Development notes require a companion metadata file.',
		});
		expect(providerResolverMap).toHaveLength(0);
		expect(toolOrchestrator.handleWebviewResponse).not.toHaveBeenCalled();

		const unclaimedResult = { success: true };
		const unclaimedResponse = {
			type: 'toolResponse',
			requestId: 'tool_other_1',
			result: unclaimedResult,
		} satisfies IncomingWebviewMessage;
		await provider.handleWebviewMessage(unclaimedResponse);

		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(developmentNoteMutationApplication.handleMessage.mock.calls[1][0]).toBe(unclaimedResponse);
		expect(toolOrchestrator.handleWebviewResponse).toHaveBeenCalledOnce();
		expect(toolOrchestrator.handleWebviewResponse).toHaveBeenCalledWith(
			'tool_other_1',
			unclaimedResult,
			undefined,
		);
		expect(providerResolverMap).toHaveLength(0);
	});

	it('deletes displaced correlation authority while preserving Copilot, webview, and message owners', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/developmentNoteMutationApplicationHandler.ts');
		const copilotSource = readSource('src/host/queryEditorCopilot.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const webviewSource = readSource('src/webview/core/message-handler.ts');

		expect(providerSource).not.toContain('webviewMutationResponseResolvers');
		expect(providerSource).not.toContain('copilot_devnotes_');
		expect(providerSource).not.toContain('Development note update timed out.');
		expect(providerSource).toContain(
			'return this.developmentNoteMutationApplication.updateDevelopmentNotes(message);',
		);
		expect(providerSource).toContain(
			'if (this.developmentNoteMutationApplication.handleMessage(message)) return;',
		);
		expect(providerSource).toMatch(
			/sqlLastSelectionApplication\?: SqlLastSelectionApplicationHandler,\s+developmentNoteMutationApplication\?: DevelopmentNoteMutationApplicationHandler,/,
		);
		expect(providerSource).toContain('this.developmentNoteMutationApplication.dispose();');
		expect(handlerSource).toContain('private readonly webviewMutationResponseResolvers');
		expect(handlerSource).toContain('const requestId = `copilot_devnotes_');
		expect(handlerSource).toContain('}, 5000);');
		expect(handlerSource).toContain("type: 'updateDevNotes'");
		expect(handlerSource).toContain('if (!pending) return false;');
		expect(copilotSource).toContain("action: 'remove'");
		expect(copilotSource).toContain("action: noteId ? 'supersede' : 'add'");
		expect(copilotSource).toContain("tool: 'update_development_note'");
		expect(hostTypesSource).toContain("type: 'toolResponse'; requestId: string; result: unknown; error?: string");
		expect(webviewSource).toContain("case 'updateDevNotes':");
		expect(webviewSource).toContain('requestHostOwnedDevelopmentNoteAdd');
		expect(webviewSource).toContain('requestHostOwnedDevelopmentNotePatch');
		expect(webviewSource).toContain('mutated = await commandSettlement;');
		expect(webviewSource).toContain('const hiddenDevelopmentNoteIds = new Set(');
		expect(webviewSource).toContain('getOptimisticHostOwnedDevelopmentNoteSections()');
		expect(webviewSource).toContain('!hiddenDevelopmentNoteIds.has(id.trim())');
		expect(webviewSource).not.toContain("startsWith('devnotes_')");
		expect(webviewSource).not.toContain('pState.devNotesSections');
		expect(webviewSource).toContain('const metadataFreeCompanion = !pState.compatibilityMode');
		expect(webviewSource).toContain('pState.metadataFreeDevelopmentNoteSections');
		expect(webviewSource).toContain("if (mutated) schedulePersist('devnotes-update');");
		expect(webviewSource).toContain("type: 'toolResponse', requestId: message.requestId, result: { success: mutated }");
	});
});
