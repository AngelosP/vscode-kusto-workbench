import { describe, expect, it, vi } from 'vitest';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';

describe('QueryRunCoordinator', () => {
	it('allocates one monotonic sequence across boxes and cancellation', () => {
		const coordinator = new QueryRunCoordinator();
		const cancel = vi.fn();

		expect(coordinator.nextSequence()).toBe(1);
		coordinator.register('query-a', { cancel, runSeq: 1 });
		coordinator.cancelAll();

		expect(coordinator.nextSequence()).toBe(2);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('replaces an entry without cancelling it', () => {
		const coordinator = new QueryRunCoordinator();
		const oldCancel = vi.fn();
		const newCancel = vi.fn();

		coordinator.register('query-1', { cancel: oldCancel, runSeq: 1 });
		coordinator.register('query-1', { cancel: newCancel, runSeq: 2 });

		expect(oldCancel).not.toHaveBeenCalled();
		expect(coordinator.get('query-1')).toEqual({ cancel: newCancel, runSeq: 2 });
	});

	it('installs a replacement before cancelling the previous entry', () => {
		const coordinator = new QueryRunCoordinator();
		const reservationCancel = vi.fn();
		const previousCancel = vi.fn(() => {
			expect(coordinator.get('query-1')).toEqual({
				cancel: reservationCancel, runSeq: 2, executionId: 'reserved',
			});
		});
		coordinator.register('query-1', { cancel: previousCancel, runSeq: 1, executionId: 'previous' });

		expect(coordinator.replaceAndCancel('query-1', {
			cancel: reservationCancel, runSeq: 2, executionId: 'reserved',
		})).toEqual({ cancel: previousCancel, runSeq: 1, executionId: 'previous' });
		expect(previousCancel).toHaveBeenCalledOnce();
		expect(reservationCancel).not.toHaveBeenCalled();
	});

	it('preserves a reentrant newer owner created while previous cancellation runs', () => {
		const coordinator = new QueryRunCoordinator();
		const newerCancel = vi.fn();
		const reservationCancel = vi.fn();
		const previousCancel = vi.fn(() => {
			coordinator.register('query-1', { cancel: newerCancel, runSeq: 3, executionId: 'newer' });
		});
		coordinator.register('query-1', { cancel: previousCancel, runSeq: 1, executionId: 'previous' });

		coordinator.replaceAndCancel('query-1', {
			cancel: reservationCancel, runSeq: 2, executionId: 'reserved',
		});

		expect(coordinator.get('query-1')).toEqual({ cancel: newerCancel, runSeq: 3, executionId: 'newer' });
		expect(reservationCancel).not.toHaveBeenCalled();
		expect(newerCancel).not.toHaveBeenCalled();
	});

	it('atomically promotes only the exact current preflight identity', () => {
		const coordinator = new QueryRunCoordinator();
		const preflightCancel = vi.fn();
		const transportCancel = vi.fn();
		coordinator.register('query-1', {
			cancel: preflightCancel,
			runSeq: 7,
			executionId: 'execution-1',
		});

		expect(coordinator.replaceIfCurrent('query-1', preflightCancel, 7, {
			cancel: transportCancel,
			runSeq: 7,
			clientActivityId: 'activity-1',
			executionId: 'execution-1',
		})).toBe(true);
		expect(coordinator.get('query-1')).toEqual({
			cancel: transportCancel,
			runSeq: 7,
			clientActivityId: 'activity-1',
			executionId: 'execution-1',
		});
		expect(preflightCancel).not.toHaveBeenCalled();
		expect(transportCancel).not.toHaveBeenCalled();
	});

	it('does not resurrect a preflight superseded before transport promotion', () => {
		const coordinator = new QueryRunCoordinator();
		const oldPreflightCancel = vi.fn();
		const currentCancel = vi.fn();
		const staleTransportCancel = vi.fn();
		coordinator.register('query-1', { cancel: oldPreflightCancel, runSeq: 7, executionId: 'old' });
		coordinator.register('query-1', { cancel: currentCancel, runSeq: 8, executionId: 'current' });

		expect(coordinator.replaceIfCurrent('query-1', oldPreflightCancel, 7, {
			cancel: staleTransportCancel,
			runSeq: 7,
			executionId: 'old',
		})).toBe(false);
		expect(coordinator.get('query-1')).toEqual({ cancel: currentCancel, runSeq: 8, executionId: 'current' });
		expect(oldPreflightCancel).not.toHaveBeenCalled();
		expect(currentCancel).not.toHaveBeenCalled();
		expect(staleTransportCancel).not.toHaveBeenCalled();
	});

	it('unregisters only the exact cancel and sequence identity', () => {
		const coordinator = new QueryRunCoordinator();
		const oldCancel = vi.fn();
		const currentCancel = vi.fn();
		coordinator.register('query-1', { cancel: currentCancel, runSeq: 2 });

		expect(coordinator.unregister('query-1', oldCancel, 2)).toBe(false);
		expect(coordinator.unregister('query-1', currentCancel, 1)).toBe(false);
		expect(coordinator.has('query-1')).toBe(true);
		expect(coordinator.unregister('query-1', currentCancel, 2)).toBe(true);
		expect(coordinator.has('query-1')).toBe(false);
	});

	it('retires an entry before invoking cancellation and preserves metadata', () => {
		const coordinator = new QueryRunCoordinator();
		const cancel = vi.fn(() => expect(coordinator.has('sql-1')).toBe(false));
		coordinator.register('sql-1', {
			cancel,
			runSeq: 7,
			clientActivityId: 'activity-1',
			executionId: 'execution-1',
		});

		expect(coordinator.cancel('sql-1')).toEqual({
			cancel,
			runSeq: 7,
			clientActivityId: 'activity-1',
			executionId: 'execution-1',
		});
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('swallows cancellation failures and continues cancelling other boxes', () => {
		const coordinator = new QueryRunCoordinator();
		const firstCancel = vi.fn(() => { throw new Error('cancel failed'); });
		const secondCancel = vi.fn();
		coordinator.register('query-a', { cancel: firstCancel, runSeq: 1 });
		coordinator.register('query-b', { cancel: secondCancel, runSeq: 2 });

		expect(() => coordinator.cancelAll()).not.toThrow();
		expect(firstCancel).toHaveBeenCalledOnce();
		expect(secondCancel).toHaveBeenCalledOnce();
		expect(coordinator.has('query-a')).toBe(false);
		expect(coordinator.has('query-b')).toBe(false);
	});

	it('retires the full cancel-all snapshot before callbacks and preserves reentrant registrations', () => {
		const coordinator = new QueryRunCoordinator();
		const replacementCancel = vi.fn();
		const firstCancel = vi.fn(() => {
			expect(coordinator.has('query-a')).toBe(false);
			expect(coordinator.has('query-b')).toBe(false);
			coordinator.register('query-c', { cancel: replacementCancel, runSeq: 3 });
		});
		const secondCancel = vi.fn(() => {
			expect(coordinator.has('query-a')).toBe(false);
			expect(coordinator.has('query-b')).toBe(false);
		});
		coordinator.register('query-a', { cancel: firstCancel, runSeq: 1 });
		coordinator.register('query-b', { cancel: secondCancel, runSeq: 2 });

		coordinator.cancelAll();

		expect(firstCancel).toHaveBeenCalledOnce();
		expect(secondCancel).toHaveBeenCalledOnce();
		expect(coordinator.has('query-c')).toBe(true);
		expect(replacementCancel).not.toHaveBeenCalled();
	});
});