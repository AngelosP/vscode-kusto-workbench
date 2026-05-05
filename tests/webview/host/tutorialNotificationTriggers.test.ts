import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerTutorialNotificationTriggers } from '../../../src/host/tutorials/tutorialNotificationTriggers.js';

function doc(fsPath: string, scheme = 'file'): vscode.TextDocument {
	return {
		uri: {
			scheme,
			fsPath,
			path: fsPath.replace(/\\/g, '/'),
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
		(vscode.workspace as any).textDocuments = [];
	});

	it('checks activation once and drains pending popups for Kusto trigger documents only', async () => {
		let onOpenDocument: ((document: vscode.TextDocument) => void) | undefined;
		let onActiveEditor: ((editor: vscode.TextEditor | undefined) => void) | undefined;
		vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockImplementation((listener: any) => {
			onOpenDocument = listener;
			return { dispose: vi.fn() } as any;
		});
		vi.spyOn(vscode.window, 'onDidChangeActiveTextEditor').mockImplementation((listener: any) => {
			onActiveEditor = listener;
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

		expect(context.subscriptions).toHaveLength(2);
		expect(service.checkOnActivation).toHaveBeenCalledOnce();
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledOnce();

		onOpenDocument?.(doc('C:\\work\\notes.txt'));
		onActiveEditor?.({ document: doc('C:\\work\\notes.txt') } as any);
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledOnce();

		onOpenDocument?.(doc('C:\\work\\notebook.kqlx'));
		onActiveEditor?.({ document: doc('C:\\work\\dashboard.sqlx') } as any);
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledTimes(3);
	});

	it('drains pending popups for restored trigger text documents after activation', async () => {
		vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockReturnValue({ dispose: vi.fn() } as any);
		vi.spyOn(vscode.window, 'onDidChangeActiveTextEditor').mockReturnValue({ dispose: vi.fn() } as any);
		const service = {
			checkOnActivation: vi.fn(async () => undefined),
			checkOnKustoFileOpen: vi.fn(async () => undefined),
		};
		(vscode.workspace as any).textDocuments = [doc('C:\\work\\notes.txt'), doc('C:\\work\\notebook.kqlx')];

		registerTutorialNotificationTriggers({ subscriptions: [] } as any, service);
		await flushMicrotasks();

		expect(service.checkOnActivation).toHaveBeenCalledOnce();
		expect(service.checkOnKustoFileOpen).toHaveBeenCalledOnce();
	});
});