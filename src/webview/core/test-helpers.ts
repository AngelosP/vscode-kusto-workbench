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
	getModel?: () => { getLineCount?: () => number; getLineMaxColumn?: (lineNumber: number) => number; getLanguageId?: () => string; uri?: { toString(): string } } | null;
	getOptions?: () => { get?: (option: any) => any };
	setPosition?: (position: { lineNumber: number; column: number }) => void;
	setSelection?: (selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => void;
	trigger?: (source: string, handlerId: string, payload: any) => void;
	onDidFocusEditorText?: (cb: () => void) => { dispose(): void };
	onDidFocusEditorWidget?: (cb: () => void) => { dispose(): void };
};

const _monacoFocusTracked = (typeof WeakSet !== 'undefined') ? new WeakSet<object>() : null;

function resolveMonacoEditorFromElement(el: Element | null): MonacoLike | null {
	if (!el) return null;

	// First try: walk up to a known section element and use the section-scoped editor map.
	const host = el.closest('kw-sql-section, kw-query-section, kw-html-section, kw-python-section') as any;
	const hostBoxId = host ? String(host.boxId || host.id || '').trim() : '';
	if (hostBoxId && (window as any).queryEditors?.[hostBoxId]) {
		return (window as any).queryEditors[hostBoxId] as MonacoLike;
	}

	// Some section implementations still keep their editor instance on the host.
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

	const winEditor = (window as any).activeMonacoEditor as MonacoLike | null;
	if (winEditor && typeof winEditor.getDomNode === 'function') {
		const domNode = winEditor.getDomNode();
		if (domNode && (domNode === el || domNode.contains(el) || el.contains(domNode))) {
			return winEditor;
		}
	}

	return null;
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

_win.__testAssertMonacoValue = (selector: string, expected: string): string => {
	const actual = _win.__testGetMonacoValue(selector);
	const expectedText = String(expected || '');
	if (actual !== expectedText) {
		throw new Error(`monaco value mismatch for ${selector}: expected ${expectedText.length} chars, got ${actual.length} chars`);
	}
	return `monaco value verified for ${selector} (${actual.length} chars)`;
};

_win.__testGetMonacoModelUri = (selector: string): string => {
	const { editor } = resolveMonacoEditorFromSelector(selector);
	const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
	const uri = model?.uri?.toString?.();
	if (!uri) {
		throw new Error(`monaco model uri unavailable for: ${selector}`);
	}
	return uri;
};

_win.__testAssertMonacoEditorMapped = (selector: string): string => {
	const { editor } = resolveMonacoEditorFromSelector(selector);
	const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
	const uri = model?.uri?.toString?.();
	if (!uri) {
		throw new Error(`monaco model uri unavailable for: ${selector}`);
	}
	const boxId = _win.queryEditorBoxByModelUri?.[uri];
	if (!boxId) {
		throw new Error(`queryEditorBoxByModelUri missing ${uri}`);
	}
	if (!_win.queryEditors?.[boxId]) {
		throw new Error(`queryEditors missing ${boxId}`);
	}
	const language = typeof model?.getLanguageId === 'function' ? model.getLanguageId() : 'unknown';
	return `editor mapped: boxId=${boxId}, language=${language}, uri=${uri}`;
};

_win.__testAssertMonacoInlineSuggestEnabled = (selector: string): string => {
	const { editor } = resolveMonacoEditorFromSelector(selector);
	const options = typeof editor.getOptions === 'function' ? editor.getOptions() : null;
	const monacoApi = _win.monaco;
	const inlineSuggestOption = monacoApi?.editor?.EditorOption?.inlineSuggest;
	if (!options?.get || inlineSuggestOption === undefined) {
		throw new Error(`inlineSuggest option unavailable for: ${selector}`);
	}
	const inlineSuggest = options.get(inlineSuggestOption);
	if (!inlineSuggest || inlineSuggest.enabled !== true) {
		throw new Error(`inlineSuggest not enabled for ${selector}: ${JSON.stringify(inlineSuggest)}`);
	}
	return `inlineSuggest enabled for ${selector}`;
};

_win.__testAssertMonacoMarkers = (selector: string, expectation: 'any' | 'none' = 'any', owner: string = '', severity: 'error' | '' = ''): string => {
	const { editor } = resolveMonacoEditorFromSelector(selector);
	const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
	if (!model?.uri) {
		throw new Error(`monaco model unavailable for marker check: ${selector}`);
	}
	const monacoApi = _win.monaco;
	if (!monacoApi?.editor?.getModelMarkers) {
		throw new Error('monaco.editor.getModelMarkers unavailable');
	}
	const options = owner ? { resource: model.uri, owner } : { resource: model.uri };
	let markers = monacoApi.editor.getModelMarkers(options) || [];
	if (severity === 'error') {
		markers = markers.filter((marker: any) => marker.severity === monacoApi.MarkerSeverity?.Error);
	}
	if (expectation === 'any' && markers.length === 0) {
		throw new Error(`expected Monaco ${severity || ''} markers for ${selector}, got 0`);
	}
	if (expectation === 'none' && markers.length !== 0) {
		throw new Error(`expected no Monaco ${severity || ''} markers for ${selector}, got ${markers.length}: ${markers.map((m: any) => String(m.message || '').slice(0, 80)).join('; ')}`);
	}
	return `${severity || 'all'} markers(${markers.length}) for ${selector}: ${markers.slice(0, 5).map((m: any) => String(m.message || '').slice(0, 60)).join('; ')}`;
};

_win.__testSelectKwDropdownItem = async (dropdownSelector: string, labelsCsv: string, allowFirstFallback: boolean = false): Promise<string> => {
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
	}) || (allowFirstFallback ? items[0] : null);
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

_win.__testAssertKwDropdownHasItems = async (dropdownSelector: string, minCount: number = 1): Promise<string> => {
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
	const labels = Array.from(root.querySelectorAll('.kusto-dropdown-item[role="option"]'))
		.map(el => (el.textContent || '').trim())
		.filter(Boolean);
	if (labels.length < minCount) {
		throw new Error(`expected at least ${minCount} dropdown item(s) in ${dropdownSelector}, got ${labels.length}`);
	}
	button.click();
	return `dropdown items(${labels.length}): ${labels.slice(0, 10).join(', ')}`;
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

type E2eSectionKind = 'sql' | 'kusto';

const E2E_SECTION = {
	sql: {
		section: 'kw-sql-section',
		editor: 'kw-sql-section .query-editor',
		databaseDropdown: "kw-sql-section .select-wrapper[title='SQL Database'] kw-dropdown",
		runButton: '.sql-run-btn',
		resultsTable: 'kw-sql-section .sql-results-body kw-data-table',
	},
	kusto: {
		section: 'kw-query-section',
		editor: 'kw-query-section .query-editor',
		databaseDropdown: "kw-query-section .select-wrapper[title='Kusto Database'] kw-dropdown",
		runButton: '',
		resultsTable: '',
	},
};

function e2eSection(kind: E2eSectionKind): any {
	const section = document.querySelector(E2E_SECTION[kind].section) as any;
	if (!section) {
		throw new Error(`${kind} section not found`);
	}
	return section;
}

function e2eKustoElementId(section: any, suffix: string): string {
	const boxId = String(section?.boxId || section?.id || '').trim();
	if (!boxId) {
		throw new Error('Kusto section has no boxId/id');
	}
	return `${boxId}_${suffix}`;
}

function e2eRunButton(kind: E2eSectionKind): HTMLButtonElement {
	const section = e2eSection(kind);
	const button = kind === 'sql'
		? section.querySelector(E2E_SECTION.sql.runButton) as HTMLButtonElement | null
		: document.getElementById(e2eKustoElementId(section, 'run_btn')) as HTMLButtonElement | null;
	if (!button) {
		throw new Error(`${kind} run button not found`);
	}
	return button;
}

function e2eResultsTable(kind: E2eSectionKind): any {
	const section = e2eSection(kind);
	const table = kind === 'sql'
		? document.querySelector(E2E_SECTION.sql.resultsTable) as any
		: document.getElementById(e2eKustoElementId(section, 'results'))?.querySelector('kw-data-table') as any;
	if (!table) {
		throw new Error(`${kind} results data table not found`);
	}
	return table;
}

function e2eColumnNames(table: any): string[] {
	return (table.columns || []).map((column: any) => String(column?.name || column || ''));
}

function e2eAssertColumns(kind: E2eSectionKind, expectedCsv: string): string {
	const table = e2eResultsTable(kind);
	const columns = e2eColumnNames(table);
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	for (const column of expected) {
		if (!columns.includes(column)) {
			throw new Error(`${kind} results missing column ${column}; got: ${columns.join(', ')}`);
		}
	}
	return `${kind} columns verified: ${columns.join(', ')}`;
}

function e2eAssertRowCount(kind: E2eSectionKind, expected: number, mode: 'exact' | 'atLeast'): string {
	const table = e2eResultsTable(kind);
	const rows = table.rows || [];
	const count = rows.length;
	if (mode === 'exact' && count !== expected) {
		throw new Error(`${kind} expected ${expected} row(s), got ${count}`);
	}
	if (mode === 'atLeast' && count < expected) {
		throw new Error(`${kind} expected at least ${expected} row(s), got ${count}`);
	}
	return `${kind} row count ${mode === 'exact' ? '=' : '>='} ${expected}: ${count}`;
}

function e2eAssertState(kind: E2eSectionKind, attr: string, expected: string): string {
	const section = e2eSection(kind);
	const actual = section.dataset?.[attr];
	if (actual !== expected) {
		throw new Error(`${kind} expected data-test-${attr}=${expected}, got ${actual}`);
	}
	return `${kind} data-test-${attr}=${actual}`;
}

function e2eAssertNoVisibleSuggest(context: string): string {
	const contextLabel = String(context || 'suggestions');
	const widgets = (Array.from(document.querySelectorAll('.suggest-widget.visible')) as HTMLElement[])
		.filter(widget => !widget.classList.contains('hidden') && widget.style.display !== 'none' && widget.offsetParent !== null);
	if (widgets.length !== 0) {
		const text = (widgets[widgets.length - 1].textContent || '').trim();
		throw new Error(`${contextLabel}: expected no visible suggest widget, got ${widgets.length}: ${text.slice(0, 200)}`);
	}
	return `${contextLabel}: no visible suggest widget`;
}

function e2eAutoTriggerToggle(): HTMLElement {
	const toggle = document.querySelector('kw-sql-toolbar .qe-auto-autocomplete-toggle') as HTMLElement | null;
	if (!toggle) {
		throw new Error('SQL auto-trigger toggle not found');
	}
	return toggle;
}

function e2eQueryApi(kind: E2eSectionKind) {
	const editorSelector = E2E_SECTION[kind].editor;
	return {
		selectDatabase: (labelsCsv: string, allowFirstFallback: boolean = false) => _win.__testSelectKwDropdownItem(E2E_SECTION[kind].databaseDropdown, labelsCsv, allowFirstFallback),
		setQuery: (text: string) => _win.__testSetMonacoValue(editorSelector, text),
		setQueryAt: (text: string, lineNumber: number = 1, column?: number) => _win.__testSetMonacoValueAt(editorSelector, text, lineNumber, column),
		setSelection: (startLineNumber: number, startColumn: number, endLineNumber: number, endColumn: number) => _win.__testSetMonacoSelection(editorSelector, startLineNumber, startColumn, endLineNumber, endColumn),
		assertQuery: (text: string) => _win.__testAssertMonacoValue(editorSelector, text),
		assertEditorMapped: () => _win.__testAssertMonacoEditorMapped(editorSelector),
		assertInlineSuggestEnabled: () => _win.__testAssertMonacoInlineSuggestEnabled(editorSelector),
		modelUri: () => _win.__testGetMonacoModelUri(editorSelector),
		typeText: (text: string) => _win.__testTypeMonaco(editorSelector, text),
		triggerSuggest: () => _win.__testTriggerMonaco(editorSelector, 'editor.action.triggerSuggest'),
		assertSuggestions: (context: string, expectedAnyCsv: string = '') => _win.__testAssertVisibleSuggest(context, expectedAnyCsv, editorSelector),
		assertMarkers: (expectation: 'any' | 'none' = 'any', owner: string = '', severity: 'error' | '' = '') => _win.__testAssertMonacoMarkers(editorSelector, expectation, owner, severity),
		assertRunEnabled: () => {
			const button = e2eRunButton(kind);
			if (button.disabled) {
				throw new Error(`${kind} run button should be enabled`);
			}
			return `${kind} run button enabled`;
		},
		run: () => {
			const button = e2eRunButton(kind);
			button.click();
			return `${kind} run clicked`;
		},
		assertHasResults: () => e2eAssertState(kind, 'testHasResults', 'true'),
		assertHasError: () => e2eAssertState(kind, 'testHasError', 'true'),
		assertNoError: () => e2eAssertState(kind, 'testHasError', 'false'),
		assertResultColumns: (expectedCsv: string) => e2eAssertColumns(kind, expectedCsv),
		assertRowCount: (expected: number) => e2eAssertRowCount(kind, expected, 'exact'),
		assertMinRowCount: (minimum: number) => e2eAssertRowCount(kind, minimum, 'atLeast'),
	};
}

function e2eInlineToggle(kind: E2eSectionKind): HTMLElement {
	const selector = kind === 'sql' ? 'kw-sql-toolbar .qe-copilot-inline-toggle' : 'kw-query-toolbar .qe-copilot-inline-toggle';
	const toggle = document.querySelector(selector) as HTMLElement | null;
	if (!toggle) {
		throw new Error(`${kind} Copilot inline toggle not found`);
	}
	return toggle;
}

function e2eAssertInlineToggleState(kind: E2eSectionKind, expectedActive: boolean): string {
	const toggle = e2eInlineToggle(kind);
	const active = toggle.classList.contains('is-active');
	if (active !== expectedActive) {
		throw new Error(`${kind} inline toggle expected active=${expectedActive}, got ${active}`);
	}
	return `${kind} inline toggle active=${active}`;
}

const E2E_PERSISTENCE_SECTION_SELECTOR = 'kw-query-section,kw-sql-section,kw-markdown-section,kw-html-section,kw-chart-section,kw-transformation-section,kw-python-section,kw-url-section';

function e2ePersistenceSections(): HTMLElement[] {
	const container = document.getElementById('queries-container');
	const candidates = container
		? Array.from(container.children)
		: Array.from(document.querySelectorAll(E2E_PERSISTENCE_SECTION_SELECTOR));
	return candidates.filter((section): section is HTMLElement => {
		const tagName = section.tagName?.toLowerCase();
		return !!tagName && E2E_PERSISTENCE_SECTION_SELECTOR.split(',').includes(tagName);
	});
}

function e2ePersistenceSection(sectionId: string): any {
	const section = document.getElementById(sectionId) as any;
	if (!section) {
		throw new Error(`section not found: ${sectionId}`);
	}
	return section;
}

function e2eSerializeSection(sectionId: string): any {
	const section = e2ePersistenceSection(sectionId);
	if (typeof section.serialize !== 'function') {
		throw new Error(`section has no serialize method: ${sectionId}`);
	}
	return section.serialize();
}

function e2eAssertField(actual: any, fieldName: string, expectedValue: any, context: string): void {
	if (typeof expectedValue === 'undefined') {
		return;
	}
	if (actual !== expectedValue) {
		throw new Error(`${context} expected ${fieldName}=${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`);
	}
}

function e2eAssertIncludes(actual: any, fieldName: string, expectedValue: any, context: string): void {
	if (typeof expectedValue === 'undefined') {
		return;
	}
	const haystack = String(actual || '');
	const needles = Array.isArray(expectedValue) ? expectedValue : [expectedValue];
	for (const needleValue of needles) {
		const needle = String(needleValue || '');
		if (needle && !haystack.includes(needle)) {
			throw new Error(`${context} expected ${fieldName} to include ${JSON.stringify(needle)}`);
		}
	}
}

function e2eParseResultJson(sectionData: any, context: string): any | null {
	if (!sectionData.resultJson) {
		return null;
	}
	try {
		return JSON.parse(String(sectionData.resultJson));
	} catch (error) {
		throw new Error(`${context} has invalid resultJson: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function e2eAssertResultJson(sectionData: any, expected: any, context: string): string {
	const expectsRows = typeof expected.resultRows !== 'undefined';
	const expectsColumns = typeof expected.resultColumns !== 'undefined';
	if (!expectsRows && !expectsColumns) {
		return '';
	}

	const result = e2eParseResultJson(sectionData, context);
	if (!result) {
		throw new Error(`${context} expected persisted resultJson`);
	}

	if (expectsRows) {
		const rows = Array.isArray(result.rows) ? result.rows : [];
		if (rows.length !== expected.resultRows) {
			throw new Error(`${context} expected ${expected.resultRows} result row(s), got ${rows.length}`);
		}
	}

	if (expectsColumns) {
		const expectedColumns = String(expected.resultColumns || '').split(',').map(value => value.trim()).filter(Boolean);
		const actualColumns = Array.isArray(result.columns)
			? result.columns.map((column: any) => String(column?.name || column || ''))
			: [];
		for (const expectedColumn of expectedColumns) {
			if (!actualColumns.includes(expectedColumn)) {
				throw new Error(`${context} missing result column ${expectedColumn}; got: ${actualColumns.join(', ')}`);
			}
		}
		return ` resultColumns=${actualColumns.join(',')}`;
	}

	return '';
}

function e2eAssertQueryPersistence(sectionId: string, expected: any = {}): string {
	const sectionData = e2eSerializeSection(sectionId);
	const context = `query section ${sectionId}`;
	e2eAssertField(sectionData.type, 'type', 'query', context);
	e2eAssertField(sectionData.name, 'name', expected.name, context);
	e2eAssertField(sectionData.query, 'query', expected.query, context);
	e2eAssertIncludes(sectionData.query, 'query', expected.queryIncludes, context);
	e2eAssertField(sectionData.clusterUrl, 'clusterUrl', expected.clusterUrl, context);
	e2eAssertField(sectionData.database, 'database', expected.database, context);
	e2eAssertField(sectionData.runMode, 'runMode', expected.runMode, context);
	e2eAssertField(sectionData.resultsVisible, 'resultsVisible', expected.resultsVisible, context);
	const resultSummary = e2eAssertResultJson(sectionData, expected, context);
	return `${context} verified${resultSummary}`;
}

function e2eAssertSqlPersistence(sectionId: string, expected: any = {}): string {
	const sectionData = e2eSerializeSection(sectionId);
	const context = `sql section ${sectionId}`;
	e2eAssertField(sectionData.type, 'type', 'sql', context);
	e2eAssertField(sectionData.name, 'name', expected.name, context);
	e2eAssertField(sectionData.query, 'query', expected.query, context);
	e2eAssertIncludes(sectionData.query, 'query', expected.queryIncludes, context);
	e2eAssertField(sectionData.serverUrl, 'serverUrl', expected.serverUrl, context);
	e2eAssertField(sectionData.database, 'database', expected.database, context);
	e2eAssertField(sectionData.runMode, 'runMode', expected.runMode, context);
	e2eAssertField(sectionData.resultsVisible, 'resultsVisible', expected.resultsVisible, context);
	const resultSummary = e2eAssertResultJson(sectionData, expected, context);
	return `${context} verified${resultSummary}`;
}

function e2eAssertMarkdownPersistence(sectionId: string, expected: any = {}): string {
	const sectionData = e2eSerializeSection(sectionId);
	const context = `markdown section ${sectionId}`;
	e2eAssertField(sectionData.type, 'type', 'markdown', context);
	e2eAssertField(sectionData.title, 'title', expected.title, context);
	e2eAssertField(sectionData.text, 'text', expected.text, context);
	e2eAssertIncludes(sectionData.text, 'text', expected.textIncludes, context);
	e2eAssertField(sectionData.mode, 'mode', expected.mode, context);
	e2eAssertField(sectionData.tab, 'tab', expected.tab, context);
	return `${context} verified`;
}

function e2eSelectSqlRunMode(mode: string, sectionId: string = ''): string {
	const section = sectionId ? e2ePersistenceSection(sectionId) : e2eSection('sql');
	const boxId = String(section.boxId || section.id || '').trim();
	if (!boxId) {
		throw new Error('SQL section has no boxId/id');
	}

	const labelByMode: Record<string, string> = {
		plain: 'Run Query',
		take100: 'Run Query (take 100)',
		top100: 'Run Query (TOP 100)',
		sample100: 'Run Query (sample 100)',
	};
	const targetLabel = labelByMode[mode];
	if (!targetLabel) {
		throw new Error(`Unsupported SQL run mode: ${mode}`);
	}

	const toggle = document.getElementById(boxId + '_sql_run_toggle') as HTMLElement | null;
	if (!toggle) {
		throw new Error(`SQL run-mode toggle not found for ${boxId}`);
	}
	toggle.click();

	const menu = document.getElementById(boxId + '_sql_run_menu') as HTMLElement | null;
	const items = Array.from(menu?.querySelectorAll('[role=menuitem]') || []) as HTMLElement[];
	const item = items.find(candidate => (candidate.textContent || '').replace(/\s+/g, ' ').trim() === targetLabel);
	if (!item) {
		throw new Error(`SQL run-mode item not found: ${targetLabel}`);
	}
	item.click();

	const actual = String(_win.runModesByBoxId?.[boxId] || '');
	if (actual !== mode) {
		throw new Error(`SQL run mode should be ${mode} after menu click, got ${actual}`);
	}

	return `selected SQL run mode ${targetLabel} for ${boxId}`;
}

_win.__e2e = {
	workbench: {
		clearSections: () => _win.__testRemoveAllSections(),
		removeSection: (selector: string) => _win.__testRemoveSection(selector),
	},
	sql: {
		...e2eQueryApi('sql'),
		connectSts: () => {
			const section = e2eSection('sql');
			const sqlConnectionId = typeof section.getSqlConnectionId === 'function' ? section.getSqlConnectionId() : '';
			const database = typeof section.getDatabase === 'function' ? section.getDatabase() : '';
			if (!sqlConnectionId) {
				throw new Error('SQL connection id missing before STS connect');
			}
			if (!database) {
				throw new Error('SQL database missing before STS connect');
			}
			postMessageToHost({ type: 'stsConnect', boxId: section.boxId, sqlConnectionId, database });
			return `sql STS connect posted for ${database}`;
		},
		assertExecutingTimerVisible: () => {
			const section = e2eSection('sql');
			if (section.dataset.testExecuting !== 'true') {
				throw new Error(`SQL expected executing=true, got ${section.dataset.testExecuting}`);
			}
			const status = section.querySelector('.query-exec-status') as HTMLElement | null;
			if (!status || status.style.display === 'none') {
				throw new Error('SQL elapsed timer not visible during execution');
			}
			return 'sql executing timer visible';
		},
		assertStaleResults: () => {
			const wrapper = document.querySelector('kw-sql-section .results-wrapper') as HTMLElement | null;
			if (!wrapper) {
				throw new Error('SQL results wrapper not found');
			}
			if (!wrapper.classList.contains('is-stale')) {
				throw new Error('SQL results wrapper should have is-stale class');
			}
			return 'sql stale results verified';
		},
		assertResultsNotStale: () => {
			const wrapper = document.querySelector('kw-sql-section .results-wrapper') as HTMLElement | null;
			if (!wrapper) {
				throw new Error('SQL results wrapper not found');
			}
			if (wrapper.classList.contains('is-stale')) {
				throw new Error('SQL stale overlay should be cleared');
			}
			return 'sql results not stale';
		},
	},
	kusto: {
		...e2eQueryApi('kusto'),
		selectSampleDatabase: () => _win.__testSelectKwDropdownItem(E2E_SECTION.kusto.databaseDropdown, 'sample,storm', true),
		assertStaleResults: () => {
			const section = e2eSection('kusto');
			const resultsDiv = document.getElementById(e2eKustoElementId(section, 'results'));
			if (!resultsDiv) {
				throw new Error('Kusto results div not found');
			}
			if (!resultsDiv.classList.contains('is-stale')) {
				throw new Error('Kusto results should have is-stale class');
			}
			return 'kusto stale results verified';
		},
		assertResultsNotStale: () => {
			const section = e2eSection('kusto');
			const resultsDiv = document.getElementById(e2eKustoElementId(section, 'results'));
			if (!resultsDiv) {
				throw new Error('Kusto results div not found');
			}
			if (resultsDiv.classList.contains('is-stale')) {
				throw new Error('Kusto stale overlay should be cleared');
			}
			return 'kusto results not stale';
		},
	},
	suggest: {
		sql: {
			setTextAt: (text: string, lineNumber: number = 1, column?: number) => _win.__e2e.sql.setQueryAt(text, lineNumber, column),
			typeText: (text: string) => _win.__e2e.sql.typeText(text),
			trigger: () => _win.__e2e.sql.triggerSuggest(),
			assertVisible: (context: string, expectedAnyCsv: string = '') => _win.__e2e.sql.assertSuggestions(context, expectedAnyCsv),
			assertHidden: (context: string) => e2eAssertNoVisibleSuggest(context),
		},
		kusto: {
			setTextAt: (text: string, lineNumber: number = 1, column?: number) => _win.__e2e.kusto.setQueryAt(text, lineNumber, column),
			typeText: (text: string) => _win.__e2e.kusto.typeText(text),
			trigger: () => _win.__e2e.kusto.triggerSuggest(),
			assertVisible: (context: string, expectedAnyCsv: string = '') => _win.__e2e.kusto.assertSuggestions(context, expectedAnyCsv),
			assertHidden: (context: string) => e2eAssertNoVisibleSuggest(context),
		},
	},
	autoTrigger: {
		assertSqlToggleVisible: () => {
			const toggle = e2eAutoTriggerToggle();
			const rect = toggle.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) {
				throw new Error('SQL auto-trigger toggle has zero dimensions');
			}
			return `sql auto-trigger toggle visible: ${rect.width}x${rect.height}`;
		},
		assertEnabled: (expected: boolean) => {
			if (typeof _win.autoTriggerAutocompleteEnabled !== 'boolean') {
				throw new Error('autoTriggerAutocompleteEnabled not found');
			}
			if (_win.autoTriggerAutocompleteEnabled !== expected) {
				throw new Error(`autoTriggerAutocompleteEnabled expected ${expected}, got ${_win.autoTriggerAutocompleteEnabled}`);
			}
			return `autoTriggerAutocompleteEnabled=${_win.autoTriggerAutocompleteEnabled}`;
		},
		clickSqlToggle: () => {
			e2eAutoTriggerToggle().click();
			return 'sql auto-trigger toggle clicked';
		},
	},
	persistence: {
		assertDocumentKind: (expectedKind: string) => {
			const actual = document.body.dataset.kustoDocumentKind || '';
			if (actual !== expectedKind) {
				throw new Error(`expected document kind ${expectedKind}, got ${actual}`);
			}
			return `document kind=${actual}`;
		},
		assertSectionOrder: (expectedTypesCsv: string) => {
			const expectedTypes = String(expectedTypesCsv || '').split(',').map(value => value.trim()).filter(Boolean);
			const actualTypes = e2ePersistenceSections().map(section => {
				try {
					return typeof (section as any).serialize === 'function'
						? String((section as any).serialize().type || '')
						: section.tagName.toLowerCase().replace(/^kw-/, '').replace(/-section$/, '');
				} catch {
					return section.tagName.toLowerCase().replace(/^kw-/, '').replace(/-section$/, '');
				}
			});
			if (actualTypes.join(',') !== expectedTypes.join(',')) {
				throw new Error(`expected section order ${expectedTypes.join(',')}, got ${actualTypes.join(',')}`);
			}
			return `section order=${actualTypes.join(',')}`;
		},
		assertSectionIds: (expectedIdsCsv: string) => {
			const expectedIds = String(expectedIdsCsv || '').split(',').map(value => value.trim()).filter(Boolean);
			const actualIds = e2ePersistenceSections().map(section => section.id || section.getAttribute('box-id') || '');
			if (actualIds.join(',') !== expectedIds.join(',')) {
				throw new Error(`expected section ids ${expectedIds.join(',')}, got ${actualIds.join(',')}`);
			}
			return `section ids=${actualIds.join(',')}`;
		},
		assertQuerySection: e2eAssertQueryPersistence,
		assertSqlSection: e2eAssertSqlPersistence,
		assertMarkdownSection: e2eAssertMarkdownPersistence,
		selectKustoRunMode: (mode: string, selector: string = 'kw-query-section') => _win.__testSelectKustoRunMode(mode, selector),
		selectSqlRunMode: e2eSelectSqlRunMode,
	},
	inline: {
		assertToggleVisible: (kind: E2eSectionKind) => {
			const toggle = e2eInlineToggle(kind);
			if (toggle.classList.contains('qe-in-overflow')) {
				throw new Error(`${kind} inline toggle is hidden in toolbar overflow`);
			}
			const rect = toggle.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) {
				throw new Error(`${kind} inline toggle has zero dimensions`);
			}
			return `${kind} inline toggle visible: ${rect.width}x${rect.height}`;
		},
		assertGlobalEnabled: (expected: boolean) => {
			if (typeof _win.copilotInlineCompletionsEnabled !== 'boolean') {
				throw new Error('copilotInlineCompletionsEnabled not found');
			}
			if (_win.copilotInlineCompletionsEnabled !== expected) {
				throw new Error(`copilotInlineCompletionsEnabled expected ${expected}, got ${_win.copilotInlineCompletionsEnabled}`);
			}
			return `copilotInlineCompletionsEnabled=${_win.copilotInlineCompletionsEnabled}`;
		},
		clickToggle: (kind: E2eSectionKind) => {
			e2eInlineToggle(kind).click();
			return `${kind} inline toggle clicked`;
		},
		assertToggleState: e2eAssertInlineToggleState,
		assertSqlAndKustoSynced: (expectedActive: boolean) => {
			const sql = e2eAssertInlineToggleState('sql', expectedActive);
			const kusto = e2eAssertInlineToggleState('kusto', expectedActive);
			return `${sql}; ${kusto}`;
		},
		beginRequestCapture: (kind: E2eSectionKind, text: string, lineNumber: number = 1, column?: number) => {
			_win.__e2e[kind].setQueryAt(text, lineNumber, column);
			_win.__e2eInlineReqCapture = [];
			_win.__e2eOrigPostMsg = _win.postMessageToHost;
			_win.postMessageToHost = function (msg: any) {
				if (msg && msg.type === 'requestCopilotInlineCompletion') {
					_win.__e2eInlineReqCapture.push(msg);
				}
				if (_win.__e2eOrigPostMsg) {
					_win.__e2eOrigPostMsg(msg);
				}
			};
			return `${kind} inline request capture armed`;
		},
		assertCapturedRequest: (flavor: string, textIncludes: string = '') => {
			const messages = _win.__e2eInlineReqCapture || [];
			if (messages.length === 0) {
				throw new Error('No inline completion request captured');
			}
			const msg = messages[0];
			if (msg.flavor !== flavor) {
				throw new Error(`Expected inline flavor=${flavor}, got ${msg.flavor}`);
			}
			if (textIncludes && !String(msg.textBefore || '').includes(textIncludes)) {
				throw new Error(`Inline request textBefore missing ${textIncludes}`);
			}
			return `inline request captured: flavor=${msg.flavor}, requests=${messages.length}`;
		},
		restoreRequestCapture: () => {
			if (_win.__e2eOrigPostMsg) {
				_win.postMessageToHost = _win.__e2eOrigPostMsg;
				delete _win.__e2eOrigPostMsg;
			}
			delete _win.__e2eInlineReqCapture;
			return 'inline request capture restored';
		},
		rememberEditorMap: (kind: E2eSectionKind, key: string = 'default') => {
			const section = e2eSection(kind);
			const uri = _win.__e2e[kind].modelUri();
			_win.__e2eRememberedEditors = _win.__e2eRememberedEditors || {};
			_win.__e2eRememberedEditors[key] = { boxId: section.boxId, uri };
			return `${kind} remembered editor map ${key}: ${section.boxId} ${uri}`;
		},
		assertRememberedEditorMapCleared: (key: string = 'default') => {
			const remembered = _win.__e2eRememberedEditors?.[key];
			if (!remembered) {
				throw new Error(`No remembered editor map for key ${key}`);
			}
			if (_win.queryEditorBoxByModelUri?.[remembered.uri]) {
				throw new Error(`queryEditorBoxByModelUri not cleaned up for ${remembered.uri}`);
			}
			if (_win.queryEditors?.[remembered.boxId]) {
				throw new Error(`queryEditors not cleaned up for ${remembered.boxId}`);
			}
			return `editor map cleanup verified for ${key}`;
		},
	},
};
