import { describe, expect, it, vi } from 'vitest';
import { clearAllKustoConnectionsAndFavorites } from '../../../src/host/extension';

describe('Delete All Kusto Connections cleanup', () => {
	it('clears all principal-owned favorites after removing connections', async () => {
		const values = new Map<string, unknown>([['kusto.favorites', [
			{ connectionId: 'c1', database: 'A', accountPartition: 'partition-a' },
			{ connectionId: 'c1', database: 'B', accountPartition: 'partition-b' },
		]]]);
		const context = {
			globalState: {
				get: <T>(key: string) => values.get(key) as T,
				update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
			},
		} as any;
		const connectionManager = { clearConnections: vi.fn(async () => 2) };

		await expect(clearAllKustoConnectionsAndFavorites(context, connectionManager as any)).resolves.toBe(2);
		expect(values.get('kusto.favorites')).toEqual([]);
	});
});