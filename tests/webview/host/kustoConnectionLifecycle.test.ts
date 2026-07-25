import { describe, expect, it, vi } from 'vitest';

import type { KustoConnectionChange } from '../../../src/host/connectionManager';
import {
	getIdentityInvalidatedConnectionIds,
	KustoConnectionLifecycle,
} from '../../../src/host/kustoConnectionLifecycle';

class FakeEvent<T> {
	private readonly listeners = new Set<(value: T) => void>();
	readonly event = (listener: (value: T) => void) => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	fire(value: T): void {
		for (const listener of [...this.listeners]) listener(value);
	}
}

const original = {
	id: 'c1', name: 'Original', clusterUrl: 'https://cluster.kusto.windows.net', authorityId: 'common',
};

describe('KustoConnectionLifecycle', () => {
	it('classifies only physical identity changes as invalidating updates', () => {
		expect(getIdentityInvalidatedConnectionIds({
			type: 'updated', previous: original, connection: { ...original, name: 'Renamed' },
		})).toEqual([]);
		expect(getIdentityInvalidatedConnectionIds({
			type: 'updated', previous: original,
			connection: { ...original, clusterUrl: 'https://other.kusto.windows.net' },
		})).toEqual(['c1']);
		expect(getIdentityInvalidatedConnectionIds({
			type: 'updated', previous: original,
			connection: { ...original, authorityId: 'organizations' },
		})).toEqual(['c1']);
		expect(getIdentityInvalidatedConnectionIds({
			type: 'updated', previous: { ...original, authorityId: 'legacy invalid authority' },
			connection: { ...original, authorityId: 'legacy invalid authority', name: 'Renamed' },
		})).toEqual(['c1']);
	});

	it('publishes invalidation before a serialized refreshed snapshot', async () => {
		const events = new FakeEvent<KustoConnectionChange>();
		const order: string[] = [];
		const lifecycle = new KustoConnectionLifecycle({
			onDidChangeConnections: events.event,
		} as any, {
			invalidateConnections: ids => order.push(`invalidate:${ids.join(',')}`),
			publishIdentityChange: async ids => { order.push(`publish:${ids.join(',')}`); },
			refreshConnections: async () => { order.push('refresh'); },
		});

		events.fire({ type: 'removed', connection: original });
		await vi.waitFor(() => expect(order).toEqual(['invalidate:c1', 'publish:c1', 'refresh']));
		lifecycle.dispose();
	});

	it('does not publish queued events after disposal', async () => {
		const events = new FakeEvent<KustoConnectionChange>();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const refresh = vi.fn(async () => gate);
		const publish = vi.fn(async () => undefined);
		const lifecycle = new KustoConnectionLifecycle({ onDidChangeConnections: events.event } as any, {
			invalidateConnections: vi.fn(), publishIdentityChange: publish, refreshConnections: refresh,
		});

		events.fire({ type: 'added', connection: original });
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		events.fire({ type: 'removed', connection: original });
		lifecycle.dispose();
		release();
		await Promise.resolve();
		await Promise.resolve();

		expect(publish).not.toHaveBeenCalled();
	});

	it('refreshes the connection snapshot when invalidation publication fails', async () => {
		const events = new FakeEvent<KustoConnectionChange>();
		const refresh = vi.fn(async () => undefined);
		const lifecycle = new KustoConnectionLifecycle({ onDidChangeConnections: events.event } as any, {
			invalidateConnections: vi.fn(),
			publishIdentityChange: vi.fn(async () => { throw new Error('publish failed'); }),
			refreshConnections: refresh,
		});

		events.fire({ type: 'removed', connection: original });
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
		lifecycle.dispose();
	});
});