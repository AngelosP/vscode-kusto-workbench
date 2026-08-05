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
import type { DashboardApplicationHandler } from '../../../src/host/dashboardApplicationHandler';
import type { ImportedCsvSaveApplicationHandler } from '../../../src/host/importedCsvSaveApplicationHandler';
import type { PythonExecutionApplicationHandler } from '../../../src/host/pythonExecutionApplicationHandler';
import type { QuerySharingApplicationHandler } from '../../../src/host/querySharingApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

describe('QueryEditorProvider query sharing application', () => {
	it('forwards copyAdeLink and shareToClipboard unchanged to the injected handler', async () => {
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
			handleMessage: vi.fn(() => Promise.resolve()),
			dispose: vi.fn(),
		} satisfies QuerySharingApplicationHandler;
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
		);
		const copyAdeLinkMessage = {
			type: 'copyAdeLink',
			query: 'StormEvents | take 10',
			connectionId: 'kusto-connection',
			database: 'Samples',
			boxId: 'query-share',
		} satisfies IncomingWebviewMessage;
		const shareToClipboardMessage = {
			type: 'shareToClipboard',
			engine: 'kusto',
			boxId: 'query-share',
			includeTitle: true,
			includeQuery: true,
			includeResults: true,
			sectionName: 'Storm sample',
			queryText: 'StormEvents | take 10',
			connectionId: 'kusto-connection',
			database: 'Samples',
			columns: ['State', 'Count'],
			rowsData: [['WA', '10']],
			totalRows: 1,
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(copyAdeLinkMessage);
		await provider.handleWebviewMessage(shareToClipboardMessage);

		expect(querySharingApplication.handleMessage).toHaveBeenCalledTimes(2);
		expect(querySharingApplication.handleMessage).toHaveBeenNthCalledWith(1, copyAdeLinkMessage);
		expect(querySharingApplication.handleMessage).toHaveBeenNthCalledWith(2, shareToClipboardMessage);
	});

	it('retains transport only while the handler owns query sharing', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/querySharingApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			['copyAdeLinkFromWebview', 'private async copyAdeLink('],
			['shareToClipboardFromWebview', 'private async shareToClipboard('],
			["case 'copyAdeLink':", "case 'copyAdeLink':"],
			["case 'shareToClipboard':", "case 'shareToClipboard':"],
			['zlib.gzipSync', 'zlib.gzipSync'],
			['exportAzureDataExplorerClusterPath', 'exportAzureDataExplorerClusterPath'],
			["type: 'shareContentReady'", "type: 'shareContentReady'"],
		];

		for (const [providerAuthority, handlerAuthority] of displacedProviderAuthorities) {
			expect(providerSource, `${providerAuthority} must remain outside QueryEditorProvider`)
				.not.toContain(providerAuthority);
			expect(handlerSource, `${handlerAuthority} must remain owned by the query-sharing handler`)
				.toContain(handlerAuthority);
		}
	});
});
