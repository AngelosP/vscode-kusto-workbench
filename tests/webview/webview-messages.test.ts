import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pState } from '../../src/webview/shared/persistence-state.js';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';

describe('webview document-view transport', () => {
	const postMessage = vi.fn();

	beforeEach(() => {
		postMessage.mockReset();
		pState.documentViewSessionId = '';
		pState.compatibilityPersistenceViewSessionId = '';
		pState.compatibilityPersistenceDocumentRequestIds.clear();
		(window as any).vscode = { postMessage };
	});

	afterEach(() => {
		pState.documentViewSessionId = '';
		pState.compatibilityPersistenceViewSessionId = '';
		pState.compatibilityPersistenceDocumentRequestIds.clear();
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

	it('stamps compatibility document requests and tracks their correlation', () => {
		pState.compatibilityPersistenceViewSessionId = 'compatibility-session-1';
		postMessageToHost({ type: 'requestDocument' });

		const message = postMessage.mock.calls[0]?.[0];
		expect(message).toEqual(expect.objectContaining({
			protocolVersion: 1,
			channel: 'compatibility-persistence',
			viewSessionId: 'compatibility-session-1',
			type: 'requestDocument',
		}));
		expect(typeof message.requestId).toBe('string');
		expect(pState.compatibilityPersistenceDocumentRequestIds.has(message.requestId)).toBe(true);
	});

	it('bounds pending compatibility document requests', () => {
		pState.compatibilityPersistenceViewSessionId = 'compatibility-session-1';
		for (let index = 0; index < 70; index++) {
			postMessageToHost({ type: 'requestDocument', requestId: `request-${index}` });
		}

		expect(pState.compatibilityPersistenceDocumentRequestIds.size).toBe(64);
		expect(pState.compatibilityPersistenceDocumentRequestIds.has('request-0')).toBe(false);
		expect(pState.compatibilityPersistenceDocumentRequestIds.has('request-69')).toBe(true);
	});

	it('stamps valid compatibility snapshots and drops malformed ones', () => {
		pState.compatibilityPersistenceViewSessionId = 'compatibility-session-1';
		postMessageToHost({
			type: 'persistDocument', state: { sections: [] }, sourceGeneration: 2,
			editRevision: 3, snapshotId: 'snapshot-1',
		});

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			protocolVersion: 1,
			channel: 'compatibility-persistence',
			viewSessionId: 'compatibility-session-1',
			type: 'persistDocument',
			snapshotId: 'snapshot-1',
		}));
		postMessage.mockClear();

		postMessageToHost({
			type: 'persistDocument', state: { sections: [] }, sourceGeneration: 2,
			editRevision: -1, snapshotId: 'snapshot-malformed',
		});
		expect(postMessage).not.toHaveBeenCalled();
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

	it('posts valid Kusto schema requests and drops malformed recognized requests', () => {
		const postMessage = vi.fn();
		(window as any).vscode = { postMessage };
		postMessageToHost({
			type: 'requestCrossClusterSchema', clusterName: 'remote', database: 'Telemetry',
			boxId: 'query_1', requestToken: 'token-1', requestSource: 'background',
		});

		expect(postMessage).toHaveBeenCalledOnce();
		postMessage.mockClear();
		postMessageToHost({
			type: 'requestCrossClusterSchema', clusterName: 'remote', database: 'Telemetry',
			boxId: 'query_1', requestToken: 'token-1', requestSource: 'manual',
		} as unknown as Parameters<typeof postMessageToHost>[0]);

		expect(postMessage).not.toHaveBeenCalled();
	});

	it('posts valid Kusto database requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const request = {
				type: 'refreshDatabases' as const, connectionId: '', boxId: 'query_1',
				requestToken: 'token-1', sectionInstanceId: 'instance-1', targetGeneration: 2,
			};
			postMessageToHost(request);

			expect(capture).toHaveBeenCalledWith(request);
			expect(postMessage).toHaveBeenCalledWith(request);
			capture.mockClear();
			postMessage.mockClear();

			postMessageToHost({
				type: 'getDatabases', connectionId: 'connection-1', boxId: 'query_1', targetGeneration: '2',
			} as unknown as Parameters<typeof postMessageToHost>[0]);
			postMessageToHost(Object.assign([], {
				type: 'refreshDatabases', connectionId: 'connection-1', boxId: 'query_1',
			}) as unknown as Parameters<typeof postMessageToHost>[0]);

			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});

	it('posts valid SQL database requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const request = {
				type: 'refreshSqlDatabases' as const, sqlConnectionId: 'sql-1', boxId: 'sql_1',
				sectionInstanceId: 'instance-1', targetGeneration: 2,
			};
			postMessageToHost(request);

			expect(capture).toHaveBeenCalledWith(request);
			expect(postMessage).toHaveBeenCalledWith(request);
			capture.mockClear();
			postMessage.mockClear();

			postMessageToHost({
				type: 'getSqlDatabases', sqlConnectionId: 'sql-1', boxId: 'sql_1',
				sectionInstanceId: 'instance-1', targetGeneration: '2',
			} as unknown as Parameters<typeof postMessageToHost>[0]);
			postMessageToHost(Object.assign([], {
				type: 'refreshSqlDatabases', sqlConnectionId: 'sql-1', boxId: 'sql_1',
				sectionInstanceId: 'instance-1', targetGeneration: 2,
			}) as unknown as Parameters<typeof postMessageToHost>[0]);

			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});

	it('posts valid SQL schema requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const request = {
				type: 'prefetchSqlSchema' as const, sqlConnectionId: 'sql-1', database: 'Db',
				boxId: 'sql_1', sectionInstanceId: 'instance-1', targetGeneration: 2,
				forceRefresh: false,
			};
			postMessageToHost(request);

			expect(capture).toHaveBeenCalledWith(request);
			expect(postMessage).toHaveBeenCalledWith(request);
			capture.mockClear();
			postMessage.mockClear();

			postMessageToHost({
				type: 'prefetchSqlSchema', sqlConnectionId: 'sql-1', database: 'Db',
				boxId: 'sql_1', sectionInstanceId: 'instance-1', targetGeneration: 2,
				forceRefresh: 'yes',
			} as unknown as Parameters<typeof postMessageToHost>[0]);
			postMessageToHost(Object.assign([], {
				type: 'prefetchSqlSchema', sqlConnectionId: 'sql-1', database: 'Db',
				boxId: 'sql_1', sectionInstanceId: 'instance-1', targetGeneration: 2,
			}) as unknown as Parameters<typeof postMessageToHost>[0]);

			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});

	it('posts valid KQL language requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const params = {
				text: 'StormEvents', connectionId: 'connection-1', database: 'Samples',
				boxId: 'query-1', uri: 'file:///workspace/query.kql',
			};
			const requests = [
				{ type: 'kqlLanguageRequest', requestId: 'diagnostics-1', method: 'textDocument/diagnostic', params },
				{ type: 'kqlLanguageRequest', requestId: 'references-1', method: 'kusto/findTableReferences', params },
			] as const;
			for (const request of requests) {
				postMessageToHost(request);
				expect(capture.mock.calls.at(-1)?.[0]).toBe(request);
				expect(postMessage.mock.calls.at(-1)?.[0]).toBe(request);
			}
			capture.mockClear();
			postMessage.mockClear();

			for (const request of [
				{ type: 'kqlLanguageRequest', requestId: '   ', method: 'kusto/findTableReferences', params },
				{ type: 'kqlLanguageRequest', requestId: 'unsupported-1', method: 'workspace/symbol', params },
				{ type: 'kqlLanguageRequest', requestId: 'malformed-1', method: 'textDocument/diagnostic', params: { text: 42 } },
				Object.assign([], {
					type: 'kqlLanguageRequest', requestId: 'array-1', method: 'kusto/findTableReferences', params,
				}),
			]) {
				postMessageToHost(request as unknown as Parameters<typeof postMessageToHost>[0]);
			}

			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});

	it('posts valid control-command syntax requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const request = {
				type: 'fetchControlCommandSyntax' as const,
				requestId: 'syntax-request-1',
				commandLower: '.show tables',
				href: '/en-us/kusto/management/show-tables-command',
			};
			postMessageToHost(request);

			expect(capture).toHaveBeenCalledWith(request);
			expect(postMessage).toHaveBeenCalledWith(request);
			capture.mockClear();
			postMessage.mockClear();

			for (const malformed of [
				{ ...request, requestId: '   ' },
				{ ...request, commandLower: 42 },
				{ ...request, href: '' },
				Object.assign([], request),
			]) {
				postMessageToHost(malformed as unknown as Parameters<typeof postMessageToHost>[0]);
			}

			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});

	it('posts valid resource URI requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const requests = [
				{
					type: 'resolveResourceUri', requestId: ' resource-request-1 ',
					path: ' ./images/logo.png ', baseUri: '',
				},
				{
					type: 'resolveResourceUri', requestId: 'resource-request-2', path: '',
				},
			] as const;
			for (const request of requests) {
				postMessageToHost(request);
				expect(capture.mock.calls.at(-1)?.[0]).toBe(request);
				expect(postMessage.mock.calls.at(-1)?.[0]).toBe(request);
			}
			capture.mockClear();
			postMessage.mockClear();

			for (const malformed of [
				{ ...requests[0], requestId: '' },
				{ ...requests[0], path: 42 },
				{ ...requests[0], baseUri: null },
				Object.assign([], requests[0]),
			]) {
				postMessageToHost(malformed as unknown as Parameters<typeof postMessageToHost>[0]);
			}

			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});

	it('posts valid URL requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const request = {
				type: 'fetchUrl' as const, boxId: 'url-section',
				url: 'https://example.com/data.csv', requestId: 'url-request-1',
			};
			postMessageToHost(request);

			expect(capture.mock.calls[0]?.[0]).toEqual(request);
			expect(capture.mock.calls[0]?.[0]).not.toBe(request);
			expect(postMessage.mock.calls[0]?.[0]).toEqual(request);
			expect(postMessage.mock.calls[0]?.[0]).not.toBe(request);
			capture.mockClear();
			postMessage.mockClear();
			let propertyReads = 0;
			const requestProxy = new Proxy(request, {
				get() {
					propertyReads++;
					throw new Error('property read');
				},
			});
			postMessageToHost(requestProxy);
			expect(capture.mock.calls[0]?.[0]).toEqual(request);
			expect(postMessage.mock.calls[0]?.[0]).toEqual(request);
			expect(propertyReads).toBe(0);
			capture.mockClear();
			postMessage.mockClear();

			const inheritedRequestId = Object.assign(Object.create({ requestId: request.requestId }), {
				type: request.type, boxId: request.boxId, url: request.url,
			});
			for (const malformed of [
				{ ...request, boxId: '' },
				{ ...request, url: 42 },
				{ ...request, requestId: [] },
				inheritedRequestId,
				Object.assign([], request),
				Object.assign(() => undefined, request),
			]) {
				postMessageToHost(malformed as unknown as Parameters<typeof postMessageToHost>[0]);
			}

			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});

	it('snapshots valid Python requests and rejects malformed ones before E2E capture', () => {
		const postMessage = vi.fn();
		const capture = vi.fn();
		(window as any).vscode = { postMessage };
		(window as any).__e2eCaptureHostMessage = capture;
		try {
			const request = {
				type: 'executePython' as const, boxId: 'python-section', code: '',
			};
			postMessageToHost(request);

			expect(capture.mock.calls[0]?.[0]).toEqual(request);
			expect(capture.mock.calls[0]?.[0]).not.toBe(request);
			expect(postMessage.mock.calls[0]?.[0]).toEqual(request);
			expect(postMessage.mock.calls[0]?.[0]).not.toBe(request);
			capture.mockClear();
			postMessage.mockClear();

			let propertyReads = 0;
			postMessageToHost(new Proxy(request, {
				get() {
					propertyReads++;
					throw new Error('property read');
				},
			}));
			expect(capture).toHaveBeenCalledWith(request);
			expect(postMessage).toHaveBeenCalledWith(request);
			expect(propertyReads).toBe(0);
			capture.mockClear();
			postMessage.mockClear();

			for (const malformed of [
				{ ...request, boxId: ['python-section'] },
				{ ...request, code: null },
				Object.assign([], request),
				Object.assign(() => undefined, request),
			]) {
				postMessageToHost(malformed as unknown as Parameters<typeof postMessageToHost>[0]);
			}
			expect(capture).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		} finally {
			delete (window as any).__e2eCaptureHostMessage;
		}
	});
});
