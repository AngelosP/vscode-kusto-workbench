import * as vscode from 'vscode';

const OPEN_FILE_ACTION = 'Open File';
const SHOW_IN_FOLDER_ACTION = 'Show in Folder';

export async function notifySavedFile(uri: vscode.Uri, message: string): Promise<void> {
	try {
		const actions = uri.scheme === 'file'
			? [OPEN_FILE_ACTION, SHOW_IN_FOLDER_ACTION]
			: [OPEN_FILE_ACTION];
		const action = await vscode.window.showInformationMessage(message, ...actions);
		if (action === OPEN_FILE_ACTION) {
			await vscode.commands.executeCommand('vscode.open', uri);
		} else if (action === SHOW_IN_FOLDER_ACTION) {
			await vscode.commands.executeCommand('revealFileInOS', uri);
		}
	} catch {
		try {
			await vscode.window.showWarningMessage('The file was saved, but Kusto Workbench could not open it automatically.');
		} catch {
			// ignore
		}
	}
}

export function withCsvExtension(uri: vscode.Uri): vscode.Uri {
	const pathToCheck = uri.path || uri.fsPath;
	if (pathToCheck.toLowerCase().endsWith('.csv')) {
		return uri;
	}
	if (uri.path) {
		return uri.with({ path: uri.path + '.csv' });
	}
	return vscode.Uri.file(uri.fsPath + '.csv');
}