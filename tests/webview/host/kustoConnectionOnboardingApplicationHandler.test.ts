import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KustoConnection } from '../../../src/host/connectionManager';
import {
	HostKustoConnectionOnboardingApplicationHandler,
	type KustoConnectionOnboardingApplicationHandlerOptions,
} from '../../../src/host/kustoConnectionOnboardingApplicationHandler';

const liveHandlers = new Set<HostKustoConnectionOnboardingApplicationHandler>();

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHarness(overrides: Partial<KustoConnectionOnboardingApplicationHandlerOptions> = {}) {
	let lastConnectionId: string | undefined;
	let lastDatabase: string | undefined;
	const addConnection = vi.fn(async (connection: Omit<KustoConnection, 'id'>) => ({
		id: 'connection-added',
		...connection,
	}));
	const getAccounts = vi.fn(async () => [
		{ id: 'account-known', label: 'Known account', lastUsedAt: 10 },
	]);
	const setExplicitAccount = vi.fn(async () => undefined);
	const getDatabases = vi.fn(async () => ['Samples']);
	const isAuthenticationError = vi.fn(() => false);
	const withTransientAuthPreference = vi.fn(async (
		_connection: KustoConnection,
		_preference: { mode: string; accountId?: string },
		operation: () => Promise<string[]>,
	) => operation());
	const saveLastSelection = vi.fn(async (connectionId: string, database?: string) => {
		lastConnectionId = connectionId;
		lastDatabase = database;
	});
	const getLastSelection = vi.fn(() => ({ lastConnectionId, lastDatabase }));
	const postMessage = vi.fn(() => Promise.resolve(true));
	const refreshConnections = vi.fn(async () => undefined);
	const output = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		show: vi.fn(),
		log: vi.fn(),
	};
	const options: KustoConnectionOnboardingApplicationHandlerOptions = {
		connectionManager: { addConnection },
		authPreferences: { getAccounts, setExplicitAccount },
		kustoClient: { getDatabases, isAuthenticationError, withTransientAuthPreference },
		saveLastSelection,
		getLastSelection,
		postMessage,
		refreshConnections,
		output,
		...overrides,
	};
	const handler = new HostKustoConnectionOnboardingApplicationHandler(options);
	liveHandlers.add(handler);
	return {
		handler,
		addConnection,
		getAccounts,
		setExplicitAccount,
		getDatabases,
		isAuthenticationError,
		withTransientAuthPreference,
		saveLastSelection,
		getLastSelection,
		postMessage,
		refreshConnections,
		output,
	};
}

describe('HostKustoConnectionOnboardingApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.restoreAllMocks();
	});

	it('declines unrelated Kusto and SQL traffic synchronously', () => {
		const harness = createHarness();

		expect(harness.handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(harness.handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(harness.postMessage).not.toHaveBeenCalled();
		expect(harness.addConnection).not.toHaveBeenCalled();
		expect(harness.getDatabases).not.toHaveBeenCalled();
	});

	it('opens the canonical dialog with the exact optional box identity and no other effect', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({ type: 'promptAddConnection', boxId: 'query-prompt' });

		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'openKustoAddConnectionDialog', boxId: 'query-prompt',
		});
		expect(harness.addConnection).not.toHaveBeenCalled();
		expect(harness.refreshConnections).not.toHaveBeenCalled();
	});

	it('keeps a blank add request response-free and side-effect-free', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'addConnection', name: 'Ignored', clusterUrl: '   ', boxId: 'query-blank',
		});

		expect(harness.addConnection).not.toHaveBeenCalled();
		expect(harness.getAccounts).not.toHaveBeenCalled();
		expect(harness.saveLastSelection).not.toHaveBeenCalled();
		expect(harness.refreshConnections).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('normalizes and persists an explicit-account connection in exact order before success', async () => {
		const order: string[] = [];
		const harness = createHarness();
		harness.addConnection.mockImplementation(async connection => {
			order.push('add');
			return { id: 'connection-1', ...connection, database: 'ManagerDatabase' };
		});
		harness.getAccounts.mockImplementation(async () => {
			order.push('accounts');
			return [{ id: 'account-known', label: 'Known account', lastUsedAt: 10 }];
		});
		harness.setExplicitAccount.mockImplementation(async () => { order.push('account'); });
		harness.saveLastSelection.mockImplementation(async () => { order.push('selection'); });
		harness.refreshConnections.mockImplementation(async () => { order.push('refresh'); });
		harness.getLastSelection.mockImplementation(() => {
			order.push('read-selection');
			return { lastConnectionId: 'connection-1', lastDatabase: 'ManagerDatabase' };
		});
		harness.postMessage.mockImplementation(() => {
			order.push('post');
			return Promise.resolve(true);
		});

		await harness.handler.handleMessage({
			type: 'addConnection',
			name: '  Friendly name  ',
			clusterUrl: '  Help.Kusto.Windows.Net  ',
			database: '  InputDatabase  ',
			authorityId: '  TENANT.ONMICROSOFT.COM  ',
			accountId: '  account-known  ',
			boxId: 'query-add',
		});

		expect(harness.addConnection).toHaveBeenCalledWith({
			name: 'Friendly name',
			clusterUrl: 'https://Help.Kusto.Windows.Net',
			database: 'InputDatabase',
			authorityId: 'tenant.onmicrosoft.com',
		});
		expect(harness.setExplicitAccount).toHaveBeenCalledWith('connection-1', {
			id: 'account-known', label: 'Known account', lastUsedAt: 10,
		});
		expect(harness.saveLastSelection).toHaveBeenCalledWith('connection-1', 'ManagerDatabase');
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'connectionAdded',
			boxId: 'query-add',
			connectionId: 'connection-1',
			lastConnectionId: 'connection-1',
			lastDatabase: 'ManagerDatabase',
		});
		expect(order).toEqual(['add', 'accounts', 'account', 'selection', 'refresh', 'read-selection', 'post']);
	});

	it('uses normalized defaults and a fallback explicit account without changing account ownership', async () => {
		const harness = createHarness();
		harness.getAccounts.mockResolvedValue([]);

		await harness.handler.handleMessage({
			type: 'addConnection',
			name: ' ',
			clusterUrl: 'cluster.kusto.windows.net',
			database: ' ',
			accountId: 'missing-account',
		});

		expect(harness.addConnection).toHaveBeenCalledWith({
			name: 'https://cluster.kusto.windows.net',
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: undefined,
			authorityId: undefined,
		});
		expect(harness.setExplicitAccount).toHaveBeenCalledWith('connection-added', {
			id: 'missing-account', label: 'missing-account',
		});
	});

	it('does not enumerate or persist an account for automatic selection', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'addConnection', name: 'Cluster', clusterUrl: 'cluster.kusto.windows.net',
		});

		expect(harness.getAccounts).not.toHaveBeenCalled();
		expect(harness.setExplicitAccount).not.toHaveBeenCalled();
		expect(harness.saveLastSelection).toHaveBeenCalledOnce();
		expect(harness.refreshConnections).toHaveBeenCalledOnce();
	});

	it('returns the exact malformed-authority add terminal before persistence', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'addConnection',
			name: 'Cluster',
			clusterUrl: 'cluster.kusto.windows.net',
			authorityId: 'https://login.microsoftonline.com/tenant',
			boxId: 'query-authority',
		});

		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'kustoConnectionMutationResult',
			boxId: 'query-authority',
			success: false,
			message: 'Tenant / Authority ID must be a tenant GUID, tenant domain, common, consumers, or organizations.',
		});
		expect(harness.addConnection).not.toHaveBeenCalled();
		expect(harness.refreshConnections).not.toHaveBeenCalled();
	});

	it.each([
		'add',
		'accounts',
		'account',
		'selection',
		'refresh',
	] as const)('turns a %s-stage rejection into the exact mutation terminal and stops success', async stage => {
		const order: string[] = [];
		const failure = new Error(`${stage} failed`);
		const harness = createHarness();
		harness.addConnection.mockImplementation(async connection => {
			order.push('add');
			if (stage === 'add') throw failure;
			return { id: 'connection-1', ...connection };
		});
		harness.getAccounts.mockImplementation(async () => {
			order.push('accounts');
			if (stage === 'accounts') throw failure;
			return [{ id: 'account-known', label: 'Known', lastUsedAt: 1 }];
		});
		harness.setExplicitAccount.mockImplementation(async () => {
			order.push('account');
			if (stage === 'account') throw failure;
		});
		harness.saveLastSelection.mockImplementation(async () => {
			order.push('selection');
			if (stage === 'selection') throw failure;
		});
		harness.refreshConnections.mockImplementation(async () => {
			order.push('refresh');
			if (stage === 'refresh') throw failure;
		});

		await harness.handler.handleMessage({
			type: 'addConnection',
			name: 'Cluster',
			clusterUrl: 'cluster.kusto.windows.net',
			accountId: 'account-known',
			boxId: 'query-failure',
		});

		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'kustoConnectionMutationResult',
			boxId: 'query-failure',
			success: false,
			message: `${stage} failed`,
		});
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'connectionAdded' }));
		expect(order.at(-1)).toBe(stage);
	});

	it('returns the exact blank-cluster test terminal and traces invalid admission without starting', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: ' ', boxId: 'query-test-blank',
		});

		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'kustoConnectionTestResult',
			boxId: 'query-test-blank',
			success: false,
			message: 'Enter a cluster URL before testing.',
		});
		expect(harness.getDatabases).not.toHaveBeenCalled();
		expect(harness.output.trace).toHaveBeenCalledOnce();
		expect(harness.output.trace.mock.calls[0][0]).toContain('service.test.invalid-request reason=missing-cluster-url');
	});

	it('returns the exact malformed-authority test terminal before start or client work', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'testKustoConnection',
			clusterUrl: 'cluster.kusto.windows.net',
			authorityId: 'https://login.microsoftonline.com/tenant',
			boxId: 'query-test-authority',
		});

		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'kustoConnectionTestResult',
			boxId: 'query-test-authority',
			success: false,
			message: 'Tenant / Authority ID must be a tenant GUID, tenant domain, common, consumers, or organizations.',
		});
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kustoConnectionTestStarted' }));
		expect(harness.getDatabases).not.toHaveBeenCalled();
	});

	it('tests the exact normalized draft through an explicit transient preference and normalizes databases', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const harness = createHarness();
		harness.getDatabases.mockResolvedValue([' Samples ', '', ' Telemetry ', '   ']);

		await harness.handler.handleMessage({
			type: 'testKustoConnection',
			name: '  Draft cluster  ',
			clusterUrl: '  Draft.Kusto.Windows.Net  ',
			database: '  Samples  ',
			authorityId: '  TENANT.ONMICROSOFT.COM  ',
			accountId: '  account-explicit  ',
			boxId: 'query-test',
		});

		const expectedConnection = {
			id: 'draft:1700000000000:i',
			name: 'Draft cluster',
			clusterUrl: 'https://Draft.Kusto.Windows.Net',
			database: 'Samples',
			authorityId: 'tenant.onmicrosoft.com',
		};
		expect(harness.withTransientAuthPreference).toHaveBeenCalledWith(
			expectedConnection,
			{ mode: 'explicit', accountId: 'account-explicit' },
			expect.any(Function),
		);
		expect(harness.getDatabases).toHaveBeenCalledWith(expectedConnection, true, {
			allowInteractive: true,
			traceId: expect.any(String),
			source: 'query-editor-connection-test',
			persistIdentity: false,
		});
		expect(harness.postMessage).toHaveBeenNthCalledWith(1, {
			type: 'kustoConnectionTestStarted', boxId: 'query-test',
		});
		expect(harness.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'kustoConnectionTestResult',
			boxId: 'query-test',
			success: true,
			message: 'Connected successfully! Found 2 database(s).',
			databases: ['Samples', 'Telemetry'],
		});
		expect(harness.output.trace.mock.calls.map(call => call[0])).toEqual([
			expect.stringContaining('service.test.start'),
			expect.stringContaining('service.test.success'),
		]);
	});

	it('uses an automatic transient preference by default', async () => {
		const harness = createHarness();

		await harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: 'cluster.kusto.windows.net',
		});

		expect(harness.withTransientAuthPreference).toHaveBeenCalledWith(
			expect.objectContaining({ clusterUrl: 'https://cluster.kusto.windows.net' }),
			{ mode: 'automatic' },
			expect.any(Function),
		);
	});

	it('keeps the current direct-client fallback when transient preference support is unavailable', async () => {
		const getDatabases = vi.fn(async () => ['Fallback']);
		const harness = createHarness({
			kustoClient: { getDatabases, isAuthenticationError: vi.fn(() => false) },
		});

		await harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: 'fallback.kusto.windows.net', accountId: 'account-ignored-by-fallback',
		});

		expect(getDatabases).toHaveBeenCalledOnce();
		expect(harness.withTransientAuthPreference).not.toHaveBeenCalled();
		expect(harness.postMessage).toHaveBeenLastCalledWith({
			type: 'kustoConnectionTestResult',
			boxId: undefined,
			success: true,
			message: 'Connected successfully! Found 1 database(s).',
			databases: ['Fallback'],
		});
	});

	it('returns the exact connected-with-no-databases warning', async () => {
		const harness = createHarness();
		harness.getDatabases.mockResolvedValue([]);

		await harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: 'empty.kusto.windows.net', boxId: 'query-empty',
		});

		expect(harness.postMessage).toHaveBeenLastCalledWith({
			type: 'kustoConnectionTestResult',
			boxId: 'query-empty',
			success: false,
			warning: true,
			message: 'Connected, but no databases are visible. Check the Authority / Tenant ID and account.',
			databases: [],
		});
	});

	it.each([
		{ isAuthError: false, expected: 'Connection failed: database discovery failed' },
		{ isAuthError: true, expected: 'Authentication failed. Please sign in when prompted.' },
	])('returns the exact $expected failure and traces safe error details', async ({ isAuthError, expected }) => {
		const failure = Object.assign(new Error('database discovery failed'), {
			name: 'KustoServiceError', status: 401, code: 'AADSTS50020',
		});
		const harness = createHarness();
		harness.getDatabases.mockRejectedValue(failure);
		harness.isAuthenticationError.mockReturnValue(isAuthError);

		await harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: 'failure.kusto.windows.net', boxId: 'query-failure',
		});

		expect(harness.isAuthenticationError).toHaveBeenCalledWith(failure);
		expect(harness.postMessage).toHaveBeenLastCalledWith({
			type: 'kustoConnectionTestResult',
			boxId: 'query-failure',
			success: false,
			message: expected,
			isAuthError,
		});
		expect(harness.output.trace.mock.calls.at(-1)?.[0]).toContain('service.test.failed');
		expect(harness.output.trace.mock.calls.at(-1)?.[0]).toContain('isAuthError=' + isAuthError);
		expect(harness.output.trace.mock.calls.at(-1)?.[0]).toContain('status=401');
		expect(harness.output.trace.mock.calls.at(-1)?.[0]).toContain('code=AADSTS50020');
	});

	it('lets accepted add and test work settle across idempotent disposal, then suppresses later onboarding', async () => {
		const addition = deferred<KustoConnection>();
		const refresh = deferred<void>();
		const databases = deferred<string[]>();
		const harness = createHarness();
		harness.addConnection.mockReturnValueOnce(addition.promise);
		harness.refreshConnections.mockReturnValueOnce(refresh.promise);
		harness.getDatabases.mockReturnValueOnce(databases.promise);
		const acceptedAdd = harness.handler.handleMessage({
			type: 'addConnection', name: 'Accepted', clusterUrl: 'accepted.kusto.windows.net', boxId: 'accepted-add',
		})!;
		const acceptedTest = harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: 'accepted-test.kusto.windows.net', boxId: 'accepted-test',
		})!;
		await vi.waitFor(() => expect(harness.addConnection).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());

		harness.handler.dispose();
		harness.handler.dispose();
		addition.resolve({
			id: 'accepted-connection', name: 'Accepted', clusterUrl: 'https://accepted.kusto.windows.net',
		});
		databases.resolve(['AcceptedDatabase']);
		await vi.waitFor(() => expect(harness.refreshConnections).toHaveBeenCalledOnce());
		refresh.resolve();
		await Promise.all([acceptedAdd, acceptedTest]);

		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'connectionAdded', boxId: 'accepted-add', connectionId: 'accepted-connection',
		}));
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'kustoConnectionTestResult',
			boxId: 'accepted-test',
			success: true,
			message: 'Connected successfully! Found 1 database(s).',
			databases: ['AcceptedDatabase'],
		});
		const callsAfterAcceptedWork = harness.postMessage.mock.calls.length;

		await harness.handler.handleMessage({ type: 'promptAddConnection', boxId: 'later-prompt' });
		await harness.handler.handleMessage({
			type: 'addConnection', name: 'Later', clusterUrl: 'later.kusto.windows.net',
		});
		await harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: 'later.kusto.windows.net',
		});

		expect(harness.addConnection).toHaveBeenCalledOnce();
		expect(harness.getDatabases).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledTimes(callsAfterAcceptedWork);
	});

	it('publishes exact accepted add and test failure terminals after disposal', async () => {
		const addition = deferred<KustoConnection>();
		const databases = deferred<string[]>();
		const harness = createHarness();
		harness.addConnection.mockReturnValueOnce(addition.promise);
		harness.getDatabases.mockReturnValueOnce(databases.promise);
		const acceptedAdd = harness.handler.handleMessage({
			type: 'addConnection', name: 'Rejected', clusterUrl: 'rejected.kusto.windows.net', boxId: 'rejected-add',
		})!;
		const acceptedTest = harness.handler.handleMessage({
			type: 'testKustoConnection', clusterUrl: 'rejected-test.kusto.windows.net', boxId: 'rejected-test',
		})!;
		await vi.waitFor(() => expect(harness.addConnection).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());

		harness.handler.dispose();
		addition.reject(new Error('accepted add failed'));
		databases.reject(new Error('accepted test failed'));
		await Promise.all([acceptedAdd, acceptedTest]);

		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'kustoConnectionMutationResult',
			boxId: 'rejected-add',
			success: false,
			message: 'accepted add failed',
		});
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'kustoConnectionTestResult',
			boxId: 'rejected-test',
			success: false,
			message: 'Connection failed: accepted test failed',
			isAuthError: false,
		});
		expect(harness.refreshConnections).not.toHaveBeenCalled();
	});

	it('preserves an accepted prompt transport rejection exactly across disposal', async () => {
		const failure = new Error('prompt transport failed');
		const postMessage = vi.fn(() => { throw failure; });
		const harness = createHarness({ postMessage });
		const request = harness.handler.handleMessage({ type: 'promptAddConnection' })!;

		harness.handler.dispose();

		await expect(request).rejects.toBe(failure);
	});
});