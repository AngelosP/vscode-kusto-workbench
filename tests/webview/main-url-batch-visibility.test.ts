import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	schedulePersist: vi.fn(),
	postMessageToHost: vi.fn(),
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: mocks.postMessageToHost,
}));
vi.mock('../../src/webview/core/dropdown.js', () => ({ closeAllMenus: vi.fn() }));
vi.mock('../../src/webview/sections/kw-query-toolbar.js', () => ({
	__kustoCloseShareModal: vi.fn(),
	__kustoShareCopyToClipboard: vi.fn(),
}));
vi.mock('../../src/webview/core/persistence.js', () => ({
	__kustoRequestAddSection: vi.fn(),
	schedulePersist: mocks.schedulePersist,
}));
vi.mock('../../src/webview/core/state.js', () => ({ queryEditors: {} }));
vi.mock('../../src/webview/core/page-scroll-dismiss.js', () => ({
	registerPageScrollDismissable: vi.fn(() => vi.fn()),
}));
vi.mock('../../src/webview/core/perf.js', () => ({ perfMark: vi.fn() }));
vi.mock('../../src/webview/core/file-open-trace.js', () => ({ traceFileOpen: vi.fn() }));
vi.mock('../../src/webview/core/kusto-editor-schema-runtime.js', () => ({
	kustoEditorSchemaCoordinator: { subscribeLifecycle: vi.fn() },
}));
vi.mock('../../src/webview/core/message-handler.js', () => ({
	drainBufferedHostMessages: vi.fn(async () => undefined),
}));
vi.mock('../../src/webview/core/document-capabilities.js', () => ({
	getAllowedAddSectionKinds: vi.fn(() => []),
}));
vi.mock('../../src/webview/core/active-section-tracker.js', () => ({}));
vi.mock('../../src/webview/core/keyboard-shortcuts.js', () => ({}));
vi.mock('../../src/webview/core/drag-reorder.js', () => ({}));

import '../../src/webview/core/main.js';

describe('batch URL visibility', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		mocks.schedulePersist.mockClear();
	});

	it('commits URL expanded state through the component command hook', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		const section = document.createElement('kw-url-section') as HTMLElement & {
			setExpanded: ReturnType<typeof vi.fn>;
			commitDocumentState: ReturnType<typeof vi.fn>;
		};
		section.id = 'url_batch';
		section.setExpanded = vi.fn();
		section.commitDocumentState = vi.fn();
		container.appendChild(section);
		document.body.appendChild(container);

		document.dispatchEvent(new CustomEvent('toggle-all-sections', {
			detail: { targetExpanded: false },
		}));

		expect(section.setExpanded).toHaveBeenCalledWith(false);
		expect(section.commitDocumentState).toHaveBeenCalledOnce();
		expect(mocks.schedulePersist).toHaveBeenCalledOnce();
	});

	it('keeps the Add Section popup open when a press starts inside and releases outside', () => {
		const dropdown = document.createElement('div');
		dropdown.className = 'add-controls-dropdown';
		const button = document.createElement('button');
		button.id = 'addSectionDropdownBtn';
		const menu = document.createElement('div');
		menu.id = 'addSectionDropdownMenu';
		menu.className = 'add-controls-dropdown-menu';
		menu.style.display = 'block';
		dropdown.append(button, menu);
		document.body.appendChild(dropdown);

		menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
		expect(menu.style.display).toBe('block');

		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(menu.style.display).toBe('none');
	});
});
