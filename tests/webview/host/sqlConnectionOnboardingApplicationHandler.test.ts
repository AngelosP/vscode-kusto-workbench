import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import type { SqlConnection } from '../../../src/host/sqlConnectionManager';
import {
	HostSqlConnectionOnboardingApplicationHandler,
	type SqlConnectionOnboardingApplicationHandlerOptions,
} from '../../../src/host/sqlConnectionOnboardingApplicationHandler';

const liveHandlers = new Set<HostSqlConnectionOnboardingApplicationHandler>();

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHarness(overrides: Partial<SqlConnectionOnboardingApplicationHandlerOptions> = {}) {
	const addedConnection: SqlConnection = {
		id: 'sql_added',
		name: 'Added SQL',
		dialect: 'mssql',
		serverUrl: 'added.database.windows.net',
		authType: 'aad',
	};
	const currentConnections = [{ ...addedConnection }];
	const addConnection = vi.fn(async (connection: Omit<SqlConnection, 'id'>, _password?: string) => ({
		id: addedConnection.id,
		...connection,
	}));
	const getConnections = vi.fn(() => currentConnections);
	const updateLastConnectionId = vi.fn(async (_connectionId: string) => undefined);
	const globalStateUpdate = vi.fn((key: string, value: unknown) => key === 'sql.lastConnectionId'
		? updateLastConnectionId(String(value))
		: Promise.resolve());
	const postMessage = vi.fn(() => Promise.resolve(true));
	const options: SqlConnectionOnboardingApplicationHandlerOptions = {
		connectionManager: { addConnection, getConnections },
		globalState: { update: globalStateUpdate },
		postMessage,
		...overrides,
	};
	const handler = new HostSqlConnectionOnboardingApplicationHandler(options);
	liveHandlers.add(handler);
	return {
		handler,
		addedConnection,
		currentConnections,
		addConnection,
		getConnections,
		updateLastConnectionId,
		globalStateUpdate,
		postMessage,
	};
}

function installPrompts(inputResponses: Array<string | undefined>, quickPickResponse?: { label: string; id: string }) {
	const responses = [...inputResponses];
	const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockImplementation(async () => responses.shift());
	const showQuickPick = vi.fn(async () => quickPickResponse);
	Object.assign(vscode.window, { showQuickPick });
	return { showInputBox, showQuickPick };
}

describe('HostSqlConnectionOnboardingApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.restoreAllMocks();
		delete (vscode.window as Partial<typeof vscode.window>).showQuickPick;
	});

	it('declines unrelated Kusto and SQL traffic synchronously', () => {
		const harness = createHarness();

		expect(harness.handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(harness.handler.handleMessage({ type: 'getSqlConnections' })).toBeUndefined();
		expect(harness.addConnection).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: 'server prompt',
			inputs: [undefined],
			quickPick: { label: 'Azure AD (default)', id: 'aad' },
			inputCalls: 1,
			quickPickCalls: 0,
		},
		{
			label: 'authentication prompt',
			inputs: ['server.database.windows.net'],
			quickPick: undefined,
			inputCalls: 1,
			quickPickCalls: 1,
		},
		{
			label: 'username prompt',
			inputs: ['server.database.windows.net', undefined],
			quickPick: { label: 'SQL Login (username/password)', id: 'sql-login' },
			inputCalls: 2,
			quickPickCalls: 1,
		},
		{
			label: 'password prompt',
			inputs: ['server.database.windows.net', 'sql-user', undefined],
			quickPick: { label: 'SQL Login (username/password)', id: 'sql-login' },
			inputCalls: 3,
			quickPickCalls: 1,
		},
	])('stops without side effects after cancellation at the $label', async ({
		inputs, quickPick, inputCalls, quickPickCalls,
	}) => {
		const harness = createHarness();
		const prompts = installPrompts(inputs, quickPick);

		await harness.handler.handleMessage({ type: 'promptAddSqlConnection', boxId: 'sql-cancel' });

		expect(prompts.showInputBox).toHaveBeenCalledTimes(inputCalls);
		expect(prompts.showQuickPick).toHaveBeenCalledTimes(quickPickCalls);
		expect(harness.addConnection).not.toHaveBeenCalled();
		expect(harness.updateLastConnectionId).not.toHaveBeenCalled();
		expect(harness.getConnections).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('preserves the exact AAD prompt sequence, trims defaults, and acknowledges after selection storage', async () => {
		const order: string[] = [];
		const harness = createHarness();
		const prompts = installPrompts(
			['  aad.database.windows.net  ', undefined],
			{ label: 'Azure AD (default)', id: 'aad' },
		);
		harness.addConnection.mockImplementation(async connection => {
			order.push('add');
			return { id: 'sql_aad', ...connection };
		});
		harness.updateLastConnectionId.mockImplementation(async () => { order.push('selection'); });
		harness.getConnections.mockImplementation(() => {
			order.push('connections');
			return harness.currentConnections;
		});
		harness.postMessage.mockImplementation(() => {
			order.push('post');
			return Promise.resolve(true);
		});

		await harness.handler.handleMessage({ type: 'promptAddSqlConnection', boxId: 'sql-aad-box' });

		expect(prompts.showInputBox.mock.calls).toEqual([
			[{
				prompt: 'SQL Server address',
				placeHolder: 'myserver.database.windows.net',
				ignoreFocusOut: true,
			}],
			[{
				prompt: 'Connection name (optional)',
				placeHolder: 'aad.database.windows.net',
				ignoreFocusOut: true,
			}],
		]);
		expect(prompts.showQuickPick).toHaveBeenCalledWith([
			{ label: 'Azure AD (default)', id: 'aad' },
			{ label: 'SQL Login (username/password)', id: 'sql-login' },
		], { placeHolder: 'Authentication type', ignoreFocusOut: true });
		expect(harness.addConnection).toHaveBeenCalledWith({
			name: 'aad.database.windows.net',
			dialect: 'mssql',
			serverUrl: 'aad.database.windows.net',
			authType: 'aad',
			username: undefined,
		}, undefined);
		expect(harness.updateLastConnectionId).toHaveBeenCalledWith('sql_aad');
		expect(harness.globalStateUpdate).toHaveBeenCalledWith('sql.lastConnectionId', 'sql_aad');
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlConnectionAdded',
			boxId: 'sql-aad-box',
			connectionId: 'sql_aad',
			connections: harness.currentConnections,
		});
		expect(order).toEqual(['add', 'selection', 'connections', 'post']);
	});

	it('preserves SQL Login prompts and passes the untrimmed password only as the separate manager argument', async () => {
		const harness = createHarness();
		const prompts = installPrompts(
			['  login.database.windows.net  ', '  sql-user  ', '  secret value  ', '  Login connection  '],
			{ label: 'SQL Login (username/password)', id: 'sql-login' },
		);

		await harness.handler.handleMessage({ type: 'promptAddSqlConnection', boxId: 'sql-login-box' });

		expect(prompts.showInputBox.mock.calls).toEqual([
			[{
				prompt: 'SQL Server address',
				placeHolder: 'myserver.database.windows.net',
				ignoreFocusOut: true,
			}],
			[{
				prompt: 'Username',
				placeHolder: 'sa',
				ignoreFocusOut: true,
			}],
			[{
				prompt: 'Password',
				password: true,
				ignoreFocusOut: true,
			}],
			[{
				prompt: 'Connection name (optional)',
				placeHolder: 'login.database.windows.net',
				ignoreFocusOut: true,
			}],
		]);
		expect(harness.addConnection).toHaveBeenCalledWith({
			name: 'Login connection',
			dialect: 'mssql',
			serverUrl: 'login.database.windows.net',
			authType: 'sql-login',
			username: '  sql-user  ',
		}, '  secret value  ');
		const persistedConnection = harness.addConnection.mock.calls[0][0];
		expect(persistedConnection).not.toHaveProperty('password');
		expect(JSON.stringify(harness.postMessage.mock.calls)).not.toContain('secret value');
	});

	it('keeps blank direct adds response-free and side-effect-free', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'addSqlConnection', name: 'Ignored', serverUrl: '   ', dialect: 'mssql', authType: 'aad',
		});

		expect(harness.addConnection).not.toHaveBeenCalled();
		expect(harness.updateLastConnectionId).not.toHaveBeenCalled();
		expect(harness.getConnections).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('trims direct name and server, applies defaults, and preserves every optional manager input', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'addSqlConnection',
			name: '   ',
			serverUrl: '  direct.database.windows.net  ',
			dialect: '',
			authType: '',
			database: '  Sales Database  ',
			port: 1444,
			username: '  direct-user  ',
			password: 'direct-secret',
			boxId: 'sql-direct-box',
		});

		expect(harness.addConnection).toHaveBeenCalledWith({
			name: 'direct.database.windows.net',
			dialect: 'mssql',
			serverUrl: 'direct.database.windows.net',
			authType: 'aad',
			username: '  direct-user  ',
			port: 1444,
			database: '  Sales Database  ',
		}, 'direct-secret');
		expect(harness.updateLastConnectionId).toHaveBeenCalledWith('sql_added');
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlConnectionAdded',
			boxId: 'sql-direct-box',
			connectionId: 'sql_added',
			connections: harness.currentConnections,
		});
		expect(JSON.stringify(harness.postMessage.mock.calls)).not.toContain('direct-secret');
	});

	it.each(['manager', 'selection', 'connections', 'transport'] as const)(
		'propagates the exact %s rejection and stops later effects', async stage => {
		const failure = new Error(`${stage} rejected`);
		const harness = createHarness();
		if (stage === 'manager') harness.addConnection.mockRejectedValue(failure);
		else if (stage === 'selection') harness.updateLastConnectionId.mockRejectedValue(failure);
		else if (stage === 'connections') harness.getConnections.mockImplementation(() => { throw failure; });
		else harness.postMessage.mockImplementation(() => { throw failure; });

		await expect(harness.handler.handleMessage({
			type: 'addSqlConnection',
			name: 'Rejected',
			serverUrl: 'rejected.database.windows.net',
			dialect: 'mssql',
			authType: 'aad',
		})).rejects.toBe(failure);

		if (stage === 'manager') expect(harness.updateLastConnectionId).not.toHaveBeenCalled();
		if (stage === 'manager' || stage === 'selection') expect(harness.getConnections).not.toHaveBeenCalled();
		if (stage !== 'transport') expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('does not await the existing fire-and-forget acknowledgement transport', async () => {
		const transport = deferred<boolean>();
		const postMessage = vi.fn(() => transport.promise);
		const harness = createHarness({ postMessage });
		let settled = false;
		const request = harness.handler.handleMessage({
			type: 'addSqlConnection',
			name: 'Transport',
			serverUrl: 'transport.database.windows.net',
			dialect: 'mssql',
			authType: 'aad',
		})!;
		void request.then(() => { settled = true; });

		await vi.waitFor(() => expect(settled).toBe(true));
		expect(postMessage).toHaveBeenCalledOnce();
		transport.resolve(true);
	});

	it('lets accepted success settle across idempotent disposal and suppresses later onboarding requests', async () => {
		const addition = deferred<SqlConnection>();
		const selection = deferred<void>();
		const harness = createHarness();
		harness.addConnection.mockReturnValueOnce(addition.promise);
		harness.updateLastConnectionId.mockReturnValueOnce(selection.promise);
		const accepted = harness.handler.handleMessage({
			type: 'addSqlConnection',
			name: 'Accepted',
			serverUrl: 'accepted.database.windows.net',
			dialect: 'mssql',
			authType: 'aad',
			boxId: 'accepted-box',
		})!;
		await vi.waitFor(() => expect(harness.addConnection).toHaveBeenCalledOnce());

		harness.handler.dispose();
		harness.handler.dispose();
		addition.resolve({
			id: 'sql_accepted', name: 'Accepted', dialect: 'mssql',
			serverUrl: 'accepted.database.windows.net', authType: 'aad',
		});
		await vi.waitFor(() => expect(harness.updateLastConnectionId).toHaveBeenCalledWith('sql_accepted'));
		selection.resolve();
		await accepted;

		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlConnectionAdded',
			boxId: 'accepted-box',
			connectionId: 'sql_accepted',
			connections: harness.currentConnections,
		});
		const prompts = installPrompts(['later.database.windows.net'], { label: 'Azure AD (default)', id: 'aad' });
		await harness.handler.handleMessage({ type: 'promptAddSqlConnection', boxId: 'later-prompt' });
		await harness.handler.handleMessage({
			type: 'addSqlConnection', name: 'Later', serverUrl: 'later.database.windows.net', dialect: 'mssql', authType: 'aad',
		});
		expect(prompts.showInputBox).not.toHaveBeenCalled();
		expect(prompts.showQuickPick).not.toHaveBeenCalled();
		expect(harness.addConnection).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledOnce();
	});

	it('preserves an accepted rejection across disposal and suppresses later related work', async () => {
		const addition = deferred<SqlConnection>();
		const failure = new Error('accepted manager failure');
		const harness = createHarness();
		harness.addConnection.mockReturnValueOnce(addition.promise);
		const accepted = harness.handler.handleMessage({
			type: 'addSqlConnection', name: 'Rejected', serverUrl: 'rejected.database.windows.net', dialect: 'mssql', authType: 'aad',
		})!;
		await vi.waitFor(() => expect(harness.addConnection).toHaveBeenCalledOnce());

		harness.handler.dispose();
		addition.reject(failure);
		await expect(accepted).rejects.toBe(failure);
		await expect(harness.handler.handleMessage({
			type: 'addSqlConnection', name: 'Later', serverUrl: 'later.database.windows.net', dialect: 'mssql', authType: 'aad',
		})).resolves.toBeUndefined();
		expect(harness.addConnection).toHaveBeenCalledOnce();
		expect(harness.updateLastConnectionId).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});
});
