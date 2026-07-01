import { describe, expect, it, vi } from 'vitest';
import { ConnectionManagerViewerV2 } from '../../../src/host/connectionManagerViewer';

function createViewerHarness(): ConnectionManagerViewerV2 & Record<string, any> {
	return Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
}

describe('ConnectionManagerViewerV2 schema search mapping', () => {
	it('includes Kusto column docstrings in cached schema search result snippets', () => {
		const viewer = createViewerHarness();
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' }]),
		};

		const results = viewer._mapKustoSchemaMatches([
			{
				clusterUrl: 'https://mycluster.kusto.windows.net',
				database: 'AlphaDb',
				kind: 'columnDocString',
				name: 'alphaCol',
				table: 'AlphaRoot',
				type: 'long',
				docString: 'Primary event count for the current window',
			},
		], { tables: true }, { tables: true });

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				matchContext: 'alphaCol: long - Primary event count for the current window',
			}),
		]);
	});

	it('searches Kusto column docstrings in freshly loaded schemas', () => {
		const viewer = createViewerHarness();
		const results = viewer._searchSingleKustoSchema(
			{
				tables: ['AlphaRoot'],
				columnTypesByTable: { AlphaRoot: { alphaCol: 'long' } },
				columnDocStrings: { 'AlphaRoot.alphaCol': 'Primary event count for the current window' },
			},
			'https://mycluster.kusto.windows.net',
			'AlphaDb',
			{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' },
			/event count/i,
			{ tables: true },
			{ tables: true },
		);

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				matchContext: 'alphaCol: long - Primary event count for the current window',
			}),
		]);
	});
});