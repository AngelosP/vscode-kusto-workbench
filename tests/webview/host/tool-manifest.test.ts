import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('tool manifest schemas', () => {
	const getTools = () => JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).contributes?.languageModelTools ?? [];

	it('does not expose human-only zoom gestures on configure-chart input schema', () => {
		const tools = getTools();
		const configureChart = tools.find((tool: any) => tool.name === 'kusto-workbench_configure-chart');

		expect(configureChart).toBeTruthy();
		expect(configureChart.inputSchema?.additionalProperties).toBe(false);
		expect(configureChart.inputSchema?.properties?.zoomPanEnabled).toBeUndefined();
		for (const key of ['xAxisSettings', 'yAxisSettings', 'legendSettings', 'heatmapSettings']) {
			expect(configureChart.inputSchema?.properties?.[key]?.additionalProperties).toBe(false);
		}
	});

	it('exposes activation and target fields on per-file tools', () => {
		const tools = getTools();
		const toolByName = new Map(tools.map((tool: any) => [tool.name, tool]));
		expect(toolByName.has('kusto-workbench_activate-workbench-file')).toBe(true);

		const targetableToolNames = [
			'kusto-workbench_add-section',
			'kusto-workbench_remove-section',
			'kusto-workbench_collapse-section',
			'kusto-workbench_reorder-sections',
			'kusto-workbench_configure-query-section',
			'kusto-workbench_update-markdown-section',
			'kusto-workbench_configure-chart',
			'kusto-workbench_configure-transformation',
			'kusto-workbench_configure-html-section',
			'kusto-workbench_validate-html-dashboard',
			'kusto-workbench_ask-kusto-copilot',
			'kusto-workbench_manage-development-notes',
			'kusto-workbench_configure-sql-section',
			'kusto-workbench_get-sql-schema',
			'kusto-workbench_ask-sql-copilot',
		];

		for (const name of targetableToolNames) {
			const tool = toolByName.get(name) as any;
			expect(tool, `${name} should exist`).toBeTruthy();
			expect(tool.inputSchema?.properties?.openFileId, `${name} openFileId`).toBeTruthy();
			expect(tool.inputSchema?.properties?.targetFileUri, `${name} targetFileUri`).toBeTruthy();
		}
	});

	it('documents the Kusto Copilot clarification handoff for calling agents', () => {
		const askKustoCopilot = getTools().find((tool: any) =>
			tool.name === 'kusto-workbench_ask-kusto-copilot',
		);

		expect(askKustoCopilot?.modelDescription).toContain("outcome='clarification-required'");
		expect(askKustoCopilot?.modelDescription).toContain('ask the returned question verbatim');
		expect(askKustoCopilot?.modelDescription).toContain('same openFileId and sectionId');
	});
});

