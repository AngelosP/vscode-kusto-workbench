import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({ onDidChange: () => ({ dispose() {} }) }),
	},
}));

vi.mock('../../../src/host/kqlLanguageService/host', () => ({
	KqlLanguageServiceHost: class {},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		startSession(): void {}
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {},
	SQL_COPILOT_OWNER_CHANGED_MESSAGE: 'SQL section owner changed. Retry the request.',
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {},
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
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

describe('QueryEditorProvider cached-values-open application', () => {
	it('forwards the exact seeCachedValues message to the injected handler without invoking VS Code directly', async () => {
		const cachedValuesOpenApplication = {
			handleMessage: vi.fn(async (_message: IncomingWebviewMessage) => undefined),
			dispose: vi.fn(),
		};
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
		const provider = Reflect.construct(QueryEditorProvider, [
			vscode.Uri.file('C:\\extension'),
			{},
			{},
			{},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			cachedValuesOpenApplication,
		]) as QueryEditorProvider;
		const message = { type: 'seeCachedValues' } satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(cachedValuesOpenApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(cachedValuesOpenApplication.handleMessage).toHaveBeenCalledWith(message);
		expect(cachedValuesOpenApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it('awaits the default handler command and discards its resolved value', async () => {
		const command = deferred<unknown>();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand')
			.mockImplementationOnce(() => command.promise);
		const provider = Reflect.construct(QueryEditorProvider, [
			vscode.Uri.file('C:\\extension'), {}, {}, {},
		]) as QueryEditorProvider;
		let settled = false;

		const request = provider.handleWebviewMessage({ type: 'seeCachedValues' });
		void request.then(() => { settled = true; }, () => { settled = true; });
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(executeCommand.mock.calls).toEqual([['kusto.seeCachedValues']]);

		command.resolve({ ignored: true });
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('propagates the default handler command rejection exactly', async () => {
		const failure = new Error('cached values command failed');
		vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValueOnce(failure);
		const provider = Reflect.construct(QueryEditorProvider, [
			vscode.Uri.file('C:\\extension'), {}, {}, {},
		]) as QueryEditorProvider;

		await expect(provider.handleWebviewMessage({ type: 'seeCachedValues' })).rejects.toBe(failure);
	});

	it('retains only injection and routing while the handler owns command dispatch', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/cachedValuesOpenApplicationHandler.ts'),
			'utf8',
		);
		const extensionSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/extension.ts'),
			'utf8',
		);

		expect(providerSource).not.toContain("case 'seeCachedValues':");
		expect(providerSource).not.toContain("executeCommand('kusto.seeCachedValues'");
		expect(handlerSource).toContain("message.type !== 'seeCachedValues'");
		expect(handlerSource).toContain("executeCommand('kusto.seeCachedValues')");
		expect(handlerSource).not.toContain('CachedValuesViewerV2');
		expect(handlerSource).not.toContain("from './cachedValuesViewer'");
		expect(extensionSource).toContain(
			"registerCommand('kusto.seeCachedValues', afterFirstLaunch(async () =>",
		);
		expect(extensionSource).toContain('CachedValuesViewerV2.open(');
	});
});