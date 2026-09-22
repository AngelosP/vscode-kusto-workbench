import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	hasDirtyOpenLocalFileAlias,
	localFileIdentityEquals,
	withKqlxDocumentWriteLock,
} from '../../../src/host/kqlxEditorProvider.js';

describe('KQLX document write lock', () => {
	it('compares full-width native file identities without numeric rounding', () => {
		expect(localFileIdentityEquals(
			{ realPathKey: 'file:///same', device: '9007199254740992', inode: '9007199254740994' },
			{ realPathKey: 'file:///same', device: '9007199254740993', inode: '9007199254740994' },
		)).toBe(false);
		expect(localFileIdentityEquals(
			{ realPathKey: 'file:///same', device: '9007199254740992', inode: '9007199254740994' },
			{ realPathKey: 'file:///same', device: '9007199254740992', inode: '9007199254740995' },
		)).toBe(false);
		expect(localFileIdentityEquals(
			{ realPathKey: 'file:///same', device: '7', inode: '0' },
			{ realPathKey: 'file:///same', device: '7', inode: '9' },
		)).toBe(false);
		expect(localFileIdentityEquals(
			{ realPathKey: 'file:///same', device: '7', inode: '0' },
			{ realPathKey: 'file:///same', device: '8', inode: '0' },
		)).toBe(false);
		expect(localFileIdentityEquals(
			{ realPathKey: 'file:///same', device: '7', inode: '0' },
			{ realPathKey: 'file:///same', device: '7', inode: '0' },
		)).toBe(true);
	});

	it('detects a dirty hard-link alias of the owned document', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-native-dirty-alias-'));
		const source = path.join(root, 'source.kqlx');
		const alias = path.join(root, 'alias.txt');
		try {
			fs.writeFileSync(source, '{}', 'utf8');
			fs.linkSync(source, alias);
			const owner = { uri: vscode.Uri.file(source) };
			const realPath = await fs.promises.realpath(source);
			const stat = await fs.promises.stat(realPath, { bigint: true });
			const identity = {
				realPathKey: realPath.toLowerCase(),
				device: stat.dev.toString(),
				inode: stat.ino.toString(),
			};

			await expect(hasDirtyOpenLocalFileAlias(identity, owner, [
				owner as any,
				{ uri: vscode.Uri.file(alias), isDirty: true },
			])).resolves.toBe(true);
			await expect(hasDirtyOpenLocalFileAlias(identity, owner, [
				{ uri: vscode.Uri.file(alias), isDirty: false },
			])).resolves.toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

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