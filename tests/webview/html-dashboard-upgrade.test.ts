import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
		const html = provenanceHtml(
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

	it('checks upload-enabled sections and posts an upgrade request to the host', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_upgrade_me';
		section.setName('Dashboard');
		section.setCode(provenanceHtml(
			{ heat: { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Requests' } } },
			'<div data-kw-bind="heat"></div>',
		));

		const status = section.evaluatePowerBiCompatibilityNotice();
		expect(status?.needsUpgrade).toBe(true);
		(section as unknown as { _requestPowerBiUpgradeWithCopilot(): void })._requestPowerBiUpgradeWithCopilot();

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]).toMatchObject({
			type: 'requestHtmlDashboardUpgradeWithCopilot',
			sectionId: 'html_upgrade_me',
			sectionName: 'Dashboard',
			targetVersion: CURRENT_HTML_DASHBOARD_POWER_BI_EXPORT_VERSION,
			reasons: ['heat (heatmap)'],
		});
	});

	it('serializes dont-tell-me-again dismissal with version and fingerprint', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_dismiss';
		section.setCode(provenanceHtml(
			{ heat: { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Requests' } } },
			'<div data-kw-bind="heat"></div>',
		));

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
			section.setCode(provenanceHtml(
				{ heat: { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Requests' } } },
				'<div data-kw-bind="heat"></div>',
			));

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

	it('detects a newly introduced unsupported Power BI binding after code changes', () => {
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

			expect((section as unknown as { _powerBiCompatibilityStatus?: { reasons?: string[] } })._powerBiCompatibilityStatus?.reasons).toContain('heat (heatmap)');
		} finally {
			vi.useRealTimers();
		}
	});
});
