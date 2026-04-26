import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { html, nothing, render } from 'lit';

const toolbarMocks = vi.hoisted(() => ({
	toggleAutoTriggerAutocompleteEnabled: vi.fn(),
	toggleCopilotInlineCompletionsEnabled: vi.fn(),
}));

vi.mock('../../src/webview/sections/kw-query-toolbar.js', () => ({
	toggleAutoTriggerAutocompleteEnabled: toolbarMocks.toggleAutoTriggerAutocompleteEnabled,
	toggleCopilotInlineCompletionsEnabled: toolbarMocks.toggleCopilotInlineCompletionsEnabled,
}));

import '../../src/webview/sections/kw-sql-toolbar.js';
import type { KwSqlToolbar } from '../../src/webview/sections/kw-sql-toolbar.js';

let container: HTMLDivElement;

function createToolbar(): KwSqlToolbar {
	render(html`<kw-sql-toolbar></kw-sql-toolbar>`, container);
	return container.querySelector('kw-sql-toolbar')!;
}

function getButton(el: KwSqlToolbar, label: string): HTMLButtonElement {
	const btn = el.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
	expect(btn, `button ${label} should exist`).not.toBeNull();
	return btn!;
}

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	toolbarMocks.toggleAutoTriggerAutocompleteEnabled.mockClear();
	toolbarMocks.toggleCopilotInlineCompletionsEnabled.mockClear();
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	delete (window as any).__kustoQueryEditorConfig;
	vi.restoreAllMocks();
});

describe('kw-sql-toolbar', () => {
	it('renders the expected SQL editor action buttons', async () => {
		const el = createToolbar();
		await el.updateComplete;

		for (const label of ['Undo', 'Redo', 'Comment', 'Prettify', 'Search', 'Replace']) {
			expect(getButton(el, label).disabled).toBe(false);
		}
	});

	it('dispatches sql-editor-action events for editor commands', async () => {
		const el = createToolbar();
		await el.updateComplete;
		const actions: string[] = [];
		container.addEventListener('sql-editor-action', ((event: CustomEvent) => {
			actions.push(event.detail.action);
		}) as EventListener);

		for (const label of ['Undo', 'Redo', 'Comment', 'Prettify', 'Search', 'Replace']) {
			getButton(el, label).click();
		}

		expect(actions).toEqual(['undo', 'redo', 'toggleComment', 'prettify', 'search', 'replace']);
	});

	it('routes autocomplete and inline Copilot toggles through query toolbar settings', async () => {
		const el = createToolbar();
		await el.updateComplete;

		getButton(el, 'Auto-completions as you type').click();
		getButton(el, 'Copilot inline suggestions').click();

		expect(toolbarMocks.toggleAutoTriggerAutocompleteEnabled).toHaveBeenCalledTimes(1);
		expect(toolbarMocks.toggleCopilotInlineCompletionsEnabled).toHaveBeenCalledTimes(1);

		el.setAutoCompleteActive(true);
		el.setCopilotInlineActive(true);
		await el.updateComplete;

		const autoButton = getButton(el, 'Auto-completions as you type');
		const inlineButton = getButton(el, 'Copilot inline suggestions');
		expect(autoButton.classList.contains('is-active')).toBe(true);
		expect(autoButton.getAttribute('aria-pressed')).toBe('true');
		expect(inlineButton.classList.contains('is-active')).toBe(true);
		expect(inlineButton.getAttribute('aria-pressed')).toBe('true');
	});

	it('keeps Copilot chat disabled until enabled, then dispatches toggle events', async () => {
		const el = createToolbar();
		await el.updateComplete;
		let toggleCount = 0;
		container.addEventListener('sql-copilot-toggle', () => { toggleCount++; });

		const disabledButton = getButton(el, 'Copilot');
		expect(disabledButton.disabled).toBe(true);
		disabledButton.click();
		expect(toggleCount).toBe(0);

		el.setCopilotChatEnabled(true);
		await el.updateComplete;

		const enabledButton = getButton(el, 'Copilot');
		expect(enabledButton.disabled).toBe(false);
		enabledButton.click();
		expect(toggleCount).toBe(1);

		el.setCopilotChatActive(true);
		await el.updateComplete;

		expect(getButton(el, 'Copilot').classList.contains('is-active')).toBe(true);
	});

	it('uses a configured Copilot logo URI when available before connection', async () => {
		(window as any).__kustoQueryEditorConfig = { copilotLogoUri: 'https://example.test/copilot.svg' };
		const el = createToolbar();
		await el.updateComplete;

		const img = getButton(el, 'Copilot').querySelector('img.copilot-logo') as HTMLImageElement | null;
		expect(img).not.toBeNull();
		expect(img?.getAttribute('src')).toBe('https://example.test/copilot.svg');
	});
});
