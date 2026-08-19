import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createSkillExportFiles, HTML_DASHBOARD_RULES_FILENAME, isSkillTemplateCurrent, SKILL_FILENAME, TEMPLATE_VERSION } from '../../../src/host/skillExport';

function readWorkspaceFile(relativePath: string): string {
	return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function extractClarificationPolicy(content: string): string {
	const marker = 'If `#askKustoCopilot` returns `outcome: "clarification-required"`';
	const start = content.indexOf(marker);
	expect(start).toBeGreaterThanOrEqual(0);
	const remainder = content.slice(start);
	const nextSection = remainder.slice(marker.length).search(/\n(?:### |4\. \*\*Collect all matches\.\*\*)/);
	return nextSection < 0
		? remainder
		: remainder.slice(0, marker.length + nextSection);
}

describe('exported Kusto Workbench skill template', () => {
	const template = readWorkspaceFile('media/skill-template.md');
	const htmlDashboardRules = readWorkspaceFile('copilot-instructions/html-dashboard-rules.md');
	const exportedFiles = createSkillExportFiles(template, htmlDashboardRules);
	const exportedSkill = exportedFiles.find(file => file.fileName === SKILL_FILENAME)?.content ?? '';
	const exportedDashboardRules = exportedFiles.find(file => file.fileName === HTML_DASHBOARD_RULES_FILENAME)?.content ?? '';

	it('is bumped to the current template version', () => {
		expect(TEMPLATE_VERSION).toBe(17);
		expect(template).toContain('# version: 17 - Auto-updated by Kusto Workbench. Do not remove this line.');
		expect(isSkillTemplateCurrent(16)).toBe(false);
		expect(isSkillTemplateCurrent(17)).toBe(true);
	});

	it('exports the compact skill and dashboard rules sidecar separately', () => {
		expect(exportedFiles.map(file => file.fileName)).toEqual([SKILL_FILENAME, HTML_DASHBOARD_RULES_FILENAME]);
		expect(exportedSkill).toContain('`./html-dashboard-rules.md`');
		expect(exportedSkill).not.toContain('KUSTO_WORKBENCH_HTML_DASHBOARD_RULES');
		expect(exportedSkill).not.toContain('# Kusto Workbench HTML Dashboard Rules');
		expect(exportedDashboardRules).toBe(htmlDashboardRules);
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
			expect(exportedSkill).toContain(toolName);
		}
	});

	it('requires calling agents to answer clarifications before escalating to the user', () => {
		for (const content of [
			exportedSkill,
			readWorkspaceFile('copilot-instructions/custom-agent.md'),
			readWorkspaceFile('copilot-instructions/custom-subagent-search.md'),
		]) {
			const policy = extractClarificationPolicy(content);
			expect(policy).toContain('returned `question` as addressed to you');
			expect(policy).toContain('answer it yourself');
			expect(policy).toContain('Use available tools');
			expect(policy).toContain('Immediately call `#askKustoCopilot` again');
			expect(policy).toContain('exact returned `sectionId` and `openFileId`');
			expect(policy).toContain('Ask the user only');
			expect(policy).toContain('genuinely user-owned choice');
			expect(policy).toContain('reasonable assumption could materially change the result');
			expect(policy).not.toMatch(/ask the returned\s+`?question`?\s+verbatim/i);
		}
	});

	it('keeps Kusto Workbench agents unable and forbidden to close the active chat tab', () => {
		const mainAgent = readWorkspaceFile('copilot-instructions/custom-agent.md');
		const searchAgent = readWorkspaceFile('copilot-instructions/custom-subagent-search.md');
		for (const content of [mainAgent, searchAgent]) {
			const toolsLine = content.split('\n').find(line => line.startsWith('tools:')) ?? '';
			expect(toolsLine).not.toMatch(/['"]vscode['"]/);
		}
		expect(mainAgent).toContain('Never close Copilot Chat or an agent conversation.');
		expect(mainAgent).toContain('`workbench.action.closeActiveEditor`');
		expect(mainAgent).toContain('target its exact URI with a tab-specific API');
		expect(mainAgent).toContain('leave the tab open');
	});

	it('includes dashboard upgrade-on-touch and validation behavior in the sidecar', () => {
		expect(exportedDashboardRules).toContain('## Upgrade On Touch');
		expect(exportedDashboardRules).toContain('latest contract and capabilities');
		expect(exportedDashboardRules).toContain('preAggregate');
		expect(exportedDashboardRules).toContain('scale: "normalized100"');
		expect(exportedDashboardRules).toContain('variant: "distribution"');
		expect(exportedDashboardRules).toContain('KustoWorkbench.renderTable(bindingId)');
		expect(exportedDashboardRules).toContain('KustoWorkbench.renderRepeatedTable(bindingId)');
		expect(exportedDashboardRules).toContain('repeatedTable');
		expect(exportedDashboardRules).toContain('cellBar');
		expect(exportedDashboardRules).toContain('cellFormat');
		expect(exportedDashboardRules).toContain('display.tooltip');
		expect(exportedDashboardRules).toContain('SVG `<title>` plus safe `title`/`aria-label` metadata');
		expect(exportedDashboardRules).toContain('Line charts show visible point markers at each tooltip target');
		expect(exportedDashboardRules).toContain('Do not use table-level `cellFormats`');
		expect(exportedDashboardRules).toContain('renders `0.68` as `68%`');
		expect(exportedDashboardRules).toContain('`compute.name` must not collide with an existing fact column name or the `groupBy` output columns.');
		expect(exportedDashboardRules).toContain('Power BI export');
		expect(exportedDashboardRules).toContain('model.fact.resultIndex');
		expect(exportedDashboardRules).toContain('Power BI/PBIP publishing supports Result 1 only');
		expect(exportedSkill).toContain('dataSourceResultIndex');
		expect(exportedSkill).toContain('joinRightDataSourceResultIndex');
	});

	it('copies the canonical HTML dashboard guide sections into the sidecar', () => {
		for (const sectionHeading of [
			'# Kusto Workbench HTML Dashboard Rules',
			'## Dashboard Checklist',
			'## Starter Template',
			'## Fact Query Rules',
			'## Provenance Contract',
			'## Display Types',
			'## Tooltip Rules',
			'## Table Rules',
			'## Repeated Table Rules',
			'## Chart Rules',
			'## Slicers',
			'## PreAggregate',
			'## Styling Defaults',
			'## Upgrade On Touch',
			'## Validation Workflow',
		]) {
			expect(exportedDashboardRules).toContain(sectionHeading);
		}
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