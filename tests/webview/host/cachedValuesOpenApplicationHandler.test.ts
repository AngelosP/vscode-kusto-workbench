import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HostCachedValuesOpenApplicationHandler } from '../../../src/host/cachedValuesOpenApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function seeCachedValuesMessage(): IncomingWebviewMessage {
	return { type: 'seeCachedValues' };
}

describe('HostCachedValuesOpenApplicationHandler', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const handler = new HostCachedValuesOpenApplicationHandler();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it('awaits exactly one zero-argument cached-values command and discards its resolved value', async () => {
		const handler = new HostCachedValuesOpenApplicationHandler();
		const command = deferred<unknown>();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand')
			.mockImplementationOnce(() => command.promise);
		let settled = false;

		const request = handler.handleMessage(seeCachedValuesMessage())!;
		void request.finally(() => { settled = true; });
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(executeCommand).toHaveBeenCalledOnce();
		expect(executeCommand.mock.calls[0]).toEqual(['kusto.seeCachedValues']);

		command.resolve({ ignored: true });
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('propagates the exact command rejection', async () => {
		const handler = new HostCachedValuesOpenApplicationHandler();
		const failure = new Error('cached values command failed');
		vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValueOnce(failure);

		await expect(handler.handleMessage(seeCachedValuesMessage())).rejects.toBe(failure);
	});

	it('turns an exact synchronous command throw into the handler rejection', async () => {
		const handler = new HostCachedValuesOpenApplicationHandler();
		const failure = new Error('cached values command threw');
		vi.spyOn(vscode.commands, 'executeCommand')
			.mockImplementationOnce(() => { throw failure; });

		await expect(handler.handleMessage(seeCachedValuesMessage())).rejects.toBe(failure);
	});

	it('allows an accepted command to resolve after disposal', async () => {
		const handler = new HostCachedValuesOpenApplicationHandler();
		const command = deferred<unknown>();
		vi.spyOn(vscode.commands, 'executeCommand').mockImplementationOnce(() => command.promise);
		const request = handler.handleMessage(seeCachedValuesMessage())!;

		handler.dispose();
		command.resolve('ignored');

		await expect(request).resolves.toBeUndefined();
	});

	it('allows an accepted command rejection to propagate after disposal', async () => {
		const handler = new HostCachedValuesOpenApplicationHandler();
		const command = deferred<unknown>();
		const failure = new Error('late cached values failure');
		vi.spyOn(vscode.commands, 'executeCommand').mockImplementationOnce(() => command.promise);
		const request = handler.handleMessage(seeCachedValuesMessage())!;

		handler.dispose();
		command.reject(failure);

		await expect(request).rejects.toBe(failure);
	});

	it('claims but suppresses later requests after idempotent disposal', async () => {
		const handler = new HostCachedValuesOpenApplicationHandler();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');

		handler.dispose();
		handler.dispose();
		const request = handler.handleMessage(seeCachedValuesMessage());

		expect(request).toBeInstanceOf(Promise);
		await expect(request).resolves.toBeUndefined();
		expect(executeCommand).not.toHaveBeenCalled();
	});
});