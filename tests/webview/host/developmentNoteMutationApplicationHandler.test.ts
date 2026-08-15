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

function noteEntry(id: string) {
	return {
		id,
		created: '2026-08-14T00:00:00.000Z',
		updated: '2026-08-14T00:00:00.000Z',
		category: 'usage-note',
		content: `Content for ${id}`,
		source: 'copilot',
	};
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
		const mutation = { action: 'add', entry: noteEntry('note_1') } as const;

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

	it('keeps the exact waiter and five-second timer live until a canonical response settles it', async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});
		let settled = false;
		const pending = handler.updateDevelopmentNotes({ action: 'add', entry: noteEntry('note_1') });
		void pending.then(() => { settled = true; });
		const request = postMessage.mock.calls[0][0] as { requestId: string };

		expect(vi.getTimerCount()).toBe(1);
		expect(handler.handleMessage(toolResponse(request.requestId, { success: 'yes' }))).toBe(true);
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(4999);
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(1);

		expect(handler.handleMessage(toolResponse(request.requestId, { success: true }))).toBe(true);
		await expect(pending).resolves.toEqual({ success: true });
		expect(settled).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('claims inherited matching correlation without consuming its waiter or timer', async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});
		let settled = false;
		const pending = handler.updateDevelopmentNotes({ action: 'remove', noteId: 'note_inherited' });
		void pending.then(() => { settled = true; });
		const request = postMessage.mock.calls[0][0] as { requestId: string };
		const inherited = Object.assign(Object.create({ requestId: request.requestId }), {
			type: 'toolResponse', result: { success: 'yes' },
		});

		expect(handler.handleMessage(inherited)).toBe(true);
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		expect(handler.handleMessage(toolResponse(request.requestId, { success: true }))).toBe(true);
		await expect(pending).resolves.toEqual({ success: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		{ action: 'add', entry: { id: 'partial' } },
		{ action: 'remove', noteId: 'note_1', requestId: 'caller-controlled' },
	])('rejects malformed producer payload $action before request, waiter, timer, or transport effects', async mutation => {
		vi.useFakeTimers();
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});

		await expect(handler.updateDevelopmentNotes(mutation as never)).resolves.toEqual({
			success: false,
			error: expect.any(String),
		});
		expect(postMessage).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('rejects a revoked nested related-section array before waiter, timer, or transport effects', async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn(() => true);
		const handler = new HostDevelopmentNoteMutationApplicationHandler({
			postMessage,
			isAvailable: () => true,
		});
		const relatedSectionIds = Proxy.revocable(['query_1'], {});
		relatedSectionIds.revoke();

		await expect(handler.updateDevelopmentNotes({
			action: 'add',
			entry: { ...noteEntry('note_revoked'), relatedSectionIds: relatedSectionIds.proxy },
		})).resolves.toEqual({ success: false, error: expect.any(String) });
		expect(postMessage).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
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

		await expect(handler.updateDevelopmentNotes({ action: 'remove', noteId: 'note_delivery' })).resolves.toEqual({
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
		const pending = handler.updateDevelopmentNotes({ action: 'remove', noteId: 'note_timeout' });
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
		const first = handler.updateDevelopmentNotes({ action: 'add', entry: noteEntry('note_1') });
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
