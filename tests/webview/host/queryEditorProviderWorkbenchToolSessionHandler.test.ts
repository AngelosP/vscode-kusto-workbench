import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const toolOrchestratorMocks = vi.hoisted(() => ({
	connect: vi.fn(() => 41),
	activateConnection: vi.fn(),
	disconnectIfOwner: vi.fn(),
	handleKustoExecutionStarted: vi.fn(),
	handleDevelopmentNoteMutationResponse: vi.fn(() => false),
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
	toolOrchestrator: toolOrchestratorMocks,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralWorkbenchToolSessionHandler = {
	activate: ReturnType<typeof vi.fn>;
	handleDevelopmentNoteMutationResponse: ReturnType<typeof vi.fn>;
	handleDevelopmentNoteMutationResponseAdmission?: ReturnType<typeof vi.fn>;
	hasPendingDevelopmentNoteMutationResponse?: ReturnType<typeof vi.fn>;
	handleMessage: ReturnType<typeof vi.fn>;
	requestSectionsFromWebview: ReturnType<typeof vi.fn>;
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

function createProvider(workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler): {
	provider: QueryEditorProvider;
	developmentNoteMutationApplication: { handleMessage: ReturnType<typeof vi.fn> };
} {
	const developmentNoteMutationApplication = {
		updateDevelopmentNotes: vi.fn(async () => ({ success: true })),
		handleMessage: vi.fn(() => false),
		dispose: vi.fn(),
	};
	const copilotInlineCompletionApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotAvailabilityApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotWriteQueryPreparationApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotConversationClearApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotHistoryRemovalApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const copilotChatFirstTimeApplication = {
		handleMessage: vi.fn(() => undefined),
		dispose: vi.fn(),
	};
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{ getConnection: vi.fn(), getConnections: vi.fn(() => []) },
		{ globalState: { get: vi.fn(), update: vi.fn(async () => undefined) } },
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
		copilotInlineCompletionApplication,
		copilotAvailabilityApplication,
		copilotWriteQueryPreparationApplication,
		copilotConversationClearApplication,
		copilotHistoryRemovalApplication,
		copilotChatFirstTimeApplication,
		workbenchToolSessionApplication,
	]) as QueryEditorProvider;
	return { provider, developmentNoteMutationApplication };
}

describe('QueryEditorProvider Workbench tool session application', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('reference-identically forwards all three routes and leaves legacy authorities untouched', async () => {
		const routeSettlements = [deferred<void>(), deferred<void>(), deferred<void>()];
		const messages = [
			{
				type: 'toolExecutionStarted',
				requestId: 'tool-start-exact',
				owner: {
					engine: 'kusto',
					boxId: 'tool-box-exact',
					sectionInstanceId: 'tool-section-instance-exact',
					targetGeneration: 7,
					executionId: 'tool-execution-exact',
					connectionId: 'tool-connection-exact',
					database: 'ToolDatabaseExact',
					producer: 'tool',
				},
			},
			{
				type: 'toolResponse',
				requestId: 'tool-response-exact',
				result: { exact: true },
			},
			{
				type: 'toolStateResponse',
				requestId: 'tool-state-exact',
				sections: [{ id: 'query-exact', type: 'query' }],
			},
		] satisfies IncomingWebviewMessage[];
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn((candidate: IncomingWebviewMessage) => {
				const index = messages.indexOf(candidate);
				return index >= 0 ? routeSettlements[index].promise : undefined;
			}),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		const legacyStateResolver = vi.fn();
		(provider as unknown as {
			toolStateResponseResolvers: Map<string, (sections: unknown[] | undefined) => void>;
		}).toolStateResponseResolvers = new Map([['tool-state-exact', legacyStateResolver]]);
		const settled = [false, false, false];

		const requests = messages.map((message, index) => {
			const request = provider.handleWebviewMessage(message);
			void request.finally(() => { settled[index] = true; });
			return request;
		});
		await Promise.resolve();

		expect(workbenchToolSessionApplication.handleMessage).toHaveBeenCalledTimes(3);
		messages.forEach((message, index) => {
			expect(workbenchToolSessionApplication.handleMessage.mock.calls[index][0]).toBe(message);
		});
		expect((provider as unknown as { workbenchToolSessionApplication: unknown })
			.workbenchToolSessionApplication).toBe(workbenchToolSessionApplication);
		expect(settled).toEqual([false, false, false]);
		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledOnce();
		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledWith(messages[1]);
		expect(workbenchToolSessionApplication.handleDevelopmentNoteMutationResponse).toHaveBeenCalledOnce();
		expect(workbenchToolSessionApplication.handleDevelopmentNoteMutationResponse).toHaveBeenCalledWith(messages[1]);
		expect(legacyStateResolver).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleKustoExecutionStarted).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();

		routeSettlements.forEach(settlement => settlement.resolve());
		await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined, undefined]);
		expect(settled).toEqual([true, true, true]);
	});

	it('keeps section-state requests as a thin deferred delegate', async () => {
		const settlement = deferred<unknown[] | undefined>();
		const sections = [{ id: 'section-state-exact', type: 'query' }];
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => undefined),
			requestSectionsFromWebview: vi.fn(() => settlement.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(workbenchToolSessionApplication);
		let settled = false;

		const request = provider.requestSectionsFromWebview('schema-refresh', 'connection-state-exact');
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(workbenchToolSessionApplication.requestSectionsFromWebview)
			.toHaveBeenCalledWith('schema-refresh', 'connection-state-exact');
		expect(settled).toBe(false);
		expect(toolOrchestratorMocks.connect).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.activateConnection).not.toHaveBeenCalled();

		settlement.resolve(sections);
		await expect(request).resolves.toBe(sections);
		expect(settled).toBe(true);
	});

	it('gives matching development-note responses first claim before tool-session fallthrough', async () => {
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleMessage: vi.fn(() => Promise.resolve()),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		developmentNoteMutationApplication.handleMessage.mockReturnValue(true);
		const message = {
			type: 'toolResponse',
			requestId: 'copilot-devnote-claimed-exact',
			result: { success: true },
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledOnce();
		expect(developmentNoteMutationApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(workbenchToolSessionApplication.handleMessage).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();
	});

	it('gives matching agent development-note responses first claim before generic tool routing', async () => {
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => true),
			handleMessage: vi.fn(() => Promise.resolve()),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		const message = {
			type: 'toolResponse', requestId: 'tool-development-note-claimed-exact', result: { success: 'yes' },
		} as unknown as IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(developmentNoteMutationApplication.handleMessage).toHaveBeenCalledWith(message);
		expect(workbenchToolSessionApplication.handleDevelopmentNoteMutationResponse).toHaveBeenCalledWith(message);
		expect(workbenchToolSessionApplication.handleMessage).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();
	});

	it('quarantines unsafe matching agent correlation before property access and admits the canonical response', async () => {
		let getterCalls = 0;
		const handleAdmission = vi.fn((admission: {
			requestId?: string;
			parsed: { ok: boolean };
		}) => admission.requestId === 'tool-development-note-current');
		const workbenchToolSessionApplication: StructuralWorkbenchToolSessionHandler = {
			activate: vi.fn(),
			handleDevelopmentNoteMutationResponse: vi.fn(() => false),
			handleDevelopmentNoteMutationResponseAdmission: handleAdmission,
			hasPendingDevelopmentNoteMutationResponse: vi.fn(() => true),
			handleMessage: vi.fn(() => Promise.resolve()),
			requestSectionsFromWebview: vi.fn(),
			dispose: vi.fn(),
		};
		const { provider, developmentNoteMutationApplication } = createProvider(workbenchToolSessionApplication);
		(developmentNoteMutationApplication as unknown as {
			handleResponseAdmission: ReturnType<typeof vi.fn>;
			hasPendingResponse: ReturnType<typeof vi.fn>;
		}).handleResponseAdmission = vi.fn(() => false);
		(developmentNoteMutationApplication as unknown as {
			hasPendingResponse: ReturnType<typeof vi.fn>;
		}).hasPendingResponse = vi.fn(() => false);
		const inherited = Object.assign(Object.create({ requestId: 'tool-development-note-current' }), {
			type: 'toolResponse', result: { success: 'yes' },
		}) as IncomingWebviewMessage;
		const accessor: Record<string, unknown> = {
			type: 'toolResponse', result: { success: 'yes' },
		};
		Object.defineProperty(accessor, 'requestId', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'tool-development-note-current';
			},
		});
		const canonical = {
			type: 'toolResponse', requestId: 'tool-development-note-current', result: { success: true },
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(inherited);
		await provider.handleWebviewMessage(accessor as unknown as IncomingWebviewMessage);
		await provider.handleWebviewMessage(canonical);

		expect(getterCalls).toBe(0);
		expect(handleAdmission).toHaveBeenCalledTimes(3);
		expect(handleAdmission.mock.calls[0][0]).toMatchObject({
			requestId: 'tool-development-note-current', parsed: { ok: false },
		});
		expect(handleAdmission.mock.calls[1][0]).toMatchObject({
			requestId: undefined, parsed: { ok: false },
		});
		expect(handleAdmission.mock.calls[2][0]).toMatchObject({
			requestId: 'tool-development-note-current', parsed: { ok: true },
		});
		expect(workbenchToolSessionApplication.handleMessage).not.toHaveBeenCalled();
		expect(toolOrchestratorMocks.handleWebviewResponse).not.toHaveBeenCalled();
	});

	it('deletes displaced provider authority while preserving orchestrator, schema, and SQL owners', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/workbenchToolSessionApplicationHandler.ts');
		const sanitationSource = readSource('src/host/persistedResultSanitizationApplicationHandler.ts');
		const orchestratorSource = readSource('src/host/kustoWorkbenchTools.ts');
		const schemaSource = readSource('src/host/queryEditorSchema.ts');
		const sqlLifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');

		expect(providerSource).not.toContain('private toolOrchestratorToken');
		expect(providerSource).not.toContain('toolStateResponseResolvers');
		expect(providerSource).not.toContain('connectToolOrchestrator');
		expect(providerSource).not.toContain('disconnectToolOrchestrator');
		expect(providerSource).not.toContain('rebuildSqlComparisonOwners');
		expect(providerSource).not.toContain("case 'toolExecutionStarted':");
		expect(providerSource).not.toContain("case 'toolResponse':");
		expect(providerSource).not.toContain("case 'toolStateResponse':");
		expect(providerSource).toContain(
			'readonly workbenchToolSessionApplication: WorkbenchToolSessionApplicationHandler;',
		);
		expect(providerSource).toMatch(
			/copilotChatFirstTimeApplication\?: CopilotChatFirstTimeApplicationHandler,\s+workbenchToolSessionApplication\?: WorkbenchToolSessionApplicationHandler,/,
		);
		expect(providerSource).toContain(
			'return this.workbenchToolSessionApplication.requestSectionsFromWebview(purpose, targetConnectionId);',
		);
		expect(providerSource).toContain(
			'const admission = admitDevelopmentNoteMutationWebviewMessage(input);',
		);
		expect(providerSource).toContain(
			'this.developmentNoteMutationApplication.handleResponseAdmission(admission)',
		);
		expect(providerSource).toContain(
			'this.workbenchToolSessionApplication.handleDevelopmentNoteMutationResponseAdmission(admission)',
		);
		expect(providerSource).toContain(
			'= this.workbenchToolSessionApplication?.handleMessage(message);',
		);
		expect(providerSource).toContain('this.workbenchToolSessionApplication.activate();');
		expect(providerSource).toContain('this.workbenchToolSessionApplication.dispose();');
		expect(providerSource).not.toContain('this.sqlLifecycle.reconcileComparisonOwners(sections);');
		expect(sanitationSource).toContain('this.options.sqlLifecycle.reconcileComparisonOwners(sections);');

		expect(handlerSource).toContain('private connectionToken: number | undefined;');
		expect(handlerSource).toContain('private readonly stateResponseResolvers');
		expect(handlerSource).toContain(
			'setTimeout(() => this.settleStateRequest(requestId, undefined), 5000);',
		);
		expect(handlerSource).toContain('createRequestToolStateMessage(requestId, purpose, targetConnectionId)');
		expect(handlerSource).toContain('resolveStrictKustoConnection');
		expect(handlerSource).toContain('canonicalSectionKind(candidate.type)');
		expect(handlerSource).toContain('this.options.schema.refreshSchemaForTools');
		expect(handlerSource).toContain('this.options.sqlLifecycle.getReadyToolOwner');
		expect(handlerSource).toContain('this.connectedOrchestrator.disconnectIfOwner(this.connectionToken);');

		expect(orchestratorSource).toContain('private pendingResponses = new Map');
		expect(orchestratorSource).toContain('handleKustoExecutionStarted(');
		expect(orchestratorSource).toContain('handleWebviewResponse(');
		expect(schemaSource).toContain('async refreshSchemaForTools(');
		expect(sqlLifecycleSource).toContain('getReadyToolOwner(boxId: string)');
		expect(sqlLifecycleSource).toContain('reconcileComparisonOwners(sections: unknown[])');
	});
});
