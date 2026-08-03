import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { closeQueryEditorSessionTabs, revealOrOpenQueryEditorSession } from '../../../src/host/extension';
import { KqlxEditorProvider } from '../../../src/host/kqlxEditorProvider';

function createPanel() {
	let disposeListener: (() => void) | undefined;
	const panel = {
		reveal: vi.fn(),
		onDidDispose: vi.fn((listener: () => void) => {
			disposeListener = listener;
			return { dispose: vi.fn() };
		}),
	};
	return { panel, dispose: () => disposeListener?.() };
}

afterEach(() => {
	vi.restoreAllMocks();
	(vscode.window.tabGroups.all as unknown as any[]).splice(0);
	(vscode.window.tabGroups.activeTabGroup as any).activeTab = undefined;
	(vscode.window.tabGroups.activeTabGroup as any).tabs = [];
	(vscode as any).__mockCommandCalls.splice(0);
});

describe('revealOrOpenQueryEditorSession', () => {
	it('keeps the active session editor instead of opening a duplicate', async () => {
		const sessionUri = vscode.Uri.file('C:/profile/session.kqlx');
		const tracked = createPanel();
		const registration = KqlxEditorProvider.trackOpenEditor(sessionUri, tracked.panel as any);
		const tab = { input: new vscode.TabInputCustom(sessionUri, 'kusto.kqlxEditor') };
		(vscode.window.tabGroups.activeTabGroup as any).activeTab = tab;
		(vscode.window.tabGroups.activeTabGroup as any).tabs = [tab];
		(vscode.window.tabGroups.all as unknown as any[]).push(vscode.window.tabGroups.activeTabGroup);

		await revealOrOpenQueryEditorSession(vscode.Uri.file('c:/profile/session.kqlx'));

		expect(tracked.panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.One, false);
		expect((vscode as any).__mockCommandCalls).toEqual([]);
		registration.dispose();
	});

	it('reveals a background session panel without reopening it', async () => {
		const sessionUri = vscode.Uri.file('C:/profile/session.kqlx');
		const tracked = createPanel();
		const registration = KqlxEditorProvider.trackOpenEditor(sessionUri, tracked.panel as any);
		const existingTab = { input: new vscode.TabInputCustom(sessionUri, 'kusto.kqlxEditor') };
		const group = { viewColumn: vscode.ViewColumn.One, tabs: [existingTab] };
		(vscode.window.tabGroups.all as unknown as any[]).push(group);

		await revealOrOpenQueryEditorSession(sessionUri);

		expect(group.tabs).toEqual([existingTab]);
		expect(tracked.panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.One, false);
		expect((vscode as any).__mockCommandCalls).toEqual([]);
		registration.dispose();
	});

	it('opens a new custom editor only when the session is not already open', async () => {
		const sessionUri = vscode.Uri.file('C:/profile/session.kqlx');

		await revealOrOpenQueryEditorSession(sessionUri);

		expect((vscode as any).__mockCommandCalls).toEqual([
			expect.objectContaining({ command: 'vscode.openWith' }),
		]);
	});

	it('waits for a closing session editor before opening its replacement', async () => {
		const sessionUri = vscode.Uri.file('C:/profile/session.kqlx');
		const tracked = createPanel();
		const registration = KqlxEditorProvider.trackOpenEditor(sessionUri, tracked.panel as any);
		registration.beginClosing();
		let settled = false;
		const reopening = revealOrOpenQueryEditorSession(sessionUri).then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		expect((vscode as any).__mockCommandCalls).toEqual([]);

		registration.finishClosing();
		await reopening;
		expect((vscode as any).__mockCommandCalls).toEqual([
			expect.objectContaining({ command: 'vscode.openWith' }),
		]);
	});
});

describe('closeQueryEditorSessionTabs', () => {
	it('waits for close finalization after the panel becomes unrevealable', async () => {
		const sessionUri = vscode.Uri.file('C:/profile/session.kqlx');
		const tracked = createPanel();
		const registration = KqlxEditorProvider.trackOpenEditor(sessionUri, tracked.panel as any);

		registration.beginClosing();
		await expect(KqlxEditorProvider.revealOpenEditorWhenReady(sessionUri, vscode.ViewColumn.One)).resolves.toBe(false);
		let settled = false;
		const closed = KqlxEditorProvider.waitForOpenEditorsClosed(sessionUri, 1_000).then(result => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		registration.finishClosing();
		await expect(closed).resolves.toBe(true);
	});

	it('closes only the extension-owned session tabs', async () => {
		const sessionUri = vscode.Uri.file('C:/profile/session.kqlx');
		const tracked = createPanel();
		const registration = KqlxEditorProvider.trackOpenEditor(sessionUri, tracked.panel as any);
		const sessionTab = { input: new vscode.TabInputCustom(sessionUri, 'kusto.kqlxEditor') };
		const otherTab = { input: new vscode.TabInputCustom(vscode.Uri.file('C:/work/report.kqlx'), 'kusto.kqlxEditor') };
		const group = { tabs: [sessionTab, otherTab] };
		(vscode.window.tabGroups.all as unknown as any[]).push(group);
		vi.spyOn(vscode.window.tabGroups, 'close').mockImplementation(async tabs => {
			const closed = new Set(Array.isArray(tabs) ? tabs : [tabs]);
			group.tabs = group.tabs.filter(tab => !closed.has(tab));
			registration.dispose();
			return true;
		});

		await closeQueryEditorSessionTabs(sessionUri);

		expect(group.tabs).toEqual([otherTab]);
	});
});