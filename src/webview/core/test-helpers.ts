// E2E test helpers — shadow-piercing element lookup by data-testid.
// These are zero-cost in production (no logic runs until called).
// Used by the vscode-ext-test E2E framework via `When I evaluate`.

import { postMessageToHost } from '../shared/webview-messages.js';
import { beginKustoPreparation, getKustoPreparationState, isSchemaEnhancementReady, isSchemaWorkerReady, markSchemaEnhancementReady, markSchemaWorkerReady, requestKustoSchemaApplyForBox, setActiveMonacoEditor, sqlTargetGenerationByBoxId } from './state.js';
import { pState } from '../shared/persistence-state.js';
import { perfSnapshot } from './perf.js';
import { getPageScrollElement, getPageScrollMaxTop, getPageScrollTop, setPageScrollTop } from './utils.js';
import { __kustoFindSuggestWidgetForEditor } from '../monaco/suggest.js';
import { __kustoCrossClusterSchemas, __kustoGetSupplementalSchemaSnapshot, __kustoInjectSupplementalSchemaForTest, __kustoSchemaTracker, __kustoTraceCrossCluster } from '../monaco/monaco.js';
import { kustoSupplementalTraceId } from '../shared/kusto-supplemental-schema-coordinator.js';
import { extractCrossClusterRefs } from '../shared/cross-cluster-schema.js';
import { computeMissingClusterUrls } from '../shared/clusterUtils.js';
import { kustoClusterKey } from '../../shared/kustoClusterUrls.js';
import { getKustoSchemaIdentityKey } from '../../shared/kustoAuth.js';
import { displayResultForBox, getResultsState } from './results-state.js';
import { adoptCurrentStateAsCleanForTest, isPersistenceSuppressedForTest } from './persistence.js';

type MonacoLike = {
	getDomNode?: () => HTMLElement | null;
	focus?: () => void;
	layout?: () => void;
	hasTextFocus?: () => boolean;
	hasWidgetFocus?: () => boolean;
	getValue?: () => string;
	setValue?: (value: string) => void;
	getModel?: () => {
		getLineCount?: () => number;
		getLineMaxColumn?: (lineNumber: number) => number;
		getLanguageId?: () => string;
		getValueInRange?: (range: unknown) => string;
		getAllDecorations?: () => Array<{ range: unknown; options?: { className?: string } }>;
		uri?: { toString(): string };
	} | null;
	getOptions?: () => { get?: (option: any) => any };
	getPosition?: () => { lineNumber: number; column: number } | null;
	getTargetAtClientPoint?: (clientX: number, clientY: number) => { type?: number | string; position?: { lineNumber: number; column: number } | null } | null;
	getScrolledVisiblePosition?: (position: { lineNumber: number; column: number }) => { top: number; left: number; height: number } | null;
	render?: (forceRedraw?: boolean) => void;
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
function splitSelectorOnTopLevelWhitespace(selector: string): string[] {
	const parts: string[] = [];
	let current = '';
	let quote: string | null = null;
	let bracketDepth = 0;
	let parenDepth = 0;
	let escaping = false;

	for (const char of selector) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === '\\') {
			current += char;
			escaping = true;
			continue;
		}
		if (quote) {
			current += char;
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === '[') bracketDepth++;
		else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
		else if (char === '(') parenDepth++;
		else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);

		if (/\s/.test(char) && bracketDepth === 0 && parenDepth === 0) {
			const trimmed = current.trim();
			if (trimmed) parts.push(trimmed);
			current = '';
			continue;
		}
		current += char;
	}

	const trimmed = current.trim();
	if (trimmed) parts.push(trimmed);
	return parts;
}

function deepQuerySelectorAcrossShadowPath(root: ParentNode, selector: string): Element | null {
	const parts = splitSelectorOnTopLevelWhitespace(selector);
	for (let splitIndex = 1; splitIndex < parts.length; splitIndex++) {
		const hostSelector = parts.slice(0, splitIndex).join(' ');
		const descendantSelector = parts.slice(splitIndex).join(' ');
		let hosts: Element[] = [];
		try {
			hosts = Array.from(root.querySelectorAll(hostSelector));
		} catch {
			continue;
		}
		for (const host of hosts) {
			if (!host.shadowRoot) continue;
			const found = deepQuerySelector(host.shadowRoot, descendantSelector);
			if (found) return found;
		}
	}
	return null;
}

function deepQuerySelector(root: ParentNode, selector: string): Element | null {
	try {
		const direct = root.querySelector(selector);
		if (direct) return direct;
	} catch { /* invalid selector for this root */ }

	const acrossShadowPath = deepQuerySelectorAcrossShadowPath(root, selector);
	if (acrossShadowPath) return acrossShadowPath;

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

function e2eEnableIsolatedKustoConnections(): string {
	_win.__e2eIsolatedKustoConnections = true;
	try { if (Array.isArray(_win.connections)) _win.connections.length = 0; } catch { /* ignore */ }
	try { if (Array.isArray(_win.kustoFavorites)) _win.kustoFavorites.length = 0; } catch { /* ignore */ }
	try { if (_win.cachedDatabases && typeof _win.cachedDatabases === 'object') { for (const key of Object.keys(_win.cachedDatabases)) delete _win.cachedDatabases[key]; } } catch { /* ignore */ }
	return 'isolated Kusto connections enabled';
}

function e2eAssertIsolatedKustoConnections(): string {
	const connectionCount = Array.isArray(_win.connections) ? _win.connections.length : 0;
	const favoriteCount = Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites.length : 0;
	const cachedDatabaseCount = _win.cachedDatabases && typeof _win.cachedDatabases === 'object' ? Object.keys(_win.cachedDatabases).length : 0;
	if (_win.__e2eIsolatedKustoConnections !== true || connectionCount || favoriteCount || cachedDatabaseCount) {
		throw new Error(`isolated Kusto connections not clean: enabled=${_win.__e2eIsolatedKustoConnections === true}; connections=${connectionCount}; favorites=${favoriteCount}; cachedDatabases=${cachedDatabaseCount}`);
	}
	return 'isolated Kusto connections are clean';
}
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


function e2eGetEditorBoxId(editor: MonacoLike): string {
	try {
		const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
		const uri = model?.uri?.toString?.();
		if (uri && _win.queryEditorBoxByModelUri?.[uri]) {
			return String(_win.queryEditorBoxByModelUri[uri]);
		}
	} catch { /* ignore */ }
	try {
		for (const [boxId, knownEditor] of Object.entries(_win.queryEditors || {})) {
			if (knownEditor === editor) {
				return String(boxId);
			}
		}
	} catch { /* ignore */ }
	return '';
}

_win.__testTriggerMonaco = (selector: string, handlerId: string, payload: any = {}): string => {
	const focusResult = _win.__testFocusMonaco(selector);
	const { editor } = resolveMonacoEditorFromSelector(selector);
	if (typeof editor.trigger !== 'function') {
		throw new Error(`monaco trigger unavailable for: ${selector}`);
	}
	const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
	const language = typeof model?.getLanguageId === 'function' ? model.getLanguageId() : '';
	const isKustoSuggest = handlerId === 'editor.action.triggerSuggest' && language === 'kusto';
	if (isKustoSuggest && typeof _win.__kustoTriggerAutocompleteForBoxId === 'function') {
		const boxId = e2eGetEditorBoxId(editor);
		if (boxId) {
			_win.__kustoTriggerAutocompleteForBoxId(boxId);
			return `${focusResult}; triggered gated kusto suggest for ${boxId}`;
		}
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

_win.__testAssertMonacoDiagnosticVisible = (selector: string, expectedText: string, expectedMessage: string = '', owner: string = 'kusto'): string => {
	const { editor, editorRoot } = resolveMonacoEditorFromSelector(selector);
	const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
	if (!model?.uri) {
		throw new Error(`monaco model unavailable for diagnostic visibility check: ${selector}`);
	}
	if (typeof model.getValueInRange !== 'function' || typeof model.getAllDecorations !== 'function') {
		throw new Error(`monaco model diagnostic decoration APIs unavailable for: ${selector}`);
	}
	const getValueInRange = model.getValueInRange.bind(model);
	const getAllDecorations = model.getAllDecorations.bind(model);
	const monacoApi = _win.monaco;
	if (!monacoApi?.editor?.getModelMarkers) {
		throw new Error('monaco.editor.getModelMarkers unavailable');
	}
	const markerText = String(expectedText || '');
	const messageText = String(expectedMessage || '');
	const markers = monacoApi.editor.getModelMarkers({ owner, resource: model.uri }) || [];
	const marker = markers.find((candidate: any) => {
		if (candidate.severity !== monacoApi.MarkerSeverity?.Error) return false;
		if (messageText && !String(candidate.message || '').includes(messageText)) return false;
		const text = getValueInRange({
			startLineNumber: candidate.startLineNumber,
			startColumn: candidate.startColumn,
			endLineNumber: candidate.endLineNumber,
			endColumn: candidate.endColumn,
		});
		return text === markerText;
	});
	if (!marker) {
		throw new Error(`Expected ${owner} error marker over ${JSON.stringify(markerText)} for ${selector}, got ${JSON.stringify(markers.map((candidate: any) => ({ message: candidate.message, startLineNumber: candidate.startLineNumber, startColumn: candidate.startColumn, endLineNumber: candidate.endLineNumber, endColumn: candidate.endColumn })))}`);
	}
	const range = {
		startLineNumber: marker.startLineNumber,
		startColumn: marker.startColumn,
		endLineNumber: marker.endLineNumber,
		endColumn: marker.endColumn,
	};
	const decorations = getAllDecorations().filter((decoration: any) => decoration.options?.className === 'squiggly-error');
	const matchingDecoration = decorations.find((decoration: any) => getValueInRange(decoration.range) === markerText);
	if (!matchingDecoration) {
		throw new Error(`Expected squiggly-error model decoration over ${JSON.stringify(markerText)}, got ${JSON.stringify(decorations.map((decoration: any) => ({ range: decoration.range, text: getValueInRange(decoration.range), className: decoration.options?.className })))}`);
	}
	const root = editorRoot.matches('.monaco-editor') ? editorRoot : editorRoot.querySelector('.monaco-editor') as HTMLElement | null;
	if (!root) {
		throw new Error(`monaco editor root unavailable for diagnostic visibility check: ${selector}`);
	}
	const startPosition = editor.getScrolledVisiblePosition?.({ lineNumber: range.startLineNumber, column: range.startColumn });
	const endPosition = editor.getScrolledVisiblePosition?.({ lineNumber: range.endLineNumber, column: range.endColumn });
	if (!startPosition || !endPosition) {
		throw new Error(`marker range is not visible for ${JSON.stringify(markerText)} in ${selector}`);
	}
	const rootRect = root.getBoundingClientRect();
	const expectedLeft = rootRect.left + Math.min(startPosition.left, endPosition.left) - 2;
	const expectedRight = rootRect.left + Math.max(startPosition.left, endPosition.left) + 2;
	const expectedTop = rootRect.top + Math.min(startPosition.top, endPosition.top) - 2;
	const expectedBottom = rootRect.top + Math.max(startPosition.top + startPosition.height, endPosition.top + endPosition.height) + 6;
	const squiggles = Array.from(root.querySelectorAll('.cdr.squiggly-error')) as HTMLElement[];
	const visibleSquiggle = squiggles.find((node) => {
		const rect = node.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return false;
		const overlapsTarget = rect.right >= expectedLeft && rect.left <= expectedRight && rect.bottom >= expectedTop && rect.top <= expectedBottom;
		if (!overlapsTarget) return false;
		const style = getComputedStyle(node);
		const hasBorder = style.borderBottomStyle !== 'none' && parseFloat(style.borderBottomWidth || '0') > 0 && style.borderBottomColor !== 'transparent' && !style.borderBottomColor.endsWith(', 0)');
		const hasBackground = !!style.backgroundImage && style.backgroundImage !== 'none';
		return hasBorder || hasBackground;
	});
	if (!visibleSquiggle) {
		throw new Error(`Expected visible squiggly-error DOM over ${JSON.stringify(markerText)}, got ${JSON.stringify(squiggles.map((node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), borderBottomStyle: style.borderBottomStyle, borderBottomWidth: style.borderBottomWidth, borderBottomColor: style.borderBottomColor, backgroundImage: style.backgroundImage === 'none' ? 'none' : 'set' }; }))}`);
	}
	const visibleRect = visibleSquiggle.getBoundingClientRect();
	return `visible ${owner} diagnostic over ${JSON.stringify(markerText)} at ${range.startLineNumber}:${range.startColumn}-${range.endColumn}; squiggle=${Math.round(visibleRect.x)},${Math.round(visibleRect.y)} ${Math.round(visibleRect.width)}x${Math.round(visibleRect.height)}`;
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

async function e2eSelectDifferentKustoDatabase(): Promise<string> {
	const section = document.querySelector('kw-query-section') as any;
	if (!section) throw new Error('Kusto section not found');
	const current = String(section.getDatabase?.() || '').trim().toLowerCase();
	const dropdownSelector = "kw-query-section .select-wrapper[title='Kusto Database'] kw-dropdown";
	const dropdown = deepQuerySelector(document, dropdownSelector) as any;
	const root = dropdown?.shadowRoot;
	const button = root?.querySelector('.kusto-dropdown-btn') as HTMLElement | null;
	if (!dropdown || !root || !button) throw new Error('Kusto database dropdown is unavailable');
	button.click();
	if (dropdown.updateComplete && typeof dropdown.updateComplete.then === 'function') await dropdown.updateComplete;
	const items = Array.from(root.querySelectorAll('.kusto-dropdown-item[role="option"]')) as HTMLElement[];
	const alternate = items.find(item => {
		const id = String(item.getAttribute('data-id') || '').trim().toLowerCase();
		const label = String(item.textContent || '').trim().toLowerCase();
		return !!label && label !== current && id !== current;
	});
	if (!alternate) {
		throw new Error(`No alternate Kusto database found. Current=${current}; available=${items.map(item => String(item.textContent || '').trim()).join(', ')}`);
	}
	const label = String(alternate.textContent || '').trim();
	alternate.click();
	if (dropdown.updateComplete && typeof dropdown.updateComplete.then === 'function') await dropdown.updateComplete;
	return `switched database from ${current || '(none)'} to ${label}`;
}

async function e2eSelectSampleKustoDatabase(sectionIndex: number = 0): Promise<string> {
	const sectionSelector = `kw-query-section:nth-of-type(${sectionIndex + 1})`;
	return _win.__testSelectKwDropdownItem(`${sectionSelector} .select-wrapper[title='Kusto Database'] kw-dropdown`, 'sample,storm,ads,devcli', true);
}

function e2eKustoSchemaIdentityForSection(section: any): { connectionId: string; accountPartition: string; clusterUrl: string; database: string; schemaKey: string } {
	const connectionId = String(section?.getConnectionId?.() || '').trim();
	const clusterUrl = String(section?.getClusterUrl?.() || '').trim();
	const database = String(section?.getDatabase?.() || '').trim();
	const connection = (_win.connections || []).find((candidate: any) => String(candidate?.id || '') === connectionId);
	const accountPartition = String(connection?.accountPartition || '').trim();
	const schemaKey = getKustoSchemaIdentityKey(connectionId, accountPartition, clusterUrl, database);
	return { connectionId, accountPartition, clusterUrl, database, schemaKey };
}

function e2eAssertKustoPreparationReady(sectionIndex: number = 0): string {
	const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
	const section = sections[sectionIndex];
	if (!section) throw new Error(`Kusto section ${sectionIndex} not found`);
	const boxId = String(section.boxId || section.id || '');
	const { database, schemaKey } = e2eKustoSchemaIdentityForSection(section);
	const editor = (window as any).queryEditors?.[boxId];
	const modelUri = String(editor?.getModel?.()?.uri?.toString?.() || '');
	const preparation = getKustoPreparationState(boxId);
	if (preparation.status !== 'ready') throw new Error(`Preparation is ${preparation.status}/${preparation.stage}`);
	if (preparation.target.database !== database || preparation.target.schemaKey !== schemaKey || preparation.target.modelUri !== modelUri) {
		throw new Error(`Preparation target mismatch for section ${sectionIndex}: expectedSchemaId=${kustoSupplementalTraceId(schemaKey)} expectedModelId=${kustoSupplementalTraceId(modelUri)} actualSchemaId=${kustoSupplementalTraceId(String(preparation.target.schemaKey || ''))} actualModelId=${kustoSupplementalTraceId(String(preparation.target.modelUri || ''))}`);
	}
	if (!isSchemaWorkerReady(boxId, schemaKey, modelUri)) throw new Error(`Worker is not ready for section ${sectionIndex}: schemaId=${kustoSupplementalTraceId(schemaKey)} modelId=${kustoSupplementalTraceId(modelUri)}`);
	return `preparation ready for section ${sectionIndex}: schemaId=${kustoSupplementalTraceId(schemaKey)} modelId=${kustoSupplementalTraceId(modelUri)}`;
}

async function e2eWaitForKustoPreparationReady(sectionIndex: number = 0, timeoutMs: number = 25000): Promise<string> {
	const started = performance.now();
	while (performance.now() - started <= timeoutMs) {
		const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
		const section = sections[sectionIndex];
		if (!section) throw new Error(`Kusto section ${sectionIndex} not found`);
		const boxId = String(section.boxId || section.id || '');
		const preparation = getKustoPreparationState(boxId);
		if (preparation.status === 'ready') return e2eAssertKustoPreparationReady(sectionIndex);
		if (preparation.status === 'error') {
			throw new Error(`Preparation failed for section ${sectionIndex}: stage=${preparation.stage} generation=${preparation.generation} revision=${preparation.revision} blockers=${preparation.blockers.join(',')} schemaId=${kustoSupplementalTraceId(String(preparation.target.schemaKey || ''))} modelId=${kustoSupplementalTraceId(String(preparation.target.modelUri || ''))}`);
		}
		await e2eDelay(100);
	}
	const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
	const section = sections[sectionIndex];
	const boxId = String(section?.boxId || section?.id || '');
	const { schemaKey } = e2eKustoSchemaIdentityForSection(section);
	const modelUri = String(_win.queryEditors?.[boxId]?.getModel?.()?.uri?.toString?.() || '');
	const preparation = getKustoPreparationState(boxId);
	throw new Error(`Preparation timed out for section ${sectionIndex}: status=${preparation.status} stage=${preparation.stage} generation=${preparation.generation} revision=${preparation.revision} blockers=${preparation.blockers.join(',')} schemaId=${kustoSupplementalTraceId(schemaKey)} modelId=${kustoSupplementalTraceId(modelUri)} workerReady=${isSchemaWorkerReady(boxId, schemaKey, modelUri)} enhancementReady=${isSchemaEnhancementReady(boxId, schemaKey, preparation.target.schemaSignature, modelUri)}`);
}

function e2eAssertKustoWorkerContext(sectionIndex: number = 0): string {
	const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
	const section = sections[sectionIndex];
	if (!section) throw new Error(`Kusto section ${sectionIndex} not found`);
	const { database, schemaKey: expectedSchemaKey } = e2eKustoSchemaIdentityForSection(section);
	const context = __kustoSchemaTracker.databaseInContext;
	const actualSchemaKey = String(context?.schemaKey || '');
	if (!expectedSchemaKey || actualSchemaKey !== expectedSchemaKey) {
		throw new Error(`Worker context mismatch for section ${sectionIndex}: expected ${expectedSchemaKey}, got ${actualSchemaKey || '(none)'}`);
	}
	return `worker context remains ${database} (${expectedSchemaKey})`;
}

async function e2eWaitForKustoWorkerContext(sectionIndex: number = 0, timeoutMs: number = 10000): Promise<string> {
	const started = performance.now();
	let lastError: unknown;
	while (performance.now() - started <= timeoutMs) {
		try {
			return e2eAssertKustoWorkerContext(sectionIndex);
		} catch (error) {
			lastError = error;
			await e2eDelay(100);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(`Worker context did not settle for section ${sectionIndex}`);
}

async function e2eAssertActualKustoWorkerContext(sectionIndex: number = 0): Promise<string> {
	const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
	const section = sections[sectionIndex];
	if (!section) throw new Error(`Kusto section ${sectionIndex} not found`);
	const boxId = String(section.boxId || section.id || '');
	const expectedDatabase = String(section.getDatabase?.() || '');
	const expectedClusterUrl = String(section.getClusterUrl?.() || '');
	const modelUri = String(_win.queryEditors?.[boxId]?.getModel?.()?.uri?.toString?.() || '');
	const monacoApi = _win.monaco;
	if (!modelUri || !monacoApi?.languages?.kusto?.getKustoWorker || !monacoApi?.Uri?.parse) {
		throw new Error(`Kusto worker is unavailable for section ${sectionIndex}`);
	}
	const workerAccessor = await monacoApi.languages.kusto.getKustoWorker();
	const worker = await workerAccessor(monacoApi.Uri.parse(modelUri));
	const workerSchema = await worker?.getSchema?.();
	const actualDatabase = String(workerSchema?.database?.name || '');
	const actualClusterUrl = String(workerSchema?.cluster?.connectionString || workerSchema?.cluster?.dataSource || workerSchema?.cluster?.uri || '');
	if (actualDatabase.toLowerCase() !== expectedDatabase.toLowerCase()) {
		throw new Error(`Actual worker database mismatch for section ${sectionIndex}: expected ${expectedDatabase}, got ${actualDatabase || '(none)'}`);
	}
	if (actualClusterUrl && kustoClusterKey(actualClusterUrl) !== kustoClusterKey(expectedClusterUrl)) {
		throw new Error(`Actual worker cluster mismatch for section ${sectionIndex}: expected ${expectedClusterUrl}, got ${actualClusterUrl}`);
	}
	return `actual worker context is ${actualClusterUrl || '(cluster unavailable)'}/${actualDatabase}`;
}

async function e2eAssertKustoTableCompletionForSection(sectionIndex: number = 0, timeoutMs: number = 5000): Promise<string> {
	const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
	const section = sections[sectionIndex];
	if (!section) throw new Error(`Kusto section ${sectionIndex} not found`);
	const boxId = String(section.boxId || section.id || '');
	const schema = _win.schemaByBoxId?.[boxId];
	const tableNames = e2eIdentifierNames(Array.isArray(schema?.tables) ? schema.tables : Object.keys(schema?.columnTypesByTable || {}));
	const table = tableNames.find((name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
	if (!table) throw new Error(`No identifier-safe table found for section ${sectionIndex}`);
	const prefix = e2eUniquePrefix(table, tableNames, 3);
	const editor = _win.queryEditors?.[boxId] as MonacoLike | undefined;
	if (!editor) throw new Error(`Kusto editor ${boxId} not found`);
	editor.setValue?.(prefix);
	editor.setPosition?.({ lineNumber: 1, column: prefix.length + 1 });
	const triggered = await _win.__kustoTriggerAutocompleteForBoxId?.(boxId);
	if (!triggered) throw new Error(`Autocomplete trigger was not accepted for section ${sectionIndex}`);
	const editorSelector = `kw-query-section:nth-of-type(${sectionIndex + 1}) .query-editor`;
	const started = performance.now();
	let lastError: unknown;
	while (performance.now() - started <= timeoutMs) {
		try {
			const labels = e2eVisibleSuggestLabelsWithDiagnostics(`section ${sectionIndex} table completion`, editorSelector);
			if (labels.some(label => e2eNormalizeSuggestLabel(label).toLowerCase() === table.toLowerCase())) {
				return `section ${sectionIndex} suggests ${table} for ${prefix}`;
			}
			lastError = new Error(`Expected ${table}, got ${labels.slice(0, 20).join(', ')}`);
		} catch (error) {
			lastError = error;
		}
		await e2eDelay(50);
	}
	throw lastError instanceof Error ? lastError : new Error(`No table completion for section ${sectionIndex}`);
}

async function e2eWaitForKustoSupplementalState(sectionIndex: number, status: string, timeoutMs: number = 15000): Promise<string> {
	const started = performance.now();
	let stableLoadedSamples = 0;
	let latest: Array<Record<string, unknown>> = [];
	while (performance.now() - started <= timeoutMs) {
		const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
		const section = sections[sectionIndex];
		if (!section) throw new Error(`Kusto section ${sectionIndex} not found`);
		const boxId = String(section.boxId || section.id || '');
		const modelUri = String(_win.queryEditors?.[boxId]?.getModel?.()?.uri?.toString?.() || '');
		latest = __kustoGetSupplementalSchemaSnapshot(modelUri);
		if (latest.length > 0 && latest.every(state => state.status === status)) {
			stableLoadedSamples++;
			if (stableLoadedSamples >= 3) return `section ${sectionIndex} supplemental states=${latest.length} status=${status} stable=${stableLoadedSamples}`;
			await e2eDelay(100);
			continue;
		}
		stableLoadedSamples = 0;
		if (latest.some(state => state.status === 'failed')) {
			throw new Error(`Supplemental schema failed for section ${sectionIndex}: ${JSON.stringify(latest)}`);
		}
		await e2eDelay(100);
	}
	throw new Error(`Supplemental state timed out for section ${sectionIndex}: expected=${status} latest=${JSON.stringify(latest)}`);
}

function e2eAssertNoKustoSupplementalWarnings(sectionIndex: number = 0): string {
	const diagnostics = e2eSuggestDiagnostics(`section ${sectionIndex} supplemental diagnostics`, `kw-query-section:nth-of-type(${sectionIndex + 1}) .query-editor`, sectionIndex);
	const forbidden = (diagnostics.markers || []).filter((marker: any) => {
		const code = typeof marker.code === 'object' ? String(marker.code?.value || '') : String(marker.code || '');
		return code.toUpperCase() === 'KS207' || code.toUpperCase() === 'KS208';
	});
	if (forbidden.length) {
		throw new Error(`Section ${sectionIndex} has supplemental warnings: ${JSON.stringify(forbidden)}; diagnostics=${JSON.stringify(diagnostics)}`);
	}
	return `section ${sectionIndex} has no KS207/KS208 markers`;
}

function e2eAssertKustoSupplementalBackgroundTrace(sectionIndex: number = 0): string {
	const diagnostics = e2eSuggestDiagnostics(`section ${sectionIndex} supplemental trace`, `kw-query-section:nth-of-type(${sectionIndex + 1}) .query-editor`, sectionIndex);
	const states = diagnostics.supplementalSchemas || [];
	if (!states.length || !states.every((state: any) => state.requestSource === 'background' && state.status === 'loaded')) {
		throw new Error(`Expected background-loaded supplemental state for section ${sectionIndex}: ${JSON.stringify(states)}`);
	}
	const trace = diagnostics.crossClusterTrace || [];
	if (!trace.some((event: any) => event.event === 'request-posted' && event.requestSource === 'background')) {
		throw new Error(`Expected background request trace for section ${sectionIndex}: ${JSON.stringify(trace.slice(-80))}`);
	}
	if (!trace.some((event: any) => event.event === 'revalidation.done')) {
		throw new Error(`Expected direct revalidation trace for section ${sectionIndex}: ${JSON.stringify(trace.slice(-80))}`);
	}
	const modelId = String(states[0]?.modelId || '');
	if (!trace.some((event: any) => event.event === 'apply-internal-success' && event.modelId === modelId && event.appliedCount > 0)) {
		throw new Error(`Expected model-scoped supplemental apply success for section ${sectionIndex}: ${JSON.stringify(trace.slice(-80))}`);
	}
	const diagnosticsText = JSON.stringify(diagnostics).toLowerCase();
	for (const sentinel of ['supplemental-remote', 'supplemental-current', 'telemetrydb', 'remoteonly', 'file:///', 'inmemory://']) {
		if (diagnosticsText.includes(sentinel)) {
			throw new Error(`Supplemental diagnostics leaked ${sentinel}`);
		}
	}
	return `section ${sectionIndex} background supplemental trace verified`;
}

async function e2eAssertKustoColumnCompletionForSection(sectionIndex: number, column: string, timeoutMs: number = 5000): Promise<string> {
	const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
	const section = sections[sectionIndex];
	if (!section) throw new Error(`Kusto section ${sectionIndex} not found`);
	const boxId = String(section.boxId || section.id || '');
	const editor = _win.queryEditors?.[boxId] as MonacoLike | undefined;
	const model = editor?.getModel?.() as any;
	if (!editor || !model) throw new Error(`Kusto editor ${sectionIndex} not found`);
	const text = String(editor.getValue?.() || '');
	const needle = `| project ${column.slice(0, Math.max(2, Math.min(column.length, 6)))}`;
	const index = text.lastIndexOf('| project ');
	const next = index >= 0 ? `${text.slice(0, index)}${needle}` : `${text}\n${needle}`;
	try {
		model.setValue(next);
		const lines = next.split(/\r?\n/);
		editor.setPosition?.({ lineNumber: lines.length, column: lines[lines.length - 1].length + 1 });
		editor.focus?.();
		const triggered = await _win.__kustoTriggerAutocompleteForBoxId?.(boxId);
		if (!triggered) throw new Error(`Autocomplete trigger was not accepted for section ${sectionIndex}`);
		const selector = `kw-query-section:nth-of-type(${sectionIndex + 1}) .query-editor`;
		const result = await e2eWaitForExistingSuggest('kusto', `section ${sectionIndex} remote column`, column, timeoutMs, false);
		const labels = e2eVisibleSuggestLabelsWithDiagnostics(`section ${sectionIndex} remote column`, selector);
		if (!labels.some(label => e2eNormalizeSuggestColumnLabel(label).toLowerCase() === column.toLowerCase())) {
			throw new Error(`Expected remote columnId=${kustoSupplementalTraceId(column)} for section ${sectionIndex}; visibleLabelCount=${labels.length}`);
		}
		return `${result.result}; section ${sectionIndex} suggests columnId=${kustoSupplementalTraceId(column)}`;
	} finally {
		try { model.setValue(text); } catch { /* best effort test cleanup */ }
	}
}

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
			const kustoBoxId = (editor as any).__kustoBoxId;
			if (kustoBoxId && typeof _win.__kustoTriggerAutocompleteForBoxId === 'function') {
				_win.__kustoTriggerAutocompleteForBoxId(kustoBoxId);
				return `${focusResult}; triggerSuggest via kusto helper`;
			}
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

_win.__testDispatchRawCtrlSpaceMonaco = (selector: string): string => {
	let previousEditor: MonacoLike | null = null;
	let previousPosition: any = null;
	try {
		previousEditor = e2eEditor('kusto');
		previousPosition = previousEditor?.getPosition?.() || null;
	} catch { /* ignore */ }
	const match = deepQuerySelector(document, selector) as HTMLElement | null;
	if (!match) {
		throw new Error(`monaco target not found: ${selector}`);
	}
	const editorRoot = (match.closest('.monaco-editor') as HTMLElement | null)
		|| (match.matches('.monaco-editor') ? match : null)
		|| (match.querySelector('.monaco-editor') as HTMLElement | null)
		|| match;
	const editor = resolveMonacoEditorFromElement(editorRoot);
	const position = previousEditor === editor && previousPosition ? previousPosition : (editor?.getPosition?.() || null);
	try { editor?.focus?.(); } catch { /* ignore */ }
	try { if (position) editor?.setPosition?.(position); } catch { /* ignore */ }
	const textarea = (editorRoot.querySelector('textarea.inputarea') as HTMLTextAreaElement | null)
		|| (editorRoot.querySelector('textarea') as HTMLTextAreaElement | null);
	if (!textarea) {
		throw new Error(`monaco textarea not found for: ${selector}`);
	}
	try { textarea.focus(); } catch { /* ignore */ }
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
	const nextPosition = editor?.getPosition?.() || null;
	return `focused monaco ${selector}; raw ctrl-space dispatched=${dispatched ? 'true' : 'false'}; position=${JSON.stringify(position)}; after=${JSON.stringify(nextPosition)}`;
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

function e2eKustoCancelButton(): HTMLButtonElement {
	const section = e2eSection('kusto');
	const button = document.getElementById(e2eKustoElementId(section, 'cancel_btn')) as HTMLButtonElement | null;
	if (!button) {
		throw new Error('kusto cancel button not found');
	}
	return button;
}

function e2eKustoResultsElement(): HTMLElement {
	const section = e2eSection('kusto');
	const results = document.getElementById(e2eKustoElementId(section, 'results')) as HTMLElement | null;
	if (!results) {
		throw new Error('kusto results element not found');
	}
	return results;
}

function e2eSetKustoCacheEnabled(enabled: boolean): string {
	const section = e2eSection('kusto');
	const checkbox = document.getElementById(e2eKustoElementId(section, 'cache_enabled')) as HTMLInputElement | null;
	if (!checkbox) {
		throw new Error('kusto cache checkbox not found');
	}
	checkbox.checked = !!enabled;
	checkbox.dispatchEvent(new Event('change', { bubbles: true }));
	return `kusto cache enabled=${checkbox.checked}`;
}

function e2eNormalizeClusterUrlKey(url: string): string {
	return kustoClusterKey(url);
}

function e2eKustoFavoriteSections(): any[] {
	return Array.from(document.querySelectorAll('kw-query-section')) as any[];
}

function e2eKustoFavoriteMatches(favorite: any, clusterUrl: string, database: string): boolean {
	const favoriteCluster = e2eNormalizeClusterUrlKey(String(favorite?.clusterUrl || ''));
	const targetCluster = e2eNormalizeClusterUrlKey(clusterUrl);
	const favoriteDatabase = String(favorite?.database || '').trim().toLowerCase();
	const targetDatabase = String(database || '').trim().toLowerCase();
	return !!targetCluster && favoriteCluster === targetCluster && favoriteDatabase === targetDatabase;
}

function e2eKustoGlobalFavorites(): any[] {
	return Array.isArray((_win as any).kustoFavorites) ? (_win as any).kustoFavorites : [];
}

async function e2eKustoPrepareFavoriteDocument(options: any = {}): Promise<string> {
	if (!isPersistenceSuppressedForTest()) throw new Error('Favorites E2E persistence suppression was not active before document setup');
	const clusterUrl = String(options.clusterUrl || '').trim();
	const database = String(options.database || '').trim();
	const sectionCount = Math.max(1, Number(options.sectionCount || 1));
	if (!clusterUrl) throw new Error('clusterUrl is required');
	if (!database) throw new Error('database is required');

	while (e2eKustoFavoriteSections().length < sectionCount) {
		const nextIndex = e2eKustoFavoriteSections().length + 1;
		if (typeof (_win as any).addQueryBox !== 'function') {
			throw new Error('addQueryBox is not available for creating Kusto sections');
		}
		(_win as any).addQueryBox({
			id: `query_favsync_${Date.now()}_${nextIndex}`,
			initialQuery: `print favsync_${nextIndex}=1`,
			clusterUrl,
			database,
		});
		await e2eDelay(80);
	}

	const connectionId = `favsync_${e2eNormalizeClusterUrlKey(clusterUrl).replace(/[^a-z0-9]+/g, '_') || Date.now()}`;
	const conn = { id: connectionId, name: String(options.connectionName || clusterUrl), clusterUrl, database };
	const sections = e2eKustoFavoriteSections();
	for (const section of sections) {
		// Set the current connection before publishing the local fake connection list.
		// That prevents kw-query-section.setConnections() from dispatching the normal
		// connection-changed event, which would ask the host to load databases for a fake cluster.
		if (typeof section.setConnectionId === 'function') section.setConnectionId(conn.id);
		if (typeof section.setDesiredClusterUrl === 'function') section.setDesiredClusterUrl(clusterUrl);
		if (typeof section.setConnections === 'function') section.setConnections([conn], { lastConnectionId: conn.id });
		if (typeof section.setDatabase === 'function') section.setDatabase(database);
		if (typeof section.setDatabases === 'function') section.setDatabases([database], database);
		if (typeof section.setFavoritesMode === 'function') section.setFavoritesMode(false);
		section.requestUpdate?.();
	}
	for (const section of sections) await section.updateComplete;
	adoptCurrentStateAsCleanForTest();
	return `prepared ${sections.length} Kusto section(s) for ${clusterUrl}/${database}`;
}

async function e2eKustoCleanFavorite(options: any = {}): Promise<string> {
	const clusterUrl = String(options.clusterUrl || '').trim();
	const database = String(options.database || '').trim();
	const timeoutMs = Math.max(500, Number(options.timeoutMs || 5000));
	if (!clusterUrl) throw new Error('clusterUrl is required');
	if (!database) throw new Error('database is required');
	let sawRoundTrip = false;
	const onMessage = (event: MessageEvent) => {
		if ((event as any)?.data?.type === 'favoritesData') {
			sawRoundTrip = true;
		}
	};
	window.addEventListener('message', onMessage as EventListener);
	const existing = e2eKustoGlobalFavorites().find(favorite => e2eKustoFavoriteMatches(favorite, clusterUrl, database));
	const connectionId = String(existing?.connectionId || '').trim();
	if (!connectionId) throw new Error(`No connection-owned favorite found for ${clusterUrl}/${database}`);
	postMessageToHost({ type: 'removeFavorite', connectionId, clusterUrl, database });
	const started = performance.now();
	try {
		while (performance.now() - started <= timeoutMs) {
			if (sawRoundTrip && !e2eKustoGlobalFavorites().some(favorite => e2eKustoFavoriteMatches(favorite, clusterUrl, database))) {
				return `cleaned favorite for ${clusterUrl}/${database}`;
			}
			await e2eDelay(80);
		}
	} finally {
		window.removeEventListener('message', onMessage as EventListener);
	}
	const matching = e2eKustoGlobalFavorites()
		.filter(favorite => e2eKustoFavoriteMatches(favorite, clusterUrl, database))
		.map(favorite => String(favorite?.name || ''))
		.join(', ');
	throw new Error(`Timed out cleaning favorite for ${clusterUrl}/${database}; sawRoundTrip=${sawRoundTrip}; matching favorites: ${matching}`);
}

async function e2eKustoSetFavoritesModeForInspection(section: any): Promise<void> {
	if (typeof section.setFavoritesMode === 'function') {
		section.setFavoritesMode(true);
	}
	section.requestUpdate?.();
	await section.updateComplete;
	adoptCurrentStateAsCleanForTest();
}

function e2eKustoFavoriteDropdownLabels(section: any): string[] {
	const dropdown = section.shadowRoot?.querySelector('.kusto-favorites-combo kw-dropdown') as any;
	if (!dropdown) return [];
	return (Array.isArray(dropdown.items) ? dropdown.items : []).map((item: any) => String(item?.label || '').trim());
}

async function e2eKustoCheckFavoriteInAllSections(name: string, expectedSectionCount: number | undefined, expectedVisible: boolean): Promise<{ ok: boolean; details: string[]; errors: string[] }> {
	const favoriteName = String(name || '').trim();
	if (!favoriteName) throw new Error('favorite name is required');
	const sections = e2eKustoFavoriteSections();
	if (typeof expectedSectionCount === 'number' && sections.length !== expectedSectionCount) {
		throw new Error(`Expected ${expectedSectionCount} Kusto section(s), found ${sections.length}`);
	}
	const errors: string[] = [];
	const details: string[] = [];
	for (const section of sections) {
		await e2eKustoSetFavoritesModeForInspection(section);
		const labels = e2eKustoFavoriteDropdownLabels(section);
		const sectionId = String(section.boxId || section.id || 'unknown');
		const hasFavorite = labels.includes(favoriteName);
		details.push(`${sectionId}=[${labels.join('|')}]`);
		if (expectedVisible && !hasFavorite) errors.push(`${sectionId} is missing ${favoriteName}`);
		if (!expectedVisible && hasFavorite) errors.push(`${sectionId} unexpectedly has ${favoriteName}`);
	}
	return { ok: errors.length === 0, details, errors };
}

async function e2eKustoAssertFavoriteInAllSections(name: string, expectedSectionCount?: number, expectedVisible = true, timeoutMs = 5000): Promise<string> {
	const started = performance.now();
	let last: { ok: boolean; details: string[]; errors: string[] } | undefined;
	while (performance.now() - started <= timeoutMs) {
		last = await e2eKustoCheckFavoriteInAllSections(name, expectedSectionCount, expectedVisible);
		if (last.ok) {
			return `${expectedVisible ? 'found' : 'did not find'} ${name} in ${last.details.length} Kusto section(s): ${last.details.join(', ')}`;
		}
		await e2eDelay(100);
	}
	const globalFavorites = e2eKustoGlobalFavorites();
	throw new Error(`${last?.errors.join('; ') || 'favorite assertion did not settle'}; window.kustoFavorites=${globalFavorites.length}; dropdowns: ${last?.details.join(', ') || ''}`);
}

async function e2eKustoAddFavoriteFromSection(index = 0): Promise<string> {
	const sections = e2eKustoFavoriteSections();
	const section = sections[index];
	if (!section) throw new Error(`Kusto section index ${index} not found; total=${sections.length}`);
	if (typeof section.setFavoritesMode === 'function') section.setFavoritesMode(false);
	section.requestUpdate?.();
	await section.updateComplete;
	const star = section.shadowRoot?.querySelector('.favorite-btn') as HTMLButtonElement | null;
	if (!star) throw new Error(`Favorite star button not found in ${section.boxId || section.id}`);
	if (star.classList.contains('favorite-active')) {
		throw new Error(`Favorite star is already active in ${section.boxId || section.id}; choose a unique cluster/database for this scenario`);
	}
	star.click();
	await e2eDelay(0);
	adoptCurrentStateAsCleanForTest();
	return `clicked favorite star in ${section.boxId || section.id}`;
}

function e2eKustoSetFavoritesSyncProbe(label = 'target'): string {
	const token = `${String(label || 'target')}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
	(_win as any).__favsyncTargetProbe = token;
	return token;
}

function e2eKustoAssertFavoritesSyncProbe(token: string): string {
	const expected = String(token || '').trim();
	const actual = String((_win as any).__favsyncTargetProbe || '').trim();
	if (!expected) throw new Error('probe token is required');
	if (actual !== expected) {
		throw new Error(`Target webview probe changed or disappeared; expected ${expected}, got ${actual || '<missing>'}`);
	}
	return `target probe still present: ${actual}`;
}

const E2E_KUSTO_IDENTITY_CHECKLIST = {
	database: 'ChecklistDb',
	cachedDatabase: 'CachedOnlyDb',
	prodKey: 'identity-prod',
	nonprodKey: 'identity-nonprod',
	fooKey: 'identity-foo',
	foobarKey: 'identity-foobar',
	regionalKey: 'identityadx.westus',
	regionalFullUrl: 'https://identityadx.westus.kusto.windows.net',
	favoriteName: 'E2E Identity Checklist Regional Favorite',
};

type E2eIdentityConnection = { id: string; name?: string; clusterUrl?: string; database?: string };

function e2eIdentityConnectionKey(connection: E2eIdentityConnection): string {
	return e2eNormalizeClusterUrlKey(String(connection?.clusterUrl || ''));
}

function e2eIdentityFindConnection(connectionsRaw: unknown, clusterKey: string): E2eIdentityConnection {
	const wantedKey = e2eNormalizeClusterUrlKey(clusterKey);
	const connections = Array.isArray(connectionsRaw) ? connectionsRaw as E2eIdentityConnection[] : [];
	const match = connections.find(connection => e2eIdentityConnectionKey(connection) === wantedKey);
	if (!match) {
		throw new Error(`Expected seeded connection ${clusterKey}; available=${connections.map(connection => `${connection.name || connection.id}:${connection.clusterUrl}`).join(', ')}`);
	}
	return match;
}

async function e2eIdentityWaitForConnections(timeoutMs = 6000): Promise<Record<string, E2eIdentityConnection>> {
	try { postMessageToHost({ type: 'getConnections' }); } catch { /* ignore */ }
	const started = performance.now();
	let lastConnections: unknown = [];
	while (performance.now() - started <= timeoutMs) {
		lastConnections = _win.connections;
		try {
			const prod = e2eIdentityFindConnection(lastConnections, E2E_KUSTO_IDENTITY_CHECKLIST.prodKey);
			const nonprod = e2eIdentityFindConnection(lastConnections, E2E_KUSTO_IDENTITY_CHECKLIST.nonprodKey);
			const foo = e2eIdentityFindConnection(lastConnections, E2E_KUSTO_IDENTITY_CHECKLIST.fooKey);
			const foobar = e2eIdentityFindConnection(lastConnections, E2E_KUSTO_IDENTITY_CHECKLIST.foobarKey);
			const regional = e2eIdentityFindConnection(lastConnections, E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey);
			return { prod, nonprod, foo, foobar, regional };
		} catch {
			await e2eDelay(100);
		}
	}
	throw new Error(`Timed out waiting for seeded checklist connections; last=${JSON.stringify(lastConnections).slice(0, 2000)}`);
}

function e2eIdentityDispatchHostMessage(message: any): void {
	window.dispatchEvent(new MessageEvent('message', { data: message }));
}

async function e2eIdentityToolConfigure(sectionId: string, input: Record<string, unknown>, timeoutMs = 7000): Promise<any> {
	const requestId = `e2e-identity-configure-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	e2eBeginHostMessageCapture();
	try {
		e2eIdentityDispatchHostMessage({ type: 'toolConfigureQuerySection', requestId, input: { ...input, sectionId } });
		const started = performance.now();
		while (performance.now() - started <= timeoutMs) {
			const response = e2eCapturedHostMessages().find(message => message?.type === 'toolResponse' && message.requestId === requestId);
			if (response) {
				if (response.result?.success !== true) {
					throw new Error(`toolConfigureQuerySection failed: ${JSON.stringify(response)}`);
				}
				return response;
			}
			await e2eDelay(100);
		}
		throw new Error(`Timed out waiting for toolConfigureQuerySection response; seen=${JSON.stringify(e2eCapturedHostMessages()).slice(0, 2000)}`);
	} finally {
		e2eRestoreHostMessageCapture();
	}
}

async function e2eIdentityRequestDatabases(connectionId: string, timeoutMs = 6000): Promise<string[]> {
	const requestId = `__e2e_identity_dbreq__${Date.now()}_${Math.random().toString(16).slice(2)}`;
	return await new Promise<string[]>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			window.removeEventListener('message', onMessage);
			reject(new Error(`Timed out waiting for databasesData for ${connectionId}`));
		}, timeoutMs);
		const onMessage = (event: MessageEvent) => {
			const message = event.data || {};
			if (message.type !== 'databasesData' || message.boxId !== requestId) return;
			window.clearTimeout(timer);
			window.removeEventListener('message', onMessage);
			resolve((Array.isArray(message.databases) ? message.databases : []).map((value: any) => String(value || '').trim()).filter(Boolean));
		};
		window.addEventListener('message', onMessage);
		try {
			postMessageToHost({ type: 'getDatabases', connectionId, boxId: requestId });
		} catch (error) {
			window.clearTimeout(timer);
			window.removeEventListener('message', onMessage);
			reject(error);
		}
	});
}

async function e2eIdentityWaitForInfoMessage(expectedText: string, timeoutMs = 6000): Promise<string> {
	const needle = String(expectedText || '').trim();
	if (!needle) throw new Error('expected info text is required');
	return await new Promise<string>((resolve, reject) => {
		const timer = window.setTimeout(() => {
			window.removeEventListener('message', onMessage);
			reject(new Error(`Timed out waiting for info message ${JSON.stringify(needle)}`));
		}, timeoutMs);
		const onMessage = (event: MessageEvent) => {
			const message = event.data || {};
			if (message.type !== 'showInfo' || !String(message.message || '').includes(needle)) return;
			window.clearTimeout(timer);
			window.removeEventListener('message', onMessage);
			resolve(String(message.message || ''));
		};
		window.addEventListener('message', onMessage);
	});
}

async function e2eIdentityAssertSectionFavoriteAlias(): Promise<any> {
	const section = e2eSection('kusto') as any;
	const shortConnection = { id: 'e2e-identity-regional-short', name: 'E2E Identity Short Regional', clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey };
	section.setConnectionId?.(shortConnection.id);
	section.setDesiredClusterUrl?.(shortConnection.clusterUrl);
	section.setConnections?.([shortConnection], { lastConnectionId: shortConnection.id });
	section.setDatabase?.(E2E_KUSTO_IDENTITY_CHECKLIST.database);
	section.setDatabases?.([E2E_KUSTO_IDENTITY_CHECKLIST.database], E2E_KUSTO_IDENTITY_CHECKLIST.database);
	section.setFavorites?.([{ name: E2E_KUSTO_IDENTITY_CHECKLIST.favoriteName, clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalFullUrl, database: E2E_KUSTO_IDENTITY_CHECKLIST.database }]);
	section.setFavoritesMode?.(true);
	section.requestUpdate?.();
	await section.updateComplete;
	const labels = e2eKustoFavoriteDropdownLabels(section);
	if (!labels.includes(E2E_KUSTO_IDENTITY_CHECKLIST.favoriteName)) {
		throw new Error(`Regional short/full favorite alias did not render in section dropdown. Labels=${labels.join(', ')}`);
	}
	return { labels };
}

async function e2eIdentityAssertConnectionManagerAliases(foo: E2eIdentityConnection, foobar: E2eIdentityConnection): Promise<any> {
	const existing = document.getElementById('e2e-identity-connection-manager');
	if (existing) existing.remove();
	const manager = document.createElement('kw-connection-manager') as any;
	manager.id = 'e2e-identity-connection-manager';
	manager.style.cssText = 'position:absolute;left:-10000px;top:0;width:900px;height:600px;';
	document.body.appendChild(manager);
	await manager.updateComplete;
	const regionalShort = { id: 'cm-regional-short', name: 'E2E Regional Short', clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey };
	const snapshot = {
		connections: [regionalShort, foo, foobar],
		sqlConnections: [],
		favorites: [{ name: E2E_KUSTO_IDENTITY_CHECKLIST.favoriteName, clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalFullUrl, database: E2E_KUSTO_IDENTITY_CHECKLIST.database }],
		leaveNoTraceClusters: [E2E_KUSTO_IDENTITY_CHECKLIST.regionalFullUrl],
		cachedDatabases: { [E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey]: [E2E_KUSTO_IDENTITY_CHECKLIST.database] },
		sqlCachedDatabases: {},
		activeKind: 'kusto',
		searchState: {
			query: 'NeedleTable',
			scope: 'cached',
			categories: { clusters: true, databases: true, tables: true, functions: true },
			contentToggles: { tables: false, functions: false },
			lastResults: [{ category: 'table', kind: 'kusto', connectionId: foo.id, connectionName: String(foo.name || ''), database: E2E_KUSTO_IDENTITY_CHECKLIST.database, name: 'NeedleTable' }],
			lastSearchTimestamp: Date.now(),
		},
	};
	await e2eDelay(150);
	manager._snapshot = snapshot;
	manager._activeKind = 'kusto';
	manager._selectedConnectionId = regionalShort.id;
	manager._search?.restoreState?.(snapshot.searchState, 'kusto');
	manager.requestUpdate?.();
	await manager.updateComplete;
	manager._setKustoFilter?.('favorites');
	await manager.updateComplete;
	const favoritesText = String(manager.shadowRoot?.textContent || '');
	const favoritesIncludesRegionalShort = favoritesText.includes('E2E Regional Short');
	if (!favoritesIncludesRegionalShort) {
		throw new Error(`Connection Manager Favorites filter did not include regional short/full alias. Text=${favoritesText.slice(0, 1000)}`);
	}
	manager._setKustoFilter?.('lnt');
	await manager.updateComplete;
	const lntText = String(manager.shadowRoot?.textContent || '');
	const lntIncludesRegionalShort = lntText.includes('E2E Regional Short');
	if (!lntIncludesRegionalShort) {
		throw new Error(`Connection Manager Leave No Trace filter did not include regional short/full alias. Text=${lntText.slice(0, 1000)}`);
	}
	manager._setKustoFilter?.('search');
	await manager.updateComplete;
	const searchText = String(manager.shadowRoot?.querySelector('[data-testid="cm-search-results"]')?.textContent || '');
	const searchIncludesFoo = searchText.includes('NeedleTable') && searchText.includes(String(foo.name || ''));
	const searchIncludesFoobar = searchText.includes(String(foobar.name || ''));
	if (!searchIncludesFoo) {
		throw new Error(`Connection Manager search result did not render exact foo connection. Text=${searchText.slice(0, 1000)}`);
	}
	if (searchIncludesFoobar) {
		throw new Error(`Connection Manager search result leaked overlapping foobar connection. Text=${searchText.slice(0, 1000)}`);
	}
	manager.remove();
	return {
		favoritesIncludesRegionalShort,
		lntIncludesRegionalShort,
		searchIncludesFoo,
		searchIncludesFoobar,
		searchConnectionId: foo.id,
		overlapConnectionId: foobar.id,
		favoritesText: favoritesText.slice(0, 1000),
		lntText: lntText.slice(0, 1000),
		searchText: searchText.slice(0, 1000),
	};
}

async function e2eIdentityAssertTwoSectionAliasDiagnostics(regional: E2eIdentityConnection): Promise<any> {
	while (e2eKustoFavoriteSections().length < 2) {
		if (typeof _win.addQueryBox !== 'function') {
			throw new Error('addQueryBox is not available for two-section alias diagnostics check');
		}
		_win.addQueryBox({
			id: `query_identity_alias_${Date.now()}`,
			initialQuery: 'print identity_alias = 1',
			clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey,
			database: E2E_KUSTO_IDENTITY_CHECKLIST.database,
		});
		await e2eDelay(80);
	}
	const sections = e2eKustoFavoriteSections().slice(0, 2) as any[];
	const fullSection = sections[0];
	const shortSection = sections[1];
	const shortConnection = { id: 'e2e-identity-regional-short-diagnostics', name: 'E2E Identity Short Diagnostics', clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey };
	const connectionsForSections = [regional, shortConnection];
	const fullQuery = `cluster('${E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey}').database('${E2E_KUSTO_IDENTITY_CHECKLIST.database}').NeedleTable | take 1`;
	const shortQuery = `cluster('${E2E_KUSTO_IDENTITY_CHECKLIST.regionalFullUrl}').database('${E2E_KUSTO_IDENTITY_CHECKLIST.database}').NeedleTable | take 1`;
	const configure = async (section: any, connection: any, query: string) => {
		section.setConnectionId?.(connection.id);
		section.setDesiredClusterUrl?.(connection.clusterUrl);
		section.setConnections?.(connectionsForSections, { lastConnectionId: connection.id });
		section.setDatabase?.(E2E_KUSTO_IDENTITY_CHECKLIST.database);
		section.setDatabases?.([E2E_KUSTO_IDENTITY_CHECKLIST.database], E2E_KUSTO_IDENTITY_CHECKLIST.database);
		const boxId = String(section.boxId || section.id || '').trim();
		const editor = boxId ? _win.queryEditors?.[boxId] as MonacoLike | undefined : undefined;
		if (!editor || typeof editor.setValue !== 'function') {
			throw new Error(`Kusto editor missing for two-section alias diagnostics check: ${boxId || '<missing>'}`);
		}
		editor.setValue(query);
		section.requestUpdate?.();
		await section.updateComplete;
		return { boxId, query };
	};
	const fullConfigured = await configure(fullSection, regional, fullQuery);
	const shortConfigured = await configure(shortSection, shortConnection, shortQuery);
	const refsFromFullSection = extractCrossClusterRefs(fullConfigured.query, {
		clusterUrl: regional.clusterUrl,
		database: E2E_KUSTO_IDENTITY_CHECKLIST.database,
	});
	const refsFromShortSection = extractCrossClusterRefs(shortConfigured.query, {
		clusterUrl: shortConnection.clusterUrl,
		database: E2E_KUSTO_IDENTITY_CHECKLIST.database,
	});
	const remoteControlRefs = extractCrossClusterRefs(`cluster('identity-other.westus').database('${E2E_KUSTO_IDENTITY_CHECKLIST.database}').NeedleTable | take 1`, {
		clusterUrl: regional.clusterUrl,
		database: E2E_KUSTO_IDENTITY_CHECKLIST.database,
	});
	const missingFromFullConnection = computeMissingClusterUrls([E2E_KUSTO_IDENTITY_CHECKLIST.regionalKey], [regional]);
	const missingFromShortConnection = computeMissingClusterUrls([E2E_KUSTO_IDENTITY_CHECKLIST.regionalFullUrl], [shortConnection]);
	const missingControl = computeMissingClusterUrls(['identity-other.westus'], [regional]);
	if (refsFromFullSection.length) {
		throw new Error(`Full regional section treated short regional current-cluster reference as remote: ${JSON.stringify(refsFromFullSection)}`);
	}
	if (refsFromShortSection.length) {
		throw new Error(`Short regional section treated full regional current-cluster reference as remote: ${JSON.stringify(refsFromShortSection)}`);
	}
	if (remoteControlRefs.length !== 1 || remoteControlRefs[0]?.clusterName !== 'identity-other.westus') {
		throw new Error(`Remote control did not detect a true cross-cluster reference: ${JSON.stringify(remoteControlRefs)}`);
	}
	if (missingFromFullConnection.length || missingFromShortConnection.length) {
		throw new Error(`Short/full regional alias produced missing-cluster entries: full=${JSON.stringify(missingFromFullConnection)} short=${JSON.stringify(missingFromShortConnection)}`);
	}
	if (missingControl.length !== 1 || missingControl[0] !== 'identity-other.westus') {
		throw new Error(`Missing-cluster control did not detect true missing cluster: ${JSON.stringify(missingControl)}`);
	}
	return {
		fullSectionBoxId: fullConfigured.boxId,
		shortSectionBoxId: shortConfigured.boxId,
		fullSectionClusterUrl: regional.clusterUrl,
		shortSectionClusterUrl: shortConnection.clusterUrl,
		refsFromFullSection,
		refsFromShortSection,
		remoteControlRefs,
		missingFromFullConnection,
		missingFromShortConnection,
		missingControl,
	};
}

async function e2eKustoRunIdentityManualChecklist(): Promise<any> {
	const seeded = await e2eIdentityWaitForConnections();
	const section = e2eSection('kusto') as any;
	const sectionId = String(section.boxId || section.id || '').trim();
	if (!sectionId) throw new Error('Kusto section missing id for identity checklist');
	const configureResponse = await e2eIdentityToolConfigure(sectionId, {
		clusterUrl: E2E_KUSTO_IDENTITY_CHECKLIST.prodKey,
		database: E2E_KUSTO_IDENTITY_CHECKLIST.database,
		query: 'print exact_identity_prod = 1',
	});
	await section.updateComplete;
	const selectedConnectionId = String(section.getConnectionId?.() || '');
	if (selectedConnectionId !== seeded.prod.id) {
		throw new Error(`Tool configure selected wrong connection. Expected ${seeded.prod.id} (${seeded.prod.clusterUrl}), got ${selectedConnectionId}; nonprod=${seeded.nonprod.id}`);
	}
	if (selectedConnectionId === seeded.nonprod.id) {
		throw new Error('Tool configure selected overlapping nonprod connection');
	}
	const selectedDatabase = String(section.getDatabase?.() || '');
	if (selectedDatabase !== E2E_KUSTO_IDENTITY_CHECKLIST.database) {
		throw new Error(`Tool configure database mismatch. Expected ${E2E_KUSTO_IDENTITY_CHECKLIST.database}, got ${selectedDatabase}`);
	}
	const cachedDatabases = await e2eIdentityRequestDatabases(seeded.regional.id);
	for (const expected of [E2E_KUSTO_IDENTITY_CHECKLIST.database, E2E_KUSTO_IDENTITY_CHECKLIST.cachedDatabase]) {
		if (!cachedDatabases.includes(expected)) {
			throw new Error(`Regional cached database lookup missed ${expected}; databases=${cachedDatabases.join(', ')}`);
		}
	}
	const favoriteAlias = await e2eIdentityAssertSectionFavoriteAlias();
	const managerAliases = await e2eIdentityAssertConnectionManagerAliases(seeded.foo, seeded.foobar);
	const twoSectionAliasDiagnostics = await e2eIdentityAssertTwoSectionAliasDiagnostics(seeded.regional);
	section.setConnectionId?.(seeded.regional.id);
	section.setDesiredClusterUrl?.(seeded.regional.clusterUrl);
	section.setConnections?.(Array.isArray(_win.connections) ? _win.connections : [], { lastConnectionId: seeded.regional.id });
	section.setDatabase?.(E2E_KUSTO_IDENTITY_CHECKLIST.database);
	section.setDatabases?.(cachedDatabases, E2E_KUSTO_IDENTITY_CHECKLIST.database);
	section.requestUpdate?.();
	await section.updateComplete;
	const copyDone = e2eIdentityWaitForInfoMessage('Azure Data Explorer link copied to clipboard.', 7000);
	postMessageToHost({
		type: 'copyAdeLink',
		boxId: sectionId,
		query: 'print identity_adx = 1',
		connectionId: seeded.regional.id,
		database: E2E_KUSTO_IDENTITY_CHECKLIST.database,
	});
	const copyInfo = await copyDone;
	const proof = {
		selectedConnectionId,
		prodConnectionId: seeded.prod.id,
		nonprodConnectionId: seeded.nonprod.id,
		configureResponse: configureResponse.result,
		cachedDatabases,
		favoriteAlias,
		managerAliases,
		twoSectionAliasDiagnostics,
		copyInfo,
		adxExpectedPath: '/clusters/identityadx.westus/databases/ChecklistDb?query=',
	};
	e2eSetProofMarker('kusto-identity-manual-checklist', proof);
	(_win.__e2eKustoIdentityManualChecklist = proof);
	return proof;
}

function e2eKustoIdentityManualChecklistSnapshot(): any {
	return _win.__e2eKustoIdentityManualChecklist || null;
}

function e2eBeginHostMessageCapture(): string {
	const root = (_win.__e2e = _win.__e2e || {}) as any;
	const existing = root.hostMessageCapture || {};
	const original = existing.active ? existing.original : _win.__e2eCaptureHostMessage;
	root.hostMessageCapture = { active: true, original, messages: [] };
	_win.__e2eCaptureHostMessage = function (msg: any) {
		try {
			root.hostMessageCapture.messages.push(msg);
		} catch {
			// ignore
		}
		if (typeof original === 'function') {
			original(msg);
		}
	};
	return 'host message capture armed';
}

function e2eRestoreHostMessageCapture(): string {
	const root = (_win.__e2e = _win.__e2e || {}) as any;
	const capture = root.hostMessageCapture;
	if (capture && typeof capture.original === 'function') {
		_win.__e2eCaptureHostMessage = capture.original;
	} else {
		delete _win.__e2eCaptureHostMessage;
	}
	delete root.hostMessageCapture;
	return 'host message capture restored';
}

function e2eCapturedHostMessages(): any[] {
	const capture = (_win.__e2e as any)?.hostMessageCapture;
	return Array.isArray(capture?.messages) ? capture.messages : [];
}

async function e2eAssertHostMessageCaptured(type: string, boxId: string = '', timeoutMs: number = 5000): Promise<string> {
	const wantedType = String(type || '').trim();
	const wantedBoxId = String(boxId || '').trim();
	if (!wantedType) {
		throw new Error('host message type is required');
	}
	const started = performance.now();
	while (performance.now() - started <= timeoutMs) {
		const messages = e2eCapturedHostMessages();
		const match = messages.find(msg => {
			if (!msg || msg.type !== wantedType) return false;
			if (!wantedBoxId) return true;
			return String(msg.boxId || '') === wantedBoxId;
		});
		if (match) {
			return `captured host message ${wantedType}${wantedBoxId ? ` for ${wantedBoxId}` : ''}`;
		}
		await e2eDelay(100);
	}
	const seen = e2eCapturedHostMessages().map(msg => `${msg?.type || '<missing>'}:${msg?.boxId || ''}`).join(', ');
	throw new Error(`Timed out waiting for host message ${wantedType}${wantedBoxId ? ` for ${wantedBoxId}` : ''}. Seen: ${seen}`);
}

function e2eRunFunctionMessages(): any[] {
	return Array.isArray(_win.__e2eRunFunctionManualMessages) ? _win.__e2eRunFunctionManualMessages : [];
}

function e2eRunFunctionExecuteMessage(): any {
	const section = e2eSection('kusto');
	const boxId = String(section.boxId || section.id || '');
	return e2eRunFunctionMessages().find(message => message && message.type === 'executeQuery' && String(message.boxId || '') === boxId);
}

function e2eRunFunctionInfoMessage(): any {
	return e2eRunFunctionMessages().find(message => message && message.type === 'showInfo');
}

function e2eRunFunctionArmCapture(): void {
	if (typeof _win.__e2eRunFunctionManualRestore === 'function') {
		_win.__e2eRunFunctionManualRestore();
	}
	const original = _win.__e2eCaptureHostMessage;
	const hadOriginal = typeof original === 'function';
	_win.__e2eRunFunctionManualMessages = [];
	_win.__e2eCaptureHostMessage = (message: any) => {
		try { _win.__e2eRunFunctionManualMessages.push(message); } catch { /* ignore */ }
		return false;
	};
	_win.__e2eRunFunctionManualRestore = () => {
		if (hadOriginal) _win.__e2eCaptureHostMessage = original;
		else delete _win.__e2eCaptureHostMessage;
		delete _win.__e2eRunFunctionManualRestore;
	};
}

function e2eRunFunctionCleanup(): void {
	try { e2eSection('kusto').executionCtrl?.setQueryExecuting(false); } catch { /* ignore */ }
	if (typeof _win.__e2eRunFunctionManualRestore === 'function') {
		_win.__e2eRunFunctionManualRestore();
	}
}

async function e2eRunFunctionWaitForMessage(timeoutMs = 6000): Promise<any> {
	const started = performance.now();
	while (performance.now() - started <= timeoutMs) {
		const message = e2eRunFunctionExecuteMessage() || e2eRunFunctionInfoMessage();
		if (message) return message;
		await e2eDelay(50);
	}
	const seen = e2eRunFunctionMessages().map(message => `${message?.type || '<missing>'}:${message?.boxId || ''}`).join(', ');
	throw new Error(`Timed out waiting for Run Function host message. Seen: ${seen}`);
}

async function e2eRunFunctionSetConnected(): Promise<any> {
	const section = e2eSection('kusto');
	if (typeof section.setConnectionId !== 'function' || typeof section.setDatabase !== 'function') {
		throw new Error('Kusto section connection/database setters are missing');
	}
	section.setConnectionId('manual-e2e-connection');
	section.setDatabase('Samples');
	await section.updateComplete;
	if (typeof _win.__kustoUpdateRunEnabledForBox === 'function') {
		_win.__kustoUpdateRunEnabledForBox(section.boxId);
	}
	return section;
}

async function e2eRunFunctionPrepare(text: string, lineNumber: number, column: number): Promise<any> {
	const section = await e2eRunFunctionSetConnected();
	try { section.executionCtrl?.setQueryExecuting(false); } catch { /* ignore */ }
	_win.__e2e.kusto.setQueryAt(text, lineNumber, column);
	const editor = e2eEditor('kusto');
	try { editor.setSelection?.({ startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column }); } catch { /* ignore */ }
	try { editor.focus?.(); } catch { /* ignore */ }
	if (typeof _win.setRunMode === 'function') {
		_win.setRunMode(section.boxId, 'runFunction');
	}
	if (typeof _win.__kustoUpdateRunEnabledForBox === 'function') {
		_win.__kustoUpdateRunEnabledForBox(section.boxId);
	}
	await e2eDelay(150);
	return section;
}

async function e2eRunFunctionRun(): Promise<any> {
	e2eRunFunctionArmCapture();
	const section = e2eSection('kusto');
	if (typeof _win.__kustoApplyRunModeFromMenu !== 'function') {
		throw new Error('Run Function menu handler missing');
	}
	_win.__kustoApplyRunModeFromMenu(section.boxId, 'runFunction');
	return e2eRunFunctionWaitForMessage();
}

function e2eRunFunctionAssertExecuted(message: any, expectedQuery: string, label: string): void {
	if (!message || message.type !== 'executeQuery') {
		throw new Error(`${label} did not execute: ${JSON.stringify(message)}`);
	}
	if (message.query !== expectedQuery) {
		throw new Error(`${label} query mismatch. Expected ${JSON.stringify(expectedQuery)}, got ${JSON.stringify(message.query)}`);
	}
	if (message.queryMode !== 'plain') {
		throw new Error(`${label} should use plain query mode, got ${message.queryMode}`);
	}
	if (message.cacheEnabled !== false) {
		throw new Error(`${label} should disable cache, got ${message.cacheEnabled}`);
	}
	if (/^\s*\.(create-or-alter|create|alter)\s+function\b/im.test(String(message.query || ''))) {
		throw new Error(`${label} sent raw function management command: ${message.query}`);
	}
}

async function e2eRunFunctionManualLeadingComments(): Promise<string> {
	const nl = String.fromCharCode(10);
	const text = [
		'// leading helper comment',
		'/* leading block comment */',
		'// .create function FakeManual() { print fake=1 }',
		'.create function RealManual() { print real=1 }',
	].join(nl);
	await e2eRunFunctionPrepare(text, 4, 20);
	const message = await e2eRunFunctionRun();
	e2eRunFunctionCleanup();
	e2eRunFunctionAssertExecuted(message, `let RealManual = () { print real=1 };${nl}RealManual()`, 'leading-comments');
	if (/FakeManual/.test(String(message.query || ''))) {
		throw new Error('leading-comments ran the commented fake function');
	}
	return 'leading-comments Run Function query verified';
}

async function e2eRunFunctionManualCursorSecondSameLine(): Promise<string> {
	const nl = String.fromCharCode(10);
	const text = '.create function FirstManual() { print first=1 }; .create function SecondManual() { print second=2 }';
	await e2eRunFunctionPrepare(text, 1, text.indexOf('SecondManual') + 2);
	const message = await e2eRunFunctionRun();
	e2eRunFunctionCleanup();
	e2eRunFunctionAssertExecuted(message, `let SecondManual = () { print second=2 };${nl}SecondManual()`, 'same-line second function');
	if (/FirstManual/.test(String(message.query || ''))) {
		throw new Error('same-line scenario included the first function');
	}
	return 'same-line second function query verified';
}

async function e2eRunFunctionManualCrlfSecond(): Promise<string> {
	const nl = String.fromCharCode(10);
	const crlf = String.fromCharCode(13, 10);
	const text = [
		'.create function FirstManual() {',
		'print first=1',
		'};',
		'.create function SecondManual() {',
		'print second=2',
		'| extend doubled = second * 2',
		'}',
	].join(crlf);
	await e2eRunFunctionPrepare(text, 5, 8);
	const message = await e2eRunFunctionRun();
	e2eRunFunctionCleanup();
	e2eRunFunctionAssertExecuted(message, `let SecondManual = () {${nl}print second=2${nl}| extend doubled = second * 2${nl}};${nl}SecondManual()`, 'CRLF second function');
	return 'CRLF second function query verified';
}

async function e2eRunFunctionManualOpenParameterizedDialog(): Promise<string> {
	const quote = String.fromCharCode(34);
	const text = `.create function LabelManual(label:string = ${quote}a,b=c${quote}) { print label }`;
	await e2eRunFunctionPrepare(text, 1, text.indexOf('LabelManual') + 2);
	e2eRunFunctionArmCapture();
	_win.__kustoApplyRunModeFromMenu(e2eSection('kusto').boxId, 'runFunction');
	const started = performance.now();
	let dialog: any = null;
	while (performance.now() - started <= 6000) {
		dialog = document.querySelector('kw-function-params-dialog') as any;
		if (dialog) break;
		await e2eDelay(50);
	}
	if (!dialog) throw new Error('Timed out waiting for function parameter dialog');
	await dialog.updateComplete;
	const root = dialog.shadowRoot;
	const inputs = Array.from(root.querySelectorAll('.fpd-input')) as HTMLInputElement[];
	if (inputs.length !== 1) {
		throw new Error(`Expected one parameter input, got ${inputs.length}`);
	}
	const expectedDefault = `${quote}a,b=c${quote}`;
	if (inputs[0].value !== expectedDefault) {
		throw new Error(`Expected default value ${expectedDefault}, got ${JSON.stringify(inputs[0].value)}`);
	}
	if (!String(root.textContent || '').includes(`default: ${expectedDefault}`)) {
		throw new Error('Dialog did not show full default text');
	}
	return 'parameter dialog default value verified';
}

async function e2eRunFunctionManualFinishParameterizedDialog(): Promise<string> {
	const nl = String.fromCharCode(10);
	const quote = String.fromCharCode(34);
	const dialog = document.querySelector('kw-function-params-dialog') as any;
	if (!dialog) throw new Error('parameter dialog missing before finish');
	await dialog.updateComplete;
	const runButton = (Array.from(dialog.shadowRoot.querySelectorAll('button')) as HTMLButtonElement[])
		.find(button => (button.textContent || '').trim() === 'Run');
	if (!runButton) throw new Error('parameter dialog Run button missing');
	runButton.click();
	const started = performance.now();
	let message: any = null;
	while (performance.now() - started <= 6000) {
		message = e2eRunFunctionExecuteMessage();
		if (message) break;
		await e2eDelay(50);
	}
	if (!message) throw new Error('Timed out waiting for parameterized executeQuery');
	e2eRunFunctionCleanup();
	const expectedDefault = `${quote}a,b=c${quote}`;
	e2eRunFunctionAssertExecuted(message, `let LabelManual = (label:string = ${expectedDefault}) { print label };${nl}LabelManual(${expectedDefault})`, 'parameter default');
	return 'parameterized Run Function query verified';
}

async function e2eRunFunctionManualFencedKql(): Promise<string> {
	const nl = String.fromCharCode(10);
	const text = ['```kql', '.create function FencedManual() { print fenced=1 }', '```'].join(nl);
	await e2eRunFunctionPrepare(text, 2, 20);
	const message = await e2eRunFunctionRun();
	e2eRunFunctionCleanup();
	e2eRunFunctionAssertExecuted(message, `let FencedManual = () { print fenced=1 };${nl}FencedManual()`, 'fenced kql');
	if (/```/.test(String(message.query || ''))) {
		throw new Error('fenced query included fence markers');
	}
	return 'fenced KQL Run Function query verified';
}

async function e2eRunFunctionManualCursorOutsideShowsNoFunction(): Promise<string> {
	const nl = String.fromCharCode(10);
	const text = ['.create function FirstManual() { print first=1 };', 'FirstManual()'].join(nl);
	await e2eRunFunctionPrepare(text, 2, 2);
	const message = await e2eRunFunctionRun();
	e2eRunFunctionCleanup();
	if (!message || message.type !== 'showInfo' || message.message !== 'No function definition found in this section.') {
		throw new Error(`Expected no-function info, got ${JSON.stringify(message)}`);
	}
	if (e2eRunFunctionMessages().some(candidate => candidate && candidate.type === 'executeQuery')) {
		throw new Error('Cursor outside function unexpectedly executed a query');
	}
	return 'cursor outside function shows no-function message';
}

function e2eCursorOffsetForLineColumn(text: string, lineNumber: number, column: number): number {
	const lines = String(text || '').split('\n');
	const targetLine = Math.max(1, Math.floor(lineNumber));
	let offset = 0;
	for (let index = 0; index < Math.min(targetLine - 1, lines.length); index++) {
		offset += lines[index].length + 1;
	}
	const lineText = lines[Math.max(0, Math.min(targetLine - 1, lines.length - 1))] || '';
	return offset + Math.max(0, Math.min(Math.floor(column) - 1, lineText.length));
}

async function e2eCursorCreateNotebook(): Promise<string> {
	_win.__testRemoveAllSections();
	await e2eLayoutWaitFor(() => document.querySelectorAll(TEST_SECTION_SELECTOR).length === 0, 'all sections removed for cursor test');

	const queryId = e2eLayoutAddSection('addQueryBox', {
		id: 'cursor_query',
		initialQuery: 'print alpha=1\n| extend beta = alpha + 1',
		expanded: true,
	});
	const sqlId = e2eLayoutAddSection('addSqlBox', {
		id: 'cursor_sql',
		name: 'Cursor SQL',
		query: 'SELECT 1 AS alpha\nSELECT 2 AS beta',
		expanded: true,
		editorHeightPx: 180,
	});
	const htmlId = e2eLayoutAddSection('addHtmlBox', {
		id: 'cursor_html',
		name: 'Cursor HTML',
		code: '<main>\n  <h1>Cursor</h1>\n</main>',
		mode: 'code',
		expanded: true,
	});
	const pythonId = e2eLayoutAddSection('addPythonBox', { id: 'cursor_python' });
	const markdownId = e2eLayoutAddSection('addMarkdownBox', {
		id: 'cursor_markdown',
		title: 'Cursor Markdown',
		text: '# Cursor\n\nBody text',
		mode: 'markdown',
		expanded: true,
	});

	await e2eLayoutWaitFor(() => [queryId, sqlId, htmlId, pythonId, markdownId].every(id => !!document.getElementById(id)), 'cursor test sections');
	await e2eLayoutSetMonacoValue(pythonId, 'value = 1\nprint(value)');
	return `cursor notebook ready: ${[queryId, sqlId, htmlId, pythonId, markdownId].join(',')}`;
}

async function e2eCursorFocusMonaco(sectionId: string, lineNumber: number, column: number): Promise<string> {
	await e2eLayoutWaitFor(() => !!resolveMonacoEditorFromElement(document.getElementById(sectionId)), `${sectionId} Monaco editor`, 10000);
	const section = document.getElementById(sectionId);
	const editor = resolveMonacoEditorFromElement(section);
	if (!editor) {
		throw new Error(`Monaco editor not found for ${sectionId}`);
	}
	if (typeof editor.setPosition === 'function') {
		editor.setPosition({ lineNumber, column });
	}
	if (typeof editor.setSelection === 'function') {
		editor.setSelection({ startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column });
	}
	try { setActiveMonacoEditor(editor); } catch { /* ignore */ }
	try { editor.focus?.(); } catch { /* ignore */ }
	try { editor.render?.(true); } catch { /* ignore */ }
	await e2eDelay(150);
	const position = editor.getPosition?.();
	return `${sectionId} caret at ${position?.lineNumber ?? lineNumber}:${position?.column ?? column}`;
}

async function e2eCursorHoverMonaco(sectionId: string, lineNumber: number, column: number): Promise<string> {
	await e2eLayoutWaitFor(() => !!resolveMonacoEditorFromElement(document.getElementById(sectionId)), `${sectionId} Monaco editor`, 10000);
	const section = document.getElementById(sectionId);
	const editor = resolveMonacoEditorFromElement(section);
	if (!editor) {
		throw new Error(`Monaco editor not found for ${sectionId}`);
	}
	if (typeof editor.setPosition === 'function') {
		editor.setPosition({ lineNumber, column });
	}
	const domNode = typeof editor.getDomNode === 'function' ? editor.getDomNode() : null;
	if (!domNode) {
		throw new Error(`Monaco DOM node not found for ${sectionId}`);
	}
	domNode.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: 20, clientY: 20 }));
	domNode.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 24, clientY: 24 }));
	await e2eDelay(150);
	const position = editor.getPosition?.();
	return `${sectionId} hover at ${position?.lineNumber ?? lineNumber}:${position?.column ?? column}`;
}

async function e2eCursorFocusMarkdown(lineNumber: number, column: number): Promise<string> {
	const section = document.getElementById('cursor_markdown') as any;
	if (!section) {
		throw new Error('cursor_markdown section not found');
	}
	if (typeof section.setMarkdownMode === 'function') {
		section.setMarkdownMode('markdown');
	}
	await e2eDelay(250);
	const editorRoot = section.querySelector('.toastui-editor-defaultUI') as HTMLElement | null;
	if (!editorRoot) {
		throw new Error('Markdown editor root not found');
	}
	const text = typeof section.getText === 'function' ? String(section.getText()) : '# Cursor\n\nBody text';
	const offset = e2eCursorOffsetForLineColumn(text, lineNumber, column);
	const textarea = editorRoot.querySelector('textarea') as HTMLTextAreaElement | null;
	if (textarea) {
		textarea.focus();
		textarea.selectionStart = offset;
		textarea.selectionEnd = offset;
		textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
		await e2eDelay(150);
		return `markdown textarea caret at ${lineNumber}:${column}`;
	}
	const editable = editorRoot.querySelector('[contenteditable="true"], .ProseMirror') as HTMLElement | null;
	if (!editable) {
		throw new Error('Markdown editable surface not found');
	}
	editable.focus();
	const textNode = editable.firstChild && editable.firstChild.nodeType === Node.TEXT_NODE
		? editable.firstChild
		: document.createTextNode(text);
	if (!textNode.parentNode) {
		editable.appendChild(textNode);
	}
	const range = document.createRange();
	range.setStart(textNode, Math.min(offset, textNode.textContent?.length ?? 0));
	range.collapse(true);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	editable.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
	await e2eDelay(150);
	return `markdown editable caret at ${lineNumber}:${column}`;
}

async function e2eCursorSetHtmlPreview(): Promise<string> {
	const section = document.getElementById('cursor_html') as any;
	if (!section || typeof section.setMode !== 'function') {
		throw new Error('cursor_html section with setMode not found');
	}
	section.setMode('preview');
	await e2eDelay(200);
	return 'html preview mode set';
}

async function e2eCursorSetMarkdownPreview(): Promise<string> {
	const section = document.getElementById('cursor_markdown') as any;
	if (!section || typeof section.setMarkdownMode !== 'function') {
		throw new Error('cursor_markdown section with setMarkdownMode not found');
	}
	section.setMarkdownMode('preview');
	await e2eDelay(200);
	return 'markdown preview mode set';
}

async function e2eCursorSetKustoExpanded(expanded: boolean): Promise<string> {
	const section = document.getElementById('cursor_query') as any;
	if (!section || typeof section.setExpanded !== 'function') {
		throw new Error('cursor_query section with setExpanded not found');
	}
	section.setExpanded(!!expanded);
	await e2eDelay(200);
	return `kusto expanded=${!!expanded}`;
}

async function e2eAssertCursorStatusMessage(editorKind: string, lineNumber?: number, column?: number, visible = true, timeoutMs = 5000): Promise<string> {
	const wantedKind = String(editorKind || '').trim();
	if (!wantedKind) {
		throw new Error('editorKind is required');
	}
	const started = performance.now();
	while (performance.now() - started <= timeoutMs) {
		const messages = e2eCapturedHostMessages().filter(msg => msg?.type === 'editorCursorPositionChanged' && msg.editorKind === wantedKind);
		const match = messages.find(msg => {
			if (!!msg.visible !== visible) return false;
			if (!visible) return true;
			return msg.line === lineNumber && msg.column === column;
		});
		if (match) {
			return visible
				? `${wantedKind} cursor status captured at ${lineNumber}:${column}`
				: `${wantedKind} cursor status clear captured`;
		}
		await e2eDelay(100);
	}
	const seen = e2eCapturedHostMessages()
		.filter(msg => msg?.type === 'editorCursorPositionChanged')
		.map(msg => `${msg.editorKind}:${msg.visible === false ? 'hidden' : `${msg.line}:${msg.column}`}`)
		.join(', ');
	throw new Error(`Timed out waiting for ${wantedKind} cursor status visible=${visible} ${lineNumber ?? ''}:${column ?? ''}. Seen: ${seen}`);
}

async function e2eCursorStatusSnapshot(timeoutMs = 5000): Promise<any> {
	const requestId = `cursor-status-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return await new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			window.removeEventListener('message', onMessage);
			clearTimeout(timer);
		};
		const onMessage = (event: MessageEvent) => {
			const message = event.data || {};
			if (message.type !== 'editorCursorStatusSnapshot' || message.requestId !== requestId) {
				return;
			}
			settled = true;
			cleanup();
			resolve(message.snapshot || { visible: false, text: '' });
		};
		const timer = setTimeout(() => {
			if (!settled) {
				cleanup();
				reject(new Error(`Timed out waiting for cursor status snapshot ${requestId}`));
			}
		}, timeoutMs);
		window.addEventListener('message', onMessage);
		postMessageToHost({ type: 'getEditorCursorStatusSnapshot', requestId });
	});
}

async function e2eAssertCursorStatusBar(editorKind: string, lineNumber?: number, column?: number, visible = true, timeoutMs = 5000): Promise<string> {
	const started = performance.now();
	const wantedText = visible ? `Ln ${lineNumber}, Col ${column}` : '';
	while (performance.now() - started <= timeoutMs) {
		const snapshot = await e2eCursorStatusSnapshot(timeoutMs);
		if (!visible && snapshot.visible === false) {
			return 'host cursor status hidden';
		}
		if (visible && snapshot.visible === true && snapshot.text === wantedText && snapshot.editorKind === editorKind) {
			return `host cursor status ${snapshot.text}`;
		}
		await e2eDelay(100);
	}
	const snapshot = await e2eCursorStatusSnapshot(timeoutMs);
	throw new Error(`Expected host cursor status ${visible ? wantedText : 'hidden'} for ${editorKind}; got ${JSON.stringify(snapshot)}`);
}

function e2eAssertKustoCancelVisibleEnabled(): string {
	const button = e2eKustoCancelButton();
	const style = getComputedStyle(button);
	if (button.disabled || style.display === 'none' || style.visibility === 'hidden') {
		throw new Error(`kusto cancel button should be visible and enabled; disabled=${button.disabled}, display=${style.display}, visibility=${style.visibility}`);
	}
	return 'kusto cancel button visible and enabled';
}

async function e2eAssertKustoStillExecutingWithCancelAfter(delayMs: number): Promise<string> {
	const delay = Number(delayMs);
	if (!Number.isFinite(delay) || delay < 0) {
		throw new Error(`invalid wait duration for Kusto cancel assertion: ${delayMs}`);
	}
	await e2eDelay(delay);
	const section = e2eSection('kusto');
	const executing = section.dataset?.testExecuting;
	if (executing !== 'true') {
		const resultText = (e2eKustoResultsElement().textContent || '').trim().slice(0, 200);
		throw new Error(`expected Kusto query to still be executing after ${delay}ms, got data-test-executing=${executing}; results=${resultText}`);
	}
	e2eAssertKustoCancelVisibleEnabled();
	return `kusto query still executing after ${delay}ms with cancel active`;
}

function e2eAssertKustoCancelHiddenDisabled(): string {
	const button = e2eKustoCancelButton();
	const style = getComputedStyle(button);
	if (!button.disabled && style.display !== 'none' && style.visibility !== 'hidden') {
		throw new Error('kusto cancel button should be hidden or disabled');
	}
	return 'kusto cancel button hidden or disabled';
}

function e2eClickKustoCancel(): string {
	e2eAssertKustoCancelVisibleEnabled();
	e2eKustoCancelButton().click();
	return 'kusto cancel clicked';
}

function e2eAssertKustoNotStuck(): string {
	const section = e2eSection('kusto');
	const executing = section.dataset?.testExecuting;
	if (executing !== 'false') {
		throw new Error(`kusto section is still executing: data-test-executing=${executing}`);
	}
	e2eAssertKustoCancelHiddenDisabled();
	return 'kusto section is not stuck';
}

function e2eAssertKustoCancelledText(): string {
	const text = e2eKustoResultsElement().textContent || '';
	if (!/Cancelled\./i.test(text)) {
		throw new Error(`expected Cancelled. text, got: ${text.slice(0, 200)}`);
	}
	return 'kusto cancelled text visible';
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
		if (hit && (hit === element || element.contains(hit))) {
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
	if (editorSelector) {
		try {
			const { editor } = resolveMonacoEditorFromSelector(editorSelector);
			const editorWidget = __kustoFindSuggestWidgetForEditor(editor, { requireVisible: true, maxDistancePx: 480 }) as HTMLElement | null;
			if (editorWidget && e2eIsVisibleElement(editorWidget)) {
				return [editorWidget];
			}
		} catch {
			// Fall through to DOM traversal below for non-Monaco callers and diagnostics.
		}
	}
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
	try { editor.trigger?.('keyboard', 'hideSuggestWidget', {}); } catch { /* ignore */ }
	return `${kind} suggest hide requested`;
}

function e2eAssertNoBlockingDialog(context: string): void {
	try {
		const text = String(document.body?.textContent || '');
		const suspicious = [
			'wants to sign in using microsoft',
			'failed to load database list',
			'sign in',
		];
		const lower = text.toLowerCase();
		const hit = suspicious.find(value => lower.includes(value));
		if (hit) {
			throw new Error(`${context}: blocking dialog/notification present (${hit})`);
		}
	} catch (error) {
		if (error instanceof Error) throw error;
	}
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

function e2eActuallyVisibleSuggestLabels(context: string, editorSelector: string = ''): string[] {
	const contextLabel = String(context || 'suggestions');
	e2eAssertNoBlockingDialog(contextLabel);
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
	const widgetRect = widget.getBoundingClientRect();
	const listViewport = (widget.querySelector('.monaco-list') || widget.querySelector('.tree') || widget) as HTMLElement;
	const viewportRect = listViewport.getBoundingClientRect ? listViewport.getBoundingClientRect() : widgetRect;
	const clip = {
		top: Math.max(widgetRect.top, viewportRect.top),
		bottom: Math.min(widgetRect.bottom, viewportRect.bottom),
		left: Math.max(widgetRect.left, viewportRect.left),
		right: Math.min(widgetRect.right, viewportRect.right),
	};
	const rows = (Array.from(widget.querySelectorAll('.monaco-list-row')) as HTMLElement[])
		.filter(row => {
			if (!e2eIsVisibleElement(row)) return false;
			const rect = row.getBoundingClientRect();
			const verticalOverlap = Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top);
			const horizontalOverlap = Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left);
			return verticalOverlap > 2 && horizontalOverlap > 2;
		});
	const labels = rows
		.map(row => row.querySelector('.label-name') as HTMLElement | null)
		.filter(labelElement => labelElement ? e2eIsVisibleElement(labelElement) : false)
		.map(labelElement => (labelElement?.textContent || '').trim())
		.filter(Boolean);
	if (labels.length === 0) {
		throw new Error(`${contextLabel}: expected actually visible suggestions, got 0 labels. Text: ${widgetText.slice(0, 200)}`);
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

function e2eNormalizeSuggestColumnLabel(value: string): string {
	let label = String(value || '').trim();
	label = label.replace(/^(\x1b\[[0-9;]*m)+/g, '');
	label = label.replace(/^(\x00|\[|\{|"|')+/, '').replace(/(\]|\}|"|')+$/, '');
	return label.trim().toLowerCase();
}

function e2eAssertVisibleSuggestExact(context: string, expectedAnyCsv: string, editorSelector: string = ''): string {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedAnyCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const labels = e2eActuallyVisibleSuggestLabels(contextLabel, editorSelector);
	if (expected.length) {
		const normalizedLabels = labels.map(label => e2eNormalizeSuggestLabel(label));
		const matched = expected.some(candidate => normalizedLabels.includes(e2eNormalizeSuggestLabel(candidate)));
		if (!matched) {
			throw new Error(`${contextLabel}: expected exact one of [${expected.join(', ')}], got: ${labels.slice(0, 20).join(', ')}`);
		}
	}
	return `${contextLabel}(${labels.length}): ${labels.slice(0, 15).join(', ')}`;
}

function e2eAssertVisibleSuggestAll(context: string, expectedCsv: string, editorSelector: string = ''): string {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const labels = e2eVisibleSuggestLabels(contextLabel, editorSelector);
	if (expected.length) {
		const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestLabel(label)));
		const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestLabel(candidate)));
		if (missing.length) {
			throw new Error(`${contextLabel}: missing expected suggestions [${missing.join(', ')}], got: ${labels.slice(0, 20).join(', ')}`);
		}
	}
	return `${contextLabel} all(${labels.length}): ${labels.slice(0, 15).join(', ')}`;
}

function e2eAssertVisibleSuggestAllColumns(context: string, expectedCsv: string, editorSelector: string = ''): string {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const labels = e2eVisibleSuggestLabels(contextLabel, editorSelector);
	if (expected.length) {
		const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
		const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
		if (missing.length) {
			throw new Error(`${contextLabel}: missing expected column suggestions [${missing.join(', ')}], got: ${labels.slice(0, 20).join(', ')}`);
		}
	}
	return `${contextLabel} columns(${labels.length}): ${labels.slice(0, 15).join(', ')}`;
}

function e2eAssertVisibleSuggestAllColumnsInRenderedRows(context: string, expectedCsv: string, editorSelector: string = ''): string {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const labels = e2eActuallyVisibleSuggestLabels(contextLabel, editorSelector);
	if (expected.length) {
		const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
		const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
		if (missing.length) {
			throw new Error(`${contextLabel}: missing expected column suggestions in rendered dropdown rows [${missing.join(', ')}], got rendered rows: ${labels.slice(0, 40).join(', ')}`);
		}
	}
	return `${contextLabel} rendered columns(${labels.length}): ${labels.slice(0, 20).join(', ')}`;
}

async function e2eWaitForVisibleSuggestAllColumnsInRenderedRows(context: string, expectedCsv: string = '', timeoutMs: number = 5000): Promise<any> {
	let lastError: unknown;
	const started = performance.now();
	while (performance.now() - started <= timeoutMs) {
		try {
			const result = e2eAssertVisibleSuggestAllColumnsInRenderedRows(context, expectedCsv, E2E_SECTION.kusto.editor);
			e2eAssertNoSuggestLoading(`${context} loading check`, E2E_SECTION.kusto.editor);
			return { elapsedMs: performance.now() - started, result };
		} catch (error) {
			lastError = error;
			await e2eDelay(50);
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError || 'timed out');
	throw new Error(`${context}: no matching rendered column suggestion set within ${timeoutMs}ms: ${message}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
}

async function e2eAssertFirstStableRenderedSuggestColumns(context: string, expectedCsv: string = '', timeoutMs: number = 5000): Promise<any> {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const started = performance.now();
	let lastError: unknown;
	while (performance.now() - started <= timeoutMs) {
		try {
			const labels = e2eActuallyVisibleSuggestLabels(contextLabel, E2E_SECTION.kusto.editor);
			e2eAssertNoSuggestLoading(`${contextLabel} loading check`, E2E_SECTION.kusto.editor);
			const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
			const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
			if (missing.length) {
				throw new Error(`${contextLabel}: first stable rendered dropdown missing [${missing.join(', ')}], got rendered rows: ${labels.slice(0, 40).join(', ')}`);
			}
			return { elapsedMs: performance.now() - started, labels };
		} catch (error) {
			lastError = error;
			const message = error instanceof Error ? error.message : String(error || '');
			if (/first stable rendered dropdown missing/.test(message)) {
				throw new Error(`${message}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
			}
			await e2eDelay(50);
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError || 'timed out');
	throw new Error(`${contextLabel}: no stable rendered dropdown within ${timeoutMs}ms: ${message}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
}

function e2eRenderedSuggestLabelsSnapshot(context: string, editorSelector: string = E2E_SECTION.kusto.editor): string[] {
	const widgets = e2eVisibleSuggestWidgets(context, editorSelector);
	if (!widgets.length) return [];
	const widget = widgets[widgets.length - 1];
	const widgetRect = widget.getBoundingClientRect();
	const listViewport = (widget.querySelector('.monaco-list') || widget.querySelector('.tree') || widget) as HTMLElement;
	const viewportRect = listViewport.getBoundingClientRect ? listViewport.getBoundingClientRect() : widgetRect;
	const clip = {
		top: Math.max(widgetRect.top, viewportRect.top),
		bottom: Math.min(widgetRect.bottom, viewportRect.bottom),
		left: Math.max(widgetRect.left, viewportRect.left),
		right: Math.min(widgetRect.right, viewportRect.right),
	};
	return (Array.from(widget.querySelectorAll('.monaco-list-row')) as HTMLElement[])
		.filter(row => {
			if (!e2eIsVisibleElement(row)) return false;
			const rect = row.getBoundingClientRect();
			return (Math.min(rect.bottom, clip.bottom) - Math.max(rect.top, clip.top)) > 2
				&& (Math.min(rect.right, clip.right) - Math.max(rect.left, clip.left)) > 2;
		})
		.map(row => row.querySelector('.label-name') as HTMLElement | null)
		.filter(labelElement => labelElement ? e2eIsVisibleElement(labelElement) : false)
		.map(labelElement => (labelElement?.textContent || '').trim())
		.filter(Boolean);
}

async function e2eAssertFirstRenderedColumnsAfterRawCtrlSpace(selector: string, context: string, expectedCsv: string = '', timeoutMs: number = 5000): Promise<any> {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const started = performance.now();
	let labels: string[] = [];
	let traceId = '';
	let dispatchResult = '';
	let attempts = 0;
	while (performance.now() - started <= timeoutMs) {
		e2eHideSuggest('kusto');
		await e2eDelay(100);
		try { if (typeof _win.__kustoClearAutocompleteTrace === 'function') _win.__kustoClearAutocompleteTrace(); } catch { /* ignore */ }
		try { _win.__e2eLastRawCtrlSpaceTraceId = ''; } catch { /* ignore */ }
		const previousTraceId = String(_win.__kustoLastAutocompleteTraceId || '');
		dispatchResult = _win.__testDispatchRawCtrlSpaceMonaco(selector);
		attempts++;
		const attemptStarted = performance.now();
		const attemptTimeoutMs = Math.min(2500, Math.max(500, timeoutMs - (attemptStarted - started)));
		while (performance.now() - attemptStarted <= attemptTimeoutMs) {
			traceId = String(_win.__kustoLastAutocompleteTraceId || '');
			labels = e2eRenderedSuggestLabelsSnapshot(contextLabel, E2E_SECTION.kusto.editor);
			if (traceId && traceId !== previousTraceId && labels.length) break;
			await e2eDelay(25);
		}
		if (traceId && traceId !== previousTraceId && labels.length) break;
		await e2eDelay(250);
	}
	if (!traceId) {
		throw new Error(`${contextLabel}: raw Ctrl+Space did not create an autocomplete trace after ${attempts} attempt(s); dispatch=${dispatchResult}`);
	}
	if (!labels.length) {
		throw new Error(`${contextLabel}: raw Ctrl+Space produced no rendered suggestion rows after ${attempts} attempt(s); dispatch=${dispatchResult}; trace=${JSON.stringify(e2eCompactAutocompleteTrace(traceId)).slice(0, 4000)}`);
	}
	const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
	const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
	if (missing.length) {
		throw new Error(`${contextLabel}: first rendered Ctrl+Space dropdown missing [${missing.join(', ')}], got rendered rows: ${labels.slice(0, 40).join(', ')}; dispatch=${dispatchResult}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
	}
	try { _win.__e2eLastRawCtrlSpaceTraceId = traceId; } catch { /* ignore */ }
	return { elapsedMs: performance.now() - started, dispatchResult, attempts, traceId, labels };
}

async function e2eAssertAllRenderedSnapshotsHaveColumns(context: string, expectedCsv: string = '', durationMs: number = 2500, intervalMs: number = 100): Promise<any> {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const snapshots: Array<{ elapsedMs: number; labels: string[] }> = [];
	const started = performance.now();
	while (performance.now() - started <= durationMs) {
		const labels = e2eRenderedSuggestLabelsSnapshot(contextLabel, E2E_SECTION.kusto.editor);
		if (labels.length) {
			const elapsedMs = performance.now() - started;
			snapshots.push({ elapsedMs, labels });
			const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
			const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
			if (missing.length) {
				throw new Error(`${contextLabel}: rendered dropdown snapshot at ${Math.round(elapsedMs)}ms missing [${missing.join(', ')}], got rows: ${labels.slice(0, 40).join(', ')}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
			}
		}
		await e2eDelay(intervalMs);
	}
	if (!snapshots.length) {
		throw new Error(`${contextLabel}: no rendered suggestion snapshots in ${durationMs}ms; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
	}
	return { snapshots: snapshots.map(snapshot => ({ elapsedMs: Math.round(snapshot.elapsedMs), labels: snapshot.labels.slice(0, 40) })) };
}

async function e2eAssertRenderedSnapshotsExcludeColumns(context: string, excludedCsv: string = '', durationMs: number = 1500, intervalMs: number = 100, requireSnapshot: boolean = true): Promise<any> {
	const contextLabel = String(context || 'suggestions');
	const excluded = String(excludedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const snapshots: Array<{ elapsedMs: number; labels: string[] }> = [];
	const started = performance.now();
	while (performance.now() - started <= durationMs) {
		const labels = e2eRenderedSuggestLabelsSnapshot(contextLabel, E2E_SECTION.kusto.editor);
		if (labels.length) {
			const elapsedMs = performance.now() - started;
			snapshots.push({ elapsedMs, labels });
			const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
			const present = excluded.filter(candidate => normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
			if (present.length) {
				throw new Error(`${contextLabel}: rendered dropdown snapshot at ${Math.round(elapsedMs)}ms unexpectedly included [${present.join(', ')}], rows: ${labels.slice(0, 40).join(', ')}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
			}
		}
		await e2eDelay(intervalMs);
	}
	if (requireSnapshot && !snapshots.length) {
		throw new Error(`${contextLabel}: no rendered suggestion snapshots in ${durationMs}ms; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
	}
	return { snapshots: snapshots.map(snapshot => ({ elapsedMs: Math.round(snapshot.elapsedMs), labels: snapshot.labels.slice(0, 40) })) };
}

async function e2eAssertRenderedSnapshotsIncludeAndExcludeColumns(context: string, expectedCsv: string = '', excludedCsv: string = '', durationMs: number = 1500, intervalMs: number = 100): Promise<any> {
	const contextLabel = String(context || 'suggestions');
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const excluded = String(excludedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const snapshots: Array<{ elapsedMs: number; labels: string[] }> = [];
	const started = performance.now();
	while (performance.now() - started <= durationMs) {
		const labels = e2eRenderedSuggestLabelsSnapshot(contextLabel, E2E_SECTION.kusto.editor);
		if (labels.length) {
			const elapsedMs = performance.now() - started;
			snapshots.push({ elapsedMs, labels });
			const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
			const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
			const present = excluded.filter(candidate => normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
			if (!missing.length && !present.length) {
				return { snapshots: snapshots.map(snapshot => ({ elapsedMs: Math.round(snapshot.elapsedMs), labels: snapshot.labels.slice(0, 40) })) };
			}
			if (present.length) {
				throw new Error(`${contextLabel}: rendered dropdown snapshot at ${Math.round(elapsedMs)}ms unexpectedly included [${present.join(', ')}], rows: ${labels.slice(0, 40).join(', ')}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
			}
		}
		await e2eDelay(intervalMs);
	}
	if (!snapshots.length) {
		throw new Error(`${contextLabel}: no rendered suggestion snapshots in ${durationMs}ms; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
	}
	const last = snapshots[snapshots.length - 1];
	const normalizedLabels = new Set(last.labels.map(label => e2eNormalizeSuggestColumnLabel(label)));
	const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestColumnLabel(candidate)));
	throw new Error(`${contextLabel}: no rendered dropdown snapshot included [${expected.join(', ')}] while excluding [${excluded.join(', ')}]; last missing [${missing.join(', ')}], rows: ${last.labels.slice(0, 40).join(', ')}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
}

async function e2eAssertRawCtrlSpaceDoesNotRenderColumns(selector: string, context: string, excludedCsv: string = '', durationMs: number = 1000, intervalMs: number = 100): Promise<any> {
	const contextLabel = String(context || 'suggestions');
	e2eHideSuggest('kusto');
	await e2eDelay(100);
	try { if (typeof _win.__kustoClearAutocompleteTrace === 'function') _win.__kustoClearAutocompleteTrace(); } catch { /* ignore */ }
	try { _win.__e2eLastRawCtrlSpaceTraceId = ''; } catch { /* ignore */ }
	const previousTraceId = String(_win.__kustoLastAutocompleteTraceId || '');
	const dispatchResult = _win.__testDispatchRawCtrlSpaceMonaco(selector);
	const started = performance.now();
	let traceId = '';
	while (performance.now() - started <= Math.max(500, durationMs)) {
		traceId = String(_win.__kustoLastAutocompleteTraceId || '');
		if (traceId && traceId !== previousTraceId) break;
		await e2eDelay(25);
	}
	if (!traceId || traceId === previousTraceId) {
		throw new Error(`${contextLabel}: raw Ctrl+Space did not create a fresh autocomplete trace; dispatch=${dispatchResult}; previousTraceId=${previousTraceId}; currentTraceId=${traceId}`);
	}
	try { _win.__e2eLastRawCtrlSpaceTraceId = traceId; } catch { /* ignore */ }
	const result = await e2eAssertRenderedSnapshotsExcludeColumns(contextLabel, excludedCsv, durationMs, intervalMs, false);
	return { dispatchResult, traceId, ...result };
}

function e2eProofId(name: string): string {
	const normalized = String(name || 'proof').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	return `e2e-proof-${normalized || 'proof'}`;
}

function e2eClearProofMarker(name: string): string {
	const id = e2eProofId(name);
	try { document.getElementById(id)?.remove(); } catch { /* ignore */ }
	return id;
}

function e2eSetProofMarker(name: string, detail?: unknown): string {
	const id = e2eClearProofMarker(name);
	const marker = document.createElement('div');
	marker.id = id;
	marker.setAttribute('data-testid', id);
	marker.hidden = true;
	try { marker.textContent = JSON.stringify(detail ?? { ok: true }).slice(0, 2000); } catch { marker.textContent = 'ok'; }
	document.body.appendChild(marker);
	return id;
}

function e2eCompactAutocompleteTrace(traceId?: string): any {
	try {
		return typeof _win.__kustoCompactAutocompleteTrace === 'function' ? _win.__kustoCompactAutocompleteTrace(traceId) : null;
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function e2eAssertAutocompleteTraceEvents(context: string, requiredCsv: string = '', forbiddenCsv: string = ''): any {
	const contextLabel = String(context || 'autocomplete trace');
	const trace = e2eCompactAutocompleteTrace();
	if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
		throw new Error(`${contextLabel}: compact autocomplete trace is unavailable: ${JSON.stringify(trace)}`);
	}
	const events = Array.isArray(trace.events) ? trace.events : [];
	const names = events.map((event: any) => String(event?.event || '')).filter(Boolean);
	const required = String(requiredCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const forbidden = String(forbiddenCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const missing = required.filter(name => !names.includes(name));
	if (missing.length) {
		throw new Error(`${contextLabel}: missing trace events [${missing.join(', ')}], got [${names.join(', ')}]; trace=${JSON.stringify(trace).slice(0, 4000)}`);
	}
	const presentForbidden = forbidden.filter(name => names.includes(name));
	if (presentForbidden.length) {
		throw new Error(`${contextLabel}: unexpected trace events [${presentForbidden.join(', ')}], got [${names.join(', ')}]; trace=${JSON.stringify(trace).slice(0, 4000)}`);
	}
	const status = String((trace as any).status || '');
	if (status && status !== 'success' && status !== 'active') {
		throw new Error(`${contextLabel}: expected active/success trace status, got ${status}; trace=${JSON.stringify(trace).slice(0, 4000)}`);
	}
	return { status, events: names };
}

async function e2eMarkAutocompleteTraceEvents(proofName: string, context: string, requiredCsv: string = '', forbiddenCsv: string = '', timeoutMs: number = 5000): Promise<any> {
	let lastError: unknown;
	const started = performance.now();
	while (performance.now() - started <= timeoutMs) {
		try {
			const result = e2eAssertAutocompleteTraceEvents(context, requiredCsv, forbiddenCsv);
			const markerId = e2eSetProofMarker(proofName, result);
			return { markerId, ...result };
		} catch (error) {
			lastError = error;
			await e2eDelay(50);
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError || 'timed out');
	throw new Error(`${context}: trace events did not satisfy requirements within ${timeoutMs}ms: ${message}`);
}

function e2eMarkAutocompleteTraceSanitized(proofName: string, context: string = 'autocomplete trace'): any {
	const result = e2eAssertAutocompleteTraceSanitized(context);
	const markerId = e2eSetProofMarker(proofName, result);
	return { markerId, ...result };
}

function e2eAssertAutocompleteTraceSanitized(context: string = 'autocomplete trace'): any {
	const contextLabel = String(context || 'autocomplete trace');
	const traces = [e2eCompactAutocompleteTrace(), typeof _win.__kustoGetAutocompleteTrace === 'function' ? _win.__kustoGetAutocompleteTrace(_win.__kustoLastAutocompleteTraceId) : null];
	const payloads = traces.filter(trace => trace && typeof trace === 'object' && !Array.isArray(trace));
	if (!payloads.length) {
		throw new Error(`${contextLabel}: no autocomplete trace payloads available to sanitize`);
	}
	const hasTraceEvents = payloads.some((trace: any) => Array.isArray(trace.events) && trace.events.some((event: any) => String(event?.event || '') === 'trace-start' || String(event?.event || '') === 'trigger-start'));
	if (!hasTraceEvents) {
		throw new Error(`${contextLabel}: autocomplete trace payloads have no trace-start/trigger-start events: ${JSON.stringify(payloads).slice(0, 2000)}`);
	}
	const text = JSON.stringify(payloads);
	if (!text) {
		throw new Error(`${contextLabel}: trace payload is empty`);
	}
	const forbiddenKeys = new Set(['rawschemajson', 'schemaobj', 'query', 'querytext', 'fulltext', 'textbefore', 'textafter', 'value', 'valuepreview', 'currentline', 'linenearcursor', 'wordnearcursor', 'widgetcontent', 'token', 'accesstoken', 'idtoken', 'password', 'secret', 'authorization', 'connectionstring', 'apikey', 'sas']);
	const foundKeys: string[] = [];
	const visit = (value: unknown): void => {
		if (!value || typeof value !== 'object') return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (forbiddenKeys.has(String(key || '').toLowerCase())) foundKeys.push(key);
			visit(child);
		}
	};
	for (const trace of payloads) visit(trace);
	if (foundKeys.length) {
		throw new Error(`${contextLabel}: trace leaked forbidden keys [${Array.from(new Set(foundKeys)).join(', ')}]; trace=${text.slice(0, 4000)}`);
	}
	for (const sentinel of ['semantic-current', 'semantic-remote', 'TelemetryDb', 'LocalDb', 'RemoteOnly', 'env_dt_traceId', 'agent.remoteOnly']) {
		if (text.toLowerCase().includes(sentinel.toLowerCase())) {
			throw new Error(`${contextLabel}: trace leaked query-derived sentinel ${sentinel}; trace=${text.slice(0, 4000)}`);
		}
	}
	const stringMatches = text.match(/"(?:\\.|[^"\\])*"/g) || [];
	const oversized = stringMatches
		.map(value => value.slice(1, -1))
		.filter(value => value.length > 820 && !value.includes('[redacted]'));
	if (oversized.length) {
		throw new Error(`${contextLabel}: trace contains oversized string length(s) ${oversized.map(value => value.length).join(', ')}`);
	}
	return { checkedPayloads: payloads.length, bytes: text.length };
}

function e2eAssertPerfSnapshot(kind: 'host' | 'webview', expectedLabelOrPrefix: string, requiredCsv: string = ''): any {
	const expected = String(expectedLabelOrPrefix || '').trim();
	const required = String(requiredCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	const snapshot = kind === 'host'
		? (((globalThis as any).__kustoPerf && typeof (globalThis as any).__kustoPerf.snapshot === 'function') ? (globalThis as any).__kustoPerf.snapshot() : null)
		: perfSnapshot();
	if (!snapshot || typeof snapshot !== 'object') {
		throw new Error(`${kind} perf snapshot unavailable`);
	}
	let marks: any[] = [];
	let label = '';
	if (kind === 'host') {
		if ((snapshot as any).enabled !== true) {
			throw new Error('host perf snapshot is disabled; run with KUSTO_WORKBENCH_PERF=1');
		}
		const current = (snapshot as any).current;
		if (!current || typeof current !== 'object') {
			throw new Error(`host perf current trace missing: ${JSON.stringify(snapshot).slice(0, 2000)}`);
		}
		label = String(current.label || '');
		marks = Array.isArray(current.marks) ? current.marks : [];
	} else {
		marks = Array.isArray((snapshot as any).marks) ? (snapshot as any).marks : [];
		label = 'webview';
	}
	if (expected && kind === 'host' && label !== expected) {
		throw new Error(`host perf current label mismatch: expected ${expected}, got ${label}; snapshot=${JSON.stringify(snapshot).slice(0, 2000)}`);
	}
	const names = marks.map(mark => String(mark?.name || '')).filter(Boolean);
	const missing = required.filter(name => !names.includes(name));
	if (missing.length) {
		throw new Error(`${kind} perf missing required marks [${missing.join(', ')}], got [${names.join(', ')}]; snapshot=${JSON.stringify(snapshot).slice(0, 3000)}`);
	}
	const measures = kind === 'webview' ? ((snapshot as any).measures || {}) : {};
	if (kind === 'webview') {
		for (const measure of ['documentDataToRestoreEndMs', 'documentDataToFirstQuerySectionMs', 'documentDataToFirstQueryEditorReadyMs']) {
			if (required.includes('webview.monaco.queryEditor.ready') && typeof measures[measure] !== 'number') {
				throw new Error(`webview perf missing measure ${measure}; snapshot=${JSON.stringify(snapshot).slice(0, 3000)}`);
			}
		}
	}
	return { label, marks: names, measures };
}

function e2eMarkPerfSnapshot(proofName: string, kind: 'host' | 'webview', expectedLabelOrPrefix: string, requiredCsv: string = ''): any {
	const result = e2eAssertPerfSnapshot(kind, expectedLabelOrPrefix, requiredCsv);
	const markerId = e2eSetProofMarker(proofName, result);
	return { markerId, ...result };
}

function e2eSuggestDiagnostics(context: string, editorSelector: string = E2E_SECTION.kusto.editor, sectionIndex: number = 0): any {
	const strictJson = (value: any): any => {
		if (Array.isArray(value)) return value.map(strictJson);
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value)
				.filter(([, child]) => child !== undefined && typeof child !== 'function')
				.map(([key, child]) => [key, strictJson(child)]));
		}
		return value;
	};
	const contextLabel = String(context || 'suggestions');
	let editor: MonacoLike | null = null;
	let boxId = '';
	let position: any = null;
	let modelUri = '';
	let value = '';
	try {
		const sections = Array.from(document.querySelectorAll('kw-query-section')) as any[];
		const section = sections[sectionIndex];
		const sectionBoxId = String(section?.boxId || section?.id || '');
		editor = sectionBoxId ? _win.queryEditors?.[sectionBoxId] || null : e2eEditor('kusto');
		if (!editor) throw new Error(`Kusto editor ${sectionIndex} not found`);
		boxId = e2eGetEditorBoxId(editor);
		position = editor.getPosition?.() || null;
		modelUri = editor.getModel?.()?.uri?.toString?.() || '';
		value = editor.getValue?.() || '';
	} catch (error) {
		// Keep diagnostics best-effort; the caller will include the error text below.
	}
	const widgets = (() => {
		try {
			return e2eVisibleSuggestWidgets(contextLabel, editorSelector).map(widget => {
				const rows = (Array.from(widget.querySelectorAll('.monaco-list-row')) as HTMLElement[])
					.filter(row => e2eIsVisibleElement(row));
				const labels = rows
					.map(row => row.querySelector('.label-name') as HTMLElement | null)
					.filter(labelElement => labelElement ? e2eIsVisibleElement(labelElement) : false)
					.map(labelElement => (labelElement?.textContent || '').trim())
					.filter(Boolean);
				return {
					textLength: String(widget.textContent || '').length,
					labelCount: labels.length,
					hasLoading: /\bloading\b/i.test(widget.textContent || ''),
					hasNoSuggestions: /no suggestions/i.test(widget.textContent || ''),
					rowCount: rows.length,
				};
			});
		} catch (error) {
			return [{ errorType: error instanceof Error ? error.name : 'Error' }];
		}
	})();
	const markers = (() => {
		try {
			const monacoApi = _win.monaco;
			const model = editor?.getModel?.() as any;
			const resource = model?.uri;
			if (!monacoApi?.editor?.getModelMarkers || !resource) return [];
			return (monacoApi.editor.getModelMarkers({ resource }) || []).map((marker: any) => ({
				owner: String(marker.owner || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 40),
				code: String(typeof marker.code === 'object' ? marker.code?.value || '' : marker.code || '').replace(/[^a-z0-9_.-]/gi, '').slice(0, 40),
				severity: marker.severity,
				startLineNumber: marker.startLineNumber,
				startColumn: marker.startColumn,
				endLineNumber: marker.endLineNumber,
				endColumn: marker.endColumn,
			}));
		} catch (error) {
			return [{ errorType: error instanceof Error ? error.name : 'Error' }];
		}
	})();
	const schemaKeys = _win.schemaByBoxId ? Object.keys(_win.schemaByBoxId) : [];
	const workerReady = _win.schemaWorkerReadyByBoxId?.[boxId] || null;
	return {
		contextId: kustoSupplementalTraceId(contextLabel),
		boxId: kustoSupplementalTraceId(boxId),
		position,
		modelId: kustoSupplementalTraceId(modelUri),
		valueLength: value.length,
		currentLineLength: position && value ? String(value.split(/\r?\n/)[Math.max(0, position.lineNumber - 1)] || '').length : 0,
		widgets,
		markers,
		schemaKeyCount: schemaKeys.length,
		schemaKeyIds: schemaKeys.map(kustoSupplementalTraceId),
		schemaWorkerReady: workerReady ? {
			status: workerReady.status,
			schemaId: kustoSupplementalTraceId(String(workerReady.schemaKey || '')),
			modelId: kustoSupplementalTraceId(String(workerReady.modelUri || '')),
		} : null,
		crossClusterSchemas: Object.entries(__kustoCrossClusterSchemas || {}).map(([key, entry]: [string, any]) => ({
			schemaId: kustoSupplementalTraceId(key),
			status: entry?.status ?? null,
			deliverySource: entry?.deliverySource ?? null,
			requestSource: entry?.requestSource ?? null,
			failureKind: entry?.failureKind ?? null,
			hasRawSchema: !!entry?.rawSchemaJson,
			revision: Number(entry?.revision || 0),
		})),
		crossClusterTrace: strictJson(typeof _win.__kustoGetCrossClusterTrace === 'function' ? _win.__kustoGetCrossClusterTrace() : []),
		supplementalSchemas: __kustoGetSupplementalSchemaSnapshot(modelUri),
		autocompleteTrace: strictJson(e2eCompactAutocompleteTrace()),
	};
}

async function e2eKustoLiveSemanticDiagnostics(context: string = 'live semantic diagnostics'): Promise<any> {
	const editor = e2eEditor('kusto') as any;
	const boxId = e2eGetEditorBoxId(editor);
	const model = editor?.getModel?.();
	const position = editor?.getPosition?.();
	let triggered = false;
	try {
		if (boxId && typeof _win.__kustoTriggerAutocompleteForBoxId === 'function') {
			triggered = await _win.__kustoTriggerAutocompleteForBoxId(boxId);
		}
	} catch {
		triggered = false;
	}
	await e2eDelay(500);
	return {
		...e2eSuggestDiagnostics(context, E2E_SECTION.kusto.editor),
		triggered,
		position,
		boxId,
		valueLength: String(model?.getValue?.() || '').length,
	};
}

function e2eSuggestDiagnosticsText(context: string, editorSelector: string = E2E_SECTION.kusto.editor): string {
	try {
		return JSON.stringify(e2eSuggestDiagnostics(context, editorSelector));
	} catch (error) {
		return JSON.stringify({ context, diagnosticsError: error instanceof Error ? error.message : String(error) });
	}
}

function e2eVisibleSuggestLabelsWithInternalFallback(context: string, editorSelector: string = E2E_SECTION.kusto.editor): string[] {
	try {
		const labels = e2eVisibleSuggestLabels(context, editorSelector);
		if (labels.length) {
			return labels;
		}
	} catch {
		// Fall through to internal best-effort list extraction for diagnostics and virtualized rows.
	}
	const labels: string[] = [];
	try {
		const editor = e2eEditor('kusto') as any;
		const ctrl = typeof editor.getContribution === 'function' ? editor.getContribution('editor.contrib.suggestController') : null;
		const candidates: any[] = [];
		try { if (ctrl?._widget) candidates.push(ctrl._widget); } catch { /* ignore */ }
		try { if (ctrl?.widget) candidates.push(ctrl.widget); } catch { /* ignore */ }
		try { if (ctrl?._suggestWidget) candidates.push(ctrl._suggestWidget); } catch { /* ignore */ }
		try { if (ctrl?.suggestWidget) candidates.push(ctrl.suggestWidget); } catch { /* ignore */ }
		for (const widget of candidates) {
			const unwrapped = widget?.value || widget;
			const list = unwrapped?._list || unwrapped?.list || unwrapped?._tree || unwrapped?.tree;
			if (!list) continue;
			const model = list._model || list.model;
			const length = Math.max(0, Number(list.length || list.getLength?.() || model?.length || model?.size || model?.getLength?.() || model?.getSize?.() || 0));
			const limit = Math.min(length, 5000);
			for (let index = 0; index < limit; index++) {
				let element: any = null;
				try { element = list.element?.(index) ?? list.getElementAt?.(index) ?? model?.get?.(index) ?? model?.element?.(index) ?? model?.getElementAt?.(index); } catch { element = null; }
				const completion = element?.completion || element?.suggestion || element?.item || element?._item || element?._completionItem || element;
				const labelValue = completion?.label || completion?.textLabel || completion?.insertText || completion?.filterText || element?.label || '';
				const label = typeof labelValue === 'string' ? labelValue : (labelValue?.label || '');
				if (label) labels.push(String(label));
			}
		}
	} catch { /* ignore */ }
	return Array.from(new Set(labels));
}

function e2eVisibleSuggestLabelsWithDiagnostics(context: string, editorSelector: string = E2E_SECTION.kusto.editor): string[] {
	try {
		return e2eVisibleSuggestLabels(context, editorSelector);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${e2eSuggestDiagnosticsText(context, editorSelector)}`);
	}
}

function e2eBuildShowSchema(
	database: string,
	tables: Record<string, Record<string, string>>,
	functions: Record<string, { columns: Record<string, string>; body?: string }> = {}
): any {
	const dbTables: Record<string, any> = {};
	for (const [tableName, columns] of Object.entries(tables)) {
		const orderedColumns: Record<string, any> = {};
		let ordinal = 0;
		for (const [columnName, type] of Object.entries(columns)) {
			orderedColumns[columnName] = {
				Name: columnName,
				Type: type,
				CslType: type,
				Ordinal: ordinal++,
			};
		}
		dbTables[tableName] = {
			Name: tableName,
			EntityType: 'Table',
			OrderedColumns: orderedColumns,
			Docstring: '',
			Folder: '',
		};
	}
	const dbFunctions: Record<string, any> = {};
	for (const [functionName, info] of Object.entries(functions)) {
		const columns: any[] = [];
		for (const [columnName, type] of Object.entries(info.columns || {})) {
			columns.push({
				Name: columnName,
				Type: type,
				CslType: type,
			});
		}
		dbFunctions[functionName] = {
			Name: functionName,
			InputParameters: [],
			OutputColumns: columns,
			FunctionKind: 'Unknown',
			DocString: '',
			Folder: '',
		};
		if (info.body) {
			dbFunctions[functionName].Body = info.body;
		}
	}
	return {
		Plugins: [],
		Databases: {
			[database]: {
				Name: database,
				Tables: dbTables,
				Functions: dbFunctions,
				MaterializedViews: {},
			},
		},
	};
}

function e2eCompactSchemaFromTables(tables: Record<string, Record<string, string>>, rawSchemaJson: any): any {
	return {
		tables: Object.keys(tables),
		columnTypesByTable: tables,
		functions: [],
		rawSchemaJson,
	};
}

async function e2eApplyKustoSemanticFixture(): Promise<string> {
	try { if (typeof _win.__kustoClearCrossClusterTrace === 'function') _win.__kustoClearCrossClusterTrace(); } catch { /* ignore */ }
	const section = e2eSection('kusto');
	const boxId = String(section.boxId || section.id || '').trim();
	const editor = e2eEditor('kusto');
	const modelUri = editor.getModel?.()?.uri?.toString?.() || '';
	if (!boxId || !modelUri) {
		throw new Error(`Cannot apply semantic fixture: boxId=${boxId || '(none)'} modelUri=${modelUri || '(none)'}`);
	}
	const primaryClusterUrl = 'https://local-semantic-test.kusto.windows.net';
	const primaryDatabase = 'LocalDb';
	const primaryTables = {
		LocalOnly: {
			LocalOnlyColumn: 'string',
			WrongTimestamp: 'datetime',
		},
	};
	const remoteClusterName = 'semantic-remote.westus.kusto.windows.net';
	const remoteClusterUrl = 'semantic-remote.westus';
	const remoteDatabase = 'TelemetryDb';
	const remoteTables = {
		Events: {
			TIMESTAMP: 'datetime',
			TIMESTAMP_RemoteOnly: 'datetime',
			EventName: 'string',
			ResponseId: 'string',
			Kind: 'string',
			Status: 'string',
			env_dt_traceId: 'string',
		},
		Span: {
			TIMESTAMP: 'datetime',
			TIMESTAMP_RemoteOnly: 'datetime',
			startTime: 'datetime',
			endTime: 'datetime',
			env_dt_traceId: 'string',
			env_dt_RemoteOnlyTrace: 'string',
			'agent.kind': 'string',
			'agent.type': 'string',
			'agent.remoteOnly': 'string',
			OtherColumn: 'string',
		},
	};
	const remoteFunctions = {
		v_autocomplete_events: {
			columns: {
				TIMESTAMP: 'datetime',
				TIMESTAMP_RemoteOnly: 'datetime',
				EventName: 'string',
				Kind: 'string',
				Status: 'string',
				ResponseId: 'string',
				ParentResponseId: 'string',
				AgentName: 'string',
				ProjectId: 'string',
				env_dt_traceId: 'string',
				env_dt_spanId: 'string',
			},
		},
	};
	const primaryRaw = e2eBuildShowSchema(primaryDatabase, primaryTables);
	const remoteRaw = e2eBuildShowSchema(remoteDatabase, remoteTables, remoteFunctions);
	const primarySchema = e2eCompactSchemaFromTables(primaryTables, primaryRaw);
	const semanticAccountPartition = 'e2e-semantic-partition';
	const semanticConnection = {
		id: 'e2e-semantic-conn',
		name: 'E2E Semantic Cluster',
		clusterUrl: primaryClusterUrl,
		accountPartition: semanticAccountPartition,
	};
	const semanticRemoteConnection = {
		id: 'e2e-semantic-remote-conn',
		name: 'E2E Semantic Remote Cluster',
		clusterUrl: remoteClusterUrl,
		accountPartition: semanticAccountPartition,
	};
	try {
		const existingConnections = Array.isArray(_win.connections) ? _win.connections : [];
		const fixtureConnectionIds = new Set([semanticConnection.id, semanticRemoteConnection.id]);
		const others = existingConnections.filter((conn: any) => !fixtureConnectionIds.has(String(conn?.id || '')));
		others.push(semanticConnection, semanticRemoteConnection);
		_win.connections.length = 0;
		_win.connections.push(...others);
		if (typeof section.setConnections === 'function') section.setConnections(_win.connections, { lastConnectionId: semanticConnection.id });
		if (typeof section.setDesiredClusterUrl === 'function') section.setDesiredClusterUrl(primaryClusterUrl);
	} catch { /* ignore */ }

	_win.schemaByBoxId[boxId] = primarySchema;
	_win.schemaMetaByBoxId[boxId] = { fromCache: false, schemaSignature: 'e2e-semantic-primary' };
	const primaryCanonicalSchemaKey = getKustoSchemaIdentityKey(semanticConnection.id, semanticAccountPartition, primaryClusterUrl, primaryDatabase);
	if (primaryCanonicalSchemaKey) {
		_win.schemaByConnDb[primaryCanonicalSchemaKey] = primarySchema;
		_win.schemaMetaByConnDb[primaryCanonicalSchemaKey] = { fromCache: false, schemaSignature: 'e2e-semantic-primary', connectionId: semanticConnection.id, accountPartition: semanticAccountPartition, clusterUrl: primaryClusterUrl, database: primaryDatabase };
	}
	try {
		section.setConnectionId?.(semanticConnection.id);
		section.setDatabase?.(primaryDatabase);
		section.setDatabases?.([primaryDatabase]);
		section.setSchemaInfo?.({ status: 'loaded', statusText: 'E2E semantic schema loaded' });
	} catch { /* ignore */ }

	if (typeof _win.__kustoSetMonacoKustoSchema !== 'function') {
		throw new Error('__kustoSetMonacoKustoSchema is not available');
	}
	const primaryApplied = await _win.__kustoSetMonacoKustoSchema(primaryRaw, primaryClusterUrl, primaryDatabase, true, modelUri, true, undefined, undefined, undefined, semanticConnection.id, semanticAccountPartition);
	if (!primaryApplied) {
		throw new Error('Primary semantic fixture schema did not apply to Monaco worker');
	}
	const preparationToken = beginKustoPreparation(boxId, {
		stage: 'waiting-worker',
		blockers: ['worker', 'enhancement'],
		target: {
			connectionId: semanticConnection.id,
			database: primaryDatabase,
			schemaKey: primaryCanonicalSchemaKey,
			schemaSignature: 'e2e-semantic-primary',
			modelUri,
		},
	});
	if (!preparationToken) throw new Error('Primary semantic fixture preparation did not start');
	markSchemaWorkerReady(boxId, primaryCanonicalSchemaKey, 'e2e-semantic-primary', modelUri, preparationToken);
	markSchemaEnhancementReady(boxId, primaryCanonicalSchemaKey, 'e2e-semantic-primary', modelUri, preparationToken);
	const originalQuery = String(editor.getValue?.() || '');
	const fixtureReference = `cluster('${remoteClusterName}').database('${remoteDatabase}').Events`;
	if (!originalQuery.includes(fixtureReference)) editor.setValue?.(`${fixtureReference}\n| take 1`);
	if (!__kustoInjectSupplementalSchemaForTest({
		clusterName: remoteClusterName,
		clusterUrl: remoteClusterUrl,
		database: remoteDatabase,
		boxId,
		rawSchemaJson: remoteRaw,
	})) {
		throw new Error('Coordinator-backed supplemental semantic fixture injection failed');
	}

	const remoteKey = getKustoSchemaIdentityKey(semanticRemoteConnection.id, semanticAccountPartition, remoteClusterUrl, remoteDatabase);
	const started = performance.now();
	while (performance.now() - started < 8000) {
		const entry = __kustoCrossClusterSchemas?.[remoteKey];
		if (entry?.status === 'loaded') {
			_win.__e2eKustoSemanticFixture = { boxId, modelUri, primaryClusterUrl, primaryDatabase, remoteKey, primaryRaw, remoteRaw };
			return `semantic fixture applied: boxId=${boxId} model=${modelUri} remoteKey=${remoteKey}`;
		}
		if (entry?.status === 'error') {
			throw new Error(`Cross-cluster semantic fixture failed: ${entry.error || 'unknown error'}; ${e2eSuggestDiagnosticsText('semantic fixture apply')}`);
		}
		await e2eDelay(100);
	}
	throw new Error(`Cross-cluster semantic fixture did not load ${remoteKey}; ${e2eSuggestDiagnosticsText('semantic fixture timeout')}`);
}

async function e2eApplyKustoCurrentClusterWorkflowFixture(): Promise<string> {
	try { if (typeof _win.__kustoClearCrossClusterTrace === 'function') _win.__kustoClearCrossClusterTrace(); } catch { /* ignore */ }
	try { if (typeof _win.__kustoClearAutocompleteTrace === 'function') _win.__kustoClearAutocompleteTrace(); } catch { /* ignore */ }
	const section = e2eSection('kusto') as any;
	const boxId = String(section.boxId || section.id || '').trim();
	const editor = e2eEditor('kusto');
	const modelUri = editor.getModel?.()?.uri?.toString?.() || '';
	if (!boxId || !modelUri) {
		throw new Error(`Cannot apply current-cluster fixture: boxId=${boxId || '(none)'} modelUri=${modelUri || '(none)'}`);
	}
	const clusterUrl = 'https://semantic-current.westus.kusto.windows.net';
	const database = 'TelemetryDb';
	const tables = {
		LocalOnly: {
			LocalOnlyColumn: 'string',
		},
	};
	const functions = {
		v_autocomplete_events: {
			columns: {
				TIMESTAMP: 'datetime',
				EventName: 'string',
				Kind: 'string',
				Status: 'string',
				ResponseId: 'string',
				env_dt_traceId: 'string',
			},
		},
	};
	const rawSchema = e2eBuildShowSchema(database, tables, functions);
	const schema = e2eCompactSchemaFromTables(tables, rawSchema);
	const connection = { id: 'e2e-current-workflow-conn', name: 'E2E Autocomplete Cluster', clusterUrl, accountPartition: 'e2e-current-workflow-partition' };
	const prevRestoreInProgress = !!pState.restoreInProgress;
	try {
		pState.restoreInProgress = true;
		if (Array.isArray(_win.connections)) {
			_win.connections.length = 0;
			_win.connections.push(connection);
		}
		if (Array.isArray(_win.kustoFavorites)) {
			_win.kustoFavorites.length = 0;
		}
		section.setConnectionId?.(connection.id);
		section.setDesiredClusterUrl?.(clusterUrl);
		section.setConnections?.(_win.connections, { lastConnectionId: connection.id });
		section.setFavorites?.([{ connectionId: connection.id, clusterUrl, database, name: 'E2E Autocomplete Cluster' }]);
		section.setFavoritesMode?.(true);
		section.setDesiredDatabase?.(database);
		section.setDatabases?.([database], database);
		section.setDatabase?.(database);
		section.setSchemaInfo?.({ status: 'loaded', statusText: 'E2E current workflow schema loaded' });
	} catch { /* ignore */ }
	finally {
		pState.restoreInProgress = prevRestoreInProgress;
	}

	_win.schemaByBoxId[boxId] = schema;
	_win.schemaMetaByBoxId[boxId] = { fromCache: false, schemaSignature: 'e2e-current-workflow' };
	const canonicalSchemaKey = getKustoSchemaIdentityKey(connection.id, connection.accountPartition, clusterUrl, database);
	if (canonicalSchemaKey) {
		_win.schemaByConnDb[canonicalSchemaKey] = schema;
		_win.schemaMetaByConnDb[canonicalSchemaKey] = { fromCache: false, schemaSignature: 'e2e-current-workflow', connectionId: connection.id, accountPartition: connection.accountPartition, clusterUrl, database };
	}
	if (typeof _win.__kustoSetMonacoKustoSchema !== 'function') {
		throw new Error('__kustoSetMonacoKustoSchema is not available');
	}
	const applied = await _win.__kustoSetMonacoKustoSchema(rawSchema, clusterUrl, database, true, modelUri, true, undefined, undefined, undefined, connection.id, connection.accountPartition);
	if (!applied) {
		throw new Error('Current-cluster workflow fixture schema did not apply to Monaco worker');
	}
	_win.__e2eKustoCurrentWorkflowFixture = { boxId, modelUri, clusterUrl, database, rawSchema };
	return `current workflow fixture applied: boxId=${boxId} model=${modelUri}`;
}

function e2eSetKustoQueryWithCaretMarker(queryWithMarker: string, marker: string = '⟦caret⟧'): string {
	const raw = String(queryWithMarker || '');
	const index = raw.indexOf(marker);
	if (index < 0) {
		throw new Error(`Caret marker ${marker} not found`);
	}
	if (raw.indexOf(marker, index + marker.length) >= 0) {
		throw new Error(`Caret marker ${marker} appears more than once`);
	}
	const text = raw.slice(0, index) + raw.slice(index + marker.length);
	const prefix = raw.slice(0, index);
	const lines = prefix.split(/\r?\n/);
	const lineNumber = lines.length;
	const column = lines[lines.length - 1].length + 1;
	_win.__e2e.kusto.setQueryAt(text, lineNumber, column);
	return `set kusto query with caret at ${lineNumber}:${column}`;
}

function e2eSetKustoQueryWithCaretMarkerStrict(queryWithMarker: string, marker: string = '⟦caret⟧'): string {
	const raw = String(queryWithMarker || '');
	const index = raw.indexOf(marker);
	if (index < 0) {
		throw new Error(`Caret marker ${marker} not found`);
	}
	if (raw.indexOf(marker, index + marker.length) >= 0) {
		throw new Error(`Caret marker ${marker} appears more than once`);
	}
	const text = raw.slice(0, index) + raw.slice(index + marker.length);
	const prefix = raw.slice(0, index);
	const lines = prefix.split(/\r?\n/);
	const lineNumber = lines.length;
	const column = lines[lines.length - 1].length + 1;
	const section = e2eSection('kusto');
	const boxId = String(section.boxId || section.id || '').trim();
	const editor = boxId ? (_win.queryEditors?.[boxId] as MonacoLike | undefined) : undefined;
	if (!editor || typeof editor.setValue !== 'function' || typeof editor.setPosition !== 'function') {
		throw new Error(`Strict Kusto editor unavailable for boxId=${boxId || '(none)'}`);
	}
	editor.setValue(text);
	editor.setPosition({ lineNumber, column });
	try { editor.focus?.(); } catch { /* ignore */ }
	try { setActiveMonacoEditor(editor); } catch { /* ignore */ }
	updateMonacoFocusDataset(editor);
	const actual = editor.getPosition?.() || null;
	if (!actual || actual.lineNumber !== lineNumber || actual.column !== column) {
		throw new Error(`Strict caret verification failed: expected ${lineNumber}:${column}, got ${actual ? `${actual.lineNumber}:${actual.column}` : '(none)'}`);
	}
	return `strict set kusto query with caret at ${lineNumber}:${column}`;
}

async function e2eAssertKustoSemanticSuggestAt(queryWithMarker: string, expectedCsv: string, context: string, timeoutMs: number = 7000): Promise<string> {
	e2eSetKustoQueryWithCaretMarker(queryWithMarker);
	await e2eDelay(100);
	e2eHideSuggest('kusto');
	await e2eDelay(100);
	const editor = e2eEditor('kusto') as any;
	const boxId = e2eGetEditorBoxId(editor);
	if (!boxId || typeof _win.__kustoTriggerAutocompleteForBoxId !== 'function') {
		throw new Error(`Cannot trigger Kusto autocomplete: boxId=${boxId || '(none)'}`);
	}
	const started = performance.now();
	const triggered = await _win.__kustoTriggerAutocompleteForBoxId(boxId);
	if (!triggered) {
		throw new Error(`${context}: autocomplete trigger not accepted; ${e2eSuggestDiagnosticsText(context)}`);
	}
	const expected = String(expectedCsv || '').split(',').map(value => value.trim()).filter(Boolean);
	let lastError = '';
	while (performance.now() - started < timeoutMs) {
		try {
			const labels = e2eVisibleSuggestLabelsWithDiagnostics(context, E2E_SECTION.kusto.editor);
			if (expected.length) {
				const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestLabel(label)));
				const missing = expected.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestLabel(candidate)));
				if (missing.length === 0) {
					return `${context}: found [${expected.join(', ')}] in ${labels.length} labels: ${labels.slice(0, 30).join(', ')}`;
				}
				lastError = `missing [${missing.join(', ')}], labels=[${labels.slice(0, 40).join(', ')}]`;
			} else if (labels.length) {
				return `${context}: ${labels.length} labels: ${labels.slice(0, 30).join(', ')}`;
			}
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await e2eDelay(100);
	}
	throw new Error(`${context}: expected suggestions [${expected.join(', ')}] within ${timeoutMs}ms; last=${lastError}; diagnostics=${e2eSuggestDiagnosticsText(context)}`);
}

type KustoSemanticCompletionScenario = 'first-timestamp' | 'inline-and-timestamp' | 'second-where-empty' | 'second-where-incomplete' | 'bracketed-agent-column' | 'summarize-by-trace-id' | 'workflow-function-timestamp' | 'workflow-function-event-name' | 'workflow-basequery-kind' | 'workflow-summarize-trace-id';

const E2E_KUSTO_SEMANTIC_QUERY_BASE = `// Synthetic hosted run function for autocomplete coverage
.create-or-alter function with
(
	folder = "Synthetic/Autocomplete",
	docstring = "Get synthetic hosted runs for autocomplete tests.",
    skipvalidation = "true"
)
GetSyntheticHostedRuns
(
    startTime: datetime,
    endTime: datetime
)
{
	let toolsByResponseId = GetSyntheticToolCallsGroupedByResponseId((startTime-12h), (endTime+12h))
    ;
	let remoteEventsByTraceId = cluster('semantic-remote.westus.kusto.windows.net').database('TelemetryDb').Events
        | project-away startTime
        | where TIMESTAMP >= startTime-12h and TIMESTAMP < endTime+12h
			and EventName == "ResponseCompleted"
		| summarize IsReplat = max((EventName == "ResponseCompleted")) by ResponseId
        | extend HostedVersion = case(isnull(IsReplat), "Unknown", IsReplat, "Replat/V2", "V1")
    ;
}`;

const E2E_KUSTO_WORKFLOW_NOT_COMPLETED_QUERY_BASE = `// Synthetic workflow function for autocomplete coverage.
.create-or-alter function with
(
	folder = "Synthetic/Autocomplete",
	docstring = "Get synthetic workflow runs that have not been completed.",
	skipvalidation = "true"
)
GetSyntheticWorkflowRuns_NotCompleted
(
	startTime: datetime,
	endTime: datetime
)
{
	let ConstructAgentId = (AgentName:string, ProjectId:string) {
		iff(isnotempty(AgentName), hash_sha1(strcat(AgentName, ProjectId)), "")
	};
	let workflowSubAgents = GetSyntheticWorkflowSubAgentRuns(startTime + 12h, endTime - 12h)
	;
	let baseQuery = materialize(cluster('semantic-current.westus').database('TelemetryDb').v_autocomplete_events()
		| where TIMESTAMP >= startTime
			and TIMESTAMP < endTime
			and EventName == "ResponseCompleted")
	;
	let incompleteWorkflowRuns = baseQuery
		| where Kind == "workflow"
		| summarize make_set(Status), count_distinct(Status) by env_dt_traceId
	;
}`;

function e2eKustoSemanticScenarioQuery(scenario: KustoSemanticCompletionScenario): { query: string; expected: string; context: string } {
	if (scenario === 'first-timestamp') {
		return {
			query: E2E_KUSTO_SEMANTIC_QUERY_BASE.replace('| where TIMESTAMP >=', '| where TIME⟦caret⟧STAMP >='),
			expected: 'TIMESTAMP,TIMESTAMP_RemoteOnly',
			context: 'first where TIMESTAMP mid-token',
		};
	}
	if (scenario === 'inline-and-timestamp') {
		return {
			query: E2E_KUSTO_SEMANTIC_QUERY_BASE.replace('and TIMESTAMP <', 'and TIME⟦caret⟧STAMP <'),
			expected: 'TIMESTAMP,TIMESTAMP_RemoteOnly',
			context: 'inline and TIMESTAMP mid-token',
		};
	}
	if (scenario === 'second-where-empty') {
		return {
			query: `// Synthetic response logs, one with longer window
let eventRows =
    materialize(cluster('semantic-remote.westus.kusto.windows.net').database('TelemetryDb').Events
    | where TIMESTAMP >= startTime and TIMESTAMP < endTime
    | where ⟦caret⟧)
;`,
			expected: 'TIMESTAMP,TIMESTAMP_RemoteOnly,EventName,ResponseId',
			context: 'second where empty predicate in synthetic materialize',
		};
	}
	if (scenario === 'second-where-incomplete') {
		return {
			query: `// Synthetic response logs, one with longer window
let eventRows =
    materialize(cluster('semantic-remote.westus.kusto.windows.net').database('TelemetryDb').Events
    | where TIMESTAMP >= startTime and TIMESTAMP < endTime
    | where ⟦caret⟧
;`,
			expected: 'TIMESTAMP,TIMESTAMP_RemoteOnly,EventName,ResponseId',
			context: 'second where incomplete synthetic materialize',
		};
	}
	if (scenario === 'bracketed-agent-column') {
		return {
			query: E2E_KUSTO_SEMANTIC_QUERY_BASE.replace('EventName ==', 'Event⟦caret⟧Name =='),
			expected: 'EventName',
			context: 'synthetic event name column',
		};
	}
	if (scenario === 'summarize-by-trace-id') {
		return {
			query: E2E_KUSTO_SEMANTIC_QUERY_BASE.replace('by ResponseId', 'by Response⟦caret⟧Id'),
			expected: 'ResponseId',
			context: 'summarize by response id',
		};
	}
	if (scenario === 'workflow-function-timestamp') {
		return {
			query: E2E_KUSTO_WORKFLOW_NOT_COMPLETED_QUERY_BASE.replace('| where TIMESTAMP >=', '| where TIME⟦caret⟧STAMP >='),
			expected: 'TIMESTAMP,TIMESTAMP_RemoteOnly',
			context: 'workflow synthetic function TIMESTAMP mid-token',
		};
	}
	if (scenario === 'workflow-function-event-name') {
		return {
			query: E2E_KUSTO_WORKFLOW_NOT_COMPLETED_QUERY_BASE.replace('and EventName ==', 'and Event⟦caret⟧Name =='),
			expected: 'EventName',
			context: 'workflow synthetic function EventName mid-token',
		};
	}
	if (scenario === 'workflow-basequery-kind') {
		return {
			query: E2E_KUSTO_WORKFLOW_NOT_COMPLETED_QUERY_BASE.replace('| where Kind ==', '| where Ki⟦caret⟧nd =='),
			expected: 'Kind',
			context: 'workflow baseQuery Kind mid-token',
		};
	}
	if (scenario === 'workflow-summarize-trace-id') {
		return {
			query: E2E_KUSTO_WORKFLOW_NOT_COMPLETED_QUERY_BASE.replace('by env_dt_traceId', 'by env_dt_⟦caret⟧traceId'),
			expected: 'env_dt_traceId',
			context: 'workflow summarize env_dt_traceId mid-token',
		};
	}
	throw new Error(`Unknown Kusto semantic completion scenario: ${scenario}`);
}

function e2eSetCurrentClusterWorkflowScenario(): string {
	return e2eSetKustoQueryWithCaretMarker(`let baseQuery = materialize(cluster('semantic-current.westus').database('TelemetryDb').v_autocomplete_events()
	| where TIME⟦caret⟧STAMP >= startTime
		and TIMESTAMP < endTime
		and EventName == "ResponseCompleted")`);
}

function e2eKustoMissingRemoteSchemaQuery(): string {
	return `LocalOnly
| union cluster('missingremote').database('missingdb').MissingTable
| where Missing⟦caret⟧`;
}

async function e2eAssertKustoSemanticScenario(scenario: KustoSemanticCompletionScenario, timeoutMs: number = 7000): Promise<string> {
	const { query, expected, context } = e2eKustoSemanticScenarioQuery(scenario);
	return e2eAssertKustoSemanticSuggestAt(query, expected, context, timeoutMs);
}

async function e2eAssertKustoSemanticScenarioVisible(scenario: KustoSemanticCompletionScenario, timeoutMs: number = 7000): Promise<string> {
	const { expected, context } = e2eKustoSemanticScenarioQuery(scenario);
	const expectedLabels = String(expected || '').split(',').map(value => value.trim()).filter(Boolean);
	const started = performance.now();
	let lastError = '';
	while (performance.now() - started < timeoutMs) {
		try {
			const labels = e2eVisibleSuggestLabelsWithDiagnostics(context, E2E_SECTION.kusto.editor);
			const normalizedLabels = new Set(labels.map(label => e2eNormalizeSuggestLabel(label)));
			const missing = expectedLabels.filter(candidate => !normalizedLabels.has(e2eNormalizeSuggestLabel(candidate)));
			if (missing.length === 0) {
				return `${context}: visible after keypress [${expectedLabels.join(', ')}] in ${labels.length} labels: ${labels.slice(0, 30).join(', ')}`;
			}
			lastError = `missing [${missing.join(', ')}], labels=[${labels.slice(0, 40).join(', ')}]`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await e2eDelay(100);
	}
	throw new Error(`${context}: expected visible suggestions [${expectedLabels.join(', ')}] after keypress within ${timeoutMs}ms; last=${lastError}; diagnostics=${e2eSuggestDiagnosticsText(context)}`);
}

function e2eAssertKustoCrossClusterTraceForSemanticFixture(): string {
	const trace = typeof _win.__kustoGetCrossClusterTrace === 'function' ? _win.__kustoGetCrossClusterTrace() : [];
	const remoteKey = getKustoSchemaIdentityKey('e2e-semantic-remote-conn', 'e2e-semantic-partition', 'semantic-remote.westus', 'TelemetryDb');
	const remoteSchemaId = kustoSupplementalTraceId(remoteKey);
	const has = (event: string, predicate: (entry: any) => boolean = () => true) => trace.some((entry: any) => entry?.event === event && predicate(entry));
	const missing: string[] = [];
	if (!has('request-posted', (entry: any) => entry.schemaId === remoteSchemaId && entry.requestSource === 'background')) missing.push('request-posted');
	if (!has('response-received', (entry: any) => !!entry.clusterId && !!entry.databaseId)) missing.push('response-received');
	if (!has('apply-start', (entry: any) => entry.schemaId === remoteSchemaId)) missing.push('apply-start');
	if (!has('apply-internal-start', (entry: any) => entry.schemaId === remoteSchemaId && entry.aliasesCount >= 2)) missing.push('apply-internal-start-alias-count');
	if (!has('apply-internal-success', (entry: any) => entry.schemaId === remoteSchemaId && entry.appliedCount > 0)) missing.push('apply-internal-success');
	if (!has('schema-status', (entry: any) => entry.schemaId === remoteSchemaId && entry.status === 'loaded')) missing.push('schema-status-loaded');
	if (!has('autocomplete-retry-trigger', (entry: any) => entry.missingKeysCount > 0)) missing.push('autocomplete-retry-trigger');
	if (has('autocomplete-retry-skipped-no-focus')) missing.push('unexpected-autocomplete-retry-skipped-no-focus');
	const traceText = JSON.stringify(trace);
	for (const sentinel of ['semantic-remote', 'TelemetryDb', 'LocalDb', 'RemoteOnly', 'agent.remoteOnly']) {
		if (traceText.toLowerCase().includes(sentinel.toLowerCase())) missing.push(`leaked-${sentinel}`);
	}
	if (missing.length) {
		throw new Error(`Missing/invalid cross-cluster trace events: ${missing.join(', ')}; trace=${JSON.stringify(trace)}`);
	}
	return `cross-cluster semantic trace ok: ${trace.map((entry: any) => entry.event).join(' -> ')}`;
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
	try {
		if (kind === 'kusto' && (editor as any).__kustoBoxId && typeof _win.__kustoTriggerAutocompleteForBoxId === 'function') {
			const triggered = await _win.__kustoTriggerAutocompleteForBoxId((editor as any).__kustoBoxId);
			if (!triggered) {
				throw new Error(`${context}: Kusto autocomplete trigger was not accepted`);
			}
		} else {
			editor.trigger?.('keyboard', 'editor.action.triggerSuggest', {});
		}
	} catch (error) {
		if (kind === 'kusto') {
			throw error;
		}
		/* fallback below */
	}
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

async function e2eWaitForExistingSuggestAll(kind: E2eSectionKind, context: string, expectedCsv: string, timeoutMs: number, started: number = performance.now()): Promise<{ elapsedMs: number; result: string }> {
	let lastError: unknown;
	while (performance.now() - started <= timeoutMs) {
		try {
			const result = e2eAssertVisibleSuggestAll(context, expectedCsv, E2E_SECTION[kind].editor);
			e2eAssertNoSuggestLoading(`${context} loading check`, E2E_SECTION[kind].editor);
			return { elapsedMs: performance.now() - started, result };
		} catch (error) {
			lastError = error;
			await e2eDelay(50);
		}
	}
	const message = lastError instanceof Error ? lastError.message : String(lastError || 'timed out');
	throw new Error(`${context}: no matching complete suggestion set within ${timeoutMs}ms: ${message}`);
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
		triggerSuggest: async () => {
			if (kind === 'kusto' && typeof _win.__kustoTriggerAutocompleteForBoxId === 'function') {
				const { editor } = resolveMonacoEditorFromSelector(editorSelector);
				const boxId = e2eGetEditorBoxId(editor);
				if (!boxId) {
					throw new Error('Kusto editor boxId unavailable for triggerSuggest');
				}
				const triggered = await _win.__kustoTriggerAutocompleteForBoxId(boxId);
				if (!triggered) {
					throw new Error(`Kusto autocomplete trigger was not accepted for ${boxId}`);
				}
				return `triggered gated kusto suggest for ${boxId}`;
			}
			return _win.__testTriggerMonaco(editorSelector, 'editor.action.triggerSuggest');
		},
		assertSuggestions: (context: string, expectedAnyCsv: string = '') => _win.__testAssertVisibleSuggest(context, expectedAnyCsv, editorSelector),
		assertMarkers: (expectation: 'any' | 'none' = 'any', owner: string = '', severity: 'error' | '' = '') => _win.__testAssertMonacoMarkers(editorSelector, expectation, owner, severity),
		assertDiagnosticVisible: (expectedText: string, expectedMessage: string = '', owner: string = 'kusto') => _win.__testAssertMonacoDiagnosticVisible(editorSelector, expectedText, expectedMessage, owner),
		assertRunEnabled: () => {
			const button = e2eRunButton(kind);
			if (button.disabled) {
				throw new Error(`${kind} run button should be enabled`);
			}
			return `${kind} run button enabled`;
		},
		selectRunMode: (mode: string) => {
			if (kind !== 'kusto') {
				throw new Error('selectRunMode is only implemented for kusto sections');
			}
			return _win.__testSelectKustoRunMode(mode, E2E_SECTION.kusto.section);
		},
		setCacheEnabled: (enabled: boolean) => {
			if (kind !== 'kusto') {
				throw new Error('setCacheEnabled is only implemented for kusto sections');
			}
			return e2eSetKustoCacheEnabled(enabled);
		},
		beginHostMessageCapture: e2eBeginHostMessageCapture,
		restoreHostMessageCapture: e2eRestoreHostMessageCapture,
		assertHostMessageCaptured: e2eAssertHostMessageCaptured,
		assertCancelButtonVisibleEnabled: () => {
			if (kind !== 'kusto') {
				throw new Error('assertCancelButtonVisibleEnabled is only implemented for kusto sections');
			}
			return e2eAssertKustoCancelVisibleEnabled();
		},
		assertStillExecutingWithCancelAfter: (delayMs: number) => {
			if (kind !== 'kusto') {
				throw new Error('assertStillExecutingWithCancelAfter is only implemented for kusto sections');
			}
			return e2eAssertKustoStillExecutingWithCancelAfter(delayMs);
		},
		assertCancelButtonHiddenDisabled: () => {
			if (kind !== 'kusto') {
				throw new Error('assertCancelButtonHiddenDisabled is only implemented for kusto sections');
			}
			return e2eAssertKustoCancelHiddenDisabled();
		},
		clickCancel: () => {
			if (kind === 'sql') {
				const section = e2eSection('sql');
				const button = document.getElementById(`${section.boxId}_sql_cancel_btn`) as HTMLButtonElement | null;
				if (!button || button.style.display === 'none' || button.disabled) {
					throw new Error('SQL cancel button is not visible and enabled');
				}
				button.click();
				return 'sql cancel clicked';
			}
			return e2eClickKustoCancel();
		},
		assertNotStuck: () => {
			if (kind !== 'kusto') {
				throw new Error('assertNotStuck is only implemented for kusto sections');
			}
			return e2eAssertKustoNotStuck();
		},
		assertCancelledText: () => {
			if (kind !== 'kusto') {
				throw new Error('assertCancelledText is only implemented for kusto sections');
			}
			return e2eAssertKustoCancelledText();
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

type E2eLayoutKind = 'query' | 'sql' | 'chart' | 'markdown' | 'transformation' | 'url' | 'html' | 'python';

interface E2eLayoutSpec {
	kind: E2eLayoutKind;
	tagName: string;
	id: string;
	minHeight: number;
	maxHeight: number;
	target: (section: HTMLElement) => HTMLElement | null;
	resizer: (section: HTMLElement) => HTMLElement | null;
}

const E2E_LAYOUT_RESULT_SECTION_ID = 'e2e_layout_query';
const E2E_LAYOUT_SPECS: E2eLayoutSpec[] = [
	{
		kind: 'query',
		tagName: 'kw-query-section',
		id: E2E_LAYOUT_RESULT_SECTION_ID,
		minHeight: 80,
		maxHeight: 950,
		target: section => section.querySelector('.query-editor-wrapper') as HTMLElement | null,
		resizer: section => document.getElementById(String((section as any).boxId || section.id) + '_query_resizer') as HTMLElement | null,
	},
	{
		kind: 'sql',
		tagName: 'kw-sql-section',
		id: 'e2e_layout_sql',
		minHeight: 80,
		maxHeight: 950,
		target: section => section.querySelector('.query-editor-wrapper') as HTMLElement | null,
		resizer: section => document.getElementById(String((section as any).boxId || section.id) + '_sql_editor_resizer') as HTMLElement | null,
	},
	{
		kind: 'chart',
		tagName: 'kw-chart-section',
		id: 'e2e_layout_chart',
		minHeight: 120,
		maxHeight: 950,
		target: section => section.querySelector('.query-editor-wrapper') as HTMLElement | null,
		resizer: section => document.getElementById(String((section as any).boxId || section.id) + '_chart_resizer') as HTMLElement | null,
	},
	{
		kind: 'markdown',
		tagName: 'kw-markdown-section',
		id: 'e2e_layout_markdown',
		minHeight: 120,
		maxHeight: 950,
		target: section => section.shadowRoot?.getElementById('editor-wrapper') as HTMLElement | null,
		resizer: section => section.shadowRoot?.querySelector('.resizer') as HTMLElement | null,
	},
	{
		kind: 'transformation',
		tagName: 'kw-transformation-section',
		id: 'e2e_layout_transformation',
		minHeight: 120,
		maxHeight: 950,
		target: section => section.shadowRoot?.getElementById('tf-wrapper') as HTMLElement | null,
		resizer: section => section.shadowRoot?.querySelector('.resizer') as HTMLElement | null,
	},
	{
		kind: 'url',
		tagName: 'kw-url-section',
		id: 'e2e_layout_url',
		minHeight: 120,
		maxHeight: 950,
		target: section => section.shadowRoot?.getElementById('output-wrapper') as HTMLElement | null,
		resizer: section => section.shadowRoot?.querySelector('.resizer') as HTMLElement | null,
	},
	{
		kind: 'html',
		tagName: 'kw-html-section',
		id: 'e2e_layout_html',
		minHeight: 120,
		maxHeight: 950,
		target: section => (section.shadowRoot?.getElementById('preview-wrapper')
			|| section.shadowRoot?.getElementById('editor-wrapper')) as HTMLElement | null,
		resizer: section => section.shadowRoot?.querySelector('.resizer') as HTMLElement | null,
	},
	{
		kind: 'python',
		tagName: 'kw-python-section',
		id: 'e2e_layout_python',
		minHeight: 120,
		maxHeight: 950,
		target: section => section.shadowRoot?.getElementById('editor-wrapper') as HTMLElement | null,
		resizer: section => section.shadowRoot?.querySelector('.resizer') as HTMLElement | null,
	},
];

function e2eLayoutSpec(kind: E2eLayoutKind): E2eLayoutSpec {
	const spec = E2E_LAYOUT_SPECS.find(candidate => candidate.kind === kind);
	if (!spec) {
		throw new Error(`Unknown layout section kind: ${kind}`);
	}
	return spec;
}

function e2eLayoutSection(spec: E2eLayoutSpec): HTMLElement {
	const section = document.getElementById(spec.id) as HTMLElement | null;
	if (!section) {
		throw new Error(`Missing ${spec.kind} layout section ${spec.id}`);
	}
	if (section.tagName.toLowerCase() !== spec.tagName) {
		throw new Error(`Expected ${spec.id} to be ${spec.tagName}, got ${section.tagName.toLowerCase()}`);
	}
	return section;
}

function e2eLayoutShell(section: HTMLElement, kind: string): HTMLElement {
	const shell = section.shadowRoot?.querySelector('kw-section-shell') as HTMLElement | null;
	if (!shell) {
		throw new Error(`Missing section shell for ${kind}`);
	}
	return shell;
}

function e2eLayoutShellButton(section: HTMLElement, kind: string, selector: string): HTMLElement {
	const shell = e2eLayoutShell(section, kind);
	const button = shell.shadowRoot?.querySelector(selector) as HTMLElement | null;
	if (!button) {
		throw new Error(`Missing ${selector} button for ${kind}`);
	}
	return button;
}

function e2eLayoutIsDisplayed(element: HTMLElement | null): boolean {
	if (!element || !element.isConnected) return false;
	const rect = element.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return false;
	const style = getComputedStyle(element);
	return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function e2eLayoutAssertDisplayed(element: HTMLElement | null, context: string): DOMRect {
	if (!e2eLayoutIsDisplayed(element)) {
		throw new Error(`${context} should be visible`);
	}
	return (element as HTMLElement).getBoundingClientRect();
}

function e2eLayoutAssertFiniteHeight(spec: E2eLayoutSpec, target: HTMLElement, context: string): number {
	const height = target.getBoundingClientRect().height;
	if (!Number.isFinite(height)) {
		throw new Error(`${context} height is not finite: ${height}`);
	}
	if (height < spec.minHeight || height > spec.maxHeight) {
		throw new Error(`${context} height out of bounds: ${height}px, expected ${spec.minHeight}-${spec.maxHeight}px`);
	}
	return height;
}

function e2eLayoutAssertTextIncludes(element: HTMLElement | null, expectedText: string, context: string): void {
	if (!element) {
		throw new Error(`${context} element not found`);
	}
	const text = String(element.textContent || '').replace(/\s+/g, ' ').trim();
	if (!text.includes(expectedText)) {
		throw new Error(`${context} missing ${JSON.stringify(expectedText)}; text=${JSON.stringify(text.slice(0, 180))}`);
	}
	if (!e2eLayoutIsDisplayed(element)) {
		throw new Error(`${context} should be visible`);
	}
}

function e2eLayoutAssertDataTableRows(root: ParentNode | null, context: string, minimumRows: number): void {
	const table = root?.querySelector('kw-data-table') as any;
	if (!table) {
		throw new Error(`${context} data table not found`);
	}
	const rows = Array.isArray(table.rows) ? table.rows : [];
	const columns = Array.isArray(table.columns) ? table.columns : [];
	if (rows.length < minimumRows) {
		throw new Error(`${context} expected at least ${minimumRows} rows, got ${rows.length}`);
	}
	if (columns.length < 2) {
		throw new Error(`${context} expected multiple columns, got ${columns.length}`);
	}
	if (!e2eLayoutIsDisplayed(table as HTMLElement)) {
		throw new Error(`${context} data table should be visible`);
	}
}

function e2eLayoutAssertSectionContent(spec: E2eLayoutSpec): void {
	const section = e2eLayoutSection(spec) as any;
	const id = String(section.boxId || section.id || spec.id);
	switch (spec.kind) {
		case 'query': {
			if (section.dataset.testHasResults !== 'true') {
				throw new Error('query section expected synthetic results');
			}
			const wrapper = document.getElementById(id + '_results_wrapper') as HTMLElement | null;
			e2eLayoutAssertDisplayed(wrapper, 'query results wrapper');
			e2eLayoutAssertDataTableRows(wrapper, 'query results', 16);
			return;
		}
		case 'sql': {
			if (section.dataset.testHasResults !== 'true') {
				throw new Error('SQL section expected synthetic results');
			}
			const wrapper = document.getElementById(id + '_sql_results_wrapper') as HTMLElement | null;
			e2eLayoutAssertDisplayed(wrapper, 'SQL results wrapper');
			e2eLayoutAssertDataTableRows(wrapper, 'SQL results', 16);
			return;
		}
		case 'chart': {
			const canvas = document.getElementById(id + '_chart_canvas_preview') as HTMLElement | null;
			e2eLayoutAssertDisplayed(canvas, 'chart preview canvas');
			const statusText = String(canvas?.textContent || '').trim();
			const hasRenderer = !!canvas?.querySelector('canvas,svg');
			if (!hasRenderer && /loading chart|select a data source|no data/i.test(statusText)) {
				throw new Error(`chart did not render data; status=${JSON.stringify(statusText)}`);
			}
			return;
		}
		case 'markdown': {
			e2eLayoutAssertTextIncludes(section.querySelector('.markdown-viewer') as HTMLElement | null, 'Markdown paragraph 42', 'markdown preview');
			return;
		}
		case 'transformation': {
			e2eLayoutAssertDataTableRows(section.shadowRoot, 'transformation results', 16);
			return;
		}
		case 'url': {
			e2eLayoutAssertTextIncludes(section.shadowRoot?.getElementById('url-content') as HTMLElement | null, 'URL body 42', 'URL content');
			return;
		}
		case 'html': {
			const iframe = section.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
			e2eLayoutAssertDisplayed(iframe, 'HTML preview iframe');
			if (!String(iframe?.srcdoc || '').includes('Layout Preview')) {
				throw new Error('HTML preview iframe srcdoc missing fixture content');
			}
			return;
		}
		case 'python': {
			e2eLayoutAssertTextIncludes(section.shadowRoot?.querySelector('.python-output') as HTMLElement | null, 'Python output 18', 'Python output');
			return;
		}
	}
}

function e2eLayoutDelay(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}

function e2eLayoutAnimationFrame(): Promise<void> {
	return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

async function e2eLayoutWaitFor(
	predicate: () => boolean,
	description: string,
	timeoutMs: number = 8000,
	intervalMs: number = 50,
): Promise<void> {
	const start = Date.now();
	let lastError = '';
	while (Date.now() - start < timeoutMs) {
		try {
			if (predicate()) return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await e2eLayoutDelay(intervalMs);
	}
	throw new Error(`Timed out waiting for ${description}${lastError ? ': ' + lastError : ''}`);
}

async function e2eLayoutWaitForUpdate(section: HTMLElement): Promise<void> {
	try {
		const updateComplete = (section as any).updateComplete;
		if (updateComplete && typeof updateComplete.then === 'function') {
			await updateComplete;
		}
	} catch { /* ignore test-only update timing errors */ }
	await e2eLayoutAnimationFrame();
}

function e2eLayoutGeneratedLines(prefix: string, count: number): string {
	return Array.from({ length: count }, (_value, index) => `${prefix} ${index + 1}: layout regression sample text`).join('\n');
}

function e2eLayoutSampleResult(): any {
	const categories = ['Alpha', 'Beta', 'Gamma', 'Delta'];
	const rows = Array.from({ length: 32 }, (_value, index) => [
		`2026-02-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
		categories[index % categories.length],
		(index + 1) * 3,
		index + 10,
	]);
	return {
		columns: [
			{ name: 'Day', type: 'datetime' },
			{ name: 'Category', type: 'string' },
			{ name: 'Score', type: 'real' },
			{ name: 'Events', type: 'long' },
		],
		rows,
		metadata: { executionTimeMs: 5 },
	};
}

function e2eChartRegressionResult(): any {
	return {
		columns: [
			{ name: 'Bucket', type: 'string' },
			{ name: 'Lane', type: 'string' },
			{ name: 'Value', type: 'long' },
		],
		rows: [
			['10', '2', 102],
			['2', '2', 22],
			['1', '2', 12],
			['10', '10', 1010],
			['2', '10', 210],
			['1', '10', 110],
		],
		metadata: { executionTimeMs: 1 },
	};
}

function e2eChartAssertArrayEqual(name: string, actual: unknown, expected: unknown): void {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson !== expectedJson) {
		throw new Error(`${name} expected ${expectedJson}, got ${actualJson}`);
	}
}

function e2eChartRenderedOption(chartId: string): any {
	const state = _win.chartStateByBoxId?.[chartId];
	const instance = state?.__echarts?.instance;
	if (!instance || typeof instance.getOption !== 'function') {
		throw new Error(`Rendered ECharts instance not available for ${chartId}`);
	}
	const option = instance.getOption();
	if (!option) {
		throw new Error(`Rendered ECharts option not available for ${chartId}`);
	}
	return option;
}

function e2eChartAssertRegressionState(chartId: string): string {
	const chartSection = document.getElementById(chartId) as any;
	if (!chartSection || typeof chartSection.serialize !== 'function') {
		throw new Error(`Chart section not found or not serializable: ${chartId}`);
	}

	const serialized = chartSection.serialize();
	if (serialized.chartTitle !== 'Requests by bucket') {
		throw new Error(`chartTitle did not sync into serialization: ${JSON.stringify(serialized.chartTitle)}`);
	}
	if (serialized.chartSubtitle !== 'From live E2E global state') {
		throw new Error(`chartSubtitle did not sync into serialization: ${JSON.stringify(serialized.chartSubtitle)}`);
	}
	if (serialized.chartTitleAlign !== 'left') {
		throw new Error(`chartTitleAlign did not sync into serialization: ${JSON.stringify(serialized.chartTitleAlign)}`);
	}

	const option = e2eChartRenderedOption(chartId);
	const xAxisOption = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
	const yAxisOption = Array.isArray(option.yAxis) ? option.yAxis[0] : option.yAxis;
	const seriesOption = Array.isArray(option.series) ? option.series[0] : option.series;
	const heatmapValues = Array.isArray(seriesOption?.data)
		? seriesOption.data.map((point: any) => point?.value)
		: [];

	e2eChartAssertArrayEqual('xAxis.data', xAxisOption?.data, ['1', '2', '10']);
	e2eChartAssertArrayEqual('yAxis.data', yAxisOption?.data, ['2', '10']);
	e2eChartAssertArrayEqual('heatmap values', heatmapValues, [
		[0, 0, 12],
		[0, 1, 110],
		[1, 0, 22],
		[1, 1, 210],
		[2, 0, 102],
		[2, 1, 1010],
	]);

	return 'live chart title sync and heatmap numeric category ordering verified';
}

async function e2eChartAssertTitleSyncAndHeatmapNumericCategories(): Promise<string> {
	const sourceId = e2eLayoutAddSection('addUrlBox', {
		id: 'url_e2e_chart_regression',
		name: 'Chart regression data',
		url: 'https://example.invalid/chart-regression.csv',
		expanded: false,
	});
	await e2eLayoutWaitFor(() => !!document.getElementById(sourceId), 'chart regression data section');
	const source = e2eChartRegressionResult();
	const csvBody = [
		source.columns.map((column: any) => column.name).join(','),
		...source.rows.map((row: unknown[]) => row.join(',')),
	].join('\n');
	window.dispatchEvent(new MessageEvent('message', { data: {
		type: 'urlContent', boxId: sourceId,
		url: 'https://example.invalid/chart-regression.csv',
		kind: 'csv', contentType: 'text/csv', status: 200, body: csvBody,
	} }));
	await e2eLayoutWaitFor(() => (getResultsState(sourceId)?.columns || []).length === 3, 'chart regression CSV data');

	const chartId = e2eLayoutAddSection('addChartBox', {
		id: 'chart_e2e_heatmap_regression',
		name: 'Chart Regression Heatmap',
		mode: 'preview',
		expanded: true,
		dataSourceId: sourceId,
		chartType: 'heatmap',
		xColumn: 'Bucket',
		yColumn: 'Lane',
		valueColumn: 'Value',
		xAxisSettings: { sortDirection: 'asc', scaleType: 'category' },
		yAxisSettings: { sortDirection: 'asc' },
		chartTitle: 'Initial title',
		chartSubtitle: 'Initial subtitle',
		chartTitleAlign: 'center',
		editorHeightPx: 260,
	});
	await e2eLayoutWaitFor(() => !!document.getElementById(chartId), 'chart regression chart section');
	const chartSection = document.getElementById(chartId) as any;
	chartSection.refresh?.();
	await e2eLayoutWaitForUpdate(chartSection as HTMLElement);
	_win.chartStateByBoxId = _win.chartStateByBoxId || {};
	_win.chartStateByBoxId[chartId] = {
		...(_win.chartStateByBoxId[chartId] || {}),
		chartTitle: 'Requests by bucket',
		chartSubtitle: 'From live E2E global state',
		chartTitleAlign: 'left',
	};
	if (typeof chartSection.syncFromGlobalState !== 'function') {
		throw new Error(`Chart section cannot sync global state: ${chartId}`);
	}
	await e2eLayoutWaitFor(() => !!chartSection.shadowRoot, 'chart shadow root', 10000);
	for (let attempt = 0; attempt < 5; attempt++) {
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'urlContent', boxId: sourceId,
			url: 'https://example.invalid/chart-regression.csv',
			kind: 'csv', contentType: 'text/csv', status: 200, body: csvBody,
		} }));
		chartSection.syncFromGlobalState();
		await e2eLayoutWaitForUpdate(chartSection as HTMLElement);
		chartSection.refresh?.();
		await e2eLayoutWaitForUpdate(chartSection as HTMLElement);
		await e2eLayoutDelay(200);
		if (!String(chartSection.shadowRoot?.textContent || '').includes('No data available yet.')) break;
	}
	await e2eLayoutDelay(500);
	if (String(chartSection.shadowRoot?.textContent || '').includes('No data available yet.')) {
		throw new Error('Chart returned to its empty state after local E2E data stabilization');
	}
	chartSection.setExpanded?.(true);
	const chartWrapper = document.getElementById(chartId + '_chart_wrapper') as HTMLElement | null;
	if (chartWrapper) {
		chartWrapper.style.display = '';
		chartWrapper.style.height = '320px';
		chartWrapper.dataset.kustoUserResized = 'true';
	}
	chartSection.refresh?.();
	await e2eLayoutWaitForUpdate(chartSection as HTMLElement);
	await e2eLayoutWaitFor(() => {
		const canvas = document.getElementById(chartId + '_chart_canvas_preview') as HTMLElement | null;
		return chartSection.getBoundingClientRect().height > 200
			&& !!canvas
			&& canvas.getBoundingClientRect().height > 100
			&& !canvas.querySelector('.error-message');
	}, 'visible chart geometry', 10000);

	await e2eLayoutWaitFor(() => {
		e2eChartAssertRegressionState(chartId);
		return true;
	}, 'chart regression state', 10000);
	const summary = e2eChartAssertRegressionState(chartId);
	setPageScrollTop(Math.max(0, chartSection.offsetTop - 24));
	await e2eLayoutDelay(100);
	return summary;
}

function e2eLayoutDispatchUrlContent(boxId: string): void {
	window.dispatchEvent(new MessageEvent('message', {
		data: {
			type: 'urlContent',
			boxId,
			url: 'https://example.invalid/e2e-layout.txt',
			contentType: 'text/plain',
			status: 200,
			kind: 'text',
			body: e2eLayoutGeneratedLines('URL body', 42),
		},
	}));
}

function e2eLayoutHtmlPreviewCode(): string {
	const cards = Array.from({ length: 10 }, (_value, index) => `
    <section class="metric">
      <h2>Metric ${index + 1}</h2>
      <p>Viewport-bound preview fixture row ${index + 1}</p>
    </section>`).join('');
	return `<!doctype html>
<html>
<head>
  <style>
    html, body { margin: 0; font-family: sans-serif; }
    body { min-height: 100vh; padding: 24px; box-sizing: border-box; background: #fafafa; }
    main { min-height: calc(100vh - 48px); display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .metric { border: 1px solid #ccc; padding: 12px; background: white; }
    h1, h2, p { margin: 0 0 8px; }
  </style>
</head>
<body>
  <main>
    <section class="metric"><h1>Layout Preview</h1><p>This fixture intentionally uses viewport height.</p></section>${cards}
  </main>
</body>
</html>`;
}

function e2eLayoutAddSection(addFunctionName: string, options: Record<string, unknown>): string {
	const addFunction = _win[addFunctionName];
	if (typeof addFunction !== 'function') {
		throw new Error(`Missing section factory ${addFunctionName}`);
	}
	return String(addFunction(options));
}

async function e2eLayoutSetMonacoValue(sectionId: string, value: string): Promise<void> {
	await e2eLayoutWaitFor(() => !!resolveMonacoEditorFromElement(document.getElementById(sectionId)), `${sectionId} Monaco editor`, 10000);
	const editor = resolveMonacoEditorFromElement(document.getElementById(sectionId));
	if (!editor || typeof editor.setValue !== 'function') {
		throw new Error(`Unable to set Monaco value for ${sectionId}`);
	}
	editor.setValue(value);
}

async function e2eLayoutCreateStressNotebook(): Promise<string> {
	_win.__testRemoveAllSections();
	await e2eLayoutWaitFor(() => document.querySelectorAll(TEST_SECTION_SELECTOR).length === 0, 'all sections to be removed');

	const queryText = `datatable(Category:string, Score:long, Events:long)\n[\n${Array.from({ length: 24 }, (_value, index) => `  "${['Alpha', 'Beta', 'Gamma', 'Delta'][index % 4]}", ${index * 3 + 1}, ${index + 10}`).join(',\n')}\n]`;
	const sqlText = `SELECT * FROM (VALUES\n${Array.from({ length: 24 }, (_value, index) => `  ('${['Alpha', 'Beta', 'Gamma', 'Delta'][index % 4]}', ${index * 3 + 1}, ${index + 10})`).join(',\n')}\n) AS layout_fixture(Category, Score, Events);`;
	const markdownText = `# Layout Regression Fixture\n\n${e2eLayoutGeneratedLines('Markdown paragraph', 42)}`;
	const pythonText = `values = list(range(64))\nfor value in values:\n    print('layout row', value)`;

	const queryId = e2eLayoutAddSection('addQueryBox', {
		id: e2eLayoutSpec('query').id,
		initialQuery: queryText,
		defaultResultsVisible: true,
		expanded: true,
	});
	const sqlId = e2eLayoutAddSection('addSqlBox', {
		id: e2eLayoutSpec('sql').id,
		name: 'Layout SQL',
		query: sqlText,
		expanded: true,
		editorHeightPx: 220,
	});

	await e2eLayoutWaitFor(() => !!document.getElementById(queryId) && !!document.getElementById(sqlId), 'query and SQL sections');

	e2eLayoutAddSection('addChartBox', {
		id: e2eLayoutSpec('chart').id,
		name: 'Layout Chart',
		mode: 'preview',
		dataSourceId: queryId,
		chartType: 'bar',
		xColumn: 'Category',
		yColumn: 'Score',
		yColumns: ['Score'],
		editorHeightPx: 240,
	});
	e2eLayoutAddSection('addMarkdownBox', {
		id: e2eLayoutSpec('markdown').id,
		title: 'Layout Markdown',
		text: markdownText,
		mode: 'preview',
		editorHeightPx: 220,
	});
	e2eLayoutAddSection('addTransformationBox', {
		id: e2eLayoutSpec('transformation').id,
		name: 'Layout Transformation',
		mode: 'preview',
		dataSourceId: queryId,
		transformationType: 'derive',
		deriveColumns: [{ name: 'ScoreCopy', expression: 'Score' }],
		editorHeightPx: 240,
	});
	e2eLayoutAddSection('addUrlBox', {
		id: e2eLayoutSpec('url').id,
		name: 'Layout URL',
		url: 'https://example.invalid/e2e-layout.txt',
		outputHeightPx: 180,
		expanded: true,
	});
	e2eLayoutAddSection('addHtmlBox', {
		id: e2eLayoutSpec('html').id,
		name: 'Layout HTML',
		code: e2eLayoutHtmlPreviewCode(),
		mode: 'preview',
		expanded: true,
	});
	e2eLayoutAddSection('addPythonBox', { id: e2eLayoutSpec('python').id });

	await e2eLayoutWaitFor(() => E2E_LAYOUT_SPECS.every(spec => !!document.getElementById(spec.id)), 'all layout sections');
	await e2eSeedQueryResult(queryId, e2eLayoutSampleResult());
	await e2eSeedQueryResult(sqlId, e2eLayoutSampleResult());
	e2eLayoutDispatchUrlContent(e2eLayoutSpec('url').id);

	const pythonSection = e2eLayoutSection(e2eLayoutSpec('python')) as any;
	await e2eLayoutSetMonacoValue(e2eLayoutSpec('python').id, pythonText);
	if (typeof pythonSection.setOutput === 'function') {
		pythonSection.setOutput(e2eLayoutGeneratedLines('Python output', 18));
	}

	const transformationSection = e2eLayoutSection(e2eLayoutSpec('transformation')) as any;
	if (typeof transformationSection.refresh === 'function') {
		transformationSection.refresh();
	}

	await e2eLayoutWaitFor(() => {
		const urlTarget = e2eLayoutSpec('url').target(e2eLayoutSection(e2eLayoutSpec('url')));
		const transformationResizer = e2eLayoutSpec('transformation').resizer(e2eLayoutSection(e2eLayoutSpec('transformation')));
		const markdownViewer = e2eLayoutSection(e2eLayoutSpec('markdown')).querySelector('.markdown-viewer') as HTMLElement | null;
		return e2eLayoutIsDisplayed(urlTarget)
			&& e2eLayoutIsDisplayed(transformationResizer)
			&& e2eLayoutIsDisplayed(markdownViewer)
			&& String(markdownViewer?.textContent || '').includes('Markdown paragraph 42');
	}, 'loaded URL, markdown, and transformation results');

	for (const spec of E2E_LAYOUT_SPECS) {
		await e2eLayoutWaitForUpdate(e2eLayoutSection(spec));
	}
	await e2eLayoutAssertStableHeights('created stress notebook');
	return `created layout stress notebook with ${E2E_LAYOUT_SPECS.length} sections`;
}

function e2eLayoutAssertAllSectionTypes(): string {
	const sections = e2ePersistenceSections();
	const actualIds = sections.map(section => section.id || section.getAttribute('box-id') || '');
	const expectedIds = E2E_LAYOUT_SPECS.map(spec => spec.id);
	if (actualIds.join(',') !== expectedIds.join(',')) {
		throw new Error(`Expected layout section ids ${expectedIds.join(',')}, got ${actualIds.join(',')}`);
	}
	for (const spec of E2E_LAYOUT_SPECS) {
		const section = e2eLayoutSection(spec);
		const target = spec.target(section);
		e2eLayoutAssertDisplayed(section, `${spec.kind} section`);
		e2eLayoutAssertDisplayed(target, `${spec.kind} layout target`);
		e2eLayoutAssertFiniteHeight(spec, target as HTMLElement, `${spec.kind} layout target`);
		e2eLayoutAssertSectionContent(spec);
		if (!e2eLayoutIsDisplayed(spec.resizer(section))) {
			throw new Error(`${spec.kind} resizer should be visible`);
		}
	}
	return `all ${E2E_LAYOUT_SPECS.length} layout section types verified`;
}

async function e2eLayoutAssertStableHeights(context: string): Promise<string> {
	const samples: number[][] = [];
	for (let sample = 0; sample < 4; sample++) {
		samples.push(E2E_LAYOUT_SPECS.map(spec => {
			const section = e2eLayoutSection(spec);
			const target = spec.target(section);
			return target ? Math.round(target.getBoundingClientRect().height) : -1;
		}));
		await e2eLayoutDelay(250);
	}
	E2E_LAYOUT_SPECS.forEach((spec, index) => {
		const values = samples.map(sample => sample[index]);
		if (values.some(value => value <= 0 || !Number.isFinite(value))) {
			throw new Error(`${context}: invalid ${spec.kind} height samples ${values.join(',')}`);
		}
		const min = Math.min(...values);
		const max = Math.max(...values);
		if (max - min > 48) {
			throw new Error(`${context}: unstable ${spec.kind} height samples ${values.join(',')}`);
		}
	});
	const documentHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
	if (documentHeight > 20000) {
		throw new Error(`${context}: document height is unexpectedly large (${documentHeight}px)`);
	}
	return `${context}: layout heights stable`;
}

async function e2eLayoutAssertScrollStability(): Promise<string> {
	e2eLayoutAssertAllSectionTypes();
	const scrollingElement = e2ePageScrollElement();
	const maxScrollTop = e2ePageScrollMaxTop(scrollingElement);
	if (maxScrollTop < 300) {
		throw new Error(`Expected a meaningfully scrollable notebook, got maxScrollTop=${maxScrollTop}`);
	}
	if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 12) {
		throw new Error(`Unexpected horizontal page overflow: ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
	}

	e2eSetPageScrollTop(scrollingElement, 0);
	await e2eLayoutDelay(100);
	if (e2ePageScrollTop(scrollingElement) > 10) {
		throw new Error('Notebook did not scroll to top');
	}
	e2eSetPageScrollTop(scrollingElement, maxScrollTop);
	await e2eLayoutDelay(100);
	if (e2ePageScrollTop(scrollingElement) < maxScrollTop * 0.75) {
		throw new Error(`Notebook did not scroll near bottom; scrollTop=${e2ePageScrollTop(scrollingElement)}, max=${maxScrollTop}`);
	}

	for (const spec of E2E_LAYOUT_SPECS) {
		const section = e2eLayoutSection(spec);
		section.scrollIntoView({ block: 'center' });
		await e2eLayoutDelay(100);
		const rect = section.getBoundingClientRect();
		if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
			throw new Error(`${spec.kind} section is not visible after scrollIntoView: top=${rect.top}, bottom=${rect.bottom}`);
		}
	}

	await e2eLayoutAssertStableHeights('scroll stability');
	return `scroll stability verified across ${E2E_LAYOUT_SPECS.length} sections`;
}

async function e2eLayoutExerciseCollapseExpand(): Promise<string> {
	e2eLayoutAssertAllSectionTypes();
	for (const spec of E2E_LAYOUT_SPECS) {
		const section = e2eLayoutSection(spec);
		section.scrollIntoView({ block: 'center' });
		await e2eLayoutDelay(75);
		const beforeTarget = spec.target(section);
		const beforeHeight = e2eLayoutAssertDisplayed(beforeTarget, `${spec.kind} target before collapse`).height;
		e2eLayoutShellButton(section, spec.kind, '.toggle-btn').click();
		await e2eLayoutWaitForUpdate(section);
		await e2eLayoutDelay(100);
		const collapsedTarget = spec.target(section);
		if (e2eLayoutIsDisplayed(collapsedTarget)) {
			throw new Error(`${spec.kind} target remained visible after collapse`);
		}
		e2eLayoutShellButton(section, spec.kind, '.toggle-btn').click();
		await e2eLayoutWaitForUpdate(section);
		await e2eLayoutWaitFor(() => e2eLayoutIsDisplayed(spec.target(section)), `${spec.kind} target to reappear after expand`);
		e2eLayoutAssertFiniteHeight(spec, spec.target(section) as HTMLElement, `${spec.kind} target after expand`);
		e2eLayoutAssertSectionContent(spec);
	}
	await e2eLayoutAssertStableHeights('collapse and expand');
	return `collapse and expand verified across ${E2E_LAYOUT_SPECS.length} sections`;
}

function e2eLayoutDispatchDrag(resizer: HTMLElement, deltaY: number): void {
	const rect = resizer.getBoundingClientRect();
	const clientX = Math.max(1, Math.round(rect.left + Math.max(4, rect.width / 2)));
	const clientY = Math.max(1, Math.round(rect.top + Math.max(1, rect.height / 2)));
	const base: MouseEventInit = {
		bubbles: true,
		cancelable: true,
		composed: true,
		view: window,
		button: 0,
		buttons: 1,
		clientX,
		clientY,
	};
	resizer.dispatchEvent(new MouseEvent('mousedown', base));
	document.dispatchEvent(new MouseEvent('mousemove', { ...base, clientY: clientY + deltaY }));
	document.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0, clientY: clientY + deltaY }));
}

async function e2eLayoutExerciseAutoFitAndResize(): Promise<string> {
	e2eLayoutAssertAllSectionTypes();
	for (const spec of E2E_LAYOUT_SPECS) {
		const section = e2eLayoutSection(spec);
		section.scrollIntoView({ block: 'center' });
		await e2eLayoutDelay(100);
		const target = spec.target(section);
		const resizer = spec.resizer(section);
		e2eLayoutAssertDisplayed(target, `${spec.kind} resize target`);
		e2eLayoutAssertDisplayed(resizer, `${spec.kind} resizer`);
		const beforeDrag = e2eLayoutAssertFiniteHeight(spec, target as HTMLElement, `${spec.kind} before drag`);
		e2eLayoutDispatchDrag(resizer as HTMLElement, 72);
		await e2eLayoutDelay(150);
		const afterDrag = e2eLayoutAssertFiniteHeight(spec, target as HTMLElement, `${spec.kind} after drag`);
		if (Math.abs(afterDrag - beforeDrag) < 18) {
			e2eLayoutDispatchDrag(resizer as HTMLElement, -72);
			await e2eLayoutDelay(150);
			const afterReverseDrag = e2eLayoutAssertFiniteHeight(spec, target as HTMLElement, `${spec.kind} after reverse drag`);
			if (Math.abs(afterReverseDrag - beforeDrag) < 18) {
				throw new Error(`${spec.kind} manual resize did not change height; before=${beforeDrag}, after=${afterDrag}, reverse=${afterReverseDrag}`);
			}
		}

		const fitButton = e2eLayoutShellButton(section, spec.kind, '.md-max-btn');
		fitButton.click();
		await e2eLayoutWaitForUpdate(section);
		await e2eLayoutDelay(200);
		e2eLayoutAssertFiniteHeight(spec, spec.target(section) as HTMLElement, `${spec.kind} after fit to contents`);
		e2eLayoutAssertSectionContent(spec);
	}
	await e2eLayoutAssertStableHeights('fit and resize');
	return `fit and resize verified across ${E2E_LAYOUT_SPECS.length} sections`;
}

async function e2eLayoutAssertNoLayoutRegression(): Promise<string> {
	e2eLayoutAssertAllSectionTypes();
	await e2eLayoutAssertScrollStability();
	return 'layout regression checks passed';
}

async function e2eAssertKustoClickCaretFidelityWithHtmlSection(): Promise<string> {
	_win.__testRemoveAllSections();
	await e2eLayoutWaitFor(() => document.querySelectorAll(TEST_SECTION_SELECTOR).length === 0, 'all sections to be removed');

	const queryText = Array.from({ length: 18 }, (_value, index) => `print row_${String(index + 1).padStart(2, '0')}`).join('\n');
	const queryId = e2eLayoutAddSection('addQueryBox', {
		id: 'query_click_fidelity',
		initialQuery: queryText,
		expanded: true,
	});
	e2eLayoutAddSection('addHtmlBox', {
		id: 'html_click_fidelity',
		name: 'Caret HTML',
		code: e2eLayoutHtmlPreviewCode(),
		mode: 'preview',
		expanded: true,
	});
	await e2eLayoutWaitFor(() => !!document.getElementById(queryId) && !!document.getElementById('html_click_fidelity'), 'Kusto and HTML caret fidelity sections');
	await e2eLayoutDelay(250);

	const querySection = document.getElementById(queryId) as HTMLElement | null;
	if (!querySection) {
		throw new Error('Kusto click fidelity section was not created');
	}
	querySection.scrollIntoView({ block: 'center' });
	await e2eLayoutDelay(150);

	const editor = resolveMonacoEditorFromElement(querySection);
	if (!editor || typeof editor.getDomNode !== 'function' || typeof editor.getScrolledVisiblePosition !== 'function' || typeof editor.getPosition !== 'function') {
		throw new Error('Kusto Monaco editor does not expose caret-position APIs');
	}
	const editorRoot = editor.getDomNode();
	if (!editorRoot) {
		throw new Error('Kusto Monaco editor DOM node unavailable');
	}
	try { editor.layout?.(); } catch { /* ignore */ }
	try { editor.setPosition?.({ lineNumber: 1, column: 1 }); } catch { /* ignore */ }

	const targetLine = 5;
	const targetColumn = 4;
	const visiblePosition = editor.getScrolledVisiblePosition({ lineNumber: targetLine, column: targetColumn });
	if (!visiblePosition) {
		throw new Error(`Target caret position ${targetLine}:${targetColumn} is not visible`);
	}
	const editorRect = editorRoot.getBoundingClientRect();
	const clientX = Math.round(editorRect.left + visiblePosition.left + 2);
	const clientY = Math.round(editorRect.top + visiblePosition.top + Math.max(2, visiblePosition.height / 2));
	const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
	if (!target) {
		throw new Error(`No DOM target at Monaco click point ${clientX},${clientY}`);
	}

	const mouseInit: MouseEventInit = {
		bubbles: true,
		cancelable: true,
		composed: true,
		view: window,
		button: 0,
		buttons: 1,
		clientX,
		clientY,
		detail: 1,
	};
	try { target.dispatchEvent(new PointerEvent('pointerdown', mouseInit)); } catch { /* ignore */ }
	target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
	target.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
	target.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 }));
	await e2eLayoutDelay(300);

	const position = editor.getPosition();
	if (!position) {
		throw new Error('Kusto editor caret position unavailable after click');
	}
	if (position.lineNumber !== targetLine || position.column !== targetColumn) {
		throw new Error(`Kusto editor caret jumped after mixed HTML click: expected ${targetLine}:${targetColumn}, got ${position.lineNumber}:${position.column}`);
	}
	return `Kusto caret stayed on clicked line ${position.lineNumber}:${position.column} with HTML section present`;
}

function e2ePageScrollElement(): HTMLElement {
	const scrollElement = getPageScrollElement()
		|| (document.scrollingElement as HTMLElement | null)
		|| document.documentElement;
	if (!scrollElement) {
		throw new Error('No page scroll element available');
	}
	return scrollElement;
}

function e2ePageScrollTop(scrollElement: HTMLElement): number {
	return getPageScrollTop(scrollElement);
}

function e2ePageScrollMaxTop(scrollElement: HTMLElement): number {
	return getPageScrollMaxTop(scrollElement);
}

function e2eSetPageScrollTop(scrollElement: HTMLElement, scrollTop: number): void {
	setPageScrollTop(scrollTop, scrollElement);
	try { scrollElement.dispatchEvent(new Event('scroll')); } catch { /* ignore */ }
}

function e2eAssertOverlayScrollContract(scrollElement: HTMLElement, context: string): string {
	const scrollTop = e2ePageScrollTop(scrollElement);
	const nativeScrollY = Number(window.scrollY || 0);
	const nativePageYOffset = Number(window.pageYOffset || 0);
	const documentTop = Number(document.documentElement.scrollTop || 0);
	if (scrollTop > 100) {
		const fakeReadDetected = Math.abs(nativeScrollY - scrollTop) < 2
			|| Math.abs(nativePageYOffset - scrollTop) < 2
			|| Math.abs(documentTop - scrollTop) < 2;
		if (fakeReadDetected) {
			throw new Error(`${context}: global scroll reads are still spoofed; pageScrollTop=${scrollTop}, window.scrollY=${nativeScrollY}, pageYOffset=${nativePageYOffset}, documentElement.scrollTop=${documentTop}`);
		}
	}
	return `pageScrollTop=${scrollTop}, nativeScrollY=${nativeScrollY}, pageYOffset=${nativePageYOffset}, documentElement.scrollTop=${documentTop}`;
}

function e2eScrollElementIntoPageView(element: HTMLElement, block: 'start' | 'center'): HTMLElement {
	const scrollElement = e2ePageScrollElement();
	const scrollRect = scrollElement === document.documentElement || scrollElement === document.body
		? { top: 0, height: window.innerHeight }
		: scrollElement.getBoundingClientRect();
	const elementRect = element.getBoundingClientRect();
	const currentTop = e2ePageScrollTop(scrollElement);
	let nextTop = currentTop + elementRect.top - scrollRect.top;
	if (block === 'center') {
		nextTop -= Math.max(0, (scrollRect.height - Math.min(elementRect.height, scrollRect.height)) / 2);
	}
	e2eSetPageScrollTop(scrollElement, nextTop);
	return scrollElement;
}

function e2eDescribeElement(element: Element | null): string {
	if (!element) return '(null)';
	const htmlElement = element as HTMLElement;
	const id = htmlElement.id ? `#${htmlElement.id}` : '';
	const classes = String(htmlElement.className || '').trim().replace(/\s+/g, '.');
	return `${htmlElement.tagName.toLowerCase()}${id}${classes ? '.' + classes : ''}`;
}

type RestoredNativeClickExpectation = {
	lineNumber: number;
	column: number;
	clientX: number;
	clientY: number;
	scrollTop: number;
	targetDescription: string;
};

const RESTORED_NATIVE_CLICK_CLIENT_X = 185;
const RESTORED_NATIVE_CLICK_CLIENT_Y = 560;

async function e2ePrepareRestoredHtmlPreviewNativeClickTarget(): Promise<string> {
	await e2eLayoutWaitFor(() => !!document.getElementById('html_click_fidelity_restored') && !!document.getElementById('query_click_fidelity_restored'), 'restored HTML and Kusto sections', 15000);
	const htmlSection = document.getElementById('html_click_fidelity_restored') as HTMLElement | null;
	const querySection = document.getElementById('query_click_fidelity_restored') as HTMLElement | null;
	if (!htmlSection || !querySection) {
		throw new Error('Restored native-click fixture sections are missing');
	}

	await e2eLayoutWaitFor(() => {
		const previewWrapper = htmlSection.shadowRoot?.getElementById('preview-wrapper') as HTMLElement | null;
		const rect = previewWrapper?.getBoundingClientRect();
		return !!previewWrapper && !!rect && rect.height >= 1200;
	}, 'restored native-click tall HTML preview wrapper', 15000);

	const scrollElement = e2ePageScrollElement();
	const maxScrollTop = e2ePageScrollMaxTop(scrollElement);
	if (maxScrollTop < 600) {
		throw new Error(`Restored native-click fixture did not create a meaningful page scroll range: maxScrollTop=${maxScrollTop}`);
	}

	e2eSetPageScrollTop(scrollElement, 0);
	await e2eLayoutDelay(100);
	e2eScrollElementIntoPageView(querySection, 'center');
	await e2eLayoutDelay(250);

	const editor = resolveMonacoEditorFromElement(querySection);
	if (!editor || typeof editor.getDomNode !== 'function' || typeof editor.getScrolledVisiblePosition !== 'function' || typeof editor.getPosition !== 'function') {
		throw new Error('Restored native-click Kusto Monaco editor does not expose required APIs');
	}
	const editorRoot = editor.getDomNode();
	if (!editorRoot) {
		throw new Error('Restored native-click Kusto Monaco editor DOM node unavailable');
	}
	try { editor.layout?.(); } catch { /* ignore */ }
	try { editor.render?.(true); } catch { /* ignore */ }

	const targetLine = 6;
	const targetColumn = 10;
	const position = editor.getScrolledVisiblePosition({ lineNumber: targetLine, column: targetColumn });
	if (!position) {
		throw new Error(`Restored native-click target ${targetLine}:${targetColumn} is not visible`);
	}
	const editorRect = editorRoot.getBoundingClientRect();
	const currentClientY = Math.round(editorRect.top + position.top + Math.max(2, position.height / 2));
	const nextScrollTop = e2ePageScrollTop(scrollElement) + currentClientY - RESTORED_NATIVE_CLICK_CLIENT_Y;
	e2eSetPageScrollTop(scrollElement, nextScrollTop);
	await e2eLayoutDelay(250);
	try { editor.layout?.(); } catch { /* ignore */ }
	try { editor.render?.(true); } catch { /* ignore */ }

	const target = document.elementFromPoint(RESTORED_NATIVE_CLICK_CLIENT_X, RESTORED_NATIVE_CLICK_CLIENT_Y) as HTMLElement | null;
	const mappedTarget = editor.getTargetAtClientPoint?.(RESTORED_NATIVE_CLICK_CLIENT_X, RESTORED_NATIVE_CLICK_CLIENT_Y);
	if (!target || !mappedTarget?.position) {
		throw new Error(`Native-click coordinate ${RESTORED_NATIVE_CLICK_CLIENT_X},${RESTORED_NATIVE_CLICK_CLIENT_Y} did not map to Monaco content; target=${e2eDescribeElement(target)}`);
	}
	if (mappedTarget.position.lineNumber !== targetLine) {
		const rect = editorRoot.getBoundingClientRect();
		throw new Error(`Native-click coordinate mapped to wrong line before click: expected line ${targetLine}, got ${mappedTarget.position.lineNumber}:${mappedTarget.position.column}; editorRect=${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)}; target=${e2eDescribeElement(target)}`);
	}

	const expectation: RestoredNativeClickExpectation = {
		lineNumber: mappedTarget.position.lineNumber,
		column: mappedTarget.position.column,
		clientX: RESTORED_NATIVE_CLICK_CLIENT_X,
		clientY: RESTORED_NATIVE_CLICK_CLIENT_Y,
		scrollTop: e2ePageScrollTop(scrollElement),
		targetDescription: e2eDescribeElement(target),
	};
	_win.__e2eRestoredNativeClickExpectation = expectation;
	try { editor.setPosition?.({ lineNumber: 1, column: 1 }); } catch { /* ignore */ }
	return `prepared restored native click at ${expectation.clientX},${expectation.clientY}; expected=${expectation.lineNumber}:${expectation.column}; scrollTop=${expectation.scrollTop}/${maxScrollTop}; target=${expectation.targetDescription}; ${e2eAssertOverlayScrollContract(scrollElement, 'native-click prepare scroll contract')}`;
}

async function e2eAssertRestoredHtmlPreviewNativeClickTarget(): Promise<string> {
	await e2eLayoutDelay(250);
	const expectation = _win.__e2eRestoredNativeClickExpectation as RestoredNativeClickExpectation | undefined;
	if (!expectation) {
		throw new Error('Restored native-click expectation was not prepared');
	}
	const querySection = document.getElementById('query_click_fidelity_restored') as HTMLElement | null;
	const editor = querySection ? resolveMonacoEditorFromElement(querySection) : null;
	if (!editor || typeof editor.getPosition !== 'function') {
		throw new Error('Restored native-click Kusto editor unavailable for assertion');
	}
	const position = editor.getPosition();
	if (!position) {
		throw new Error('Restored native-click Kusto caret position unavailable after native click');
	}
	if (position.lineNumber !== expectation.lineNumber || position.column !== expectation.column) {
		throw new Error(`Native click mapped incorrectly: expected ${expectation.lineNumber}:${expectation.column}, got ${position.lineNumber}:${position.column}; click=${expectation.clientX},${expectation.clientY}; preparedScrollTop=${expectation.scrollTop}; target=${expectation.targetDescription}`);
	}
	return `native click kept Kusto caret at ${position.lineNumber}:${position.column}; click=${expectation.clientX},${expectation.clientY}; preparedScrollTop=${expectation.scrollTop}; target=${expectation.targetDescription}`;
}

async function e2eAssertKustoClickCaretFidelityAfterRestoredHtmlPreviewScroll(): Promise<string> {
	await e2eLayoutWaitFor(() => !!document.getElementById('html_click_fidelity_restored') && !!document.getElementById('query_click_fidelity_restored'), 'restored HTML and Kusto sections', 15000);
	const htmlSection = document.getElementById('html_click_fidelity_restored') as HTMLElement | null;
	const querySection = document.getElementById('query_click_fidelity_restored') as HTMLElement | null;
	if (!htmlSection || !querySection) {
		throw new Error('Restored click-fidelity fixture sections are missing');
	}

	await e2eLayoutWaitFor(() => {
		const previewWrapper = htmlSection.shadowRoot?.getElementById('preview-wrapper') as HTMLElement | null;
		const iframe = htmlSection.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
		const rect = previewWrapper?.getBoundingClientRect();
		return !!previewWrapper && !!iframe && !!rect && rect.height >= 1200;
	}, 'restored tall HTML preview wrapper', 15000);

	const scrollElement = e2ePageScrollElement();
	const maxScrollTop = e2ePageScrollMaxTop(scrollElement);
	if (maxScrollTop < 600) {
		throw new Error(`Restored fixture did not create a meaningful page scroll range: maxScrollTop=${maxScrollTop}, scrollHeight=${scrollElement.scrollHeight}, clientHeight=${scrollElement.clientHeight}`);
	}

	e2eSetPageScrollTop(scrollElement, 0);
	await e2eLayoutDelay(100);
	e2eScrollElementIntoPageView(htmlSection, 'start');
	await e2eLayoutDelay(100);
	e2eSetPageScrollTop(scrollElement, e2ePageScrollTop(scrollElement) + 900);
	await e2eLayoutDelay(200);
	e2eScrollElementIntoPageView(querySection, 'center');
	await e2eLayoutDelay(300);
	const scrollContract = e2eAssertOverlayScrollContract(scrollElement, 'restored click-fidelity scroll contract');

	const editor = resolveMonacoEditorFromElement(querySection);
	if (!editor || typeof editor.getDomNode !== 'function' || typeof editor.getScrolledVisiblePosition !== 'function' || typeof editor.getPosition !== 'function') {
		throw new Error('Restored Kusto Monaco editor does not expose caret-position APIs');
	}
	const editorRoot = editor.getDomNode();
	if (!editorRoot) {
		throw new Error('Restored Kusto Monaco editor DOM node unavailable');
	}

	await e2eLayoutWaitFor(() => {
		const rect = editorRoot.getBoundingClientRect();
		return editorRoot.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
	}, 'restored Kusto editor to become visible and measurable', 10000);

	try { editor.setPosition?.({ lineNumber: 1, column: 1 }); } catch { /* ignore */ }
	await e2eLayoutAnimationFrame();

	const targetLine = 6;
	const targetColumn = 10;
	const visiblePosition = editor.getScrolledVisiblePosition({ lineNumber: targetLine, column: targetColumn });
	if (!visiblePosition) {
		throw new Error(`Restored target caret position ${targetLine}:${targetColumn} is not visible`);
	}
	const editorRect = editorRoot.getBoundingClientRect();
	const clientX = Math.round(editorRect.left + visiblePosition.left + 2);
	const clientY = Math.round(editorRect.top + visiblePosition.top + Math.max(2, visiblePosition.height / 2));
	const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
	if (!target) {
		throw new Error(`No DOM target at restored Monaco click point ${clientX},${clientY}`);
	}

	let expectedPosition = { lineNumber: targetLine, column: targetColumn };
	try {
		const mappedTarget = editor.getTargetAtClientPoint?.(clientX, clientY);
		if (mappedTarget?.position) {
			expectedPosition = { lineNumber: mappedTarget.position.lineNumber, column: mappedTarget.position.column };
		}
	} catch { /* ignore */ }
	if (expectedPosition.lineNumber !== targetLine) {
		throw new Error(`Restored click point mapped to unexpected line before dispatch: expected line ${targetLine}, got ${expectedPosition.lineNumber}:${expectedPosition.column}`);
	}

	const mouseInit: MouseEventInit = {
		bubbles: true,
		cancelable: true,
		composed: true,
		view: window,
		button: 0,
		buttons: 1,
		clientX,
		clientY,
		detail: 1,
	};
	try { target.dispatchEvent(new PointerEvent('pointerdown', { ...mouseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch { /* ignore */ }
	target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
	target.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));
	target.dispatchEvent(new MouseEvent('click', { ...mouseInit, buttons: 0 }));
	await e2eLayoutDelay(350);

	const position = editor.getPosition();
	if (!position) {
		throw new Error('Restored Kusto editor caret position unavailable after click');
	}
	if (position.lineNumber !== expectedPosition.lineNumber || position.column !== expectedPosition.column) {
		const scrollTop = e2ePageScrollTop(scrollElement);
		const queryRect = querySection.getBoundingClientRect();
		const targetRect = target.getBoundingClientRect();
		throw new Error(`Restored HTML preview click mapped incorrectly: expected ${expectedPosition.lineNumber}:${expectedPosition.column}, got ${position.lineNumber}:${position.column}; scrollTop=${scrollTop}/${maxScrollTop}; editorRect=${Math.round(editorRect.left)},${Math.round(editorRect.top)},${Math.round(editorRect.width)}x${Math.round(editorRect.height)}; queryRect=${Math.round(queryRect.left)},${Math.round(queryRect.top)},${Math.round(queryRect.width)}x${Math.round(queryRect.height)}; click=${clientX},${clientY}; target=${e2eDescribeElement(target)}; targetRect=${Math.round(targetRect.left)},${Math.round(targetRect.top)},${Math.round(targetRect.width)}x${Math.round(targetRect.height)}`);
	}
	return `Restored HTML preview click kept Kusto caret at ${position.lineNumber}:${position.column}; pageScrollTop=${e2ePageScrollTop(scrollElement)}/${maxScrollTop}; ${scrollContract}; target=${e2eDescribeElement(target)}`;
}

async function e2eSeedQueryResult(boxId: string, result: unknown): Promise<string> {
	const id = String(boxId || '').trim();
	const section = document.getElementById(id) as any;
	if (!id || !section) throw new Error(`Result owner not found: ${id || '(empty)'}`);
	if (section.updateComplete && typeof section.updateComplete.then === 'function') await section.updateComplete;
	await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
	let accepted = displayResultForBox(result, id, { label: 'Results', showExecutionTime: true });
	if (!accepted) throw new Error(`Result owner rejected local E2E data: ${id}`);
	if (section.updateComplete && typeof section.updateComplete.then === 'function') await section.updateComplete;
	const hasTabularData = Array.isArray((result as any)?.columns) || Array.isArray((result as any)?.rows);
	let table = section.querySelector?.('kw-data-table') || section.shadowRoot?.querySelector?.('kw-data-table');
	if (hasTabularData && !table) {
		accepted = displayResultForBox(result, id, { label: 'Results', showExecutionTime: true });
		if (!accepted) throw new Error(`Result owner rejected replayed local E2E data: ${id}`);
		if (section.updateComplete && typeof section.updateComplete.then === 'function') await section.updateComplete;
		table = section.querySelector?.('kw-data-table') || section.shadowRoot?.querySelector?.('kw-data-table');
	}
	if (hasTabularData && !table) throw new Error(`Result table did not survive local E2E rendering: ${id}`);
	if (table?.updateComplete && typeof table.updateComplete.then === 'function') await table.updateComplete;
	return `seeded local result for ${id}`;
}

if (document.body.dataset.kustoE2eEnabled === 'true') {
	_win.__e2e = {
	proof: {
		clear: e2eClearProofMarker,
		id: e2eProofId,
	},
	perf: {
		snapshot: perfSnapshot,
		markWebviewSnapshot: (proofName: string, requiredCsv: string = '') => e2eMarkPerfSnapshot(proofName, 'webview', 'webview', requiredCsv),
	},
	workbench: {
		clearSections: () => _win.__testRemoveAllSections(),
		seedResult: e2eSeedQueryResult,
		enableIsolatedKustoConnections: e2eEnableIsolatedKustoConnections,
		assertIsolatedKustoConnections: e2eAssertIsolatedKustoConnections,
		removeSection: (selector: string) => _win.__testRemoveSection(selector),
	},
	layout: {
		createStressNotebook: e2eLayoutCreateStressNotebook,
		assertAllSectionTypes: e2eLayoutAssertAllSectionTypes,
		assertScrollStability: e2eLayoutAssertScrollStability,
		exerciseCollapseExpand: e2eLayoutExerciseCollapseExpand,
		exerciseAutoFitAndResize: e2eLayoutExerciseAutoFitAndResize,
		assertNoLayoutRegression: e2eLayoutAssertNoLayoutRegression,
	},
	chart: {
		assertTitleSyncAndHeatmapNumericCategories: e2eChartAssertTitleSyncAndHeatmapNumericCategories,
	},
	cursorStatus: {
		beginCapture: e2eBeginHostMessageCapture,
		restoreCapture: e2eRestoreHostMessageCapture,
		createNotebook: e2eCursorCreateNotebook,
		hoverKusto: (lineNumber: number, column: number) => e2eCursorHoverMonaco('cursor_query', lineNumber, column),
		focusKusto: (lineNumber: number, column: number) => e2eCursorFocusMonaco('cursor_query', lineNumber, column),
		focusSql: (lineNumber: number, column: number) => e2eCursorFocusMonaco('cursor_sql', lineNumber, column),
		focusHtml: (lineNumber: number, column: number) => e2eCursorFocusMonaco('cursor_html', lineNumber, column),
		focusPython: (lineNumber: number, column: number) => e2eCursorFocusMonaco('cursor_python', lineNumber, column),
		focusMarkdown: (lineNumber: number, column: number) => e2eCursorFocusMarkdown(lineNumber, column),
		setHtmlPreview: e2eCursorSetHtmlPreview,
		setMarkdownPreview: e2eCursorSetMarkdownPreview,
		setKustoExpanded: e2eCursorSetKustoExpanded,
		assertVisible: (editorKind: string, lineNumber: number, column: number, timeoutMs: number = 5000) => e2eAssertCursorStatusMessage(editorKind, lineNumber, column, true, timeoutMs),
		assertHidden: (editorKind: string, timeoutMs: number = 5000) => e2eAssertCursorStatusMessage(editorKind, undefined, undefined, false, timeoutMs),
		assertStatusBarVisible: (editorKind: string, lineNumber: number, column: number, timeoutMs: number = 5000) => e2eAssertCursorStatusBar(editorKind, lineNumber, column, true, timeoutMs),
		assertStatusBarHidden: (timeoutMs: number = 5000) => e2eAssertCursorStatusBar('', undefined, undefined, false, timeoutMs),
	},
	sql: {
		...e2eQueryApi('sql'),
		resultContract: () => {
			const section = e2eSection('sql');
			const state = getResultsState(section.boxId);
			if (!state) throw new Error('SQL result state is unavailable');
			return {
				columns: state.columns,
				rows: state.rows,
				metadata: state.metadata,
			};
		},
		assertTypeContract: () => {
			const result = _win.__e2e.sql.resultContract();
			const row = result.rows[0];
			const byName = Object.fromEntries(result.columns.map((column: any, index: number) => [column.name, row[index]]));
			const expected: Record<string, string> = {
				NullValue: 'null',
				BitValue: 'true',
				BigValue: '9007199254740993',
				DecimalValue: '1234567890.123456789',
				GuidValue: '12345678-1234-1234-1234-1234567890ab',
			};
			for (const [name, value] of Object.entries(expected)) {
				if (String(byName[name]?.full) !== value) {
					throw new Error(`${name} full=${byName[name]?.full} expected=${value}`);
				}
			}
			if (!String(byName.BinaryValue?.full).toLowerCase().includes('0102ff')) throw new Error(`BinaryValue full=${byName.BinaryValue?.full}`);
			if (!String(byName.OffsetValue?.full).includes('+05:30')) throw new Error(`OffsetValue lost offset: ${byName.OffsetValue?.full}`);
			if (!String(byName.JsonText?.full).includes('{"a":1}')) throw new Error(`JsonText full=${byName.JsonText?.full}`);
			if (!String(byName.XmlValue?.full).includes('<root>')) throw new Error(`XmlValue full=${byName.XmlValue?.full}`);
			return 'SQL type contract preserved';
		},
		connectSts: () => {
			const section = e2eSection('sql');
			if (section.dataset.testStsReady === 'true') {
				return 'sql STS already ready';
			}
			const sqlConnectionId = typeof section.getSqlConnectionId === 'function' ? section.getSqlConnectionId() : '';
			const database = typeof section.getDatabase === 'function' ? section.getDatabase() : '';
			if (!sqlConnectionId) {
				throw new Error('SQL connection id missing before STS connect');
			}
			if (!database) {
				throw new Error('SQL database missing before STS connect');
			}
			postMessageToHost({
				type: 'stsConnect', boxId: section.boxId, sqlConnectionId, database,
				targetGeneration: sqlTargetGenerationByBoxId[section.boxId] ?? 0,
			});
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
		runFunctionManual: {
			setConnected: e2eRunFunctionSetConnected,
			leadingComments: e2eRunFunctionManualLeadingComments,
			cursorSecondSameLine: e2eRunFunctionManualCursorSecondSameLine,
			crlfSecond: e2eRunFunctionManualCrlfSecond,
			openParameterizedDialog: e2eRunFunctionManualOpenParameterizedDialog,
			finishParameterizedDialog: e2eRunFunctionManualFinishParameterizedDialog,
			fencedKql: e2eRunFunctionManualFencedKql,
			cursorOutsideShowsNoFunction: e2eRunFunctionManualCursorOutsideShowsNoFunction,
		},
		favorites: {
			prepareDocument: e2eKustoPrepareFavoriteDocument,
			clean: e2eKustoCleanFavorite,
			addFromSection: e2eKustoAddFavoriteFromSection,
			setProbe: e2eKustoSetFavoritesSyncProbe,
			assertProbe: e2eKustoAssertFavoritesSyncProbe,
			assertVisibleInAllSections: (name: string, expectedSectionCount?: number, timeoutMs?: number) => e2eKustoAssertFavoriteInAllSections(name, expectedSectionCount, true, timeoutMs),
			assertAbsentInAllSections: (name: string, expectedSectionCount?: number, timeoutMs?: number) => e2eKustoAssertFavoriteInAllSections(name, expectedSectionCount, false, timeoutMs),
		},
		manualIdentityChecklist: {
			run: e2eKustoRunIdentityManualChecklist,
			snapshot: e2eKustoIdentityManualChecklistSnapshot,
		},
		assertClickCaretFidelityWithHtmlSection: () => e2eAssertKustoClickCaretFidelityWithHtmlSection(),
		assertClickCaretFidelityAfterRestoredHtmlPreviewScroll: () => e2eAssertKustoClickCaretFidelityAfterRestoredHtmlPreviewScroll(),
		prepareRestoredHtmlPreviewNativeClickTarget: () => e2ePrepareRestoredHtmlPreviewNativeClickTarget(),
		assertRestoredHtmlPreviewNativeClickTarget: () => e2eAssertRestoredHtmlPreviewNativeClickTarget(),
		selectSampleDatabase: (sectionIndex: number = 0) => e2eSelectSampleKustoDatabase(sectionIndex),
		selectDifferentDatabase: () => e2eSelectDifferentKustoDatabase(),
		assertPreparationReady: (sectionIndex: number = 0) => e2eAssertKustoPreparationReady(sectionIndex),
		waitForPreparationReady: (sectionIndex: number = 0, timeoutMs: number = 25000) => e2eWaitForKustoPreparationReady(sectionIndex, timeoutMs),
		assertWorkerContext: (sectionIndex: number = 0) => e2eAssertKustoWorkerContext(sectionIndex),
		waitForWorkerContext: (sectionIndex: number = 0, timeoutMs: number = 10000) => e2eWaitForKustoWorkerContext(sectionIndex, timeoutMs),
		assertActualWorkerContext: (sectionIndex: number = 0) => e2eAssertActualKustoWorkerContext(sectionIndex),
		assertTableCompletionForSection: (sectionIndex: number = 0, timeoutMs: number = 5000) => e2eAssertKustoTableCompletionForSection(sectionIndex, timeoutMs),
		waitForSupplementalState: (sectionIndex: number = 0, status: string = 'loaded', timeoutMs: number = 15000) => e2eWaitForKustoSupplementalState(sectionIndex, status, timeoutMs),
		assertNoSupplementalWarnings: (sectionIndex: number = 0) => e2eAssertNoKustoSupplementalWarnings(sectionIndex),
		assertSupplementalBackgroundTrace: (sectionIndex: number = 0) => e2eAssertKustoSupplementalBackgroundTrace(sectionIndex),
		assertColumnCompletionForSection: (sectionIndex: number, column: string, timeoutMs: number = 5000) => e2eAssertKustoColumnCompletionForSection(sectionIndex, column, timeoutMs),
		requestSchemaApply: () => {
			const section = document.querySelector('kw-query-section') as any;
			return requestKustoSchemaApplyForBox(String(section?.boxId || section?.id || ''), true);
		},
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
		applySemanticCompletionFixture: () => e2eApplyKustoSemanticFixture(),
		applyCurrentClusterWorkflowFixture: () => e2eApplyKustoCurrentClusterWorkflowFixture(),
		setQueryWithCaretMarker: (queryWithMarker: string, marker?: string) => e2eSetKustoQueryWithCaretMarker(queryWithMarker, marker),
		setQueryWithCaretMarkerStrict: (queryWithMarker: string, marker?: string) => e2eSetKustoQueryWithCaretMarkerStrict(queryWithMarker, marker),
		setSemanticScenario: (scenario: KustoSemanticCompletionScenario) => {
			const { query, context } = e2eKustoSemanticScenarioQuery(scenario);
			return e2eSetKustoQueryWithCaretMarker(query) + ` for ${context}`;
		},
		setCurrentClusterWorkflowScenario: () => e2eSetCurrentClusterWorkflowScenario(),
		setMissingRemoteSchemaScenario: () => e2eSetKustoQueryWithCaretMarker(e2eKustoMissingRemoteSchemaQuery()) + ' for missing remote schema timeout',
		assertSemanticSuggestAt: (queryWithMarker: string, expectedCsv: string, context: string, timeoutMs?: number) => e2eAssertKustoSemanticSuggestAt(queryWithMarker, expectedCsv, context, timeoutMs),
		assertSemanticScenario: (scenario: KustoSemanticCompletionScenario, timeoutMs?: number) => e2eAssertKustoSemanticScenario(scenario, timeoutMs),
		assertSemanticScenarioVisible: (scenario: KustoSemanticCompletionScenario, timeoutMs?: number) => e2eAssertKustoSemanticScenarioVisible(scenario, timeoutMs),
		assertSemanticCrossClusterTrace: () => e2eAssertKustoCrossClusterTraceForSemanticFixture(),
		suggestDiagnostics: (context: string = 'kusto semantic suggestions', sectionIndex: number = 0) => e2eSuggestDiagnostics(context, `kw-query-section:nth-of-type(${sectionIndex + 1}) .query-editor`, sectionIndex),
		liveSemanticDiagnostics: (context: string = 'live semantic diagnostics') => e2eKustoLiveSemanticDiagnostics(context),
		clearCrossClusterTrace: () => { if (typeof _win.__kustoClearCrossClusterTrace === 'function') _win.__kustoClearCrossClusterTrace(); return 'cross-cluster trace cleared'; },
		getCrossClusterTrace: () => typeof _win.__kustoGetCrossClusterTrace === 'function' ? _win.__kustoGetCrossClusterTrace() : [],
		getAutocompleteTrace: (traceId?: string) => typeof _win.__kustoGetAutocompleteTrace === 'function' ? _win.__kustoGetAutocompleteTrace(traceId) : null,
		compactAutocompleteTrace: (traceId?: string) => e2eCompactAutocompleteTrace(traceId),
		assertAutocompleteTraceEvents: (context: string, requiredCsv: string = '', forbiddenCsv: string = '') => e2eAssertAutocompleteTraceEvents(context, requiredCsv, forbiddenCsv),
		markAutocompleteTraceEvents: (proofName: string, context: string, requiredCsv: string = '', forbiddenCsv: string = '', timeoutMs: number = 5000) => e2eMarkAutocompleteTraceEvents(proofName, context, requiredCsv, forbiddenCsv, timeoutMs),
		assertAutocompleteTraceSanitized: (context?: string) => e2eAssertAutocompleteTraceSanitized(context),
		markAutocompleteTraceSanitized: (proofName: string, context?: string) => e2eMarkAutocompleteTraceSanitized(proofName, context),
		clearAutocompleteTrace: () => typeof _win.__kustoClearAutocompleteTrace === 'function' ? _win.__kustoClearAutocompleteTrace() : undefined,
		lastAutocompleteTraceId: () => _win.__kustoLastAutocompleteTraceId,
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
			assertAllVisible: (context: string, expectedCsv: string = '') => e2eAssertVisibleSuggestAll(context, expectedCsv, E2E_SECTION.sql.editor),
			waitExistingAllVisible: (context: string, expectedCsv: string = '', timeoutMs: number = 5000) => e2eWaitForExistingSuggestAll('sql', context, expectedCsv, timeoutMs),
			assertHidden: (context: string) => e2eAssertNoVisibleSuggest(context),
		},
		kusto: {
			setTextAt: (text: string, lineNumber: number = 1, column?: number) => _win.__e2e.kusto.setQueryAt(text, lineNumber, column),
			typeText: (text: string) => _win.__e2e.kusto.typeText(text),
			hide: () => e2eHideSuggest('kusto'),
			trigger: () => _win.__e2e.kusto.triggerSuggest(),
			waitVisible: (context: string, expectedAnyCsv: string = '', timeoutMs: number = 5000) => e2eWaitForSuggest('kusto', context, expectedAnyCsv, timeoutMs, false),
			waitExistingAllVisible: (context: string, expectedCsv: string = '', timeoutMs: number = 5000) => e2eWaitForExistingSuggestAll('kusto', context, expectedCsv, timeoutMs),
			waitExistingAllColumnsVisible: async (context: string, expectedCsv: string = '', timeoutMs: number = 5000) => {
				let lastError: unknown;
				const started = performance.now();
				while (performance.now() - started <= timeoutMs) {
					try {
						const result = e2eAssertVisibleSuggestAllColumns(context, expectedCsv, E2E_SECTION.kusto.editor);
						e2eAssertNoSuggestLoading(`${context} loading check`, E2E_SECTION.kusto.editor);
						return { elapsedMs: performance.now() - started, result };
					} catch (error) {
						lastError = error;
						await e2eDelay(50);
					}
				}
				const message = lastError instanceof Error ? lastError.message : String(lastError || 'timed out');
				throw new Error(`${context}: no matching column suggestion set within ${timeoutMs}ms: ${message}; trace=${JSON.stringify(e2eCompactAutocompleteTrace()).slice(0, 4000)}`);
			},
			waitRenderedAllColumnsVisible: (context: string, expectedCsv: string = '', timeoutMs: number = 5000) => e2eWaitForVisibleSuggestAllColumnsInRenderedRows(context, expectedCsv, timeoutMs),
			assertFirstStableRenderedColumns: (context: string, expectedCsv: string = '', timeoutMs: number = 5000) => e2eAssertFirstStableRenderedSuggestColumns(context, expectedCsv, timeoutMs),
			assertFirstRenderedColumnsAfterRawCtrlSpace: (selector: string, context: string, expectedCsv: string = '', timeoutMs: number = 5000) => e2eAssertFirstRenderedColumnsAfterRawCtrlSpace(selector, context, expectedCsv, timeoutMs),
			assertAllRenderedSnapshotsHaveColumns: (context: string, expectedCsv: string = '', durationMs: number = 2500, intervalMs: number = 100) => e2eAssertAllRenderedSnapshotsHaveColumns(context, expectedCsv, durationMs, intervalMs),
			assertRenderedSnapshotsExcludeColumns: (context: string, excludedCsv: string = '', durationMs: number = 1500, intervalMs: number = 100, requireSnapshot: boolean = true) => e2eAssertRenderedSnapshotsExcludeColumns(context, excludedCsv, durationMs, intervalMs, requireSnapshot),
			assertRenderedSnapshotsIncludeAndExcludeColumns: (context: string, expectedCsv: string = '', excludedCsv: string = '', durationMs: number = 1500, intervalMs: number = 100) => e2eAssertRenderedSnapshotsIncludeAndExcludeColumns(context, expectedCsv, excludedCsv, durationMs, intervalMs),
			assertRawCtrlSpaceDoesNotRenderColumns: (selector: string, context: string, excludedCsv: string = '', durationMs: number = 1000, intervalMs: number = 100) => e2eAssertRawCtrlSpaceDoesNotRenderColumns(selector, context, excludedCsv, durationMs, intervalMs),
			assertVisible: (context: string, expectedAnyCsv: string = '') => _win.__e2e.kusto.assertSuggestions(context, expectedAnyCsv),
			assertAllVisible: (context: string, expectedCsv: string = '') => e2eAssertVisibleSuggestAll(context, expectedCsv, E2E_SECTION.kusto.editor),
			assertAllColumnsVisible: (context: string, expectedCsv: string = '') => e2eAssertVisibleSuggestAllColumns(context, expectedCsv, E2E_SECTION.kusto.editor),
			assertRenderedAllColumnsVisible: (context: string, expectedCsv: string = '') => e2eAssertVisibleSuggestAllColumnsInRenderedRows(context, expectedCsv, E2E_SECTION.kusto.editor),
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
			_win.__e2eOrigCaptureHostMessage = _win.__e2eCaptureHostMessage;
			_win.__e2eCaptureHostMessage = function (msg: any) {
				if (msg && msg.type === 'requestCopilotInlineCompletion') {
					const requestId = String(msg.requestId || '');
					const alreadyCaptured = requestId && _win.__e2eInlineReqCapture.some((existing: any) => String(existing.requestId || '') === requestId);
					if (!alreadyCaptured) {
						_win.__e2eInlineReqCapture.push(msg);
					}
				}
				if (typeof _win.__e2eOrigCaptureHostMessage === 'function') {
					_win.__e2eOrigCaptureHostMessage(msg);
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
			if (typeof _win.__e2eOrigCaptureHostMessage === 'function') {
				_win.__e2eCaptureHostMessage = _win.__e2eOrigCaptureHostMessage;
			} else {
				delete _win.__e2eCaptureHostMessage;
			}
			delete _win.__e2eOrigCaptureHostMessage;
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
}
