import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	FIRST_LAUNCH_FILE_TRIGGER_DELAY_MS,
	isFirstLaunchTriggerUri,
	registerFirstLaunchTriggers,
} from '../../../src/host/firstLaunch/firstLaunchTriggers.js';

function document(path: string, scheme = 'file'): vscode.TextDocument {
	const uri = scheme === 'file' ? vscode.Uri.file(path) : vscode.Uri.parse(`${scheme}:${path}`);
	return { uri } as any;
}

describe('first-launch file triggers', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		(vscode.workspace as any).textDocuments = [];
		(vscode.window as any).activeTextEditor = undefined;
		(vscode.window.tabGroups as any).all = [];
		(vscode.window.tabGroups as any).activeTabGroup = { activeTab: undefined, tabs: [], isActive: true };
	});

	it('accepts all primary formats and rejects sidecars and unrelated schemes', () => {
		for (const extension of ['kqlx', 'mdx', 'sqlx', 'kql', 'csl', 'md', 'sql']) {
			expect(isFirstLaunchTriggerUri(vscode.Uri.file(`C:\\work\\sample.${extension}`), new Set())).toBe(true);
		}
		expect(isFirstLaunchTriggerUri(vscode.Uri.file('C:\\work\\sample.kql.json'), new Set())).toBe(false);
		expect(isFirstLaunchTriggerUri(vscode.Uri.parse('git:/work/sample.kql'), new Set())).toBe(false);
		expect(isFirstLaunchTriggerUri(vscode.Uri.parse('untitled:/sample.sql'), new Set())).toBe(false);
	});

	it('rejects both sides of a diff even when the modified URI uses the file scheme', () => {
		const original = vscode.Uri.parse('git:/work/query.kql');
		const modified = vscode.Uri.file('C:\\work\\query.kql');
		const diff = new vscode.TabInputTextDiff(original, modified);
		(vscode.window.tabGroups as any).all = [{ tabs: [{ input: diff }] }];

		expect(isFirstLaunchTriggerUri(original)).toBe(false);
		expect(isFirstLaunchTriggerUri(modified)).toBe(false);
	});

	it('installs listeners before scanning restored documents and coalesces duplicate URI events', async () => {
		vi.useFakeTimers();
		let onOpen: ((doc: vscode.TextDocument) => void) | undefined;
		const order: string[] = [];
		vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockImplementation((listener: any) => {
			order.push('listener');
			onOpen = listener;
			return { dispose: vi.fn() } as any;
		});
		vi.spyOn(vscode.window, 'onDidChangeActiveTextEditor').mockReturnValue({ dispose: vi.fn() } as any);
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabs').mockReturnValue({ dispose: vi.fn() } as any);
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabGroups').mockReturnValue({ dispose: vi.fn() } as any);
		const restored = document('C:\\work\\query.sqlx');
		(vscode.workspace as any).textDocuments = [restored];
		let resolveTrigger!: () => void;
		const triggerAutomatic = vi.fn(() => {
			order.push('trigger');
			return new Promise<'completed'>(resolve => { resolveTrigger = () => resolve('completed'); });
		});

		registerFirstLaunchTriggers({ subscriptions: [] } as any, { triggerAutomatic } as any);
		onOpen?.(restored);

		expect(order[0]).toBe('listener');
		await vi.advanceTimersByTimeAsync(FIRST_LAUNCH_FILE_TRIGGER_DELAY_MS);
		expect(triggerAutomatic).toHaveBeenCalledOnce();
		resolveTrigger();
		await Promise.resolve();
	});

	it('cancels a document trigger when the URI becomes the modified side of a diff', async () => {
		vi.useFakeTimers();
		let onOpen: ((doc: vscode.TextDocument) => void) | undefined;
		let onTabs: ((event: vscode.TabChangeEvent) => void) | undefined;
		vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockImplementation((listener: any) => {
			onOpen = listener;
			return { dispose: vi.fn() } as any;
		});
		vi.spyOn(vscode.window, 'onDidChangeActiveTextEditor').mockReturnValue({ dispose: vi.fn() } as any);
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabs').mockImplementation((listener: any) => {
			onTabs = listener;
			return { dispose: vi.fn() } as any;
		});
		vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabGroups').mockReturnValue({ dispose: vi.fn() } as any);
		const triggerAutomatic = vi.fn(async () => 'completed' as const);
		registerFirstLaunchTriggers({ subscriptions: [] } as any, { triggerAutomatic } as any);

		const modified = vscode.Uri.file('C:\\work\\query.kql');
		onOpen?.({ uri: modified } as any);
		const diffTab = { input: new vscode.TabInputTextDiff(vscode.Uri.parse('git:/work/query.kql'), modified), isActive: true } as any;
		(vscode.window.tabGroups as any).all = [{ tabs: [diffTab] }];
		onTabs?.({ opened: [diffTab], changed: [], closed: [] } as any);
		await vi.advanceTimersByTimeAsync(FIRST_LAUNCH_FILE_TRIGGER_DELAY_MS);

		expect(triggerAutomatic).not.toHaveBeenCalled();
	});
});