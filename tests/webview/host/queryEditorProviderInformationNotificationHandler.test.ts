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
import type { ArtifactCsvSaveApplicationHandler } from '../../../src/host/artifactCsvSaveApplicationHandler';
import type { CopilotContentOpenApplicationHandler } from '../../../src/host/copilotContentOpenApplicationHandler';
import type { ControlCommandSyntaxApplicationHandler } from '../../../src/host/controlCommandSyntaxApplicationHandler';
import type { DashboardApplicationHandler } from '../../../src/host/dashboardApplicationHandler';
import type { ImportedCsvSaveApplicationHandler } from '../../../src/host/importedCsvSaveApplicationHandler';
import type { InformationNotificationApplicationHandler } from '../../../src/host/informationNotificationApplicationHandler';
import type { PythonExecutionApplicationHandler } from '../../../src/host/pythonExecutionApplicationHandler';
import type { QuerySharingApplicationHandler } from '../../../src/host/querySharingApplicationHandler';
import type { ResourceUriApplicationHandler } from '../../../src/host/resourceUriApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { UrlContentApplicationHandler } from '../../../src/host/urlContentApplicationHandler';

describe('QueryEditorProvider information-notification application', () => {
	it('forwards the exact showInfo message to the injected handler without invoking VS Code directly', async () => {
		const dashboardApplication = {
			handleMessage: vi.fn(() => undefined),
			beginPowerBiPublishDocumentApplication: vi.fn(() => false),
			settlePowerBiPublishDocumentApplication: vi.fn(async () => undefined),
			setPowerBiPublishCleanupAdmission: vi.fn(),
			dispose: vi.fn(),
		} satisfies DashboardApplicationHandler;
		const artifactCsvSaveApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies ArtifactCsvSaveApplicationHandler;
		const pythonExecutionApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies PythonExecutionApplicationHandler;
		const importedCsvSaveApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies ImportedCsvSaveApplicationHandler;
		const querySharingApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies QuerySharingApplicationHandler;
		const urlContentApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies UrlContentApplicationHandler;
		const controlCommandSyntaxApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies ControlCommandSyntaxApplicationHandler;
		const resourceUriApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies ResourceUriApplicationHandler;
		const copilotContentOpenApplication = {
			handleMessage: vi.fn(() => undefined),
			dispose: vi.fn(),
		} satisfies CopilotContentOpenApplicationHandler;
		const informationNotificationApplication = {
			handleMessage: vi.fn(() => true as const),
			dispose: vi.fn(),
		} satisfies InformationNotificationApplicationHandler;
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
		const provider = Reflect.construct(QueryEditorProvider, [
			vscode.Uri.file('C:\\extension'),
			{},
			{},
			{},
			undefined,
			dashboardApplication,
			artifactCsvSaveApplication,
			pythonExecutionApplication,
			importedCsvSaveApplication,
			querySharingApplication,
			urlContentApplication,
			controlCommandSyntaxApplication,
			resourceUriApplication,
			copilotContentOpenApplication,
			informationNotificationApplication,
		]) as QueryEditorProvider;
		const message = {
			type: 'showInfo',
			message: '  Keep\tthis text exactly.  ',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(informationNotificationApplication.handleMessage).toHaveBeenCalledTimes(1);
		expect(informationNotificationApplication.handleMessage).toHaveBeenCalledWith(message);
		expect(informationNotificationApplication.handleMessage.mock.calls[0][0]).toBe(message);
		expect(showInformationMessage).not.toHaveBeenCalled();
	});

	it('does not adopt the native notification thenable', async () => {
		const pendingNotification = new Promise<string | undefined>(() => undefined);
		vi.spyOn(vscode.window, 'showInformationMessage').mockReturnValue(pendingNotification);
		const provider = Reflect.construct(QueryEditorProvider, [
			vscode.Uri.file('C:\\extension'), {}, {}, {},
		]) as QueryEditorProvider;

		await expect(provider.handleWebviewMessage({
			type: 'showInfo', message: 'fire and forget',
		})).resolves.toBeUndefined();
	});

	it('turns a synchronous native notification throw into a rejected provider call', async () => {
		const failure = new Error('notification failed synchronously');
		vi.spyOn(vscode.window, 'showInformationMessage')
			.mockImplementationOnce(() => { throw failure; });
		const provider = Reflect.construct(QueryEditorProvider, [
			vscode.Uri.file('C:\\extension'), {}, {}, {},
		]) as QueryEditorProvider;

		await expect(provider.handleWebviewMessage({
			type: 'showInfo', message: 'preserve failure',
		})).rejects.toBe(failure);
	});

	it('retains only injection and routing while the handler owns the native notification', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/informationNotificationApplicationHandler.ts'),
			'utf8',
		);

		expect(providerSource).not.toContain("case 'showInfo':");
		expect(providerSource).not.toContain('vscode.window.showInformationMessage(message.message)');
		expect(handlerSource).toContain("message.type !== 'showInfo'");
		expect(handlerSource).toContain('vscode.window.showInformationMessage(message.message)');
	});
});