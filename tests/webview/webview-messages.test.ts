import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pState } from '../../src/webview/shared/persistence-state.js';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';

describe('webview document-view transport', () => {
	const postMessage = vi.fn();

	beforeEach(() => {
		postMessage.mockReset();
		pState.documentViewSessionId = '';
		(window as any).vscode = { postMessage };
	});

	afterEach(() => {
		pState.documentViewSessionId = '';
		delete (window as any).vscode;
	});

	it('stamps a valid host-owned command with the current view session', () => {
		pState.documentViewSessionId = 'view-session-1';
		postMessageToHost({
			type: 'markdownDocumentCommand', commandId: 'command-1', sourceGeneration: 2,
			expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0,
				patch: { text: 'after' },
			},
		});

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			protocolVersion: 1,
			channel: 'document-view',
			viewSessionId: 'view-session-1',
			type: 'markdownDocumentCommand',
			commandId: 'command-1',
		}));
	});

	it('preserves metadata-free compatibility acknowledgements outside a native session', () => {
		postMessageToHost({
			type: 'documentReloadResult', requestId: 'compat-reload', applied: true, editRevision: 0,
		});

		expect(postMessage).toHaveBeenCalledWith({
			type: 'documentReloadResult', requestId: 'compat-reload', applied: true, editRevision: 0,
		});
	});

	it('drops malformed in-scope messages instead of posting them', () => {
		pState.documentViewSessionId = 'view-session-1';
		postMessageToHost({
			type: 'markdownDocumentCommand', commandId: 'command-1', sourceGeneration: -1,
			expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0,
				patch: { text: 'after' },
			},
		});

		expect(postMessage).not.toHaveBeenCalled();
	});
});import { describe, expect, it, vi } from 'vitest';
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
