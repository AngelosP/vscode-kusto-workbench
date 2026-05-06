import { describe, expect, it, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';

function createProviderHarness() {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.requestHtmlDashboardUpgradeWithCopilot = vi.fn(async () => undefined);
	return provider;
}

describe('QueryEditorProvider Power BI publish help notification', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('opens the Kusto Workbench fix prompt when the notification action is selected', async () => {
		const provider = createProviderHarness();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Ask Kusto Workbench to Fix' as any);

		await provider.showPowerBiPublishHelp({
			type: 'showPowerBiPublishHelp',
			sectionId: 'html_publish_help',
			sectionName: 'Publish Help Dashboard',
			targetVersion: 1,
			reasons: ['Missing application/kw-provenance block.'],
		});

		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining('query-backed data bindings'),
			'Ask Kusto Workbench to Fix',
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
});
