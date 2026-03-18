import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-copilot-chat.js';
import type { KwCopilotChat, CopilotTool, ChatMessageEntry } from '../../src/webview/components/kw-copilot-chat.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let container: HTMLDivElement;

function createChat(boxId = 'test_box'): KwCopilotChat {
	render(html`<kw-copilot-chat box-id=${boxId}></kw-copilot-chat>`, container);
	return container.querySelector('kw-copilot-chat')!;
}

async function waitUpdate(el: KwCopilotChat): Promise<void> {
	await el.updateComplete;
}

function getMessages(el: KwCopilotChat): readonly ChatMessageEntry[] {
	return el.getMessages();
}

function getShadowEl(el: KwCopilotChat, selector: string): HTMLElement | null {
	return el.shadowRoot?.querySelector(selector) as HTMLElement | null;
}

function getAllShadowEls(el: KwCopilotChat, selector: string): HTMLElement[] {
	return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? []) as HTMLElement[];
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-copilot-chat — initialization', () => {
	it('renders without errors', async () => {
		const el = createChat();
		await waitUpdate(el);
		expect(el.shadowRoot).toBeTruthy();
	});

	it('renders the header with title and buttons', async () => {
		const el = createChat();
		await waitUpdate(el);
		const title = getShadowEl(el, '.chat-title span');
		expect(title?.textContent).toBe('CHAT');
		expect(getShadowEl(el, '.clear-btn')).toBeTruthy();
		expect(getShadowEl(el, '.close-btn')).toBeTruthy();
	});

	it('renders the messages container', async () => {
		const el = createChat();
		await waitUpdate(el);
		expect(getShadowEl(el, '.messages')).toBeTruthy();
	});

	it('renders the textarea input', async () => {
		const el = createChat();
		await waitUpdate(el);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		expect(ta).toBeTruthy();
		expect(ta.placeholder).toBe('Ask Copilot\u2026');
	});

	it('renders the send button', async () => {
		const el = createChat();
		await waitUpdate(el);
		expect(getShadowEl(el, '.send-btn')).toBeTruthy();
	});

	it('shows the initial tip message on first render', async () => {
		const el = createChat();
		await waitUpdate(el);
		const msgs = getMessages(el);
		expect(msgs.length).toBe(1);
		expect(msgs[0].kind).toBe('notification');
		expect(msgs[0].text).toBe('__TIP__');
		// Verify it renders the tip notification HTML.
		const tipEl = getShadowEl(el, '.msg-notification');
		expect(tipEl).toBeTruthy();
		expect(tipEl!.textContent).toContain('Kusto Workbench custom agent');
	});
});

describe('kw-copilot-chat — message appending', () => {
	it('appends a user message', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendMessage('user', 'Hello world');
		await waitUpdate(el);
		const userMsgs = getAllShadowEls(el, '.msg-user');
		expect(userMsgs.length).toBe(1);
		expect(userMsgs[0].textContent).toBe('Hello world');
	});

	it('appends an assistant message', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendMessage('assistant', 'Here is your query');
		await waitUpdate(el);
		const assistantMsgs = getAllShadowEls(el, '.msg-assistant');
		expect(assistantMsgs.length).toBe(1);
		expect(assistantMsgs[0].textContent).toBe('Here is your query');
	});

	it('appends a notification message', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendMessage('notification', 'Select a cluster first.');
		await waitUpdate(el);
		// 2nd notification (1st is the tip).
		const notifs = getAllShadowEls(el, '.msg-notification');
		expect(notifs.length).toBe(2);
		expect(notifs[1].textContent).toBe('Select a cluster first.');
	});

	it('appends a tool response', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendToolResponse('get_schema', 'Schema loaded', '{"tables":[]}', 'entry-1');
		await waitUpdate(el);
		const toolMsgs = getAllShadowEls(el, '.msg-tool');
		expect(toolMsgs.length).toBe(1);
		expect(toolMsgs[0].textContent).toContain('get_schema');
		expect(toolMsgs[0].textContent).toContain('Schema loaded');
	});

	it('appends an executed query (success)', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendExecutedQuery('StormEvents | take 10', '10 rows', '', 'entry-2', null);
		await waitUpdate(el);
		const toolMsgs = getAllShadowEls(el, '.msg-tool');
		expect(toolMsgs.length).toBe(1);
		expect(toolMsgs[0].textContent).toContain('execute_kusto_query');
		expect(toolMsgs[0].textContent).toContain('10 rows');
		expect(toolMsgs[0].classList.contains('is-error')).toBe(false);
	});

	it('appends an executed query (error)', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendExecutedQuery('bad query', 'Error', 'Syntax error', 'entry-3', null);
		await waitUpdate(el);
		const toolMsgs = getAllShadowEls(el, '.msg-tool');
		expect(toolMsgs.length).toBe(1);
		expect(toolMsgs[0].classList.contains('is-error')).toBe(true);
		expect(toolMsgs[0].textContent).toContain('Query failed to execute');
	});

	it('appends general rules link after first user message', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendMessage('user', 'Write a query');
		el.appendGeneralRulesLink('/path/to/rules.md', 'Some rules preview', 'entry-4');
		await waitUpdate(el);
		const msgs = getMessages(el);
		// Should be: tip, user, general-rules
		expect(msgs[1].kind).toBe('user');
		expect(msgs[2].kind).toBe('system');
		expect(msgs[2].text).toBe('Loaded query writing guidelines');
	});

	it('appends query snapshot', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendQuerySnapshot('StormEvents | take 100', 'entry-5');
		await waitUpdate(el);
		const snapshots = getAllShadowEls(el, '.msg-query-snapshot');
		expect(snapshots.length).toBe(1);
		expect(snapshots[0].textContent).toContain('Existing query');
	});

	it('truncates long query snapshots in preview', async () => {
		const el = createChat();
		await waitUpdate(el);
		const longQuery = 'StormEvents | where StartTime > ago(7d) | project State, EventType, DamageProperty | summarize count() by State | top 10 by count_ desc | render piechart';
		el.appendQuerySnapshot(longQuery, 'entry-6');
		await waitUpdate(el);
		const msgs = getMessages(el);
		const snapshot = msgs[msgs.length - 1];
		expect(snapshot.text.length).toBeLessThanOrEqual(82); // 80 chars + ellipsis
	});

	it('does not append empty query snapshot', async () => {
		const el = createChat();
		await waitUpdate(el);
		const countBefore = getMessages(el).length;
		el.appendQuerySnapshot('', 'entry-7');
		expect(getMessages(el).length).toBe(countBefore);
	});

	it('appends clarifying question', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendClarifyingQuestion('Which database do you mean?', 'entry-8');
		await waitUpdate(el);
		const questions = getAllShadowEls(el, '.msg-clarifying-question');
		expect(questions.length).toBe(1);
		expect(questions[0].textContent).toContain('Clarifying question');
		expect(questions[0].textContent).toContain('Which database do you mean?');
	});

	it('appends devnotes context', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendDevNotesContext('table has 500k rows', 'entry-9');
		await waitUpdate(el);
		const systemMsgs = getAllShadowEls(el, '.msg-system');
		expect(systemMsgs.length).toBe(1);
		expect(systemMsgs[0].textContent).toContain('Development notes');
	});

	it('appends devnote tool call', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendDevNoteToolCall('save', '[perf] This table is huge', 'Saved', 'entry-10');
		await waitUpdate(el);
		const toolMsgs = getAllShadowEls(el, '.msg-tool');
		expect(toolMsgs.length).toBe(1);
		expect(toolMsgs[0].textContent).toContain('update_development_note');
	});
});

describe('kw-copilot-chat — running state', () => {
	it('sets running state and disables input', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.setRunning(true);
		await waitUpdate(el);
		expect(el.isRunning()).toBe(true);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		expect(ta.disabled).toBe(true);
		const sendBtn = getShadowEl(el, '.send-btn');
		expect(sendBtn!.classList.contains('is-running')).toBe(true);
	});

	it('clears running state', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.setRunning(true);
		el.setRunning(false);
		await waitUpdate(el);
		expect(el.isRunning()).toBe(false);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		expect(ta.disabled).toBe(false);
	});

	it('appends status text with notification when setting running', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.setRunning(true, 'Processing...');
		await waitUpdate(el);
		const msgs = getMessages(el);
		const last = msgs[msgs.length - 1];
		expect(last.kind).toBe('notification');
		expect(last.text).toBe('Processing...');
	});
});

describe('kw-copilot-chat — send/cancel', () => {
	it('dispatches copilot-send when user clicks send with text', async () => {
		const el = createChat();
		await waitUpdate(el);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		ta.value = 'Write a query for me';
		const handler = vi.fn();
		el.addEventListener('copilot-send', handler as any);
		const sendBtn = getShadowEl(el, '.send-btn');
		sendBtn!.click();
		expect(handler).toHaveBeenCalledTimes(1);
		const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
		expect(detail.text).toBe('Write a query for me');
	});

	it('appends notification when sending with empty input', async () => {
		const el = createChat();
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-send', handler as any);
		const sendBtn = getShadowEl(el, '.send-btn');
		sendBtn!.click();
		expect(handler).not.toHaveBeenCalled();
		const msgs = getMessages(el);
		const last = msgs[msgs.length - 1];
		expect(last.kind).toBe('notification');
		expect(last.text).toContain('Type what you want');
	});

	it('dispatches copilot-cancel when running and clicked', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.setRunning(true);
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-cancel', handler as any);
		const sendBtn = getShadowEl(el, '.send-btn');
		sendBtn!.click();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('clears input after successful send', async () => {
		const el = createChat();
		await waitUpdate(el);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		ta.value = 'Some request';
		const sendBtn = getShadowEl(el, '.send-btn');
		sendBtn!.click();
		expect(ta.value).toBe('');
	});
});

describe('kw-copilot-chat — clear conversation', () => {
	it('dispatches copilot-clear event', async () => {
		const el = createChat();
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-clear', handler as any);
		const clearBtn = getShadowEl(el, '.clear-btn');
		clearBtn!.click();
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('clearConversation() resets messages to just the tip', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendMessage('user', 'Hello');
		el.appendMessage('assistant', 'Hi');
		el.clearConversation();
		await waitUpdate(el);
		const msgs = getMessages(el);
		expect(msgs.length).toBe(1);
		expect(msgs[0].text).toBe('__TIP__');
	});

	it('clearConversation() resets running state', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.setRunning(true);
		el.clearConversation();
		expect(el.isRunning()).toBe(false);
	});
});

describe('kw-copilot-chat — close', () => {
	it('dispatches copilot-close event', async () => {
		const el = createChat();
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-close', handler as any);
		const closeBtn = getShadowEl(el, '.close-btn');
		closeBtn!.click();
		expect(handler).toHaveBeenCalledTimes(1);
	});
});

describe('kw-copilot-chat — tools', () => {
	const sampleTools: CopilotTool[] = [
		{ name: 'get_extended_schema', label: 'Get Schema', description: 'Gets schema', enabledByDefault: true },
		{ name: 'execute_kusto_query', label: 'Execute Query', description: 'Runs query', enabledByDefault: true },
		{ name: 'respond_to_all_other_queries', label: 'Respond', description: 'Final answer', enabledByDefault: true },
	];

	it('applyOptions sets tools and enables defaults', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.applyOptions([], '', sampleTools);
		expect(el.getEnabledTools()).toEqual(['get_extended_schema', 'execute_kusto_query', 'respond_to_all_other_queries']);
	});

	it('getEnabledTools filters by known tools', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.applyOptions([], '', sampleTools);
		// Simulate applying a reduced tool set.
		el.applyOptions([], '', [sampleTools[0]]);
		const enabled = el.getEnabledTools();
		expect(enabled).toEqual(['get_extended_schema']);
	});

	it('tools button is disabled when no tools', async () => {
		const el = createChat();
		await waitUpdate(el);
		const toolsBtn = getShadowEl(el, '.tools-btn') as HTMLButtonElement;
		expect(toolsBtn.disabled).toBe(true);
	});

	it('tools button is enabled after applyOptions', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.applyOptions([], '', sampleTools);
		await waitUpdate(el);
		const toolsBtn = getShadowEl(el, '.tools-btn') as HTMLButtonElement;
		expect(toolsBtn.disabled).toBe(false);
	});

	it('toggles tools panel visibility', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.applyOptions([], '', sampleTools);
		await waitUpdate(el);
		const toolsBtn = getShadowEl(el, '.tools-btn')!;
		toolsBtn.click();
		await waitUpdate(el);
		expect(getShadowEl(el, '.tools-panel')).toBeTruthy();
		// Click again to close.
		toolsBtn.click();
		await waitUpdate(el);
		expect(getShadowEl(el, '.tools-panel')).toBeFalsy();
	});

	it('renders tool items with checkboxes in correct groups', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.applyOptions([], '', sampleTools);
		await waitUpdate(el);
		const toolsBtn = getShadowEl(el, '.tools-btn')!;
		toolsBtn.click();
		await waitUpdate(el);
		const groups = getAllShadowEls(el, '.tools-group-title');
		expect(groups.length).toBe(2); // Final step + Optional tools
		expect(groups[0].textContent).toBe('Final step');
		expect(groups[1].textContent).toBe('Optional tools');
	});
});

describe('kw-copilot-chat — remove entry', () => {
	it('marks entry as removed and dispatches event', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendToolResponse('get_schema', 'Schema loaded', '{}', 'entry-remove-1');
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-remove-entry', handler as any);
		// Click the remove button.
		const removeBtn = getShadowEl(el, '.remove-btn');
		expect(removeBtn).toBeTruthy();
		removeBtn!.click();
		await waitUpdate(el);
		expect(handler).toHaveBeenCalledTimes(1);
		expect((handler.mock.calls[0][0] as CustomEvent).detail.entryId).toBe('entry-remove-1');
		// Message should be marked as removed.
		const msgs = getMessages(el);
		const removed = msgs.find(m => m.entryId === 'entry-remove-1');
		expect(removed?.removed).toBe(true);
	});
});

describe('kw-copilot-chat — view tool', () => {
	it('dispatches copilot-view-tool for tool response', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendToolResponse('get_schema', 'Schema loaded', '{"tables":[]}', 'entry-view-1');
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-view-tool', handler as any);
		const viewBtn = getShadowEl(el, '.tool-icon-btn');
		viewBtn!.click();
		await waitUpdate(el);
		expect(handler).toHaveBeenCalledTimes(1);
		const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
		expect(detail.tool).toBe('get_schema');
		expect(detail.content).toBe('{"tables":[]}');
	});
});

describe('kw-copilot-chat — insert query', () => {
	it('dispatches copilot-insert-query for executed query', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendExecutedQuery('StormEvents | take 5', '5 rows', '', 'entry-insert-1', { columns: [], rows: [] });
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-insert-query', handler as any);
		// The insert button (codicon-insert) should be first icon button.
		const insertBtns = getAllShadowEls(el, '.tool-icon-btn');
		const insertBtn = insertBtns.find(b => b.title?.includes('Insert'));
		expect(insertBtn).toBeTruthy();
		insertBtn!.click();
		await waitUpdate(el);
		expect(handler).toHaveBeenCalledTimes(1);
		const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
		expect(detail.query).toBe('StormEvents | take 5');
		expect(detail.result).toEqual({ columns: [], rows: [] });
	});
});

describe('kw-copilot-chat — open preview', () => {
	it('dispatches copilot-open-preview for general rules', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.appendMessage('user', 'Write a query');
		el.appendGeneralRulesLink('/rules.md', 'Preview text', 'entry-preview-1');
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-open-preview', handler as any);
		// Find the eye button in the system message.
		const systemMsg = getShadowEl(el, '.msg-system')!;
		const eyeBtn = systemMsg.querySelector('.tool-icon-btn') as HTMLElement;
		expect(eyeBtn).toBeTruthy();
		eyeBtn.click();
		await waitUpdate(el);
		expect(handler).toHaveBeenCalledTimes(1);
		expect((handler.mock.calls[0][0] as CustomEvent).detail.filePath).toBe('/rules.md');
	});
});

describe('kw-copilot-chat — open agent link', () => {
	it('dispatches copilot-open-agent when tip link is clicked', async () => {
		const el = createChat();
		await waitUpdate(el);
		const handler = vi.fn();
		el.addEventListener('copilot-open-agent', handler as any);
		const link = getShadowEl(el, '.msg-notification a') as HTMLAnchorElement;
		expect(link).toBeTruthy();
		link.click();
		expect(handler).toHaveBeenCalledTimes(1);
	});
});

describe('kw-copilot-chat — keyboard', () => {
	it('Enter sends message', async () => {
		const el = createChat();
		await waitUpdate(el);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		ta.value = 'test message';
		const handler = vi.fn();
		el.addEventListener('copilot-send', handler as any);
		ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('Shift+Enter does not send', async () => {
		const el = createChat();
		await waitUpdate(el);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		ta.value = 'test message';
		const handler = vi.fn();
		el.addEventListener('copilot-send', handler as any);
		ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
		expect(handler).not.toHaveBeenCalled();
	});

	it('Escape cancels when running', async () => {
		const el = createChat();
		await waitUpdate(el);
		el.setRunning(true);
		await waitUpdate(el);
		const ta = getShadowEl(el, 'textarea') as HTMLTextAreaElement;
		const handler = vi.fn();
		el.addEventListener('copilot-cancel', handler as any);
		ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(handler).toHaveBeenCalledTimes(1);
	});
});

describe('kw-copilot-chat — input resizer', () => {
	it('renders the input resizer', async () => {
		const el = createChat();
		await waitUpdate(el);
		const resizer = getShadowEl(el, '.input-resizer');
		expect(resizer).toBeTruthy();
		expect(resizer!.title).toBe('Drag to resize input area');
	});
});
