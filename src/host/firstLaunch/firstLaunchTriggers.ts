import * as vscode from 'vscode';
import { classifyWorkbenchUri } from '../workbenchFileTypes';
import type { FirstLaunchCoordinator } from './firstLaunchCoordinator';

type TriggerCoordinator = Pick<FirstLaunchCoordinator, 'triggerAutomatic'>;
export const FIRST_LAUNCH_FILE_TRIGGER_DELAY_MS = 75;

function tabInputUri(input: unknown): vscode.Uri | undefined {
	if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
		return input.uri;
	}
	return undefined;
}

function diffUriKeys(): Set<string> {
	const keys = new Set<string>();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (tab.input instanceof vscode.TabInputTextDiff) {
				keys.add(tab.input.original.toString());
				keys.add(tab.input.modified.toString());
			}
		}
	}
	return keys;
}

export function isFirstLaunchTriggerUri(uri: vscode.Uri, diffKeys: ReadonlySet<string> = diffUriKeys()): boolean {
	if (uri.scheme !== 'file' && uri.scheme !== 'vscode-userdata') {
		return false;
	}
	if (diffKeys.has(uri.toString())) {
		return false;
	}
	const info = classifyWorkbenchUri(uri, { includeOptionalPlainText: true });
	return !!info && !info.isSidecar;
}

export function registerFirstLaunchTriggers(context: vscode.ExtensionContext, coordinator: TriggerCoordinator): void {
	const inFlightUris = new Set<string>();
	const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const cancelPendingDiffUris = (): void => {
		const keys = diffUriKeys();
		for (const key of keys) {
			const timer = pendingTimers.get(key);
			if (timer) {
				clearTimeout(timer);
				pendingTimers.delete(key);
			}
		}
	};

	const scheduleUri = (uri: vscode.Uri | undefined): void => {
		if (!uri) {
			return;
		}
		const key = uri.toString();
		if (pendingTimers.has(key) || inFlightUris.has(key)) {
			return;
		}
		const timer = setTimeout(() => {
			pendingTimers.delete(key);
			if (!isFirstLaunchTriggerUri(uri)) {
				return;
			}
			inFlightUris.add(key);
			void coordinator.triggerAutomatic('file').finally(() => inFlightUris.delete(key));
		}, FIRST_LAUNCH_FILE_TRIGGER_DELAY_MS);
		pendingTimers.set(key, timer);
	};

	const triggerDocument = (document: vscode.TextDocument | undefined): void => scheduleUri(document?.uri);
	const triggerTab = (tab: vscode.Tab | undefined): void => scheduleUri(tab ? tabInputUri(tab.input) : undefined);

	context.subscriptions.push(
		{
			dispose: () => {
				for (const timer of pendingTimers.values()) clearTimeout(timer);
				pendingTimers.clear();
			},
		},
		vscode.workspace.onDidOpenTextDocument(triggerDocument),
		vscode.window.onDidChangeActiveTextEditor(editor => triggerDocument(editor?.document)),
		vscode.window.tabGroups.onDidChangeTabs(event => {
			cancelPendingDiffUris();
			for (const tab of event.opened) triggerTab(tab);
			for (const tab of event.changed) {
				if (tab.isActive) triggerTab(tab);
			}
		}),
		vscode.window.tabGroups.onDidChangeTabGroups(() => {
			cancelPendingDiffUris();
			triggerTab(vscode.window.tabGroups.activeTabGroup.activeTab);
		}),
	);

	// Scan only after listeners are installed so an open event cannot be lost between setup and discovery.
	triggerDocument(vscode.window.activeTextEditor?.document);
	triggerTab(vscode.window.tabGroups.activeTabGroup.activeTab);
	for (const document of vscode.workspace.textDocuments) {
		triggerDocument(document);
	}
}