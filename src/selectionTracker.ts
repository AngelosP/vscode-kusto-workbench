import * as vscode from 'vscode';

const lastSelectionByUri = new Map<string, vscode.Range>();

const selectionEmitter = new vscode.EventEmitter<{ uri: string; range: vscode.Range }>();
export const onDidRecordSelection = selectionEmitter.event;

export const recordTextEditorSelection = (editor: vscode.TextEditor): void => {
	try {
		const uri = editor?.document?.uri?.toString();
		if (!uri) {
			return;
		}
		const sel = Array.isArray(editor.selections) && editor.selections.length ? editor.selections[0] : editor.selection;
		if (!sel) {
			return;
		}
		const next = new vscode.Range(sel.start, sel.end);
		const prev = lastSelectionByUri.get(uri);
		if (prev && prev.isEqual(next)) {
			return;
		}
		lastSelectionByUri.set(uri, next);
		try {
			selectionEmitter.fire({ uri, range: next });
		} catch {
			// ignore
		}
	} catch {
		// ignore
	}
};

export const getLastSelectionForUri = (uri: vscode.Uri): vscode.Range | undefined => {
	try {
		return lastSelectionByUri.get(uri.toString());
	} catch {
		return undefined;
	}
};
