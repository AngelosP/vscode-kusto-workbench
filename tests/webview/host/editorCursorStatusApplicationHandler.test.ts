import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __mockStatusBarItems, ExtensionMode } from 'vscode';

import { EditorCursorStatusBar } from '../../../src/host/editorCursorStatusBar';
import { HostEditorCursorStatusApplicationHandler } from '../../../src/host/editorCursorStatusApplicationHandler';
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

function createStatusBar(snapshot: { visible: boolean; text: string } = { visible: false, text: '' }) {
	return {
		update: vi.fn(),
		getSnapshot: vi.fn(() => snapshot),
		clearOwnerPrefix: vi.fn(),
		dispose: vi.fn(),
	};
}

describe('HostEditorCursorStatusApplicationHandler', () => {
	beforeEach(() => {
		__mockStatusBarItems.length = 0;
	});

	it('declines unrelated traffic and updates only while visible with trimmed owner identities', () => {
		const statusBar = createStatusBar();
		const handler = new HostEditorCursorStatusApplicationHandler({
			statusBar,
			extensionMode: ExtensionMode.Development,
			postMessage: vi.fn(async () => true),
		});
		const update = {
			type: 'editorCursorPositionChanged',
			boxId: '  query_13  ',
			editorKind: 'kusto',
			line: 8,
			column: 13,
			visible: true,
		} satisfies IncomingWebviewMessage;

		expect(handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
		expect(handler.handleMessage(update)).toBe(true);
		expect(statusBar.update).not.toHaveBeenCalled();

		handler.setPanelVisible(true);
		expect(handler.handleMessage(update)).toBe(true);
		expect(statusBar.update).toHaveBeenCalledTimes(1);
		expect(statusBar.update.mock.calls[0][1]).toBe(update);
		const boxOwnerId = statusBar.update.mock.calls[0][0] as string;
		expect(boxOwnerId).toMatch(/^queryEditor:\d+:query_13$/);

		const trimmedKind = {
			type: 'editorCursorPositionChanged',
			boxId: '   ',
			editorKind: '  sql  ',
			line: 3,
			column: 5,
		} as unknown as IncomingWebviewMessage;
		handler.handleMessage(trimmedKind);
		const kindOwnerId = statusBar.update.mock.calls[1][0] as string;
		expect(kindOwnerId).toBe(`${boxOwnerId.slice(0, -'query_13'.length)}sql`);

		const fallback = {
			type: 'editorCursorPositionChanged',
			boxId: '',
			line: 1,
			column: 1,
		} satisfies IncomingWebviewMessage;
		handler.handleMessage(fallback);
		const fallbackOwnerId = statusBar.update.mock.calls[2][0] as string;
		expect(fallbackOwnerId).toBe(`${boxOwnerId.slice(0, -'query_13'.length)}editor`);

		handler.setPanelVisible(false);
		expect(statusBar.clearOwnerPrefix).toHaveBeenCalledWith(boxOwnerId.slice(0, -'query_13'.length));
		handler.handleMessage(update);
		expect(statusBar.update).toHaveBeenCalledTimes(3);
	});

	it('awaits development snapshot transport and preserves the exact request and snapshot', async () => {
		const snapshot = { visible: true, text: 'Ln 8, Col 13' };
		const statusBar = createStatusBar(snapshot);
		const delivery = deferred<boolean>();
		const postMessage = vi.fn(() => delivery.promise);
		const handler = new HostEditorCursorStatusApplicationHandler({
			statusBar,
			extensionMode: ExtensionMode.Development,
			postMessage,
		});
		const request = {
			type: 'getEditorCursorStatusSnapshot',
			requestId: '  cursor-snapshot-13  ',
		} satisfies IncomingWebviewMessage;

		const handled = handler.handleMessage(request);
		expect(handled).toBeInstanceOf(Promise);
		let settled = false;
		void handled?.finally(() => { settled = true; });
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(statusBar.getSnapshot).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'editorCursorStatusSnapshot',
			requestId: request.requestId,
			snapshot,
		});
		expect((postMessage.mock.calls[0][0] as { snapshot: unknown }).snapshot).toBe(snapshot);

		delivery.resolve(true);
		await expect(handled).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('uses the hidden fallback without an adapter and swallows snapshot transport failures', async () => {
		const rejectingPostMessage = vi.fn(() => Promise.reject(new Error('transport rejected')));
		const rejectingHandler = new HostEditorCursorStatusApplicationHandler({
			extensionMode: ExtensionMode.Development,
			postMessage: rejectingPostMessage,
		});

		await expect(rejectingHandler.handleMessage({
			type: 'getEditorCursorStatusSnapshot',
			requestId: 'fallback-request',
		})).resolves.toBeUndefined();
		expect(rejectingPostMessage).toHaveBeenCalledWith({
			type: 'editorCursorStatusSnapshot',
			requestId: 'fallback-request',
			snapshot: { visible: false, text: '' },
		});

		const throwingHandler = new HostEditorCursorStatusApplicationHandler({
			extensionMode: ExtensionMode.Development,
			postMessage: vi.fn(() => { throw new Error('transport threw'); }),
		});
		await expect(throwingHandler.handleMessage({
			type: 'getEditorCursorStatusSnapshot',
			requestId: 'throwing-request',
		})).resolves.toBeUndefined();
	});

	it('suppresses production snapshots', async () => {
		const statusBar = createStatusBar({ visible: true, text: 'Ln 1, Col 2' });
		const postMessage = vi.fn(async () => true);
		const handler = new HostEditorCursorStatusApplicationHandler({
			statusBar,
			extensionMode: ExtensionMode.Production,
			postMessage,
		});

		await expect(handler.handleMessage({
			type: 'getEditorCursorStatusSnapshot',
			requestId: 'production-request',
		})).resolves.toBeUndefined();
		expect(statusBar.getSnapshot).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('disposes idempotently, clears its prefix, and suppresses later cursor traffic', async () => {
		const statusBar = createStatusBar();
		const postMessage = vi.fn(async () => true);
		const handler = new HostEditorCursorStatusApplicationHandler({
			statusBar,
			extensionMode: ExtensionMode.Development,
			postMessage,
		});
		const update = {
			type: 'editorCursorPositionChanged',
			boxId: 'query_13',
			editorKind: 'kusto',
			line: 2,
			column: 4,
		} satisfies IncomingWebviewMessage;
		handler.setPanelVisible(true);
		handler.handleMessage(update);
		const ownerPrefix = (statusBar.update.mock.calls[0][0] as string).slice(0, -'query_13'.length);

		handler.dispose();
		handler.dispose();
		handler.setPanelVisible(true);
		expect(handler.handleMessage(update)).toBe(true);
		await expect(handler.handleMessage({
			type: 'getEditorCursorStatusSnapshot',
			requestId: 'after-dispose',
		})).resolves.toBeUndefined();

		expect(statusBar.clearOwnerPrefix).toHaveBeenCalledTimes(1);
		expect(statusBar.clearOwnerPrefix).toHaveBeenCalledWith(ownerPrefix);
		expect(statusBar.update).toHaveBeenCalledTimes(1);
		expect(statusBar.dispose).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
	});

	it('uses unique prefixes and leaves stale-owner protection with the shared status bar', () => {
		const statusBar = new EditorCursorStatusBar();
		const first = new HostEditorCursorStatusApplicationHandler({
			statusBar,
			extensionMode: ExtensionMode.Development,
			postMessage: vi.fn(async () => true),
		});
		const second = new HostEditorCursorStatusApplicationHandler({
			statusBar,
			extensionMode: ExtensionMode.Development,
			postMessage: vi.fn(async () => true),
		});
		const update = {
			type: 'editorCursorPositionChanged',
			boxId: 'shared_box',
			editorKind: 'html',
			line: 6,
			column: 9,
		} satisfies IncomingWebviewMessage;
		first.setPanelVisible(true);
		second.setPanelVisible(true);
		first.handleMessage(update);
		const firstOwner = statusBar.getSnapshot().ownerId;
		second.handleMessage(update);
		const secondOwner = statusBar.getSnapshot().ownerId;

		expect(firstOwner).not.toBe(secondOwner);
		expect(secondOwner).toMatch(/^queryEditor:\d+:shared_box$/);
		first.setPanelVisible(false);
		expect(statusBar.getSnapshot().ownerId).toBe(secondOwner);
		first.dispose();
		expect(statusBar.getSnapshot().ownerId).toBe(secondOwner);
		expect(__mockStatusBarItems[0].disposed).toBe(false);

		second.dispose();
		expect(statusBar.getSnapshot()).toEqual({ visible: false, text: '' });
		expect(__mockStatusBarItems[0].disposed).toBe(false);
		statusBar.dispose();
		expect(__mockStatusBarItems[0].disposed).toBe(true);
	});
});