import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { withKqlxDocumentWriteLock } from '../../../src/host/kqlxEditorProvider.js';

describe('KQLX document write lock', () => {
	it('serializes writers for the shared vscode-userdata session URI', async () => {
		const uri = vscode.Uri.parse('vscode-userdata:/profile/globalStorage/extension/session.kqlx');
		const otherUri = vscode.Uri.parse('vscode-userdata:/profile/globalStorage/extension/other-session.kqlx');
		let releaseFirst!: () => void;
		let markFirstEntered!: () => void;
		let markControlEntered!: () => void;
		const firstEntered = new Promise<void>(resolve => { markFirstEntered = resolve; });
		const controlEntered = new Promise<void>(resolve => { markControlEntered = resolve; });
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		let secondEntered = false;

		const first = withKqlxDocumentWriteLock(uri, async () => {
			markFirstEntered();
			await firstGate;
		});
		await firstEntered;
		const second = withKqlxDocumentWriteLock(uri, async () => {
			secondEntered = true;
		});
		const control = withKqlxDocumentWriteLock(otherUri, async () => {
			markControlEntered();
		});

		try {
			await controlEntered;
			expect(secondEntered).toBe(false);
		} finally {
			releaseFirst();
			await Promise.all([first, second, control]);
		}
	});
});