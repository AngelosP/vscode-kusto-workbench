import { describe, expect, it, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';

const powerBiPublishMocks = vi.hoisted(() => ({
	publishToPowerBIService: vi.fn(),
}));

vi.mock('../../../src/host/powerBiPublish', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/powerBiPublish')>(),
	publishToPowerBIService: powerBiPublishMocks.publishToPowerBIService,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';

function createProviderHarness() {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider._panelDisposed = false;
	provider.dashboardWorkflowAbortControllers = new Map();
	provider.pendingPowerBiPublishAcks = new Map();
	provider.connectionManager = {
		isLeaveNoTrace: () => false,
		runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: unknown) => unknown) => run({
			clusterKeys: [], globallyBlocked: false, version: 0, revocationGenerations: {},
		}),
	};
	provider.output = { error: vi.fn(), warn: vi.fn() };
	provider.requestHtmlDashboardUpgradeWithCopilot = vi.fn(async () => undefined);
	provider.postMessage = vi.fn();
	return provider;
}

function publishLease(cleanup: () => Promise<boolean>, applicationState = 'idle') {
	return {
		cleanup,
		timer: setTimeout(() => undefined, 60_000),
		boxId: 'html_publish',
		publishInfo: Object.freeze({
			workspaceId: 'workspace-1',
			semanticModelId: 'model-created',
			reportId: 'report-created',
			reportName: 'Dashboard',
			reportUrl: 'https://app.powerbi.com/report',
		}),
		applicationState,
		cleanupRequested: false,
		finalizationInProgress: false,
	};
}

const publishInfo = {
	workspaceId: 'workspace-1', semanticModelId: 'model-created', reportId: 'report-created',
	reportName: 'Dashboard', reportUrl: 'https://app.powerbi.com/report',
} as const;

const previousPublishInfo = {
	workspaceId: 'workspace-old', semanticModelId: 'model-old', reportId: 'report-old',
	reportName: 'Old dashboard', reportUrl: 'https://app.powerbi.com/old', dataMode: 'directQuery',
} as const;

function publishProjection(
	documentRevision: number,
	sectionRevision: number,
	pbiPublishInfo?: typeof publishInfo | typeof previousPublishInfo,
) {
	return {
		documentRevision,
		sectionRevisions: { html_publish: sectionRevision },
		markdownSectionRevisions: {}, chartSections: [],
		htmlSections: [{ id: 'html_publish', type: 'html', ...(pbiPublishInfo ? { pbiPublishInfo } : {}) }],
		markdownSections: [], pythonSections: [], transformationSections: [], urlSections: [],
		orderedSectionIds: ['html_publish'],
	};
}

function wrongKindProjection() {
	return {
		documentRevision: 0,
		sectionRevisions: { html_publish: 0 },
		markdownSectionRevisions: { html_publish: 0 }, chartSections: [], htmlSections: [],
		markdownSections: [{ id: 'html_publish', type: 'markdown', text: 'replacement' }],
		pythonSections: [], transformationSections: [], urlSections: [], orderedSectionIds: ['html_publish'],
	};
}

const applyPublishCommand = {
	type: 'patch', sectionId: 'html_publish', expectedSectionRevision: 0,
	patch: {
		pbiPublishInfo: publishInfo,
	},
};

const compensatePublishCommand = {
	type: 'patch', sectionId: 'html_publish', expectedSectionRevision: 1,
	patch: { pbiPublishInfo: null },
};

const appliedTerminal = {
	ok: true, documentRevision: 1, sectionRevision: 1,
	projection: publishProjection(1, 1, publishInfo),
};

const compensatedTerminal = {
	ok: true, documentRevision: 2, sectionRevision: 2,
	projection: publishProjection(2, 2),
};

const restorePreviousPublishCommand = {
	type: 'patch', sectionId: 'html_publish', expectedSectionRevision: 1,
	patch: { pbiPublishInfo: previousPublishInfo },
};

const restoredPreviousTerminal = {
	ok: true, documentRevision: 2, sectionRevision: 2,
	projection: publishProjection(2, 2, previousPublishInfo),
};

describe('QueryEditorProvider Power BI publish help notification', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		powerBiPublishMocks.publishToPowerBIService.mockReset();
	});

	it('opens the Kusto Workbench fix prompt when the notification action is selected', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Fix it using Kusto Workbench' as any);

		await provider.showPowerBiPublishHelp({
			type: 'showPowerBiPublishHelp',
			requestId: 'publish-help-1',
			sectionId: 'html_publish_help',
			sectionName: 'Publish Help Dashboard',
			targetVersion: 1,
			reasons: ['Missing application/kw-provenance block.'],
		});

		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining('query-backed data bindings for Publish Help Dashboard'),
			'Fix it using Kusto Workbench',
		);
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'powerBiPublishHelpResult',
			requestId: 'publish-help-1',
			boxId: 'html_publish_help',
			action: 'fixWithKustoWorkbench',
		});
		expect(provider.requestHtmlDashboardUpgradeWithCopilot).not.toHaveBeenCalled();
	});

	it('aborts and retires only the exact dashboard workflow request', () => {
		const provider = createProviderHarness();
		const first = provider.beginDashboardWorkflow('dashboard-request-1') as AbortController;
		const second = provider.beginDashboardWorkflow('dashboard-request-2') as AbortController;

		provider.cancelDashboardWorkflow('dashboard-request-1');

		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		expect(provider.dashboardWorkflowAbortControllers.has('dashboard-request-1')).toBe(false);
		expect(provider.isDashboardWorkflowCurrent('dashboard-request-2', second)).toBe(true);
	});

	it('cleans up newly created Fabric items when the workflow retires after commit', async () => {
		const provider = createProviderHarness();
		const cleanupCreatedItems = vi.fn(async () => true);
		let resolvePublish!: (result: Record<string, unknown>) => void;
		powerBiPublishMocks.publishToPowerBIService.mockReturnValue(new Promise(resolve => {
			resolvePublish = resolve;
		}));
		const message = {
			type: 'publishToPowerBI', requestId: 'publish-retired-after-commit', boxId: 'html_publish',
			workspaceId: 'workspace-1', reportName: 'Dashboard', pageWidth: 1280, pageHeight: 720,
			htmlCode: '<main></main>', dataSources: [], dataMode: 'import',
		};

		const publishing = provider.publishToPowerBIFromWebview(message);
		await Promise.resolve();
		provider.cancelDashboardWorkflow(message.requestId);
		resolvePublish({
			reportUrl: 'https://app.powerbi.com/report', scheduleConfigured: true,
			dataMode: 'import', semanticModelId: 'model-created', reportId: 'report-created',
			createdNewItems: true, cleanupCreatedItems,
		});
		await publishing;

		expect(cleanupCreatedItems).toHaveBeenCalledOnce();
		expect(provider.postMessage).not.toHaveBeenCalled();
	});

	it('keeps created-item cleanup authority until application acknowledgment', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		provider.pendingPowerBiPublishAcks.set('publish-ack', publishLease(cleanup, 'applied'));

		await provider.acceptPowerBiPublishAck('publish-ack', true);

		expect(cleanup).not.toHaveBeenCalled();
		expect(provider.pendingPowerBiPublishAcks.has('publish-ack')).toBe(false);
	});

	it('compensates created items when application acknowledgment rejects', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		provider.pendingPowerBiPublishAcks.set('publish-nack', publishLease(cleanup));

		await provider.acceptPowerBiPublishAck('publish-nack', false);

		expect(cleanup).toHaveBeenCalledOnce();
		expect(provider.pendingPowerBiPublishAcks.has('publish-nack')).toBe(false);
	});

	it('releases cleanup authority from the authoritative document commit without webview ack', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		provider.pendingPowerBiPublishAcks.set('publish-host-commit', publishLease(cleanup));
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-host-commit', 'apply', applyPublishCommand, 0, publishProjection(0, 0),
		)).toBe(true);

		await provider.settlePowerBiPublishDocumentApplication('publish-host-commit', 'apply', appliedTerminal);
		await provider.acceptPowerBiPublishAck('publish-host-commit', true);

		expect(cleanup).not.toHaveBeenCalled();
		expect(provider.pendingPowerBiPublishAcks.has('publish-host-commit')).toBe(false);
	});

	it('defers cleanup through an in-flight apply until compensation commits', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		provider.pendingPowerBiPublishAcks.set('publish-interleaving', publishLease(cleanup));
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-interleaving', 'apply', applyPublishCommand, 0, publishProjection(0, 0),
		)).toBe(true);

		await provider.acceptPowerBiPublishAck('publish-interleaving', false);
		expect(cleanup).not.toHaveBeenCalled();
		expect(provider.pendingPowerBiPublishAcks.get('publish-interleaving')?.applicationState).toBe('apply-in-flight');

		await provider.settlePowerBiPublishDocumentApplication('publish-interleaving', 'apply', appliedTerminal);
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-interleaving', 'compensate', compensatePublishCommand, 1,
			publishProjection(1, 1, publishInfo),
		)).toBe(true);
		await provider.settlePowerBiPublishDocumentApplication(
			'publish-interleaving', 'compensate', compensatedTerminal,
		);

		expect(cleanup).toHaveBeenCalledOnce();
		expect(provider.pendingPowerBiPublishAcks.has('publish-interleaving')).toBe(false);
	});

	it('rejects misrouted publish application commands before changing lease state', () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		provider.pendingPowerBiPublishAcks.set('publish-routed', publishLease(cleanup));

		expect(provider.beginPowerBiPublishDocumentApplication('publish-routed', 'apply', {
			type: 'patch', sectionId: 'markdown_1', patch: { text: 'wrong' },
		}, 0, publishProjection(0, 0))).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication('publish-routed', 'apply', {
			...applyPublishCommand, sectionId: 'other_html',
		}, 0, publishProjection(0, 0))).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication('publish-routed', 'apply', {
			...applyPublishCommand,
			patch: { pbiPublishInfo: { ...applyPublishCommand.patch.pbiPublishInfo, reportId: 'wrong-report' } },
		}, 0, publishProjection(0, 0))).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication('publish-routed', 'apply', {
			...applyPublishCommand,
			patch: { pbiPublishInfo: { ...applyPublishCommand.patch.pbiPublishInfo, reportName: 'Wrong dashboard' } },
		}, 0, publishProjection(0, 0))).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-routed', 'apply', applyPublishCommand, 0, wrongKindProjection(),
		)).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-routed', 'apply', applyPublishCommand, 1, publishProjection(0, 0),
		)).toBe(false);
		expect(provider.pendingPowerBiPublishAcks.get('publish-routed')?.applicationState).toBe('idle');
	});

	it('rejects compensation against an intervening revision or same-ID replacement', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		provider.pendingPowerBiPublishAcks.set('publish-cas', publishLease(cleanup));
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-cas', 'apply', applyPublishCommand, 0, publishProjection(0, 0),
		)).toBe(true);
		await provider.settlePowerBiPublishDocumentApplication('publish-cas', 'apply', appliedTerminal);

		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-cas', 'compensate', { ...compensatePublishCommand, expectedSectionRevision: 2 }, 2,
			publishProjection(2, 2, publishInfo),
		)).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-cas', 'compensate', compensatePublishCommand, 1, wrongKindProjection(),
		)).toBe(false);
		expect(provider.pendingPowerBiPublishAcks.get('publish-cas')?.applicationState).toBe('applied');
	});

	it('restores exact pre-existing publish metadata when publish-as-new retires after apply', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		provider.pendingPowerBiPublishAcks.set('publish-restore-old', publishLease(cleanup));
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-restore-old', 'apply', applyPublishCommand, 0,
			publishProjection(0, 0, previousPublishInfo),
		)).toBe(true);
		await provider.settlePowerBiPublishDocumentApplication(
			'publish-restore-old', 'apply', appliedTerminal,
		);

		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-restore-old', 'compensate', compensatePublishCommand, 1,
			publishProjection(1, 1, publishInfo),
		)).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-restore-old', 'compensate', {
				...restorePreviousPublishCommand,
				patch: { pbiPublishInfo: { ...previousPublishInfo, reportId: 'wrong-old-report' } },
			}, 1, publishProjection(1, 1, publishInfo),
		)).toBe(false);
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-restore-old', 'compensate', restorePreviousPublishCommand, 1,
			publishProjection(1, 1, publishInfo),
		)).toBe(true);
		await provider.acceptPowerBiPublishAck('publish-restore-old', false);
		await provider.settlePowerBiPublishDocumentApplication(
			'publish-restore-old', 'compensate', restoredPreviousTerminal,
		);

		expect(cleanup).toHaveBeenCalledOnce();
		expect(provider.pendingPowerBiPublishAcks.has('publish-restore-old')).toBe(false);
	});

	it('delegates native cleanup to the authoritative projection admission', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		const cleanupAdmission = vi.fn(async (
			_info: unknown, _cleanup: () => Promise<boolean>, waitForPending: boolean,
		) => waitForPending);
		provider.setPowerBiPublishCleanupAdmission(cleanupAdmission);
		provider.pendingPowerBiPublishAcks.set('publish-native-cleanup', publishLease(cleanup));

		await provider.acceptPowerBiPublishAck('publish-native-cleanup', false);

		expect(cleanupAdmission).toHaveBeenCalledOnce();
		expect(cleanupAdmission.mock.calls[0][2]).toBe(true);
		expect(cleanup).not.toHaveBeenCalled();
		expect(provider.pendingPowerBiPublishAcks.has('publish-native-cleanup')).toBe(false);
	});

	it('waits through apply before native cleanup finalization enters the queue', async () => {
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		const cleanupAdmission = vi.fn(async () => true);
		provider.setPowerBiPublishCleanupAdmission(cleanupAdmission);
		provider.pendingPowerBiPublishAcks.set('publish-native-interleaving', publishLease(cleanup));
		expect(provider.beginPowerBiPublishDocumentApplication(
			'publish-native-interleaving', 'apply', applyPublishCommand, 0, publishProjection(0, 0),
		)).toBe(true);

		await provider.acceptPowerBiPublishAck('publish-native-interleaving', false);
		expect(cleanupAdmission).not.toHaveBeenCalled();
		await provider.settlePowerBiPublishDocumentApplication(
			'publish-native-interleaving', 'apply', appliedTerminal,
		);
		expect(cleanupAdmission).not.toHaveBeenCalled();
		expect(provider.pendingPowerBiPublishAcks.get('publish-native-interleaving')?.applicationState).toBe('applied');
	});

	it('suppresses a publish-help choice after exact workflow cancellation', async () => {
		const provider = createProviderHarness();
		let resolveSelection!: (selection: string | undefined) => void;
		vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(new Promise(resolve => {
			resolveSelection = resolve as (selection: string | undefined) => void;
		}) as any);

		const prompt = provider.showPowerBiPublishHelp({
			type: 'showPowerBiPublishHelp', requestId: 'publish-help-cancel',
			sectionId: 'html_publish_help',
		});
		await Promise.resolve();
		provider.cancelDashboardWorkflow('publish-help-cancel');
		resolveSelection('Fix it using Kusto Workbench');
		await prompt;

		expect(provider.postMessage).not.toHaveBeenCalled();
	});

	it('suppresses a partial-publish choice after exact workflow cancellation', async () => {
		const provider = createProviderHarness();
		let resolveSelection!: (selection: string | undefined) => void;
		vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(new Promise(resolve => {
			resolveSelection = resolve as (selection: string | undefined) => void;
		}) as any);

		const prompt = provider.showPowerBiPartialPublishWarning({
			type: 'showPowerBiPartialPublishWarning', requestId: 'partial-publish-cancel',
			sectionId: 'html_partial',
		});
		await Promise.resolve();
		provider.cancelDashboardWorkflow('partial-publish-cancel');
		resolveSelection('Publish anyway');
		await prompt;

		expect(provider.postMessage).not.toHaveBeenCalled();
	});

	it('does not open the fix prompt when the notification is dismissed', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

		await provider.showPowerBiPublishHelp({
			type: 'showPowerBiPublishHelp',
			requestId: 'publish-help-2',
			sectionId: 'html_publish_help',
		});

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'powerBiPublishHelpResult',
			requestId: 'publish-help-2',
			boxId: 'html_publish_help',
			action: 'dismissed',
		});
		expect(provider.requestHtmlDashboardUpgradeWithCopilot).not.toHaveBeenCalled();
	});

	it('builds a prompt with the originating section and every supplied issue reason', () => {
		const provider = createProviderHarness();

		const prompt = provider.buildHtmlDashboardUpgradePrompt({
			type: 'requestHtmlDashboardUpgradeWithCopilot',
			sectionId: 'html_invalid_pie_chart_spec',
			sectionName: 'Invalid pie chart spec',
			targetVersion: 1,
			reasons: [
				'invalid-pie (pie: invalid chart spec: missing value)',
				'No query-backed data sources were available for Power BI publish.',
				'Run the referenced query section (query_fact) so Kusto Workbench can package its query and result schema for Power BI.',
			],
		});

		expect(prompt).toContain('Upgrade HTML section Invalid pie chart spec (html_invalid_pie_chart_spec)');
		expect(prompt).toContain('- invalid-pie (pie: invalid chart spec: missing value)');
		expect(prompt).toContain('- No query-backed data sources were available for Power BI publish.');
		expect(prompt).toContain('- Run the referenced query section (query_fact)');
		expect(prompt).toContain('Make the dashboard 100% compatible with Power BI exporting before publishing.');
		expect(prompt).not.toContain('Invalid bar chart spec');
		expect(prompt).not.toContain('html_invalid_bar_chart_spec');
	});

	it('continues publish when a partial-publish warning selects Publish anyway', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Publish anyway' as any);

		await provider.showPowerBiPartialPublishWarning({
			type: 'showPowerBiPartialPublishWarning',
			requestId: 'request-1',
			sectionId: 'html_partial',
			sectionName: 'Partial Dashboard',
			targetVersion: 1,
			reasons: ['Potential preview-only data-role rendering detected.'],
		});

		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining('cannot fully reproduce'),
			'Publish anyway',
			'Fix with Kusto Workbench',
		);
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'powerBiPartialPublishWarningResult',
			boxId: 'html_partial',
			requestId: 'request-1',
			action: 'publishAnyway',
		});
		expect(provider.requestHtmlDashboardUpgradeWithCopilot).not.toHaveBeenCalled();
	});

	it('opens the full compatibility fix prompt when a partial-publish warning selects Fix with Kusto Workbench', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Fix with Kusto Workbench' as any);

		await provider.showPowerBiPartialPublishWarning({
			type: 'showPowerBiPartialPublishWarning',
			requestId: 'request-2',
			sectionId: 'html_partial',
			sectionName: 'Partial Dashboard',
			targetVersion: 1,
			reasons: ['Potential preview-only data-role rendering detected.'],
		});

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'powerBiPartialPublishWarningResult',
			boxId: 'html_partial',
			requestId: 'request-2',
			action: 'fixWithKustoWorkbench',
		});
		expect(provider.requestHtmlDashboardUpgradeWithCopilot).not.toHaveBeenCalled();
	});

	it('clears pending partial-publish requests when the notification is dismissed', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

		await provider.showPowerBiPartialPublishWarning({
			type: 'showPowerBiPartialPublishWarning',
			requestId: 'request-3',
			sectionId: 'html_partial',
		});

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'powerBiPartialPublishWarningResult',
			boxId: 'html_partial',
			requestId: 'request-3',
			action: 'dismissed',
		});
		expect(provider.requestHtmlDashboardUpgradeWithCopilot).not.toHaveBeenCalled();
	});

	it('opens GitHub Issues when unsupported visual notification action is selected', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Ask for it' as any);
		const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true as any);

		await provider.showPowerBiUnsupportedVisualHelp({
			type: 'showPowerBiUnsupportedVisualHelp',
			requestId: 'unsupported-help-1',
			message: 'Power BI export does not support heatmap visuals yet. Ask for support for this chart type; it will be added once the owner knows people need it.',
		});

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining('Ask for support for this chart type'),
			'Ask for it',
		);
		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(openExternal.mock.calls[0][0].toString()).toBe('https://github.com/AngelosP/vscode-kusto-workbench/issues');
	});

	it('does not open GitHub after unsupported-help cancellation', async () => {
		const provider = createProviderHarness();
		let resolveSelection!: (selection: string | undefined) => void;
		vi.spyOn(vscode.window, 'showInformationMessage').mockReturnValue(new Promise(resolve => {
			resolveSelection = resolve as (selection: string | undefined) => void;
		}) as any);
		const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true as any);

		const prompt = provider.showPowerBiUnsupportedVisualHelp({
			type: 'showPowerBiUnsupportedVisualHelp', requestId: 'unsupported-help-cancel',
			message: 'Unsupported visual',
		});
		await Promise.resolve();
		provider.cancelDashboardWorkflow('unsupported-help-cancel');
		resolveSelection('Ask for it');
		await prompt;

		expect(openExternal).not.toHaveBeenCalled();
	});
});
