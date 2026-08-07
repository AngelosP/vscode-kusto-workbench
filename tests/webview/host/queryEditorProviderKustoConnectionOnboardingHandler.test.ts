import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const getAccounts = vi.fn(async () => []);
const setExplicitAccount = vi.fn(async () => undefined);
const getDatabases = vi.fn(async () => []);
const withTransientAuthPreference = vi.fn(async (
	_candidate: unknown,
	_preference: unknown,
	operation: () => Promise<unknown>,
) => operation());
const isAuthenticationError = vi.fn(() => false);

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {
		readonly getDatabases = getDatabases;
		readonly withTransientAuthPreference = withTransientAuthPreference;
		readonly isAuthenticationError = isAuthenticationError;
	},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({
			onDidChange: () => ({ dispose() {} }),
			getAccounts,
			setExplicitAccount,
		}),
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

type StructuralKustoConnectionOnboardingHandler = {
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
	kustoConnectionOnboardingApplication: StructuralKustoConnectionOnboardingHandler,
	postMessage: ReturnType<typeof vi.fn>,
): {
	provider: QueryEditorProvider;
	legacyPromptAddConnection: ReturnType<typeof vi.fn>;
	legacyAddConnectionFromWebview: ReturnType<typeof vi.fn>;
	legacyTestConnectionFromWebview: ReturnType<typeof vi.fn>;
	refreshConnections: ReturnType<typeof vi.fn>;
} {
	const provider = Reflect.construct(QueryEditorProvider, [
		vscode.Uri.file('C:\\extension'),
		{},
		{},
		{},
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
		kustoConnectionOnboardingApplication,
	]) as QueryEditorProvider;
	const legacyPromptAddConnection = vi.fn(async () => undefined);
	const legacyAddConnectionFromWebview = vi.fn(async () => undefined);
	const legacyTestConnectionFromWebview = vi.fn(async () => undefined);
	const refreshConnections = vi.fn(async () => undefined);
	Object.assign(provider.connection, {
		promptAddConnection: legacyPromptAddConnection,
		addConnectionFromWebview: legacyAddConnectionFromWebview,
		testConnectionFromWebview: legacyTestConnectionFromWebview,
	});
	Object.assign(provider, {
		panel: {
			webview: { postMessage },
		},
		sendConnectionsData: refreshConnections,
	});
	return {
		provider,
		legacyPromptAddConnection,
		legacyAddConnectionFromWebview,
		legacyTestConnectionFromWebview,
		refreshConnections,
	};
}

describe('QueryEditorProvider Kusto connection-onboarding application', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('forwards all three exact onboarding messages without invoking legacy services or adapters', async () => {
		const kustoConnectionOnboardingApplication: StructuralKustoConnectionOnboardingHandler = {
			handleMessage: vi.fn((message: IncomingWebviewMessage) => {
				switch (message.type) {
					case 'promptAddConnection':
					case 'addConnection':
					case 'testKustoConnection':
						return Promise.resolve();
					default:
						return undefined;
				}
			}),
			dispose: vi.fn(),
		};
		const postMessage = vi.fn(async () => true);
		const {
			provider,
			legacyPromptAddConnection,
			legacyAddConnectionFromWebview,
			legacyTestConnectionFromWebview,
			refreshConnections,
		} = createProvider(kustoConnectionOnboardingApplication, postMessage);
		const prompt = {
			type: 'promptAddConnection',
			boxId: 'query-onboarding',
		} satisfies IncomingWebviewMessage;
		const add = {
			type: 'addConnection',
			name: 'Help cluster',
			clusterUrl: 'help.kusto.windows.net',
			database: 'Samples',
			authorityId: 'organizations',
			accountId: 'account-1',
			boxId: 'query-onboarding',
		} satisfies IncomingWebviewMessage;
		const test = {
			type: 'testKustoConnection',
			name: 'Help cluster draft',
			clusterUrl: 'help.kusto.windows.net',
			database: 'Samples',
			authorityId: 'organizations',
			accountId: 'account-1',
			boxId: 'query-onboarding',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(prompt);
		await provider.handleWebviewMessage(add);
		await provider.handleWebviewMessage(test);

		expect(provider.kustoConnectionOnboardingApplication).toBe(kustoConnectionOnboardingApplication);
		expect(provider.kustoConnectionIntakeApplication).not.toBe(kustoConnectionOnboardingApplication);
		expect(kustoConnectionOnboardingApplication.handleMessage).toHaveBeenCalledTimes(3);
		expect(kustoConnectionOnboardingApplication.handleMessage.mock.calls[0][0]).toBe(prompt);
		expect(kustoConnectionOnboardingApplication.handleMessage.mock.calls[1][0]).toBe(add);
		expect(kustoConnectionOnboardingApplication.handleMessage.mock.calls[2][0]).toBe(test);
		expect(legacyPromptAddConnection).not.toHaveBeenCalled();
		expect(legacyAddConnectionFromWebview).not.toHaveBeenCalled();
		expect(legacyTestConnectionFromWebview).not.toHaveBeenCalled();
		expect(refreshConnections).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(getAccounts).not.toHaveBeenCalled();
		expect(setExplicitAccount).not.toHaveBeenCalled();
		expect(getDatabases).not.toHaveBeenCalled();
		expect(withTransientAuthPreference).not.toHaveBeenCalled();
		expect(isAuthenticationError).not.toHaveBeenCalled();
	});

	it('awaits accepted onboarding work and adopts the injected handler rejection exactly', async () => {
		const handled = deferred<void>();
		const kustoConnectionOnboardingApplication: StructuralKustoConnectionOnboardingHandler = {
			handleMessage: vi.fn((_message: IncomingWebviewMessage) => handled.promise),
			dispose: vi.fn(),
		};
		const { provider } = createProvider(kustoConnectionOnboardingApplication, vi.fn(async () => true));
		let settled = false;
		const request = provider.handleWebviewMessage({
			type: 'promptAddConnection',
			boxId: 'query-onboarding',
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

		const failure = new Error('injected Kusto connection-onboarding handler failed');
		kustoConnectionOnboardingApplication.handleMessage.mockImplementationOnce(() => Promise.reject(failure));
		await expect(provider.handleWebviewMessage({
			type: 'testKustoConnection',
			clusterUrl: 'help.kusto.windows.net',
		})).rejects.toBe(failure);
	});

	it('retains only handler injection while connection, auth, client, trace, refresh, and emitters stay put', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const serviceSource = readSource('src/host/queryEditorConnection.ts');
		const handlerSource = readSource('src/host/kustoConnectionOnboardingApplicationHandler.ts');
		const managerSource = readSource('src/host/connectionManager.ts');
		const authSource = readSource('src/host/kustoAuthPreferenceService.ts');
		const clientSource = readSource('src/host/kustoClient.ts');
		const traceSource = readSource('src/host/databaseListTrace.ts');
		const sectionFactorySource = readSource('src/webview/core/section-factory.ts');
		const emitterSource = readSource('src/webview/shared/webview-messages.ts');

		for (const type of ['promptAddConnection', 'addConnection', 'testKustoConnection']) {
			expect(providerSource).not.toContain(`case '${type}':`);
			expect(handlerSource).toContain(`case '${type}':`);
			expect(emitterSource).toContain(`type: '${type}'`);
		}
		for (const method of ['promptAddConnection', 'addConnectionFromWebview', 'testConnectionFromWebview']) {
			expect(serviceSource).not.toContain(`async ${method}(`);
		}
		expect(providerSource).toContain('private connectionsDataRevision = 0;');
		expect(providerSource).toContain('private connectionsDataTail: Promise<void> = Promise.resolve();');
		expect(providerSource).toContain('refreshConnections: () => this.sendConnectionsData()');
		expect(providerSource).toContain('this.kustoConnectionOnboardingApplication.dispose();');
		expect(handlerSource).toContain('await this.options.refreshConnections();');
		expect(handlerSource).toContain('await this.options.saveLastSelection(newConnection.id, newConnection.database);');
		expect(managerSource).toContain("this.changeEmitter.fire({ type: 'added', connection: { ...newConnection } });");
		expect(authSource).toContain('setExplicitAccount(connectionId: string, account: vscode.AuthenticationSessionAccountInformation)');
		expect(clientSource).toContain('public async withTransientAuthPreference<T>(');
		expect(clientSource).toContain('async getDatabases(connection: KustoConnection');
		expect(traceSource).toContain('export function traceDatabaseList(');
		expect(sectionFactorySource).toContain("type: 'testKustoConnection'");
		expect(sectionFactorySource).toContain("type: 'addConnection'");
	});
});