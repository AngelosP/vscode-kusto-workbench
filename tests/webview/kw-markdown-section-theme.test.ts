import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/webview/core/utils.js', () => ({
	addPageScrollListener: vi.fn(() => vi.fn()),
	getScrollY: () => 0,
	maybeAutoScrollWhileDragging: vi.fn(),
}));

vi.mock('../../src/webview/core/dropdown.js', () => ({
	closeAllMenus: vi.fn(),
}));

vi.mock('../../src/webview/core/markdown-document-client.js', () => ({
	isHostOwnedMarkdownDocument: vi.fn(() => false),
	requestHostOwnedMarkdownAdd: vi.fn(),
	requestHostOwnedMarkdownPatch: vi.fn(() => true),
	requestHostOwnedMarkdownRemove: vi.fn(),
}));

vi.mock('../../src/webview/shared/lazy-vendor.js', () => ({
	ensureToastUiLoaded: vi.fn(() => Promise.resolve()),
}));

import { KwMarkdownSection, commitMarkdownDocumentState } from '../../src/webview/sections/kw-markdown-section.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import type { MarkdownSectionState } from '../../src/shared/markdownSectionDefinition.js';
import { ensureToastUiLoaded } from '../../src/webview/shared/lazy-vendor.js';
import {
	isHostOwnedMarkdownDocument,
	requestHostOwnedMarkdownPatch,
} from '../../src/webview/core/markdown-document-client.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Set the body class to simulate a VS Code theme. */
function setVsCodeTheme(theme: 'dark' | 'light') {
	document.body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light');
	if (theme === 'dark') {
		document.body.classList.add('vscode-dark');
	} else {
		document.body.classList.add('vscode-light');
	}
}

function dispatchAuthoredEvent(target: HTMLElement, event: Event): void {
	Object.defineProperty(event, 'isTrusted', { value: true });
	target.dispatchEvent(event);
}

/**
 * Create a fake TOAST UI editor DOM structure inside a host element.
 * Mimics what TOAST UI Editor creates internally.
 */
function createFakeToastUiEditorDom(host: HTMLElement, isDark: boolean): void {
	// TOAST UI adds `toastui-editor-dark` to the host `el` when theme='dark'
	if (isDark) {
		host.classList.add('toastui-editor-dark');
	}

	const defaultUI = document.createElement('div');
	defaultUI.className = 'toastui-editor-defaultUI' + (isDark ? ' toastui-editor-dark' : '');

	const mainContainer = document.createElement('div');
	mainContainer.className = 'toastui-editor-main-container';

	const wwContainer = document.createElement('div');
	wwContainer.className = 'toastui-editor-ww-container';

	const contents = document.createElement('div');
	contents.className = 'toastui-editor-contents';

	const proseMirror = document.createElement('div');
	proseMirror.className = 'ProseMirror';
	proseMirror.setAttribute('contenteditable', 'true');
	proseMirror.innerHTML = '<p>Hello world</p>';

	contents.appendChild(proseMirror);
	wwContainer.appendChild(contents);
	mainContainer.appendChild(wwContainer);
	defaultUI.appendChild(mainContainer);
	host.appendChild(defaultUI);
}

/**
 * Create a fake TOAST UI viewer DOM structure (Preview mode — no .toastui-editor-defaultUI).
 */
function createFakeToastUiViewerDom(host: HTMLElement, isDark: boolean): void {
	if (isDark) {
		host.classList.add('toastui-editor-dark');
	}

	const contents = document.createElement('div');
	contents.className = 'toastui-editor-contents';
	contents.innerHTML = '<p>Preview content</p>';
	host.appendChild(contents);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);

	// Reset the static theme cache so each test starts fresh.
	(KwMarkdownSection as any)._lastAppliedToastUiIsDark = null;
	(KwMarkdownSection as any)._themeObserverStarted = false;

	// Reset global markdown boxes list.
	(window as any).__kustoMarkdownBoxes = [];
});

afterEach(() => {
	container.remove();
	document.body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light');
	(window as any).__kustoMarkdownBoxes = [];
});

// ── Tests: applyThemeAll ──────────────────────────────────────────────────────

describe('KwMarkdownSection.applyThemeAll — theme switching', () => {

	it('adds toastui-editor-dark class on .toastui-editor-defaultUI when theme is dark', () => {
		setVsCodeTheme('dark');

		const editorHost = document.createElement('div');
		editorHost.id = 'md1_md_editor';
		createFakeToastUiEditorDom(editorHost, false); // start light
		container.appendChild(editorHost);

		const viewerHost = document.createElement('div');
		viewerHost.id = 'md1_md_viewer';
		createFakeToastUiViewerDom(viewerHost, false); // start light
		container.appendChild(viewerHost);

		(window as any).__kustoMarkdownBoxes = ['md1'];

		KwMarkdownSection.applyThemeAll();

		// Editor: .toastui-editor-defaultUI should have the dark class
		const defaultUI = editorHost.querySelector('.toastui-editor-defaultUI')!;
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(true);

		// Viewer: host itself should have the dark class (no .toastui-editor-defaultUI)
		expect(viewerHost.classList.contains('toastui-editor-dark')).toBe(true);
	});

	it('removes toastui-editor-dark from .toastui-editor-defaultUI when switching to light', () => {
		// Start dark
		setVsCodeTheme('dark');
		const editorHost = document.createElement('div');
		editorHost.id = 'md2_md_editor';
		createFakeToastUiEditorDom(editorHost, true); // start dark
		container.appendChild(editorHost);

		const viewerHost = document.createElement('div');
		viewerHost.id = 'md2_md_viewer';
		createFakeToastUiViewerDom(viewerHost, true); // start dark
		container.appendChild(viewerHost);

		(window as any).__kustoMarkdownBoxes = ['md2'];

		// First apply dark
		KwMarkdownSection.applyThemeAll();

		// Now switch to light
		setVsCodeTheme('light');
		KwMarkdownSection.applyThemeAll();

		const defaultUI = editorHost.querySelector('.toastui-editor-defaultUI')!;
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(false);
		expect(viewerHost.classList.contains('toastui-editor-dark')).toBe(false);
	});

	it('removes toastui-editor-dark from host element when TOAST UI added it during construction (dark→light)', () => {
		// This is the critical regression test:
		// TOAST UI's constructor adds `toastui-editor-dark` to the host `el` element.
		// When switching to light theme, it must be removed from the host too,
		// not just from .toastui-editor-defaultUI children.
		setVsCodeTheme('dark');

		const editorHost = document.createElement('div');
		editorHost.id = 'md3_md_editor';
		editorHost.className = 'kusto-markdown-editor';
		createFakeToastUiEditorDom(editorHost, true); // TOAST UI adds dark class to host AND defaultUI
		container.appendChild(editorHost);

		(window as any).__kustoMarkdownBoxes = ['md3'];

		// Verify dark state: host has the dark class (set by TOAST UI constructor)
		expect(editorHost.classList.contains('toastui-editor-dark')).toBe(true);

		// Apply dark theme (should be a no-op since already dark)
		KwMarkdownSection.applyThemeAll();

		// Now switch to light
		setVsCodeTheme('light');
		KwMarkdownSection.applyThemeAll();

		// The host element itself must NOT have toastui-editor-dark anymore.
		// If this fails, it means the dark CSS selectors (.toastui-editor-dark .ProseMirror)
		// will still match because the class is on an ancestor — causing white text on white background.
		expect(editorHost.classList.contains('toastui-editor-dark')).toBe(false);

		// The .toastui-editor-defaultUI should also not have it
		const defaultUI = editorHost.querySelector('.toastui-editor-defaultUI')!;
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(false);
	});

	it('skips update when theme has not changed', () => {
		setVsCodeTheme('dark');

		const editorHost = document.createElement('div');
		editorHost.id = 'md4_md_editor';
		createFakeToastUiEditorDom(editorHost, false);
		container.appendChild(editorHost);

		const viewerHost = document.createElement('div');
		viewerHost.id = 'md4_md_viewer';
		container.appendChild(viewerHost);

		(window as any).__kustoMarkdownBoxes = ['md4'];

		// First call applies dark
		KwMarkdownSection.applyThemeAll();
		const defaultUI = editorHost.querySelector('.toastui-editor-defaultUI')!;
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(true);

		// Remove the class manually to detect if second call is a no-op
		defaultUI.classList.remove('toastui-editor-dark');

		// Second call with same theme should skip (cached)
		KwMarkdownSection.applyThemeAll();
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(false); // not re-applied
	});

	it('handles multiple markdown sections correctly', () => {
		setVsCodeTheme('dark');

		// Create two markdown sections
		for (const id of ['mdA', 'mdB']) {
			const editor = document.createElement('div');
			editor.id = id + '_md_editor';
			createFakeToastUiEditorDom(editor, false);
			container.appendChild(editor);

			const viewer = document.createElement('div');
			viewer.id = id + '_md_viewer';
			createFakeToastUiViewerDom(viewer, false);
			container.appendChild(viewer);
		}

		(window as any).__kustoMarkdownBoxes = ['mdA', 'mdB'];

		KwMarkdownSection.applyThemeAll();

		// Both editors should be dark
		for (const id of ['mdA', 'mdB']) {
			const defaultUI = document.getElementById(id + '_md_editor')!.querySelector('.toastui-editor-defaultUI')!;
			expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(true);

			const viewer = document.getElementById(id + '_md_viewer')!;
			expect(viewer.classList.contains('toastui-editor-dark')).toBe(true);
		}

		// Switch to light
		setVsCodeTheme('light');
		KwMarkdownSection.applyThemeAll();

		for (const id of ['mdA', 'mdB']) {
			const defaultUI = document.getElementById(id + '_md_editor')!.querySelector('.toastui-editor-defaultUI')!;
			expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(false);

			const viewer = document.getElementById(id + '_md_viewer')!;
			expect(viewer.classList.contains('toastui-editor-dark')).toBe(false);
		}
	});

	it('removes dark class from host even when .toastui-editor-defaultUI exists (WYSIWYG mode)', () => {
		// Simulates the exact scenario that breaks:
		// 1. Editor instantiated in dark mode → TOAST UI sets toastui-editor-dark on host AND defaultUI
		// 2. User switches to light theme
		// 3. applyThemeAll should remove toastui-editor-dark from BOTH host AND defaultUI
		setVsCodeTheme('dark');

		const editorHost = document.createElement('div');
		editorHost.id = 'md5_md_editor';
		editorHost.className = 'kusto-markdown-editor toastui-editor-dark'; // set by TOAST UI constructor
		container.appendChild(editorHost);

		// TOAST UI creates its internal DOM
		const defaultUI = document.createElement('div');
		defaultUI.className = 'toastui-editor-defaultUI toastui-editor-dark';

		const proseMirror = document.createElement('div');
		proseMirror.className = 'ProseMirror';
		proseMirror.innerHTML = '<p>Test</p>';

		defaultUI.appendChild(proseMirror);
		editorHost.appendChild(defaultUI);

		(window as any).__kustoMarkdownBoxes = ['md5'];

		// Apply dark (matches current state)
		KwMarkdownSection.applyThemeAll();

		// Switch to light
		setVsCodeTheme('light');
		KwMarkdownSection.applyThemeAll();

		// CSS selector `.toastui-editor-dark .ProseMirror` should NOT match anymore.
		// This requires that NO ancestor of .ProseMirror has .toastui-editor-dark.
		expect(editorHost.classList.contains('toastui-editor-dark')).toBe(false);
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(false);

		// Verify the selector wouldn't match by walking ancestors
		let el: Element | null = proseMirror;
		while (el) {
			expect(el.classList.contains('toastui-editor-dark')).toBe(false);
			el = el.parentElement;
		}
	});

	it('removes dark class from host in Markdown source mode too', () => {
		// Markdown source editing mode also uses ProseMirror with md-specific classes.
		setVsCodeTheme('dark');

		const editorHost = document.createElement('div');
		editorHost.id = 'md6_md_editor';
		editorHost.className = 'kusto-markdown-editor toastui-editor-dark';
		container.appendChild(editorHost);

		const defaultUI = document.createElement('div');
		defaultUI.className = 'toastui-editor-defaultUI toastui-editor-dark';

		const mdContainer = document.createElement('div');
		mdContainer.className = 'toastui-editor-md-container';

		const proseMirror = document.createElement('div');
		proseMirror.className = 'ProseMirror';

		const textSpan = document.createElement('span');
		textSpan.className = 'toastui-editor-md-marked-text';
		textSpan.textContent = '# Heading';

		proseMirror.appendChild(textSpan);
		mdContainer.appendChild(proseMirror);
		defaultUI.appendChild(mdContainer);
		editorHost.appendChild(defaultUI);

		(window as any).__kustoMarkdownBoxes = ['md6'];

		KwMarkdownSection.applyThemeAll();

		// Switch to light
		setVsCodeTheme('light');
		KwMarkdownSection.applyThemeAll();

		// No ancestor of the Markdown ProseMirror should have the dark class
		expect(editorHost.classList.contains('toastui-editor-dark')).toBe(false);
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(false);
	});

	it('correctly re-applies dark after light→dark switch', () => {
		setVsCodeTheme('light');

		const editorHost = document.createElement('div');
		editorHost.id = 'md7_md_editor';
		editorHost.className = 'kusto-markdown-editor';
		createFakeToastUiEditorDom(editorHost, false);
		container.appendChild(editorHost);

		(window as any).__kustoMarkdownBoxes = ['md7'];

		KwMarkdownSection.applyThemeAll();

		const defaultUI = editorHost.querySelector('.toastui-editor-defaultUI')!;
		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(false);

		// Switch to dark
		setVsCodeTheme('dark');
		KwMarkdownSection.applyThemeAll();

		expect(defaultUI.classList.contains('toastui-editor-dark')).toBe(true);
	});
});

describe('KwMarkdownSection Markdown portability', () => {
	it('configures authored WYSIWYG bullet lists to serialize with dash markers', async () => {
		let capturedOptions: any;
		class FakeToastEditor {
			markdown = '';
			constructor(options: any) {
				capturedOptions = options;
				createFakeToastUiEditorDom(options.el, false);
			}

			getMarkdown(): string {
				if (!this.markdown) return '';
				const rendered = capturedOptions.customMarkdownRenderer.bulletList({}, { origin: () => ({ delim: '*' }) });
				return `${rendered.delim} portable item`;
			}
			setMarkdown(): void {}
			setHeight(): void {}
			changeMode(): void {}
			destroy(): void {}
			getCurrentModeEditor(): object { return { commands: {} }; }
		}

		(window as any).toastui = { Editor: FakeToastEditor };
		const section = document.createElement('kw-markdown-section') as KwMarkdownSection;
		section.id = section.boxId = 'portable-list';

		const editorHost = document.createElement('div');
		editorHost.className = 'kusto-markdown-editor';
		section.appendChild(editorHost);
		const viewerHost = document.createElement('div');
		viewerHost.className = 'markdown-viewer';
		section.appendChild(viewerHost);
		container.appendChild(section);

		try {
			(section as any)._initEditor();
			const renderBulletList = capturedOptions.customMarkdownRenderer?.bulletList;
			expect(renderBulletList).toBeTypeOf('function');
			expect(section.serialize().text).toBe('');
			const prose = editorHost.querySelector('.ProseMirror') as HTMLElement;
			dispatchAuthoredEvent(prose, new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: '* portable item' }));
			(section.getEditorApi()?._toastui as FakeToastEditor).markdown = '* portable item';
			capturedOptions.events.change();
			dispatchAuthoredEvent(prose, new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '* portable item' }));
			await Promise.resolve();
			await Promise.resolve();
			expect(section.serialize().text).toBe('- portable item');

			const original = { delim: '*', rawHTML: ['<ul>', '</ul>'] };
			expect(renderBulletList({}, { inTable: true, origin: () => original })).toEqual({
				delim: '-',
				rawHTML: ['<ul>', '</ul>'],
			});
			for (const marker of ['*', '+', '-']) {
				const listNode: any = { type: { name: 'bulletList' }, attrs: { htmlAttrs: null } };
				const transaction = {
					setNodeMarkup: (_pos: number, _type: unknown, attrs: unknown) => { listNode.attrs = attrs; return transaction; },
				};
				const view = {
					state: { doc: { descendants: (visit: (node: unknown, pos: number) => void) => visit(listNode, 0) }, tr: transaction },
					dispatch: vi.fn(),
				};
				const sourceList = { type: 'list', listData: { type: 'bullet', bulletChar: marker } };
				(KwMarkdownSection as any)._restoreBulletMarkers({
					toastMark: { getRootNode: () => ({ type: 'document', firstChild: sourceList }) },
					wwEditor: { view },
				});
				expect(listNode.attrs.htmlAttrs).toEqual({});
				expect(renderBulletList({ node: listNode }, { origin: () => original })).toEqual({
					delim: marker,
					rawHTML: ['<ul>', '</ul>'],
				});
			}
		} finally {
			(section as any)._editorApi?.dispose();
			delete (window as any).toastui;
		}
	});
});

describe('KwMarkdownSection exact source preservation', () => {
	it('does not request a native patch for delayed constructor normalization after host adoption', async () => {
		const original = '# Opening note\r\n\r\nA **bold** note.\r\n\r\n* first\r\n* second\r\n\r\n';
		const normalized = '# Opening note\n\nA **bold** note.\n\n* first\n* second';
		class FakeToastEditor {
			constructor(private options: any) {
				createFakeToastUiEditorDom(options.el, false);
				options.events.change();
				queueMicrotask(() => options.events.change());
			}
			getMarkdown(): string { return normalized; }
			setMarkdown(): void {}
			setHeight(): void {}
			changeMode(): void {}
			destroy(): void {}
			getCurrentModeEditor(): object { return { commands: {} }; }
		}

		vi.mocked(isHostOwnedMarkdownDocument).mockReturnValue(true);
		vi.mocked(requestHostOwnedMarkdownPatch).mockClear();
		(window as any).toastui = { Editor: FakeToastEditor };
		const section = document.createElement('kw-markdown-section') as KwMarkdownSection;
		section.id = section.boxId = 'passive-markdown';
		const editorHost = document.createElement('div');
		editorHost.className = 'kusto-markdown-editor';
		editorHost.slot = 'editor';
		section.appendChild(editorHost);
		const viewerHost = document.createElement('div');
		viewerHost.className = 'markdown-viewer';
		viewerHost.slot = 'viewer';
		section.appendChild(viewerHost);
		container.appendChild(section);

		try {
			section.applyHostDocumentState({
				id: section.boxId, type: 'markdown', title: 'Opening note', text: original,
				tab: 'edit', mode: 'wysiwyg', expanded: true,
			});
			(section as any)._initEditor();
			await section.updateComplete;
			await Promise.resolve();

			expect(section.getEditorApi()?._toastui.getMarkdown()).toBe(normalized);
			expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
			expect(section.getEditorApi()?.getValue()).toBe(original);
			expect((section as any)._createDocumentState().text).toBe(original);
			expect(section.serialize().text).toBe(original);
			expect(section.getText()).toBe(original);
		} finally {
			section.getEditorApi()?.dispose();
			vi.mocked(isHostOwnedMarkdownDocument).mockReturnValue(false);
			delete pState.pendingMarkdownTextByBoxId[section.boxId];
			delete (window as any).toastui;
		}
	});
});

describe('KwMarkdownSection authored operation boundaries', () => {
	const original = '# Opening note\r\n\r\nA **bold** note.\r\n\r\n* first\r\n* second\r\n\r\n';
	const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
	type FakeOptions = {
		el: HTMLElement;
		initialValue: string;
		viewer?: boolean;
		toolbarItems?: Array<Array<string | { name: string; el: HTMLElement }>>;
		events: { change?: () => void; command?: () => void; afterPreviewRender?: () => void };
	};

	class FakeToastEditor {
		markdown: string;
		nextInput: string | undefined;
		deferInput = false;
		boldResult = '**Bold note**';
		private history: string[] = [];
		private future: string[] = [];
		undo = vi.fn(() => {
			const previous = this.history.pop();
			if (previous === undefined) return;
			this.future.push(this.markdown);
			this.markdown = previous;
			this.emitChange();
		});
		redo = vi.fn(() => {
			const next = this.future.pop();
			if (next === undefined) return;
			this.history.push(this.markdown);
			this.markdown = next;
			this.emitChange();
		});

		constructor(public options: FakeOptions) {
			this.markdown = normalize(options.initialValue);
			if (options.viewer) {
				createFakeToastUiViewerDom(options.el, false);
				return;
			}
			createFakeToastUiEditorDom(options.el, false);
			const toolbar = document.createElement('div');
			toolbar.className = 'toastui-editor-defaultUI-toolbar';
			for (const group of options.toolbarItems ?? []) {
				for (const item of group) if (typeof item !== 'string') toolbar.appendChild(item.el);
			}
			const bold = document.createElement('button');
			bold.type = 'button';
			bold.className = 'toastui-editor-toolbar-icons bold';
			bold.setAttribute('aria-label', 'Bold');
			bold.addEventListener('click', () => {
				this.authorMarkdown(this.boldResult);
				options.events.command?.();
			});
			toolbar.appendChild(bold);
			options.el.querySelector('.toastui-editor-defaultUI')!.prepend(toolbar);
			const prose = options.el.querySelector('.ProseMirror') as HTMLElement;
			prose.tabIndex = 0;
			for (const event of ['beforeinput', 'input', 'paste', 'cut', 'drop', 'compositionend']) {
				prose.addEventListener(event, () => {
					if (this.nextInput === undefined) return;
					const text = this.nextInput;
					this.nextInput = undefined;
					if (this.deferInput) queueMicrotask(() => queueMicrotask(() => this.authorMarkdown(text)));
					else this.authorMarkdown(text);
				});
			}
			prose.addEventListener('keydown', event => {
				if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'b') return;
				this.authorMarkdown(this.boldResult);
				options.events.command?.();
			});
			this.emitChange();
		}

		emitChange(): void {
			this.options.events.change?.();
			queueMicrotask(() => this.options.events.change?.());
		}
		authorMarkdown(text: string): void {
			this.history.push(this.markdown);
			this.future = [];
			this.markdown = normalize(text);
			this.emitChange();
		}
		getMarkdown(): string { return this.markdown; }
		setMarkdown(text: string): void {
			this.markdown = normalize(text);
			this.history = [];
			this.future = [];
			this.emitChange();
		}
		changeMode(): void { this.emitChange(); }
		setHeight(): void {}
		destroy(): void {}
		getCurrentModeEditor(): object { return { commands: { undo: this.undo, redo: this.redo } }; }
	}

	const legacyPersist = vi.fn();
	let previousKind: typeof pState.documentKind;
	let previousSchedulePersist: unknown;
	beforeEach(() => {
		previousKind = pState.documentKind;
		previousSchedulePersist = (window as any).schedulePersist;
		pState.documentKind = 'kqlx';
		pState.restoreInProgress = false;
		pState.applyingHostMarkdownProjection = false;
		vi.mocked(isHostOwnedMarkdownDocument).mockReturnValue(true);
		vi.mocked(requestHostOwnedMarkdownPatch).mockClear();
		legacyPersist.mockClear();
		(window as any).schedulePersist = legacyPersist;
		(window as any).toastui = { Editor: FakeToastEditor };
	});
	afterEach(() => {
		for (const section of container.querySelectorAll<KwMarkdownSection>('kw-markdown-section')) {
			section.getEditorApi()?.dispose();
			delete pState.pendingMarkdownTextByBoxId[section.boxId];
			delete pState.hostOwnedMarkdownSections[section.boxId];
			delete window.__kustoMarkdownEditors[section.boxId];
		}
		if (vi.isFakeTimers()) {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
		pState.documentKind = previousKind;
		vi.mocked(isHostOwnedMarkdownDocument).mockReturnValue(false);
		(window as any).schedulePersist = previousSchedulePersist;
		delete (window as any).toastui;
	});

	async function flushCallbacks(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	async function mountSection(text = original, mode: 'wysiwyg' | 'markdown' | 'preview' = 'wysiwyg', id = 'authored-markdown') {
		const section = document.createElement('kw-markdown-section') as KwMarkdownSection;
		section.id = section.boxId = id;
		const editorHost = document.createElement('div');
		editorHost.id = id + '_md_editor';
		editorHost.className = 'kusto-markdown-editor';
		editorHost.slot = 'editor';
		section.appendChild(editorHost);
		const viewerHost = document.createElement('div');
		viewerHost.id = id + '_md_viewer';
		viewerHost.className = 'markdown-viewer';
		viewerHost.slot = 'viewer';
		section.appendChild(viewerHost);
		container.appendChild(section);
		window.__kustoMarkdownBoxes.push(id);
		const state: MarkdownSectionState = {
			id, type: 'markdown', title: 'Opening note', text, expanded: true,
			tab: mode === 'preview' ? 'preview' : 'edit', mode,
		};
		pState.hostOwnedMarkdownSections[id] = state;
		section.applyHostDocumentState(state);
		(section as any)._initEditor();
		await section.updateComplete;
		await flushCallbacks();
		const editor = section.getEditorApi()?._toastui as FakeToastEditor;
		expect(editor).toBeInstanceOf(FakeToastEditor);
		return { section, editorHost, editor, state, prose: editorHost.querySelector('.ProseMirror') as HTMLElement };
	}

	function assertExactText(section: KwMarkdownSection, text: string): void {
		expect(section.getText()).toBe(text);
		expect(section.getEditorApi()?.getValue()).toBe(text);
		expect((section as any)._createDocumentState().text).toBe(text);
		expect(section.serialize().text).toBe(text);
	}

	function typeText(fixture: Awaited<ReturnType<typeof mountSection>>, text: string): void {
		fixture.editor.nextInput = text;
		dispatchAuthoredEvent(fixture.prose, new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
		dispatchAuthoredEvent(fixture.prose, new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
	}

	it.each([
		['empty', ''],
		['blank CRLF', '\r\n\r\n'],
		['mixed bullet markers', '* star\r\n+ plus\r\n- dash\r\n\r\n'],
		['trailing LF', 'Last line\n\n\n'],
	])('preserves exact %s source through initialization', async (_label, text) => {
		const { section, editor } = await mountSection(text);
		expect(editor.getMarkdown()).toBe(normalize(text));
		assertExactText(section, text);
		expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
		expect(legacyPersist).not.toHaveBeenCalled();
	});

	it('keeps focus, theme, layout, mode projection and automatic preview fitting passive', async () => {
		vi.useFakeTimers();
		const { section, editor, prose, state } = await mountSection();
		prose.focus();
		editor.emitChange();
		section.getEditorApi()?.layout();
		section.applyEditorMode();
		editor.options.events.afterPreviewRender?.();
		setVsCodeTheme('dark');
		KwMarkdownSection.applyThemeAll();
		setVsCodeTheme('light');
		KwMarkdownSection.applyThemeAll();
		section.applyHostDocumentState({ ...state, mode: 'preview', tab: 'preview' });
		vi.advanceTimersByTime(400);
		await flushCallbacks();
		assertExactText(section, original);
		expect(section.serialize().editorHeightPx).toBeUndefined();
		expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
		expect(legacyPersist).not.toHaveBeenCalled();
	});

	it('keeps metadata-only name, mode, expansion and explicit fit/resize patches exact', async () => {
		vi.useFakeTimers();
		const { section } = await mountSection();
		const shell = section.shadowRoot!.querySelector('kw-section-shell')!;
		shell.dispatchEvent(new CustomEvent('name-change', { detail: { name: 'Renamed note' } }));
		section.setMarkdownMode('markdown');
		shell.dispatchEvent(new CustomEvent('toggle-visibility'));
		section.setExpanded(true);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(4);
		const preview = section.shadowRoot!.querySelector('[aria-label="Preview"]') as HTMLElement;
		preview.click();
		vi.advanceTimersByTime(400);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(5);
		const resizer = section.shadowRoot!.querySelector('.resizer') as HTMLElement;
		resizer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: 0 }));
		document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 180 }));
		document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
		expect(requestHostOwnedMarkdownPatch).toHaveBeenLastCalledWith(expect.objectContaining({ editorHeightPx: 180 }));
		shell.dispatchEvent(new CustomEvent('fit-to-contents'));
		await flushCallbacks();
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(7);
		expect(section.serialize().editorHeightPx).toBeUndefined();
		for (const [snapshot] of vi.mocked(requestHostOwnedMarkdownPatch).mock.calls) expect(snapshot.text).toBe(original);
		assertExactText(section, original);
	});

	it('keeps synchronous typed text through an immediate rename before host acknowledgement and later passive changes', async () => {
		const fixture = await mountSection();
		const authored = '# Typed note\n\n+ authored item';
		typeText(fixture, authored);
		fixture.section.setName('After typing');
		assertExactText(fixture.section, authored);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: authored, title: 'Opening note' }));
		expect(requestHostOwnedMarkdownPatch).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: authored, title: 'After typing' }));
		await flushCallbacks();
		expect(pState.hostOwnedMarkdownSections[fixture.section.boxId].text).toBe(original);
		fixture.editor.markdown = authored + '\n';
		fixture.editor.emitChange();
		await flushCallbacks();
		assertExactText(fixture.section, authored);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(2);
	});

	it('keeps authored input authorized through the inner editor deferred default work', async () => {
		const fixture = await mountSection();
		fixture.editor.deferInput = true;
		fixture.editor.nextInput = 'Deferred authored note';
		dispatchAuthoredEvent(fixture.prose, new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
		await flushCallbacks();
		assertExactText(fixture.section, 'Deferred authored note');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
		fixture.editor.markdown += '\n';
		fixture.editor.emitChange();
		await flushCallbacks();
		assertExactText(fixture.section, 'Deferred authored note');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it('does not leave a stopped no-op input event authorized for later passive changes or commands', async () => {
		const fixture = await mountSection();
		fixture.prose.addEventListener('beforeinput', event => {
			event.preventDefault();
			event.stopPropagation();
		}, { once: true });
		dispatchAuthoredEvent(fixture.prose, new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }));
		await flushCallbacks();
		fixture.editor.markdown = 'Later passive note';
		fixture.editor.emitChange();
		fixture.editor.options.events.command?.();
		await flushCallbacks();
		assertExactText(fixture.section, original);
		expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
	});

	it('adopts completed toolbar commands after their synchronous internal change without requiring editor focus', async () => {
		const { section, editorHost, editor } = await mountSection();
		editor.boldResult = '**Toolbar note**\r\n\r\n';
		const bold = editorHost.querySelector('[aria-label="Bold"]') as HTMLElement;
		dispatchAuthoredEvent(bold, new MouseEvent('pointerdown', { bubbles: true }));
		dispatchAuthoredEvent(bold, new MouseEvent('click', { bubbles: true }));
		assertExactText(section, '**Toolbar note**');
		await flushCallbacks();
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it.each(['wysiwyg', 'markdown'] as const)('lets Ctrl+B reach the inner %s editor command', async mode => {
		const { section, editor, prose } = await mountSection(original, mode);
		prose.focus();
		editor.boldResult = '**Shortcut note**';
		dispatchAuthoredEvent(prose, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'b', ctrlKey: true }));
		await flushCallbacks();
		assertExactText(section, '**Shortcut note**');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it('persists custom toolbar Undo and Redo even though direct editor commands emit no command event', async () => {
		const fixture = await mountSection();
		typeText(fixture, 'Authored note');
		await flushCallbacks();
		const undo = fixture.editorHost.querySelector('[aria-label="Undo"]') as HTMLElement;
		const redo = fixture.editorHost.querySelector('[aria-label="Redo"]') as HTMLElement;
		dispatchAuthoredEvent(undo, new MouseEvent('click', { bubbles: true }));
		assertExactText(fixture.section, normalize(original));
		dispatchAuthoredEvent(redo, new MouseEvent('click', { bubbles: true }));
		assertExactText(fixture.section, 'Authored note');
		await flushCallbacks();
		expect(fixture.editor.undo).toHaveBeenCalledTimes(1);
		expect(fixture.editor.redo).toHaveBeenCalledTimes(1);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(3);
	});

	it.each(['wysiwyg', 'markdown'] as const)('persists Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z direct commands in %s mode', async mode => {
		const fixture = await mountSection(original, mode);
		typeText(fixture, 'Keyboard history');
		await flushCallbacks();
		fixture.prose.focus();
		for (const [key, shiftKey, text] of [
			['z', false, normalize(original)], ['y', false, 'Keyboard history'],
			['z', false, normalize(original)], ['z', true, 'Keyboard history'],
		] as const) {
			dispatchAuthoredEvent(fixture.prose, new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ctrlKey: true, shiftKey }));
			assertExactText(fixture.section, text);
		}
		await flushCallbacks();
		expect(fixture.editor.undo).toHaveBeenCalledTimes(2);
		expect(fixture.editor.redo).toHaveBeenCalledTimes(2);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(5);
	});

	it.each(['paste', 'cut', 'drop'])('admits an authored %s before the inner editor changes', async eventType => {
		const fixture = await mountSection();
		fixture.editor.nextInput = eventType === 'cut' ? '' : `${eventType} note\r\n\r\n`;
		dispatchAuthoredEvent(fixture.prose, new Event(eventType, { bubbles: true, cancelable: true }));
		await flushCallbacks();
		assertExactText(fixture.section, eventType === 'cut' ? '' : `${eventType} note`);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it('admits composition input and completion without leaving later passive changes authorized', async () => {
		const fixture = await mountSection();
		dispatchAuthoredEvent(fixture.prose, new CompositionEvent('compositionstart', { bubbles: true }));
		fixture.editor.nextInput = 'Composing';
		dispatchAuthoredEvent(fixture.prose, new InputEvent('beforeinput', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
		dispatchAuthoredEvent(fixture.prose, new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
		await flushCallbacks();
		fixture.editor.nextInput = 'Composed note';
		dispatchAuthoredEvent(fixture.prose, new CompositionEvent('compositionend', { bubbles: true, data: 'Composed note' }));
		await flushCallbacks();
		assertExactText(fixture.section, 'Composed note');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(2);
		fixture.editor.markdown += '\n';
		fixture.editor.emitChange();
		await flushCallbacks();
		assertExactText(fixture.section, 'Composed note');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(2);
	});

	it.each(['click', 'input'] as const)('admits a formatting popup %s including slider input', async eventType => {
		const fixture = await mountSection();
		const popup = document.createElement('div');
		popup.className = 'toastui-editor-popup';
		const control = document.createElement(eventType === 'click' ? 'button' : 'input');
		if (control instanceof HTMLInputElement) control.type = 'range';
		popup.appendChild(control);
		fixture.editorHost.appendChild(popup);
		control.addEventListener(eventType, () => {
			fixture.editor.authorMarkdown('Formatted note');
			fixture.editor.options.events.command?.();
		});
		dispatchAuthoredEvent(control, new Event(eventType, { bubbles: true }));
		await flushCallbacks();
		assertExactText(fixture.section, 'Formatted note');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it('admits input-only editor updates while passive commands alone cannot change the exact buffer', async () => {
		const fixture = await mountSection();
		fixture.editor.nextInput = 'Input-only note';
		dispatchAuthoredEvent(fixture.prose, new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
		await flushCallbacks();
		assertExactText(fixture.section, 'Input-only note');
		fixture.editor.markdown = 'Passive vendor command';
		fixture.editor.emitChange();
		fixture.editor.options.events.command?.();
		await flushCallbacks();
		assertExactText(fixture.section, 'Input-only note');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it.each(['', '+ Tool note\r\n\r\n', '- Tool note\n\n'])('preserves registered API replacement exactly through the tool commit path: %j', async replacement => {
		const { section, editor } = await mountSection();
		const registered = window.__kustoMarkdownEditors[section.boxId];
		expect(registered).toBe(section.getEditorApi());
		registered.setValue(replacement);
		assertExactText(section, replacement);
		expect(editor.getMarkdown()).toBe(normalize(replacement));
		expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
		expect(commitMarkdownDocumentState(section.boxId)).toBe(true);
		await flushCallbacks();
		assertExactText(section, replacement);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenLastCalledWith(expect.objectContaining({ text: replacement }));
	});

	it('keeps empty API text authoritative over stale pending text and a remounted editor', async () => {
		const fixture = await mountSection();
		fixture.section.getEditorApi()!.setValue('');
		pState.pendingMarkdownTextByBoxId[fixture.section.boxId] = 'Stale pending note';
		fixture.editorHost.textContent = '';
		(fixture.section as any)._initEditor();
		await flushCallbacks();
		assertExactText(fixture.section, '');
		expect(fixture.section.getEditorApi()?._toastui.getMarkdown()).toBe('');
		expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
	});

	it('makes native public setText an explicit author operation without relying on delayed change', async () => {
		const { section } = await mountSection();
		const replacement = '* Public API note\r\n\r\n';
		section.setText(replacement);
		assertExactText(section, replacement);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenLastCalledWith(expect.objectContaining({ text: replacement }));
		await flushCallbacks();
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it('keeps plain Markdown reload setText passive while genuine compatibility input still persists', async () => {
		vi.mocked(isHostOwnedMarkdownDocument).mockReturnValue(false);
		pState.documentKind = 'md';
		const fixture = await mountSection();
		fixture.section.plainMd = true;
		const replacement = '+ Reload note\r\n\r\n';
		fixture.section.setText(replacement);
		await flushCallbacks();
		assertExactText(fixture.section, replacement);
		expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
		expect(legacyPersist).not.toHaveBeenCalled();
		typeText(fixture, 'Compatibility authored note');
		await flushCallbacks();
		assertExactText(fixture.section, 'Compatibility authored note');
		expect(legacyPersist).toHaveBeenCalledTimes(1);
	});

	it('resets exact text at the canonical rejection/reload projection boundary without an echo patch', async () => {
		const fixture = await mountSection();
		typeText(fixture, 'Unacknowledged note');
		await flushCallbacks();
		assertExactText(fixture.section, 'Unacknowledged note');
		fixture.section.applyHostDocumentState(fixture.state);
		await flushCallbacks();
		assertExactText(fixture.section, original);
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it('rejects delayed callbacks and API replacements from an editor replaced within the same section', async () => {
		const fixture = await mountSection();
		const previousApi = fixture.section.getEditorApi()!;
		fixture.editor.nextInput = 'Retained authored note';
		dispatchAuthoredEvent(fixture.prose, new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
		fixture.editorHost.textContent = '';
		(fixture.section as any)._initEditor();
		const currentApi = fixture.section.getEditorApi()!;
		previousApi.setValue('Stale API note');
		fixture.editor.options.events.change?.();
		fixture.editor.options.events.command?.();
		previousApi.dispose();
		await flushCallbacks();
		expect(currentApi).not.toBe(previousApi);
		assertExactText(fixture.section, 'Retained authored note');
		expect(fixture.editorHost.querySelector('.toastui-editor-defaultUI')).not.toBeNull();
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(1);
	});

	it('prevents detached same-ID owners and their queued callbacks from commanding the replacement', async () => {
		const previous = await mountSection();
		previous.editor.nextInput = 'Previous authored note';
		dispatchAuthoredEvent(previous.prose, new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
		previous.section.remove();
		const current = await mountSection('Current exact note\r\n\r\n');
		const callsBeforeStale = vi.mocked(requestHostOwnedMarkdownPatch).mock.calls.length;
		previous.section.getEditorApi()!.setValue('Detached API note');
		previous.editor.options.events.change?.();
		previous.editor.options.events.command?.();
		previous.section.setName('Detached rename');
		await flushCallbacks();
		assertExactText(current.section, 'Current exact note\r\n\r\n');
		expect(window.__kustoMarkdownEditors[current.section.boxId]).toBe(current.section.getEditorApi());
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(callsBeforeStale);
		typeText(current, 'Current authored note');
		await flushCallbacks();
		assertExactText(current.section, 'Current authored note');
		expect(requestHostOwnedMarkdownPatch).toHaveBeenCalledTimes(callsBeforeStale + 1);
		previous.section.getEditorApi()!.dispose();
	});
});

describe('KwMarkdownSection editor init retry ownership', () => {
	const normalize = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
	type RetryFakeOptions = {
		el: HTMLElement;
		initialValue: string;
		viewer?: boolean;
		toolbarItems?: Array<Array<string | { name: string; el: HTMLElement }>>;
		events: { change?: () => void; command?: () => void; afterPreviewRender?: () => void };
	};

	class RetryRegistrationToastEditor {
		static constructed: RetryRegistrationToastEditor[] = [];

		markdown: string;
		nextInput: string | undefined;
		private history: string[] = [];
		private future: string[] = [];
		undo = vi.fn(() => {
			const previous = this.history.pop();
			if (previous === undefined) return;
			this.future.push(this.markdown);
			this.markdown = previous;
			this.emitChange();
		});
		redo = vi.fn(() => {
			const next = this.future.pop();
			if (next === undefined) return;
			this.history.push(this.markdown);
			this.markdown = next;
			this.emitChange();
		});

		constructor(public options: RetryFakeOptions) {
			RetryRegistrationToastEditor.constructed.push(this);
			this.markdown = normalize(options.initialValue);
			if (options.viewer) {
				createFakeToastUiViewerDom(options.el, false);
				return;
			}
			createFakeToastUiEditorDom(options.el, false);
			const toolbar = document.createElement('div');
			toolbar.className = 'toastui-editor-defaultUI-toolbar';
			for (const group of options.toolbarItems ?? []) {
				for (const item of group) {
					if (typeof item !== 'string') toolbar.appendChild(item.el);
				}
			}
			options.el.querySelector('.toastui-editor-defaultUI')!.prepend(toolbar);
			const prose = options.el.querySelector('.ProseMirror') as HTMLElement | null;
			if (!prose) return;
			prose.tabIndex = 0;
			for (const event of ['beforeinput', 'input', 'paste', 'cut', 'drop', 'compositionend']) {
				prose.addEventListener(event, () => {
					if (this.nextInput === undefined) return;
					const text = this.nextInput;
					this.nextInput = undefined;
					this.authorMarkdown(text);
				});
			}
			this.emitChange();
		}

		static reset(): void {
			RetryRegistrationToastEditor.constructed = [];
		}

		emitChange(): void {
			this.options.events.change?.();
			queueMicrotask(() => this.options.events.change?.());
		}

		authorMarkdown(text: string): void {
			this.history.push(this.markdown);
			this.future = [];
			this.markdown = normalize(text);
			this.emitChange();
		}

		getMarkdown(): string {
			return this.markdown;
		}

		setMarkdown(text: string): void {
			this.markdown = normalize(text);
			this.history = [];
			this.future = [];
			this.emitChange();
		}

		changeMode(): void {
			this.emitChange();
		}

		setHeight(): void {}

		destroy(): void {}

		getCurrentModeEditor(): object {
			return { commands: { undo: this.undo, redo: this.redo } };
		}
	}

	const legacyPersist = vi.fn();
	let previousKind: typeof pState.documentKind;
	let previousSchedulePersist: unknown;

	beforeEach(() => {
		previousKind = pState.documentKind;
		previousSchedulePersist = (window as any).schedulePersist;
		pState.documentKind = 'kqlx';
		legacyPersist.mockClear();
		(window as any).schedulePersist = legacyPersist;
		vi.mocked(isHostOwnedMarkdownDocument).mockReturnValue(false);
		vi.mocked(requestHostOwnedMarkdownPatch).mockClear();
		vi.mocked(ensureToastUiLoaded).mockClear().mockImplementation(() => Promise.resolve());
		RetryRegistrationToastEditor.reset();
		delete (window as any).toastui;
		for (const key of Object.keys(window.__kustoMarkdownEditors ?? {})) delete window.__kustoMarkdownEditors[key];
	});

	afterEach(() => {
		if (vi.isFakeTimers()) {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
		pState.documentKind = previousKind;
		(window as any).schedulePersist = previousSchedulePersist;
		vi.mocked(isHostOwnedMarkdownDocument).mockReturnValue(false);
		delete (window as any).toastui;
		for (const key of Object.keys(window.__kustoMarkdownEditors ?? {})) delete window.__kustoMarkdownEditors[key];
	});

	async function flushRetryCallbacks(): Promise<void> {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	async function mountLifecycleSection({
		boxId = 'retry-markdown',
		domId = boxId,
		text = 'Initial note',
		plainMd = false,
	}: {
		boxId?: string;
		domId?: string;
		text?: string;
		plainMd?: boolean;
	} = {}) {
		const section = document.createElement('kw-markdown-section') as KwMarkdownSection;
		if (domId) section.id = domId;
		section.boxId = boxId;
		section.setAttribute('box-id', boxId);
		section.initialText = text;
		section.setAttribute('initial-text', text);
		if (plainMd) {
			section.plainMd = true;
			section.setAttribute('plain-md', '');
		}
		const editorHost = document.createElement('div');
		editorHost.id = boxId + '_md_editor';
		editorHost.className = 'kusto-markdown-editor';
		editorHost.slot = 'editor';
		section.appendChild(editorHost);
		const viewerHost = document.createElement('div');
		viewerHost.id = boxId + '_md_viewer';
		viewerHost.className = 'markdown-viewer';
		viewerHost.slot = 'viewer';
		section.appendChild(viewerHost);
		container.appendChild(section);
		window.__kustoMarkdownBoxes.push(boxId);
		await section.updateComplete;
		await flushRetryCallbacks();
		return { section, editorHost, prose: editorHost.querySelector('.ProseMirror') as HTMLElement | null };
	}

	function typeRetryText(
		fixture: Awaited<ReturnType<typeof mountLifecycleSection>>,
		text: string,
	): RetryRegistrationToastEditor {
		const editor = fixture.section.getEditorApi()?._toastui as RetryRegistrationToastEditor;
		expect(editor).toBeInstanceOf(RetryRegistrationToastEditor);
		const prose = fixture.prose ?? (fixture.editorHost.querySelector('.ProseMirror') as HTMLElement | null);
		expect(prose).toBeTruthy();
		editor.nextInput = text;
		dispatchAuthoredEvent(prose!, new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text }));
		dispatchAuthoredEvent(prose!, new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
		return editor;
	}

	it('keeps the current same-ID registration and text when a detached vendor-missing retry fires later', async () => {
		vi.useFakeTimers();
		const previous = await mountLifecycleSection({ boxId: 'retry-shared', domId: 'retry-shared', text: 'Queued old note' });
		expect(previous.section.getEditorApi()).toBeNull();
		expect(vi.mocked(ensureToastUiLoaded)).toHaveBeenCalledTimes(1);

		previous.section.remove();
		(window as any).toastui = { Editor: RetryRegistrationToastEditor };

		const current = await mountLifecycleSection({ boxId: 'retry-shared', domId: 'retry-shared', text: 'Current exact note' });
		const currentApi = current.section.getEditorApi();
		expect(currentApi).not.toBeNull();
		typeRetryText(current, 'Current authored note');
		await flushRetryCallbacks();
		expect(current.section.getText()).toBe('Current authored note');
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(50);
		await flushRetryCallbacks();

		expect(previous.section.getEditorApi()).toBeNull();
		expect(current.section.getEditorApi()).toBe(currentApi);
		expect(window.__kustoMarkdownEditors['retry-shared']).toBe(currentApi);
		expect(current.section.getText()).toBe('Current authored note');
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(1);
		expect(requestHostOwnedMarkdownPatch).not.toHaveBeenCalled();
	});

	it('retries exactly once after a same-node reconnect and initializes when the vendor becomes available', async () => {
		vi.useFakeTimers();
		const fixture = await mountLifecycleSection({ boxId: 'same-node-reconnect', domId: 'same-node-reconnect', text: 'Reconnect note' });
		expect(fixture.section.getEditorApi()).toBeNull();
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(0);

		fixture.section.remove();
		container.appendChild(fixture.section);
		await fixture.section.updateComplete;
		await flushRetryCallbacks();

		(window as any).toastui = { Editor: RetryRegistrationToastEditor };
		await vi.advanceTimersByTimeAsync(49);
		await flushRetryCallbacks();
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		await flushRetryCallbacks();
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(1);
		expect(fixture.section.getEditorApi()).not.toBeNull();

		await vi.advanceTimersByTimeAsync(8000);
		await flushRetryCallbacks();
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(1);
	});

	it('keeps the exact editor object and undo history when the same node is reordered with an attached API', async () => {
		(window as any).toastui = { Editor: RetryRegistrationToastEditor };
		const fixture = await mountLifecycleSection({ boxId: 'same-node-reorder', domId: 'same-node-reorder', text: 'Original note' });
		const api = fixture.section.getEditorApi();
		const editor = api?._toastui as RetryRegistrationToastEditor;
		expect(editor).toBeInstanceOf(RetryRegistrationToastEditor);

		typeRetryText(fixture, 'Edited note');
		await flushRetryCallbacks();
		expect(fixture.section.getText()).toBe('Edited note');

		fixture.section.remove();
		container.appendChild(fixture.section);
		await fixture.section.updateComplete;
		await flushRetryCallbacks();

		expect(fixture.section.getEditorApi()).toBe(api);
		expect(fixture.section.getEditorApi()?._toastui).toBe(editor);
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(1);

		const undo = fixture.editorHost.querySelector('[aria-label="Undo"]') as HTMLElement;
		dispatchAuthoredEvent(undo, new MouseEvent('click', { bubbles: true }));
		await flushRetryCallbacks();
		expect(fixture.section.getText()).toBe('Original note');
		expect(editor.undo).toHaveBeenCalledTimes(1);
	});

	it('remains usable for plain Markdown when the section has no DOM id', async () => {
		(window as any).toastui = { Editor: RetryRegistrationToastEditor };
		pState.documentKind = 'md';
		const fixture = await mountLifecycleSection({ boxId: 'idless-plain-md', domId: '', text: 'Plain body', plainMd: true });
		expect(fixture.section.id).toBe('');
		expect(fixture.section.getEditorApi()).not.toBeNull();
		expect(window.__kustoMarkdownEditors['idless-plain-md']).toBe(fixture.section.getEditorApi());
		expect(fixture.section.getText()).toBe('Plain body');

		fixture.section.setText('Updated plain body');
		await flushRetryCallbacks();
		expect(fixture.section.getText()).toBe('Updated plain body');
	});

	it('keeps the retry delays at 50/250/1000/2000/4000 and stops after five attempts', async () => {
		vi.useFakeTimers();
		await mountLifecycleSection({ boxId: 'retry-cap', domId: 'retry-cap', text: 'Cap note' });
		expect(vi.mocked(ensureToastUiLoaded)).toHaveBeenCalledTimes(1);

		for (const [before, after, calls] of [
			[49, 1, 2],
			[249, 1, 3],
			[999, 1, 4],
			[1999, 1, 5],
			[3999, 1, 6],
		] as const) {
			await vi.advanceTimersByTimeAsync(before);
			await flushRetryCallbacks();
			expect(vi.mocked(ensureToastUiLoaded)).toHaveBeenCalledTimes(calls - 1);
			await vi.advanceTimersByTimeAsync(after);
			await flushRetryCallbacks();
			expect(vi.mocked(ensureToastUiLoaded)).toHaveBeenCalledTimes(calls);
		}

		await vi.advanceTimersByTimeAsync(10000);
		await flushRetryCallbacks();
		expect(vi.mocked(ensureToastUiLoaded)).toHaveBeenCalledTimes(6);
		expect(RetryRegistrationToastEditor.constructed).toHaveLength(0);
	});
});

describe('KwMarkdownSection mode popup dismissal', () => {
	it('stays open when a press starts inside and releases outside', async () => {
		const section = document.createElement('kw-markdown-section') as KwMarkdownSection;
		(section as any)._dropdownOpen = true;
		container.appendChild(section);
		await section.updateComplete;

		const menu = section.shadowRoot!.querySelector('.md-mode-dropdown-menu') as HTMLElement;
		menu.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
		document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
		await section.updateComplete;
		expect((section as any)._dropdownOpen).toBe(true);

		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		await section.updateComplete;
		expect((section as any)._dropdownOpen).toBe(false);
	});
});
