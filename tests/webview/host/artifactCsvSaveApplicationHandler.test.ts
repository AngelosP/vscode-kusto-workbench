import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HostArtifactCsvSaveApplicationHandler } from '../../../src/host/artifactCsvSaveApplicationHandler';

type HandlerHarness = {
	handler: HostArtifactCsvSaveApplicationHandler & Record<string, any>;
	postMessage: ReturnType<typeof vi.fn>;
	markDisposed(): void;
};

const liveHandlers = new Set<HostArtifactCsvSaveApplicationHandler>();

function createHandlerHarness(): HandlerHarness {
	let disposed = false;
	const postMessage = vi.fn().mockResolvedValue(true);
	const handler = new HostArtifactCsvSaveApplicationHandler({
		postMessage,
		isDisposed: () => disposed,
	}) as HostArtifactCsvSaveApplicationHandler & Record<string, any>;
	liveHandlers.add(handler);
	return {
		handler,
		postMessage,
		markDisposed: () => { disposed = true; },
	};
}

function findChallenge(postMessage: ReturnType<typeof vi.fn>, exportId?: string): any {
	return postMessage.mock.calls
		.map(call => call[0] as any)
		.find(message => message.type === 'requestArtifactCsvSaveData'
			&& (exportId === undefined || message.exportId === exportId));
}

describe('HostArtifactCsvSaveApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.useRealTimers();
		vi.restoreAllMocks();
		(vscode as any).__mockFileSystem?.clear?.();
	});

	it('declines unrelated messages synchronously', () => {
		const { handler, postMessage } = createHandlerHarness();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('claims malformed intents before picker or intent effects', async () => {
		const { handler, postMessage } = createHandlerHarness();
		const pickerSpy = vi.spyOn(vscode.window, 'showSaveDialog');

		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-malformed',
			boxId: ['query-1'], artifactId: 'artifact-1',
		} as any);

		expect(pickerSpy).not.toHaveBeenCalled();
		expect(handler.pendingArtifactCsvIntentIds.size).toBe(0);
		expect(handler.pendingArtifactCsvSaves.size).toBe(0);
		expect(handler.completedArtifactCsvIntentIds.size).toBe(0);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('writes exact bytes only after the matching one-use nonce response', async () => {
		const { handler, postMessage } = createHandlerHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		const csv = 'Name,Score\nalpha,1\nbravo,2';
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-1', boxId: 'query-1',
			artifactId: 'artifact-1', suggestedFileName: 'results.csv',
		});
		expect(writeSpy).not.toHaveBeenCalled();
		const challenge = findChallenge(postMessage);
		expect(challenge).toMatchObject({
			type: 'requestArtifactCsvSaveData', exportId: 'export-1', boxId: 'query-1',
			artifactId: 'artifact-1',
		});
		expect(challenge.requestId).not.toBe('export-1');

		const response = {
			type: 'artifactCsvSaveData' as const, requestId: challenge.requestId, boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true, csv,
		};
		await handler.handleMessage(response);
		await handler.handleMessage({ ...response, csv: 'replay' });

		expect(writeSpy).toHaveBeenCalledOnce();
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from(csv, 'utf8'));
	});

	it('ignores replayed export intents while active and after settlement', async () => {
		const { handler, postMessage } = createHandlerHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const intent = {
			type: 'requestArtifactCsvSave' as const, requestId: 'export-replay',
			boxId: 'query-1', artifactId: 'artifact-1',
		};

		await handler.handleMessage(intent);
		await handler.handleMessage(intent);
		const challenge = findChallenge(postMessage);
		expect(postMessage.mock.calls.filter(call => (call[0] as any).type === 'requestArtifactCsvSaveData'))
			.toHaveLength(1);
		expect(vscode.window.showSaveDialog).toHaveBeenCalledOnce();

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'once',
		});
		await handler.handleMessage(intent);
		expect(vscode.window.showSaveDialog).toHaveBeenCalledOnce();
	});

	it('bounds active and completed export intent ledgers', async () => {
		vi.useFakeTimers();
		const { handler, postMessage } = createHandlerHarness();
		const pickerResolvers: Array<(uri: vscode.Uri | undefined) => void> = [];
		vi.spyOn(vscode.window, 'showSaveDialog').mockImplementation(() => new Promise(resolve => {
			pickerResolvers.push(resolve as (uri: vscode.Uri | undefined) => void);
		}) as any);
		const requests = Array.from({ length: 9 }, (_value, index) => handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: `active-${index}`,
			boxId: `query-${index}`, artifactId: `artifact-${index}`,
		}));
		await vi.waitFor(() => expect(pickerResolvers).toHaveLength(8));
		expect(vscode.window.showSaveDialog).toHaveBeenCalledTimes(8);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSave', exportId: 'active-8',
		});
		for (const resolve of pickerResolvers) resolve(undefined);
		await Promise.all(requests);

		for (let index = 0; index < 300; index++) handler.completeArtifactCsvIntent(`completed-${index}`);
		expect(handler.completedArtifactCsvIntentIds.size).toBe(256);
	});

	it('requires exact box and artifact correlation before consuming a nonce', async () => {
		const { handler, postMessage } = createHandlerHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-2', boxId: 'query-2', artifactId: 'artifact-2',
		});
		const challenge = findChallenge(postMessage);

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId, boxId: 'query-2',
			artifactId: 'wrong-artifact', accepted: true, csv: 'wrong',
		});
		expect(writeSpy).not.toHaveBeenCalled();
		expect(handler.pendingArtifactCsvSaves.size).toBe(1);

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId, boxId: 'query-2',
			artifactId: 'artifact-2', accepted: true, csv: 'correct',
		});
		expect(writeSpy).toHaveBeenCalledOnce();
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('correct', 'utf8'));
	});

	it('leaves the exact nonce state untouched after a malformed matching transfer', async () => {
		vi.useFakeTimers();
		const { handler, postMessage } = createHandlerHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		const informationSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-malformed',
			boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = findChallenge(postMessage, 'export-malformed');
		const pending = handler.pendingArtifactCsvSaves.get(challenge.requestId);
		const timer = pending.timer;

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: ['query-1'], artifactId: 'artifact-1', accepted: true, csv: 'forged',
		} as any);

		expect(handler.pendingArtifactCsvSaves.get(challenge.requestId)).toBe(pending);
		expect(handler.pendingArtifactCsvSaves.get(challenge.requestId).timer).toBe(timer);
		expect(handler.pendingArtifactCsvIntentIds.has('export-malformed')).toBe(true);
		expect(handler.completedArtifactCsvIntentIds.size).toBe(0);
		expect(writeSpy).not.toHaveBeenCalled();
		expect(informationSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'canonical',
		});

		expect(writeSpy).toHaveBeenCalledOnce();
		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('canonical', 'utf8'));
	});

	it('keeps concurrent exports correlated when responses complete in reverse order', async () => {
		const { handler, postMessage } = createHandlerHarness();
		const uriA = vscode.Uri.file('C:/Users/test/Downloads/a.csv');
		const uriB = vscode.Uri.file('C:/Users/test/Downloads/b.csv');
		vi.spyOn(vscode.window, 'showSaveDialog')
			.mockResolvedValueOnce(uriA as any)
			.mockResolvedValueOnce(uriB as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-a', boxId: 'query-a', artifactId: 'artifact-a',
		});
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-b', boxId: 'query-b', artifactId: 'artifact-b',
		});
		const challengeA = findChallenge(postMessage, 'export-a');
		const challengeB = findChallenge(postMessage, 'export-b');

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challengeB.requestId,
			boxId: 'query-b', artifactId: 'artifact-b', accepted: true, csv: 'B',
		});
		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challengeA.requestId,
			boxId: 'query-a', artifactId: 'artifact-a', accepted: true, csv: 'A',
		});

		expect(writeSpy).toHaveBeenCalledWith(uriA, Buffer.from('A', 'utf8'));
		expect(writeSpy).toHaveBeenCalledWith(uriB, Buffer.from('B', 'utf8'));
	});

	it('cancels only the dismissed picker intent', async () => {
		const { handler, postMessage } = createHandlerHarness();
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(undefined);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-cancel', boxId: 'query-1', artifactId: 'artifact-1',
		});

		expect(postMessage).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSave', exportId: 'export-cancel',
		});
		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('abandons an intent revoked while the native picker is open', async () => {
		const { handler, postMessage } = createHandlerHarness();
		let resolvePicker!: (uri: vscode.Uri | undefined) => void;
		const picker = new Promise<vscode.Uri | undefined>(resolve => { resolvePicker = resolve; });
		vi.spyOn(vscode.window, 'showSaveDialog').mockReturnValue(picker as any);
		const request = handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-revoked', boxId: 'query-1', artifactId: 'artifact-1',
		});
		await Promise.resolve();

		await handler.handleMessage({ type: 'cancelArtifactCsvSaveIntent', requestId: 'export-revoked' });
		resolvePicker(vscode.Uri.file('C:/Users/test/Downloads/results.csv'));
		await request;

		expect(postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'requestArtifactCsvSaveData' }),
		);
	});

	it('invalidates an issued nonce when its exact intent is revoked', async () => {
		const { handler, postMessage } = createHandlerHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-issued', boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = findChallenge(postMessage);

		await handler.handleMessage({ type: 'cancelArtifactCsvSaveIntent', requestId: 'export-issued' });
		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId, boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true, csv: 'untrusted',
		});

		expect(writeSpy).not.toHaveBeenCalled();
	});

	it('times out an unanswered nonce without affecting later attempts', async () => {
		vi.useFakeTimers();
		const { handler, postMessage } = createHandlerHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/results.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-timeout', boxId: 'query-1', artifactId: 'artifact-1',
		});

		vi.advanceTimersByTime(60_000);

		expect(postMessage).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSave', exportId: 'export-timeout',
		});
		expect(errorSpy).toHaveBeenCalledWith('Timed out preparing results for CSV export.');
	});

	it('accepts a delayed payload before the transfer deadline', async () => {
		vi.useFakeTimers();
		const { handler, postMessage } = createHandlerHarness();
		const savedUri = vscode.Uri.file('C:/Users/test/Downloads/delayed.csv');
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(savedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-delayed', boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = findChallenge(postMessage);
		vi.advanceTimersByTime(59_000);

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'delayed',
		});

		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('delayed', 'utf8'));
		expect(errorSpy).not.toHaveBeenCalledWith('Timed out preparing results for CSV export.');
	});

	it('preserves remote URI authority when appending the CSV extension', async () => {
		const { handler, postMessage } = createHandlerHarness();
		const pickedUri = vscode.Uri.parse('vscode-remote://ssh-remote+host/remote/workspace/results');
		const savedUri = pickedUri.with({ path: '/remote/workspace/results.csv' });
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(pickedUri as any);
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-remote', boxId: 'query-1', artifactId: 'artifact-1',
		});
		const challenge = findChallenge(postMessage);

		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: challenge.requestId,
			boxId: 'query-1', artifactId: 'artifact-1', accepted: true, csv: 'remote',
		});

		expect(writeSpy).toHaveBeenCalledWith(savedUri, Buffer.from('remote', 'utf8'));
		expect(savedUri.toString()).toBe('vscode-remote://ssh-remote+host/remote/workspace/results.csv');
	});

	it('disposal retires open picker intents and issued nonces', async () => {
		const { handler, postMessage, markDisposed } = createHandlerHarness();
		let resolvePicker!: (uri: vscode.Uri | undefined) => void;
		vi.spyOn(vscode.window, 'showSaveDialog')
			.mockImplementationOnce(() => new Promise(resolve => { resolvePicker = resolve as any; }) as any)
			.mockResolvedValueOnce(vscode.Uri.file('C:/Users/test/Downloads/issued.csv') as any);
		const pickerRequest = handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-picker', boxId: 'query-picker',
			artifactId: 'artifact-picker',
		});
		await Promise.resolve();
		await handler.handleMessage({
			type: 'requestArtifactCsvSave', requestId: 'export-issued', boxId: 'query-issued',
			artifactId: 'artifact-issued',
		});
		const issuedChallenge = findChallenge(postMessage, 'export-issued');
		const writeSpy = vi.spyOn(vscode.workspace.fs, 'writeFile');

		markDisposed();
		handler.dispose();
		resolvePicker(vscode.Uri.file('C:/Users/test/Downloads/picker.csv'));
		await pickerRequest;
		await handler.handleMessage({
			type: 'artifactCsvSaveData', requestId: issuedChallenge.requestId,
			boxId: 'query-issued', artifactId: 'artifact-issued', accepted: true, csv: 'retired',
		});

		expect(findChallenge(postMessage, 'export-picker')).toBeUndefined();
		expect(writeSpy).not.toHaveBeenCalled();
	});
});