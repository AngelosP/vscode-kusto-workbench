import { describe, expect, it, vi } from 'vitest';

import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import { SqlExecutionBroker } from '../../../src/host/sql/sqlExecutionBroker';

function createHarness() {
	let ownerToken = 'owner-a';
	const queryRuns = new QueryRunCoordinator();
	const postMessage = vi.fn(() => true);
	const broker = new SqlExecutionBroker({
		queryRuns,
		getOwnerToken: () => ownerToken,
		postMessage,
	});
	return { broker, queryRuns, postMessage, setOwnerToken: (value: string) => { ownerToken = value; } };
}

describe('SqlExecutionBroker', () => {
	it('does not disturb a running execution until owner preflight is promoted', () => {
		const harness = createHarness();
		const runningAdmission = harness.broker.reserve('sql_1', 'running');
		const cancel = vi.fn();
		const running = harness.broker.start(runningAdmission, () => ({ cancel }));

		const stalePreflight = harness.broker.reservePreflight('sql_1', 'stale', 'owner-old');

		expect(running.isCurrent()).toBe(true);
		expect(cancel).not.toHaveBeenCalled();
		expect(harness.broker.clearPreflight(stalePreflight)).toBe(true);
		expect(running.isCurrent()).toBe(true);
	});

	it('cancels an exact owner preflight without cancelling the current run', async () => {
		const harness = createHarness();
		const runningAdmission = harness.broker.reserve('sql_1', 'running');
		const cancel = vi.fn();
		const running = harness.broker.start(runningAdmission, () => ({ cancel }));
		harness.broker.reservePreflight('sql_1', 'preflight', 'owner-a');

		expect(harness.broker.cancelExpected('sql_1', 'preflight')).toBe(true);
		await Promise.resolve();

		expect(cancel).not.toHaveBeenCalled();
		expect(running.isCurrent()).toBe(true);
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-a', executionId: 'preflight',
		});
	});

	it('cancels an exact running execution without retiring a newer preflight', () => {
		const harness = createHarness();
		const runningAdmission = harness.broker.reserve('sql_1', 'running');
		const cancel = vi.fn();
		harness.broker.start(runningAdmission, () => ({ cancel }));
		const preflight = harness.broker.reservePreflight('sql_1', 'next', 'owner-a');

		expect(harness.broker.cancelExpected('sql_1', 'running', false)).toBe(true);

		expect(cancel).toHaveBeenCalledOnce();
		expect(harness.broker.isPreflightCurrent(preflight)).toBe(true);
	});

	it('clears a promoted pending admission when transport start throws', () => {
		const harness = createHarness();
		const admission = harness.broker.reservePending('sql_1', 'failed-start', 'owner-a');
		const secondStart = vi.fn(() => ({ cancel: vi.fn() }));

		expect(() => harness.broker.start(admission, () => { throw new Error('start failed'); })).toThrow('start failed');

		expect(harness.broker.isPendingCurrent(admission)).toBe(false);
		expect(harness.broker.cancelExpected('sql_1', 'failed-start')).toBe(false);
		expect(() => harness.broker.start(admission, secondStart)).toThrow('canceled');
		expect(secondStart).not.toHaveBeenCalled();
	});

	it('atomically promotes a validated preflight and supersedes the running execution', () => {
		const harness = createHarness();
		const runningAdmission = harness.broker.reserve('sql_1', 'running');
		const cancel = vi.fn();
		harness.broker.start(runningAdmission, () => ({ cancel }));
		const preflight = harness.broker.reservePreflight('sql_1', 'next', 'owner-a');

		const admission = harness.broker.promotePreflight(preflight);

		expect(admission).toMatchObject({ boxId: 'sql_1', executionId: 'next', ownerToken: 'owner-a' });
		expect(cancel).toHaveBeenCalledOnce();
		expect(harness.broker.isPendingCurrent(admission!)).toBe(true);
	});

	it('retires a pending preflight with its exact execution ID and owner token', async () => {
		const harness = createHarness();
		const admission = harness.broker.reservePending('sql_1', 'manual-1', 'owner-a');

		expect(harness.broker.cancelExpected('sql_1', 'manual-1')).toBe(true);
		await Promise.resolve();

		expect(harness.broker.isAdmissionCurrent(admission)).toBe(false);
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-a', executionId: 'manual-1',
		});
	});

	it('rejects cancellation for an unrelated execution identity', () => {
		const harness = createHarness();
		const admission = harness.broker.reservePending('sql_1', 'manual-current', 'owner-a');

		expect(harness.broker.cancelExpected('sql_1', 'manual-stale')).toBe(false);
		expect(harness.broker.isPendingCurrent(admission)).toBe(true);
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('cancels and observes a transport when admission changes synchronously during start', async () => {
		const harness = createHarness();
		const admission = harness.broker.reserve('sql_1', 'copilot-1');
		const promise = Promise.reject(new Error('cancelled during admission'));
		void promise.catch(() => undefined);
		const cancel = vi.fn();

		expect(() => harness.broker.start(admission, () => {
			harness.broker.supersede('sql_1');
			return { cancel, promise };
		})).toThrow('SQL Copilot write-query canceled');
		expect(cancel).toHaveBeenCalledOnce();
		expect(harness.queryRuns.has('sql_1')).toBe(false);
		await Promise.resolve();
	});

	it('snapshots cancellation correlation before a reentrant cancel callback', async () => {
		const harness = createHarness();
		const admission = harness.broker.reserve('sql_1', 'execution-1');
		const cancel = vi.fn(() => harness.setOwnerToken('owner-b'));
		harness.broker.start(admission, () => ({ cancel }));

		await harness.broker.cancelRunning('sql_1', { notifyWebview: true });

		expect(cancel).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-a', executionId: 'execution-1',
		});
	});

	it('releases only the exact current lease and never unregisters a replacement', () => {
		const harness = createHarness();
		const oldAdmission = harness.broker.reserve('sql_1', 'old');
		const oldLease = harness.broker.start(oldAdmission, () => ({ cancel: vi.fn() }));
		const currentAdmission = harness.broker.reserve('sql_1', 'current');
		const currentLease = harness.broker.start(currentAdmission, () => ({ cancel: vi.fn() }));

		oldLease.release();

		expect(oldLease.isCurrent()).toBe(false);
		expect(currentLease.isCurrent()).toBe(true);
		expect(harness.queryRuns.get('sql_1')?.executionId).toBe('current');
	});

	it('promotes an exact pending admission into a current execution lease', () => {
		const harness = createHarness();
		const admission = harness.broker.reservePending('sql_1', 'manual-1', 'owner-a');
		const cancel = vi.fn();

		const lease = harness.broker.start(admission, () => ({ cancel, promise: Promise.resolve('done') }));

		expect(harness.broker.isPendingCurrent(admission)).toBe(false);
		expect(lease.isCurrent()).toBe(true);
		expect(lease.executionId).toBe('manual-1');
	});

	it('consumes an admission before start and rejects transport reuse', () => {
		const harness = createHarness();
		const admission = harness.broker.reserve('sql_1', 'single-use');
		const firstCancel = vi.fn();
		const first = harness.broker.start(admission, () => ({ cancel: firstCancel }));
		const duplicateStart = vi.fn(() => ({ cancel: vi.fn() }));

		expect(() => harness.broker.start(admission, duplicateStart)).toThrow('canceled');
		expect(duplicateStart).not.toHaveBeenCalled();
		expect(first.isCurrent()).toBe(true);
		expect(firstCancel).not.toHaveBeenCalled();
		expect(harness.queryRuns.get('sql_1')?.executionId).toBe('single-use');
	});

	it('clears one closed box without disturbing another admission', () => {
		const harness = createHarness();
		const closed = harness.broker.reservePending('sql-closed', 'closed-1', 'owner-a');
		const current = harness.broker.reservePending('sql-current', 'current-1', 'owner-a');

		harness.broker.clearBox('sql-closed');

		expect(harness.broker.isAdmissionCurrent(closed)).toBe(false);
		expect(harness.broker.isPendingCurrent(current)).toBe(true);
	});

	it('keeps a stale empty-ID admission retired after box reuse', () => {
		const harness = createHarness();
		const stale = harness.broker.reservePending('sql-reused', '', 'owner-a');
		harness.broker.clearBox('sql-reused');
		const current = harness.broker.reservePending('sql-reused', '', 'owner-a');
		const staleStart = vi.fn(() => ({ cancel: vi.fn() }));

		expect(() => harness.broker.start(stale, staleStart)).toThrow('canceled');
		expect(staleStart).not.toHaveBeenCalled();
		const currentLease = harness.broker.start(current, () => ({ cancel: vi.fn() }));
		expect(currentLease.isCurrent()).toBe(true);
	});
});