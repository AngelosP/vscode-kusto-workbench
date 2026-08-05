import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import { ConnectionManagerViewerV2 } from '../../../src/host/connectionManagerViewer';
import { HostImportedCsvSaveApplicationHandler } from '../../../src/host/importedCsvSaveApplicationHandler';

const liveImportedCsvHandlers = new Set<HostImportedCsvSaveApplicationHandler>();

function resetCommandCalls(): void {
	((vscode as any).__mockCommandCalls ?? []).length = 0;
}

function createQueryEditorProviderHarness(): QueryEditorProvider & Record<string, any> {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider._panelDisposed = false;
	provider.postMessage = vi.fn().mockResolvedValue(true);
	return provider;
}

function createImportedCsvSaveHandler(): HostImportedCsvSaveApplicationHandler {
	const handler = new HostImportedCsvSaveApplicationHandler();
	liveImportedCsvHandlers.add(handler);
	return handler;
}

function createConnectionManagerViewerHarness(): ConnectionManagerViewerV2 & Record<string, any> {
	return Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
}

function expectCommandUri(command: string, expectedUri: vscode.Uri): void {
	const call = ((vscode as any).__mockCommandCalls as Array<{ command: string; args: unknown[] }>).find(entry => entry.command === command);
	expect(call).toBeTruthy();
	const actualUri = call?.args[0] as vscode.Uri;
	expect(actualUri.scheme).toBe(expectedUri.scheme);
	expect((actualUri as any).authority).toBe((expectedUri as any).authority);
	expect(actualUri.path).toBe(expectedUri.path);
	expect(actualUri.fsPath).toBe(expectedUri.fsPath);
}

describe('saved results CSV notifications', () => {
	afterEach(() => {
		for (const handler of liveImportedCsvHandlers) handler.dispose();
		liveImportedCsvHandlers.clear();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetCommandCalls();
		(vscode as any).__mockFileSystem?.clear?.();
	});

	it('declines unrelated messages synchronously', () => {
		const handler = createImportedCsvSaveHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
	});

	it('reports empty imported CSV data without opening the picker', async () => {
		const handler = createImportedCsvSaveHandler();
		const dialogSpy = vi.spyOn(vscode.window, 'showSaveDialog');
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

		await handler.handleMessage({ type: 'saveImportedCsv', csv: '  \r\n  ' });

		expect(infoSpy).toHaveBeenCalledWith('No results to save.');
		expect(dialogSpy).not.toHaveBeenCalled();
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('does nothing when the imported CSV picker is canceled', async () => {
		const handler = createImportedCsvSaveHandler();
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(undefined);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage({ type: 'saveImportedCsv', csv: 'name\nalpha' });

		expect(writeSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	it('appends the CSV extension and writes exact UTF-8 bytes locally', async () => {
		const handler = createImportedCsvSaveHandler();
		const pickedUri = vscode.Uri.file('C:/Users/test/Downloads/imported');
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/imported.csv');
		const csv = 'Name,City\nJos\u00e9,\u6771\u4eac';
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await handler.handleMessage({
			type: 'saveImportedCsv', csv, suggestedFileName: 'imported.csv',
		});

		expect(writeSpy).toHaveBeenCalledOnce();
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from(csv, 'utf8'));
	});

	it('ignores the retired uncorrelated result-byte message', async () => {
		const provider = createQueryEditorProviderHarness();
		const dialogSpy = vi.spyOn(vscode.window, 'showSaveDialog');
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await provider.handleWebviewMessage({
			type: 'saveResultsCsv', csv: 'untrusted', suggestedFileName: 'results.csv',
		} as any);
		expect(dialogSpy).not.toHaveBeenCalled();
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('offers an Open File action after query editor results are saved', async () => {
		const handler = createImportedCsvSaveHandler();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open File' as any);

		await handler.handleMessage({
			type: 'saveImportedCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'results.csv',
		});

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			`Saved results to ${savedUri.fsPath}`,
			'Open File',
			'Show in Folder',
		);
		expectCommandUri('vscode.open', savedUri);
	});

	it('offers a Show in Folder action after query editor results are saved', async () => {
		const handler = createImportedCsvSaveHandler();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Show in Folder' as any);

		await handler.handleMessage({
			type: 'saveImportedCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'results.csv',
		});

		expectCommandUri('revealFileInOS', savedUri);
	});

	it('does not report a CSV save failure when a post-save action fails', async () => {
		const handler = createImportedCsvSaveHandler();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open File' as any);
		vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValueOnce(new Error('Open failed'));
		const warningSpy = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage({
			type: 'saveImportedCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'results.csv',
		});

		expect(warningSpy).toHaveBeenCalledWith('The file was saved, but Kusto Workbench could not open it automatically.');
		expect(errorSpy).not.toHaveBeenCalledWith('Failed to save results to CSV file.');
	});

	it('does not report a CSV save failure when the saved notification cannot be shown', async () => {
		const handler = createImportedCsvSaveHandler();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockRejectedValueOnce(new Error('Notification failed'));
		const warningSpy = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage({
			type: 'saveImportedCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'results.csv',
		});

		expect(warningSpy).toHaveBeenCalledWith('The file was saved, but Kusto Workbench could not open it automatically.');
		expect(errorSpy).not.toHaveBeenCalledWith('Failed to save results to CSV file.');
	});

	it('offers the same actions after connection manager preview results are saved', async () => {
		const viewer = createConnectionManagerViewerHarness();
		const pickedUri = vscode.Uri.file('C:/Users/test/Downloads/preview');
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/preview.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open File' as any);
		const statusBarSpy = vi.spyOn(vscode.window, 'setStatusBarMessage');

		await viewer.onMessage({
			type: 'saveResultsCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'preview.csv',
		});

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			`Saved results to ${savedUri.fsPath}`,
			'Open File',
			'Show in Folder',
		);
		expectCommandUri('vscode.open', savedUri);
		expect(statusBarSpy).not.toHaveBeenCalledWith(expect.stringContaining('Results saved to'), expect.anything());
	});

	it('reports an actual connection manager CSV write failure', async () => {
		const viewer = createConnectionManagerViewerHarness();
		const pickedUri = vscode.Uri.file('C:/Users/test/Downloads/preview.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.workspace.fs, 'writeFile').mockRejectedValueOnce(new Error('Disk full'));
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

		await viewer.onMessage({
			type: 'saveResultsCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'preview.csv',
		});

		expect(errorSpy).toHaveBeenCalledWith('Failed to save results to CSV file.');
		expect(infoSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('Saved results to'),
			expect.anything(),
			expect.anything(),
		);
	});

	it('reports an actual imported CSV write failure', async () => {
		const handler = createImportedCsvSaveHandler();
		const pickedUri = vscode.Uri.file('C:/Users/test/Downloads/imported.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.workspace.fs, 'writeFile').mockRejectedValueOnce(new Error('Disk full'));
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

		await handler.handleMessage({ type: 'saveImportedCsv', csv: 'name\nalpha' });

		expect(errorSpy).toHaveBeenCalledWith('Failed to save results to CSV file.');
		expect(infoSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('Saved results to'),
			expect.anything(),
			expect.anything(),
		);
	});

	it('preserves the picked URI authority when appending the CSV extension', async () => {
		const handler = createImportedCsvSaveHandler();
		const pickedUri = vscode.Uri.parse('vscode-remote://ssh-remote+host/remote/workspace/results');
		const savedUri = pickedUri.with({ path: '/remote/workspace/results.csv' });
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open File' as any);

		await handler.handleMessage({
			type: 'saveImportedCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'results.csv',
		});

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			`Saved results to ${savedUri.fsPath}`,
			'Open File',
		);
		expectCommandUri('vscode.open', savedUri);
		expect(savedUri.toString()).toBe('vscode-remote://ssh-remote+host/remote/workspace/results.csv');
	});

	it('does not publish a picker result after disposal', async () => {
		const handler = createImportedCsvSaveHandler();
		let resolvePicker!: (uri: vscode.Uri | undefined) => void;
		vi.spyOn(vscode.window, 'showSaveDialog').mockImplementation(() => new Promise(resolve => {
			resolvePicker = resolve as (uri: vscode.Uri | undefined) => void;
		}) as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const request = handler.handleMessage({ type: 'saveImportedCsv', csv: 'name\nalpha' });
		await Promise.resolve();

		handler.dispose();
		resolvePicker(vscode.Uri.file('C:/Users/test/Downloads/imported.csv'));
		await request;

		expect(writeSpy).not.toHaveBeenCalled();
	});
});