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
import type { PythonExecutionApplicationHandler } from '../../../src/host/pythonExecutionApplicationHandler';
import type { QuerySharingApplicationHandler } from '../../../src/host/querySharingApplicationHandler';
import type { ResourceUriApplicationHandler } from '../../../src/host/resourceUriApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { UrlContentApplicationHandler } from '../../../src/host/urlContentApplicationHandler';

describe('QueryEditorProvider Copilot content-open application', () => {
	it('forwards both exact content-open messages unchanged to the injected handler', async () => {
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
			handleMessage: vi.fn(() => Promise.resolve()),
			dispose: vi.fn(),
		} satisfies CopilotContentOpenApplicationHandler;
		Object.assign(vscode.window, { showTextDocument: vi.fn(async () => undefined) });
		const extensionUri = vscode.Uri.file('C:\\extension');
		const openTextDocument = vi.spyOn(vscode.workspace, 'openTextDocument');
		const showTextDocument = vi.spyOn(vscode.window, 'showTextDocument');
		const uriFile = vi.spyOn(vscode.Uri, 'file');
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
		const provider = Reflect.construct(QueryEditorProvider, [
			extensionUri,
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
		]) as QueryEditorProvider;
		const toolResultMessage = {
			type: 'openToolResultInEditor',
			boxId: 'query-1',
			tool: '  get_schema  ',
			label: 'Schema result',
			content: 'Table\tColumn\nStormEvents\tState',
		} satisfies IncomingWebviewMessage;
		const markdownPreviewMessage = {
			type: 'openMarkdownPreview',
			filePath: 'C:\\workspace\\copilot-result.md',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(toolResultMessage);
		await provider.handleWebviewMessage(markdownPreviewMessage);

		expect(copilotContentOpenApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(copilotContentOpenApplication.handleMessage).toHaveBeenNthCalledWith(1, toolResultMessage);
		expect(copilotContentOpenApplication.handleMessage).toHaveBeenNthCalledWith(2, markdownPreviewMessage);
		expect(copilotContentOpenApplication.handleMessage.mock.calls[0][0]).toBe(toolResultMessage);
		expect(copilotContentOpenApplication.handleMessage.mock.calls[1][0]).toBe(markdownPreviewMessage);
		expect(openTextDocument).not.toHaveBeenCalled();
		expect(showTextDocument).not.toHaveBeenCalled();
		expect(uriFile).not.toHaveBeenCalled();
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it('retains only injection and routing while the handler owns both native effects', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/copilotContentOpenApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			["case 'openToolResultInEditor':", "message.type !== 'openToolResultInEditor'"],
			["case 'openMarkdownPreview':", "message.type !== 'openMarkdownPreview'"],
			['private async openToolResultInEditor', 'private async openToolResultInEditor'],
			['private async openMarkdownPreview', 'private async openMarkdownPreview'],
			['vscode.workspace.openTextDocument', 'vscode.workspace.openTextDocument'],
			['vscode.window.showTextDocument', 'vscode.window.showTextDocument'],
			["String(message.tool || 'tool_result').trim()", "String(message.tool || 'tool_result').trim()"],
			["String(message.content || '')", "String(message.content || '')"],
			["language: 'plaintext'", "language: 'plaintext'"],
			['viewColumn: vscode.ViewColumn.Beside', 'viewColumn: vscode.ViewColumn.Beside'],
			['vscode.Uri.file(message.filePath)', 'vscode.Uri.file(message.filePath)'],
			["vscode.commands.executeCommand('markdown.showPreview'", "vscode.commands.executeCommand('markdown.showPreview'"],
			['Failed to open tool result:', 'Failed to open tool result:'],
			['Failed to open markdown preview:', 'Failed to open markdown preview:'],
		];

		for (const [providerAuthority, handlerAuthority] of displacedProviderAuthorities) {
			expect(providerSource, `${providerAuthority} must remain outside QueryEditorProvider`)
				.not.toContain(providerAuthority);
			expect(handlerSource, `${handlerAuthority} must remain owned by the content-open handler`)
				.toContain(handlerAuthority);
		}
	});
});