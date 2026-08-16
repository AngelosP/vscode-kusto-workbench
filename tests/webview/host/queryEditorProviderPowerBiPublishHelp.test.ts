import { describe, expect, it, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';

const powerBiPublishMocks = vi.hoisted(() => ({
	publishToPowerBIService: vi.fn(),
	listFabricWorkspaces: vi.fn(),
	checkFabricItemExists: vi.fn(),
}));

vi.mock('../../../src/host/powerBiPublish', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/powerBiPublish')>(),
	publishToPowerBIService: powerBiPublishMocks.publishToPowerBIService,
	listFabricWorkspaces: powerBiPublishMocks.listFabricWorkspaces,
	checkFabricItemExists: powerBiPublishMocks.checkFabricItemExists,
}));

import { HostDashboardApplicationHandler } from '../../../src/host/dashboardApplicationHandler';

function createProviderHarness() {
	const postMessage = vi.fn(() => Promise.resolve(true));
	const output = { error: vi.fn(), warn: vi.fn() };
	const connectionManager = {
		isLeaveNoTrace: () => false,
		runWithLeaveNoTraceSnapshotLock: async (run: (snapshot: unknown) => unknown) => run({
			clusterKeys: [], globallyBlocked: false, version: 0, revocationGenerations: {},
		}),
	};
	const provider = new HostDashboardApplicationHandler({
		postMessage,
		isDisposed: () => provider._panelDisposed,
		output: output as never,
		connectionManager: connectionManager as never,
	}) as HostDashboardApplicationHandler & Record<string, any>;
	provider._panelDisposed = false;
	provider.output = output;
	provider.requestHtmlDashboardUpgradeWithCopilot = vi.fn(async () => undefined);
	provider.postMessage = postMessage;
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

const validPublishHtmlCode = `<script type="application/kw-provenance">${JSON.stringify({
	version: 1,
	model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
	bindings: {
		'total-actions': { display: { type: 'scalar', agg: 'COUNT' } },
	},
})}</script><span data-kw-bind="total-actions"></span>`;

function validPublishDataSources() {
	return [{
		name: 'Fact Events',
		sectionId: 'query_fact',
		clusterUrl: 'https://cluster.kusto.windows.net',
		database: 'db',
		query: 'FactEvents',
		columns: [{ name: 'ActionCount', type: 'long' }],
	}];
}

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

describe('HostDashboardApplicationHandler Power BI workflows', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		powerBiPublishMocks.publishToPowerBIService.mockReset();
		powerBiPublishMocks.listFabricWorkspaces.mockReset();
		powerBiPublishMocks.checkFabricItemExists.mockReset();
	});

	it('declines unrelated provider messages synchronously', () => {
		const provider = createProviderHarness();

		expect(provider.handleMessage({ type: 'showInfo', message: 'Unrelated' })).toBeUndefined();
		expect(provider.postMessage).not.toHaveBeenCalled();
	});

	it('returns correlated workspace and item-existence responses', async () => {
		const provider = createProviderHarness();
		powerBiPublishMocks.listFabricWorkspaces.mockResolvedValue([
			{ id: 'workspace-1', name: 'Analytics', isPersonal: false },
		]);
		powerBiPublishMocks.checkFabricItemExists.mockResolvedValue(true);

		await provider.handleMessage({
			type: 'getPbiWorkspaces', requestId: 'workspaces-1', boxId: 'html_publish',
		});
		await provider.handleMessage({
			type: 'checkPbiItemExists', requestId: 'exists-1', boxId: 'html_publish',
			workspaceId: 'workspace-1', reportId: 'report-1',
		});

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'pbiWorkspacesResult', requestId: 'workspaces-1', boxId: 'html_publish',
			ok: true, workspaces: [{ id: 'workspace-1', name: 'Analytics', isPersonal: false }],
		});
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'pbiItemExistsResult', requestId: 'exists-1', boxId: 'html_publish', exists: true,
		});
	});

	it('rejects malformed provenance before empty-source PBIP handling or filesystem writes', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(vscode.Uri.file('C:/tmp/malformed.pbip'));
		const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');

		await provider.handleMessage({
			type: 'exportDashboard', requestId: 'export-malformed', boxId: 'html_publish',
			html: '<script type="application/kw-provenance">{broken</script><main>Dashboard</main>',
			suggestedFileName: 'Malformed', dataSources: [],
		});

		expect(showWarningMessage).not.toHaveBeenCalledWith(expect.stringContaining('No data bindings found'));
		expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Dashboard provenance contains invalid JSON.'));
		expect(createDirectory).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('returns the unchanged successful publish response and retains its application lease until ack', async () => {
		const provider = createProviderHarness();
		powerBiPublishMocks.publishToPowerBIService.mockResolvedValue({
			reportUrl: 'https://app.powerbi.com/report', scheduleConfigured: true,
			initialRefreshTriggered: false, dataMode: 'import',
			semanticModelId: 'model-created', reportId: 'report-created', createdNewItems: false,
		});
		const message = {
			type: 'publishToPowerBI' as const, requestId: 'publish-success', boxId: 'html_publish',
			workspaceId: 'workspace-1', workspaceName: 'Analytics', reportName: 'Dashboard',
			pageWidth: 1280, pageHeight: 720,
			htmlCode: validPublishHtmlCode, dataSources: validPublishDataSources(),
			dataMode: 'import' as const,
		};

		await provider.handleMessage(message);

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'publishToPowerBIResult', requestId: 'publish-success', boxId: 'html_publish', ok: true,
			reportUrl: 'https://app.powerbi.com/report', scheduleConfigured: true,
			initialRefreshTriggered: false, dataMode: 'import',
			semanticModelId: 'model-created', reportId: 'report-created',
			workspaceId: 'workspace-1', reportName: 'Dashboard', workspaceName: 'Analytics',
		});
		expect(provider.pendingPowerBiPublishAcks.has('publish-success')).toBe(true);

		await provider.handleMessage({
			type: 'publishToPowerBIAck', requestId: 'publish-success', accepted: true,
		});
		expect(provider.pendingPowerBiPublishAcks.has('publish-success')).toBe(false);
	});

	it('publishes unchanged optional DirectQuery refresh fields', async () => {
		const provider = createProviderHarness();
		powerBiPublishMocks.publishToPowerBIService.mockResolvedValue({
			reportUrl: 'https://app.powerbi.com/direct-query', scheduleConfigured: true,
			dataMode: 'directQuery', semanticModelId: 'model-existing',
			reportId: 'report-existing', createdNewItems: false,
		});

		await provider.handleMessage({
			type: 'publishToPowerBI', requestId: 'publish-direct-query', boxId: 'html_publish',
			workspaceId: 'workspace-1', reportName: 'Dashboard', pageWidth: 1280, pageHeight: 720,
			htmlCode: validPublishHtmlCode, dataSources: validPublishDataSources(),
			dataMode: 'directQuery', semanticModelId: 'model-existing', reportId: 'report-existing',
		});

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'publishToPowerBIResult', requestId: 'publish-direct-query',
			boxId: 'html_publish', ok: true,
			reportUrl: 'https://app.powerbi.com/direct-query', scheduleConfigured: true,
			initialRefreshTriggered: undefined, dataMode: 'directQuery',
			semanticModelId: 'model-existing', reportId: 'report-existing',
			workspaceId: 'workspace-1', reportName: 'Dashboard', workspaceName: undefined,
		});

		await provider.handleMessage({
			type: 'publishToPowerBIAck', requestId: 'publish-direct-query', accepted: true,
		});
		expect(provider.pendingPowerBiPublishAcks.has('publish-direct-query')).toBe(false);
	});

	it('keeps the exact created-item application lease and timer live until a canonical acknowledgment', async () => {
		vi.useFakeTimers();
		const provider = createProviderHarness();
		const cleanupCreatedItems = vi.fn(async () => true);
		powerBiPublishMocks.publishToPowerBIService.mockResolvedValue({
			reportUrl: 'https://app.powerbi.com/report', scheduleConfigured: true,
			initialRefreshTriggered: false, dataMode: 'import',
			semanticModelId: 'model-created', reportId: 'report-created', createdNewItems: true,
			cleanupCreatedItems,
		});

		await provider.handleMessage({
			type: 'publishToPowerBI', requestId: 'publish-canonical-ack', boxId: 'html_publish',
			workspaceId: 'workspace-1', workspaceName: 'Analytics', reportName: 'Dashboard',
			pageWidth: 1280, pageHeight: 720,
			htmlCode: validPublishHtmlCode, dataSources: validPublishDataSources(), dataMode: 'import',
		});

		const lease = provider.pendingPowerBiPublishAcks.get('publish-canonical-ack');
		expect(lease).toBeDefined();
		const timer = lease.timer;
		expect(vi.getTimerCount()).toBe(1);

		await provider.handleMessage({
			type: 'publishToPowerBIAck', requestId: 'publish-canonical-ack', accepted: 'yes',
		} as never);

		expect(provider.pendingPowerBiPublishAcks.get('publish-canonical-ack')).toBe(lease);
		expect(lease.cleanupRequested).toBe(false);
		expect(lease.finalizationInProgress).toBe(false);
		expect(lease.timer).toBe(timer);
		expect(cleanupCreatedItems).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(14_999);
		expect(provider.pendingPowerBiPublishAcks.get('publish-canonical-ack')).toBe(lease);
		expect(lease.timer).toBe(timer);
		expect(cleanupCreatedItems).not.toHaveBeenCalled();

		await provider.handleMessage({
			type: 'publishToPowerBIAck', requestId: 'publish-canonical-ack', accepted: true,
		});

		expect(provider.pendingPowerBiPublishAcks.has('publish-canonical-ack')).toBe(false);
		expect(cleanupCreatedItems).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('expires an unacknowledged created-item lease at exactly 15 seconds', async () => {
		vi.useFakeTimers();
		const provider = createProviderHarness();
		const cleanupCreatedItems = vi.fn(async () => true);
		powerBiPublishMocks.publishToPowerBIService.mockResolvedValue({
			reportUrl: 'https://app.powerbi.com/report', scheduleConfigured: true,
			initialRefreshTriggered: false, dataMode: 'import',
			semanticModelId: 'model-created', reportId: 'report-created', createdNewItems: true,
			cleanupCreatedItems,
		});

		await provider.handleMessage({
			type: 'publishToPowerBI', requestId: 'publish-timeout', boxId: 'html_publish',
			workspaceId: 'workspace-1', reportName: 'Dashboard', pageWidth: 1280, pageHeight: 720,
			htmlCode: validPublishHtmlCode, dataSources: validPublishDataSources(), dataMode: 'import',
		});

		const lease = provider.pendingPowerBiPublishAcks.get('publish-timeout');
		expect(lease).toBeDefined();
		await vi.advanceTimersByTimeAsync(14_999);
		expect(provider.pendingPowerBiPublishAcks.get('publish-timeout')).toBe(lease);
		expect(cleanupCreatedItems).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(provider.pendingPowerBiPublishAcks.has('publish-timeout')).toBe(false);
		expect(cleanupCreatedItems).toHaveBeenCalledOnce();
	});

	it('rearms an applied rejection for exactly five seconds without cleanup', async () => {
		vi.useFakeTimers();
		const provider = createProviderHarness();
		const cleanup = vi.fn(async () => true);
		const lease = publishLease(cleanup, 'applied');
		const originalTimer = lease.timer;
		provider.pendingPowerBiPublishAcks.set('publish-rearm', lease);

		await provider.handleMessage({
			type: 'publishToPowerBIAck', requestId: 'publish-rearm', accepted: false,
		});

		expect(provider.pendingPowerBiPublishAcks.get('publish-rearm')).toBe(lease);
		expect(lease.cleanupRequested).toBe(true);
		expect(lease.timer).not.toBe(originalTimer);
		expect(cleanup).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(provider.pendingPowerBiPublishAcks.get('publish-rearm')).toBe(lease);
		expect(cleanup).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(provider.pendingPowerBiPublishAcks.has('publish-rearm')).toBe(false);
		expect(cleanup).not.toHaveBeenCalled();
	});

	it('rejects inadmissible publish before Leave No Trace policy or publish service effects', async () => {
		const provider = createProviderHarness();
		const isLeaveNoTrace = vi.spyOn(provider.options.connectionManager, 'isLeaveNoTrace');
		const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');

		await provider.handleMessage({
			type: 'publishToPowerBI', requestId: 'publish-invalid', boxId: 'html_publish',
			workspaceId: 'workspace-1', reportName: 'Invalid dashboard',
			pageWidth: 1280, pageHeight: 720, htmlCode: '<main>Preview only</main>',
			dataSources: validPublishDataSources(), dataMode: 'import',
		});

		expect(isLeaveNoTrace).not.toHaveBeenCalled();
		expect(showWarningMessage).not.toHaveBeenCalled();
		expect(powerBiPublishMocks.publishToPowerBIService).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'publishToPowerBIResult', requestId: 'publish-invalid',
			boxId: 'html_publish', ok: false,
			error: expect.stringContaining(
				'Missing application/kw-provenance block. Ask Kusto Workbench to make this dashboard exportable to Power BI.',
			),
		});
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
		const first = provider.beginWorkflow('dashboard-request-1') as AbortController;
		const second = provider.beginWorkflow('dashboard-request-2') as AbortController;

		provider.cancelWorkflow('dashboard-request-1');

		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(false);
		expect(provider.dashboardWorkflowAbortControllers.has('dashboard-request-1')).toBe(false);
		expect(provider.isWorkflowCurrent('dashboard-request-2', second)).toBe(true);
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
			htmlCode: validPublishHtmlCode, dataSources: validPublishDataSources(), dataMode: 'import',
		};

		const publishing = provider.publishToPowerBI(message);
		await Promise.resolve();
		provider.cancelWorkflow(message.requestId);
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
		provider.cancelWorkflow('publish-help-cancel');
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
		provider.cancelWorkflow('partial-publish-cancel');
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

});
