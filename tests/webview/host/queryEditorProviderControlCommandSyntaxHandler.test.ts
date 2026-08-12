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

describe('QueryEditorProvider control-command syntax application', () => {
	it('forwards fetchControlCommandSyntax unchanged to the injected handler', async () => {
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
			handleMessage: vi.fn(() => Promise.resolve()),
			dispose: vi.fn(),
		} satisfies ControlCommandSyntaxApplicationHandler;
		const provider = new QueryEditorProvider(
			vscode.Uri.file('C:\\extension'),
			{} as never,
			{} as vscode.ExtensionContext,
			{} as never,
			undefined,
			dashboardApplication,
			artifactCsvSaveApplication,
			pythonExecutionApplication,
			importedCsvSaveApplication,
			querySharingApplication,
			urlContentApplication,
			controlCommandSyntaxApplication,
		);
		const message = {
			type: 'fetchControlCommandSyntax',
			requestId: 'syntax-request-1',
			commandLower: '.show tables',
			href: '/kusto/management/show-tables-command',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(controlCommandSyntaxApplication.handleMessage).toHaveBeenCalledOnce();
		expect(controlCommandSyntaxApplication.handleMessage).toHaveBeenCalledWith(message);
	});

	it('retains transport only while the handler owns control-command syntax lookup', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/controlCommandSyntaxApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			['controlCommandSyntaxCache', 'controlCommandSyntaxCache'],
			['CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS', 'CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS'],
			["case 'fetchControlCommandSyntax':", 'isControlCommandSyntaxWebviewMessageType(message)'],
			['decodeHtmlEntities', 'decodeHtmlEntities'],
			['extractControlCommandSyntaxFromLearnHtml', 'extractControlCommandSyntaxFromLearnHtml'],
			['extractWithArgsFromSyntax', 'extractWithArgsFromSyntax'],
			['handleFetchControlCommandSyntax', 'handleFetchControlCommandSyntax'],
			["new URL(href, 'https://learn.microsoft.com/en-us/kusto/')", "new URL(href, 'https://learn.microsoft.com/en-us/kusto/')"],
			["type: 'controlCommandSyntaxResult'", "type: 'controlCommandSyntaxResult'"],
		];

		for (const [providerAuthority, handlerAuthority] of displacedProviderAuthorities) {
			expect(providerSource, `${providerAuthority} must remain outside QueryEditorProvider`)
				.not.toContain(providerAuthority);
			expect(handlerSource, `${handlerAuthority} must remain owned by the control-command syntax handler`)
				.toContain(handlerAuthority);
		}
	});
});