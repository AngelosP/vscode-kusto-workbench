import { describe, expect, it, vi } from 'vitest';

import {
	HostKustoConnectionBrowsingApplicationHandler,
	type KustoConnectionBrowsingApplicationHandlerOptions,
} from '../../../src/host/kustoConnectionBrowsingApplicationHandler';
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

function createHandler(overrides: Partial<KustoConnectionBrowsingApplicationHandlerOptions> = {}) {
	const sendConnectionsData = vi.fn(async () => undefined);
	const sendDatabases = vi.fn(async () => undefined);
	const saveLastSelection = vi.fn(async () => undefined);
	const refreshTextEditorDiagnostics = vi.fn(async () => undefined);
	const handler = new HostKustoConnectionBrowsingApplicationHandler({
		sendConnectionsData,
		sendDatabases,
		saveLastSelection,
		refreshTextEditorDiagnostics,
		...overrides,
	});
	return {
		handler,
		sendConnectionsData,
		sendDatabases,
		saveLastSelection,
		refreshTextEditorDiagnostics,
	};
}

describe('HostKustoConnectionBrowsingApplicationHandler', () => {
	it('declines unrelated traffic synchronously', () => {
		const harness = createHandler();

		expect(harness.handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(harness.handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(harness.sendConnectionsData).not.toHaveBeenCalled();
		expect(harness.sendDatabases).not.toHaveBeenCalled();
		expect(harness.saveLastSelection).not.toHaveBeenCalled();
	});

	it('forwards the exact optional policy request and awaits the revisioned connection projection', async () => {
		const settlement = deferred<void>();
		const sendConnectionsData = vi.fn(() => settlement.promise);
		const harness = createHandler({ sendConnectionsData });
		const message = {
			type: 'getConnections', policyRequestId: ' policy-request-exact ',
		} satisfies IncomingWebviewMessage;
		let settled = false;

		const request = harness.handler.handleMessage(message)!;
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(sendConnectionsData).toHaveBeenCalledOnce();
		expect(sendConnectionsData).toHaveBeenCalledWith(message.policyRequestId);
		expect(settled).toBe(false);

		settlement.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('shapes passive database discovery with every exact lifecycle field', async () => {
		const harness = createHandler();
		const message = {
			type: 'getDatabases',
			connectionId: ' passive-connection-exact ',
			boxId: ' passive-box-exact ',
			requestToken: ' passive-token-exact ',
			requiredDatabase: ' PassiveDatabaseExact ',
			sectionInstanceId: ' passive-section-exact ',
			targetGeneration: 17,
		} satisfies IncomingWebviewMessage;

		await harness.handler.handleMessage(message);

		expect(harness.sendDatabases).toHaveBeenCalledOnce();
		expect(harness.sendDatabases).toHaveBeenCalledWith(
			message.connectionId,
			message.boxId,
			{
				mode: 'passive',
				requestToken: message.requestToken,
				requiredDatabase: message.requiredDatabase,
				sectionInstanceId: message.sectionInstanceId,
				targetGeneration: message.targetGeneration,
			},
		);
	});

	it('shapes interactive refresh and preserves a blank connection for service-owned failure handling', async () => {
		const harness = createHandler();
		const message = {
			type: 'refreshDatabases',
			connectionId: '',
			boxId: 'refresh-box-exact',
			requestToken: 'refresh-token-exact',
			requiredDatabase: '',
			sectionInstanceId: 'refresh-section-exact',
			targetGeneration: 23,
		} satisfies IncomingWebviewMessage;

		await harness.handler.handleMessage(message);

		expect(harness.sendDatabases).toHaveBeenCalledOnce();
		expect(harness.sendDatabases).toHaveBeenCalledWith('', message.boxId, {
			mode: 'interactive-refresh',
			requestToken: message.requestToken,
			requiredDatabase: '',
			sectionInstanceId: message.sectionInstanceId,
			targetGeneration: message.targetGeneration,
		});
	});

	it('claims malformed database requests before service effects', async () => {
		const harness = createHandler();

		await expect(harness.handler.handleMessage({
			type: 'getDatabases', connectionId: 'connection', boxId: 'box', targetGeneration: '17',
		} as unknown as IncomingWebviewMessage)).resolves.toBeUndefined();
		await expect(harness.handler.handleMessage({
			type: 'refreshDatabases', connectionId: 'connection', boxId: 42,
		} as unknown as IncomingWebviewMessage)).resolves.toBeUndefined();
		await expect(harness.handler.handleMessage(Object.assign([], {
			type: 'getDatabases', connectionId: 'connection', boxId: 'box',
		}) as unknown as IncomingWebviewMessage)).resolves.toBeUndefined();

		expect(harness.sendDatabases).not.toHaveBeenCalled();
	});

	it('keeps blank selection response-free and side-effect-free', async () => {
		const harness = createHandler();

		await harness.handler.handleMessage({
			type: 'saveLastSelection', connectionId: '   ', database: 'IgnoredDatabase',
		});

		expect(harness.saveLastSelection).not.toHaveBeenCalled();
		expect(harness.refreshTextEditorDiagnostics).not.toHaveBeenCalled();
	});

	it('persists a trimmed selection before diagnostics while preserving undefined database', async () => {
		const persistence = deferred<void>();
		const saveLastSelection = vi.fn(() => persistence.promise);
		const order: string[] = [];
		const refreshTextEditorDiagnostics = vi.fn(async () => { order.push('diagnostics'); });
		const harness = createHandler({ saveLastSelection, refreshTextEditorDiagnostics });
		const message = {
			type: 'saveLastSelection', connectionId: ' connection-exact ', database: undefined,
		} satisfies IncomingWebviewMessage;
		const request = harness.handler.handleMessage(message)!;

		expect(saveLastSelection).toHaveBeenCalledWith('connection-exact', undefined);
		expect(refreshTextEditorDiagnostics).not.toHaveBeenCalled();

		order.push('persisted');
		persistence.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(order).toEqual(['persisted', 'diagnostics']);
	});

	it('preserves an explicitly empty database value', async () => {
		const harness = createHandler();

		await harness.handler.handleMessage({
			type: 'saveLastSelection', connectionId: 'connection-empty-database', database: '',
		});

		expect(harness.saveLastSelection).toHaveBeenCalledWith('connection-empty-database', '');
		expect(harness.refreshTextEditorDiagnostics).toHaveBeenCalledOnce();
	});

	it('propagates persistence failure exactly and does not refresh diagnostics', async () => {
		const asynchronousFailure = new Error('selection persistence failed asynchronously');
		const synchronousFailure = new Error('selection persistence failed synchronously');
		const asynchronous = createHandler({
			saveLastSelection: vi.fn(async () => { throw asynchronousFailure; }),
		});
		const synchronous = createHandler({
			saveLastSelection: vi.fn(() => { throw synchronousFailure; }),
		});

		await expect(asynchronous.handler.handleMessage({
			type: 'saveLastSelection', connectionId: 'async-connection', database: 'Database',
		})).rejects.toBe(asynchronousFailure);
		await expect(synchronous.handler.handleMessage({
			type: 'saveLastSelection', connectionId: 'sync-connection', database: 'Database',
		})).rejects.toBe(synchronousFailure);
		expect(asynchronous.refreshTextEditorDiagnostics).not.toHaveBeenCalled();
		expect(synchronous.refreshTextEditorDiagnostics).not.toHaveBeenCalled();
	});

	it('contains synchronous and asynchronous diagnostics failures after successful persistence', async () => {
		const asynchronousFailure = new Error('diagnostics failed asynchronously');
		const synchronousFailure = new Error('diagnostics failed synchronously');
		const asynchronous = createHandler({
			refreshTextEditorDiagnostics: vi.fn(async () => { throw asynchronousFailure; }),
		});
		const synchronous = createHandler({
			refreshTextEditorDiagnostics: vi.fn(() => { throw synchronousFailure; }),
		});

		await expect(asynchronous.handler.handleMessage({
			type: 'saveLastSelection', connectionId: 'async-diagnostics', database: 'Database',
		})).resolves.toBeUndefined();
		await expect(synchronous.handler.handleMessage({
			type: 'saveLastSelection', connectionId: 'sync-diagnostics', database: 'Database',
		})).resolves.toBeUndefined();
		expect(asynchronous.saveLastSelection).toHaveBeenCalledOnce();
		expect(synchronous.saveLastSelection).toHaveBeenCalledOnce();
	});

	it('allows an accepted selection to finish across disposal', async () => {
		const persistence = deferred<void>();
		const saveLastSelection = vi.fn(() => persistence.promise);
		const refreshTextEditorDiagnostics = vi.fn(async () => undefined);
		const harness = createHandler({ saveLastSelection, refreshTextEditorDiagnostics });
		const request = harness.handler.handleMessage({
			type: 'saveLastSelection', connectionId: 'crossing-connection', database: 'CrossingDatabase',
		})!;

		harness.handler.dispose();
		expect(refreshTextEditorDiagnostics).not.toHaveBeenCalled();
		persistence.resolve();

		await expect(request).resolves.toBeUndefined();
		expect(refreshTextEditorDiagnostics).toHaveBeenCalledOnce();
	});

	it('claims but suppresses every later route after idempotent disposal', async () => {
		const harness = createHandler();
		const messages = [
			{ type: 'getConnections', policyRequestId: 'later-policy' },
			{ type: 'getDatabases', connectionId: 'later-connection', boxId: 'later-box' },
			{ type: 'refreshDatabases', connectionId: 'later-connection', boxId: 'later-box' },
			{ type: 'saveLastSelection', connectionId: 'later-connection', database: '' },
		] satisfies IncomingWebviewMessage[];

		harness.handler.dispose();
		harness.handler.dispose();

		for (const message of messages) {
			const request = harness.handler.handleMessage(message);
			expect(request).toBeInstanceOf(Promise);
			await expect(request).resolves.toBeUndefined();
		}
		expect(harness.sendConnectionsData).not.toHaveBeenCalled();
		expect(harness.sendDatabases).not.toHaveBeenCalled();
		expect(harness.saveLastSelection).not.toHaveBeenCalled();
		expect(harness.refreshTextEditorDiagnostics).not.toHaveBeenCalled();
	});
});
