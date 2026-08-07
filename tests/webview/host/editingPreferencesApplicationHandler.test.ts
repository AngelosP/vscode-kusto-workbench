import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/editingPreferences', () => ({
	setEditingPreference: vi.fn(),
}));

import type { EditingPreferencesDataMessage } from '../../../src/shared/editingPreferences';
import { setEditingPreference } from '../../../src/host/editingPreferences';
import {
	HostEditingPreferencesApplicationHandler,
	type EditingPreferencesApplicationHandlerOptions,
} from '../../../src/host/editingPreferencesApplicationHandler';
import { STORAGE_KEYS, type IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function preferences(revision: number): EditingPreferencesDataMessage {
	return {
		type: 'editingPreferencesData',
		revision,
		caretDocsEnabled: true,
		caretDocsEnabledUserSet: true,
		autoTriggerAutocompleteEnabled: false,
		autoTriggerAutocompleteEnabledUserSet: true,
		copilotInlineCompletionsEnabled: true,
		copilotInlineCompletionsEnabledUserSet: true,
	};
}

function createHarness(overrides: Partial<EditingPreferencesApplicationHandlerOptions> = {}) {
	const publisher = { postToAllWebviews: vi.fn(async () => undefined) };
	const postMessage = vi.fn(async () => true);
	const options: EditingPreferencesApplicationHandlerOptions = {
		context: { globalState: {} } as EditingPreferencesApplicationHandlerOptions['context'],
		getPublisher: () => publisher,
		postMessage,
		...overrides,
	};
	return {
		handler: new HostEditingPreferencesApplicationHandler(options),
		options,
		publisher,
		postMessage,
	};
}

describe('HostEditingPreferencesApplicationHandler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('declines unrelated traffic synchronously', () => {
		const { handler, publisher, postMessage } = createHarness();

		expect(handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
		expect(setEditingPreference).not.toHaveBeenCalled();
		expect(publisher.postToAllWebviews).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('maps all three discriminators and normalizes enabled values exactly once', async () => {
		const authoritative = preferences(21);
		vi.mocked(setEditingPreference).mockResolvedValue(authoritative);
		const { handler, options, publisher } = createHarness();
		const messages = [
			{ type: 'setCaretDocsEnabled', enabled: 0 },
			{ type: 'setAutoTriggerAutocompleteEnabled', enabled: 'enabled' },
			{ type: 'setCopilotInlineCompletionsEnabled', enabled: null },
		] as unknown as IncomingWebviewMessage[];

		for (const message of messages) {
			await handler.handleMessage(message);
		}

		expect(setEditingPreference).toHaveBeenNthCalledWith(1, options.context, STORAGE_KEYS.caretDocsEnabled, false);
		expect(setEditingPreference).toHaveBeenNthCalledWith(2, options.context, STORAGE_KEYS.autoTriggerAutocompleteEnabled, true);
		expect(setEditingPreference).toHaveBeenNthCalledWith(3, options.context, STORAGE_KEYS.copilotInlineCompletionsEnabled, false);
		expect(setEditingPreference).toHaveBeenCalledTimes(3);
		expect(publisher.postToAllWebviews).toHaveBeenCalledTimes(3);
		for (const [message] of publisher.postToAllWebviews.mock.calls) {
			expect(message).toBe(authoritative);
		}
	});

	it('awaits one mutation and broadcasts its authoritative object through the live publisher', async () => {
		const mutation = deferred<EditingPreferencesDataMessage>();
		const publication = deferred<unknown>();
		const authoritative = preferences(22);
		vi.mocked(setEditingPreference).mockReturnValue(mutation.promise);
		let publisher: EditingPreferencesApplicationHandlerOptions['getPublisher'] extends () => infer T ? T : never;
		const postToAllWebviews = vi.fn(() => publication.promise);
		const fallback = vi.fn(async () => true);
		const { handler } = createHarness({
			getPublisher: () => publisher,
			postMessage: fallback,
		});
		let settled = false;

		const request = handler.handleMessage({ type: 'setCaretDocsEnabled', enabled: true });
		void request?.finally(() => { settled = true; });
		await Promise.resolve();
		expect(setEditingPreference).toHaveBeenCalledOnce();
		expect(postToAllWebviews).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		publisher = { postToAllWebviews };
		mutation.resolve(authoritative);
		await vi.waitFor(() => expect(postToAllWebviews).toHaveBeenCalledOnce());
		expect(postToAllWebviews.mock.calls[0][0]).toBe(authoritative);
		expect(fallback).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		publication.resolve(undefined);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('awaits the current-panel fallback with the authoritative object when no publisher exists', async () => {
		const authoritative = preferences(23);
		const publication = deferred<boolean>();
		vi.mocked(setEditingPreference).mockResolvedValue(authoritative);
		const postMessage = vi.fn(() => publication.promise);
		const { handler, publisher } = createHarness({
			getPublisher: () => undefined,
			postMessage,
		});
		let settled = false;

		const request = handler.handleMessage({ type: 'setAutoTriggerAutocompleteEnabled', enabled: false });
		void request?.finally(() => { settled = true; });
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());

		expect(postMessage.mock.calls[0][0]).toBe(authoritative);
		expect(publisher.postToAllWebviews).not.toHaveBeenCalled();
		expect(settled).toBe(false);
		publication.resolve(true);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('propagates the exact mutation rejection without publication', async () => {
		const failure = new Error('preference mutation failed');
		vi.mocked(setEditingPreference).mockRejectedValue(failure);
		const { handler, publisher, postMessage } = createHarness();

		await expect(handler.handleMessage({
			type: 'setCopilotInlineCompletionsEnabled', enabled: true,
		})).rejects.toBe(failure);
		expect(publisher.postToAllWebviews).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('propagates exact global and fallback publication rejections', async () => {
		const authoritative = preferences(24);
		vi.mocked(setEditingPreference).mockResolvedValue(authoritative);
		const globalFailure = new Error('global publication failed');
		const global = createHarness();
		global.publisher.postToAllWebviews.mockRejectedValue(globalFailure);

		await expect(global.handler.handleMessage({
			type: 'setCaretDocsEnabled', enabled: true,
		})).rejects.toBe(globalFailure);

		const fallbackFailure = new Error('panel publication failed');
		const fallback = createHarness({
			getPublisher: () => undefined,
			postMessage: vi.fn(() => Promise.reject(fallbackFailure)),
		});
		await expect(fallback.handler.handleMessage({
			type: 'setCaretDocsEnabled', enabled: false,
		})).rejects.toBe(fallbackFailure);
	});

	it('settles accepted work across idempotent disposal and suppresses later requests', async () => {
		const mutation = deferred<EditingPreferencesDataMessage>();
		const authoritative = preferences(25);
		vi.mocked(setEditingPreference).mockReturnValue(mutation.promise);
		const { handler, publisher, postMessage } = createHarness();
		const accepted = handler.handleMessage({ type: 'setCaretDocsEnabled', enabled: true });

		handler.dispose();
		handler.dispose();
		const suppressed = handler.handleMessage({ type: 'setAutoTriggerAutocompleteEnabled', enabled: true });
		mutation.resolve(authoritative);

		await expect(accepted).resolves.toBeUndefined();
		await expect(suppressed).resolves.toBeUndefined();
		expect(setEditingPreference).toHaveBeenCalledOnce();
		expect(publisher.postToAllWebviews).toHaveBeenCalledOnce();
		expect(publisher.postToAllWebviews.mock.calls[0][0]).toBe(authoritative);
		expect(postMessage).not.toHaveBeenCalled();
	});
});
