import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../../../src/host/copilotChatOpenUtils', () => ({
	openKustoWorkbenchAgentChat: vi.fn(),
}));

import {
	HostCopilotChatFirstTimeApplicationHandler,
	type CopilotChatFirstTimeApplicationHandlerOptions,
} from '../../../src/host/copilotChatFirstTimeApplicationHandler';
import { openKustoWorkbenchAgentChat } from '../../../src/host/copilotChatOpenUtils';
import { STORAGE_KEYS, type IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

const firstTimeMessageText = 'Hello there! Did you know this extension comes with a custom agent called \'Kusto Workbench\' that is available through the VS Code Copilot chat window? You should use that instead of this chat window unless you are very familiar with both and you understand the differences.';
const openAgentAction = 'Open the Kusto Workbench agent';
const useChatAction = 'Use this Copilot Chat window';

type CopilotChatFirstTimeMessage = Extract<IncomingWebviewMessage, {
	type: 'copilotChatFirstTimeCheck';
}>;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function firstTimeMessage(boxId = 'first-time-box-1'): CopilotChatFirstTimeMessage {
	return { type: 'copilotChatFirstTimeCheck', boxId };
}

function createHandler() {
	const globalState = {
		get: vi.fn(() => false),
		update: vi.fn(async () => undefined),
	};
	const postMessage = vi.fn((_message: unknown): void | boolean | Thenable<boolean> => true);
	const handler = new HostCopilotChatFirstTimeApplicationHandler({
		globalState: globalState as unknown as CopilotChatFirstTimeApplicationHandlerOptions['globalState'],
		postMessage,
	});
	return { handler, globalState, postMessage };
}

describe('HostCopilotChatFirstTimeApplicationHandler', () => {
	beforeEach(() => {
		vi.mocked(openKustoWorkbenchAgentChat).mockReset().mockResolvedValue(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, globalState, postMessage } = createHandler();
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(globalState.get).not.toHaveBeenCalled();
		expect(globalState.update).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('publishes exact proceed for already-seen state without writing or showing UI', async () => {
		const { handler, globalState, postMessage } = createHandler();
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
		globalState.get.mockReturnValue(true);
		const message = firstTimeMessage('  already-seen-box  ');

		await expect(handler.handleMessage(message)).resolves.toBeUndefined();

		expect(globalState.get).toHaveBeenCalledOnce();
		expect(globalState.get).toHaveBeenCalledWith(STORAGE_KEYS.copilotChatFirstTimeDismissed);
		expect(globalState.update).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'copilotChatFirstTimeResult',
			boxId: message.boxId,
			action: 'proceed',
		});
	});

	it('writes the dismissed flag before showing the exact modal and publishing proceed', async () => {
		const events: string[] = [];
		const write = deferred<void>();
		const { handler, globalState, postMessage } = createHandler();
		globalState.get.mockImplementation(() => {
			events.push('read');
			return false;
		});
		globalState.update.mockImplementation(async () => {
			events.push('write:start');
			await write.promise;
			events.push('write:end');
		});
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage')
			.mockImplementation(async () => {
				events.push('modal');
				return useChatAction;
			});
		postMessage.mockImplementation(() => {
			events.push('transport');
			return true;
		});
		const message = firstTimeMessage('write-before-modal-box');

		const request = handler.handleMessage(message)!;
		await Promise.resolve();

		expect(events).toEqual(['read', 'write:start']);
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(globalState.update).toHaveBeenCalledWith(
			STORAGE_KEYS.copilotChatFirstTimeDismissed,
			true,
		);

		write.resolve();
		await expect(request).resolves.toBeUndefined();

		expect(events).toEqual(['read', 'write:start', 'write:end', 'modal', 'transport']);
		expect(showInformationMessage).toHaveBeenCalledWith(
			firstTimeMessageText,
			{ modal: true },
			openAgentAction,
			useChatAction,
		);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'copilotChatFirstTimeResult', boxId: message.boxId, action: 'proceed',
		});
	});

	it.each([
		{ choice: openAgentAction, action: 'openedAgent', opensAgent: true },
		{ choice: useChatAction, action: 'proceed', opensAgent: false },
		{ choice: undefined, action: 'dismissed', opensAgent: false },
	] as const)('maps $action choice to the exact result', async ({ choice, action, opensAgent }) => {
		const { handler, globalState, postMessage } = createHandler();
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage')
			.mockResolvedValue(choice);
		const message = firstTimeMessage(`choice-${action}`);

		await expect(handler.handleMessage(message)).resolves.toBeUndefined();

		expect(globalState.update).toHaveBeenCalledWith(
			STORAGE_KEYS.copilotChatFirstTimeDismissed,
			true,
		);
		expect(showInformationMessage).toHaveBeenCalledWith(
			firstTimeMessageText,
			{ modal: true },
			openAgentAction,
			useChatAction,
		);
		if (opensAgent) {
			expect(openKustoWorkbenchAgentChat).toHaveBeenCalledOnce();
			expect(vi.mocked(openKustoWorkbenchAgentChat).mock.calls[0]).toEqual([]);
		} else {
			expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
		}
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'copilotChatFirstTimeResult', boxId: message.boxId, action,
		});
	});

	it('awaits Agent Chat settlement and discards its resolved boolean before publishing', async () => {
		const helper = deferred<boolean>();
		const { handler, postMessage } = createHandler();
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(openAgentAction);
		vi.mocked(openKustoWorkbenchAgentChat).mockReturnValue(helper.promise);
		const message = firstTimeMessage('helper-settlement-box');
		let settled = false;

		const request = handler.handleMessage(message)!;
		void request.finally(() => { settled = true; });
		await Promise.resolve();
		await Promise.resolve();

		expect(openKustoWorkbenchAgentChat).toHaveBeenCalledOnce();
		expect(postMessage).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		helper.resolve(false);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'copilotChatFirstTimeResult', boxId: message.boxId, action: 'openedAgent',
		});
	});

	it('propagates exact state read, state write, and modal failures without later effects', async () => {
		const readFailure = new Error('first-time state read failed');
		const writeFailure = new Error('first-time state write failed');
		const modalFailure = new Error('first-time modal failed');

		const readCase = createHandler();
		readCase.globalState.get.mockImplementation(() => { throw readFailure; });
		const readModal = vi.spyOn(vscode.window, 'showInformationMessage');
		await expect(readCase.handler.handleMessage(firstTimeMessage('read-failure')))
			.rejects.toBe(readFailure);
		expect(readCase.globalState.update).not.toHaveBeenCalled();
		expect(readModal).not.toHaveBeenCalled();
		expect(readCase.postMessage).not.toHaveBeenCalled();
		readModal.mockRestore();

		const writeCase = createHandler();
		writeCase.globalState.update.mockRejectedValue(writeFailure);
		const writeModal = vi.spyOn(vscode.window, 'showInformationMessage');
		await expect(writeCase.handler.handleMessage(firstTimeMessage('write-failure')))
			.rejects.toBe(writeFailure);
		expect(writeModal).not.toHaveBeenCalled();
		expect(writeCase.postMessage).not.toHaveBeenCalled();
		writeModal.mockRestore();

		const modalCase = createHandler();
		const modal = vi.spyOn(vscode.window, 'showInformationMessage').mockRejectedValue(modalFailure);
		await expect(modalCase.handler.handleMessage(firstTimeMessage('modal-failure')))
			.rejects.toBe(modalFailure);
		expect(modal).toHaveBeenCalledOnce();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
		expect(modalCase.postMessage).not.toHaveBeenCalled();
	});

	it('propagates exact asynchronous and synchronous Agent Chat failures without publishing', async () => {
		const asynchronousFailure = new Error('Agent Chat failed asynchronously');
		const synchronousFailure = new Error('Agent Chat failed synchronously');
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(openAgentAction);

		const asynchronous = createHandler();
		vi.mocked(openKustoWorkbenchAgentChat).mockRejectedValueOnce(asynchronousFailure);
		await expect(asynchronous.handler.handleMessage(firstTimeMessage('async-helper-failure')))
			.rejects.toBe(asynchronousFailure);
		expect(asynchronous.postMessage).not.toHaveBeenCalled();

		const synchronous = createHandler();
		vi.mocked(openKustoWorkbenchAgentChat)
			.mockImplementationOnce(() => { throw synchronousFailure; });
		await expect(synchronous.handler.handleMessage(firstTimeMessage('sync-helper-failure')))
			.rejects.toBe(synchronousFailure);
		expect(synchronous.postMessage).not.toHaveBeenCalled();
	});

	it('does not await returned transport thenables and preserves exact synchronous transport failure', async () => {
		const transportThen = vi.fn();
		const fireAndForget = createHandler();
		fireAndForget.globalState.get.mockReturnValue(true);
		fireAndForget.postMessage.mockReturnValue({ then: transportThen });

		await expect(fireAndForget.handler.handleMessage(firstTimeMessage('pending-transport')))
			.resolves.toBeUndefined();
		expect(transportThen).not.toHaveBeenCalled();

		const transportFailure = new Error('first-time result transport threw');
		const throwing = createHandler();
		throwing.globalState.get.mockReturnValue(true);
		throwing.postMessage.mockImplementation(() => { throw transportFailure; });

		await expect(throwing.handler.handleMessage(firstTimeMessage('throwing-transport')))
			.rejects.toBe(transportFailure);
	});

	it('allows accepted helper settlement and rejection to cross disposal', async () => {
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(openAgentAction);
		const successHelper = deferred<boolean>();
		const success = createHandler();
		vi.mocked(openKustoWorkbenchAgentChat).mockReturnValueOnce(successHelper.promise);
		const successMessage = firstTimeMessage('dispose-success');
		const successRequest = success.handler.handleMessage(successMessage)!;
		await Promise.resolve();
		await Promise.resolve();

		success.handler.dispose();
		successHelper.resolve(true);
		await expect(successRequest).resolves.toBeUndefined();
		expect(success.postMessage).toHaveBeenCalledWith({
			type: 'copilotChatFirstTimeResult', boxId: successMessage.boxId, action: 'openedAgent',
		});

		const failure = new Error('accepted helper failed after disposal');
		const rejectedHelper = deferred<boolean>();
		const rejected = createHandler();
		vi.mocked(openKustoWorkbenchAgentChat).mockReturnValueOnce(rejectedHelper.promise);
		const rejectedRequest = rejected.handler.handleMessage(firstTimeMessage('dispose-failure'))!;
		await Promise.resolve();
		await Promise.resolve();

		rejected.handler.dispose();
		rejectedHelper.reject(failure);
		await expect(rejectedRequest).rejects.toBe(failure);
		expect(rejected.postMessage).not.toHaveBeenCalled();
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const { handler, globalState, postMessage } = createHandler();
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(firstTimeMessage('disposed-request'));

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(globalState.get).not.toHaveBeenCalled();
		expect(globalState.update).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(openKustoWorkbenchAgentChat).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});
});