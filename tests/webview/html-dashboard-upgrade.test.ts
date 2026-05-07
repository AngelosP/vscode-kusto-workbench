import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'lit';
import { KwHtmlSection, type PbiPublishInfo } from '../../src/webview/sections/kw-html-section';
import {
	CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
	analyzeHtmlDashboardPowerBiCompatibility,
	findUnsupportedPowerBiBindings,
	parseKwProvenance,
} from '../../src/shared/htmlDashboardUpgrade';

function provenanceHtml(bindings: Record<string, unknown>, body = ''): string {
	return `<script type="application/kw-provenance">${JSON.stringify({
		version: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
		model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
		bindings,
	})}</script>${body}`;
}

function pbiInfo(): PbiPublishInfo {
	return {
		workspaceId: 'workspace-1',
		semanticModelId: 'semantic-model-1',
		reportId: 'report-1',
		reportName: 'Report',
		reportUrl: 'https://powerbi.example/reports/report-1',
	};
}

function fixableTableTargetHtml(): string {
	return provenanceHtml(
		{
			'top-table': {
				display: {
					type: 'table',
					groupBy: ['OS'],
					columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }],
				},
			},
		},
		'<div data-kw-bind="top-table"></div>',
	);
}

describe('htmlDashboardUpgrade shared analyzer', () => {
	it('parses Kusto Workbench provenance from HTML', () => {
		const parsed = parseKwProvenance(provenanceHtml({ total: { display: { type: 'scalar', agg: 'COUNT' } } }));

		expect(parsed?.version).toBe(CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION);
		expect(parsed?.model.fact.sectionId).toBe('query_fact');
		expect(Object.keys(parsed?.bindings ?? {})).toEqual(['total']);
	});

	it('reports missing provenance when a caller has already determined Power BI relevance', () => {
		const status = analyzeHtmlDashboardPowerBiCompatibility('<main>Published dashboard</main>');

		expect(status.needsUpgrade).toBe(true);
		expect(status.reasons.join('\n')).toContain('Missing application/kw-provenance');
	});

	it('reports unsupported rendered Power BI display bindings', () => {
		const status = analyzeHtmlDashboardPowerBiCompatibility(provenanceHtml(
			{ heat: { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Requests' } } },
			'<div data-kw-bind="heat"></div>',
		));

		expect(status.needsUpgrade).toBe(true);
		expect(status.reasons).toContain('heat (heatmap)');
	});

	it('reports target-shape blockers before export or publish is attempted', () => {
		const html = fixableTableTargetHtml();

		expect(findUnsupportedPowerBiBindings(html)).toEqual(['top-table (table: target must be table or tbody inside table)']);
		expect(analyzeHtmlDashboardPowerBiCompatibility(html).reasons).toContain('top-table (table: target must be table or tbody inside table)');
	});

	it('reports the missing field for invalid chart display specs', () => {
		const status = analyzeHtmlDashboardPowerBiCompatibility(provenanceHtml(
			{
				'invalid-pie': { display: { type: 'pie', groupBy: 'State' } },
				'invalid-bar': { display: { type: 'bar', groupBy: 'State' } },
				'invalid-bar-sum': { display: { type: 'bar', groupBy: 'State', value: { agg: 'SUM' } } },
			},
			'<div data-kw-bind="invalid-pie"></div><div data-kw-bind="invalid-bar"></div><div data-kw-bind="invalid-bar-sum"></div>',
		));

		expect(status.reasons).toContain('invalid-pie (pie: invalid chart spec: missing value)');
		expect(status.reasons).toContain('invalid-bar (bar: invalid chart spec: missing value)');
		expect(status.reasons).toContain('invalid-bar-sum (bar: invalid chart spec: missing value column)');
	});

	it('reports preview-only data-role rendering as a partial Power BI export issue', () => {
		const status = analyzeHtmlDashboardPowerBiCompatibility(provenanceHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			`<main>
				<div data-kw-bind="total"></div>
				<div data-role="heatmap"></div>
				<script>
					KustoWorkbench.onDataReady(function () {
						document.currentScript.closest('main').querySelector('[data-role="heatmap"]').innerHTML = '<button>Manual cell</button>';
					});
				</script>
			</main>`,
		));

		expect(status.needsUpgrade).toBe(true);
		expect(status.reasons.join('\n')).toContain('Potential preview-only data-role rendering detected');
	});
});

describe('KwHtmlSection Power BI upgrade relevance gate', () => {
	let capturedMessages: unknown[];

	beforeEach(() => {
		capturedMessages = [];
		(window as Window & typeof globalThis & { __e2eCaptureHostMessage?: (message: unknown) => void }).__e2eCaptureHostMessage = message => {
			capturedMessages.push(message);
		};
	});

	afterEach(() => {
		delete (window as Window & typeof globalThis & { __e2eCaptureHostMessage?: (message: unknown) => void }).__e2eCaptureHostMessage;
	});

	it('does not check pure JavaScript dashboards that use bindHtml without Power BI export enablement', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_pure_js';
		section.setCode('<script>KustoWorkbench.bindHtml("chart", () => "<svg></svg>");</script><main id="chart"></main>');

		expect(section.isPowerBiCompatibilityCheckEnabled()).toBe(false);
		expect(section.evaluatePowerBiCompatibilityNotice()).toBeUndefined();
	});

	it('does not check provenance with zero bindings unless publish metadata exists', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_zero_bindings';
		section.setCode(provenanceHtml({}));

		expect(section.isPowerBiCompatibilityCheckEnabled()).toBe(false);
		expect(section.evaluatePowerBiCompatibilityNotice()).toBeUndefined();
	});

	it('checks old published sections even when the upload button is disabled by missing bindings', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_published_missing_contract';
		section.setPbiPublishInfo(pbiInfo());
		section.setCode('<main>Old published dashboard</main>');

		expect(section.isPowerBiCompatibilityCheckEnabled()).toBe(true);
		const status = section.evaluatePowerBiCompatibilityNotice();
		expect(status?.needsUpgrade).toBe(true);
		expect(status?.reasons.join('\n')).toContain('Missing application/kw-provenance');
	});

	it('checks fixable upload-enabled sections and posts an upgrade request to the host', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_upgrade_me';
		section.setName('Dashboard');
		section.setCode(fixableTableTargetHtml());

		const status = section.evaluatePowerBiCompatibilityNotice();
		expect(status?.needsUpgrade).toBe(true);
		(section as unknown as { _requestPowerBiUpgradeWithCopilot(): void })._requestPowerBiUpgradeWithCopilot();

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({
			type: 'requestHtmlDashboardUpgradeWithCopilot',
			sectionId: 'html_upgrade_me',
			sectionName: 'Dashboard',
			targetVersion: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
			reasons: ['top-table (table: target must be table or tbody inside table)'],
		});
	});

	it('summarizes Power BI notice reasons without raw analyzer text', () => {
		const section = new KwHtmlSection();
		const noticeText = (section as unknown as { _getPowerBiUpgradeNoticeText(reasons: string[]): { title: string; detail: string } })
			._getPowerBiUpgradeNoticeText(['top-table (table: target must be table or tbody inside table)']);

		expect(noticeText.title).toBe('Power BI export needs an update');
		expect(noticeText.detail).toBe('Some dashboard content is not connected to exportable Power BI elements.');
		expect(noticeText.detail).not.toContain('top-table (table: target must be table or tbody inside table)');
	});

	it('gives the Power BI notice close button its own native tooltip', () => {
		const section = new KwHtmlSection();
		section.setCode(fixableTableTargetHtml());
		section.evaluatePowerBiCompatibilityNotice();

		const container = document.createElement('div');
		render((section as unknown as { _renderPowerBiUpgradeNotice(): unknown })._renderPowerBiUpgradeNotice(), container);

		const closeButton = container.querySelector('.power-bi-upgrade-close');
		expect(closeButton?.getAttribute('title')).toBe('Dismiss Power BI export notification');
		expect(closeButton?.getAttribute('aria-label')).toBe('Dismiss Power BI export notification');
	});

	it('does not offer a passive update for unsupported display bindings and explains the publish block', async () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_unsupported_heatmap';
		section.setCode(provenanceHtml(
			{ heat: { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Requests' } } },
			'<div data-kw-bind="heat"></div>',
		));

		expect(section.isPowerBiCompatibilityCheckEnabled()).toBe(false);
		expect(section.evaluatePowerBiCompatibilityNotice()).toBeUndefined();

		const container = document.createElement('div');
		render((section as unknown as { _renderToolbar(): unknown })._renderToolbar(), container);
		const uploadButton = container.querySelector<HTMLButtonElement>('button[aria-label="Publish to Power BI service"]');
		expect(uploadButton).toBeTruthy();
		expect(uploadButton?.disabled).toBe(false);
		expect(uploadButton?.getAttribute('title')).toBe('Publish to Power BI service');

		await (section as unknown as { _publishToPowerBI(): Promise<void> })._publishToPowerBI();

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({
			type: 'showPowerBiUnsupportedVisualHelp',
		});
		expect(JSON.stringify(capturedMessages[0])).toContain('does not support heatmap visuals yet');
		expect(JSON.stringify(capturedMessages[0])).toContain('Ask for support for this chart type');
		expect(JSON.stringify(capturedMessages[0])).not.toContain('heat (heatmap)');
	});

	it('posts actionable publish help when Power BI publish has no data bindings', async () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_publish_help';
		section.setName('Publish Help Dashboard');
		section.setCode('<main>Manual dashboard without provenance</main>');

		await (section as unknown as { _publishToPowerBI(): Promise<void> })._publishToPowerBI();

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({
			type: 'showPowerBiPublishHelp',
			sectionId: 'html_publish_help',
			sectionName: 'Publish Help Dashboard',
			targetVersion: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
			reasons: [
				'Missing application/kw-provenance block. Ask Kusto Workbench to make this dashboard exportable to Power BI.',
				'No query-backed data sources were available for Power BI publish.',
			],
		});
	});

	it('includes section compatibility reasons in publish help when query-backed data is missing', async () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_invalid_pie_chart_spec';
		section.setName('Invalid pie chart spec');
		section.setCode(provenanceHtml(
			{ 'invalid-pie': { display: { type: 'pie', groupBy: 'State' } } },
			'<div data-kw-bind="invalid-pie"></div>',
		));

		await (section as unknown as { _publishToPowerBI(): Promise<void> })._publishToPowerBI();

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({
			type: 'showPowerBiPublishHelp',
			sectionId: 'html_invalid_pie_chart_spec',
			sectionName: 'Invalid pie chart spec',
			reasons: [
				'invalid-pie (pie: invalid chart spec: missing value)',
				'No query-backed data sources were available for Power BI publish.',
				'Run the referenced query section (query_fact) so Kusto Workbench can package its query and result schema for Power BI.',
			],
		});
	});

	it('warns before partially publishing query-backed dashboards with preview-only rendering', async () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_partial_publish';
		section.setName('Partial Publish Dashboard');
		section.setCode(provenanceHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			`<main>
				<div data-kw-bind="total"></div>
				<div data-role="heatmap"></div>
				<script>
					KustoWorkbench.onDataReady(function (data) {
						document.currentScript.closest('main').querySelector('[data-role="heatmap"]').innerHTML = '<button>Manual cell</button>';
						KustoWorkbench.bind('total', String((data && data.rows || []).length));
					});
				</script>
			</main>`,
		));

		const dataSources = [{
			name: 'Fact Events',
			sectionId: 'query_fact',
			clusterUrl: 'https://cluster.example',
			database: 'db',
			query: 'FactEvents',
			columns: [{ name: 'OS', type: 'string' }],
		}];
		const openedDialogs: unknown[] = [];
		Object.assign(section as unknown as Record<string, unknown>, {
			_collectDataSourcesForPBI: () => dataSources,
			_measureCurrentHtmlHeight: vi.fn(async () => 480),
			_openPublishDialog: vi.fn((htmlCode: string, dialogDataSources: unknown[], previewHeight: number | undefined, suggestedName: string) => {
				openedDialogs.push({ htmlCode, dialogDataSources, previewHeight, suggestedName });
			}),
		});

		await (section as unknown as { _publishToPowerBI(): Promise<void> })._publishToPowerBI();

		expect(openedDialogs).toHaveLength(0);
		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({
			type: 'showPowerBiPartialPublishWarning',
			sectionId: 'html_partial_publish',
			sectionName: 'Partial Publish Dashboard',
			targetVersion: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
		});
		expect(JSON.stringify(capturedMessages[0])).toContain('Potential preview-only data-role rendering detected');
	});

	it('opens the publish dialog after the host returns Publish anyway for a partial dashboard', async () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_partial_publish_continue';
		section.setName('Partial Publish Dashboard');
		section.setCode(provenanceHtml(
			{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
			`<main>
				<div data-kw-bind="total"></div>
				<div data-role="feed"></div>
				<script>
					KustoWorkbench.onDataReady(function () {
						document.currentScript.closest('main').querySelector('[data-role="feed"]').textContent = 'Preview only';
					});
				</script>
			</main>`,
		));

		const dataSources = [{
			name: 'Fact Events',
			sectionId: 'query_fact',
			clusterUrl: 'https://cluster.example',
			database: 'db',
			query: 'FactEvents',
			columns: [{ name: 'OS', type: 'string' }],
		}];
		const openPublishDialog = vi.fn();
		Object.assign(section as unknown as Record<string, unknown>, {
			_collectDataSourcesForPBI: () => dataSources,
			_measureCurrentHtmlHeight: vi.fn(async () => 512),
			_openPublishDialog: openPublishDialog,
		});

		section.connectedCallback();
		try {
			await (section as unknown as { _publishToPowerBI(): Promise<void> })._publishToPowerBI();
			const message = capturedMessages[0] as { requestId: string };
			window.dispatchEvent(new MessageEvent('message', {
				data: {
					type: 'powerBiPartialPublishWarningResult',
					boxId: 'html_partial_publish_continue',
					requestId: message.requestId,
					action: 'publishAnyway',
				},
			}));
			await new Promise(resolve => setTimeout(resolve, 0));

			expect(openPublishDialog).toHaveBeenCalledWith(expect.any(String), dataSources, 512, 'Partial Publish Dashboard');
		} finally {
			section.disconnectedCallback();
		}
	});

	it('serializes dont-tell-me-again dismissal with version and fingerprint', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_dismiss';
		section.setCode(fixableTableTargetHtml());

		const status = section.evaluatePowerBiCompatibilityNotice();
		expect(status?.signature).toBeTruthy();
		(section as unknown as { _dismissPowerBiUpgradeNotice(): void })._dismissPowerBiUpgradeNotice();
		const serialized = section.serialize();

		expect(serialized.powerBiUpgradeNotice?.dismissedForSection).toBe(true);
		expect(serialized.powerBiUpgradeNotice?.dismissedForVersion).toBe(CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION);
		expect(serialized.powerBiUpgradeNotice?.dismissedForSignature).toBe(status?.signature);
		expect(serialized.powerBiUpgradeNotice?.dismissedAt).toBeTruthy();
	});

	it('skips compatibility checks for a section-level dismissed notice even when the HTML changes', () => {
		vi.useFakeTimers();
		try {
			const section = new KwHtmlSection();
			section.boxId = 'html_dismissed_forever';
			section.setCode(fixableTableTargetHtml());

			expect(section.evaluatePowerBiCompatibilityNotice()?.needsUpgrade).toBe(true);
			(section as unknown as { _dismissPowerBiUpgradeNotice(): void })._dismissPowerBiUpgradeNotice();

			expect(section.isPowerBiUpgradeNoticeDismissed()).toBe(true);
			expect(section.shouldRunPowerBiCompatibilityNoticeCheck()).toBe(false);
			expect(section.isPowerBiCompatibilityCheckEnabled()).toBe(false);
			expect(section.evaluatePowerBiCompatibilityNotice()).toBeUndefined();

			section.setCode(provenanceHtml(
				{ 'another-table': { display: { type: 'table', groupBy: ['OS'], columns: [{ name: 'OS' }] } } },
				'<div data-kw-bind="another-table"></div>',
			));
			vi.runAllTimers();

			expect(section.shouldRunPowerBiCompatibilityNoticeCheck()).toBe(false);
			expect((section as unknown as { _powerBiCompatibilityStatus?: unknown })._powerBiCompatibilityStatus).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats restored signature-only dismissals as section-level dismissals', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_legacy_dismissed';
		section.setPowerBiUpgradeNotice({
			dismissedForVersion: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
			dismissedForSignature: 'legacy-signature',
			dismissedAt: '2026-05-06T00:00:00.000Z',
		});
		section.setCode(fixableTableTargetHtml());

		expect(section.isPowerBiUpgradeNoticeDismissed()).toBe(true);
		expect(section.shouldRunPowerBiCompatibilityNoticeCheck()).toBe(false);
		expect(section.evaluatePowerBiCompatibilityNotice()).toBeUndefined();
	});

	it('clears stale compatibility status when code changes to a valid exportable section', () => {
		vi.useFakeTimers();
		try {
			const section = new KwHtmlSection();
			section.boxId = 'html_refresh_status';
			section.setCode(fixableTableTargetHtml());

			expect(section.evaluatePowerBiCompatibilityNotice()?.needsUpgrade).toBe(true);

			section.setCode(provenanceHtml(
				{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
				'<span data-kw-bind="total"></span>',
			));
			vi.runAllTimers();

			expect((section as unknown as { _powerBiCompatibilityStatus?: unknown })._powerBiCompatibilityStatus).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('blocks a newly introduced unsupported Power BI binding without showing the passive update notice', () => {
		vi.useFakeTimers();
		try {
			const section = new KwHtmlSection();
			section.boxId = 'html_detect_new_issue';
			section.setCode(provenanceHtml(
				{ total: { display: { type: 'scalar', agg: 'COUNT' } } },
				'<span data-kw-bind="total"></span>',
			));
			section.evaluatePowerBiCompatibilityNotice();
			expect((section as unknown as { _powerBiCompatibilityStatus?: unknown })._powerBiCompatibilityStatus).toBeUndefined();

			section.setCode(provenanceHtml(
				{ heat: { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Requests' } } },
				'<div data-kw-bind="heat"></div>',
			));
			vi.runAllTimers();

			expect((section as unknown as { _powerBiCompatibilityStatus?: unknown })._powerBiCompatibilityStatus).toBeUndefined();
			expect((section as unknown as { _canEvaluatePowerBiCompatibilityNotice(): boolean })._canEvaluatePowerBiCompatibilityNotice()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
