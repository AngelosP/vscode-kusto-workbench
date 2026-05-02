import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMonacoCursorStatusPublisher, type MonacoCursorStatusEditor } from '../../../src/webview/shared/editor-cursor-status';

type CallbackName = 'cursor' | 'focusText' | 'focusWidget' | 'blurText' | 'blurWidget' | 'mouseMove' | 'mouseLeave';

function createEditor() {
	const callbacks: Record<CallbackName, Array<() => void>> = {
		cursor: [],
		focusText: [],
		focusWidget: [],
		blurText: [],
		blurWidget: [],
		mouseMove: [],
		mouseLeave: [],
	};
	const disposed: string[] = [];
	let position: { lineNumber: number; column: number } | null = { lineNumber: 1, column: 2 };
	let textFocus = false;
	let widgetFocus = false;
	const add = (name: CallbackName, cb: () => void) => {
		callbacks[name].push(cb);
		return { dispose: () => disposed.push(name) };
	};
	const editor: MonacoCursorStatusEditor = {
		getPosition: () => position,
		hasTextFocus: () => textFocus,
		hasWidgetFocus: () => widgetFocus,
		onDidChangeCursorPosition: cb => add('cursor', cb),
		onDidFocusEditorText: cb => add('focusText', cb),
		onDidFocusEditorWidget: cb => add('focusWidget', cb),
		onDidBlurEditorText: cb => add('blurText', cb),
		onDidBlurEditorWidget: cb => add('blurWidget', cb),
		onMouseMove: cb => add('mouseMove', cb),
		onMouseLeave: cb => add('mouseLeave', cb),
	};
	return {
		editor,
		disposed,
		setPosition: (next: typeof position) => { position = next; },
		setFocus: (text: boolean, widget = false) => { textFocus = text; widgetFocus = widget; },
		fire: (name: CallbackName) => callbacks[name].forEach(cb => cb()),
	};
}

describe('createMonacoCursorStatusPublisher', () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	it('publishes focused cursor positions and dedupes unchanged values', () => {
		const harness = createEditor();
		const postMessage = vi.fn();
		const publisher = createMonacoCursorStatusPublisher({
			editor: harness.editor,
			boxId: 'query_1',
			editorKind: 'kusto',
			postMessage,
		});

		harness.fire('cursor');
		expect(postMessage).not.toHaveBeenCalled();

		harness.setFocus(true);
		harness.fire('focusText');
		expect(postMessage).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenLastCalledWith({
			type: 'editorCursorPositionChanged',
			boxId: 'query_1',
			editorKind: 'kusto',
			line: 1,
			column: 2,
			visible: true,
			reason: 'focus-text',
		});

		harness.fire('cursor');
		expect(postMessage).toHaveBeenCalledTimes(1);

		harness.setPosition({ lineNumber: 3, column: 4 });
		harness.fire('cursor');
		expect(postMessage).toHaveBeenCalledTimes(2);
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ line: 3, column: 4, reason: 'cursor' }));

		publisher.dispose();
	});

	it('keeps widget focus active and clears after blur', () => {
		vi.useFakeTimers();
		const harness = createEditor();
		const postMessage = vi.fn();
		createMonacoCursorStatusPublisher({ editor: harness.editor, boxId: 'sql_1', editorKind: 'sql', postMessage });

		harness.setFocus(false, true);
		harness.fire('focusWidget');
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, editorKind: 'sql' }));

		harness.fire('blurWidget');
		vi.runOnlyPendingTimers();
		expect(postMessage).toHaveBeenCalledTimes(1);

		harness.setFocus(false, false);
		harness.fire('blurText');
		vi.runOnlyPendingTimers();
		expect(postMessage).toHaveBeenLastCalledWith({
			type: 'editorCursorPositionChanged',
			boxId: 'sql_1',
			editorKind: 'sql',
			visible: false,
			reason: 'blur',
		});
	});

	it('clears invalid positions and disposes event subscriptions', () => {
		const harness = createEditor();
		const postMessage = vi.fn();
		const publisher = createMonacoCursorStatusPublisher({ editor: harness.editor, boxId: 'html_1', editorKind: 'html', postMessage });

		harness.setFocus(true);
		harness.setPosition({ lineNumber: 0, column: 1 });
		publisher.publish('manual');
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, reason: 'invalid-position' }));

		publisher.clear('preview');
		expect(postMessage).toHaveBeenCalledTimes(1);

		publisher.dispose();
		expect(harness.disposed.sort()).toEqual(['blurText', 'blurWidget', 'cursor', 'focusText', 'focusWidget', 'mouseLeave', 'mouseMove'].sort());
		publisher.dispose();
		publisher.publish('after-dispose');
		publisher.clear('after-dispose');
		expect(postMessage).toHaveBeenCalledTimes(1);
	});

	it('works when focus APIs and optional event APIs are absent', () => {
		const postMessage = vi.fn();
		const publisher = createMonacoCursorStatusPublisher({
			editor: { getPosition: () => ({ lineNumber: 5, column: 6 }) },
			boxId: 'python_1',
			editorKind: 'python',
			postMessage,
		});

		publisher.publish('manual');
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ line: 5, column: 6, visible: true }));
	});

	it('publishes while the mouse is inside and clears after mouse leave', () => {
		vi.useFakeTimers();
		const harness = createEditor();
		const postMessage = vi.fn();
		createMonacoCursorStatusPublisher({ editor: harness.editor, boxId: 'query_1', editorKind: 'kusto', postMessage });

		harness.fire('mouseMove');
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, reason: 'mouse' }));

		harness.fire('mouseLeave');
		vi.runOnlyPendingTimers();
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, reason: 'mouse-leave' }));

		harness.setFocus(true);
		harness.fire('mouseMove');
		harness.fire('mouseLeave');
		vi.runOnlyPendingTimers();
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true, reason: 'mouse' }));
	});

	it('uses DOM mouse events when Monaco mouse hooks are unavailable', () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const domNode = document.createElement('div');
		const publisher = createMonacoCursorStatusPublisher({
			editor: { getDomNode: () => domNode, getPosition: () => ({ lineNumber: 8, column: 9 }) },
			boxId: 'html_1',
			editorKind: 'html',
			postMessage,
		});

		publisher.publish('manual');
		expect(postMessage).not.toHaveBeenCalled();

		domNode.dispatchEvent(new MouseEvent('mouseenter'));
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ line: 8, column: 9, reason: 'mouse' }));

		domNode.dispatchEvent(new MouseEvent('mouseleave'));
		vi.runOnlyPendingTimers();
		expect(postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, reason: 'mouse-leave' }));

		publisher.dispose();
		domNode.dispatchEvent(new MouseEvent('mousemove'));
		expect(postMessage).toHaveBeenCalledTimes(2);
	});

	it('handles null positions and disposable failures', () => {
		const postMessage = vi.fn();
		const publisher = createMonacoCursorStatusPublisher({
			editor: {
				getPosition: () => null,
				onDidFocusEditorText: () => ({ dispose: () => { throw new Error('dispose failed'); } }),
			},
			boxId: 'markdown_1',
			editorKind: 'markdown',
			postMessage,
		});

		publisher.publish('manual');
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ visible: false, reason: 'invalid-position' }));
		expect(() => publisher.dispose()).not.toThrow();
	});
});
