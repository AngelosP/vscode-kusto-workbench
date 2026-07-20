import { describe, expect, it, vi } from 'vitest';
import { StsProcessManager } from '../../../src/host/sql/stsProcessManager';

function createOutput() {
	return {
		trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
	} as any;
}

function createConnection() {
	const handlers = new Map<string, (params: unknown) => void>();
	return {
		sendRequest: vi.fn().mockResolvedValue({ ok: true }),
		onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
			handlers.set(method, handler);
			return { dispose: () => handlers.delete(method) };
		}),
		emit(method: string, params: unknown) { handlers.get(method)?.(params); },
		dispose: vi.fn(),
	};
}

function readyManager() {
	const manager = new StsProcessManager('sts', 'logs', createOutput()) as any;
	const connection = createConnection();
	manager._connection = connection;
	manager._activeEpoch = 1;
	manager._epoch = 1;
	manager._readyPromise = Promise.resolve();
	return { manager: manager as StsProcessManager, raw: manager, connection };
}

describe('StsProcessManager request lifecycle', () => {
	it('passes requests through the active process epoch', async () => {
		const { manager, connection } = readyManager();
		await expect(manager.sendRequest('test/method', { value: 1 }, { expectedEpoch: 1, timeoutMs: 1000 }))
			.resolves.toEqual({ ok: true });
		expect(connection.sendRequest).toHaveBeenCalledWith('test/method', { value: 1 });
	});

	it('rejects a request when the expected epoch is stale', async () => {
		const { manager, connection } = readyManager();
		await expect(manager.sendRequest('test/method', {}, { expectedEpoch: 2 }))
			.rejects.toThrow('epoch changed before test/method');
		expect(connection.sendRequest).not.toHaveBeenCalled();
	});

	it('rejects an in-flight request when its process epoch ends', async () => {
		const { manager, raw, connection } = readyManager();
		connection.sendRequest.mockReturnValue(new Promise(() => undefined));
		const request = manager.sendRequest('query/executeString', {}, { expectedEpoch: 1, timeoutMs: null });
		await vi.waitFor(() => expect(connection.sendRequest).toHaveBeenCalledOnce());
		raw._endActiveEpoch(new Error('process lost'));
		await expect(request).rejects.toThrow('process lost');
	});

	it('uses a method-specific timeout', async () => {
		vi.useFakeTimers();
		try {
			const { manager, connection } = readyManager();
			connection.sendRequest.mockReturnValue(new Promise(() => undefined));
			const request = manager.sendRequest('query/subset', {}, { timeoutMs: 25 });
			const assertion = expect(request).rejects.toThrow('timed out after 25ms');
			await vi.advanceTimersByTimeAsync(25);
			await assertion;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('StsProcessManager notification lifecycle', () => {
	it('rejects waiters from a failed restart generation before creating the next generation', async () => {
		const { manager, raw } = readyManager();
		const child = {
			exitCode: null, killed: false,
			kill: vi.fn(function (this: { killed: boolean }) { this.killed = true; return true; }),
		} as any;
		raw._process = child;
		raw._connection = null;
		raw._activeEpoch = 0;
		raw._readyPromise = new Promise<void>((resolve: () => void, reject: (error: Error) => void) => {
			raw._readyResolve = resolve;
			raw._readyReject = reject;
		});
		const waiting = manager.sendRequest('query/subset', {}, { timeoutMs: null });

		raw._handleExit(child, -1, new Error('restart crashed'));

		await expect(waiting).rejects.toThrow('restart crashed');
	});

	it('resets the restart budget after a stable successful epoch', async () => {
		vi.useFakeTimers();
		const { raw } = readyManager();
		try {
			raw._restartCount = 2;
			raw._failed = true;
			raw._activeEpoch = 0;
			raw._readyResolve = vi.fn();
			raw._readyReject = vi.fn();
			const connection = createConnection();

			raw._markInitialized(connection);
			expect(raw._restartCount).toBe(2);
			expect(raw._failed).toBe(false);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(raw._restartCount).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('disposes the transport and terminates the child on abnormal exit', async () => {
		const { manager, raw, connection } = readyManager();
		const child = {
			exitCode: null,
			killed: false,
			kill: vi.fn(function (this: { killed: boolean }) { this.killed = true; return true; }),
		} as any;
		raw._process = child;

		raw._handleExit(child, -1, new Error('transport closed'));

		expect(connection.dispose).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledTimes(1);
		await manager.stop();
	});

	it('rebinds persistent handlers to a replacement connection and supports disposal', () => {
		const { manager, raw, connection: first } = readyManager();
		const handler = vi.fn();
		const subscription = manager.onNotification('query/complete', handler);
		first.emit('query/complete', { ownerUri: 'one' });
		expect(handler).toHaveBeenLastCalledWith({ ownerUri: 'one' }, 1);

		const second = createConnection();
		raw._connection = second;
		raw._activeEpoch = 2;
		raw._bindNotificationHandlers(second, 2);
		second.emit('query/complete', { ownerUri: 'two' });
		expect(handler).toHaveBeenLastCalledWith({ ownerUri: 'two' }, 2);

		subscription.dispose();
		second.emit('query/complete', { ownerUri: 'ignored' });
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it('emits an epoch end only once', () => {
		const { manager, raw } = readyManager();
		const handler = vi.fn();
		manager.onDidEndEpoch(handler);
		raw._endActiveEpoch(new Error('first'));
		raw._endActiveEpoch(new Error('second'));
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0][0]).toMatchObject({ epoch: 1 });
	});
});