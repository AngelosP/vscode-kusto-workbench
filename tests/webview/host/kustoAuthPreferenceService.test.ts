import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { KustoAuthPreferenceService } from '../../../src/host/kustoAuthPreferenceService';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(candidate => { resolve = candidate; });
	return { promise, resolve };
}

function harness(initialGlobalState: Record<string, unknown> = {}, onSessionsChanged?: (listener: (event: any) => void) => void) {
	const globalState = new Map(Object.entries(initialGlobalState));
	const secrets = new Map<string, string>();
	const context = {
		globalState: {
			get: <T>(key: string, fallback?: T) => globalState.has(key) ? globalState.get(key) as T : fallback,
			update: vi.fn(async (key: string, value: unknown) => {
				if (value === undefined) globalState.delete(key);
				else globalState.set(key, value);
			}),
		},
		secrets: {
			keys: vi.fn(async () => [...secrets.keys()]),
			get: vi.fn(async (key: string) => secrets.get(key)),
			store: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
			delete: vi.fn(async (key: string) => { secrets.delete(key); }),
		},
		subscriptions: [],
	} as any;
	if (onSessionsChanged) {
		vi.spyOn(vscode.authentication, 'onDidChangeSessions').mockImplementation(listener => {
			onSessionsChanged(listener);
			return { dispose: vi.fn() };
		});
	}
	return { context, globalState, secrets, service: new KustoAuthPreferenceService(context) };
}

describe('KustoAuthPreferenceService', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(vscode.authentication, 'getAccounts').mockResolvedValue([]);
	});

	it('keeps explicit account selection profile-local and exact', async () => {
		const test = harness();
		await test.service.setExplicitAccount('conn-1', { id: 'account-1', label: 'user@example.com' });

		expect(test.service.getPreference('conn-1')).toEqual({ mode: 'explicit', accountId: 'account-1' });
		expect(test.service.getPreferredAccountId('conn-1')).toBe('account-1');
		expect(JSON.stringify(test.globalState.get('kusto.auth.connectionPreferences.v1'))).not.toContain('user@example.com');
	});

	it('records automatic success but never rewrites a different explicit account', async () => {
		const test = harness();
		await test.service.recordSuccessfulAccount('automatic', { id: 'account-a', label: 'a@example.com' });
		await test.service.setExplicitAccount('explicit', { id: 'account-b', label: 'b@example.com' });
		await test.service.recordSuccessfulAccount('explicit', { id: 'account-c', label: 'c@example.com' });

		expect(test.service.getPreference('automatic')).toEqual({ mode: 'automatic', lastSuccessfulAccountId: 'account-a' });
		expect(test.service.getPreference('explicit')).toEqual({ mode: 'explicit', accountId: 'account-b' });
	});

	it('distinguishes first automatic account establishment from account rotation', async () => {
		const test = harness();
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));

		await test.service.recordSuccessfulAccount('conn-1', { id: 'account-a', label: 'a@example.com' }, 'partition-a');
		await test.service.recordSuccessfulAccount('conn-1', { id: 'account-b', label: 'b@example.com' }, 'partition-b');

		expect(changes).toEqual([
			{
				connectionIds: ['conn-1'], reason: 'success', accountId: 'account-a',
				accountPartition: 'partition-a', firstEstablishment: true,
			},
			{
				connectionIds: ['conn-1'], reason: 'success', accountId: 'account-b',
				accountPartition: 'partition-b', firstEstablishment: false,
			},
		]);
	});

	it('does not invalidate an establishing run when its Microsoft session is added', async () => {
		let listener!: (event: any) => void;
		const accounts: Array<{ id: string; label: string }> = [];
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		const test = harness({}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));

		accounts.push({ id: 'account-a', label: 'a@example.com' });
		listener({ provider: { id: 'microsoft' } });
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledTimes(2));

		expect(changes).toEqual([]);
	});

	it('does not reinterpret an overlapping no-details event as rotation after first mapping is recorded', async () => {
		let listener!: (event: any) => void;
		const initialAccounts = deferred<readonly { id: string; label: string }[]>();
		vi.mocked(vscode.authentication.getAccounts)
			.mockReturnValueOnce(initialAccounts.promise)
			.mockResolvedValueOnce([{ id: 'account-a', label: 'a@example.com' }]);
		const test = harness({}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));

		listener({ provider: { id: 'microsoft' } });
		await test.service.recordSuccessfulAccount(
			'conn-a', { id: 'account-a', label: 'a@example.com' }, 'partition-a',
		);
		initialAccounts.resolve([{ id: 'account-a', label: 'a@example.com' }]);

		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledTimes(2));
		expect(changes).toEqual([{
			connectionIds: ['conn-a'], reason: 'success', accountId: 'account-a',
			accountPartition: 'partition-a', firstEstablishment: true,
		}]);
	});

	it('contains provider account refresh failures without publishing invalidation', async () => {
		vi.mocked(vscode.authentication.getAccounts).mockRejectedValueOnce(new Error('provider unavailable'));
		const test = harness();
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));

		await Promise.resolve();
		await Promise.resolve();

		expect(changes).toEqual([]);
		expect(test.service.getPreference('conn-1')).toEqual({ mode: 'automatic' });
	});

	it('invalidates a mapped connection when removal follows a failed initial account baseline', async () => {
		let listener!: (event: any) => void;
		vi.mocked(vscode.authentication.getAccounts)
			.mockRejectedValueOnce(new Error('provider unavailable'))
			.mockRejectedValueOnce(new Error('provider still unavailable'));
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'automatic', lastSuccessfulAccountId: 'account-a' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await Promise.resolve();
		await Promise.resolve();

		listener({
			provider: { id: 'microsoft' }, added: [], changed: [],
			removed: [{ account: { id: 'account-a', label: 'a@example.com' } }],
		});

		await vi.waitFor(() => expect(changes).toEqual([{ connectionIds: ['conn-a'], reason: 'sessions-changed' }]));
	});

	it('targets only connections mapped to a removed Microsoft account', async () => {
		let listener!: (event: any) => void;
		const accounts = [
			{ id: 'account-a', label: 'a@example.com' },
			{ id: 'account-b', label: 'b@example.com' },
		];
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'automatic', lastSuccessfulAccountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());

		accounts.splice(0, 1);
		listener({ provider: { id: 'microsoft' } });

		await vi.waitFor(() => expect(changes).toEqual([{ connectionIds: ['conn-a'], reason: 'sessions-changed' }]));
	});

	it('targets mapped connections when a Microsoft session changes under the same account ID', async () => {
		let listener!: (event: any) => void;
		const accounts = [{ id: 'account-a', label: 'a@example.com' }];
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'automatic', lastSuccessfulAccountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());

		listener({ provider: { id: 'microsoft' } });

		await vi.waitFor(() => expect(changes).toEqual([{ connectionIds: ['conn-a'], reason: 'sessions-changed' }]));
	});

	it('scopes a detailed same-set session change to the named Microsoft account', async () => {
		let listener!: (event: any) => void;
		const accounts = [
			{ id: 'account-a', label: 'a@example.com' },
			{ id: 'account-b', label: 'b@example.com' },
		];
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'explicit', accountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());

		listener({
			provider: { id: 'microsoft' }, added: [], removed: [],
			changed: [{ account: { id: 'account-a', label: 'a@example.com' } }],
		});

		await vi.waitFor(() => expect(changes).toEqual([{ connectionIds: ['conn-a'], reason: 'sessions-changed' }]));
	});

	it('invalidates a named changed account when the same provider event adds another account', async () => {
		let listener!: (event: any) => void;
		const accounts = [{ id: 'account-a', label: 'a@example.com' }];
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'explicit', accountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());

		accounts.push({ id: 'account-b', label: 'b@example.com' });
		listener({
			provider: { id: 'microsoft' },
			added: [{ account: { id: 'account-b', label: 'b@example.com' } }],
			removed: [],
			changed: [{ account: { id: 'account-a', label: 'a@example.com' } }],
		});

		await vi.waitFor(() => expect(changes).toEqual([{ connectionIds: ['conn-a'], reason: 'sessions-changed' }]));
	});

	it('unions removed and named changed accounts from one provider event', async () => {
		let listener!: (event: any) => void;
		const accounts = [
			{ id: 'account-a', label: 'a@example.com' },
			{ id: 'account-c', label: 'c@example.com' },
		];
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'explicit', accountId: 'account-a' },
				'conn-c': { mode: 'explicit', accountId: 'account-c' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());

		accounts.splice(1, 1);
		listener({
			provider: { id: 'microsoft' },
			added: [],
			removed: [{ account: { id: 'account-c', label: 'c@example.com' } }],
			changed: [{ account: { id: 'account-a', label: 'a@example.com' } }],
		});

		await vi.waitFor(() => expect(changes).toEqual([{
			connectionIds: ['conn-a', 'conn-c'], reason: 'sessions-changed',
		}]));
	});

	it('invalidates a same-ID Microsoft session that is removed and re-added in one event', async () => {
		let listener!: (event: any) => void;
		const accounts = [
			{ id: 'account-a', label: 'a@example.com' },
			{ id: 'account-b', label: 'b@example.com' },
		];
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'explicit', accountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());

		listener({
			provider: { id: 'microsoft' },
			removed: [{ account: { id: 'account-a', label: 'a@example.com' } }],
			added: [{ account: { id: 'account-a', label: 'a@example.com' } }],
			changed: [],
		});

		await vi.waitFor(() => expect(changes).toEqual([{
			connectionIds: ['conn-a'], reason: 'sessions-changed',
		}]));
	});

	it('uses observed session IDs to scope a production-shaped A recreation without revoking B', async () => {
		let listener!: (event: any) => void;
		const accounts = [
			{ id: 'account-a', label: 'a@example.com' },
			{ id: 'account-b', label: 'b@example.com' },
		];
		const sessions = new Map([
			['account-a', { id: 'session-a-1', account: accounts[0], accessToken: 'token-a-1', scopes: [] }],
			['account-b', { id: 'session-b-1', account: accounts[1], accessToken: 'token-b-1', scopes: [] }],
		]);
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		vi.spyOn(vscode.authentication, 'getSession').mockImplementation(async (_provider, _scopes, options: any) =>
			sessions.get(String(options?.account?.id || '')) as any);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'explicit', accountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());
		test.service.observeProviderSession(sessions.get('account-a') as any, ['scope']);
		test.service.observeProviderSession(sessions.get('account-b') as any, ['scope']);
		sessions.set('account-a', { id: 'session-a-2', account: accounts[0], accessToken: 'token-a-2', scopes: [] });

		listener({ provider: { id: 'microsoft' } });

		await vi.waitFor(() => expect(changes).toEqual([{
			connectionIds: ['conn-a'], reason: 'sessions-changed',
		}]));
		expect(test.service.getProviderSessionGeneration('account-a')).toBe(1);
		expect(test.service.getProviderSessionGeneration('account-b')).toBe(0);
	});

	it('does not broaden invalidation when A replacement is observed before provider refresh', async () => {
		let listener!: (event: any) => void;
		const accounts = [
			{ id: 'account-a', label: 'a@example.com' },
			{ id: 'account-b', label: 'b@example.com' },
		];
		const sessionA1 = { id: 'session-a-1', account: accounts[0], accessToken: 'token-a-1', scopes: [] };
		const sessionA2 = { id: 'session-a-2', account: accounts[0], accessToken: 'token-a-2', scopes: [] };
		const sessionB = { id: 'session-b-1', account: accounts[1], accessToken: 'token-b', scopes: [] };
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		vi.spyOn(vscode.authentication, 'getSession').mockImplementation(async (_provider, _scopes, options: any) =>
			String(options?.account?.id) === 'account-a' ? sessionA2 as any : sessionB as any);
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'explicit', accountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());
		test.service.observeProviderSession(sessionA1 as any, ['scope']);
		test.service.observeProviderSession(sessionB as any, ['scope']);

		listener({ provider: { id: 'microsoft' } });
		test.service.observeProviderSession(sessionA2 as any, ['scope']);
		await test.service.waitForProviderAccountRefresh();

		expect(changes).toEqual([{ connectionIds: ['conn-a'], reason: 'sessions-changed' }]);
		expect(test.service.getProviderSessionGeneration('account-a')).toBe(1);
		expect(test.service.getProviderSessionGeneration('account-b')).toBe(0);
	});

	it('does not treat first use of a second Kusto authority as account recreation', async () => {
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'home': { mode: 'explicit', accountId: 'account-a' },
				'guest': { mode: 'explicit', accountId: 'account-a' },
			},
		});
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		const account = { id: 'account-a', label: 'a@example.com' };

		test.service.observeProviderSession({ id: 'session-home', account, accessToken: 'home', scopes: [] } as any, ['scope']);
		test.service.observeProviderSession({ id: 'session-guest', account, accessToken: 'guest', scopes: [] } as any, ['scope', 'VSCODE_TENANT:guest']);

		expect(test.service.getProviderSessionGeneration('account-a')).toBe(0);
		expect(changes).toEqual([]);
	});

	it('advances only A when the provider refreshes its token under the same session ID', async () => {
		let listener!: (event: any) => void;
		const accounts = [
			{ id: 'account-a', label: 'a@example.com' },
			{ id: 'account-b', label: 'b@example.com' },
		];
		let tokenA = 'token-a-1';
		vi.mocked(vscode.authentication.getAccounts).mockImplementation(async () => [...accounts]);
		vi.spyOn(vscode.authentication, 'getSession').mockImplementation(async (_provider, _scopes, options: any) => {
			const account = String(options?.account?.id) === 'account-a' ? accounts[0] : accounts[1];
			return { id: `session-${account.id}`, account, accessToken: account.id === 'account-a' ? tokenA : 'token-b', scopes: [] } as any;
		});
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'conn-a': { mode: 'explicit', accountId: 'account-a' },
				'conn-b': { mode: 'explicit', accountId: 'account-b' },
			},
		}, candidate => { listener = candidate; });
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));
		await vi.waitFor(() => expect(vscode.authentication.getAccounts).toHaveBeenCalledOnce());
		test.service.observeProviderSession({ id: 'session-account-a', account: accounts[0], accessToken: tokenA, scopes: [] } as any, ['scope']);
		test.service.observeProviderSession({ id: 'session-account-b', account: accounts[1], accessToken: 'token-b', scopes: [] } as any, ['scope']);
		tokenA = 'token-a-2';

		listener({ provider: { id: 'microsoft' } });
		await test.service.waitForProviderAccountRefresh();

		expect(changes).toEqual([{ connectionIds: ['conn-a'], reason: 'sessions-changed' }]);
		expect(test.service.getProviderSessionGeneration('account-a')).toBe(1);
		expect(test.service.getProviderSessionGeneration('account-b')).toBe(0);
	});

	it('migrates the old cluster map only when exactly one connection owns the endpoint', async () => {
		const endpoint = 'https://same.kusto.windows.net';
		const uniqueEndpoint = 'https://unique.kusto.windows.net';
		const test = harness({ 'kusto.auth.clusterAccountMap': { [endpoint]: 'legacy-account', [uniqueEndpoint]: 'unique-account' } });
		await test.service.migrateLegacyMappings([
			{ id: 'conn-1', name: 'One', clusterUrl: endpoint },
			{ id: 'conn-2', name: 'Two', clusterUrl: endpoint, authorityId: 'contoso.com' },
			{ id: 'unique', name: 'Unique', clusterUrl: uniqueEndpoint },
		] as any);

		expect(test.service.getPreference('conn-1')).toEqual({ mode: 'automatic' });
		expect(test.service.getPreference('conn-2')).toEqual({ mode: 'automatic' });
		expect(test.service.getPreference('unique')).toEqual({ mode: 'automatic', legacyAccountId: 'unique-account' });
	});

	it('serializes concurrent preference writes without losing either connection', async () => {
		const test = harness();
		await Promise.all([
			test.service.setExplicitAccount('conn-1', { id: 'account-1', label: 'one@example.com' }),
			test.service.setExplicitAccount('conn-2', { id: 'account-2', label: 'two@example.com' }),
		]);

		expect(test.service.getPreferredAccountId('conn-1')).toBe('account-1');
		expect(test.service.getPreferredAccountId('conn-2')).toBe('account-2');
	});

	it('assigns one explicit account to multiple connections in one state write', async () => {
		const test = harness();
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));

		await test.service.setExplicitAccounts(
			['conn-1', 'conn-2', 'conn-1'],
			{ id: 'account-1', label: 'one@example.com' },
		);

		expect(test.service.getPreferredAccountId('conn-1')).toBe('account-1');
		expect(test.service.getPreferredAccountId('conn-2')).toBe('account-1');
		expect(test.context.globalState.update).toHaveBeenCalledWith(
			'kusto.auth.connectionPreferences.v1',
			{
				'conn-1': { mode: 'explicit', accountId: 'account-1' },
				'conn-2': { mode: 'explicit', accountId: 'account-1' },
			},
		);
		expect(changes).toEqual([{
			connectionIds: ['conn-1', 'conn-2'], reason: 'selection', accountId: 'account-1',
		}]);
	});

	it('isolates account partitions and token overrides by authority', async () => {
		const test = harness();
		const homePartition = test.service.getAccountPartition(undefined, 'account-1');
		const guestPartition = test.service.getAccountPartition('contoso.com', 'account-1');
		expect(homePartition).not.toBe(guestPartition);

		await test.service.setTokenOverride(undefined, 'account-1', 'home-token');
		await test.service.setTokenOverride('contoso.com', 'account-1', 'guest-token');
		expect(await test.service.getTokenOverride(undefined, 'account-1')).toBe('home-token');
		expect(await test.service.getTokenOverride('contoso.com', 'account-1')).toBe('guest-token');
	});

	it('emits override changes only for supplied matching connection IDs', async () => {
		const test = harness();
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));

		await test.service.setTokenOverride(undefined, 'account-1', 'token', ['connection-a']);

		expect(changes).toContainEqual(expect.objectContaining({
			reason: 'override',
			connectionIds: ['connection-a'],
			accountId: 'account-1',
		}));
	});

	it('clears legacy default-authority overrides so they cannot resurface', async () => {
		const test = harness();
		test.secrets.set('kusto.auth.tokenOverride.account-1', 'legacy-token');
		expect(await test.service.getTokenOverride(undefined, 'account-1')).toBe('legacy-token');

		await test.service.setTokenOverride(undefined, 'account-1', 'current-token');
		expect(test.secrets.has('kusto.auth.tokenOverride.account-1')).toBe(false);
		expect(await test.service.getTokenOverride(undefined, 'account-1')).toBe('current-token');

		test.secrets.set('kusto.auth.tokenOverride.account-1', 'legacy-again');
		await test.service.clearTokenOverride(undefined, 'account-1');
		expect(await test.service.getTokenOverride(undefined, 'account-1')).toBeUndefined();
	});

	it('forgets only mappings and secrets that reference the chosen account', async () => {
		const test = harness();
		await test.service.setExplicitAccount('remove', { id: 'account-1', label: 'one@example.com' });
		await test.service.setExplicitAccount('keep', { id: 'account-2', label: 'two@example.com' });
		await test.service.setTokenOverride(undefined, 'account-1', 'secret-one');
		await test.service.setTokenOverride(undefined, 'account-2', 'secret-two');

		await test.service.forgetAccount('account-1');

		expect(test.service.getPreference('remove')).toEqual({ mode: 'automatic' });
		expect(test.service.getPreference('keep')).toEqual({ mode: 'explicit', accountId: 'account-2' });
		expect(await test.service.getTokenOverride(undefined, 'account-1')).toBeUndefined();
		expect(await test.service.getTokenOverride(undefined, 'account-2')).toBe('secret-two');
	});

	it('reports an unmapped forgotten account without claiming every connection', async () => {
		const test = harness({
			'kusto.auth.connectionPreferences.v1': {
				'active': { mode: 'automatic', lastSuccessfulAccountId: 'account-active' },
			},
		});
		const changes: unknown[] = [];
		test.service.onDidChange(change => changes.push(change));

		await test.service.forgetAccount('account-historical');

		expect(changes).toContainEqual({
			connectionIds: [], reason: 'account-forgotten', accountId: 'account-historical',
		});
		expect(test.service.getPreference('active')).toEqual({
			mode: 'automatic', lastSuccessfulAccountId: 'account-active',
		});
	});

	it('merges provider accounts with historical accounts without exposing tokens', async () => {
		const test = harness({
			'kusto.auth.knownAccounts': [{ id: 'known', label: 'known@example.com', lastUsedAt: 2 }],
		});
		vi.spyOn(vscode.authentication, 'getAccounts').mockResolvedValue([
			{ id: 'provider', label: 'provider@example.com' },
		]);

		expect(await test.service.getAccounts()).toEqual([
			{ id: 'known', label: 'known@example.com', lastUsedAt: 2 },
			{ id: 'provider', label: 'provider@example.com', lastUsedAt: 0 },
		]);
	});
});