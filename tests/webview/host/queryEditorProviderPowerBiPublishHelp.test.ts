import { describe, expect, it, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';

function createProviderHarness() {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.requestHtmlDashboardUpgradeWithCopilot = vi.fn(async () => undefined);
	provider.postMessage = vi.fn();
	return provider;
}

describe('QueryEditorProvider Power BI publish help notification', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('opens the Kusto Workbench fix prompt when the notification action is selected', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Fix it using Kusto Workbench' as any);

		await provider.showPowerBiPublishHelp({
			type: 'showPowerBiPublishHelp',
			sectionId: 'html_publish_help',
			sectionName: 'Publish Help Dashboard',
			targetVersion: 1,
			reasons: ['Missing application/kw-provenance block.'],
		});

		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining('query-backed data bindings for Publish Help Dashboard'),
			'Fix it using Kusto Workbench',
		);
		expect(provider.requestHtmlDashboardUpgradeWithCopilot).toHaveBeenCalledWith({
			type: 'requestHtmlDashboardUpgradeWithCopilot',
			sectionId: 'html_publish_help',
			sectionName: 'Publish Help Dashboard',
			targetVersion: 1,
			reasons: ['Missing application/kw-provenance block.'],
		});
	});

	it('does not open the fix prompt when the notification is dismissed', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

		await provider.showPowerBiPublishHelp({
			type: 'showPowerBiPublishHelp',
			sectionId: 'html_publish_help',
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
		expect(provider.requestHtmlDashboardUpgradeWithCopilot).toHaveBeenCalledWith({
			type: 'requestHtmlDashboardUpgradeWithCopilot',
			sectionId: 'html_partial',
			sectionName: 'Partial Dashboard',
			targetVersion: 1,
			reasons: ['Potential preview-only data-role rendering detected.'],
		});
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
			message: 'Power BI export does not support heatmap visuals yet. Ask for support for this chart type; it will be added once the owner knows people need it.',
		});

		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining('Ask for support for this chart type'),
			'Ask for it',
		);
		expect(openExternal).toHaveBeenCalledWith(expect.objectContaining({
			scheme: 'https',
			path: 'https://github.com/AngelosP/vscode-kusto-workbench/issues',
		}));
	});
});
