import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
	captureTextDocumentWriteSnapshot,
	isLiveTextDocument,
	isTextDocumentWriteSnapshotCurrent,
} from '../../../src/host/textDocumentWriteOwner';

type FakeDocument = {
	uri: vscode.Uri;
	version: number;
	isClosed: boolean;
	text: string;
	getText(): string;
};

function createDocument(path: string, text = 'print 1', version = 1): FakeDocument {
	return {
		uri: vscode.Uri.file(path),
		version,
		isClosed: false,
		text,
		getText() {
			return this.text;
		},
	};
}

function asDocument(document: FakeDocument): vscode.TextDocument {
	return document as unknown as vscode.TextDocument;
}

function asDocuments(...documents: FakeDocument[]): vscode.TextDocument[] {
	return documents.map(asDocument);
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

afterEach(() => {
	Object.defineProperty(process, 'platform', originalPlatform);
	(vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [];
});

describe('textDocumentWriteOwner', () => {
	it('accepts a live current document and snapshot', () => {
		const document = createDocument('/work/query.kql');
		const documents = asDocuments(createDocument('/work/other.kql'), document);

		expect(isLiveTextDocument(asDocument(document), documents)).toBe(true);
		const snapshot = captureTextDocumentWriteSnapshot(asDocument(document), documents);
		expect(snapshot).toEqual({ document, version: 1, text: 'print 1' });
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(isTextDocumentWriteSnapshotCurrent(snapshot!, documents)).toBe(true);
	});

	it('uses vscode.workspace.textDocuments by default', () => {
		const document = createDocument('/work/query.kql');
		(vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [document];

		const snapshot = captureTextDocumentWriteSnapshot(asDocument(document));
		expect(snapshot).toBeDefined();
		expect(isTextDocumentWriteSnapshotCurrent(snapshot!)).toBe(true);

		(vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [];
		expect(isLiveTextDocument(asDocument(document))).toBe(false);
		expect(isTextDocumentWriteSnapshotCurrent(snapshot!)).toBe(false);
	});

	it('rejects a closed document even when it remains in the document array', () => {
		const document = createDocument('/work/query.kql');
		const documents = asDocuments(document);
		const snapshot = captureTextDocumentWriteSnapshot(asDocument(document), documents)!;

		document.isClosed = true;

		expect(isLiveTextDocument(asDocument(document), documents)).toBe(false);
		expect(captureTextDocumentWriteSnapshot(asDocument(document), documents)).toBeUndefined();
		expect(isTextDocumentWriteSnapshotCurrent(snapshot, documents)).toBe(false);
	});

	it('rejects a same-URI successor with identical text and version', () => {
		const original = createDocument('/work/query.kql');
		const successor = createDocument('/work/query.kql');
		const snapshot = captureTextDocumentWriteSnapshot(asDocument(original), asDocuments(original))!;

		expect(isLiveTextDocument(asDocument(original), asDocuments(successor))).toBe(false);
		expect(captureTextDocumentWriteSnapshot(asDocument(original), asDocuments(successor))).toBeUndefined();
		expect(isTextDocumentWriteSnapshotCurrent(snapshot, asDocuments(successor))).toBe(false);
	});

	it('rejects duplicate same-URI entries even when the original is present', () => {
		const original = createDocument('/work/query.kql');
		const duplicate = createDocument('/work/query.kql');

		expect(isLiveTextDocument(asDocument(original), asDocuments(original, duplicate))).toBe(false);
		expect(isLiveTextDocument(asDocument(original), asDocuments(duplicate, original))).toBe(false);
		expect(isLiveTextDocument(asDocument(original), asDocuments(original, original))).toBe(false);
		expect(captureTextDocumentWriteSnapshot(asDocument(original), asDocuments(original, duplicate))).toBeUndefined();
	});

	it('rejects a missing original document', () => {
		const document = createDocument('/work/query.kql');
		const documents = asDocuments(createDocument('/work/other.kql'));

		expect(isLiveTextDocument(asDocument(document), documents)).toBe(false);
		expect(isLiveTextDocument(asDocument(document), [])).toBe(false);
		expect(captureTextDocumentWriteSnapshot(asDocument(document), documents)).toBeUndefined();
	});

	it('marks snapshots stale after version or source changes', () => {
		const document = createDocument('/work/query.kql');
		const documents = asDocuments(document);
		const snapshot = captureTextDocumentWriteSnapshot(asDocument(document), documents)!;

		document.version = 2;
		expect(isTextDocumentWriteSnapshotCurrent(snapshot, documents)).toBe(false);

		document.version = 1;
		document.text = 'print 2';
		expect(isTextDocumentWriteSnapshotCurrent(snapshot, documents)).toBe(false);

		document.text = 'print 1';
		expect(isTextDocumentWriteSnapshotCurrent(snapshot, documents)).toBe(true);
	});

	it('does not mutate or rebase snapshots', () => {
		const document = createDocument('/work/query.kql');
		const documents = asDocuments(document);
		const snapshot = captureTextDocumentWriteSnapshot(asDocument(document), documents)!;

		document.version = 3;
		document.text = 'print 3';
		expect(isTextDocumentWriteSnapshotCurrent(snapshot, documents)).toBe(false);
		expect(snapshot).toEqual({ document, version: 1, text: 'print 1' });
		expect(() => {
			(snapshot as { version: number }).version = 3;
		}).toThrow(TypeError);

		const nextSnapshot = captureTextDocumentWriteSnapshot(asDocument(document), documents)!;
		expect(nextSnapshot).not.toBe(snapshot);
		expect(nextSnapshot).toEqual({ document, version: 3, text: 'print 3' });
		expect(snapshot.version).toBe(1);
		expect(snapshot.text).toBe('print 1');
	});

	it('rejects a snapshot when the version changes during text capture', () => {
		const document = createDocument('/work/query.kql');
		document.getText = function () {
			this.version += 1;
			return this.text;
		};

		expect(captureTextDocumentWriteSnapshot(asDocument(document), asDocuments(document))).toBeUndefined();
	});

	it('treats Windows case and separator variants as the same URI', () => {
		Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
		const original = createDocument('C:\\Work\\Query.kql');
		const successor = createDocument('c:/work/query.kql');

		expect(isLiveTextDocument(asDocument(original), asDocuments(original))).toBe(true);
		expect(isLiveTextDocument(asDocument(original), asDocuments(successor))).toBe(false);
		expect(isLiveTextDocument(asDocument(original), asDocuments(original, successor))).toBe(false);
	});
});
