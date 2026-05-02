import * as vscode from 'vscode';

export type EditorCursorStatusEditorKind = 'kusto' | 'sql' | 'html' | 'python' | 'markdown';

export interface EditorCursorStatusPayload {
	line?: unknown;
	column?: unknown;
	visible?: boolean;
	boxId?: string;
	editorKind?: EditorCursorStatusEditorKind;
	reason?: string;
}

export interface EditorCursorStatusSnapshot {
	visible: boolean;
	text: string;
	ownerId?: string;
	line?: number;
	column?: number;
	boxId?: string;
	editorKind?: EditorCursorStatusEditorKind;
}

const STATUS_BAR_ITEM_ID = 'kustoWorkbench.cursorPosition';

function toPositiveInteger(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	const integer = Math.floor(value);
	return integer > 0 ? integer : undefined;
}

export class EditorCursorStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private snapshot: EditorCursorStatusSnapshot = { visible: false, text: '' };

	constructor() {
		this.item = vscode.window.createStatusBarItem(STATUS_BAR_ITEM_ID, vscode.StatusBarAlignment.Right, 1000);
		this.item.name = 'Kusto Workbench Cursor Position';
		this.item.tooltip = 'Kusto Workbench editor cursor position';
		this.item.accessibilityInformation = {
			label: 'Kusto Workbench editor cursor position',
			role: 'status'
		};
	}

	update(ownerId: string, payload: EditorCursorStatusPayload): void {
		if (payload.visible === false) {
			this.clear(ownerId);
			return;
		}

		const line = toPositiveInteger(payload.line);
		const column = toPositiveInteger(payload.column);
		if (line === undefined || column === undefined) {
			this.clear(ownerId);
			return;
		}

		const text = `Ln ${line}, Col ${column}`;
		this.item.text = text;
		this.item.show();
		this.snapshot = {
			visible: true,
			text,
			ownerId,
			line,
			column,
			boxId: payload.boxId,
			editorKind: payload.editorKind
		};
	}

	clear(ownerId: string): void {
		if (this.snapshot.ownerId && this.snapshot.ownerId !== ownerId) {
			return;
		}
		this.hide();
	}

	clearOwnerPrefix(ownerPrefix: string): void {
		if (this.snapshot.ownerId && !this.snapshot.ownerId.startsWith(ownerPrefix)) {
			return;
		}
		this.hide();
	}

	getSnapshot(): EditorCursorStatusSnapshot {
		return { ...this.snapshot };
	}

	dispose(): void {
		this.hide();
		this.item.dispose();
	}

	private hide(): void {
		this.item.hide();
		this.snapshot = { visible: false, text: '' };
	}
}
