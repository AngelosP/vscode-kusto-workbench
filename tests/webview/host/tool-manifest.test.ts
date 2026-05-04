import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('tool manifest schemas', () => {
	it('does not expose human-only zoom gestures on configure-chart input schema', () => {
		const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
		const tools = manifest.contributes?.languageModelTools ?? [];
		const configureChart = tools.find((tool: any) => tool.name === 'kusto-workbench_configure-chart');

		expect(configureChart).toBeTruthy();
		expect(configureChart.inputSchema?.additionalProperties).toBe(false);
		expect(configureChart.inputSchema?.properties?.zoomPanEnabled).toBeUndefined();
		for (const key of ['xAxisSettings', 'yAxisSettings', 'legendSettings', 'heatmapSettings']) {
			expect(configureChart.inputSchema?.properties?.[key]?.additionalProperties).toBe(false);
		}
	});
});

