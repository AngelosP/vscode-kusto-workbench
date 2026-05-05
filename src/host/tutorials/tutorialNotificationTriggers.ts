import * as vscode from 'vscode';
import { isKustoTutorialTriggerDocument } from './tutorialNotificationService';
import type { TutorialNotificationService } from './tutorialNotificationService';

type TutorialNotificationTriggerService = Pick<TutorialNotificationService, 'checkOnActivation' | 'checkOnKustoFileOpen'>;

export function registerTutorialNotificationTriggers(context: vscode.ExtensionContext, notificationService: TutorialNotificationTriggerService): void {
	const findOpenTriggerDocument = (): vscode.TextDocument | undefined => {
		const activeDocument = vscode.window.activeTextEditor?.document;
		if (activeDocument && isKustoTutorialTriggerDocument(activeDocument)) {
			return activeDocument;
		}
		return vscode.workspace.textDocuments.find(isKustoTutorialTriggerDocument);
	};

	const checkOnKustoFileOpen = (doc: vscode.TextDocument | undefined): void => {
		if (!doc || !isKustoTutorialTriggerDocument(doc)) {
			return;
		}
		void notificationService.checkOnKustoFileOpen().catch(error => {
			console.error('[Kusto Workbench] Failed to check Did you know file-open notifications:', error);
		});
	};

	void notificationService.checkOnActivation()
		.then(() => checkOnKustoFileOpen(findOpenTriggerDocument()))
		.catch(error => {
			console.error('[Kusto Workbench] Failed to check Did you know activation notifications:', error);
		});

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => checkOnKustoFileOpen(doc)),
		vscode.window.onDidChangeActiveTextEditor(editor => checkOnKustoFileOpen(editor?.document)),
	);
}