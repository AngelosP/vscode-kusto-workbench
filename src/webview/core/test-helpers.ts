// E2E test helpers — shadow-piercing element lookup by data-testid.
// These are zero-cost in production (no logic runs until called).
// Used by the vscode-ext-test E2E framework via `When I evaluate`.

import { postMessageToHost } from '../shared/webview-messages.js';
import { setActiveMonacoEditor } from './state.js';

type MonacoLike = {
	getDomNode?: () => HTMLElement | null;
	focus?: () => void;
	hasTextFocus?: () => boolean;
	hasWidgetFocus?: () => boolean;
	getValue?: () => string;
	setValue?: (value: string) => void;
	getModel?: () => { getLineCount?: () => number; getLineMaxColumn?: (lineNumber: number) => number } | null;
	setPosition?: (position: { lineNumber: number; column: number }) => void;
	setSelection?: (selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => void;
	trigger?: (source: string, handlerId: string, payload: any) => void;
	onDidFocusEditorText?: (cb: () => void) => { dispose(): void };
	onDidFocusEditorWidget?: (cb: () => void) => { dispose(): void };
};

const _monacoFocusTracked = (typeof WeakSet !== 'undefined') ? new WeakSet<object>() : null;

function resolveMonacoEditorFromElement(el: Element | null): MonacoLike | null {
	if (!el) return null;

	// First try: walk up to a known section element and use its _editor property directly.
	const host = el.closest('kw-sql-section, kw-query-section, kw-html-section, kw-python-section') as any;
	if (host && host._editor) {
		return host._editor as MonacoLike;
	}

	// Second try: if the selector was for a section element itself (e.g. 'kw-sql-section .monaco-editor'),
	// the .monaco-editor might not be a DOM child due to fixedOverflowWidgets.
	// Try finding the section by tag name from the element or its ancestors.
	if (!host) {
		const tagMatch = el.tagName?.toLowerCase();
		if (tagMatch && (tagMatch === 'kw-sql-section' || tagMatch === 'kw-query-section' || tagMatch === 'kw-html-section' || tagMatch === 'kw-python-section')) {
			const sectionEl = el as any;
			if (sectionEl._editor) return sectionEl._editor as MonacoLike;
		}
	}

	const winEditor = (window as any).activeMonacoEditor;
	return winEditor || null;
}

function updateMonacoFocusDataset(editor: MonacoLike | null): 'text' | 'widget' | 'none' {
	if (!editor || typeof editor.getDomNode !== 'function') {
		return 'none';
	}

	const dom = editor.getDomNode();
	if (!dom) {
		return 'none';
	}

	let state: 'text' | 'widget' | 'none' = 'none';
	try {
		const hasText = typeof editor.hasTextFocus === 'function' ? !!editor.hasTextFocus() : false;
		const hasWidget = typeof editor.hasWidgetFocus === 'function' ? !!editor.hasWidgetFocus() : false;
		state = hasText ? 'text' : (hasWidget ? 'widget' : 'none');
	} catch {
		state = 'none';
	}

	dom.dataset.testMonacoFocus = state;
	return state;
}

function ensureMonacoFocusTracking(editor: MonacoLike | null): void {
	if (!editor) return;
	if (_monacoFocusTracked && _monacoFocusTracked.has(editor as object)) {
		return;
	}

	try {
		if (typeof editor.onDidFocusEditorText === 'function') {
			editor.onDidFocusEditorText(() => {
				updateMonacoFocusDataset(editor);
			});
		}
	} catch { /* ignore */ }

	try {
		if (typeof editor.onDidFocusEditorWidget === 'function') {
			editor.onDidFocusEditorWidget(() => {
				updateMonacoFocusDataset(editor);
			});
		}
	} catch { /* ignore */ }

	if (_monacoFocusTracked) {
		_monacoFocusTracked.add(editor as object);
	}

	updateMonacoFocusDataset(editor);
}

function dispatchMonacoMouseSequence(target: HTMLElement): void {
	const rect = target.getBoundingClientRect();
	const clientX = rect.left + Math.min(Math.max(rect.width / 2, 8), Math.max(rect.width - 8, 8));
	const clientY = rect.top + Math.min(Math.max(rect.height / 2, 8), Math.max(rect.height - 8, 8));

	const mouseInit: MouseEventInit = {
		bubbles: true,
		cancelable: true,
		view: window,
		button: 0,
		buttons: 1,
		clientX,
		clientY,
	};

	try {
		target.dispatchEvent(new PointerEvent('pointerdown', mouseInit));
	} catch { /* ignore */ }
	try {
		target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
	} catch { /* ignore */ }
	try {
		target.dispatchEvent(new MouseEvent('mouseup', mouseInit));
	} catch { /* ignore */ }
	try {
		target.dispatchEvent(new MouseEvent('click', mouseInit));
	} catch { /* ignore */ }
}

function dispatchKeyboardEventWithLegacyCodes(
	target: EventTarget,
	type: 'keydown' | 'keyup',
	init: KeyboardEventInit,
	legacyCode: number,
): boolean {
	const event = new KeyboardEvent(type, {
		bubbles: true,
		cancelable: true,
		composed: true,
		...init,
	});

	try {
		Object.defineProperty(event, 'keyCode', { configurable: true, get: () => legacyCode });
	} catch { /* ignore */ }
	try {
		Object.defineProperty(event, 'which', { configurable: true, get: () => legacyCode });
	} catch { /* ignore */ }

	return target.dispatchEvent(event);
}

/**
 * Find an element by `data-testid`, recursively searching through shadow roots.
 * Returns the first match or null.
 *
 * Usage from E2E tests:
 *   When I evaluate "window.__testFind('sql-conn-server').focus()" in the webview
 *   When I evaluate "window.__testFind('sql-conn-save').click()" in the webview
 */
function deepQueryByTestId(root: ParentNode, testId: string): Element | null {
	// Check direct children first
	const direct = root.querySelector(`[data-testid="${testId}"]`);
	if (direct) return direct;

	// Recurse into shadow roots
	const elements = root.querySelectorAll('*');
	for (const el of elements) {
		if (el.shadowRoot) {
			const found = deepQueryByTestId(el.shadowRoot, testId);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Find ALL elements matching a `data-testid`, recursively through shadow roots.
 */
function deepQueryAllByTestId(root: ParentNode, testId: string): Element[] {
	const results: Element[] = [];

	root.querySelectorAll(`[data-testid="${testId}"]`).forEach(el => results.push(el));

	root.querySelectorAll('*').forEach(el => {
		if (el.shadowRoot) {
			results.push(...deepQueryAllByTestId(el.shadowRoot, testId));
		}
	});

	return results;
}

/**
 * Find an element by any CSS selector, recursively through shadow roots.
 * Useful when data-testid isn't available.
 */
function deepQuerySelector(root: ParentNode, selector: string): Element | null {
	try {
		const direct = root.querySelector(selector);
		if (direct) return direct;
	} catch { /* invalid selector for this root */ }

	const elements = root.querySelectorAll('*');
	for (const el of elements) {
		if (el.shadowRoot) {
			const found = deepQuerySelector(el.shadowRoot, selector);
			if (found) return found;
		}
	}
	return null;
}

function resolveMonacoEditorFromSelector(selector: string): { editor: MonacoLike; editorRoot: HTMLElement } {
	const match = deepQuerySelector(document, selector) as HTMLElement | null;
	if (!match) {
		throw new Error(`monaco target not found: ${selector}`);
	}

	const editorRoot = (match.closest('.monaco-editor') as HTMLElement | null)
		|| (match.matches('.monaco-editor') ? match : null)
		|| (match.querySelector('.monaco-editor') as HTMLElement | null)
		|| match;

	const editor = resolveMonacoEditorFromElement(editorRoot);
	if (!editor) {
		throw new Error(`monaco editor instance not found for: ${selector}`);
	}

	return { editor, editorRoot };
}

// Expose on window for E2E test access
const _win = window as any;
_win.__testFind = (testId: string): Element | null => deepQueryByTestId(document, testId);
_win.__testFindAll = (testId: string): Element[] => deepQueryAllByTestId(document, testId);
_win.__testQuery = (selector: string): Element | null => deepQuerySelector(document, selector);

const TEST_SECTION_SELECTOR = 'kw-sql-section,kw-query-section,kw-chart-section,kw-markdown-section,kw-transformation-section,kw-html-section,kw-url-section,kw-python-section';

function clickTestSectionClose(section: HTMLElement): void {
	const shell = section.shadowRoot?.querySelector('kw-section-shell') as HTMLElement | null;
	const closeButton = shell?.shadowRoot?.querySelector('.close-btn') as HTMLElement | null;
	if (!closeButton) {
		const tag = section.tagName.toLowerCase();
		throw new Error(`Could not find section close button for ${tag}`);
	}
	closeButton.click();
}

_win.__testRemoveAllSections = (): string => {
	let removed = 0;
	for (let pass = 0; pass < 50; pass++) {
		const sections = Array.from(document.querySelectorAll(TEST_SECTION_SELECTOR)) as HTMLElement[];
		if (sections.length === 0) {
			return `removed ${removed} sections; remaining=0`;
		}

		for (const section of sections) {
			if (!section.isConnected) continue;
			clickTestSectionClose(section);
			removed++;
		}
	}

	const remaining = Array.from(document.querySelectorAll(TEST_SECTION_SELECTOR)).map(element => element.tagName.toLowerCase());
	throw new Error(`Timed out removing sections; remaining=${remaining.join(', ')}`);
};

_win.__testRemoveSection = (selector: string = TEST_SECTION_SELECTOR): string => {
	const section = document.querySelector(selector) as HTMLElement | null;
	if (!section) {
		throw new Error(`Section not found: ${selector}`);
	}

	const tag = section.tagName.toLowerCase();
	const boxId = (section as any).boxId || section.id || tag;
	clickTestSectionClose(section);

	for (let pass = 0; pass < 50; pass++) {
		if (!section.isConnected) {
			return `removed ${tag} ${boxId}`;
		}
	}

	throw new Error(`Timed out removing ${tag} ${boxId}`);
};

_win.__testSelectKustoRunMode = (mode: string, selector: string = 'kw-query-section'): string => {
	const section = document.querySelector(selector) as any;
	if (!section) {
		throw new Error(`Kusto section not found: ${selector}`);
	}

	const boxId = String(section.boxId || section.id || '');
	if (!boxId) {
		throw new Error('Kusto section has no boxId/id');
	}

	const labelByMode: Record<string, string> = {
		plain: 'Run Query',
		take100: 'Run Query (take 100)',
		sample100: 'Run Query (sample 100)',
	};
	const targetLabel = labelByMode[mode];
	if (!targetLabel) {
		throw new Error(`Unsupported Kusto run mode: ${mode}`);
	}

	const toggle = document.getElementById(boxId + '_run_toggle') as HTMLElement | null;
	if (!toggle) {
		throw new Error(`Kusto run-mode toggle not found for ${boxId}`);
	}
	toggle.click();

	const menu = document.getElementById(boxId + '_run_menu') as HTMLElement | null;
	const items = Array.from(menu?.querySelectorAll('[role=menuitem]') || []) as HTMLElement[];
	const item = items.find(candidate => (candidate.textContent || '').replace(/\s+/g, ' ').trim() === targetLabel);
	if (!item) {
		throw new Error(`Kusto run-mode item not found: ${targetLabel}`);
	}
	item.click();

	const actual = String(_win.runModesByBoxId?.[boxId] || '');
	if (actual !== mode) {
		throw new Error(`Kusto run mode should be ${mode} after menu click, got ${actual}`);
	}

	return `selected Kusto run mode ${targetLabel} for ${boxId}`;
};

// ── Interaction helpers ────────────────────────────────────────────────────
// Each returns a string describing what happened (for E2E step logging).

/**
 * Set the value of a text/number/password input by data-testid.
 * Fires the native `input` event so Lit/React `@input` handlers trigger.
 *
 *   __testSet('sql-conn-server', 'myserver.database.windows.net')
 */
_win.__testSet = (testId: string, value: string): string => {
	const el = deepQueryByTestId(document, testId) as HTMLInputElement | null;
	if (!el) return `not found: ${testId}`;
	const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
	if (nativeSetter) nativeSetter.call(el, value);
	else el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	return `set ${testId} = "${value}"`;
};

/**
 * Select an option in a `<select>` by data-testid.
 * Fires `change` so Lit's `@change` handler triggers.
 *
 *   __testSelect('sql-conn-auth', 'sql-login')
 */
_win.__testSelect = (testId: string, value: string): string => {
	const el = deepQueryByTestId(document, testId) as HTMLSelectElement | null;
	if (!el) return `not found: ${testId}`;
	const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
	if (nativeSetter) nativeSetter.call(el, value);
	else el.value = value;
	el.dispatchEvent(new Event('change', { bubbles: true }));
	return `selected ${testId} = "${value}"`;
};

/**
 * Click any element by data-testid.
 *
 *   __testClick('sql-conn-save')
 */
_win.__testClick = (testId: string): string => {
	const el = deepQueryByTestId(document, testId) as HTMLElement | null;
	if (!el) return `not found: ${testId}`;
	el.click();
	return `clicked ${testId}`;
};

/**
 * Set a checkbox checked/unchecked by data-testid.
 * Fires `change` so Lit's `@change` handler triggers.
 *
 *   __testCheck('remember-me', true)
 */
_win.__testCheck = (testId: string, checked: boolean): string => {
	const el = deepQueryByTestId(document, testId) as HTMLInputElement | null;
	if (!el) return `not found: ${testId}`;
	if (el.checked !== checked) {
		el.checked = checked;
		el.dispatchEvent(new Event('change', { bubbles: true }));
	}
	return `${checked ? 'checked' : 'unchecked'} ${testId}`;
};

/**
 * Focus an element by data-testid (useful before keyboard steps).
 *
 *   __testFocus('sql-conn-server')
 */
_win.__testFocus = (testId: string): string => {
	const el = deepQueryByTestId(document, testId) as HTMLElement | null;
	if (!el) return `not found: ${testId}`;
	el.focus();
	return `focused ${testId}`;
};

/**
 * Focus a Monaco editor by CSS selector and fail if Monaco text/widget focus was not established.
 * Also annotates the Monaco root with data-test-monaco-focus="text|widget|none" for DOM waits.
 *
 *   __testFocusMonaco('kw-sql-section .monaco-editor')
 */
_win.__testFocusMonaco = (selector: string): string => {
	const match = deepQuerySelector(document, selector) as HTMLElement | null;
	if (!match) {
		throw new Error(`monaco target not found: ${selector}`);
	}

	const editorRoot = (match.closest('.monaco-editor') as HTMLElement | null)
		|| (match.matches('.monaco-editor') ? match : null)
		|| (match.querySelector('.monaco-editor') as HTMLElement | null)
		|| match;

	const editor = resolveMonacoEditorFromElement(editorRoot);
	if (!editor) {
		throw new Error(`monaco editor instance not found for: ${selector}`);
	}

	ensureMonacoFocusTracking(editor);

	try {
		dispatchMonacoMouseSequence(editorRoot);
	} catch { /* ignore */ }

	try {
		if (typeof editor.focus === 'function') {
			editor.focus();
		}
	} catch { /* ignore */ }

	try {
		setActiveMonacoEditor(editor);
	} catch { /* ignore */ }

	const textarea = (editorRoot.querySelector('textarea.inputarea') as HTMLTextAreaElement | null)
		|| (editorRoot.querySelector('textarea') as HTMLTextAreaElement | null);
	if (textarea) {
		try { textarea.readOnly = false; } catch { /* ignore */ }
		try { textarea.disabled = false; } catch { /* ignore */ }
		try { textarea.removeAttribute('readonly'); } catch { /* ignore */ }
		try { textarea.removeAttribute('disabled'); } catch { /* ignore */ }
		try { textarea.focus(); } catch { /* ignore */ }
	}

	const state = updateMonacoFocusDataset(editor);
	if (state === 'none') {
		const active = document.activeElement as HTMLElement | null;
		const activeDesc = active ? `${active.tagName}.${String(active.className || '').trim()}` : '(none)';
		throw new Error(`monaco focus not established for ${selector}; active=${activeDesc}`);
	}

	return `focused monaco ${selector} (${state})`;
};

/**
 * Set the full text of a Monaco editor and move the caret to the end.
 * This bypasses the test framework's generic typing, which does not reach webviews reliably.
 *
 *   __testSetMonacoValue('kw-sql-section .monaco-editor', 'SELECT * FROM ')
 */
_win.__testSetMonacoValue = (selector: string, value: string): string => {
	const focusResult = _win.__testFocusMonaco(selector);
	const { editor } = resolveMonacoEditorFromSelector(selector);
	if (!editor || typeof editor.setValue !== 'function') {
		throw new Error(`monaco setValue unavailable for: ${selector}`);
	}

	try {
		editor.setValue(String(value || ''));
	} catch (err) {
		throw new Error(`failed to set monaco value for ${selector}: ${err instanceof Error ? err.message : String(err)}`);
	}

	try {
		const model = (typeof editor.getModel === 'function') ? editor.getModel() : null;
		const lineNumber = model?.getLineCount ? model.getLineCount() : 1;
		const column = model?.getLineMaxColumn ? model.getLineMaxColumn(lineNumber) : (String(value || '').length + 1);
		if (typeof editor.setPosition === 'function') {
			editor.setPosition({ lineNumber, column });
		}
	} catch { /* ignore */ }

	try {
		if (typeof editor.focus === 'function') {
			editor.focus();
		}
	} catch { /* ignore */ }

	updateMonacoFocusDataset(editor);
	const current = (typeof editor.getValue === 'function') ? editor.getValue() : String(value || '');
	return `${focusResult}; monaco value set (${current.length} chars)`;
};

_win.__testSetMonacoValueAt = (selector: string, value: string, lineNumber: number = 1, column?: number): string => {
	const setResult = _win.__testSetMonacoValue(selector, value);
	const { editor } = resolveMonacoEditorFromSelector(selector);
	const model = (typeof editor.getModel === 'function') ? editor.getModel() : null;
	const targetLine = Number.isFinite(lineNumber) ? Math.max(1, Math.floor(lineNumber)) : 1;
	const maxColumn = model?.getLineMaxColumn ? model.getLineMaxColumn(targetLine) : String(value || '').length + 1;
	const targetColumn = Number.isFinite(column) ? Math.max(1, Math.floor(column as number)) : maxColumn;
	if (typeof editor.setPosition !== 'function') {
		throw new Error(`monaco setPosition unavailable for: ${selector}`);
	}
	editor.setPosition({ lineNumber: targetLine, column: targetColumn });
	try { editor.focus?.(); } catch { /* ignore */ }
	updateMonacoFocusDataset(editor);
	return `${setResult}; caret=${targetLine}:${targetColumn}`;
};

_win.__testSetMonacoSelection = (
	selector: string,
	startLineNumber: number,
	startColumn: number,
	endLineNumber: number,
	endColumn: number,
): string => {
	const focusResult = _win.__testFocusMonaco(selector);
	const { editor } = resolveMonacoEditorFromSelector(selector);
	if (typeof editor.setSelection !== 'function') {
		throw new Error(`monaco setSelection unavailable for: ${selector}`);
	}
	editor.setSelection({ startLineNumber, startColumn, endLineNumber, endColumn });
	try { editor.focus?.(); } catch { /* ignore */ }
	updateMonacoFocusDataset(editor);
	return `${focusResult}; selection=${startLineNumber}:${startColumn}-${endLineNumber}:${endColumn}`;
};

_win.__testTriggerMonaco = (selector: string, handlerId: string, payload: any = {}): string => {
	const focusResult = _win.__testFocusMonaco(selector);
	const { editor } = resolveMonacoEditorFromSelector(selector);
	if (typeof editor.trigger !== 'function') {
		throw new Error(`monaco trigger unavailable for: ${selector}`);
	}
	editor.trigger('e2e-test', handlerId, payload ?? {});
	return `${focusResult}; triggered ${handlerId}`;
};

_win.__testTypeMonaco = (selector: string, text: string): string => {
	const focusResult = _win.__testFocusMonaco(selector);
	const { editor } = resolveMonacoEditorFromSelector(selector);
	if (typeof editor.trigger !== 'function') {
		throw new Error(`monaco trigger unavailable for: ${selector}`);
	}
	editor.trigger('keyboard', 'type', { text: String(text || '') });
	const current = typeof editor.getValue === 'function' ? editor.getValue() || '' : '';
	return `${focusResult}; typed ${String(text || '').length} chars; value=${current}`;
};

_win.__testGetMonacoValue = (selector: string): string => {
	const { editor } = resolveMonacoEditorFromSelector(selector);
	if (typeof editor.getValue !== 'function') {
		throw new Error(`monaco getValue unavailable for: ${selector}`);
	}
	return editor.getValue() || '';
};

_win.__testSelectKwDropdownItem = async (dropdownSelector: string, labelsCsv: string): Promise<string> => {
	const dropdown = deepQuerySelector(document, dropdownSelector) as HTMLElement | null;
	if (!dropdown) {
		throw new Error(`dropdown not found: ${dropdownSelector}`);
	}
	const root = dropdown.shadowRoot;
	if (!root) {
		throw new Error(`dropdown shadow root unavailable: ${dropdownSelector}`);
	}
	const button = root.querySelector('.kusto-dropdown-btn') as HTMLElement | null;
	if (!button) {
		throw new Error(`dropdown button not found: ${dropdownSelector}`);
	}
	button.click();
	const maybeUpdateComplete = (dropdown as any).updateComplete;
	if (maybeUpdateComplete && typeof maybeUpdateComplete.then === 'function') {
		await maybeUpdateComplete;
	}
	const desired = String(labelsCsv || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
	const items = Array.from(root.querySelectorAll('.kusto-dropdown-item[role="option"]')) as HTMLElement[];
	if (!items.length) {
		throw new Error(`dropdown has no items: ${dropdownSelector}`);
	}
	const item = items.find(el => {
		const text = (el.textContent || '').trim().toLowerCase();
		return desired.length === 0 || desired.some(label => text === label || text.includes(label));
	});
	if (!item) {
		const available = items.map(el => (el.textContent || '').trim()).filter(Boolean).join(', ');
		throw new Error(`dropdown item not found [${labelsCsv}] in ${dropdownSelector}; available=${available}`);
	}
	const label = (item.textContent || '').trim();
	item.click();
	const afterClickUpdateComplete = (dropdown as any).updateComplete;
	if (afterClickUpdateComplete && typeof afterClickUpdateComplete.then === 'function') {
		await afterClickUpdateComplete;
	}
	return `selected dropdown item: ${label}`;
};

_win.__testAssertVisibleSuggest = (context: string, expectedAnyCsv: string = '', editorSelector: string = ''): string => {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedAnyCsv || '').split(',').map(s => s.trim()).filter(Boolean);
	const roots: ParentNode[] = [];
	if (editorSelector) {
		const selectedRoot = deepQuerySelector(document, editorSelector) as ParentNode | null;
		if (!selectedRoot) {
			throw new Error(`${contextLabel}: editor root not found: ${editorSelector}`);
		}
		roots.push(selectedRoot);
	}
	roots.push(document);

	let widgets: HTMLElement[] = [];
	for (const root of roots) {
		widgets = Array.from(root.querySelectorAll('.suggest-widget.visible')) as HTMLElement[];
		widgets = widgets.filter(widget =>
			!widget.classList.contains('hidden')
			&& widget.style.display !== 'none'
			&& widget.offsetParent !== null
		);
		if (widgets.length) break;
	}

	if (widgets.length === 0) {
		throw new Error(`${contextLabel}: expected visible suggest widget`);
	}

	const widget = widgets[widgets.length - 1];
	const widgetText = (widget.textContent || '').trim();
	if (/no suggestions/i.test(widgetText)) {
		throw new Error(`${contextLabel}: suggest widget reported no suggestions`);
	}

	const rows = (Array.from(widget.querySelectorAll('.monaco-list-row')) as HTMLElement[])
		.filter(row => row.offsetParent !== null);
	const labels = rows
		.map(row => ((row.querySelector('.label-name') as HTMLElement | null)?.textContent || '').trim())
		.filter(Boolean);

	if (labels.length === 0) {
		throw new Error(`${contextLabel}: expected visible suggestions, got 0 labels. Text: ${widgetText.slice(0, 200)}`);
	}

	if (expected.length && !expected.some(candidate => labels.some(label => label.toLowerCase().includes(candidate.toLowerCase())))) {
		throw new Error(`${contextLabel}: expected one of [${expected.join(', ')}], got: ${labels.slice(0, 20).join(', ')}`);
	}

	return `${contextLabel}(${labels.length}): ${labels.slice(0, 15).join(', ')}`;
};

/**
 * Dispatch a Ctrl+Space chord directly to Monaco's hidden textarea.
 * This bypasses the test framework's generic key injection, which does not reach webviews.
 *
 *   __testSendCtrlSpaceMonaco('kw-sql-section .monaco-editor')
 */
_win.__testSendCtrlSpaceMonaco = (selector: string): string => {
	const focusResult = _win.__testFocusMonaco(selector);
	const match = deepQuerySelector(document, selector) as HTMLElement | null;
	if (!match) {
		throw new Error(`monaco target not found: ${selector}`);
	}

	const editorRoot = (match.closest('.monaco-editor') as HTMLElement | null)
		|| (match.matches('.monaco-editor') ? match : null)
		|| (match.querySelector('.monaco-editor') as HTMLElement | null)
		|| match;

	// Resolve the actual Monaco editor instance and trigger suggest directly.
	// This avoids keyboard events being intercepted by the wrong editor.
	const editor = resolveMonacoEditorFromElement(editorRoot);
	if (editor && typeof editor.trigger === 'function') {
		try {
			editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
			return `${focusResult}; triggerSuggest via editor.trigger()`;
		} catch (err) {
			// Fall through to keyboard dispatch
			console.warn('[test-helpers] editor.trigger failed, falling back to keyboard:', err);
		}
	}

	// Fallback: dispatch keyboard events directly on the textarea
	const textarea = (editorRoot.querySelector('textarea.inputarea') as HTMLTextAreaElement | null)
		|| (editorRoot.querySelector('textarea') as HTMLTextAreaElement | null);
	if (!textarea) {
		throw new Error(`monaco textarea not found for: ${selector}`);
	}

	try { textarea.focus(); } catch { /* ignore */ }

	// Real chord order: Ctrl down, Space down/up while Ctrl held, Ctrl up.
	dispatchKeyboardEventWithLegacyCodes(textarea, 'keydown', {
		key: 'Control',
		code: 'ControlLeft',
		ctrlKey: true,
	}, 17);
	const dispatched = dispatchKeyboardEventWithLegacyCodes(textarea, 'keydown', {
		key: ' ',
		code: 'Space',
		ctrlKey: true,
	}, 32);
	dispatchKeyboardEventWithLegacyCodes(textarea, 'keyup', {
		key: ' ',
		code: 'Space',
		ctrlKey: true,
	}, 32);
	dispatchKeyboardEventWithLegacyCodes(textarea, 'keyup', {
		key: 'Control',
		code: 'ControlLeft',
		ctrlKey: false,
	}, 17);

	return `${focusResult}; ctrl-space dispatched=${dispatched ? 'true' : 'false'}`;
};

/**
 * Read the current value of an input/select/textarea by data-testid.
 * Useful for assertions.
 *
 *   __testGet('sql-conn-server')  → "myserver.database.windows.net"
 */
_win.__testGet = (testId: string): string | null => {
	const el = deepQueryByTestId(document, testId) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
	if (!el) return null;
	if (el instanceof HTMLInputElement && el.type === 'checkbox') return String(el.checked);
	return el.value;
};

/**
 * Read the text content of any element by data-testid.
 *
 *   __testText('error-message')  → "Connection failed"
 */
_win.__testText = (testId: string): string | null => {
	const el = deepQueryByTestId(document, testId);
	if (!el) return null;
	return el.textContent?.trim() ?? '';
};

/**
 * Seed a SQL AAD token override for E2E without using the interactive auth dialogs.
 */
_win.__testSetSqlAuthOverride = (serverUrl: string, accountId: string, token: string): string => {
	postMessageToHost({ type: 'testSetSqlAuthOverride', serverUrl, accountId, token });
	return `sql auth override posted for ${String(serverUrl || '').trim()}`;
};

/**
 * Clear a SQL AAD token override after an E2E scenario.
 */
_win.__testClearSqlAuthOverride = (accountId: string): string => {
	postMessageToHost({ type: 'testClearSqlAuthOverride', accountId });
	return `sql auth override clear requested for ${String(accountId || '').trim()}`;
};

/**
 * Open a kw-dropdown by data-testid and disable auto-close so it stays open
 * for screenshots. The dropdown's close handlers are neutralized until the
 * next page navigation or reload.
 *
 *   __testOpenDropdown('cluster-dropdown')
 */
_win.__testOpenDropdown = (testId: string): string => {
	const el = deepQueryByTestId(document, testId) as any;
	if (!el) return `not found: ${testId}`;
	if (typeof el._openMenu !== 'function') return `${testId} is not a kw-dropdown`;
	// Neutralize all dismiss paths so the menu survives until screenshot
	el._closeMenu = () => {};
	el._onDocumentMousedown = () => {};
	el._onDocumentScroll = () => {};
	el._dismissMenu = () => {};
	// Open the menu
	el._openMenu();
	return `opened dropdown ${testId}`;
};

/**
 * Set the active Monaco editor content to the given text.
 * Avoids needing escaped quotes in Gherkin evaluate steps.
 *
 *   __testSetEditorValue('StormEvents | take 10')
 */
_win.__testSetEditorValue = (text: string): string => {
	// Try window.activeMonacoEditor first
	let ed = (window as any).activeMonacoEditor;
	if (!ed || typeof ed.setValue !== 'function') {
		// Fall back: find the first editor in the global queryEditors map
		const qe = (window as any).queryEditors;
		if (qe) {
			for (const key of Object.keys(qe)) {
				if (qe[key] && typeof qe[key].setValue === 'function') {
					ed = qe[key];
					break;
				}
			}
		}
	}
	if (!ed || typeof ed.setValue !== 'function') return 'no active editor';
	ed.setValue(text);
	return `set editor value (${text.length} chars)`;
};

/**
 * Override the visible text of a kw-dropdown button by data-testid.
 * Useful for replacing real cluster/database names with fake placeholder
 * text in marketplace screenshots.
 *
 *   __testSetDropdownText('cluster-dropdown', 'Favorite connection #1 (clusterName.databaseName)')
 */
_win.__testSetDropdownText = (testId: string, text: string): string => {
	const el = deepQueryByTestId(document, testId) as any;
	if (!el) return `not found: ${testId}`;
	const btn = el.shadowRoot?.querySelector('.kusto-dropdown-btn-text') as HTMLElement | null;
	if (!btn) return `no button text element in ${testId}`;
	btn.textContent = text;
	return `set dropdown text: ${text}`;
};
