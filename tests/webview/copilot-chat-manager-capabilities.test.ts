import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createSectionWithCapabilities: vi.fn(),
	postMessageToHost: vi.fn(),
	setSectionName: vi.fn(),
	emitAppliedDone: vi.fn(),
	displayResultBatchForBox: vi.fn(),
	prettifyKusto: vi.fn((value: string) => value),
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	createSectionWithCapabilities: mocks.createSectionWithCapabilities,
	schedulePersist: vi.fn(),
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: mocks.postMessageToHost,
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoSetSectionName: mocks.setSectionName,
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	__kustoGetLastOptimizeModelId: vi.fn(() => ''),
	__kustoSetLastOptimizeModelId: vi.fn(),
}));

vi.mock('../../src/webview/core/dropdown.js', () => ({
	syncSelectBackedDropdown: vi.fn(),
	renderMenuDropdownHtml: vi.fn(() => '<select></select>'),
}));

vi.mock('../../src/webview/core/state.js', () => ({
	connections: [],
	sqlConnections: [],
}));

vi.mock('../../src/webview/monaco/prettify.js', () => ({
	__kustoPrettifyKustoTextWithSemicolonStatements: mocks.prettifyKusto,
}));

vi.mock('../../src/webview/core/kusto-copilot-output-runtime.js', () => ({
	emitAppliedKustoCopilotDone: mocks.emitAppliedDone,
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	displayResultBatchForBox: mocks.displayResultBatchForBox,
}));

import '../../src/webview/components/kw-copilot-chat.js';
import { CopilotChatManagerController, type CopilotChatManagerHost } from '../../src/webview/sections/copilot-chat-manager.controller.js';
import { kustoWebviewFlavor, sqlWebviewFlavor } from '../../src/webview/sections/copilot-chat-flavor.js';

function createSqlManagerHost(boxId = 'sql_source'): HTMLElement & CopilotChatManagerHost {
	const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
	host.boxId = boxId;
	host.addController = vi.fn();
	host.getCopilotConnectionId = () => 'sql-connection-1';
	host.getCopilotServerUrl = () => 'sql.example';
	host.getCopilotOwnerToken = () => 'sql-owner-1';
	host.getDatabase = () => 'Db';
	host.getCopilotEditorValue = () => 'SELECT existing';
	host.layoutCopilotEditor = vi.fn();
	host.focusCopilotEditor = vi.fn();
	const wrapper = document.createElement('div');
	wrapper.className = 'query-editor-wrapper';
	host.appendChild(wrapper);
	document.body.appendChild(host);
	return host;
}

describe('CopilotChatManagerController document capabilities', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		vi.clearAllMocks();
	});

	it('rejects Copilot Insert before creating a section in compatibility mode', () => {
		mocks.createSectionWithCapabilities.mockReturnValue({
			ok: false, error: 'Adding a query section requires upgrading this compatibility file first.',
		});
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => 'print source = 1';
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		controller.installCopilotChat();
		const chat = host.querySelector('kw-copilot-chat');
		expect(chat).not.toBeNull();

		chat!.dispatchEvent(new CustomEvent('copilot-insert-query', {
			detail: { query: 'print inserted = 2' },
		}));

		expect(mocks.createSectionWithCapabilities).toHaveBeenCalledWith('query', expect.objectContaining({
			initialQuery: 'print inserted = 2', afterBoxId: 'query_source',
		}));
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'showInfo', message: 'Adding a query section requires upgrading this compatibility file first.',
		});
		expect(mocks.setSectionName).not.toHaveBeenCalled();
	});

	it('inserts every stored Kusto result as a conservative transient batch', async () => {
		mocks.createSectionWithCapabilities.mockReturnValue({ ok: true, sectionId: 'query_inserted' });
		const inserted = document.createElement('kw-query-section');
		inserted.id = 'query_inserted';
		document.body.appendChild(inserted);
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => 'print source = 1';
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		new CopilotChatManagerController(host, kustoWebviewFlavor).installCopilotChat();
		const result = {
			columns: ['First'], rows: [[1]], metadata: {},
			additionalResults: { version: 1, sets: [{
				resultIndex: 1, columns: ['Second'], rows: [[2]], metadata: {},
			}] },
		};

		host.querySelector('kw-copilot-chat')!.dispatchEvent(new CustomEvent('copilot-insert-query', {
			detail: { query: 'print 1; print 2', result },
		}));
		await new Promise(resolve => setTimeout(resolve, 120));

		expect(mocks.displayResultBatchForBox).toHaveBeenCalledWith(
			expect.objectContaining({ additionalResults: expect.objectContaining({ version: 1 }) }),
			'query_inserted',
			expect.objectContaining({
				artifactPublication: {
					producer: expect.objectContaining({ producer: 'copilot-insert' }),
				},
			}),
		);
	});

	it('writes exact generated Kusto into a newly inserted query section', async () => {
		mocks.createSectionWithCapabilities.mockReturnValue({ ok: true, sectionId: 'query_exact_insert' });
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => '';
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
		const executeEdits = vi.fn();
		const previousQueryEditors = window.queryEditors;
		window.queryEditors = {
			query_exact_insert: {
				getModel: () => ({ getFullModelRange: () => range }),
				executeEdits,
				focus: vi.fn(),
			},
		};
		const query = 'print Value=1 | extend Label = "A  B", Other = Value';
		mocks.prettifyKusto.mockReturnValueOnce('print Value=1\n| extend Label = "A B", Other = Value');

		try {
			new CopilotChatManagerController(host, kustoWebviewFlavor).installCopilotChat();
			host.querySelector('kw-copilot-chat')!.dispatchEvent(new CustomEvent('copilot-insert-query', {
				detail: { query },
			}));
			await new Promise(resolve => setTimeout(resolve, 120));

			expect(executeEdits).toHaveBeenCalledWith('copilot', [{ range, text: query }]);
		} finally {
			window.queryEditors = previousQueryEditors;
		}
	});

	it('emits exact Kusto and SQL preparation messages when installing each chat manager', () => {
		const createHost = (boxId: string) => {
			const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
			host.boxId = boxId;
			host.addController = vi.fn();
			host.getCopilotConnectionId = () => 'connection-1';
			host.getCopilotServerUrl = () => 'https://cluster.example';
			host.getDatabase = () => 'Db';
			host.getCopilotEditorValue = () => '';
			host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		return host;
		};
		const kustoHost = createHost('query_source');
		const sqlHost = createHost('sql_source');

		new CopilotChatManagerController(kustoHost, kustoWebviewFlavor).installCopilotChat();
		new CopilotChatManagerController(sqlHost, sqlWebviewFlavor).installCopilotChat();

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'prepareCopilotWriteQuery', boxId: 'query_source', flavor: 'kusto',
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'prepareCopilotWriteQuery', boxId: 'sql_source', flavor: 'sql',
		});
	});

	it('routes SQL progress to transient presentation and prose to durable chat history', async () => {
		const controller = new CopilotChatManagerController(createSqlManagerHost(), sqlWebviewFlavor);
		controller.installCopilotChat();
		const chat = controller.getCopilotChatEl()!;
		chat.setRunning(true);
		const initialMessages = chat.getMessages().length;

		controller.copilotWriteQueryStatus('Generating response (round 1)\u2026', '', 'progress');
		await chat.updateComplete;
		expect(chat.shadowRoot?.querySelector('[data-testid="copilot-chat-progress"]')?.textContent)
			.toBe('Generating response (round 1)\u2026');
		expect(chat.getMessages()).toHaveLength(initialMessages);

		controller.copilotWriteQueryStatus('Final SQL prose', '', 'assistant');
		expect(chat.getMessages()).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'Final SQL prose' }));
	});

	it('submits SQL agent work without changing the manual draft and rejects a busy replacement', async () => {
		const controller = new CopilotChatManagerController(createSqlManagerHost(), sqlWebviewFlavor);
		controller.installCopilotChat();
		const chat = controller.getCopilotChatEl()!;
		await chat.updateComplete;
		const input = chat.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
		input.value = 'manual draft';
		mocks.postMessageToHost.mockClear();

		const requestId = controller.submitSqlCopilotChatRequest('Agent SQL request', true);

		expect(requestId).toEqual(expect.stringMatching(/^sql-copilot-request-/));
		expect(input.value).toBe('manual draft');
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery', flavor: 'sql', request: 'Agent SQL request',
			requireToolUse: true, sqlCopilotRequestId: requestId,
		}));
		expect(controller.submitSqlCopilotChatRequest('Must not replace', true)).toBeUndefined();
	});

	it('keeps a manual SQL request idle and retryable until an owner token exists', async () => {
		let ownerToken = '';
		const host = createSqlManagerHost();
		host.getCopilotOwnerToken = () => ownerToken;
		const controller = new CopilotChatManagerController(host, sqlWebviewFlavor);
		controller.installCopilotChat();
		const chat = controller.getCopilotChatEl()!;
		await chat.updateComplete;
		const input = chat.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
		const send = chat.shadowRoot?.querySelector('[data-testid="copilot-chat-send-stop"]') as HTMLButtonElement;
		input.value = 'Retry this SQL request when ready';
		mocks.postMessageToHost.mockClear();

		send.click();
		await chat.updateComplete;

		expect(chat.isRunning()).toBe(false);
		expect(input.value).toBe('Retry this SQL request when ready');
		expect(controller.isCopilotChatRunning()).toBe(false);
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery',
		}));
		expect(chat.getMessages()).not.toContainEqual(expect.objectContaining({
			kind: 'user', text: 'Retry this SQL request when ready',
		}));
		expect(chat.getMessages()).toContainEqual(expect.objectContaining({
			kind: 'notification', text: 'SQL Tools Service is still connecting. Try again when the connection is ready.',
		}));

		ownerToken = 'sql-owner-ready';
		send.click();

		expect(input.value).toBe('');
		expect(chat.isRunning()).toBe(true);
		expect(controller.isCopilotChatRunning()).toBe(true);
		expect(chat.getMessages().filter(message =>
			message.kind === 'user' && message.text === 'Retry this SQL request when ready')).toHaveLength(1);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery', flavor: 'sql', request: 'Retry this SQL request when ready',
			sqlOwnerToken: ownerToken, sqlCopilotRequestId: expect.stringMatching(/^sql-copilot-request-/),
		}));
	});

	it('rejects programmatic SQL work without an owner and preserves the manual draft for retry', async () => {
		let ownerToken = '';
		const host = createSqlManagerHost();
		host.getCopilotOwnerToken = () => ownerToken;
		const controller = new CopilotChatManagerController(host, sqlWebviewFlavor);
		controller.installCopilotChat();
		const chat = controller.getCopilotChatEl()!;
		await chat.updateComplete;
		const input = chat.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement;
		input.value = 'manual draft';
		mocks.postMessageToHost.mockClear();

		expect(controller.submitSqlCopilotChatRequest('Agent SQL request', true)).toBeUndefined();
		expect(controller.isCopilotChatRunning()).toBe(false);
		expect(input.value).toBe('manual draft');
		expect(chat.getMessages()).not.toContainEqual(expect.objectContaining({
			kind: 'user', text: 'Agent SQL request',
		}));
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery',
		}));

		ownerToken = 'sql-owner-ready';
		const requestId = controller.submitSqlCopilotChatRequest('Agent SQL request', true);

		expect(requestId).toEqual(expect.stringMatching(/^sql-copilot-request-/));
		expect(input.value).toBe('manual draft');
		expect(chat.getMessages().filter(message =>
			message.kind === 'user' && message.text === 'Agent SQL request')).toHaveLength(1);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery', sqlOwnerToken: ownerToken,
			sqlCopilotRequestId: requestId,
		}));
	});

	it('cancels and completes only the exact active SQL Copilot request', async () => {
		const controller = new CopilotChatManagerController(createSqlManagerHost(), sqlWebviewFlavor);
		controller.installCopilotChat();
		await controller.getCopilotChatEl()!.updateComplete;
		const requestId = controller.submitSqlCopilotChatRequest('Agent SQL request', true)!;
		mocks.postMessageToHost.mockClear();

		expect(controller.cancelSqlCopilotRequest('sql-copilot-request-stale')).toBe(false);
		expect(mocks.postMessageToHost).not.toHaveBeenCalled();
		expect(controller.cancelSqlCopilotRequest(requestId)).toBe(true);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelCopilotWriteQuery', boxId: 'sql_source', flavor: 'sql', sqlCopilotRequestId: requestId,
		});
		await controller.getCopilotChatEl()!.updateComplete;
		expect(controller.getCopilotChatEl()!.shadowRoot?.querySelector('[data-testid="copilot-chat-progress"]')?.textContent)
			.toBe('Canceling\u2026');
		expect(controller.admitSqlCopilotMessage({ sqlCopilotRequestId: 'sql-copilot-request-stale' })).toBe(false);
		expect(controller.admitSqlCopilotMessage({ sqlCopilotRequestId: [requestId] })).toBe(false);
		expect(controller.admitSqlCopilotMessage({ sqlCopilotRequestId: requestId })).toBe(true);
		expect(controller.completeSqlCopilotRequest({ sqlCopilotRequestId: requestId })).toBe(true);
		expect(controller.admitSqlCopilotMessage({ sqlCopilotRequestId: requestId })).toBe(false);
	});

	it('Clear cancels the exact running SQL request before clearing conversation state', async () => {
		const controller = new CopilotChatManagerController(createSqlManagerHost(), sqlWebviewFlavor);
		controller.installCopilotChat();
		await controller.getCopilotChatEl()!.updateComplete;
		const requestId = controller.submitSqlCopilotChatRequest('Agent SQL request', true)!;
		mocks.postMessageToHost.mockClear();
		expect(controller.cancelSqlCopilotRequest(requestId)).toBe(true);

		controller.getCopilotChatEl()!.dispatchEvent(new CustomEvent('copilot-clear'));

		const messages = mocks.postMessageToHost.mock.calls.map(call => call[0]);
		expect(messages).toEqual(expect.arrayContaining([
			{ type: 'clearCopilotConversation', boxId: 'sql_source', flavor: 'sql' },
		]));
		expect(messages.filter((message: any) => message.type === 'cancelCopilotWriteQuery')).toEqual([
			{ type: 'cancelCopilotWriteQuery', boxId: 'sql_source', flavor: 'sql', sqlCopilotRequestId: requestId },
		]);
		expect(controller.admitSqlCopilotMessage({ sqlCopilotRequestId: requestId })).toBe(false);
	});

	it('emits exact tool-result and Markdown-preview open messages', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => 'print source = 1';
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		controller.installCopilotChat();
		const chat = host.querySelector('kw-copilot-chat');
		expect(chat).not.toBeNull();
		mocks.postMessageToHost.mockClear();
		const toolDetail = {
			tool: '  get_schema  ',
			label: 'Schema result',
			content: '  exact content\r\nwith spacing  ',
		};
		const previewDetail = { filePath: 'C:\\workspace\\copilot-result.md' };

		chat!.dispatchEvent(new CustomEvent('copilot-view-tool', { detail: toolDetail }));
		chat!.dispatchEvent(new CustomEvent('copilot-open-preview', { detail: previewDetail }));

		expect(mocks.postMessageToHost).toHaveBeenCalledTimes(2);
		expect(mocks.postMessageToHost).toHaveBeenNthCalledWith(1, {
			type: 'openToolResultInEditor',
			boxId: 'query_source',
			...toolDetail,
		});
		expect(mocks.postMessageToHost).toHaveBeenNthCalledWith(2, {
			type: 'openMarkdownPreview',
			...previewDetail,
		});
	});

	it('atomically submits an agent request and retains its conversation owner after completion', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => 'print source = 1';
		host.getSchemaLifecycleIdentity = () => ({ sectionInstanceId: 'instance-1', targetGeneration: 2 });
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		mocks.postMessageToHost.mockClear();

		const owner = controller.submitCopilotChatRequest('Show events', true);

		expect(owner).toMatchObject({
			boxId: 'query_source', sectionInstanceId: 'instance-1', targetGeneration: 2,
			copilotRequestId: expect.any(String),
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery', request: 'Show events', requireToolUse: true,
			...owner,
		}));
		expect(controller.isCopilotChatRunning()).toBe(true);
		controller.getCopilotChatEl()!.setRunning(false);
		expect(controller.submitCopilotChatRequest('Do not replace', true)).toBeUndefined();
		expect(controller.completeKustoCopilotRequest(owner)).toBe(true);
		expect(controller.getActiveKustoCopilotRequest()).toBeUndefined();
		expect(controller.admitKustoCopilotConversationOwner(owner)).toBe(true);
	});

	it('rolls back a failed Kusto start transport so a programmatic retry can run', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => 'print source = 1';
		host.getSchemaLifecycleIdentity = () => ({ sectionInstanceId: 'instance-1', targetGeneration: 2 });
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		controller.installCopilotChat();
		mocks.postMessageToHost.mockClear();
		mocks.postMessageToHost.mockImplementationOnce(() => {
			throw new Error('transport unavailable');
		});

		expect(controller.submitCopilotChatRequest('First attempt', true)).toBeUndefined();
		expect(controller.getActiveKustoCopilotRequest()).toBeUndefined();
		expect(controller.isCopilotChatRunning()).toBe(false);
		expect(controller.getCopilotChatEl()!.getMessages()).not.toContainEqual(expect.objectContaining({
			kind: 'user', text: 'First attempt',
		}));
		mocks.postMessageToHost.mockImplementation(() => undefined);

		const retryOwner = controller.submitCopilotChatRequest('Retry attempt', true);

		expect(retryOwner).toMatchObject({
			boxId: 'query_source', sectionInstanceId: 'instance-1', targetGeneration: 2,
			copilotRequestId: expect.any(String),
		});
		expect(controller.getActiveKustoCopilotRequest()).toEqual(retryOwner);
		expect(controller.getCopilotChatEl()!.getMessages().filter(message =>
			message.kind === 'user' && message.text === 'Retry attempt')).toHaveLength(1);
	});

	it('restores the completed Kusto conversation owner when a follow-up transport fails', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => 'print source = 1';
		host.getSchemaLifecycleIdentity = () => ({ sectionInstanceId: 'instance-1', targetGeneration: 2 });
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		controller.installCopilotChat();
		mocks.postMessageToHost.mockClear();
		const firstOwner = controller.submitCopilotChatRequest('First completed turn', true)!;
		controller.getCopilotChatEl()!.setRunning(false);
		expect(controller.completeKustoCopilotRequest(firstOwner)).toBe(true);
		mocks.postMessageToHost.mockImplementationOnce(() => {
			throw new Error('follow-up transport unavailable');
		});

		expect(controller.submitCopilotChatRequest('Failed follow-up', true)).toBeUndefined();
		expect(controller.getActiveKustoCopilotRequest()).toBeUndefined();
		expect(controller.admitKustoCopilotConversationOwner(firstOwner)).toBe(true);
		mocks.postMessageToHost.mockImplementation(() => undefined);
		mocks.postMessageToHost.mockClear();

		controller.getCopilotChatEl()!.dispatchEvent(new CustomEvent('copilot-clear'));

		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'clearCopilotConversation', flavor: 'kusto', ...firstOwner,
		});
		expect(controller.admitKustoCopilotConversationOwner(firstOwner)).toBe(false);
	});

	it('does not reopen an already visible chat before an ordinary programmatic submission', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => 'print source = 1';
		host.getSchemaLifecycleIdentity = () => ({ sectionInstanceId: 'instance-1', targetGeneration: 2 });
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		controller.setCopilotChatVisible(true, false);
		const visibility = vi.spyOn(controller, 'setCopilotChatVisible');
		mocks.postMessageToHost.mockClear();

		const owner = controller.submitCopilotChatRequest('optimize the performance of this query', false);

		expect(owner).toBeDefined();
		expect(visibility).not.toHaveBeenCalled();
		expect(controller.getCopilotChatEl()!.getMessages()).toContainEqual(expect.objectContaining({
			kind: 'user', text: 'optimize the performance of this query',
		}));
		expect(mocks.postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery',
			request: 'optimize the performance of this query',
			requireToolUse: undefined,
		}));
	});

	it('emits retirement only after active ownership and running UI are cleared', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => '';
		host.getSchemaLifecycleIdentity = () => ({ sectionInstanceId: 'instance-1', targetGeneration: 1 });
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		const owner = controller.submitCopilotChatRequest('Show events', true)!;
		const chat = controller.getCopilotChatEl()!;
		mocks.emitAppliedDone.mockImplementationOnce(() => {
			expect(controller.getActiveKustoCopilotRequest()).toBeUndefined();
			expect(chat.isRunning()).toBe(false);
		});

		controller.retireKustoCopilotRequest();

		expect(mocks.emitAppliedDone).toHaveBeenCalledWith(expect.objectContaining({
			...owner, type: 'copilotWriteQueryDone', ok: false, retired: true,
		}));
	});

	it('clears exact Kusto ownership locally and cancels active work before host history clear', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => '';
		host.getSchemaLifecycleIdentity = () => ({ sectionInstanceId: 'instance-1', targetGeneration: 1 });
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		const owner = controller.submitCopilotChatRequest('Show events', true)!;
		mocks.postMessageToHost.mockClear();

		controller.getCopilotChatEl()!.dispatchEvent(new CustomEvent('copilot-clear'));

		expect(controller.getActiveKustoCopilotRequest()).toBeUndefined();
		expect(controller.admitKustoCopilotConversationOwner(owner)).toBe(false);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelCopilotWriteQuery', flavor: 'kusto', ...owner,
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'clearCopilotConversation', flavor: 'kusto', ...owner,
		});
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'prepareCopilotWriteQuery', boxId: 'query_source', flavor: 'kusto',
		});
	});

	it('clears completed conversation ownership through the real Clear event', () => {
		const host = document.createElement('div') as HTMLElement & CopilotChatManagerHost;
		host.boxId = 'query_source';
		host.addController = vi.fn();
		host.getCopilotConnectionId = () => 'connection-1';
		host.getCopilotServerUrl = () => 'https://cluster.example';
		host.getDatabase = () => 'Db';
		host.getCopilotEditorValue = () => '';
		host.getSchemaLifecycleIdentity = () => ({ sectionInstanceId: 'instance-1', targetGeneration: 1 });
		host.layoutCopilotEditor = vi.fn();
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		host.appendChild(wrapper);
		document.body.appendChild(host);
		const controller = new CopilotChatManagerController(host, kustoWebviewFlavor);
		const owner = controller.submitCopilotChatRequest('Show events', true)!;
		controller.getCopilotChatEl()!.setRunning(false);
		expect(controller.completeKustoCopilotRequest(owner)).toBe(true);
		mocks.postMessageToHost.mockClear();

		controller.getCopilotChatEl()!.dispatchEvent(new CustomEvent('copilot-clear'));

		expect(controller.admitKustoCopilotConversationOwner(owner)).toBe(false);
		expect(mocks.postMessageToHost).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'cancelCopilotWriteQuery' }),
		);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'clearCopilotConversation', flavor: 'kusto', ...owner,
		});
	});
});