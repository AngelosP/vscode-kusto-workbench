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
import type { UrlContentApplicationHandler } from '../../../src/host/urlContentApplicationHandler';

describe('QueryEditorProvider URL content application', () => {
	it('forwards fetchUrl unchanged to the injected handler', async () => {
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
			handleMessage: vi.fn(() => Promise.resolve()),
			dispose: vi.fn(),
		} satisfies UrlContentApplicationHandler;
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
		);
		const message = {
			type: 'fetchUrl',
			boxId: 'url-section',
			url: 'not a URL',
			requestId: 'url-request-1',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(urlContentApplication.handleMessage).toHaveBeenCalledOnce();
		expect(urlContentApplication.handleMessage).toHaveBeenCalledWith(message);
	});

	it('retains transport only while the handler owns URL content acquisition', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/urlContentApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			['fetchUrlFromWebview', 'private async fetchUrlContent('],
			["case 'fetchUrl':", "message.type !== 'fetchUrl'"],
			['new AbortController()', 'new AbortController()'],
			['URL_FETCH_TIMEOUT_MS = 15_000', 'URL_FETCH_TIMEOUT_MS = 15_000'],
			['URL_TEXT_MAX_BYTES = 100 * 1024 * 1024', 'URL_TEXT_MAX_BYTES = 100 * 1024 * 1024'],
			['URL_IMAGE_MAX_BYTES = 5 * 1024 * 1024', 'URL_IMAGE_MAX_BYTES = 5 * 1024 * 1024'],
			['URL_CONTENT_MAX_CHARS = 200_000', 'URL_CONTENT_MAX_CHARS = 200_000'],
			["type: 'urlContent'", "type: 'urlContent'"],
			["type: 'urlError'", "type: 'urlError'"],
		];

		for (const [providerAuthority, handlerAuthority] of displacedProviderAuthorities) {
			expect(providerSource, `${providerAuthority} must remain outside QueryEditorProvider`)
				.not.toContain(providerAuthority);
			expect(handlerSource, `${handlerAuthority} must remain owned by the URL-content handler`)
				.toContain(handlerAuthority);
		}
	});
});
