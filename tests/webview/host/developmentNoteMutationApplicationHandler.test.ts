import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostDevelopmentNoteMutationApplicationHandler } from '../../../src/host/developmentNoteMutationApplicationHandler';
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

function toolResponse(
	requestId: string,
	result: unknown,
	error?: string,
): Extract<IncomingWebviewMessage, { type: 'toolResponse' }> {
	return { type: 'toolResponse', requestId, result, error };
}

describe('HostDevelopmentNoteMutationApplicationHandler', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('declines unrelated and unclaimed responses synchronously', () => {
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBe(false);
		expect(handler.handleMessage(toolResponse('tool_other_1', { success: true }))).toBe(false);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('owns the exact request ID, outbound mutation, and matching success settlement', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1234);
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});
		const mutation = { action: 'add', entry: { id: 'note_1' } };

		const pending = handler.updateDevelopmentNotes(mutation);

		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'updateDevNotes',
			requestId: 'copilot_devnotes_1234_i',
			action: 'add',
			entry: mutation.entry,
		});
		const response = toolResponse('copilot_devnotes_1234_i', { success: true });
		expect(handler.handleMessage(response)).toBe(true);
		await expect(pending).resolves.toEqual({ success: true });
		expect(handler.handleMessage(response)).toBe(false);
	});

	it('settles the exact claimed error and false result shapes', async () => {
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});
		const first = handler.updateDevelopmentNotes({ action: 'remove', noteId: 'note_1' });
		const firstRequest = postMessage.mock.calls[0][0] as { requestId: string };
		const claimedError = toolResponse(
			firstRequest.requestId,
			{ success: false },
			'Development notes require a companion metadata file.',
		);

		expect(handler.handleMessage(claimedError)).toBe(true);
		await expect(first).resolves.toEqual({
			success: false,
			error: 'Development notes require a companion metadata file.',
		});

		const second = handler.updateDevelopmentNotes({ action: 'remove', noteId: 'note_2' });
		const secondRequest = postMessage.mock.calls[1][0] as { requestId: string };
		expect(handler.handleMessage(toolResponse(secondRequest.requestId, { success: false }))).toBe(true);
		await expect(second).resolves.toEqual({ success: false });
	});

	it.each([
		{
			name: 'rejected delivery',
			postMessage: () => false as const,
			error: 'Kusto Workbench rejected the development note request.',
		},
		{
			name: 'asynchronous delivery failure',
			postMessage: () => Promise.reject(new Error('async delivery failed')),
			error: 'async delivery failed',
		},
		{
			name: 'synchronous delivery failure',
			postMessage: () => { throw new Error('sync delivery failed'); },
			error: 'sync delivery failed',
		},
	])('settles $name exactly', async ({ postMessage, error }) => {
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});

		await expect(handler.updateDevelopmentNotes({ action: 'add' })).resolves.toEqual({
			success: false,
			error,
		});
	});

	it('returns unavailable without issuing a request', async () => {
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => false,
		});

		await expect(handler.updateDevelopmentNotes({ action: 'add' })).resolves.toEqual({
			success: false,
			error: 'Kusto Workbench editor is unavailable.',
		});
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('settles only at the exact five-second timeout and declines a late response', async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});
		let settled = false;
		const pending = handler.updateDevelopmentNotes({ action: 'add' });
		void pending.then(() => { settled = true; });
		const request = postMessage.mock.calls[0][0] as { requestId: string };

		await vi.advanceTimersByTimeAsync(4999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toEqual({
			success: false,
			error: 'Development note update timed out.',
		});
		expect(settled).toBe(true);
		expect(handler.handleMessage(toolResponse(request.requestId, { success: true }))).toBe(false);
	});

	it('settles every pending request on idempotent disposal and ignores late delivery', async () => {
		vi.spyOn(Math, 'random')
			.mockReturnValueOnce(0.1)
			.mockReturnValueOnce(0.2);
		const delivery = deferred<boolean>();
		const postMessage = vi.fn(() => delivery.promise);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});
		const first = handler.updateDevelopmentNotes({ action: 'add', entry: { id: 'note_1' } });
		const firstRequest = postMessage.mock.calls[0][0] as { requestId: string };
		const second = handler.updateDevelopmentNotes({ action: 'remove', noteId: 'note_2' });

		handler.dispose();
		handler.dispose();

		await expect(first).resolves.toEqual({
			success: false,
			error: 'Kusto Workbench editor closed.',
		});
		await expect(second).resolves.toEqual({
			success: false,
			error: 'Kusto Workbench editor closed.',
		});
		expect(handler.handleMessage(toolResponse(firstRequest.requestId, { success: true }))).toBe(false);
		await expect(handler.updateDevelopmentNotes({ action: 'add' })).resolves.toEqual({
			success: false,
			error: 'Kusto Workbench editor is unavailable.',
		});

		delivery.resolve(false);
		await Promise.resolve();
	});
});
