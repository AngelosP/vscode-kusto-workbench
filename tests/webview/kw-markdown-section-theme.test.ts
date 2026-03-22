import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/webview/core/utils.js', () => ({
	getScrollY: () => 0,
	maybeAutoScrollWhileDragging: vi.fn(),
}));

vi.mock('../../src/webview/modules/dropdown.js', () => ({
	closeAllMenus: vi.fn(),
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

vi.mock('../../src/webview/shared/lazy-vendor.js', () => ({
	ensureToastUiLoaded: () => Promise.resolve(),
}));

import { KwMarkdownSection } from '../../src/webview/sections/kw-markdown-section.js';

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
