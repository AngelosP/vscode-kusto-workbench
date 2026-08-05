import { describe, expect, it } from 'vitest';

import {
	parseHtmlSection,
	parseHtmlSectionPatch,
	patchHtmlSection,
} from '../../src/shared/htmlSectionDefinition.js';

describe('HTML section definition', () => {
	it('deeply isolates persisted configuration and supports null deletion', () => {
		const dataSourceIds = ['query_1'];
		const pbiPublishInfo = {
			workspaceId: 'workspace', semanticModelId: 'model', reportId: 'report',
			reportName: 'Report', reportUrl: 'https://app.powerbi.com/report', dataMode: 'import' as const,
		};
		const powerBiUpgradeNotice = {
			dismissedForSection: true, dismissedForVersion: 1,
			dismissedForSignature: 'signature', dismissedAt: '2026-08-04T00:00:00.000Z',
		};
		const parsed = parseHtmlSection({
			id: 'dashboard-any-id', type: 'html', name: 'Dashboard', code: '<main>before</main>',
			mode: 'preview', expanded: false, editorHeightPx: 320, previewHeightPx: 640,
			previewHeightUserSet: true, dataSourceIds, pbiPublishInfo, powerBiUpgradeNotice,
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		dataSourceIds[0] = 'mutated';
		pbiPublishInfo.reportName = 'Mutated';
		powerBiUpgradeNotice.dismissedForSignature = 'mutated';
		expect(parsed.value).toMatchObject({
			dataSourceIds: ['query_1'],
			pbiPublishInfo: { reportName: 'Report' },
			powerBiUpgradeNotice: { dismissedForSignature: 'signature' },
		});

		const patch = parseHtmlSectionPatch({
			code: '<main>after</main>', editorHeightPx: null, previewHeightPx: null,
			previewHeightUserSet: null, pbiPublishInfo: null, powerBiUpgradeNotice: null,
		});
		expect(patch.ok).toBe(true);
		if (!patch.ok) return;
		const updated = patchHtmlSection(parsed.value, patch.value);
		expect(updated.code).toBe('<main>after</main>');
		for (const key of [
			'editorHeightPx', 'previewHeightPx', 'previewHeightUserSet',
			'pbiPublishInfo', 'powerBiUpgradeNotice',
		]) expect(updated).not.toHaveProperty(key);
	});

	it('rejects malformed nested publish and notice metadata', () => {
		expect(parseHtmlSection({
			id: 'html_bad_publish', type: 'html',
			pbiPublishInfo: { workspaceId: 'workspace' },
		}).ok).toBe(false);
		const invalidNotice = parseHtmlSection({
			id: 'html_bad_notice', type: 'html',
			powerBiUpgradeNotice: { dismissedAt: 42 },
		});
		expect(invalidNotice.ok).toBe(false);
		if (!invalidNotice.ok) expect(invalidNotice.error).toContain('dismissedAt');
	});
});