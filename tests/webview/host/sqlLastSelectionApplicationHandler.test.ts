import { describe, expect, it, vi } from 'vitest';

import { HostSqlLastSelectionApplicationHandler } from '../../../src/host/sqlLastSelectionApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function message(
	sqlConnectionId: string,
	database?: string,
): Extract<IncomingWebviewMessage, { type: 'saveSqlLastSelection' }> {
	return { type: 'saveSqlLastSelection', sqlConnectionId, database };
}

describe('HostSqlLastSelectionApplicationHandler', () => {
	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const update = vi.fn(async () => undefined);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(update).not.toHaveBeenCalled();
	});

	it('trims the connection ID and awaits it before explicitly clearing the database', async () => {
		const firstWrite = deferred<void>();
		const update = vi.fn((key: string) => key === 'sql.lastConnectionId'
			? firstWrite.promise
			: Promise.resolve());
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });
		let settled = false;

		const request = handler.handleMessage(message(' sql-a ', ''))!;
		void request.then(() => { settled = true; });
		await Promise.resolve();

		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenNthCalledWith(1, 'sql.lastConnectionId', 'sql-a');
		expect(settled).toBe(false);

		firstWrite.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(update).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenNthCalledWith(2, 'sql.lastDatabase', '');
		expect(settled).toBe(true);
	});

	it('does not write anything for a blank connection ID', async () => {
		const update = vi.fn(async () => undefined);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });

		await expect(handler.handleMessage(message(' \t ', 'Db'))).resolves.toBeUndefined();

		expect(update).not.toHaveBeenCalled();
	});

	it('preserves an undefined database as no database write', async () => {
		const update = vi.fn(async () => undefined);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });

		await expect(handler.handleMessage(message('sql-a'))).resolves.toBeUndefined();

		expect(update).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledWith('sql.lastConnectionId', 'sql-a');
	});

	it('preserves the exact defined database value', async () => {
		const update = vi.fn(async () => undefined);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });

		await expect(handler.handleMessage(message('sql-a', ' Db '))).resolves.toBeUndefined();

		expect(update).toHaveBeenNthCalledWith(1, 'sql.lastConnectionId', 'sql-a');
		expect(update).toHaveBeenNthCalledWith(2, 'sql.lastDatabase', ' Db ');
	});

	it('propagates the exact connection write rejection without writing the database', async () => {
		const failure = new Error('connection selection write failed');
		const update = vi.fn().mockRejectedValueOnce(failure);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });

		await expect(handler.handleMessage(message('sql-a', 'Db'))).rejects.toBe(failure);

		expect(update).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledWith('sql.lastConnectionId', 'sql-a');
	});

	it('propagates the exact database write rejection after the connection write', async () => {
		const failure = new Error('database selection write failed');
		const update = vi.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(failure);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });

		await expect(handler.handleMessage(message('sql-a', 'Db'))).rejects.toBe(failure);

		expect(update).toHaveBeenCalledTimes(2);
		expect(update).toHaveBeenNthCalledWith(1, 'sql.lastConnectionId', 'sql-a');
		expect(update).toHaveBeenNthCalledWith(2, 'sql.lastDatabase', 'Db');
	});

	it('allows accepted ordered writes to settle after disposal', async () => {
		const firstWrite = deferred<void>();
		const update = vi.fn((key: string) => key === 'sql.lastConnectionId'
			? firstWrite.promise
			: Promise.resolve());
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });
		const request = handler.handleMessage(message('sql-a', 'Db'))!;

		handler.dispose();
		firstWrite.resolve();

		await expect(request).resolves.toBeUndefined();
		expect(update).toHaveBeenNthCalledWith(1, 'sql.lastConnectionId', 'sql-a');
		expect(update).toHaveBeenNthCalledWith(2, 'sql.lastDatabase', 'Db');
	});

	it('allows an accepted rejection to propagate after disposal', async () => {
		const pendingWrite = deferred<void>();
		const failure = new Error('late selection write failed');
		const update = vi.fn(() => pendingWrite.promise);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });
		const request = handler.handleMessage(message('sql-a'))!;

		handler.dispose();
		pendingWrite.reject(failure);

		await expect(request).rejects.toBe(failure);
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const update = vi.fn(async () => undefined);
		const handler = new HostSqlLastSelectionApplicationHandler({ globalState: { update } });

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(message('sql-a', ''));

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(update).not.toHaveBeenCalled();
	});
});