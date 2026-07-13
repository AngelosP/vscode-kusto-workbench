import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { KustoAuthPreferenceService } from '../../../src/host/kustoAuthPreferenceService';

function harness(initialGlobalState: Record<string, unknown> = {}) {
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