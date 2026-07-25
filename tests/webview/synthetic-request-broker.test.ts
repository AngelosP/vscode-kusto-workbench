import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	SyntheticRequestBroker,
	SyntheticRequestDisposedError,
	SyntheticRequestTimeoutError,
} from '../../src/webview/core/synthetic-request-broker.js';

describe('SyntheticRequestBroker', () => {
	afterEach(() => vi.useRealTimers());

	it('times out requests and retains a bounded late-response tombstone', async () => {
		vi.useFakeTimers();
		const broker = new SyntheticRequestBroker<string, { connectionId: string }>({
			timeoutMs: 100,
			tombstoneTtlMs: 200,
		});
		const request = broker.begin('request-1', { connectionId: 'c1' });
		const rejection = expect(request).rejects.toBeInstanceOf(SyntheticRequestTimeoutError);

		await vi.advanceTimersByTimeAsync(100);
		await rejection;
		expect(broker.hasActive('request-1')).toBe(false);
		expect(broker.isSynthetic('request-1')).toBe(true);
		expect(broker.resolve('request-1', 'late')).toEqual({ kind: 'tombstone' });

		await vi.advanceTimersByTimeAsync(201);
		expect(broker.isSynthetic('request-1')).toBe(false);
	});

	it('settles active requests once and classifies duplicate delivery as synthetic', async () => {
		const broker = new SyntheticRequestBroker<string, { connectionId: string }>();
		const request = broker.begin('request-1', { connectionId: 'c1' });

		expect(broker.resolve('request-1', 'schema')).toEqual({
			kind: 'active',
			metadata: { connectionId: 'c1' },
		});
		await expect(request).resolves.toBe('schema');
		expect(broker.resolve('request-1', 'duplicate')).toEqual({ kind: 'tombstone' });
	});

	it('rejects replaced, capacity-evicted, and disposed requests', async () => {
		const broker = new SyntheticRequestBroker<string, undefined>({ maxActive: 1 });
		const first = broker.begin('request-1', undefined);
		const firstRejection = expect(first).rejects.toBeInstanceOf(SyntheticRequestDisposedError);
		const second = broker.begin('request-2', undefined);
		await firstRejection;
		const secondRejection = expect(second).rejects.toBeInstanceOf(SyntheticRequestDisposedError);
		broker.dispose();
		await secondRejection;
	});

	it('cancels active requests selected by metadata', async () => {
		const broker = new SyntheticRequestBroker<string, { connectionId: string }>();
		const first = broker.begin('request-1', { connectionId: 'c1' });
		const second = broker.begin('request-2', { connectionId: 'c2' });
		const rejection = expect(first).rejects.toThrow('identity changed');

		expect(broker.cancelWhere(metadata => metadata.connectionId === 'c1', new Error('identity changed'))).toBe(1);
		await rejection;
		expect(broker.hasActive('request-2')).toBe(true);
		broker.resolve('request-2', 'current');
		await expect(second).resolves.toBe('current');
	});
});
