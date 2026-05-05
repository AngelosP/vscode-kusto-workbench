import * as vscode from 'vscode';
import { isKustoTutorialTriggerDocument, isKustoTutorialTriggerUri } from './tutorialNotificationService';
import type { TutorialNotificationService } from './tutorialNotificationService';

type TutorialNotificationTriggerService = Pick<TutorialNotificationService, 'checkOnActivation' | 'checkOnKustoFileOpen'>;

function getTabInputUri(input: unknown): vscode.Uri | undefined {
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	return undefined;
}

export function registerTutorialNotificationTriggers(context: vscode.ExtensionContext, notificationService: TutorialNotificationTriggerService): void {
	const pendingChecksByUri = new Set<string>();

	const resolveTriggerDocument = async (uri: vscode.Uri): Promise<vscode.TextDocument | undefined> => {
		if (!isKustoTutorialTriggerUri(uri)) {
			return undefined;
		}
		const existing = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
		if (existing) {
			return existing;
		}
		try {
			return await vscode.workspace.openTextDocument(uri);
		} catch (error) {
			console.error('[Kusto Workbench] Failed to resolve Did you know trigger document:', error);
			return undefined;
		}
	};

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
		const key = doc.uri.toString();
		if (pendingChecksByUri.has(key)) {
			return;
		}
		pendingChecksByUri.add(key);
		void notificationService.checkOnKustoFileOpen(doc).catch(error => {
			console.error('[Kusto Workbench] Failed to check Did you know file-open notifications:', error);
		}).finally(() => {
			pendingChecksByUri.delete(key);
		});
	};

	const checkOnKustoTabOpen = (tab: vscode.Tab | undefined): void => {
		const uri = tab ? getTabInputUri(tab.input) : undefined;
		if (!uri || !isKustoTutorialTriggerUri(uri)) {
			return;
		}
		void resolveTriggerDocument(uri).then(checkOnKustoFileOpen);
	};

	void notificationService.checkOnActivation()
		.then(() => checkOnKustoFileOpen(findOpenTriggerDocument()))
		.catch(error => {
			console.error('[Kusto Workbench] Failed to check Did you know activation notifications:', error);
		});

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => checkOnKustoFileOpen(doc)),
		vscode.window.onDidChangeActiveTextEditor(editor => checkOnKustoFileOpen(editor?.document)),
		vscode.window.tabGroups.onDidChangeTabs(event => {
			for (const tab of event.opened) {
				checkOnKustoTabOpen(tab);
			}
			for (const tab of event.changed) {
				if (tab.isActive) {
					checkOnKustoTabOpen(tab);
				}
			}
		}),
		vscode.window.tabGroups.onDidChangeTabGroups(() => checkOnKustoTabOpen(vscode.window.tabGroups.activeTabGroup.activeTab)),
	);
}