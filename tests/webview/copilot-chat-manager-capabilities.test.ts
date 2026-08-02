import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	createSectionWithCapabilities: vi.fn(),
	postMessageToHost: vi.fn(),
	setSectionName: vi.fn(),
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
	emitAdmittedKustoCopilotOutput: vi.fn(),
}));

import { CopilotChatManagerController, type CopilotChatManagerHost } from '../../src/webview/sections/copilot-chat-manager.controller.js';
import { kustoWebviewFlavor } from '../../src/webview/sections/copilot-chat-flavor.js';

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
});