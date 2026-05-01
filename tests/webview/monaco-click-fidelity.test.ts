import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	__kustoArePositionsEqual,
	__kustoAreSelectionsEqual,
	__kustoGetEditorPositionAtClientPoint,
	__kustoInstallEditorClickFidelityGuard,
	__kustoIsCollapsedSelection,
	__kustoIsMonacoContentClickTarget,
	__kustoIsPlainPrimaryMouseClick,
	__kustoShouldIgnoreEditorMouseTarget,
	__kustoShouldRepairClickPosition,
} from '../../src/webview/monaco/click-fidelity';

const defaultElementFromPoint = typeof document.elementFromPoint === 'function'
	? document.elementFromPoint.bind(document)
	: undefined;

function rect(width = 400, height = 200): DOMRect {
	return {
		x: 0,
		y: 0,
		left: 0,
		top: 0,
		right: width,
		bottom: height,
		width,
		height,
		toJSON: () => ({}),
	} as DOMRect;
}

function makeMouseEvent(type: string, init: MouseEventInit = {}): MouseEvent {
	return new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
		buttons: 1,
		clientX: 20,
		clientY: 30,
		detail: 1,
		...init,
	});
}

function createMeasurableRoot(): { wrapper: HTMLElement; container: HTMLElement; target: HTMLElement } {
	const wrapper = document.createElement('div');
	const container = document.createElement('div');
	const target = document.createElement('div');
	wrapper.appendChild(container);
	container.appendChild(target);
	document.body.appendChild(wrapper);
	(wrapper as any).getBoundingClientRect = () => rect(500, 300);
	(container as any).getBoundingClientRect = () => rect(500, 260);
	return { wrapper, container, target };
}

function mockElementFromPoint(target: Element | null): void {
	Object.defineProperty(document, 'elementFromPoint', {
		configurable: true,
		value: vi.fn(() => target),
	});
}

afterEach(() => {
	vi.useRealTimers();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	if (defaultElementFromPoint) {
		Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: defaultElementFromPoint });
	} else {
		delete (document as any).elementFromPoint;
	}
});

describe('Monaco click fidelity helpers', () => {
	it('ignores editor-adjacent UI targets', () => {
		const root = document.createElement('div');
		root.innerHTML = `
			<div class="query-editor-toolbar"><button id="toolbarButton"></button></div>
			<div class="query-editor-resizer" id="resizer"></div>
			<div class="kusto-copilot-chat" id="chat"></div>
			<div data-kusto-no-editor-focus="true"><span id="noFocus"></span></div>
			<div class="suggest-widget"><span id="suggestion"></span></div>
			<div class="scrollbar"><span id="scrollbarChild"></span></div>
		`;
		document.body.appendChild(root);

		expect(__kustoShouldIgnoreEditorMouseTarget(root.querySelector('#toolbarButton'))).toBe(true);
		expect(__kustoShouldIgnoreEditorMouseTarget(root.querySelector('#resizer'))).toBe(true);
		expect(__kustoShouldIgnoreEditorMouseTarget(root.querySelector('#chat'))).toBe(true);
		expect(__kustoShouldIgnoreEditorMouseTarget(root.querySelector('#noFocus'))).toBe(true);
		expect(__kustoShouldIgnoreEditorMouseTarget(root.querySelector('#suggestion'))).toBe(true);
		expect(__kustoShouldIgnoreEditorMouseTarget(root.querySelector('#scrollbarChild'))).toBe(true);
		expect(__kustoShouldIgnoreEditorMouseTarget(document.createElement('span'))).toBe(false);
	});

	it('only treats unmodified single left-clicks as repair-eligible', () => {
		expect(__kustoIsPlainPrimaryMouseClick(makeMouseEvent('mousedown'))).toBe(true);
		expect(__kustoIsPlainPrimaryMouseClick(makeMouseEvent('mousedown', { button: 2 }))).toBe(false);
		expect(__kustoIsPlainPrimaryMouseClick(makeMouseEvent('mousedown', { detail: 2 }))).toBe(false);
		expect(__kustoIsPlainPrimaryMouseClick(makeMouseEvent('mousedown', { shiftKey: true }))).toBe(false);
		expect(__kustoIsPlainPrimaryMouseClick(makeMouseEvent('mousedown', { ctrlKey: true }))).toBe(false);
		expect(__kustoIsPlainPrimaryMouseClick(makeMouseEvent('mousedown', { metaKey: true }))).toBe(false);
		expect(__kustoIsPlainPrimaryMouseClick(makeMouseEvent('mousedown', { altKey: true }))).toBe(false);
	});

	it('accepts only Monaco content click targets for caret repair', () => {
		expect(__kustoIsMonacoContentClickTarget({ type: 6, position: { lineNumber: 1, column: 2 } })).toBe(true);
		expect(__kustoIsMonacoContentClickTarget({ type: 7, position: { lineNumber: 1, column: 2 } })).toBe(true);
		expect(__kustoIsMonacoContentClickTarget({ type: 'CONTENT_TEXT', position: { lineNumber: 1, column: 2 } })).toBe(true);
		expect(__kustoIsMonacoContentClickTarget({ type: 'scrollbar', position: { lineNumber: 1, column: 2 } })).toBe(false);
		expect(__kustoIsMonacoContentClickTarget({ type: 3, position: { lineNumber: 1, column: 2 } })).toBe(false);
	});

	it('reads a target position only from content targets', () => {
		const editor = {
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 2, column: 5 } })),
		};
		expect(__kustoGetEditorPositionAtClientPoint(editor, 10, 20)).toEqual({ lineNumber: 2, column: 5 });

		editor.getTargetAtClientPoint.mockReturnValue({ type: 11, position: { lineNumber: 9, column: 9 } });
		expect(__kustoGetEditorPositionAtClientPoint(editor, 10, 20)).toBeNull();

		editor.getTargetAtClientPoint.mockReturnValue({ type: 6, position: null });
		expect(__kustoGetEditorPositionAtClientPoint(editor, 10, 20)).toBeNull();
	});

	it('repairs only when the selection is collapsed and the caret differs', () => {
		const clicked = { lineNumber: 4, column: 8 };
		const current = { lineNumber: 1, column: 1 };
		const collapsed = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
		const selected = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };
		const changedSelection = { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 4 };

		expect(__kustoIsCollapsedSelection(collapsed)).toBe(true);
		expect(__kustoIsCollapsedSelection(selected)).toBe(false);
		expect(__kustoArePositionsEqual(clicked, { lineNumber: 4, column: 8 })).toBe(true);
		expect(__kustoAreSelectionsEqual(selected, { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 })).toBe(true);
		expect(__kustoShouldRepairClickPosition(clicked, current, collapsed, 1)).toBe(true);
		expect(__kustoShouldRepairClickPosition(clicked, clicked, collapsed, 1)).toBe(false);
		expect(__kustoShouldRepairClickPosition(clicked, current, selected, 1, selected)).toBe(true);
		expect(__kustoShouldRepairClickPosition(clicked, current, changedSelection, 1, selected)).toBe(false);
		expect(__kustoShouldRepairClickPosition(clicked, current, selected, 1)).toBe(false);
		expect(__kustoShouldRepairClickPosition(clicked, current, collapsed, 2)).toBe(false);
	});
});


describe('Monaco click fidelity guard', () => {
	it('deduplicates pointerdown and mousedown preparation for the same click', () => {
		const { wrapper, container, target } = createMeasurableRoot();
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 2, column: 3 } })),
			getPosition: vi.fn(() => ({ lineNumber: 2, column: 3 })),
			getSelection: vi.fn(() => ({ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 })),
			getSelections: vi.fn(() => [{ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('pointerdown'));
		target.dispatchEvent(makeMouseEvent('mousedown'));

		expect(editor.layout).toHaveBeenCalledTimes(1);
		guard.dispose();
	});

	it('repairs a missed simple click after mouseup when the caret stayed elsewhere', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 3, column: 7 } })),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const activateEditor = vi.fn();
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor,
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown'));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		vi.runAllTimers();

		expect(activateEditor).toHaveBeenCalled();
		expect(editor.focus).toHaveBeenCalled();
		expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 7 });
		guard.dispose();
	});

	it('does not let deferred focus move an already-focused click back to the first line', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		let focused = false;
		let currentPosition = { lineNumber: 1, column: 1 };
		let selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
		const clickedPosition = { lineNumber: 5, column: 4 };
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(() => {
				focused = true;
				currentPosition = { lineNumber: 1, column: 1 };
				selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
			}),
			hasTextFocus: vi.fn(() => focused),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: clickedPosition })),
			getPosition: vi.fn(() => currentPosition),
			getSelection: vi.fn(() => selection),
			getSelections: vi.fn(() => [selection]),
			setPosition: vi.fn((position: { lineNumber: number; column: number }) => {
				currentPosition = position;
				selection = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
			}),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown'));
		focused = true;
		currentPosition = clickedPosition;
		selection = { startLineNumber: 5, startColumn: 4, endLineNumber: 5, endColumn: 4 };
		vi.runOnlyPendingTimers();

		expect(editor.focus).not.toHaveBeenCalled();
		expect(currentPosition).toEqual(clickedPosition);
		guard.dispose();
	});

	it('cancels repair when the mouse moves like a drag selection', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 3, column: 7 } })),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown', { clientX: 20, clientY: 30 }));
		document.dispatchEvent(makeMouseEvent('mousemove', { clientX: 30, clientY: 30 }));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		vi.runAllTimers();

		expect(editor.setPosition).not.toHaveBeenCalled();
		guard.dispose();
	});

	it('refreshes geometry and recaptures the click target when the page scrolls before mouseup', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const firstPosition = { lineNumber: 3, column: 7 };
		const recapturedPosition = { lineNumber: 8, column: 5 };
		mockElementFromPoint(target);
		const editor = {
			layout: vi.fn(),
			render: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn()
				.mockReturnValueOnce({ type: 6, position: firstPosition })
				.mockReturnValue({ type: 6, position: recapturedPosition }),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown'));
		document.dispatchEvent(new Event('scroll', { bubbles: true }));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		vi.runAllTimers();

		expect(editor.layout).toHaveBeenCalled();
		expect(editor.render).toHaveBeenCalledWith(true);
		expect(editor.setPosition).toHaveBeenCalledWith(recapturedPosition);
		guard.dispose();
	});

	it('recaptures the click target when the page scrolls after mouseup but before deferred repair runs', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const firstPosition = { lineNumber: 3, column: 7 };
		const recapturedPosition = { lineNumber: 9, column: 4 };
		mockElementFromPoint(target);
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn()
				.mockReturnValueOnce({ type: 6, position: firstPosition })
				.mockReturnValue({ type: 6, position: recapturedPosition }),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown'));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		document.dispatchEvent(new Event('scroll', { bubbles: true }));
		vi.runAllTimers();

		expect(editor.focus).toHaveBeenCalled();
		expect(editor.setPosition).toHaveBeenCalledWith(recapturedPosition);
		guard.dispose();
	});

	it('cancels repair when wheel scrolling starts during the click', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 3, column: 7 } })),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown'));
		window.dispatchEvent(new Event('wheel', { bubbles: true, cancelable: true }));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		vi.runAllTimers();

		expect(editor.focus).not.toHaveBeenCalled();
		expect(editor.setPosition).not.toHaveBeenCalled();
		guard.dispose();
	});

	it('skips dirty recapture when the click point is no longer inside the editor', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const outside = document.createElement('div');
		document.body.appendChild(outside);
		mockElementFromPoint(outside);
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 3, column: 7 } })),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown'));
		document.dispatchEvent(new Event('scroll', { bubbles: true }));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		vi.runAllTimers();

		expect(editor.getTargetAtClientPoint).toHaveBeenCalledTimes(1);
		expect(editor.focus).not.toHaveBeenCalled();
		expect(editor.setPosition).not.toHaveBeenCalled();
		guard.dispose();
	});

	it('cancels an already-settling repair when a later click starts', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const firstPosition = { lineNumber: 3, column: 7 };
		const secondPosition = { lineNumber: 6, column: 2 };
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn()
				.mockReturnValueOnce({ type: 6, position: firstPosition })
				.mockReturnValueOnce({ type: 6, position: secondPosition }),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown', { clientX: 20, clientY: 30 }));
		document.dispatchEvent(makeMouseEvent('mouseup', { clientX: 20, clientY: 30 }));
		target.dispatchEvent(makeMouseEvent('mousedown', { clientX: 40, clientY: 50 }));
		document.dispatchEvent(makeMouseEvent('mouseup', { clientX: 40, clientY: 50 }));
		vi.runAllTimers();

		expect(editor.setPosition).toHaveBeenCalledTimes(1);
		expect(editor.setPosition).toHaveBeenCalledWith(secondPosition);
		expect(editor.setPosition).not.toHaveBeenCalledWith(firstPosition);
		guard.dispose();
	});

	it('repairs a missed simple click when an old selection stayed unchanged', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const oldSelection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 };
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 3, column: 7 } })),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => oldSelection),
			getSelections: vi.fn(() => [oldSelection]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown'));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		vi.runAllTimers();

		expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 3, column: 7 });
		guard.dispose();
	});

	it('cancels an earlier repair when a double-click starts', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 3, column: 7 } })),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown', { detail: 1 }));
		target.dispatchEvent(makeMouseEvent('mousedown', { detail: 2 }));
		document.dispatchEvent(makeMouseEvent('mouseup'));
		vi.runAllTimers();

		expect(editor.setPosition).not.toHaveBeenCalled();
		guard.dispose();
	});

	it('cancels a settling repair when a double-click arrives after mouseup', () => {
		vi.useFakeTimers();
		const { wrapper, container, target } = createMeasurableRoot();
		const editor = {
			layout: vi.fn(),
			focus: vi.fn(),
			getTargetAtClientPoint: vi.fn(() => ({ type: 6, position: { lineNumber: 3, column: 7 } })),
			getPosition: vi.fn(() => ({ lineNumber: 1, column: 1 })),
			getSelection: vi.fn(() => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 })),
			getSelections: vi.fn(() => [{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }]),
			setPosition: vi.fn(),
		};
		const guard = __kustoInstallEditorClickFidelityGuard({
			boxId: 'query_1',
			editor,
			container,
			wrapper,
			activateEditor: vi.fn(),
			forceWritable: vi.fn(),
			setCrossClusterPointerDown: vi.fn(),
		});

		target.dispatchEvent(makeMouseEvent('mousedown', { detail: 1 }));
		document.dispatchEvent(makeMouseEvent('mouseup', { detail: 1 }));
		document.dispatchEvent(makeMouseEvent('dblclick', { detail: 2 }));
		vi.runAllTimers();

		expect(editor.focus).not.toHaveBeenCalled();
		expect(editor.setPosition).not.toHaveBeenCalled();
		guard.dispose();
	});
});
