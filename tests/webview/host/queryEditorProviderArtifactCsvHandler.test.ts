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
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

describe('QueryEditorProvider artifact CSV save application forwarding', () => {
	it('forwards every artifact CSV save message unchanged to the injected handler', async () => {
		const dashboardApplication = {
			handleMessage: vi.fn(() => undefined),
			beginPowerBiPublishDocumentApplication: vi.fn(() => false),
			settlePowerBiPublishDocumentApplication: vi.fn(async () => undefined),
			setPowerBiPublishCleanupAdmission: vi.fn(),
			dispose: vi.fn(),
		} satisfies DashboardApplicationHandler;
		const artifactCsvSaveApplication = {
			handleMessage: vi.fn(async () => undefined),
			dispose: vi.fn(),
		} satisfies ArtifactCsvSaveApplicationHandler;
		const provider = new QueryEditorProvider(
			vscode.Uri.file('C:\\extension'),
			{} as never,
			{} as vscode.ExtensionContext,
			{} as never,
			undefined,
			dashboardApplication,
			artifactCsvSaveApplication,
		);
		const messages: IncomingWebviewMessage[] = [
			{
				type: 'requestArtifactCsvSave', requestId: 'csv-export-1', boxId: 'query-1',
				artifactId: 'artifact-1', suggestedFileName: 'results.csv',
			},
			{
				type: 'artifactCsvSaveData', requestId: 'csv-nonce-1', boxId: 'query-1',
				artifactId: 'artifact-1', accepted: true, csv: 'Name\nalpha',
			},
			{ type: 'cancelArtifactCsvSaveIntent', requestId: 'csv-export-1' },
		];

		for (const message of messages) await provider.handleWebviewMessage(message);

		expect(artifactCsvSaveApplication.handleMessage).toHaveBeenCalledTimes(messages.length);
		for (const message of messages) {
			expect(artifactCsvSaveApplication.handleMessage).toHaveBeenCalledWith(message);
		}
	});

	it('retains transport only while the handler owns artifact CSV save state', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/artifactCsvSaveApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			['pendingArtifactCsvIntentIds', 'pendingArtifactCsvIntentIds'],
			['pendingArtifactCsvSaves', 'pendingArtifactCsvSaves'],
			['completedArtifactCsvIntentIds', 'completedArtifactCsvIntentIds'],
			['requestArtifactCsvSaveFromWebview(', 'private async requestArtifactCsvSave('],
			['acceptArtifactCsvSaveData(', 'private async acceptArtifactCsvSaveData('],
			['cancelArtifactCsvSaveIntent(', 'private cancelArtifactCsvSaveIntent('],
			["case 'requestArtifactCsvSave':", "case 'requestArtifactCsvSave':"],
			["case 'artifactCsvSaveData':", "case 'artifactCsvSaveData':"],
			["case 'cancelArtifactCsvSaveIntent':", "case 'cancelArtifactCsvSaveIntent':"],
		];

		for (const [providerAuthority, handlerAuthority] of displacedProviderAuthorities) {
			expect(providerSource, `${providerAuthority} must remain outside QueryEditorProvider`)
				.not.toContain(providerAuthority);
			expect(handlerSource, `${handlerAuthority} must remain owned by the artifact CSV handler`)
				.toContain(handlerAuthority);
		}
	});
});