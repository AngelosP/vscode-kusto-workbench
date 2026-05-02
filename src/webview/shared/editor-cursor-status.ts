export type EditorCursorStatusKind = 'kusto' | 'sql' | 'html' | 'python' | 'markdown';

export type EditorCursorStatusMessage = {
	type: 'editorCursorPositionChanged';
	boxId?: string;
	editorKind: EditorCursorStatusKind;
	line?: number;
	column?: number;
	visible?: boolean;
	reason?: string;
};

type DisposableLike = { dispose(): void };

export type MonacoCursorStatusEditor = {
	getPosition?: () => { lineNumber: number; column: number } | null;
	getDomNode?: () => HTMLElement | null;
	hasTextFocus?: () => boolean;
	hasWidgetFocus?: () => boolean;
	onMouseMove?: (cb: () => void) => DisposableLike;
	onMouseLeave?: (cb: () => void) => DisposableLike;
	onDidChangeCursorPosition?: (cb: () => void) => DisposableLike;
	onDidFocusEditorText?: (cb: () => void) => DisposableLike;
	onDidFocusEditorWidget?: (cb: () => void) => DisposableLike;
	onDidBlurEditorText?: (cb: () => void) => DisposableLike;
	onDidBlurEditorWidget?: (cb: () => void) => DisposableLike;
};

export type EditorCursorStatusPublisher = {
	publish(reason?: string): void;
	clear(reason?: string): void;
	dispose(): void;
};

export interface MonacoCursorStatusPublisherOptions {
	editor: MonacoCursorStatusEditor;
	boxId: string;
	editorKind: EditorCursorStatusKind;
	postMessage: (message: EditorCursorStatusMessage) => void;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value && value > 0;
}

export function createMonacoCursorStatusPublisher(options: MonacoCursorStatusPublisherOptions): EditorCursorStatusPublisher {
	const disposables: DisposableLike[] = [];
	let disposed = false;
	let lastMessageKey = '';
	let mouseInside = false;
	let hasMouseTracking = false;

	const post = (message: EditorCursorStatusMessage): void => {
		const key = message.visible === false
			? 'hidden'
			: `visible:${message.line}:${message.column}`;
		if (key === lastMessageKey) {
			return;
		}
		lastMessageKey = key;
		options.postMessage(message);
	};

	const isEditorActive = (): boolean => {
		const hasTextFocus = typeof options.editor.hasTextFocus === 'function';
		const hasWidgetFocus = typeof options.editor.hasWidgetFocus === 'function';
		const focused = !!(hasTextFocus && options.editor.hasTextFocus?.()) || !!(hasWidgetFocus && options.editor.hasWidgetFocus?.());
		if (focused || mouseInside) {
			return true;
		}
		return !hasTextFocus && !hasWidgetFocus && !hasMouseTracking;
	};

	const clearAfterInactive = (reason: string) => {
		setTimeout(() => {
			if (!disposed && !isEditorActive()) {
				publisher.clear(reason);
			}
		}, 0);
	};

	const publisher: EditorCursorStatusPublisher = {
		publish(reason = 'cursor'): void {
			if (disposed || !isEditorActive()) {
				return;
			}
			const position = options.editor.getPosition?.();
			const line = position?.lineNumber;
			const column = position?.column;
			if (!isPositiveInteger(line) || !isPositiveInteger(column)) {
				publisher.clear('invalid-position');
				return;
			}
			post({
				type: 'editorCursorPositionChanged',
				boxId: options.boxId,
				editorKind: options.editorKind,
				line,
				column,
				visible: true,
				reason
			});
		},
		clear(reason = 'clear'): void {
			if (disposed) {
				return;
			}
			post({
				type: 'editorCursorPositionChanged',
				boxId: options.boxId,
				editorKind: options.editorKind,
				visible: false,
				reason
			});
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			publisher.clear('dispose');
			disposed = true;
			for (const disposable of disposables.splice(0)) {
				try { disposable.dispose(); } catch { /* ignore */ }
			}
		}
	};

	const add = (disposable: DisposableLike | undefined): void => {
		if (disposable) {
			disposables.push(disposable);
		}
	};

	add(options.editor.onDidFocusEditorText?.(() => publisher.publish('focus-text')));
	add(options.editor.onDidFocusEditorWidget?.(() => publisher.publish('focus-widget')));
	add(options.editor.onDidChangeCursorPosition?.(() => publisher.publish('cursor')));
	add(options.editor.onMouseMove?.(() => {
		mouseInside = true;
		publisher.publish('mouse');
	}));
	add(options.editor.onMouseLeave?.(() => {
		mouseInside = false;
		clearAfterInactive('mouse-leave');
	}));
	if (typeof options.editor.onMouseMove === 'function' || typeof options.editor.onMouseLeave === 'function') {
		hasMouseTracking = true;
	}

	const domNode = options.editor.getDomNode?.();
	if (domNode) {
		hasMouseTracking = true;
		const onMouseEnterOrMove = () => {
			mouseInside = true;
			publisher.publish('mouse');
		};
		const onMouseLeave = () => {
			mouseInside = false;
			clearAfterInactive('mouse-leave');
		};
		domNode.addEventListener('mouseenter', onMouseEnterOrMove);
		domNode.addEventListener('mousemove', onMouseEnterOrMove);
		domNode.addEventListener('mouseleave', onMouseLeave);
		add({ dispose: () => {
			domNode.removeEventListener('mouseenter', onMouseEnterOrMove);
			domNode.removeEventListener('mousemove', onMouseEnterOrMove);
			domNode.removeEventListener('mouseleave', onMouseLeave);
		} });
	}

	const clearAfterBlur = () => clearAfterInactive('blur');
	add(options.editor.onDidBlurEditorText?.(clearAfterBlur));
	add(options.editor.onDidBlurEditorWidget?.(clearAfterBlur));

	return publisher;
}
