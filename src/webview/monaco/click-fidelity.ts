import { addPageScrollListener } from '../core/utils';

type MonacoPositionLike = {
	lineNumber: number;
	column: number;
};

type MonacoSelectionLike = {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
};

type MonacoMouseTargetLike = {
	type?: number | string;
	position?: MonacoPositionLike | null;
};

type MonacoEditorClickLike = {
	focus?: () => void;
	layout?: () => void;
	render?: (forceRedraw?: boolean) => void;
	getPosition?: () => MonacoPositionLike | null;
	getSelection?: () => MonacoSelectionLike | null;
	getSelections?: () => MonacoSelectionLike[] | null;
	setPosition?: (position: MonacoPositionLike) => void;
	getTargetAtClientPoint?: (clientX: number, clientY: number) => MonacoMouseTargetLike | null;
};

export type KustoClickFidelityGuard = {
	dispose: () => void;
};

export type KustoClickFidelityGuardOptions = {
	boxId: string;
	editor: MonacoEditorClickLike;
	container: HTMLElement;
	wrapper?: HTMLElement | null;
	activateEditor: () => void;
	forceWritable: () => void;
	setCrossClusterPointerDown: (isPointerDown: boolean) => void;
	scheduleSuggestClamp?: () => void;
	logError?: (error: unknown) => void;
};

type PendingClickRepair = {
	id: number;
	clientX: number;
	clientY: number;
	position: MonacoPositionLike;
	selectionBefore: MonacoSelectionLike | null;
	geometryDirty: boolean;
	cancelled: boolean;
	settling: boolean;
	cleanup: () => void;
};

type PreparationStamp = {
	key: string;
	at: number;
};

const DUPLICATE_PREPARATION_WINDOW_MS = 40;
const CLICK_MOVE_CANCEL_THRESHOLD_PX = 4;

const MONACO_CONTENT_TEXT_TARGET = 6;
const MONACO_CONTENT_EMPTY_TARGET = 7;

const IGNORED_EDITOR_MOUSE_TARGET_SELECTOR = [
	'.kusto-copilot-chat',
	'kw-copilot-chat',
	'[data-kusto-no-editor-focus="true"]',
	'.query-editor-toolbar',
	'kw-query-toolbar',
	'.query-editor-resizer',
	'.find-widget',
	'.suggest-widget',
	'.parameter-hints-widget',
	'.monaco-hover',
	'.overflowingContentWidgets',
	'.context-view',
	'.monaco-menu',
	'.monaco-editor-overlaymessage',
	'.minimap',
	'.decorationsOverviewRuler',
	'.scrollbar',
	'.slider',
].join(',');

export function __kustoShouldIgnoreEditorMouseTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) {
		return false;
	}
	return !!target.closest(IGNORED_EDITOR_MOUSE_TARGET_SELECTOR);
}

export function __kustoIsPlainPrimaryMouseClick(event: MouseEvent): boolean {
	if (event.button !== 0) {
		return false;
	}
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return false;
	}
	if (typeof event.detail === 'number' && event.detail > 1) {
		return false;
	}
	return true;
}

export function __kustoIsMonacoContentClickTarget(target: MonacoMouseTargetLike | null | undefined): boolean {
	if (!target) {
		return false;
	}
	const targetType = target.type;
	if (targetType === MONACO_CONTENT_TEXT_TARGET || targetType === MONACO_CONTENT_EMPTY_TARGET) {
		return true;
	}
	if (typeof targetType !== 'string') {
		return false;
	}
	const normalized = targetType.replace(/[_\s-]/g, '').toLowerCase();
	return normalized === 'contenttext' || normalized === 'contentempty';
}

export function __kustoGetEditorPositionAtClientPoint(editor: MonacoEditorClickLike, clientX: number, clientY: number): MonacoPositionLike | null {
	try {
		if (!editor || typeof editor.getTargetAtClientPoint !== 'function') {
			return null;
		}
		const target = editor.getTargetAtClientPoint(clientX, clientY);
		if (!__kustoIsMonacoContentClickTarget(target)) {
			return null;
		}
		const position = target?.position;
		if (!position || !Number.isFinite(position.lineNumber) || !Number.isFinite(position.column)) {
			return null;
		}
		return { lineNumber: position.lineNumber, column: position.column };
	} catch {
		return null;
	}
}

export function __kustoIsCollapsedSelection(selection: MonacoSelectionLike | null | undefined): boolean {
	if (!selection) {
		return false;
	}
	return selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn;
}

export function __kustoArePositionsEqual(left: MonacoPositionLike | null | undefined, right: MonacoPositionLike | null | undefined): boolean {
	if (!left || !right) {
		return false;
	}
	return left.lineNumber === right.lineNumber && left.column === right.column;
}

export function __kustoAreSelectionsEqual(left: MonacoSelectionLike | null | undefined, right: MonacoSelectionLike | null | undefined): boolean {
	if (!left || !right) {
		return false;
	}
	return left.startLineNumber === right.startLineNumber
		&& left.startColumn === right.startColumn
		&& left.endLineNumber === right.endLineNumber
		&& left.endColumn === right.endColumn;
}

export function __kustoShouldRepairClickPosition(
	clickedPosition: MonacoPositionLike | null | undefined,
	currentPosition: MonacoPositionLike | null | undefined,
	selection: MonacoSelectionLike | null | undefined,
	selectionCount: number,
	selectionBefore?: MonacoSelectionLike | null,
): boolean {
	if (!clickedPosition || selectionCount > 1) {
		return false;
	}
	if (__kustoIsCollapsedSelection(selection)) {
		return !__kustoArePositionsEqual(clickedPosition, currentPosition);
	}
	return __kustoAreSelectionsEqual(selectionBefore, selection);
}

function defaultLogError(error: unknown): void {
	try { console.error('[kusto]', error); } catch { /* ignore */ }
}

function getEventPreparationKey(event: MouseEvent): string {
	return `${Math.round(event.clientX)}:${Math.round(event.clientY)}:${event.button}`;
}

function shouldSkipDuplicatePreparation(stamp: PreparationStamp | null, event: MouseEvent, now: number): boolean {
	if (!stamp) {
		return false;
	}
	return stamp.key === getEventPreparationKey(event) && now - stamp.at <= DUPLICATE_PREPARATION_WINDOW_MS;
}

function isEditorMeasurable(container: HTMLElement, wrapper: HTMLElement | null | undefined): boolean {
	try {
		if (!container.isConnected) {
			return false;
		}
		const containerRect = container.getBoundingClientRect();
		if (!containerRect || containerRect.width <= 0 || containerRect.height <= 0) {
			return false;
		}
		if (wrapper) {
			const wrapperRect = wrapper.getBoundingClientRect();
			if (!wrapperRect || wrapperRect.width <= 0 || wrapperRect.height <= 0) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function getElementAtClientPoint(clientX: number, clientY: number): Element | null {
	try {
		return document.elementFromPoint(clientX, clientY);
	} catch {
		return null;
	}
}

function getSelectionCount(editor: MonacoEditorClickLike): number {
	try {
		if (typeof editor.getSelections !== 'function') {
			return 1;
		}
		const selections = editor.getSelections();
		return Array.isArray(selections) ? selections.length : 1;
	} catch {
		return 1;
	}
}

export function __kustoInstallEditorClickFidelityGuard(options: KustoClickFidelityGuardOptions): KustoClickFidelityGuard {
	const root = options.wrapper || options.container;
	const logError = options.logError || defaultLogError;
	let disposed = false;
	let focusRequestId = 0;
	let repairSequence = 0;
	let lastPreparation: PreparationStamp | null = null;
	let pendingRepair: PendingClickRepair | null = null;

	const safeCall = (callback: () => void): void => {
		try { callback(); } catch (error) { logError(error); }
	};

	const refreshEditorGeometry = (): boolean => {
		safeCall(() => options.editor.layout?.());
		safeCall(() => options.editor.render?.(true));
		return isEditorMeasurable(options.container, options.wrapper);
	};

	const isElementInsideEditorRoot = (target: Element | null): boolean => {
		if (!target || __kustoShouldIgnoreEditorMouseTarget(target)) {
			return false;
		}
		return target === root || root.contains(target) || target === options.container || options.container.contains(target);
	};

	const recaptureRepairPosition = (repair: PendingClickRepair): MonacoPositionLike | null => {
		const target = getElementAtClientPoint(repair.clientX, repair.clientY);
		if (!isElementInsideEditorRoot(target)) {
			return null;
		}
		return __kustoGetEditorPositionAtClientPoint(options.editor, repair.clientX, repair.clientY);
	};

	const cancelPendingRepair = (): void => {
		const repair = pendingRepair;
		if (!repair) {
			return;
		}
		pendingRepair = null;
		repair.cancelled = true;
		safeCall(() => repair.cleanup());
	};

	const prepareForMouseDown = (event: MouseEvent): boolean => {
		if (disposed || __kustoShouldIgnoreEditorMouseTarget(event.target)) {
			return false;
		}
		safeCall(() => options.forceWritable());
		safeCall(() => options.setCrossClusterPointerDown(true));

		const now = Date.now();
		if (shouldSkipDuplicatePreparation(lastPreparation, event, now)) {
			return true;
		}
		lastPreparation = { key: getEventPreparationKey(event), at: now };
		refreshEditorGeometry();
		return true;
	};

	const runDeferredActivation = (): void => {
		const requestId = ++focusRequestId;
		setTimeout(() => {
			if (disposed || requestId !== focusRequestId) {
				return;
			}
			safeCall(() => options.activateEditor());
			refreshEditorGeometry();
			safeCall(() => options.scheduleSuggestClamp?.());
		}, 0);
	};

	const finishRepairAfterClick = (repair: PendingClickRepair): void => {
		if (pendingRepair !== repair || repair.settling) {
			return;
		}
		repair.settling = true;
		setTimeout(() => {
			if (pendingRepair !== repair) {
				return;
			}
			pendingRepair = null;
			safeCall(() => repair.cleanup());
			if (disposed || repair.cancelled || !refreshEditorGeometry()) {
				return;
			}

			let repairPosition = repair.position;
			if (repair.geometryDirty) {
				const recapturedPosition = recaptureRepairPosition(repair);
				if (!recapturedPosition) {
					return;
				}
				repairPosition = recapturedPosition;
			}

			safeCall(() => options.activateEditor());
			refreshEditorGeometry();
			safeCall(() => options.scheduleSuggestClamp?.());
			safeCall(() => options.editor.focus?.());

			let selection: MonacoSelectionLike | null = null;
			let currentPosition: MonacoPositionLike | null = null;
			let selectionCount = 1;
			try { selection = options.editor.getSelection?.() || null; } catch { selection = null; }
			try { currentPosition = options.editor.getPosition?.() || null; } catch { currentPosition = null; }
			selectionCount = getSelectionCount(options.editor);

			if (__kustoShouldRepairClickPosition(repairPosition, currentPosition, selection, selectionCount, repair.selectionBefore)) {
				safeCall(() => options.editor.setPosition?.(repairPosition));
			}
		}, 0);
	};

	const scheduleRepair = (event: MouseEvent, position: MonacoPositionLike): void => {
		cancelPendingRepair();
		let selectionBefore: MonacoSelectionLike | null = null;
		try { selectionBefore = options.editor.getSelection?.() || null; } catch { selectionBefore = null; }
		const repair: PendingClickRepair = {
			id: ++repairSequence,
			clientX: event.clientX,
			clientY: event.clientY,
			position,
			selectionBefore,
			geometryDirty: false,
			cancelled: false,
			settling: false,
			cleanup: () => { /* assigned below */ },
		};
		let removePageScrollListener: (() => void) | null = null;

		const cancelRepair = (): void => {
			if (pendingRepair !== repair) {
				return;
			}
			cancelPendingRepair();
		};
		const markGeometryDirty = (): void => {
			if (pendingRepair === repair) {
				repair.geometryDirty = true;
			}
		};
		const onMove = (moveEvent: MouseEvent): void => {
			if (Math.abs(moveEvent.clientX - repair.clientX) > CLICK_MOVE_CANCEL_THRESHOLD_PX || Math.abs(moveEvent.clientY - repair.clientY) > CLICK_MOVE_CANCEL_THRESHOLD_PX) {
				cancelRepair();
			}
		};
		const onMouseUp = (): void => finishRepairAfterClick(repair);
		const onClick = (): void => finishRepairAfterClick(repair);
		const onVisibilityChange = (): void => {
			if (document.visibilityState === 'hidden') {
				cancelRepair();
			}
		};

		repair.cleanup = () => {
			document.removeEventListener('mousemove', onMove, true);
			document.removeEventListener('pointermove', onMove as EventListener, true);
			document.removeEventListener('mouseup', onMouseUp, true);
			document.removeEventListener('click', onClick, true);
			document.removeEventListener('dblclick', cancelRepair, true);
			document.removeEventListener('pointercancel', cancelRepair, true);
			document.removeEventListener('scroll', markGeometryDirty, true);
			document.removeEventListener('wheel', cancelRepair, true);
			document.removeEventListener('visibilitychange', onVisibilityChange, true);
			window.removeEventListener('blur', cancelRepair, true);
			window.removeEventListener('wheel', cancelRepair, true);
			window.removeEventListener('scroll', markGeometryDirty, true);
			if (removePageScrollListener) {
				const remove = removePageScrollListener;
				removePageScrollListener = null;
				remove();
			}
		};

		pendingRepair = repair;
		document.addEventListener('mousemove', onMove, true);
		document.addEventListener('pointermove', onMove as EventListener, true);
		document.addEventListener('mouseup', onMouseUp, true);
		document.addEventListener('click', onClick, true);
		document.addEventListener('dblclick', cancelRepair, true);
		document.addEventListener('pointercancel', cancelRepair, true);
		document.addEventListener('scroll', markGeometryDirty, true);
		document.addEventListener('wheel', cancelRepair, true);
		document.addEventListener('visibilitychange', onVisibilityChange, true);
		window.addEventListener('blur', cancelRepair, true);
		window.addEventListener('wheel', cancelRepair, true);
		window.addEventListener('scroll', markGeometryDirty, true);
		try { removePageScrollListener = addPageScrollListener(markGeometryDirty, { passive: true }); } catch (error) { logError(error); }
	};

	const onPointerDown = (event: Event): void => {
		if (event instanceof MouseEvent) {
			prepareForMouseDown(event);
		}
	};

	const onMouseDown = (event: MouseEvent): void => {
		if (!prepareForMouseDown(event)) {
			return;
		}
		runDeferredActivation();

		if (!__kustoIsPlainPrimaryMouseClick(event)) {
			cancelPendingRepair();
			return;
		}
		if (!isEditorMeasurable(options.container, options.wrapper)) {
			cancelPendingRepair();
			return;
		}
		const position = __kustoGetEditorPositionAtClientPoint(options.editor, event.clientX, event.clientY);
		if (!position) {
			cancelPendingRepair();
			return;
		}
		scheduleRepair(event, position);
	};

	root.addEventListener('pointerdown', onPointerDown, true);
	root.addEventListener('mousedown', onMouseDown, true);

	return {
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			root.removeEventListener('pointerdown', onPointerDown, true);
			root.removeEventListener('mousedown', onMouseDown, true);
			cancelPendingRepair();
		},
	};
}
