import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerTutorialNotificationTriggers } from '../../../src/host/tutorials/tutorialNotificationTriggers.js';

function doc(fsPath: string, scheme = 'file'): vscode.TextDocument {
	return {
		uri: {
			scheme,
			fsPath,
			path: fsPath.replace(/\\/g, '/'),
			toString: () => `${scheme}:///${fsPath.replace(/\\/g, '/')}`,
		},
	} as any;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('registerTutorialNotificationTriggers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		(vscode.window as any).activeTextEditor = undefined;
		(vscode.window.tabGroups as any).activeTabGroup = { activeTab: undefined, tabs: [], isActive: true };
		(vscode.workspace as any).textDocuments = [];
	});

	it('checks activation once and drains pending popups for Kusto trigger documents only', async () => {
		let onOpenDocument: ((document: vscode.TextDocument) => void) | undefined;
		let onActiveEditor: ((editor: vscode.TextEditor | undefined) => void) | undefined;
		let onTabs: ((event: vscode.TabChangeEvent) => void) | undefined;
		let onTabGroups: (() => void) | undefined;
		vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockImplementation((listener: any) => {
			onOpenDocument = listener;
			return { dispose: vi.fn() } as any;
		});
		vi.spyOn(vscode.window, 'onDidChangeActiveTextEditor').mockImplementation((listener: any) => {
			onActiveEditor = listener;
			return { dispose: vi.fn() } as any;
		});
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabs').mockImplementation((listener: any) => {
			onTabs = listener;
			return { dispose: vi.fn() } as any;
		});
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabGroups').mockImplementation((listener: any) => {
			onTabGroups = listener;
			return { dispose: vi.fn() } as any;
		});
		const service = {
			checkOnActivation: vi.fn(async () => undefined),
			checkOnKustoFileOpen: vi.fn(async () => undefined),
		};
		const context = { subscriptions: [] } as any;
		(vscode.window as any).activeTextEditor = { document: doc('C:\\work\\query.kql') };

		registerTutorialNotificationTriggers(context, service);
		await flushMicrotasks();

		expect(context.subscriptions).toHaveLength(4);
		expect(service.checkOnActivation).toHaveBeenCalledOnce();
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledOnce();
		expect(service.checkOnKustoFileOpen).toHaveBeenLastCalledWith((vscode.window as any).activeTextEditor.document);

		onOpenDocument?.(doc('C:\\work\\notes.txt'));
		onActiveEditor?.({ document: doc('C:\\work\\notes.txt') } as any);
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledOnce();

		const openedNotebook = doc('C:\\work\\notebook.kqlx');
		const activeDashboard = doc('C:\\work\\dashboard.sqlx');
		onOpenDocument?.(openedNotebook);
		onActiveEditor?.({ document: activeDashboard } as any);
		const sqlDocument = doc('C:\\work\\query.sql');
		const markdownDocument = doc('C:\\work\\notes.md');
		onOpenDocument?.(sqlDocument);
		onOpenDocument?.(markdownDocument);
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledTimes(5);
		expect(service.checkOnKustoFileOpen).toHaveBeenNthCalledWith(2, openedNotebook);
		expect(service.checkOnKustoFileOpen).toHaveBeenNthCalledWith(3, activeDashboard);
		expect(service.checkOnKustoFileOpen).toHaveBeenNthCalledWith(4, sqlDocument);
		expect(service.checkOnKustoFileOpen).toHaveBeenNthCalledWith(5, markdownDocument);
		await flushMicrotasks();

		const reopenedNotebook = doc('C:\\work\\notebook.kqlx');
		(vscode.workspace as any).textDocuments = [reopenedNotebook];
		onTabs?.({
			opened: [],
			closed: [],
			changed: [{ isActive: true, input: new vscode.TabInputCustom(reopenedNotebook.uri as any, 'kusto.kqlxEditor') } as any],
		} as any);
		await flushMicrotasks();
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledTimes(6);
		expect(service.checkOnKustoFileOpen).toHaveBeenNthCalledWith(6, reopenedNotebook);

		const activeSqlTabDocument = doc('C:\\work\\active.sql');
		(vscode.workspace as any).textDocuments = [activeSqlTabDocument];
		(vscode.window.tabGroups as any).activeTabGroup = {
			activeTab: { isActive: true, input: new vscode.TabInputText(activeSqlTabDocument.uri as any) },
		};
		onTabGroups?.();
		await flushMicrotasks();
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledTimes(7);
		expect(service.checkOnKustoFileOpen).toHaveBeenNthCalledWith(7, activeSqlTabDocument);
	});

	it('drains pending popups for restored trigger text documents after activation', async () => {
		vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockReturnValue({ dispose: vi.fn() } as any);
		vi.spyOn(vscode.window, 'onDidChangeActiveTextEditor').mockReturnValue({ dispose: vi.fn() } as any);
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabs').mockReturnValue({ dispose: vi.fn() } as any);
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabGroups').mockReturnValue({ dispose: vi.fn() } as any);
		const service = {
			checkOnActivation: vi.fn(async () => undefined),
			checkOnKustoFileOpen: vi.fn(async () => undefined),
		};
		(vscode.workspace as any).textDocuments = [doc('C:\\work\\notes.txt'), doc('C:\\work\\notebook.kqlx')];

		registerTutorialNotificationTriggers({ subscriptions: [] } as any, service);
		await flushMicrotasks();

		expect(service.checkOnActivation).toHaveBeenCalledOnce();
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledOnce();
		expect(service.checkOnKustoFileOpen).toHaveBeenLastCalledWith((vscode.workspace as any).textDocuments[1]);
	});
});