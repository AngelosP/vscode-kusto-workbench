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
		expect((section as unknown as { _isPowerBiUploadEnabled(): boolean })._isPowerBiUploadEnabled()).toBe(false);

		(section as unknown as { _showPowerBiUploadUnavailableMessage(): void })._showPowerBiUploadUnavailableMessage();
		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({ type: 'showInfo' });
		expect(JSON.stringify(capturedMessages[0])).toContain('does not support heatmap visuals yet');
		capturedMessages = [];

		await (section as unknown as { _publishToPowerBI(): Promise<void> })._publishToPowerBI();

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({
			type: 'showInfo',
		});
		expect(JSON.stringify(capturedMessages[0])).toContain('does not support heatmap visuals yet');
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
				'No query-backed data sources were available for Power BI publish.',
				'Missing application/kw-provenance block.',
			],
		});
	});

	it('serializes dont-tell-me-again dismissal with version and fingerprint', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_dismiss';
		section.setCode(fixableTableTargetHtml());

		const status = section.evaluatePowerBiCompatibilityNotice();
		expect(status?.signature).toBeTruthy();
		(section as unknown as { _dismissPowerBiUpgradeNotice(): void })._dismissPowerBiUpgradeNotice();
		const serialized = section.serialize();

		expect(serialized.powerBiUpgradeNotice?.dismissedForVersion).toBe(CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION);
		expect(serialized.powerBiUpgradeNotice?.dismissedForSignature).toBe(status?.signature);
		expect(serialized.powerBiUpgradeNotice?.dismissedAt).toBeTruthy();
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
			expect((section as unknown as { _isPowerBiUploadEnabled(): boolean })._isPowerBiUploadEnabled()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
