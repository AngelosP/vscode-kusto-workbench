import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

let nextTargetUri: vscode.Uri | undefined;

export function setNextDevelopmentCsvSaveTarget(target: string): vscode.Uri {
	const value = String(target || '').trim();
	if (!value) throw new Error('A CSV save target is required.');
	if (!path.isAbsolute(value) && (value === '.' || value === '..' || path.basename(value) !== value)) {
		throw new Error('The CSV save target must be an absolute path or a file name.');
	}
	const targetPath = path.isAbsolute(value)
		? value
		: path.join(process.env.TEMP || process.env.TMP || os.tmpdir(), value);
	nextTargetUri = vscode.Uri.file(targetPath);
	return nextTargetUri;
}

export function clearNextDevelopmentCsvSaveTarget(): void {
	nextTargetUri = undefined;
}

export function showCsvSaveDialogWithDevelopmentTarget(
	options: vscode.SaveDialogOptions,
): Thenable<vscode.Uri | undefined> {
	const targetUri = nextTargetUri;
	if (!targetUri) return vscode.window.showSaveDialog(options);
	nextTargetUri = undefined;
	return Promise.resolve(targetUri);
}