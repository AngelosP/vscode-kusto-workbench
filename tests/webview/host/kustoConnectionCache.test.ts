import { describe, expect, it } from 'vitest';
import { KustoConnectionCache, LEGACY_ACCOUNT_PARTITION } from '../../../src/host/kustoConnectionCache';

function harness(initial: Record<string, unknown> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		values,
		cache: new KustoConnectionCache({
			globalState: {
				get: <T>(key: string) => values.get(key) as T,
				update: async (key: string, value: unknown) => { values.set(key, value); },
			},
		} as any),
	};
}

describe('KustoConnectionCache', () => {
	it('isolates database lists by connection and account partition', async () => {
		const test = harness();
		await test.cache.setDatabases('conn-1', 'account-a', ['DbA']);
		await test.cache.setDatabases('conn-1', 'account-b', ['DbB']);
		await test.cache.setDatabases('conn-2', 'account-a', ['DbC']);

		expect(test.cache.getDatabases('conn-1', 'account-a', false)).toEqual(['DbA']);
		expect(test.cache.getDatabases('conn-1', 'account-b', false)).toEqual(['DbB']);
		expect(test.cache.getDatabases('conn-2', 'account-a', false)).toEqual(['DbC']);
	});

	it('never replaces a nonempty principal cache with an empty discovery result', async () => {
		const test = harness();
		await test.cache.setDatabases('conn-1', 'account-a', ['VisibleDb']);
		expect(await test.cache.setDatabases('conn-1', 'account-a', [])).toBe(false);
		expect(test.cache.getDatabases('conn-1', 'account-a', false)).toEqual(['VisibleDb']);
	});

	it('serializes writes across cache instances that share global state', async () => {
		const values = new Map<string, unknown>();
		const context = {
			globalState: {
				get: <T>(key: string) => values.get(key) as T,
				update: async (key: string, value: unknown) => {
					await Promise.resolve();
					values.set(key, value);
				},
			},
		} as any;
		const first = new KustoConnectionCache(context);
		const second = new KustoConnectionCache(context);

		await Promise.all([
			first.setDatabases('conn-1', 'account-a', ['DbA']),
			second.setDatabases('conn-2', 'account-b', ['DbB']),
		]);

		expect(first.getDatabases('conn-1', 'account-a', false)).toEqual(['DbA']);
		expect(first.getDatabases('conn-2', 'account-b', false)).toEqual(['DbB']);
	});

	it('migrates a unique ordinary legacy cluster cache but not authority or ambiguous matches', async () => {
		const test = harness({
			'kusto.cachedDatabases': {
				unique: ['UniqueDb'],
				ambiguous: ['AmbiguousDb'],
				tenant: ['TenantDb'],
			},
		});
		await test.cache.migrateLegacy([
			{ id: 'unique-conn', name: 'Unique', clusterUrl: 'https://unique.kusto.windows.net' },
			{ id: 'ambiguous-a', name: 'A', clusterUrl: 'https://ambiguous.kusto.windows.net' },
			{ id: 'ambiguous-b', name: 'B', clusterUrl: 'https://ambiguous.kusto.windows.net' },
			{ id: 'tenant-conn', name: 'Tenant', clusterUrl: 'https://tenant.kusto.windows.net', authorityId: 'contoso.com' },
		] as any);

		expect(test.cache.getDatabases('unique-conn', undefined, true)).toEqual(['UniqueDb']);
		expect(test.cache.getDatabases('ambiguous-a', undefined, true)).toEqual([]);
		expect(test.cache.getDatabases('tenant-conn', undefined, true)).toEqual([]);
		expect(test.cache.getEntries()).toContainEqual(expect.objectContaining({ accountPartition: LEGACY_ACCOUNT_PARTITION }));
	});

	it('clears only one connection or account partition', async () => {
		const test = harness();
		await test.cache.setDatabases('conn-1', 'account-a', ['A']);
		await test.cache.setDatabases('conn-1', 'account-b', ['B']);
		await test.cache.setDatabases('conn-2', 'account-a', ['C']);
		await test.cache.clearAccountPartition('account-a');

		expect(test.cache.getDatabases('conn-1', 'account-a', false)).toEqual([]);
		expect(test.cache.getDatabases('conn-1', 'account-b', false)).toEqual(['B']);
		expect(test.cache.getDatabases('conn-2', 'account-a', false)).toEqual([]);
	});

	it('rejects an old-generation write after Clear All and retires legacy storage', async () => {
		const test = harness({
			'kusto.cachedDatabases': { legacy: ['LegacyDb'] },
		});
		const oldGeneration = test.cache.captureGeneration();

		await test.cache.clearAll();
		expect(await test.cache.setDatabases('conn-1', 'account-a', ['LateDb'], oldGeneration)).toBe(false);

		expect(test.cache.getDatabases('conn-1', 'account-a', false)).toEqual([]);
		expect(test.values.get('kusto.cachedDatabases')).toBeUndefined();
	});

	it('does not migrate a stale legacy snapshot after a queued Clear All', async () => {
		const test = harness({
			'kusto.cachedDatabases': { unique: ['LegacyDb'] },
		});

		const clear = test.cache.clearAll();
		const migration = test.cache.migrateLegacy([
			{ id: 'unique-conn', name: 'Unique', clusterUrl: 'https://unique.kusto.windows.net' },
		] as any);
		await Promise.all([clear, migration]);

		expect(test.cache.getDatabases('unique-conn', undefined, true)).toEqual([]);
		expect(test.values.get('kusto.cachedDatabases')).toBeUndefined();
	});

	it('does not reveal a retired legacy entry after forgetting the principal partition', async () => {
		const test = harness({
			'kusto.cachedDatabases': { unique: ['LegacyDb'] },
		});
		await test.cache.migrateLegacy([
			{ id: 'unique-conn', name: 'Unique', clusterUrl: 'https://unique.kusto.windows.net' },
		] as any);
		expect(test.cache.getDatabases('unique-conn', undefined, true)).toEqual(['LegacyDb']);

		await test.cache.setDatabases('unique-conn', 'account-a', ['PrincipalDb']);
		await test.cache.clearAccountPartition('account-a');

		expect(test.cache.getDatabases('unique-conn', undefined, true)).toEqual([]);
	});

	it('does not invalidate connection A writes when connection B is cleared', async () => {
		const test = harness();
		const generationA = test.cache.captureGeneration('conn-a', 'partition-a');

		await test.cache.clearConnection('conn-b');
		expect(await test.cache.setDatabases('conn-a', 'partition-a', ['DbA'], generationA)).toBe(true);

		expect(test.cache.getDatabases('conn-a', 'partition-a', false)).toEqual(['DbA']);
	});
});