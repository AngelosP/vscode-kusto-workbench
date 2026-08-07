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
	toolOrchestrator: undefined,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type StructuralSqlConnectionOnboardingHandler = {
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
	sqlConnectionOnboardingApplication: StructuralSqlConnectionOnboardingHandler,
): {
	provider: QueryEditorProvider;
	showInputBox: ReturnType<typeof vi.spyOn>;
	showQuickPick: ReturnType<typeof vi.spyOn>;
	addConnection: ReturnType<typeof vi.fn>;
	getConnections: ReturnType<typeof vi.fn>;
	globalStateUpdate: ReturnType<typeof vi.fn>;
	refreshSqlConnections: ReturnType<typeof vi.fn>;
	postMessage: ReturnType<typeof vi.fn>;
	legacyPromptAddSqlConnection: ReturnType<typeof vi.fn>;
	legacyAddSqlConnectionFromWebview: ReturnType<typeof vi.fn>;
} {
	const addConnection = vi.fn(async () => ({
		id: 'sql_legacy',
		name: 'Legacy',
		dialect: 'mssql',
		serverUrl: 'legacy.database.windows.net',
		authType: 'aad',
	}));
	const getConnections = vi.fn(() => []);
	const globalStateUpdate = vi.fn(async () => undefined);
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{},
		{
			globalState: { update: globalStateUpdate },
		},
		{
			connectionManager: { addConnection, getConnections },
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
		sqlConnectionOnboardingApplication,
	]) as QueryEditorProvider;
	const postMessage = vi.fn(async () => true);
	const refreshSqlConnections = vi.fn(async () => true);
	const legacyPromptAddSqlConnection = vi.fn(async () => undefined);
	const legacyAddSqlConnectionFromWebview = vi.fn(async () => undefined);
	Object.assign(provider, {
		panel: { webview: { postMessage } },
		sendSqlConnectionsData: refreshSqlConnections,
		promptAddSqlConnection: legacyPromptAddSqlConnection,
		addSqlConnectionFromWebview: legacyAddSqlConnectionFromWebview,
	});
	const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
	const showQuickPick = vi.fn(async () => undefined);
	Object.assign(vscode.window, { showQuickPick });
	return {
		provider,
		showInputBox,
		showQuickPick,
		addConnection,
		getConnections,
		globalStateUpdate,
		refreshSqlConnections,
		postMessage,
		legacyPromptAddSqlConnection,
		legacyAddSqlConnectionFromWebview,
	};
}

describe('QueryEditorProvider SQL connection-onboarding application', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete (vscode.window as Partial<typeof vscode.window>).showQuickPick;
	});

	it('forwards both exact onboarding messages without invoking provider-owned effects', async () => {
		const sqlConnectionOnboardingApplication: StructuralSqlConnectionOnboardingHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				switch (message.type) {
					case 'promptAddSqlConnection':
					case 'addSqlConnection':
						return Promise.resolve();
					default:
						return undefined;
				}
			}),
			dispose: vi.fn(),
		};
		const {
			provider,
			showInputBox,
			showQuickPick,
			addConnection,
			getConnections,
			globalStateUpdate,
			refreshSqlConnections,
			postMessage,
			legacyPromptAddSqlConnection,
			legacyAddSqlConnectionFromWebview,
		} = createProvider(sqlConnectionOnboardingApplication);
		const prompt = {
			type: 'promptAddSqlConnection',
			boxId: 'sql-onboarding',
		} satisfies IncomingWebviewMessage;
		const add = {
			type: 'addSqlConnection',
			name: '  Sales SQL  ',
			serverUrl: '  sales.database.windows.net  ',
			dialect: 'mssql',
			authType: 'sql-login',
			database: 'Sales',
			port: 1433,
			username: 'sales-user',
			password: 'secret-value',
			boxId: 'sql-onboarding',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(prompt);
		await provider.handleWebviewMessage(add);

		expect(provider.sqlConnectionOnboardingApplication).toBe(sqlConnectionOnboardingApplication);
		expect(provider.kustoConnectionOnboardingApplication).not.toBe(sqlConnectionOnboardingApplication);
		expect(sqlConnectionOnboardingApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(sqlConnectionOnboardingApplication.handleMessage.mock.calls[0][0]).toBe(prompt);
		expect(sqlConnectionOnboardingApplication.handleMessage.mock.calls[1][0]).toBe(add);
		expect(showInputBox).not.toHaveBeenCalled();
		expect(showQuickPick).not.toHaveBeenCalled();
		expect(legacyPromptAddSqlConnection).not.toHaveBeenCalled();
		expect(legacyAddSqlConnectionFromWebview).not.toHaveBeenCalled();
		expect(addConnection).not.toHaveBeenCalled();
		expect(getConnections).not.toHaveBeenCalled();
		expect(globalStateUpdate).not.toHaveBeenCalled();
		expect(refreshSqlConnections).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('awaits accepted onboarding work and adopts the injected handler rejection exactly', async () => {
		const handled = deferred<void>();
		const sqlConnectionOnboardingApplication: StructuralSqlConnectionOnboardingHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(sqlConnectionOnboardingApplication);
		let settled = false;
		const request = provider.handleWebviewMessage({
			type: 'promptAddSqlConnection',
			boxId: 'sql-onboarding',
		});
		void request.then(
			() => { settled = true; },
			() => { settled = true; },
		);
		await Promise.resolve();

		expect(settled).toBe(false);
		handled.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);

		const failure = new Error('injected SQL connection-onboarding handler failed');
		sqlConnectionOnboardingApplication.handleMessage.mockImplementationOnce(() => Promise.reject(failure));
		await expect(provider.handleWebviewMessage({
			type: 'addSqlConnection',
			name: 'Sales SQL',
			serverUrl: 'sales.database.windows.net',
			dialect: 'mssql',
			authType: 'aad',
		})).rejects.toBe(failure);
	});

	it('retains only handler injection while SQL owners, publication, controls, response application, and secrets stay put', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/sqlConnectionOnboardingApplicationHandler.ts');
		const managerSource = readSource('src/host/sqlConnectionManager.ts');
		const workbenchSource = readSource('src/host/sql/sqlWorkbenchService.ts');
		const lifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const hostTypesSource = readSource('src/host/queryEditorTypes.ts');
		const emitterSource = readSource('src/webview/shared/webview-messages.ts');
		const sectionFactorySource = readSource('src/webview/core/section-factory.ts');
		const messageHandlerSource = readSource('src/webview/core/message-handler.ts');

		for (const type of ['promptAddSqlConnection', 'addSqlConnection']) {
			expect(providerSource).not.toContain(`case '${type}':`);
			expect(handlerSource).toContain(`case '${type}':`);
			expect(hostTypesSource).toContain(`type: '${type}'`);
			expect(emitterSource).toContain(`type: '${type}'`);
		}
		expect(providerSource).not.toContain('private async promptAddSqlConnection(');
		expect(providerSource).not.toContain('private async addSqlConnectionFromWebview(');
		expect(providerSource).toContain('private _sqlConnectionsSnapshotRevision = 0;');
		expect(providerSource).toContain('private sqlConnectionsSnapshotTail: Promise<boolean> = Promise.resolve(true);');
		expect(providerSource).toContain('private async sendSqlConnectionsData(): Promise<boolean>');
		expect(providerSource).toContain('this.sqlConnectionOnboardingApplication.dispose();');
		expect(handlerSource).toContain("await this.options.globalState.update('sql.lastConnectionId', newConnection.id);");
		expect(handlerSource).toContain('connections: this.options.connectionManager.getConnections(),');
		expect(handlerSource).not.toContain("type: 'sqlConnectionsData'");
		expect(managerSource).toContain('async addConnection(connection: Omit<SqlConnection, \'id\'>, password?: string)');
		expect(managerSource).toContain('await this.context.secrets.store(`${STORAGE_KEYS.passwordPrefix}${connectionId}`, password);');
		expect(workbenchSource).toContain('export class SqlWorkbenchService');
		expect(lifecycleSource).toContain('export class SqlEditorLifecycleCoordinator');
		expect(sectionFactorySource).toContain("type: 'addSqlConnection'");
		expect(sectionFactorySource).toContain("type: 'promptAddSqlConnection'");
		expect(messageHandlerSource).toContain("case 'sqlConnectionAdded':");
	});
});
