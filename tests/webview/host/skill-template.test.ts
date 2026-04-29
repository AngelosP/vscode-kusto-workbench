import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { TEMPLATE_VERSION } from '../../../src/host/skillExport';

function readWorkspaceFile(relativePath: string): string {
	return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('exported Kusto Workbench skill template', () => {
	const template = readWorkspaceFile('media/skill-template.md');

	it('is bumped to the current template version', () => {
		expect(TEMPLATE_VERSION).toBe(5);
		expect(template).toContain('# version: 5 - Auto-updated by Kusto Workbench. Do not remove this line.');
	});

	it('documents the current tool surface including dashboards, SQL, and development notes', () => {
		for (const toolName of [
			'configureHtmlSection',
			'getHtmlDashboardGuide',
			'validateHtmlDashboard',
			'manageDevelopmentNotes',
			'askSqlCopilot',
			'listSqlConnections',
			'configureSqlSection',
			'getSqlSchema',
		]) {
			expect(template).toContain(toolName);
		}
	});

	it('includes dashboard upgrade-on-touch and validation behavior', () => {
		expect(template).toContain('Upgrade on touch');
		expect(template).toContain('latest dashboard contracts, specs, and capabilities');
		expect(template).toContain('preAggregate');
		expect(template).toContain('scale: "normalized100"');
		expect(template).toContain('variant: "distribution"');
		expect(template).toContain('renderTable');
		expect(template).toContain('cellBar');
		expect(template).toContain('Keep `compute.name` distinct from fact and preAggregate group columns.');
		expect(template).toContain('Power BI export-ready');
	});
});

describe('dashboard language model tool wiring', () => {
	it('keeps manifest, registration, and main prompt names aligned', () => {
		const manifest = JSON.parse(readWorkspaceFile('package.json'));
		const contributedTools = manifest.contributes.languageModelTools as Array<{ name: string; toolReferenceName: string }>;
		const registrations = readWorkspaceFile('src/host/kustoWorkbenchTools.ts');
		const prompt = readWorkspaceFile('copilot-instructions/custom-agent.md');

		for (const expected of [
			{ name: 'kusto-workbench_get-html-dashboard-guide', toolReferenceName: 'getHtmlDashboardGuide' },
			{ name: 'kusto-workbench_validate-html-dashboard', toolReferenceName: 'validateHtmlDashboard' },
		]) {
			expect(contributedTools).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
			expect(registrations).toContain(`registerTool('${expected.name}'`);
			expect(prompt).toContain(expected.toolReferenceName);
		}
	});
});