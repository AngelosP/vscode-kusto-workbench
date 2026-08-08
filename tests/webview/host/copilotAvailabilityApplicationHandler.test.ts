import { describe, expect, it, vi } from 'vitest';

import {
	HostCopilotAvailabilityApplicationHandler,
	type CopilotAvailabilityApplicationHandlerOptions,
} from '../../../src/host/copilotAvailabilityApplicationHandler';
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

function availabilityMessage(
	boxId = 'availability-query-1',
): Extract<IncomingWebviewMessage, { type: 'checkCopilotAvailability' }> {
	return { type: 'checkCopilotAvailability', boxId };
}

function createHandler(overrides: Partial<CopilotAvailabilityApplicationHandlerOptions> = {}) {
	const checkCopilotAvailability = vi.fn(async () => undefined);
	const handler = new HostCopilotAvailabilityApplicationHandler({
		checkCopilotAvailability,
		...overrides,
	});
	return { handler, checkCopilotAvailability };
}

describe('HostCopilotAvailabilityApplicationHandler', () => {
	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, checkCopilotAvailability } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(checkCopilotAvailability).not.toHaveBeenCalled();
	});

	it('delegates the exact box ID and awaits settlement', async () => {
		const settlement = deferred<void>();
		const checkCopilotAvailability = vi.fn(() => settlement.promise);
		const { handler } = createHandler({ checkCopilotAvailability });
		const message = availabilityMessage('  availability-query-exact  ');
		let settled = false;

		const request = handler.handleMessage(message)!;
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(checkCopilotAvailability).toHaveBeenCalledOnce();
		expect(checkCopilotAvailability).toHaveBeenCalledWith(message.boxId);
		expect(settled).toBe(false);

		settlement.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('propagates exact asynchronous and synchronous rejections', async () => {
		const asynchronousFailure = new Error('Copilot availability failed asynchronously');
		const synchronousFailure = new Error('Copilot availability failed synchronously');
		const asynchronous = createHandler({
			checkCopilotAvailability: vi.fn(async () => { throw asynchronousFailure; }),
		});
		const synchronous = createHandler({
			checkCopilotAvailability: vi.fn(() => { throw synchronousFailure; }),
		});

		await expect(asynchronous.handler.handleMessage(availabilityMessage('async')))
			.rejects.toBe(asynchronousFailure);
		await expect(synchronous.handler.handleMessage(availabilityMessage('sync')))
			.rejects.toBe(synchronousFailure);
	});

	it('allows accepted settlement to complete across disposal', async () => {
		const settlement = deferred<void>();
		const checkCopilotAvailability = vi.fn(() => settlement.promise);
		const { handler } = createHandler({ checkCopilotAvailability });
		const message = availabilityMessage();
		const request = handler.handleMessage(message)!;

		handler.dispose();
		expect(checkCopilotAvailability).toHaveBeenCalledWith(message.boxId);
		settlement.resolve();

		await expect(request).resolves.toBeUndefined();
	});

	it('preserves an accepted rejection across disposal', async () => {
		const settlement = deferred<void>();
		const failure = new Error('accepted Copilot availability failed');
		const checkCopilotAvailability = vi.fn(() => settlement.promise);
		const { handler } = createHandler({ checkCopilotAvailability });
		const request = handler.handleMessage(availabilityMessage())!;

		handler.dispose();
		settlement.reject(failure);

		await expect(request).rejects.toBe(failure);
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const { handler, checkCopilotAvailability } = createHandler();

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(availabilityMessage());

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(checkCopilotAvailability).not.toHaveBeenCalled();
	});
});
