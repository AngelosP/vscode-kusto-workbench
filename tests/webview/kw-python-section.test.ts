import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/sections/kw-python-section.js';
import type { KwPythonSection } from '../../src/webview/sections/kw-python-section.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	adoptHostOwnedMarkdownDocument,
	resetHostOwnedMarkdownDocument,
} from '../../src/webview/core/markdown-document-client.js';
import {
	resetPythonExecutionAdmissionForTest,
	retireAllPythonExecutions,
} from '../../src/webview/core/python-execution-admission.js';
import { onPythonError, onPythonResult } from '../../src/webview/core/section-factory.js';

// ── Mock Monaco ───────────────────────────────────────────────────────────────

/** Minimal fake Monaco editor that tracks create calls & stores value. */
function createMockMonaco() {
	const editors: Array<{
		value: string;
		disposed: boolean;
		domNode: HTMLElement;
		commands: Map<number, () => void>;
		contentChangeHandlers: Array<() => void>;
	}> = [];

	const monaco = {
		editor: {
			create(container: HTMLElement, opts: any) {
				const domNode = document.createElement('div');
				container.appendChild(domNode);
				const ed = {
					value: String(opts?.value ?? ''),
					disposed: false,
					domNode,
					commands: new Map<number, () => void>(),
					contentChangeHandlers: [] as Array<() => void>,
					getValue() { return this.value; },
					setValue(v: string) {
						this.value = v;
						for (const handler of this.contentChangeHandlers) handler();
					},
					getModel() { return { getValue: () => ed.value }; },
					getContentHeight() { return 100; },
					getDomNode() { return this.disposed ? null : this.domNode; },
					layout() {},
					dispose() { this.disposed = true; },
					focus() {},
					onDidFocusEditorText() { return { dispose() {} }; },
					onDidFocusEditorWidget() { return { dispose() {} }; },
					onDidChangeModelContent(cb: () => void) {
						this.contentChangeHandlers.push(cb);
						return { dispose: () => {
							const index = this.contentChangeHandlers.indexOf(cb);
							if (index >= 0) this.contentChangeHandlers.splice(index, 1);
						} };
					},
					updateOptions() {},
					addCommand(keybinding: number, handler: () => void) { this.commands.set(keybinding, handler); },
				};
				editors.push(ed);
				return ed;
			},
		},
		KeyMod: { CtrlCmd: 0x0800, Shift: 0x0400 },
		KeyCode: { Enter: 3 },
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
	const element = container.querySelector('kw-python-section')!;
	element.id = 'py_test_1';
	return element;
}

// ── Setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
	resetHostOwnedMarkdownDocument();
	resetPythonExecutionAdmissionForTest();
	pState.documentMutationAllowed = true;
	delete (window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode;
	container = document.createElement('div');
	container.id = 'queries-container';
	document.body.appendChild(container);
});

afterEach(() => {
	resetHostOwnedMarkdownDocument();
	resetPythonExecutionAdmissionForTest();
	render(nothing, container);
	container.remove();
	delete (window as any).ensureMonaco;
	delete (window as any).schedulePersist;
	pState.documentMutationAllowed = true;
	delete (window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode;
	vi.restoreAllMocks();
});

function activateHostOwnership(output = 'before output'): void {
	pState.documentKind = 'kqlx';
	pState.compatibilityMode = false;
	pState.restoreInProgress = false;
	pState.documentRuntimeActive = true;
	pState.applyingHostMarkdownProjection = false;
	const adopted = adoptHostOwnedMarkdownDocument({
		documentRevision: 0,
		sourceGeneration: 17,
		sectionRevisions: { py_test_1: 0 },
		markdownSectionRevisions: {},
	}, {
		sections: [{
			id: 'py_test_1', type: 'python', name: 'Before', code: 'print(1)',
			output, expanded: true, editorHeightPx: 180,
		}],
	});
	expect(adopted).toBe(true);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-python-section — reorder (disconnect/reconnect)', () => {

	it('retains the editor and current content across a transient DOM move', async () => {
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
		// Reordering must not dispose the component-owned Monaco instance.
		expect(mockMonaco.editors[0].disposed).toBe(false);

		// Re-insert (simulates reorder completion)
		container.appendChild(el);
		await el.updateComplete;
		// Allow deferred disconnect handling to settle.
		await new Promise(r => setTimeout(r, 0));

		expect(mockMonaco.editors.length).toBe(1);
		expect(mockMonaco.editors[0].value).toBe('print(10)');
		expect(mockMonaco.editors[0].disposed).toBe(false);
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

	it('disposes its editor after genuine removal', async () => {
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));

		container.removeChild(el);
		await new Promise(r => setTimeout(r, 0));

		expect(mockMonaco.editors[0].disposed).toBe(true);
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

describe('kw-python-section — host-owned document state', () => {
	it('applies a projection without recreating Monaco or executing code', async () => {
		activateHostOwnership();
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));
		const editor = mockMonaco.editors[0];

		el.applyHostDocumentState({
			id: 'py_test_1', type: 'python', name: 'Host', code: 'print(2)',
			output: 'two', expanded: false, editorHeightPx: 360,
		});
		await el.updateComplete;

		expect(mockMonaco.editors).toHaveLength(1);
		expect(mockMonaco.editors[0]).toBe(editor);
		expect(editor.value).toBe('print(2)');
		expect(el.serialize()).toEqual({
			id: 'py_test_1', type: 'python', name: 'Host', code: 'print(2)',
			output: 'two', expanded: false, editorHeightPx: 360,
		});
		expect(posted.some(message => message.type === 'markdownDocumentCommand')).toBe(false);
		expect(posted.some(message => message.type === 'executePython')).toBe(false);
	});

	it('emits revisioned patches for code and admitted execution output', async () => {
		activateHostOwnership();
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));
		el.applyHostDocumentState(pState.hostOwnedPythonSections.py_test_1);
		posted.length = 0;

		mockMonaco.editors[0].setValue('print(2)');
		await Promise.resolve();
		expect(posted[0]).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 17, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'py_test_1', expectedSectionRevision: 0,
				patch: { code: 'print(2)', output: 'before output' },
			},
		});

		const ctrlEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyCode.Enter;
		mockMonaco.editors[0].commands.get(ctrlEnter)!();
		expect(posted[1]).toMatchObject({
			type: 'executePython', boxId: 'py_test_1', code: 'print(2)',
		});
		onPythonResult({
			type: 'pythonResult', boxId: 'py_test_1', stdout: 'done\n', stderr: '', exitCode: 0,
		});
		await Promise.resolve();
		expect(posted[2]).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 17, expectedDocumentRevision: 1,
			command: {
				type: 'patch', sectionId: 'py_test_1', expectedSectionRevision: 1,
				patch: { code: 'print(2)', output: 'done\n' },
			},
		});
	});

	it('persists clearing a nonempty live model as empty code', async () => {
		activateHostOwnership();
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));
		el.applyHostDocumentState(pState.hostOwnedPythonSections.py_test_1);
		posted.length = 0;

		mockMonaco.editors[0].setValue('');

		expect(posted[0]).toMatchObject({
			type: 'markdownDocumentCommand',
			command: {
				type: 'patch', sectionId: 'py_test_1', expectedSectionRevision: 0,
				patch: { code: '' },
			},
		});
		expect(el.serialize().code).toBe('');
	});

	it('emits revisioned patches for programmatic collapse and rename', async () => {
		activateHostOwnership();
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));
		el.applyHostDocumentState(pState.hostOwnedPythonSections.py_test_1);
		posted.length = 0;

		el.setExpanded(false);
		el.setName('Renamed');
		const commands = posted.filter(message => message.type === 'markdownDocumentCommand');
		expect(commands).toHaveLength(2);
		expect(commands[0]).toMatchObject({
			expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'py_test_1', expectedSectionRevision: 0,
				patch: { expanded: false, name: 'Before' },
			},
		});
		expect(commands[1]).toMatchObject({
			expectedDocumentRevision: 1,
			command: {
				type: 'patch', sectionId: 'py_test_1', expectedSectionRevision: 1,
				patch: { expanded: false, name: 'Renamed' },
			},
		});
	});

	it('rejects a late terminal after an authoritative projection', async () => {
		activateHostOwnership();
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));
		el.applyHostDocumentState(pState.hostOwnedPythonSections.py_test_1);
		const ctrlEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyCode.Enter;
		mockMonaco.editors[0].commands.get(ctrlEnter)!();
		posted.length = 0;

		el.applyHostDocumentState({
			...pState.hostOwnedPythonSections.py_test_1,
			output: 'restored output',
		});
		onPythonResult({
			type: 'pythonResult', boxId: 'py_test_1', stdout: 'late output', stderr: '', exitCode: 0,
		});

		expect(posted.some(message => message.type === 'markdownDocumentCommand')).toBe(false);
		expect(el.serialize().output).toBe('restored output');
	});

	it('blocks an identical-code rerun until a retired terminal is consumed', async () => {
		activateHostOwnership();
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
		const el = createPythonSection('print(1)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));
		el.applyHostDocumentState(pState.hostOwnedPythonSections.py_test_1);
		const ctrlEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyCode.Enter;
		const run = mockMonaco.editors[0].commands.get(ctrlEnter)!;
		posted.length = 0;

		run();
		expect(posted.filter(message => message.type === 'executePython')).toHaveLength(1);
		el.applyHostDocumentState({ ...pState.hostOwnedPythonSections.py_test_1, output: 'projected' });
		run();
		expect(posted.filter(message => message.type === 'executePython')).toHaveLength(1);

		onPythonResult({
			type: 'pythonResult', boxId: 'py_test_1', stdout: 'run A', stderr: '', exitCode: 0,
		});
		expect(posted.some(message => message.type === 'markdownDocumentCommand')).toBe(false);
		expect(el.serialize().output).toBe('projected');

		run();
		expect(posted.filter(message => message.type === 'executePython')).toHaveLength(2);
		onPythonResult({
			type: 'pythonResult', boxId: 'py_test_1', stdout: 'run B', stderr: '', exitCode: 0,
		});
		expect(posted.filter(message => message.type === 'markdownDocumentCommand')).toHaveLength(1);
		expect(el.serialize().output).toBe('run B');
	});

	it.each(['result', 'error'] as const)(
		'consumes an inactive retired %s terminal and allows rerun after repair',
		async terminalKind => {
			activateHostOwnership();
			const mockMonaco = createMockMonaco();
			(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
			const posted: any[] = [];
			(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
			const el = createPythonSection('print(1)');
			await el.updateComplete;
			await new Promise(r => setTimeout(r, 0));
			el.applyHostDocumentState(pState.hostOwnedPythonSections.py_test_1);
			const ctrlEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyCode.Enter;
			const run = mockMonaco.editors[0].commands.get(ctrlEnter)!;
			run();
			posted.length = 0;

			pState.documentRuntimeActive = false;
			retireAllPythonExecutions();
			if (terminalKind === 'result') {
				onPythonResult({
					type: 'pythonResult', boxId: 'py_test_1', stdout: 'discarded', stderr: '', exitCode: 0,
				});
			} else {
				onPythonError({ type: 'pythonError', boxId: 'py_test_1', error: 'discarded' });
			}
			expect(el.serialize().output).toBe('before output');
			expect(posted.some(message => message.type === 'markdownDocumentCommand')).toBe(false);

			pState.documentRuntimeActive = true;
			el.applyHostDocumentState({ ...pState.hostOwnedPythonSections.py_test_1, output: 'repaired' });
			run();
			expect(posted.filter(message => message.type === 'executePython')).toHaveLength(1);
			onPythonResult({
				type: 'pythonResult', boxId: 'py_test_1', stdout: 'new output', stderr: '', exitCode: 0,
			});
			expect(el.serialize().output).toBe('new output');
		},
	);

	it('blocks a detached same-ID instance from publishing stale code or output', async () => {
		activateHostOwnership();
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		(window as any).vscode = { postMessage(message: any) { posted.push(message); } };
		const stale = createPythonSection('print(1)');
		await stale.updateComplete;
		await new Promise(r => setTimeout(r, 0));
		const staleEditor = mockMonaco.editors[0];
		const ctrlEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyCode.Enter;
		staleEditor.commands.get(ctrlEnter)!();
		posted.length = 0;

		container.removeChild(stale);
		const replacement = document.createElement('kw-python-section') as KwPythonSection;
		replacement.id = 'py_test_1';
		replacement.setAttribute('box-id', 'py_test_1');
		replacement.setOutput('replacement output');
		container.appendChild(replacement);
		staleEditor.setValue('print("stale")');
		onPythonResult({
			type: 'pythonResult', boxId: 'py_test_1', stdout: 'stale output', stderr: '', exitCode: 0,
		});
		await Promise.resolve();

		expect(posted.some(message => message.type === 'markdownDocumentCommand')).toBe(false);
		expect(replacement.serialize().output).toBe('replacement output');
	});
});

describe('kw-python-section — Ctrl+Enter runs Python', () => {
	it('registers no run shortcut and cannot execute in the read-only browser host', async () => {
		pState.documentMutationAllowed = false;
		(window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode = true;
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		const posted: any[] = [];
		const previousVsCode = window.vscode;
		window.vscode = { postMessage(message: any) { posted.push(message); } } as any;
		try {
			const el = createPythonSection('print(1)');
			await el.updateComplete;
			await new Promise(resolve => setTimeout(resolve, 0));

			expect(mockMonaco.editors[0].commands).toHaveLength(0);
			(el as any)._run();
			expect(posted.some(message => message.type === 'executePython')).toBe(false);
			expect(el.shadowRoot?.textContent).not.toContain('Running…');
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('registers Ctrl+Enter and Ctrl+Shift+Enter commands on the editor', async () => {
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		(window as any).schedulePersist = () => {};

		const el = createPythonSection('print(42)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));

		const ed = mockMonaco.editors[0];
		const ctrlEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyCode.Enter;
		const ctrlShiftEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyMod.Shift | mockMonaco.KeyCode.Enter;

		expect(ed.commands.has(ctrlEnter), 'Ctrl+Enter command should be registered').toBe(true);
		expect(ed.commands.has(ctrlShiftEnter), 'Ctrl+Shift+Enter command should be registered').toBe(true);
	});

	it('Ctrl+Enter handler sends executePython message', async () => {
		const mockMonaco = createMockMonaco();
		(window as any).ensureMonaco = () => Promise.resolve(mockMonaco);
		(window as any).schedulePersist = () => {};

		const posted: any[] = [];
		(window as any).vscode = { postMessage(msg: any) { posted.push(msg); } };

		const el = createPythonSection('print(42)');
		await el.updateComplete;
		await new Promise(r => setTimeout(r, 0));

		const ed = mockMonaco.editors[0];
		const ctrlEnter = mockMonaco.KeyMod.CtrlCmd | mockMonaco.KeyCode.Enter;
		const handler = ed.commands.get(ctrlEnter)!;
		expect(handler, 'Ctrl+Enter handler must exist').toBeDefined();
		el.setOutput('previous output');

		// Invoke the handler — should send executePython message
		handler();

		expect(posted.length).toBe(1);
		expect(posted[0].type).toBe('executePython');
		expect(posted[0].boxId).toBe('py_test_1');
		expect(posted[0].code).toBe('print(42)');
		expect(el.serialize().output).toBe('previous output');

		delete (window as any).vscode;
	});
});
