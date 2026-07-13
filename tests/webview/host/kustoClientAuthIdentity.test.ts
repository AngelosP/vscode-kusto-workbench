import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	KustoQueryClient,
	type KustoAuthContext,
} from '../../../src/host/kustoClient';
import type { KustoConnection } from '../../../src/host/connectionManager';
import { KustoAuthPreferenceService } from '../../../src/host/kustoAuthPreferenceService';

const CONNECTION: KustoConnection = {
	id: 'conn-1',
	name: 'Guest tenant cluster',
	clusterUrl: 'https://example.kusto.windows.net',
};

function authContext(accountId: string, overrides: Partial<KustoAuthContext> = {}): KustoAuthContext {
	return {
		connectionId: CONNECTION.id,
		connectionIdentityKey: CONNECTION.clusterUrl,
		clusterEndpoint: CONNECTION.clusterUrl,
		scopes: ['https://kusto.kusto.windows.net/.default'],
		account: { id: accountId, label: `${accountId}@example.com` },
		accountId,
		accountPartition: `partition-${accountId}`,
		preferenceMode: 'automatic',
		...overrides,
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('KustoQueryClient auth identity', () => {
	it('passes the normalized tenant scope and exact account to Microsoft authentication', async () => {
		const client = new KustoQueryClient();
		const account = { id: 'account-1', label: 'user@example.com' };
		const session = { id: 'session-1', accessToken: 'token', account, scopes: [] } as any;
		const getSession = vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue(session);

		const result = await (client as any).requestSession(
			{ ...CONNECTION, authorityId: 'CONTOSO.ONMICROSOFT.COM' },
			{ mode: 'explicit', accountId: account.id },
			account,
			{ interactiveIfNeeded: false },
		);

		expect(result.session).toBe(session);
		expect(getSession).toHaveBeenCalledWith(
			'microsoft',
			['https://kusto.kusto.windows.net/.default', 'VSCODE_TENANT:contoso.onmicrosoft.com'],
			{ silent: true, account },
		);
	});

	it('rejects a provider session for a different explicit account', async () => {
		const client = new KustoQueryClient();
		const requested = { id: 'account-1', label: 'one@example.com' };
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({
			id: 'session-2',
			accessToken: 'token',
			account: { id: 'account-2', label: 'two@example.com' },
			scopes: [],
		} as any);

		await expect((client as any).requestSession(
			CONNECTION,
			{ mode: 'explicit', accountId: requested.id },
			requested,
			{ interactiveIfNeeded: false },
		)).rejects.toThrow('different account');
	});

	it('advances past a zero-database result in automatic mode', async () => {
		const client = new KustoQueryClient();
		const firstClient = { id: 'first', close: vi.fn() };
		const secondClient = { id: 'second' };
		(client as any).authContextByClient.set(firstClient, authContext('account-1'));
		(client as any).getOrCreateClient = vi.fn(async () => firstClient);
		(client as any).getAccountCandidates = vi.fn(async () => [{ id: 'account-2', label: 'two@example.com' }]);
		(client as any).requestSession = vi.fn(async () => ({
			session: {
				id: 'session-2',
				accessToken: 'token',
				account: { id: 'account-2', label: 'two@example.com' },
				scopes: [],
			},
			interactive: false,
		}));
		(client as any).createClientEntry = vi.fn(async () => ({
			client: secondClient,
			auth: authContext('account-2'),
		}));
		const operation = vi.fn(async (sdkClient: { id: string }) => ({
			client: sdkClient.id,
			hasDatabases: sdkClient === secondClient,
		}));

		await expect((client as any).executeWithAuthRetry(
			CONNECTION,
			operation,
			{
				allowInteractive: false,
				isSuccessfulResult: (result: { hasDatabases: boolean }) => result.hasDatabases,
			},
		)).resolves.toEqual({ client: 'second', hasDatabases: true });
		expect(operation).toHaveBeenCalledTimes(2);
		expect(firstClient.close).toHaveBeenCalledOnce();
	});

	it('returns a zero-database fallback with the account partition that produced it', async () => {
		const client = new KustoQueryClient();
		const accountAClient = { id: 'account-a-client', close: vi.fn() };
		(client as any).authContextByClient.set(accountAClient, authContext('account-a'));
		(client as any).getOrCreateClient = vi.fn(async () => accountAClient);
		(client as any).getAccountCandidates = vi.fn(async () => [{ id: 'account-b', label: 'b@example.com' }]);
		(client as any).requestSession = vi.fn(async () => ({
			session: { id: 'session-b', accessToken: 'token-b', account: { id: 'account-b', label: 'b@example.com' }, scopes: [] },
			interactive: false,
		}));
		(client as any).createClientEntry = vi.fn(async () => ({
			client: { id: 'account-b-client' },
			auth: authContext('account-b'),
		}));
		const operation = vi.fn(async (sdkClient: { id: string }) => {
			if (sdkClient.id === 'account-b-client') throw Object.assign(new Error('forbidden'), { statusCode: 403 });
			return { databases: [] as string[] };
		});
		let operationAuth: KustoAuthContext | undefined;

		const result = await (client as any).executeWithAuthRetry(
			CONNECTION,
			operation,
			{
				allowInteractive: false,
				onClient: (_sdkClient: unknown, auth: KustoAuthContext) => { operationAuth = auth; },
				isSuccessfulResult: (response: { databases: string[] }) => response.databases.length > 0,
			},
		);

		expect(result).toEqual({ databases: [] });
		expect(operationAuth?.accountPartition).toBe('partition-account-a');
	});

	it('reports an all-zero automatic discovery under the active account partition', async () => {
		const client = new KustoQueryClient();
		const emptyResponse = {
			primaryResults: [{ columns: [{ name: 'DatabaseName' }], rows: function* rows() { /* empty */ } }],
		};
		const accountAClient = { id: 'account-a-client', close: vi.fn(), execute: vi.fn(async () => emptyResponse) };
		const accountBClient = { id: 'account-b-client', close: vi.fn(), execute: vi.fn(async () => emptyResponse) };
		(client as any).getPreference = vi.fn(() => ({ mode: 'automatic', lastSuccessfulAccountId: 'account-a' }));
		(client as any).getAccountPartition = vi.fn(() => 'partition-account-a');
		(client as any).authContextByClient.set(accountAClient, authContext('account-a'));
		(client as any).getOrCreateClient = vi.fn(async () => accountAClient);
		(client as any).getAccountCandidates = vi.fn(async () => [{ id: 'account-b', label: 'b@example.com' }]);
		(client as any).requestSession = vi.fn(async () => ({
			session: { id: 'session-b', accessToken: 'token-b', account: { id: 'account-b', label: 'b@example.com' }, scopes: [] },
			interactive: false,
		}));
		(client as any).createClientEntry = vi.fn(async () => ({ client: accountBClient, auth: authContext('account-b') }));
		(client as any).createRequestProperties = vi.fn(async () => ({ clientRequestId: 'show-databases' }));
		(client as any).executeWithAuthRetry = KustoQueryClient.prototype['executeWithAuthRetry'].bind(client);

		await expect(client.getDatabasesWithIdentity(CONNECTION, true, { allowInteractive: false })).resolves.toEqual(expect.objectContaining({
			databases: [],
			accountPartition: 'partition-account-a',
		}));
	});

	it('cancels an accepted result when authentication changes during success persistence', async () => {
		const client = new KustoQueryClient();
		const sdkClient = { id: 'selected' };
		(client as any).authContextByClient.set(sdkClient, authContext('account-1'));
		(client as any).getOrCreateClient = vi.fn(async () => sdkClient);
		(client as any).getAccountCandidates = vi.fn(async () => []);
		const persistence = deferred<void>();
		(client as any).authPreferences = {
			getPreference: vi.fn(() => ({ mode: 'automatic' })),
			recordSuccessfulAccount: vi.fn(async () => persistence.promise),
		};

		const operation = (client as any).executeWithAuthRetry(
			CONNECTION,
			async () => ({ ok: true }),
			{ allowInteractive: false },
		);
		await Promise.resolve();
		await Promise.resolve();
		(client as any).bumpConnectionRevision(CONNECTION.id);
		persistence.resolve();

		await expect(operation).rejects.toMatchObject({ name: 'QueryCancelledError' });
	});

	it('adopts a provider session change emitted while acquiring the exact client', async () => {
		const client = new KustoQueryClient();
		const sdkClient = { id: 'selected' };
		(client as any).authContextByClient.set(sdkClient, authContext('account-1'));
		(client as any).getOrCreateClient = vi.fn(async () => {
			(client as any).authRevision++;
			return sdkClient;
		});
		(client as any).getAccountCandidates = vi.fn(async () => []);

		await expect((client as any).executeWithAuthRetry(
			CONNECTION,
			async () => ({ ok: true }),
			{ allowInteractive: false, persistAuthSuccess: false },
		)).resolves.toEqual({ ok: true });
	});

	it('lets the operation establishing account B succeed while cancelling an older account A operation', async () => {
		const client = new KustoQueryClient();
		const accountAClient = { id: 'account-a-client' };
		const accountBClient = { id: 'account-b-client' };
		(client as any).authContextByClient.set(accountAClient, authContext('account-a'));
		(client as any).authContextByClient.set(accountBClient, authContext('account-b'));
		(client as any).getOrCreateClient = vi.fn()
			.mockResolvedValueOnce(accountAClient)
			.mockResolvedValueOnce(accountBClient);
		(client as any).getAccountCandidates = vi.fn(async () => []);
		(client as any).authPreferences = {
			getPreference: vi.fn(() => ({ mode: 'automatic' })),
			recordSuccessfulAccount: vi.fn(async (_connectionId: string, account: { id: string }) => {
				if (account.id !== 'account-b') return false;
				(client as any).authRevision++;
				(client as any).bumpConnectionRevision(CONNECTION.id);
				return true;
			}),
		};
		const accountAResult = deferred<{ account: string }>();

		const olderAOperation = (client as any).executeWithAuthRetry(
			CONNECTION,
			async () => accountAResult.promise,
			{ allowInteractive: false },
		);
		await Promise.resolve();
		await Promise.resolve();
		const establishingBOperation = (client as any).executeWithAuthRetry(
			CONNECTION,
			async () => ({ account: 'account-b' }),
			{ allowInteractive: false },
		);

		await expect(establishingBOperation).resolves.toEqual({ account: 'account-b' });
		accountAResult.resolve({ account: 'account-a' });
		await expect(olderAOperation).rejects.toMatchObject({ name: 'QueryCancelledError' });
	});

	it('scopes account mutation cancellation to the affected account', async () => {
		const client = new KustoQueryClient();
		const sdkClient = { id: 'account-a-client' };
		(client as any).authContextByClient.set(sdkClient, authContext('account-a'));
		(client as any).getOrCreateClient = vi.fn(async () => sdkClient);
		(client as any).getAccountCandidates = vi.fn(async () => []);
		(client as any).authPreferences = {
			getPreference: vi.fn(() => ({ mode: 'automatic', lastSuccessfulAccountId: 'account-a' })),
			recordSuccessfulAccount: vi.fn(async () => false),
		};

		const unaffected = deferred<{ ok: boolean }>();
		const unaffectedOperation = (client as any).executeWithAuthRetry(CONNECTION, async () => unaffected.promise, { allowInteractive: false });
		await Promise.resolve();
		(client as any).bumpAccountRevision('account-b');
		unaffected.resolve({ ok: true });
		await expect(unaffectedOperation).resolves.toEqual({ ok: true });

		const affected = deferred<{ ok: boolean }>();
		const affectedStarted = deferred<void>();
		const affectedOperation = (client as any).executeWithAuthRetry(CONNECTION, async () => {
			affectedStarted.resolve();
			return affected.promise;
		}, { allowInteractive: false });
		await affectedStarted.promise;
		(client as any).bumpAccountRevision('account-a');
		affected.resolve({ ok: true });
		await expect(affectedOperation).rejects.toMatchObject({ name: 'QueryCancelledError' });
	});

	it('does not cancel another connection when a scoped override changes for the same account', async () => {
		const globalState = new Map<string, unknown>();
		const secrets = new Map<string, string>();
		const context = {
			globalState: {
				get: <T>(key: string, fallback?: T) => globalState.has(key) ? globalState.get(key) as T : fallback,
				update: async (key: string, value: unknown) => { globalState.set(key, value); },
			},
			secrets: {
				keys: async () => [...secrets.keys()],
				get: async (key: string) => secrets.get(key),
				store: async (key: string, value: string) => { secrets.set(key, value); },
				delete: async (key: string) => { secrets.delete(key); },
			},
			globalStorageUri: vscode.Uri.file('/scoped-override-test'),
			subscriptions: [],
		} as any;
		const client = new KustoQueryClient(context);
		const sdkClient = { id: 'connection-b-client' };
		(client as any).authContextByClient.set(sdkClient, authContext('account-a'));
		(client as any).getOrCreateClient = vi.fn(async () => sdkClient);
		(client as any).getAccountCandidates = vi.fn(async () => []);
		const result = deferred<{ ok: boolean }>();
		const started = deferred<void>();
		const operation = (client as any).executeWithAuthRetry(CONNECTION, async () => {
			started.resolve();
			return result.promise;
		}, { allowInteractive: false, persistAuthSuccess: false });
		await started.promise;

		await KustoAuthPreferenceService.getInstance(context).setTokenOverride(undefined, 'account-a', 'token-a', ['connection-a']);
		result.resolve({ ok: true });

		await expect(operation).resolves.toEqual({ ok: true });
		client.dispose();
	});

	it('returns zero databases without changing identity in explicit mode', async () => {
		const client = new KustoQueryClient();
		const selectedClient = { id: 'selected' };
		(client as any).getPreference = vi.fn(() => ({ mode: 'explicit', accountId: 'account-1' }));
		(client as any).authContextByClient.set(selectedClient, authContext('account-1', { preferenceMode: 'explicit' }));
		(client as any).getOrCreateClient = vi.fn(async () => selectedClient);
		const requestSession = vi.fn();
		(client as any).requestSession = requestSession;

		await expect((client as any).executeWithAuthRetry(
			CONNECTION,
			async () => ({ hasDatabases: false }),
			{
				allowInteractive: true,
				isSuccessfulResult: (result: { hasDatabases: boolean }) => result.hasDatabases,
			},
		)).resolves.toEqual({ hasDatabases: false });
		expect(requestSession).not.toHaveBeenCalled();
	});

	it('uses the captured authority and account for server-side cancellation', async () => {
		const client = new KustoQueryClient();
		const captured = authContext('account-1', {
			authorityId: 'contoso.com',
			scopes: ['https://kusto.kusto.windows.net/.default', 'VSCODE_TENANT:contoso.com'],
		});
		const session = { id: 'session-1', accessToken: 'token', account: captured.account, scopes: [] } as any;
		const requestSession = vi.fn(async () => ({ session, interactive: false }));
		const execute = vi.fn(async () => undefined);
		const close = vi.fn();
		(client as any).requestSession = requestSession;
		(client as any).createClientEntry = vi.fn(async () => ({ client: { execute, close }, auth: captured }));
		(client as any).createRequestProperties = vi.fn(async () => ({ clientRequestId: 'cancel-1' }));

		await (client as any).cancelQueryByClientActivityId(CONNECTION, 'Db', 'activity-1', 'Stop', captured);

		expect(requestSession).toHaveBeenCalledWith(
			expect.objectContaining({ authorityId: 'contoso.com' }),
			{ mode: 'explicit', accountId: 'account-1' },
			captured.account,
			{ interactiveIfNeeded: false },
		);
		expect(execute).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('serializes all waiters on the same auth identity', async () => {
		const client = new KustoQueryClient();
		const first = deferred<void>();
		const order: string[] = [];
		const firstRun = (client as any).withAuthLock('identity', async () => {
			order.push('first-start');
			await first.promise;
			order.push('first-end');
		});
		const secondRun = (client as any).withAuthLock('identity', async () => { order.push('second'); });
		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(['first-start']);
		first.resolve();
		await Promise.all([firstRun, secondRun]);
		expect(order).toEqual(['first-start', 'first-end', 'second']);
	});

	it('closes ordinary and cancelable SDK clients exactly once on dispose', () => {
		const client = new KustoQueryClient();
		const ordinary = { close: vi.fn() };
		const cancelable = { close: vi.fn() };
		(client as any).clients.set('conn', { client: ordinary, auth: authContext('account-1') });
		(client as any).cancelableClientsByKey.set('run', { client: cancelable, auth: authContext('account-1') });

		client.dispose();
		client.dispose();

		expect(ordinary.close).toHaveBeenCalledOnce();
		expect(cancelable.close).toHaveBeenCalledOnce();
	});
});