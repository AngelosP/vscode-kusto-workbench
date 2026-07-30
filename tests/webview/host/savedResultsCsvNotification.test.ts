import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import { ConnectionManagerViewerV2 } from '../../../src/host/connectionManagerViewer';

function resetCommandCalls(): void {
	((vscode as any).__mockCommandCalls ?? []).length = 0;
}

function createQueryEditorProviderHarness(): QueryEditorProvider & Record<string, any> {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.pendingArtifactCsvIntentIds = new Set<string>();
	provider.pendingArtifactCsvSaves = new Map<string, unknown>();
	provider.completedArtifactCsvIntentIds = new Map<string, unknown>();
	provider._panelDisposed = false;
	provider.postMessage = vi.fn().mockResolvedValue(true);
	return provider;
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
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetCommandCalls();
		(vscode as any).__mockFileSystem?.clear?.();
	});

	it('writes governed results only after the matching host nonce response', async () => {
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1',
			artifactId: 'artifact-1', suggestedFileName: 'results.csv',
		});
		expect(writeSpy).not.toHaveBeenCalled();
		const challenge = vi.mocked(provider.postMessage).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'requestArtifactCsvSaveData');
		expect(challenge).toMatchObject({
			type: 'requestArtifactCsvSaveData', exportId: 'export-1', boxId: 'query-1', artifactId: 'artifact-1',
		});
		expect(challenge.requestId).not.toBe('export-1');

		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId, boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true, csv: 'name,count\nalpha,1',
		});
		expect(writeSpy).toHaveBeenCalledOnce();
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('name,count\nalpha,1', 'utf8'));
	});

	it('ignores replayed export intents while active and after settlement', async () => {
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const intent = {
			type: 'requestArtifactCsvSave' as const, requestId: 'export-replay',
			boxId: 'query-1', artifactId: 'artifact-1',
		};
		await provider.handleWebviewMessage(intent);
		await provider.handleWebviewMessage(intent);
		const challenges = vi.mocked(provider.postMessage).mock.calls
			.map(call => call[0] as any)
			.filter(message => message.type === 'requestArtifactCsvSaveData');
		expect(challenges).toHaveLength(1);
		expect(vscode.window.showSaveDialog).toHaveBeenCalledOnce();

		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challenges[0].requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'once',
		});
		await provider.handleWebviewMessage(intent);
		expect(vscode.window.showSaveDialog).toHaveBeenCalledOnce();
	});

	it('bounds active and completed export intent ledgers', async () => {
		vi.useFakeTimers();
		const provider = createQueryEditorProviderHarness();
		const pickerResolvers: Array<(uri: vscode.Uri | undefined) => void> = [];
		vi.spyOn(vscode.window, 'showSaveDialog').mockImplementation(() => new Promise(resolve => {
			pickerResolvers.push(resolve as (uri: vscode.Uri | undefined) => void);
		}) as any);
		const requests = Array.from({ length: 9 }, (_value, index) => provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: `active-${index}`,
			boxId: `query-${index}`, artifactId: `artifact-${index}`,
		}));
		await vi.waitFor(() => expect(pickerResolvers).toHaveLength(8));
		expect(vscode.window.showSaveDialog).toHaveBeenCalledTimes(8);
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSave', exportId: 'active-8',
		});
		for (const resolve of pickerResolvers) resolve(undefined);
		await Promise.all(requests);

		for (let index = 0; index < 300; index++) provider.completeArtifactCsvIntent(`completed-${index}`);
		expect(provider.completedArtifactCsvIntentIds.size).toBe(256);
	});

	it('ignores mismatched and replayed artifact CSV responses', async () => {
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-2', boxId: 'query-2', artifactId: 'artifact-2',
		});
		const challenge = vi.mocked(provider.postMessage).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'requestArtifactCsvSaveData');

		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId, boxId: 'query-2',
			artifactId: 'wrong-artifact', accepted: true, csv: 'wrong',
		});
		expect(writeSpy).not.toHaveBeenCalled();
		expect(provider.pendingArtifactCsvSaves.size).toBe(1);
		const valid = {
			type: 'artifactCsvSaveData' as const, requestId: challenge.requestId, boxId: 'query-2',
			artifactId: 'artifact-2', accepted: true, csv: 'correct',
		};
		await provider.handleWebviewMessage(valid);
		await provider.handleWebviewMessage({ ...valid, csv: 'replay' });
		expect(writeSpy).toHaveBeenCalledOnce();
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('correct', 'utf8'));
	});

	it('keeps concurrent exports correlated when responses complete in reverse order', async () => {
		const provider = createQueryEditorProviderHarness();
		const uriA = vscode.Uri.file('C:/Users/test/Downloads/a.csv');
		const uriB = vscode.Uri.file('C:/Users/test/Downloads/b.csv');
		vi.spyOn(vscode.window, 'showSaveDialog')
			.mockResolvedValueOnce(uriA as any)
			.mockResolvedValueOnce(uriB as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-a', boxId: 'query-a', artifactId: 'artifact-a',
		});
		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-b', boxId: 'query-b', artifactId: 'artifact-b',
		});
		const challenges = vi.mocked(provider.postMessage).mock.calls
			.map(call => call[0] as any)
			.filter(message => message.type === 'requestArtifactCsvSaveData');
		const challengeA = challenges.find(message => message.exportId === 'export-a');
		const challengeB = challenges.find(message => message.exportId === 'export-b');

		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challengeB.requestId,
			boxId: 'query-b', artifactId: 'artifact-b', accepted: true, csv: 'B',
		});
		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challengeA.requestId,
			boxId: 'query-a', artifactId: 'artifact-a', accepted: true, csv: 'A',
		});
		expect(writeSpy).toHaveBeenCalledWith(uriA, Buffer.from('A', 'utf8'));
		expect(writeSpy).toHaveBeenCalledWith(uriB, Buffer.from('B', 'utf8'));
	});

	it('cancels the webview projection when the picker is dismissed', async () => {
		const provider = createQueryEditorProviderHarness();
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(undefined);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-cancel', boxId: 'query-1', artifactId: 'artifact-1',
		});
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSave', exportId: 'export-cancel',
		});
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('abandons an intent revoked while the native picker is open', async () => {
		const provider = createQueryEditorProviderHarness();
		let resolvePicker!: (uri: vscode.Uri | undefined) => void;
		const picker = new Promise<vscode.Uri | undefined>(resolve => { resolvePicker = resolve; });
		vi.spyOn(vscode.window, 'showSaveDialog').mockReturnValue(picker as any);
		const request = provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-revoked', boxId: 'query-1', artifactId: 'artifact-1',
		});
		await Promise.resolve();
		expect(provider.pendingArtifactCsvIntentIds.has('export-revoked')).toBe(true);

		await provider.handleWebviewMessage({
			type: 'cancelArtifactCsvSaveIntent', requestId: 'export-revoked',
		});
		resolvePicker(vscode.Uri.file('C:/Users/test/Downloads/results.csv'));
		await request;
		expect(provider.pendingArtifactCsvIntentIds.has('export-revoked')).toBe(false);
		expect(provider.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'requestArtifactCsvSaveData' }),
		);
	});

	it('invalidates an issued host nonce when the webview revokes its intent', async () => {
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-issued', boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = vi.mocked(provider.postMessage).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'requestArtifactCsvSaveData');
		expect(provider.pendingArtifactCsvSaves.size).toBe(1);

		await provider.handleWebviewMessage({
			type: 'cancelArtifactCsvSaveIntent', requestId: 'export-issued',
		});
		expect(provider.pendingArtifactCsvSaves.size).toBe(0);
		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId, boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true, csv: 'untrusted',
		});
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('times out unanswered host nonce challenges', async () => {
		vi.useFakeTimers();
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-timeout', boxId: 'query-1', artifactId: 'artifact-1',
		});
		expect(provider.pendingArtifactCsvSaves.size).toBe(1);

		vi.advanceTimersByTime(60_000);
		expect(provider.pendingArtifactCsvSaves.size).toBe(0);
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSave', exportId: 'export-timeout',
		});
		expect(errorSpy).toHaveBeenCalledWith('Timed out preparing results for CSV export.');
	});

	it('accepts a delayed payload before the transfer deadline', async () => {
		vi.useFakeTimers();
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/delayed.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-delayed', boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = vi.mocked(provider.postMessage).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'requestArtifactCsvSaveData');
		vi.advanceTimersByTime(59_000);

		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'delayed',
		});
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('delayed', 'utf8'));
		expect(errorSpy).not.toHaveBeenCalledWith('Timed out preparing results for CSV export.');
	});

	it('preserves remote URI authority for governed artifact exports', async () => {
		const provider = createQueryEditorProviderHarness();
		const pickedUri = vscode.Uri.parse('vscode-remote://ssh-remote+host/remote/workspace/results');
		const savedUri = pickedUri.with({ path: '/remote/workspace/results.csv' });
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await provider.handleWebviewMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-remote', boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = vi.mocked(provider.postMessage).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'requestArtifactCsvSaveData');

		await provider.handleWebviewMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'remote',
		});
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('remote', 'utf8'));
		expect(savedUri.toString()).toBe('vscode-remote://ssh-remote+host/remote/workspace/results.csv');
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
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open File' as any);

		await provider.saveImportedCsvFromWebview({
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
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Show in Folder' as any);

		await provider.saveImportedCsvFromWebview({
			type: 'saveImportedCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'results.csv',
		});

		expectCommandUri('revealFileInOS', savedUri);
	});

	it('does not report a CSV save failure when a post-save action fails', async () => {
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open File' as any);
		vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValueOnce(new Error('Open failed'));
		const warningSpy = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

		await provider.saveImportedCsvFromWebview({
			type: 'saveImportedCsv',
			csv: 'name,count\nalpha,1',
			suggestedFileName: 'results.csv',
		});

		expect(warningSpy).toHaveBeenCalledWith('The file was saved, but Kusto Workbench could not open it automatically.');
		expect(errorSpy).not.toHaveBeenCalledWith('Failed to save results to CSV file.');
	});

	it('does not report a CSV save failure when the saved notification cannot be shown', async () => {
		const provider = createQueryEditorProviderHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockRejectedValueOnce(new Error('Notification failed'));
		const warningSpy = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

		await provider.saveImportedCsvFromWebview({
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

	it('preserves the picked URI authority when appending the CSV extension', async () => {
		const provider = createQueryEditorProviderHarness();
		const pickedUri = vscode.Uri.parse('vscode-remote://ssh-remote+host/remote/workspace/results');
		const savedUri = pickedUri.with({ path: '/remote/workspace/results.csv' });
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Open File' as any);

		await provider.saveImportedCsvFromWebview({
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
});