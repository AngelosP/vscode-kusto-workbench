import { describe, expect, it, vi } from 'vitest';
import {
	KustoWorkbenchToolOrchestrator,
	type ValidateHtmlDashboardResult,
} from '../../../src/host/kustoWorkbenchTools';

interface DashboardValidationHarness {
	validateHtmlDashboard(input: { sectionId: string }): Promise<ValidateHtmlDashboardResult>;
	sendToWebview: ReturnType<typeof vi.fn>;
	resolveToolTarget: ReturnType<typeof vi.fn>;
}

describe('Kusto Workbench HTML dashboard agent validation', () => {
	it('returns the portable compiler missing-column diagnostic', async () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: {
				'total-actions': { display: { type: 'scalar', agg: 'SUM', column: 'MissingMetric' } },
			},
		})}</script><span data-kw-bind="total-actions"></span>`;
		const orchestrator = Object.create(
			KustoWorkbenchToolOrchestrator.prototype,
		) as DashboardValidationHarness;
		orchestrator.sendToWebview = vi.fn(async () => ({
			success: true,
			sectionId: 'html_dashboard',
			name: 'Dashboard',
			code: htmlCode,
			hasProvenance: true,
			bindingCount: 1,
			dataSources: [{
				name: 'Fact Events',
				sectionId: 'query_fact',
				clusterUrl: 'https://cluster.kusto.windows.net',
				database: 'db',
				query: 'FactEvents',
				columns: [{ name: 'ExistingMetric', type: 'long' }],
			}],
			factColumns: [{ name: 'ExistingMetric', type: 'long' }],
		}));
		orchestrator.resolveToolTarget = vi.fn(() => ({
			openFiles: [],
			hasActiveUnsupportedFile: false,
			explicitTargetRequested: false,
		}));

		const result = await orchestrator.validateHtmlDashboard({ sectionId: 'html_dashboard' });

		expect(result.diagnostics).toEqual([{
			code: 'missing-column',
			severity: 'error',
			message: 'total-actions (column: missing column MissingMetric)',
			bindingKey: 'total-actions',
			role: 'column',
			columnName: 'MissingMetric',
		}]);
		expect(result.issues).toContain('total-actions (column: missing column MissingMetric)');
		expect(result.valid).toBe(false);
		expect(orchestrator.sendToWebview).toHaveBeenCalledWith(
			'toolGetHtmlDashboardContext',
			{ sectionId: 'html_dashboard' },
			30000,
			{},
		);
	});

	it('allows zero bindings without an agent-only rejection', async () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: {},
		})}</script><main>Dashboard</main>`;
		const orchestrator = Object.create(
			KustoWorkbenchToolOrchestrator.prototype,
		) as DashboardValidationHarness;
		orchestrator.sendToWebview = vi.fn(async () => ({
			success: true, sectionId: 'html_dashboard', name: 'Dashboard', code: htmlCode,
			hasProvenance: true, bindingCount: 0,
			dataSources: [{
				name: 'Fact Events', sectionId: 'query_fact',
				clusterUrl: 'https://cluster.kusto.windows.net', database: 'db', query: 'FactEvents',
				columns: [{ name: 'ExistingMetric', type: 'long' }],
			}],
			factColumns: [{ name: 'ExistingMetric', type: 'long' }],
		}));
		orchestrator.resolveToolTarget = vi.fn(() => ({
			openFiles: [], hasActiveUnsupportedFile: false, explicitTargetRequested: false,
		}));

		const result = await orchestrator.validateHtmlDashboard({ sectionId: 'html_dashboard' });

		expect(result.diagnostics).toEqual([]);
		expect(result.issues).toEqual([]);
		expect(result.valid).toBe(true);
	});
});
