import { describe, expect, it, vi } from 'vitest';

import { KustoExecutionCoordinator } from '../../../src/host/kustoExecutionCoordinator';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import type { KustoExecutionRequestIdentity } from '../../../src/shared/kustoExecution';

function request(executionId: string, targetGeneration = 1): KustoExecutionRequestIdentity {
	return {
		engine: 'kusto',
		boxId: 'query_1',
		sectionInstanceId: 'instance-1',
		targetGeneration,
		executionId,
		connectionId: 'connection-1',
		database: 'Samples',
		producer: 'manual',
	};
}

function createHarness() {
	const queryRuns = new QueryRunCoordinator();
	const postMessage = vi.fn(() => true);
	const coordinator = new KustoExecutionCoordinator({ queryRuns, postMessage });
	coordinator.openSection('query_1', 'instance-1');
	coordinator.adoptTarget({
		boxId: 'query_1', sectionInstanceId: 'instance-1', targetGeneration: 1,
		connectionId: 'connection-1', database: 'Samples',
	});
	return { coordinator, queryRuns, postMessage };
}

function result(label: string) {
	return {
		columns: ['label'], rows: [[label]],
		metadata: { cluster: 'https://cluster.kusto.windows.net', database: 'Samples', executionTime: '0.001s' },
	};
}

describe('KustoExecutionCoordinator', () => {
	it('reserves before awaits and atomically supersedes the previous transport', async () => {
		const harness = createHarness();
		const old = harness.coordinator.reserve(request('old'));
		const oldCancel = vi.fn();
		harness.coordinator.start(old, () => ({ cancel: oldCancel, promise: Promise.resolve(result('old')) }));

		const current = harness.coordinator.reserve(request('current'));
		await Promise.resolve();

		expect(oldCancel).toHaveBeenCalledOnce();
		expect(harness.coordinator.getActive('query_1')).toEqual(current);
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'old', reason: 'superseded',
		}));
	});

	it('rejects stale cancellation without disturbing the current execution', () => {
		const harness = createHarness();
		const current = harness.coordinator.reserve(request('current'));
		const cancel = vi.fn();
		harness.coordinator.start(current, () => ({ cancel, promise: Promise.resolve(result('current')) }));

		expect(harness.coordinator.cancelExpected(request('stale'))).toBe(false);
		expect(cancel).not.toHaveBeenCalled();
		expect(harness.coordinator.getActive('query_1')).toEqual(current);
	});

	it('settles exactly once and includes the captured dispatch identity', async () => {
		const harness = createHarness();
		const reservation = harness.coordinator.reserve(request('execution-1'));
		const lease = harness.coordinator.start(reservation, () => ({ cancel: vi.fn(), promise: Promise.resolve(result('ok')) }));
		lease.captureDispatch({
			dispatchAttempt: 1,
			connectionRevision: 7,
			leaveNoTraceRevision: 3,
			connectionIdentityKey: 'cluster|authority',
			clusterEndpoint: 'https://cluster.kusto.windows.net',
			authorityId: 'organizations',
			accountPartition: 'partition-a',
			clientActivityId: 'KW.execute_query;attempt-1',
		});

		await expect(harness.coordinator.succeed(reservation, result('ok'))).resolves.toBe(true);
		await expect(harness.coordinator.succeed(reservation, result('duplicate'))).resolves.toBe(false);
		expect(harness.postMessage).toHaveBeenCalledTimes(1);
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: 'execution-1',
			dispatch: expect.objectContaining({ accountPartition: 'partition-a', connectionRevision: 7 }),
		}));
	});

	it('retires a dispatchless success attempt instead of publishing rows', async () => {
		const harness = createHarness();
		const reservation = harness.coordinator.reserve(request('execution-no-dispatch'));

		await expect(harness.coordinator.succeed(reservation, result('invalid'))).resolves.toBe(false);
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'execution-no-dispatch', reason: 'retired',
		}));
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(harness.coordinator.getActive('query_1')).toBeUndefined();
	});

	it('retires the exact execution when its target advances', async () => {
		const harness = createHarness();
		const reservation = harness.coordinator.reserve(request('execution-1'));
		const cancel = vi.fn();
		harness.coordinator.start(reservation, () => ({ cancel, promise: Promise.resolve(result('old')) }));

		expect(harness.coordinator.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'instance-1', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Other',
		})).toBe(true);
		await Promise.resolve();

		expect(cancel).toHaveBeenCalledOnce();
		await expect(harness.coordinator.succeed(reservation, result('old'))).resolves.toBe(false);
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'execution-1', reason: 'retired',
		}));
	});

	it('does not report success until delivery settles true', async () => {
		let settleDelivery!: (delivered: boolean) => void;
		const delivery = new Promise<boolean>(resolve => { settleDelivery = resolve; });
		const queryRuns = new QueryRunCoordinator();
		const coordinator = new KustoExecutionCoordinator({ queryRuns, postMessage: () => delivery });
		coordinator.openSection('query_1', 'instance-1');
		coordinator.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples',
		});
		const reservation = coordinator.reserve(request('execution-delivery'));
		const lease = coordinator.start(reservation, () => ({ cancel: vi.fn(), promise: Promise.resolve(result('ok')) }));
		lease.captureDispatch({
			dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 2,
			connectionIdentityKey: 'cluster|authority', clusterEndpoint: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a', clientActivityId: 'KW.execute_query;delivery',
		});
		let settled = false;
		const success = coordinator.succeed(reservation, result('ok')).then(value => { settled = true; return value; });

		await Promise.resolve();
		expect(settled).toBe(false);
		expect(coordinator.getActive('query_1')).toBeUndefined();
		settleDelivery(true);
		await expect(success).resolves.toBe(true);
		expect(coordinator.getActive('query_1')).toBeUndefined();
	});

	it('reports rejected successful-terminal delivery as unsuccessful and sends an exact fallback terminal', async () => {
		const queryRuns = new QueryRunCoordinator();
		const postMessage = vi.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const coordinator = new KustoExecutionCoordinator({ queryRuns, postMessage });
		coordinator.openSection('query_1', 'instance-1');
		coordinator.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples',
		});
		const reservation = coordinator.reserve(request('execution-rejected-delivery'));
		const lease = coordinator.start(reservation, () => ({ cancel: vi.fn(), promise: Promise.resolve(result('ok')) }));
		lease.captureDispatch({
			dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 2,
			connectionIdentityKey: 'cluster|authority', clusterEndpoint: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a', clientActivityId: 'KW.execute_query;rejected-delivery',
		});

		await expect(coordinator.succeed(reservation, result('ok'))).resolves.toBe(false);
		expect(postMessage).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
			type: 'queryResult', executionId: 'execution-rejected-delivery',
		}));
		expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
			type: 'queryCancelled', executionId: 'execution-rejected-delivery', reason: 'retired',
		}));
		expect(coordinator.getActive('query_1')).toBeUndefined();
	});

	it.each(['error', 'cancel'] as const)('sends an exact retired fallback when %s terminal delivery is rejected', async terminalKind => {
		const queryRuns = new QueryRunCoordinator();
		const postMessage = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const coordinator = new KustoExecutionCoordinator({ queryRuns, postMessage });
		coordinator.openSection('query_1', 'instance-1');
		coordinator.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples',
		});
		const reservation = coordinator.reserve(request(`execution-rejected-${terminalKind}`));

		if (terminalKind === 'error') coordinator.fail(reservation, 'failed');
		else coordinator.cancelExpected(reservation);
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

		expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
			type: 'queryCancelled', executionId: `execution-rejected-${terminalKind}`, reason: 'retired',
		}));
	});

	it('publishes an exact retired terminal for a stale preclaimed request', async () => {
		const harness = createHarness();
		const stale = request('execution-preclaimed', 0);

		await expect(harness.coordinator.rejectPreclaimedRequest(stale)).resolves.toBe(true);

		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'execution-preclaimed', sectionInstanceId: 'instance-1',
			targetGeneration: 0, reservationSequence: expect.any(Number), reason: 'retired',
		}));
	});

	it('retries an exact stale-preclaim terminal when its first delivery is rejected', async () => {
		const postMessage = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const coordinator = new KustoExecutionCoordinator({ queryRuns: new QueryRunCoordinator(), postMessage });

		await expect(coordinator.rejectPreclaimedRequest(request('execution-preclaim-retry'))).resolves.toBe(true);
		expect(postMessage).toHaveBeenCalledTimes(2);
		expect(postMessage.mock.calls[1][0]).toEqual(postMessage.mock.calls[0][0]);
	});

	it('commits one successful terminal before replacement while delivery is pending', async () => {
		let settleDelivery!: (delivered: boolean) => void;
		const firstDelivery = new Promise<boolean>(resolve => { settleDelivery = resolve; });
		const postMessage = vi.fn()
			.mockImplementationOnce(() => firstDelivery)
			.mockResolvedValue(true);
		const queryRuns = new QueryRunCoordinator();
		const coordinator = new KustoExecutionCoordinator({ queryRuns, postMessage });
		coordinator.openSection('query_1', 'instance-1');
		coordinator.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Samples',
		});
		const old = coordinator.reserve(request('execution-old-delivery'));
		const oldLease = coordinator.start(old, () => ({ cancel: vi.fn(), promise: Promise.resolve(result('old')) }));
		oldLease.captureDispatch({
			dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
			connectionIdentityKey: 'cluster|authority', clusterEndpoint: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a', clientActivityId: 'KW.execute_query;old-delivery',
		});
		const oldSuccess = coordinator.succeed(old, result('old'));
		await Promise.resolve();

		const current = coordinator.reserve(request('execution-current-delivery'));
		settleDelivery(true);

		await expect(oldSuccess).resolves.toBe(true);
		expect(coordinator.getActive('query_1')).toEqual(current);
		const oldTerminals = postMessage.mock.calls
			.map(call => call[0])
			.filter(message => message.executionId === 'execution-old-delivery');
		expect(oldTerminals).toEqual([expect.objectContaining({
			type: 'queryResult', executionId: 'execution-old-delivery',
		})]);
	});

	it('rejects a closed same-ID section incarnation', () => {
		const harness = createHarness();
		expect(harness.coordinator.closeSection('query_1', 'instance-1')).toBe(true);
		expect(harness.coordinator.openSection('query_1', 'instance-1')).toBe(false);
		expect(() => harness.coordinator.reserve(request('late'))).toThrow('no longer current');
	});

	it('preserves only the exact account-establishing dispatch during auth refresh', () => {
		const harness = createHarness();
		const reservation = harness.coordinator.reserve(request('execution-1'));
		const cancel = vi.fn();
		const lease = harness.coordinator.start(reservation, () => ({ cancel, promise: Promise.resolve(result('ok')) }));
		lease.captureDispatch({
			dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0, connectionIdentityKey: 'cluster|authority',
			clusterEndpoint: 'https://cluster.kusto.windows.net', accountPartition: 'partition-new',
			clientActivityId: 'KW.execute_query;attempt-1',
		});

		harness.coordinator.revokeConnections(['connection-1'], 'partition-new');
		expect(cancel).not.toHaveBeenCalled();
		expect(harness.coordinator.getActive('query_1')).toEqual(reservation);

		harness.coordinator.revokeConnections(['connection-1'], 'partition-other');
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('disposes only coordinator-owned Kusto runs', () => {
		const harness = createHarness();
		const reservation = harness.coordinator.reserve(request('execution-1'));
		const cancel = vi.fn();
		harness.coordinator.start(reservation, () => ({ cancel, promise: Promise.resolve(result('ok')) }));
		const sqlCancel = vi.fn();
		harness.queryRuns.register('sql_1', { cancel: sqlCancel, runSeq: harness.queryRuns.nextSequence(), executionId: 'sql-run' });

		harness.coordinator.dispose();

		expect(cancel).toHaveBeenCalledOnce();
		expect(sqlCancel).not.toHaveBeenCalled();
		expect(harness.queryRuns.has('sql_1')).toBe(true);
	});
});