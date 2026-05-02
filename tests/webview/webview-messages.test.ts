import { describe, expect, it, vi } from 'vitest';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';

describe('postMessageToHost', () => {
	it('calls vscode.postMessage when available', () => {
		const postMessage = vi.fn();
		(window as any).vscode = { postMessage };

		postMessageToHost({ type: 'getConnections' });

		expect(postMessage).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith({ type: 'getConnections' });
	});

	it('does not throw when vscode is undefined', () => {
		delete (window as any).vscode;
		expect(() => postMessageToHost({ type: 'getConnections' })).not.toThrow();
	});

	it('posts cursor position payloads', () => {
		const postMessage = vi.fn();
		(window as any).vscode = { postMessage };

		postMessageToHost({
			type: 'editorCursorPositionChanged',
			boxId: 'query_1',
			editorKind: 'kusto',
			line: 4,
			column: 41,
			visible: true,
			reason: 'test'
		});

		expect(postMessage).toHaveBeenCalledWith({
			type: 'editorCursorPositionChanged',
			boxId: 'query_1',
			editorKind: 'kusto',
			line: 4,
			column: 41,
			visible: true,
			reason: 'test'
		});
	});

	it('posts cursor status snapshot requests', () => {
		const postMessage = vi.fn();
		(window as any).vscode = { postMessage };

		postMessageToHost({ type: 'getEditorCursorStatusSnapshot', requestId: 'cursor-request-1' });

		expect(postMessage).toHaveBeenCalledWith({
			type: 'getEditorCursorStatusSnapshot',
			requestId: 'cursor-request-1'
		});
	});
});
