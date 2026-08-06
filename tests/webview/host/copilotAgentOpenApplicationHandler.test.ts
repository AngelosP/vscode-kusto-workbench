import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/copilotChatOpenUtils', () => ({
	openKustoWorkbenchAgentChat: vi.fn(),
}));

import { HostCopilotAgentOpenApplicationHandler } from '../../../src/host/copilotAgentOpenApplicationHandler';
import { openKustoWorkbenchAgentChat } from '../../../src/host/copilotChatOpenUtils';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function openCopilotAgentMessage(): IncomingWebviewMessage {
	return { type: 'openCopilotAgent' };
}

describe('HostCopilotAgentOpenApplicationHandler', () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const handler = new HostCopilotAgentOpenApplicationHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
	});

	it('awaits exactly one zero-argument helper call and discards its resolved boolean', async () => {
		const handler = new HostCopilotAgentOpenApplicationHandler();
		const open = deferred<boolean>();
		vi.mocked(openKustoWorkbenchAgentChat).mockReturnValueOnce(open.promise);
		let settled = false;

		const request = handler.handleMessage(openCopilotAgentMessage())!;
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(openKustoWorkbenchAgentChat).toHaveBeenCalledOnce();
		expect(vi.mocked(openKustoWorkbenchAgentChat).mock.calls[0]).toEqual([]);

		open.resolve(false);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('propagates the exact helper rejection', async () => {
		const handler = new HostCopilotAgentOpenApplicationHandler();
		const failure = new Error('agent chat open failed');
		vi.mocked(openKustoWorkbenchAgentChat).mockRejectedValueOnce(failure);

		await expect(handler.handleMessage(openCopilotAgentMessage())).rejects.toBe(failure);
	});

	it('turns an exact synchronous helper throw into the handler rejection', async () => {
		const handler = new HostCopilotAgentOpenApplicationHandler();
		const failure = new Error('agent chat open threw');
		vi.mocked(openKustoWorkbenchAgentChat)
			.mockImplementationOnce(() => { throw failure; });

		await expect(handler.handleMessage(openCopilotAgentMessage())).rejects.toBe(failure);
	});

	it('allows an accepted helper call to resolve after disposal', async () => {
		const handler = new HostCopilotAgentOpenApplicationHandler();
		const open = deferred<boolean>();
		vi.mocked(openKustoWorkbenchAgentChat).mockReturnValueOnce(open.promise);
		const request = handler.handleMessage(openCopilotAgentMessage())!;

		handler.dispose();
		open.resolve(true);

		await expect(request).resolves.toBeUndefined();
	});

	it('allows an accepted helper rejection to propagate after disposal', async () => {
		const handler = new HostCopilotAgentOpenApplicationHandler();
		const open = deferred<boolean>();
		const failure = new Error('late agent chat open failure');
		vi.mocked(openKustoWorkbenchAgentChat).mockReturnValueOnce(open.promise);
		const request = handler.handleMessage(openCopilotAgentMessage())!;

		handler.dispose();
		open.reject(failure);

		await expect(request).rejects.toBe(failure);
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const handler = new HostCopilotAgentOpenApplicationHandler();

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(openCopilotAgentMessage());

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
	});
});