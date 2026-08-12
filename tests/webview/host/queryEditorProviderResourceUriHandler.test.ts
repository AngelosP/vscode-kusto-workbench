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
import type { ControlCommandSyntaxApplicationHandler } from '../../../src/host/controlCommandSyntaxApplicationHandler';
import type { DashboardApplicationHandler } from '../../../src/host/dashboardApplicationHandler';
import type { ImportedCsvSaveApplicationHandler } from '../../../src/host/importedCsvSaveApplicationHandler';
import type { PythonExecutionApplicationHandler } from '../../../src/host/pythonExecutionApplicationHandler';
import type { QuerySharingApplicationHandler } from '../../../src/host/querySharingApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { UrlContentApplicationHandler } from '../../../src/host/urlContentApplicationHandler';

type ResourceUriApplicationHandler = {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
};

describe('QueryEditorProvider resource URI application', () => {
	it('forwards resolveResourceUri unchanged to the injected handler', async () => {
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
			handleMessage: vi.fn(() => Promise.resolve()),
			dispose: vi.fn(),
		} satisfies ResourceUriApplicationHandler;
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
		]) as QueryEditorProvider;
		const message = {
			type: 'resolveResourceUri',
			requestId: 'resource-request-1',
			path: 'https://example.test/image.png',
			baseUri: 'file:///C:/workspace/document.kqlx',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(resourceUriApplication.handleMessage).toHaveBeenCalledOnce();
		expect(resourceUriApplication.handleMessage).toHaveBeenCalledWith(message);
	});

	it('retains only transport and webview conversion capability in the provider', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/resourceUriApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			['resolvedResourceUriCache', 'resolvedResourceUriCache'],
			["case 'resolveResourceUri':", 'isResourceUriWebviewMessageType(message)'],
			['private async resolveResourceUri', 'private async resolveResourceUri'],
			['vscode.workspace.fs.stat', 'vscode.workspace.fs.stat'],
			['vscode.workspace.getWorkspaceFolder', 'vscode.workspace.getWorkspaceFolder'],
			["type: 'resolveResourceUriResult'", "type: 'resolveResourceUriResult'"],
			['Missing or unsupported baseUri. Only local files are supported.', 'Missing or unsupported baseUri. Only local files are supported.'],
			['File not found.', 'File not found.'],
			['Webview panel is not available.', 'Webview panel is not available.'],
			['Failed to create webview URI:', 'Failed to create webview URI:'],
		];

		for (const [providerAuthority, handlerAuthority] of displacedProviderAuthorities) {
			expect(providerSource, `${providerAuthority} must remain outside QueryEditorProvider`)
				.not.toContain(providerAuthority);
			expect(handlerSource, `${handlerAuthority} must remain owned by the resource URI handler`)
				.toContain(handlerAuthority);
		}
		expect(providerSource).not.toMatch(/import\s+\*\s+as\s+path\s+from\s+['"]path['"]/);
		expect(providerSource).toContain('asWebviewUri: uri => this.panel?.webview.asWebviewUri(uri)');
	});
});