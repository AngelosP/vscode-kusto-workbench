import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createSectionWithCapabilities: vi.fn(),
	postMessageToHost: vi.fn(),
	setSectionName: vi.fn(),
	emitAppliedDone: vi.fn(),
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
	__kustoPrettifyKustoTextWithSemicolonStatements: vi.fn((value: string) => value),
}));

vi.mock('../../src/webview/core/kusto-copilot-output-runtime.js', () => ({
	emitAppliedKustoCopilotDone: mocks.emitAppliedDone,
}));

import '../../src/webview/components/kw-copilot-chat.js';
import { CopilotChatManagerController, type CopilotChatManagerHost } from '../../src/webview/sections/copilot-chat-manager.controller.js';
import { kustoWebviewFlavor, sqlWebviewFlavor } from '../../src/webview/sections/copilot-chat-flavor.js';

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