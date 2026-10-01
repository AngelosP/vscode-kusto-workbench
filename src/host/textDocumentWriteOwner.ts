import * as vscode from 'vscode';
import { normalizeWorkbenchUriKey } from './workbenchFileTypes';

export type TextDocumentWriteSnapshot = Readonly<{
	document: vscode.TextDocument;
	version: number;
	text: string;
}>;

export function isLiveTextDocument(
	document: vscode.TextDocument,
	documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments,
): boolean {
	if (document.isClosed) {
		return false;
	}
	const key = normalizeWorkbenchUriKey(document.uri);
	let found = false;
	for (const candidate of documents) {
		if (normalizeWorkbenchUriKey(candidate.uri) !== key) {
			continue;
		}
		if (candidate !== document || found) {
			return false;
		}
		found = true;
	}
	return found;
}

export function captureTextDocumentWriteSnapshot(
	document: vscode.TextDocument,
	documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments,
): TextDocumentWriteSnapshot | undefined {
	if (!isLiveTextDocument(document, documents)) {
		return undefined;
	}
	const version = document.version;
	const text = document.getText();
	if (document.version !== version || !isLiveTextDocument(document, documents)) {
		return undefined;
	}
	return Object.freeze({ document, version, text });
}

export function isTextDocumentWriteSnapshotCurrent(
	snapshot: TextDocumentWriteSnapshot,
	documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments,
): boolean {
	const { document } = snapshot;
	return isLiveTextDocument(document, documents)
		&& document.version === snapshot.version
		&& document.getText() === snapshot.text;
}
