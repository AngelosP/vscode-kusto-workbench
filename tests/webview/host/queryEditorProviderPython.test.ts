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
import type { PythonExecutionApplicationHandler } from '../../../src/host/pythonExecutionApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

describe('QueryEditorProvider Python execution', () => {
	it('forwards executePython unchanged to the injected handler', async () => {
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
			handleMessage: vi.fn(() => Promise.resolve()),
			dispose: vi.fn(),
		} satisfies PythonExecutionApplicationHandler;
		const provider = new QueryEditorProvider(
			vscode.Uri.file('C:\\extension'),
			{} as never,
			{} as vscode.ExtensionContext,
			{} as never,
			undefined,
			dashboardApplication,
			artifactCsvSaveApplication,
			pythonExecutionApplication,
		);
		const message = {
			type: 'executePython', boxId: 'python-forwarding', code: 'print("forwarded")',
		} satisfies IncomingWebviewMessage;

		await provider.handleWebviewMessage(message);

		expect(pythonExecutionApplication.handleMessage).toHaveBeenCalledOnce();
		expect(pythonExecutionApplication.handleMessage).toHaveBeenCalledWith(message);
	});

	it('retains transport only while the handler owns Python execution state', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/pythonExecutionApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			['createPythonProcess', 'createProcess'],
			['executePythonFromWebview', 'private async executePython('],
			["case 'executePython':", 'admitPythonExecutionWebviewMessage(message)'],
			["type: 'pythonResult'", "type: 'pythonResult'"],
			["type: 'pythonError'", "type: 'pythonError'"],
			['spawn(', 'spawn('],
		];

		for (const [providerAuthority, handlerAuthority] of displacedProviderAuthorities) {
			expect(providerSource, `${providerAuthority} must remain outside QueryEditorProvider`)
				.not.toContain(providerAuthority);
			expect(handlerSource, `${handlerAuthority} must remain owned by the Python handler`)
				.toContain(handlerAuthority);
		}
	});
});