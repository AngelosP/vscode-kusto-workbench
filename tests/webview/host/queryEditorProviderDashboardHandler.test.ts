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
import type { DashboardApplicationHandler } from '../../../src/host/dashboardApplicationHandler';

describe('QueryEditorProvider dashboard application forwarding', () => {
	it('forwards every dashboard request unchanged to the injected dashboard handler', async () => {
		const dashboardHandler = {
			handleMessage: vi.fn(async () => undefined),
			beginPowerBiPublishDocumentApplication: vi.fn(() => false),
			settlePowerBiPublishDocumentApplication: vi.fn(async () => undefined),
			setPowerBiPublishCleanupAdmission: vi.fn(),
			dispose: vi.fn(),
		} satisfies DashboardApplicationHandler;
		const provider = new QueryEditorProvider(
			vscode.Uri.file('C:\\extension'),
			{} as never,
			{} as vscode.ExtensionContext,
			{} as never,
			undefined,
			dashboardHandler,
		);
		const messages: IncomingWebviewMessage[] = [
			{
				type: 'showPowerBiPublishHelp', requestId: 'dashboard-help-1',
				sectionId: 'html-dashboard-1', sectionName: 'Dashboard', targetVersion: 1,
				reasons: ['Missing provenance.'],
			},
			{
				type: 'showPowerBiPartialPublishWarning', requestId: 'dashboard-partial-1',
				sectionId: 'html-dashboard-1', sectionName: 'Dashboard', targetVersion: 1,
				reasons: ['Preview-only interaction.'],
			},
			{
				type: 'showPowerBiUnsupportedVisualHelp', requestId: 'dashboard-unsupported-1',
				message: 'Unsupported visual.',
			},
			{ type: 'cancelDashboardWorkflow', requestId: 'dashboard-cancel-1' },
			{ type: 'publishToPowerBIAck', requestId: 'dashboard-publish-1', accepted: true },
			{
				type: 'exportDashboard', requestId: 'dashboard-export-1', boxId: 'html-dashboard-1',
				html: '<main>Dashboard</main>', suggestedFileName: 'dashboard.html',
				previewHeight: 720, dataSources: [],
			},
			{
				type: 'requestHtmlDashboardUpgradeWithCopilot', sectionId: 'html-dashboard-1',
				sectionName: 'Dashboard', targetVersion: 1, reasons: ['Missing provenance.'],
			},
			{ type: 'getPbiWorkspaces', requestId: 'dashboard-workspaces-1', boxId: 'html-dashboard-1' },
			{
				type: 'publishToPowerBI', requestId: 'dashboard-publish-1', boxId: 'html-dashboard-1',
				workspaceId: 'workspace-1', reportName: 'Dashboard', pageWidth: 1280, pageHeight: 720,
				htmlCode: '<main>Dashboard</main>', dataSources: [], dataMode: 'import',
			},
			{
				type: 'checkPbiItemExists', requestId: 'dashboard-exists-1', boxId: 'html-dashboard-1',
				workspaceId: 'workspace-1', reportId: 'report-1',
			},
		];

		for (const message of messages) await provider.handleWebviewMessage(message);

		expect(dashboardHandler.handleMessage).toHaveBeenCalledTimes(messages.length);
		for (const message of messages) {
			expect(dashboardHandler.handleMessage).toHaveBeenCalledWith(message);
		}
	});

	it('retains transport only while the handler owns dashboard workflow state', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/dashboardApplicationHandler.ts'),
			'utf8',
		);
		const displacedProviderAuthorities = [
			'dashboardWorkflowAbortControllers',
			'pendingPowerBiPublishAcks',
			'beginPowerBiPublishDocumentApplication(',
			'settlePowerBiPublishDocumentApplication(',
			'publishToPowerBIService',
			'listFabricWorkspaces',
			'checkFabricItemExists',
			'exportHtmlToPowerBI',
		];

		for (const authority of displacedProviderAuthorities) {
			expect(providerSource, `${authority} must remain outside QueryEditorProvider`).not.toContain(authority);
			expect(handlerSource, `${authority} must remain owned by the dashboard handler`).toContain(authority);
		}
	});
});
