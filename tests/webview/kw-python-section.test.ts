import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/sections/kw-python-section.js';
import type { KwPythonSection } from '../../src/webview/sections/kw-python-section.js';

// ── Mock Monaco ───────────────────────────────────────────────────────────────

/** Minimal fake Monaco editor that tracks create calls & stores value. */
function createMockMonaco() {
	const editors: Array<{ value: string; disposed: boolean; domNode: HTMLElement }> = [];

	const monaco = {
		editor: {
			create(container: HTMLElement, opts: any) {
				const domNode = document.createElement('div');
				container.appendChild(domNode);
				const ed = {
					value: String(opts?.value ?? ''),
					disposed: false,
					domNode,
					getValue() { return this.value; },
					setValue(v: string) { this.value = v; },
					getModel() { return { getValue: () => ed.value }; },
					getContentHeight() { return 100; },
					getDomNode() { return this.disposed ? null : this.domNode; },
					layout() {},
					dispose() { this.disposed = true; },
					focus() {},
					onDidFocusEditorText() { return { dispose() {} }; },
					onDidFocusEditorWidget() { return { dispose() {} }; },
					onDidChangeModelContent() { return { dispose() {} }; },
					updateOptions() {},
				};
				editors.push(ed);
				return ed;
			},
		},
		editors,
	};

	return monaco;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let container: HTMLDivElement;

function createPythonSection(initialCode = ''): KwPythonSection {
	render(html`
		<kw-python-section box-id="py_test_1" initial-code=${initialCode}>
			<div slot="editor" class="query-editor"></div>
		</kw-python-section>
	`, container);
	return container.querySelector('kw-python-section')!;
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
	container = document.createElement('div');
	container.id = 'queries-container';
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	delete (window as any).ensureMonaco;
	delete (window as any).schedulePersist;
	vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-python-section — reorder (disconnect/reconnect)', () => {

	it('re-creates editor with saved content after DOM move', async () => {
		// Set up mock Monaco
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		(window as any).schedulePersist = () => {};

		// Create the section
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		// Wait for the ensureMonaco promise to resolve
		await new Promise(r => setTimeout(r, 0));

		// Verify editor was created with initial code
		expect(mockMonaco.editors.length).toBe(1);
		expect(mockMonaco.editors[0].value).toBe('print(1)');

		// Simulate user editing content
		mockMonaco.editors[0].value = 'print(10)';

		// Simulate a reorder: remove from DOM then re-append
		container.removeChild(el);
		// disconnectedCallback fires — editor should be disposed, content saved

		expect(mockMonaco.editors[0].disposed).toBe(true);

		// Re-insert (simulates reorder completion)
		container.appendChild(el);
		await el.updateComplete;
		// Wait for the ensureMonaco promise in connectedCallback
		await new Promise(r => setTimeout(r, 0));

		// A NEW editor should have been created with the saved content
		expect(mockMonaco.editors.length).toBe(2);
		expect(mockMonaco.editors[1].value).toBe('print(10)');
		expect(mockMonaco.editors[1].disposed).toBe(false);
	});

	it('does not lose content when initial-code differs from current', async () => {
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		(window as any).schedulePersist = () => {};

		const el = createPythonSection('# original');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));

		// User completely replaces the code
		mockMonaco.editors[0].value = 'import os\nprint(os.getcwd())';

		// Reorder
		container.removeChild(el);
		container.appendChild(el);
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));

		// New editor must have the user's code, not the original initial-code
		const lastEditor = mockMonaco.editors[mockMonaco.editors.length - 1];
		expect(lastEditor.value).toBe('import os\nprint(os.getcwd())');
	});

	it('getName() returns the section title', async () => {
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		(window as any).schedulePersist = () => {};

		const el = createPythonSection();
		await el.updateComplete;

		el.setTitle('My Analysis');
		expect(el.getName()).toBe('My Analysis');
	});
});
