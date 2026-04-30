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

function deepQuerySelectorAll(root: ParentNode, selector: string): Element[] {
	const results: Element[] = [];
	try {
		root.querySelectorAll(selector).forEach(el => results.push(el));
	} catch { /* invalid selector for this root */ }

	root.querySelectorAll('*').forEach(el => {
		if (el.shadowRoot) {
			results.push(...deepQuerySelectorAll(el.shadowRoot, selector));
		}
	});

	return results;
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
	const widgets = e2eVisibleSuggestWidgets(contextLabel, editorSelector);
	e2eAssertNoSuggestLoading(`${contextLabel} loading check`, editorSelector);

	if (widgets.length === 0) {
		throw new Error(`${contextLabel}: expected visible suggest widget`);
	}

	const widget = widgets[widgets.length - 1];
	const widgetText = (widget.textContent || '').trim();
	if (/\bloading\b/i.test(widgetText)) {
		throw new Error(`${contextLabel}: suggest widget is still loading. Text: ${widgetText.slice(0, 200)}`);
	}
	if (/no suggestions/i.test(widgetText)) {
		throw new Error(`${contextLabel}: suggest widget reported no suggestions`);
	}

	const rows = (Array.from(widget.querySelectorAll('.monaco-list-row')) as HTMLElement[])
		.filter(row => e2eIsVisibleElement(row));
	const labels = rows
		.map(row => row.querySelector('.label-name') as HTMLElement | null)
		.filter(labelElement => labelElement ? e2eIsVisibleElement(labelElement) : false)
		.map(labelElement => (labelElement?.textContent || '').trim())
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

type KustoCompletionScenario = 'table-prefix' | 'pipe-operators' | 'project-columns' | 'where-columns' | 'summarize-functions' | 'extend-functions' | 'valid-query';

type KustoCompletionTargets = {
	table: string;
	tablePrefix: string;
	column: string;
	columnPrefix: string;
	stringColumn: string;
	numericColumn: string;
	dateColumn: string;
	expectedByScenario: Record<string, string[]>;
};

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
	const widgets = e2eVisibleSuggestWidgets(contextLabel);
	if (widgets.length !== 0) {
		const text = (widgets[widgets.length - 1].textContent || '').trim();
		throw new Error(`${contextLabel}: expected no visible suggest widget, got ${widgets.length}: ${text.slice(0, 200)}`);
	}
	return `${contextLabel}: no visible suggest widget`;
}

function e2eDelay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function e2eIsVisibleElement(element: HTMLElement): boolean {
	let current: HTMLElement | null = element;
	while (current) {
		if (String(current.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return false;
		if (current.classList.contains('hidden')) return false;
		const currentStyle = getComputedStyle(current);
		if (currentStyle.display === 'none' || currentStyle.visibility === 'hidden' || Number(currentStyle.opacity) === 0) return false;
		current = current.parentElement;
	}
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return false;
	const doc = element.ownerDocument || document;
	const view = doc.defaultView || window;
	if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= view.innerWidth || rect.top >= view.innerHeight) return false;
	const minX = Math.max(0, rect.left + 1);
	const maxX = Math.min(view.innerWidth - 1, rect.right - 1);
	const minY = Math.max(0, rect.top + 1);
	const maxY = Math.min(view.innerHeight - 1, rect.bottom - 1);
	const points = [
		[(minX + maxX) / 2, (minY + maxY) / 2],
		[minX, minY],
		[maxX, minY],
		[minX, maxY],
	] as const;
	for (const [x, y] of points) {
		const hit = doc.elementFromPoint(x, y);
		if (hit && (hit === element || element.contains(hit) || hit.contains(element))) {
			return true;
		}
	}
	return false;
}

function e2eSuggestRoots(contextLabel: string, editorSelector: string = ''): ParentNode[] {
	const roots: ParentNode[] = [];
	if (editorSelector) {
		const selectedRoot = deepQuerySelector(document, editorSelector) as ParentNode | null;
		if (!selectedRoot) {
			throw new Error(`${contextLabel}: editor root not found: ${editorSelector}`);
		}
		roots.push(selectedRoot);
	}
	roots.push(document);
	return roots;
}

function e2eVisibleSuggestWidgets(contextLabel: string, editorSelector: string = ''): HTMLElement[] {
	const seen = new Set<HTMLElement>();
	const widgets: HTMLElement[] = [];
	for (const root of e2eSuggestRoots(contextLabel, editorSelector)) {
		const rootWidgets = deepQuerySelectorAll(root, '.suggest-widget') as HTMLElement[];
		for (const widget of rootWidgets) {
			if (!seen.has(widget) && e2eIsVisibleElement(widget)) {
				seen.add(widget);
				widgets.push(widget);
			}
		}
	}
	return widgets;
}

function e2eAssertNoSuggestLoading(context: string, editorSelector: string = ''): string {
	const contextLabel = String(context || 'suggestions');
	const loadingWidgets = e2eVisibleSuggestWidgets(contextLabel, editorSelector)
		.filter(widget => /\bloading\b/i.test((widget.textContent || '').trim()));
	if (loadingWidgets.length) {
		const text = (loadingWidgets[loadingWidgets.length - 1].textContent || '').trim();
		throw new Error(`${contextLabel}: expected no visible loading suggest widget, got ${loadingWidgets.length}: ${text.slice(0, 200)}`);
	}
	return `${contextLabel}: no visible loading suggest widget`;
}

function e2eEditor(kind: E2eSectionKind): MonacoLike {
	const section = e2eSection(kind);
	const boxId = String(section.boxId || section.id || '').trim();
	const editor = boxId ? _win.queryEditors?.[boxId] as MonacoLike | undefined : undefined;
	if (editor) {
		return editor;
	}
	return resolveMonacoEditorFromSelector(E2E_SECTION[kind].editor).editor;
}

function e2eHideSuggest(kind: E2eSectionKind): string {
	const editor = e2eEditor(kind);
	try { editor.trigger?.('keyboard', 'hideSuggestWidget', {}); } catch { /* ignore */ }
	const roots: ParentNode[] = [document];
	try {
		const selectedRoot = deepQuerySelector(document, E2E_SECTION[kind].editor) as ParentNode | null;
		if (selectedRoot) {
			roots.unshift(selectedRoot);
		}
	} catch { /* ignore */ }
	let hiddenCount = 0;
	for (const root of roots) {
		try {
			const widgets = deepQuerySelectorAll(root, '.suggest-widget') as HTMLElement[];
			for (const widget of widgets) {
				widget.classList.add('hidden');
				widget.style.display = 'none';
				hiddenCount++;
			}
		} catch { /* ignore */ }
	}
	return `${kind} suggest hide requested; hidden widgets=${hiddenCount}`;
}

function e2eVisibleSuggestLabels(context: string, editorSelector: string = ''): string[] {
	const contextLabel = String(context || 'suggestions');
	const widgets = e2eVisibleSuggestWidgets(contextLabel, editorSelector);
	e2eAssertNoSuggestLoading(`${contextLabel} loading check`, editorSelector);

	if (widgets.length === 0) {
		throw new Error(`${contextLabel}: expected visible suggest widget`);
	}

	const widget = widgets[widgets.length - 1];
	const widgetText = (widget.textContent || '').trim();
	if (/\bloading\b/i.test(widgetText)) {
		throw new Error(`${contextLabel}: suggest widget is still loading. Text: ${widgetText.slice(0, 200)}`);
	}
	if (/no suggestions/i.test(widgetText)) {
		throw new Error(`${contextLabel}: suggest widget reported no suggestions`);
	}

	const rows = (Array.from(widget.querySelectorAll('.monaco-list-row')) as HTMLElement[])
		.filter(row => e2eIsVisibleElement(row));
	const labels = rows
		.map(row => row.querySelector('.label-name') as HTMLElement | null)
		.filter(labelElement => labelElement ? e2eIsVisibleElement(labelElement) : false)
		.map(labelElement => (labelElement?.textContent || '').trim())
		.filter(Boolean);

	if (labels.length === 0) {
		throw new Error(`${contextLabel}: expected visible suggestions, got 0 labels. Text: ${widgetText.slice(0, 200)}`);
	}

	return labels;
}

function e2eNormalizeSuggestLabel(value: string): string {
	let label = String(value || '').trim();
	label = label.replace(/^(\x1b\[[0-9;]*m)+/g, '');
	label = label.replace(/^(\x00|\[|\(|\{|"|')+/, '').replace(/(\]|\)|\}|"|')+$/, '');
	label = label.split(/[\s,\(:]/g).filter(Boolean)[0] || label;
	return label.trim().toLowerCase();
}

function e2eAssertVisibleSuggestExact(context: string, expectedAnyCsv: string, editorSelector: string = ''): string {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedAnyCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const labels = e2eVisibleSuggestLabels(contextLabel, editorSelector);
	if (expected.length) {
		const normalizedLabels = labels.map(label => e2eNormalizeSuggestLabel(label));
		const matched = expected.some(candidate => normalizedLabels.includes(e2eNormalizeSuggestLabel(candidate)));
		if (!matched) {
			throw new Error(`${contextLabel}: expected exact one of [${expected.join(', ')}], got: ${labels.slice(0, 20).join(', ')}`);
		}
	}
	return `${contextLabel}(${labels.length}): ${labels.slice(0, 15).join(', ')}`;
}

function e2eAutoTriggerToggle(kind: E2eSectionKind = 'sql'): HTMLElement {
	const toolbarSelector = kind === 'sql' ? 'kw-sql-toolbar' : 'kw-query-toolbar';
	const toggle = document.querySelector(`${toolbarSelector} .qe-auto-autocomplete-toggle`) as HTMLElement | null;
	if (!toggle) {
		throw new Error(`${kind} auto-trigger toggle not found`);
	}
	return toggle;
}

function e2eAssertAutoTriggerToggleVisible(kind: E2eSectionKind): string {
	const toggle = e2eAutoTriggerToggle(kind);
	const rect = toggle.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) {
		throw new Error(`${kind} auto-trigger toggle has zero dimensions`);
	}
	return `${kind} auto-trigger toggle visible: ${rect.width}x${rect.height}`;
}

function e2eClickAutoTriggerToggle(kind: E2eSectionKind): string {
	e2eAutoTriggerToggle(kind).click();
	return `${kind} auto-trigger toggle clicked`;
}

function e2eAssertAutoTriggerEnabled(expected: boolean): string {
	if (typeof _win.autoTriggerAutocompleteEnabled !== 'boolean') {
		throw new Error('autoTriggerAutocompleteEnabled not found');
	}
	if (_win.autoTriggerAutocompleteEnabled !== expected) {
		throw new Error(`autoTriggerAutocompleteEnabled expected ${expected}, got ${_win.autoTriggerAutocompleteEnabled}`);
	}
	return `autoTriggerAutocompleteEnabled=${_win.autoTriggerAutocompleteEnabled}`;
}

function e2eEnsureAutoTriggerEnabled(kind: E2eSectionKind, expected: boolean): string {
	if (typeof _win.autoTriggerAutocompleteEnabled !== 'boolean') {
		throw new Error('autoTriggerAutocompleteEnabled not found');
	}
	if (_win.autoTriggerAutocompleteEnabled !== expected) {
		e2eClickAutoTriggerToggle(kind);
	}
	return e2eAssertAutoTriggerEnabled(expected);
}

function e2eKustoSchema(): any {
	const section = e2eSection('kusto');
	const boxId = String(section.boxId || section.id || '').trim();
	const schema = boxId ? _win.schemaByBoxId?.[boxId] : null;
	if (!schema) {
		const allKeys = _win.schemaByBoxId ? Object.keys(_win.schemaByBoxId) : [];
		throw new Error(`No Kusto schema for boxId=${boxId} (keys: ${allKeys.join(',')})`);
	}
	return schema;
}

function e2eIdentifierNames(values: string[]): string[] {
	return values
		.map(value => String(value || '').trim())
		.filter(value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));
}

function e2eUniquePrefix(value: string, allValues: string[], minimumLength: number = 3): string {
	const normalized = String(value || '');
	for (let length = Math.min(Math.max(minimumLength, 1), normalized.length); length <= normalized.length; length++) {
		const prefix = normalized.slice(0, length);
		const matches = allValues.filter(candidate => String(candidate || '').toLowerCase().startsWith(prefix.toLowerCase()));
		if (matches.length === 1) {
			return prefix;
		}
	}
	return normalized;
}

function e2ePickColumn(columns: string[], columnTypes: Record<string, string>, typePattern: RegExp, fallback: string): string {
	return columns.find(column => typePattern.test(String(columnTypes[column] || ''))) || fallback;
}

function e2ePrepareKustoCompletionTargets(): string {
	const schema = e2eKustoSchema();
	const tableNames = e2eIdentifierNames(Array.isArray(schema.tables) ? schema.tables : Object.keys(schema.columnTypesByTable || {}));
	const columnTypesByTable = schema.columnTypesByTable && typeof schema.columnTypesByTable === 'object'
		? schema.columnTypesByTable as Record<string, Record<string, string>>
		: {};
	const preferredTables = ['StormEvents', 'RawEventsADS', 'PopulationData'];
	const rankedTables = [
		...preferredTables.filter(table => tableNames.some(candidate => candidate.toLowerCase() === table.toLowerCase())),
		...tableNames,
	];
	const table = rankedTables.find(candidate => {
		const columns = e2eIdentifierNames(Object.keys(columnTypesByTable[candidate] || {}));
		return columns.length >= 3;
	});
	if (!table) {
		throw new Error(`No Kusto table with at least 3 identifier columns. Tables: ${tableNames.slice(0, 20).join(', ')}`);
	}

	const columnTypes = columnTypesByTable[table] || {};
	const columns = e2eIdentifierNames(Object.keys(columnTypes));
	if (columns.length < 3) {
		throw new Error(`Kusto table ${table} has too few identifier columns: ${columns.join(', ')}`);
	}

	const fallbackColumn = columns[0];
	const stringColumn = e2ePickColumn(columns, columnTypes, /string/i, fallbackColumn);
	const numericColumn = e2ePickColumn(columns, columnTypes, /int|long|real|decimal|double/i, fallbackColumn);
	const dateColumn = e2ePickColumn(columns, columnTypes, /date|time/i, fallbackColumn);
	const column = stringColumn || numericColumn || dateColumn || fallbackColumn;
	const targets: KustoCompletionTargets = {
		table,
		tablePrefix: e2eUniquePrefix(table, tableNames, 3),
		column,
		columnPrefix: e2eUniquePrefix(column, columns, 2),
		stringColumn,
		numericColumn,
		dateColumn,
		expectedByScenario: {
			'table-prefix': [table],
			'pipe-operators': ['where', 'project', 'summarize', 'take'],
			'project-columns': [column],
			'where-columns': [column],
			'summarize-functions': ['dcount'],
			'extend-functions': ['tostring', 'todouble', 'todatetime', 'tolower'],
		},
	};
	_win.__e2eKustoCompletionTargets = targets;
	return `kusto completion targets: table=${targets.table} tablePrefix=${targets.tablePrefix} column=${targets.column} columnPrefix=${targets.columnPrefix} string=${targets.stringColumn} numeric=${targets.numericColumn} date=${targets.dateColumn}`;
}

function e2eKustoCompletionTargets(): KustoCompletionTargets {
	const targets = _win.__e2eKustoCompletionTargets as KustoCompletionTargets | undefined;
	if (!targets) {
		e2ePrepareKustoCompletionTargets();
	}
	const nextTargets = _win.__e2eKustoCompletionTargets as KustoCompletionTargets | undefined;
	if (!nextTargets) {
		throw new Error('Kusto completion targets were not prepared');
	}
	return nextTargets;
}

async function e2eWaitForKustoCompletionTargets(timeoutMs: number = 25000): Promise<string> {
	const started = performance.now();
	let lastError: unknown;
	while (performance.now() - started <= timeoutMs) {
		try {
			return e2ePrepareKustoCompletionTargets();
		} catch (error) {
			lastError = error;
			await e2eDelay(500);
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError || 'timed out');
	throw new Error(`Kusto schema completion targets not ready after ${timeoutMs}ms: ${message}`);
}

function e2eSetKustoCompletionTargetProbeState(status: string, message: string = ''): void {
	try {
		const section = e2eSection('kusto') as HTMLElement;
		section.dataset.testCompletionTargetsStatus = status;
		section.dataset.testCompletionTargetsReady = status === 'ready' ? 'true' : 'false';
		section.dataset.testCompletionTargetsMessage = message;
	} catch { /* ignore */ }
}

function e2eStartKustoCompletionTargetProbe(timeoutMs: number = 25000): string {
	try {
		const previous = _win.__e2eKustoCompletionTargetProbeTimer;
		if (previous) {
			clearInterval(previous);
			_win.__e2eKustoCompletionTargetProbeTimer = null;
		}
	} catch { /* ignore */ }

	e2eSetKustoCompletionTargetProbeState('waiting');
	const started = performance.now();
	let lastMessage = '';
	const probe = () => {
		try {
			const result = e2ePrepareKustoCompletionTargets();
			try {
				if (_win.__e2eKustoCompletionTargetProbeTimer) {
					clearInterval(_win.__e2eKustoCompletionTargetProbeTimer);
					_win.__e2eKustoCompletionTargetProbeTimer = null;
				}
			} catch { /* ignore */ }
			e2eSetKustoCompletionTargetProbeState('ready', result);
		} catch (error) {
			lastMessage = error instanceof Error ? error.message : String(error || 'not ready');
			if (performance.now() - started > timeoutMs) {
				try {
					if (_win.__e2eKustoCompletionTargetProbeTimer) {
						clearInterval(_win.__e2eKustoCompletionTargetProbeTimer);
						_win.__e2eKustoCompletionTargetProbeTimer = null;
					}
				} catch { /* ignore */ }
				e2eSetKustoCompletionTargetProbeState('error', lastMessage);
			}
		}
	};
	probe();
	try {
		if (!_win.__e2eKustoCompletionTargets) {
			_win.__e2eKustoCompletionTargetProbeTimer = setInterval(probe, 500);
		}
	} catch { /* ignore */ }
	return `kusto completion target probe started (${timeoutMs}ms)`;
}

function e2eAssertKustoCompletionTargetsReady(): string {
	const section = e2eSection('kusto') as HTMLElement;
	const status = section.dataset.testCompletionTargetsStatus || '';
	const message = section.dataset.testCompletionTargetsMessage || '';
	if (status !== 'ready') {
		throw new Error(`Kusto completion targets not ready: status=${status || '(missing)'} message=${message}`);
	}
	return message || e2ePrepareKustoCompletionTargets();
}

function e2eSetKustoCompletionContext(scenario: KustoCompletionScenario): string {
	const targets = e2eKustoCompletionTargets();
	const table = targets.table;
	const column = targets.column;
	let text = '';
	let lineNumber = 1;
	let columnNumber = 1;

	if (scenario === 'table-prefix') {
		text = targets.tablePrefix;
		lineNumber = 1;
		columnNumber = targets.tablePrefix.length + 1;
	} else if (scenario === 'pipe-operators') {
		text = `${table}\n| `;
		lineNumber = 2;
		columnNumber = 3;
	} else if (scenario === 'project-columns') {
		text = `${table}\n| project ${targets.columnPrefix}`;
		lineNumber = 2;
		columnNumber = `| project ${targets.columnPrefix}`.length + 1;
	} else if (scenario === 'where-columns') {
		text = `${table}\n| where ${targets.columnPrefix}`;
		lineNumber = 2;
		columnNumber = `| where ${targets.columnPrefix}`.length + 1;
	} else if (scenario === 'summarize-functions') {
		text = `${table}\n| summarize dc`;
		lineNumber = 2;
		columnNumber = '| summarize dc'.length + 1;
	} else if (scenario === 'extend-functions') {
		text = `${table}\n| extend computedValue = to`;
		lineNumber = 2;
		columnNumber = '| extend computedValue = to'.length + 1;
	} else if (scenario === 'valid-query') {
		text = `${table}\n| project ${column}\n| take 5`;
		lineNumber = 3;
		columnNumber = '| take 5'.length + 1;
	} else {
		throw new Error(`Unknown Kusto completion scenario: ${scenario}`);
	}

	_win.__e2e.kusto.setQueryAt(text, lineNumber, columnNumber);
	try {
		const editor = e2eEditor('kusto') as any;
		if (editor.__kustoAutoSuggestTimer) {
			clearTimeout(editor.__kustoAutoSuggestTimer);
			editor.__kustoAutoSuggestTimer = null;
		}
	} catch { /* ignore */ }
	return `kusto completion context ${scenario}: ${JSON.stringify(text)}`;
}

async function e2eWaitForSuggest(kind: E2eSectionKind, context: string, expectedAnyCsv: string, timeoutMs: number, exact: boolean = false): Promise<{ elapsedMs: number; result: string }> {
	const editor = e2eEditor(kind);
	const started = performance.now();
	try { editor.trigger?.('keyboard', 'editor.action.triggerSuggest', {}); } catch { /* fallback below */ }
	return e2eWaitForExistingSuggest(kind, context, expectedAnyCsv, timeoutMs, exact, started);
}

async function e2eWaitForExistingSuggest(kind: E2eSectionKind, context: string, expectedAnyCsv: string, timeoutMs: number, exact: boolean = false, started: number = performance.now()): Promise<{ elapsedMs: number; result: string }> {
	let lastError: unknown;
	while (performance.now() - started <= timeoutMs) {
		try {
			const result = exact
				? e2eAssertVisibleSuggestExact(context, expectedAnyCsv, E2E_SECTION[kind].editor)
				: _win.__testAssertVisibleSuggest(context, expectedAnyCsv, E2E_SECTION[kind].editor);
			e2eAssertNoSuggestLoading(`${context} loading check`, E2E_SECTION[kind].editor);
			return { elapsedMs: performance.now() - started, result };
		} catch (error) {
			lastError = error;
			await e2eDelay(50);
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError || 'timed out');
	throw new Error(`${context}: no matching suggestions within ${timeoutMs}ms: ${message}`);
}

async function e2eAssertSuggestStaysVisible(kind: E2eSectionKind, context: string, expectedAnyCsv: string, durationMs: number = 1000, exact: boolean = false): Promise<string> {
	const expected = String(expectedAnyCsv || '').split(',').map(value => value.trim()).filter(Boolean).join(',');
	const started = performance.now();
	let checks = 0;
	let latest = '';
	while (performance.now() - started <= durationMs) {
		latest = exact
			? e2eAssertVisibleSuggestExact(context, expected, E2E_SECTION[kind].editor)
			: _win.__testAssertVisibleSuggest(context, expected, E2E_SECTION[kind].editor);
		e2eAssertNoSuggestLoading(`${context} loading check`, E2E_SECTION[kind].editor);
		checks++;
		await e2eDelay(100);
	}
	latest = exact
		? e2eAssertVisibleSuggestExact(context, expected, E2E_SECTION[kind].editor)
		: _win.__testAssertVisibleSuggest(context, expected, E2E_SECTION[kind].editor);
	e2eAssertNoSuggestLoading(`${context} final loading check`, E2E_SECTION[kind].editor);
	return `${latest}; stayed visible for ${Math.round(performance.now() - started)}ms (${checks + 1} checks)`;
}

async function e2eAssertSuggestLatency(kind: E2eSectionKind, context: string, expectedAnyCsv: string, maxMs: number = 3000, exact: boolean = false): Promise<string> {
	const expected = String(expectedAnyCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const result = await e2eWaitForSuggest(kind, context, expected.join(','), maxMs, exact);
	if (result.elapsedMs > maxMs) {
		throw new Error(`${context}: suggestions took ${Math.round(result.elapsedMs)}ms, expected <= ${maxMs}ms`);
	}
	await e2eDelay(250);
	const stableResult = exact
		? e2eAssertVisibleSuggestExact(`${context} stable`, expected.join(','), E2E_SECTION[kind].editor)
		: _win.__testAssertVisibleSuggest(`${context} stable`, expected.join(','), E2E_SECTION[kind].editor);
	return `${result.result}; ${stableResult}; latency=${Math.round(result.elapsedMs)}ms <= ${maxMs}ms`;
}

async function e2eAssertRepeatedSuggestLatency(kind: E2eSectionKind, scenario: KustoCompletionScenario, runs: number = 5, maxSingleMs: number = 3000, maxAverageMs: number = 1500): Promise<string> {
	const targets = e2eKustoCompletionTargets();
	const expected = (targets.expectedByScenario[scenario] || []).join(',');
	const timings: number[] = [];
	for (let runIndex = 0; runIndex < runs; runIndex++) {
		e2eHideSuggest(kind);
		await e2eDelay(120);
		e2eSetKustoCompletionContext(scenario);
		const result = await e2eWaitForSuggest(kind, `${scenario} run ${runIndex + 1}`, expected, maxSingleMs, true);
		if (result.elapsedMs > maxSingleMs) {
			throw new Error(`${scenario} run ${runIndex + 1}: ${Math.round(result.elapsedMs)}ms > ${maxSingleMs}ms`);
		}
		await e2eAssertSuggestStaysVisible(kind, `${scenario} run ${runIndex + 1} settled`, expected, 350, true);
		timings.push(result.elapsedMs);
	}
	const average = timings.reduce((total, value) => total + value, 0) / Math.max(1, timings.length);
	if (average > maxAverageMs) {
		throw new Error(`${scenario}: average suggest latency ${Math.round(average)}ms > ${maxAverageMs}ms (${timings.map(value => Math.round(value)).join(', ')}ms)`);
	}
	return `${scenario} repeated latency ok: avg=${Math.round(average)}ms single=[${timings.map(value => Math.round(value)).join(',')}] thresholds single<=${maxSingleMs} avg<=${maxAverageMs}`;
}

function e2eAssertKustoCompletionVisible(scenario: KustoCompletionScenario): string {
	const targets = e2eKustoCompletionTargets();
	const expected = (targets.expectedByScenario[scenario] || []).join(',');
	return e2eAssertVisibleSuggestExact(`kusto ${scenario}`, expected, E2E_SECTION.kusto.editor);
}

async function e2eAssertKustoCompletionStaysVisible(scenario: KustoCompletionScenario, durationMs: number = 1000): Promise<string> {
	const targets = e2eKustoCompletionTargets();
	const expected = (targets.expectedByScenario[scenario] || []).join(',');
	return e2eAssertSuggestStaysVisible('kusto', `kusto ${scenario} persistent`, expected, durationMs, true);
}

async function e2eAssertKustoAutoTriggered(scenario: KustoCompletionScenario, timeoutMs: number = 3000): Promise<string> {
	const targets = e2eKustoCompletionTargets();
	const expected = (targets.expectedByScenario[scenario] || []).join(',');
	const result = await e2eWaitForExistingSuggest('kusto', `kusto ${scenario} auto-trigger`, expected, timeoutMs, true);
	return `${result.result}; auto-trigger latency=${Math.round(result.elapsedMs)}ms <= ${timeoutMs}ms`;
}

async function e2eAssertKustoCompletionLatency(scenario: KustoCompletionScenario, maxMs: number = 3000): Promise<string> {
	const targets = e2eKustoCompletionTargets();
	const expected = (targets.expectedByScenario[scenario] || []).join(',');
	return e2eAssertSuggestLatency('kusto', `kusto ${scenario}`, expected, maxMs, true);
}

function e2eAcceptKustoSuggestion(scenario: KustoCompletionScenario): string {
	const editor = e2eEditor('kusto');
	try { editor.trigger?.('keyboard', 'acceptSelectedSuggestion', {}); } catch (error) {
		throw new Error(`Kusto accept suggestion failed for ${scenario}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return `kusto accepted suggestion for ${scenario}`;
}

function e2eAssertAcceptedKustoCompletion(scenario: KustoCompletionScenario): string {
	const targets = e2eKustoCompletionTargets();
	const value = String(e2eEditor('kusto').getValue?.() || '');
	if (scenario === 'table-prefix' && !value.startsWith(targets.table)) {
		throw new Error(`Expected accepted table completion ${targets.table}, got ${JSON.stringify(value)}`);
	}
	if ((scenario === 'project-columns' || scenario === 'where-columns') && !new RegExp(`\\b${targets.column}\\b`, 'i').test(value)) {
		throw new Error(`Expected accepted column completion ${targets.column}, got ${JSON.stringify(value)}`);
	}
	if (scenario === 'pipe-operators' && !/\|\s+(where|project|summarize|take)\b/i.test(value)) {
		throw new Error(`Expected accepted pipe operator completion, got ${JSON.stringify(value)}`);
	}
	return `kusto accepted ${scenario}: ${JSON.stringify(value)}`;
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
		prepareCompletionTargets: () => e2ePrepareKustoCompletionTargets(),
		waitForCompletionTargets: (timeoutMs: number = 25000) => e2eWaitForKustoCompletionTargets(timeoutMs),
		startCompletionTargetProbe: (timeoutMs: number = 25000) => e2eStartKustoCompletionTargetProbe(timeoutMs),
		assertCompletionTargetsReady: () => e2eAssertKustoCompletionTargetsReady(),
		setCompletionContext: (scenario: KustoCompletionScenario) => e2eSetKustoCompletionContext(scenario),
		assertCompletionVisible: (scenario: KustoCompletionScenario) => e2eAssertKustoCompletionVisible(scenario),
		assertCompletionStaysVisible: (scenario: KustoCompletionScenario, durationMs: number = 1000) => e2eAssertKustoCompletionStaysVisible(scenario, durationMs),
		assertAutoTriggered: (scenario: KustoCompletionScenario, timeoutMs: number = 3000) => e2eAssertKustoAutoTriggered(scenario, timeoutMs),
		assertCompletionLatency: (scenario: KustoCompletionScenario, maxMs: number = 3000) => e2eAssertKustoCompletionLatency(scenario, maxMs),
		assertRepeatedSuggestLatency: (scenario: KustoCompletionScenario, runs: number = 5, maxSingleMs: number = 3000, maxAverageMs: number = 1500) => e2eAssertRepeatedSuggestLatency('kusto', scenario, runs, maxSingleMs, maxAverageMs),
		acceptSuggestion: (scenario: KustoCompletionScenario) => e2eAcceptKustoSuggestion(scenario),
		assertAcceptedCompletion: (scenario: KustoCompletionScenario) => e2eAssertAcceptedKustoCompletion(scenario),
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
			hide: () => e2eHideSuggest('kusto'),
			trigger: () => _win.__e2e.kusto.triggerSuggest(),
			assertVisible: (context: string, expectedAnyCsv: string = '') => _win.__e2e.kusto.assertSuggestions(context, expectedAnyCsv),
			assertHidden: (context: string) => e2eAssertNoVisibleSuggest(context),
		},
	},
	autoTrigger: {
		assertSqlToggleVisible: () => {
			return e2eAssertAutoTriggerToggleVisible('sql');
		},
		assertEnabled: (expected: boolean) => {
			return e2eAssertAutoTriggerEnabled(expected);
		},
		clickSqlToggle: () => {
			return e2eClickAutoTriggerToggle('sql');
		},
		assertToggleVisible: (kind: E2eSectionKind) => e2eAssertAutoTriggerToggleVisible(kind),
		clickToggle: (kind: E2eSectionKind) => e2eClickAutoTriggerToggle(kind),
		ensureEnabled: (kind: E2eSectionKind, expected: boolean) => e2eEnsureAutoTriggerEnabled(kind, expected),
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
