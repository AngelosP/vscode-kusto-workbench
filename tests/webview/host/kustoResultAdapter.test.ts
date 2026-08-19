import { describe, expect, it } from 'vitest';

import { adaptKustoQueryResponse } from '../../../src/host/kustoResultAdapter.js';
import { getKustoResultSets } from '../../../src/shared/kustoResultBatch.js';

function table(
	name: string,
	id: number,
	kind: string,
	columns: Array<{ name: string; type: string; ordinal: number }>,
	rows: unknown[][],
) {
	return {
		name, id, kind, columns,
		rows: function* resultRows() {
			for (const row of rows) {
				yield Object.fromEntries(columns.map((column, index) => [column.name, row[index]]));
			}
		},
	};
}

describe('adaptKustoQueryResponse', () => {
	it('preserves every primary result in order with table metadata and per-set statistics', () => {
		const adapted = adaptKustoQueryResponse({
			primaryResults: [
				table('ResultTable_0', 0, 'PrimaryResult', [{ name: 'First', type: 'long', ordinal: 0 }], [[1]]),
				table('ResultTable_1', 1, 'PrimaryResult', [{ name: 'Second', type: 'string', ordinal: 0 }], [['two']]),
			],
		}, {
			cluster: 'https://cluster', database: 'Db', executionTime: '0.010s',
			clientActivityId: 'activity-1',
			serverStats: {
				cpuTimeMs: 5,
				datasetStatistics: [
					{ serverRowCount: 1, serverTableSize: 10 },
					{ serverRowCount: 2, serverTableSize: 20 },
				],
			},
		});

		expect(adapted.ok).toBe(true);
		if (!adapted.ok) return;
		const sets = getKustoResultSets(adapted.value);
		expect(sets).toHaveLength(2);
		expect(sets[0]).toMatchObject({
			resultIndex: 0,
			columns: [{ name: 'First', type: 'long' }],
			rows: [[{ display: '1', full: '1' }]],
			metadata: {
				resultName: 'ResultTable_0', resultId: 0, resultKind: 'PrimaryResult',
				serverStats: { cpuTimeMs: 5, serverRowCount: 1, serverTableSize: 10 },
			},
		});
		expect(sets[1]).toMatchObject({
			resultIndex: 1,
			columns: [{ name: 'Second', type: 'string' }],
			rows: [[{ display: 'two', full: 'two' }]],
			metadata: {
				resultName: 'ResultTable_1', resultId: 1, resultKind: 'PrimaryResult',
				serverStats: { cpuTimeMs: 5, serverRowCount: 2, serverTableSize: 20 },
			},
		});
	});

	it('returns a synthetic empty primary result when the response has no primary tables', () => {
		const adapted = adaptKustoQueryResponse({ primaryResults: [] }, {
			cluster: 'https://cluster', database: 'Db', executionTime: '0.010s',
		});

		expect(adapted.ok).toBe(true);
		if (!adapted.ok) return;
		expect(adapted.value).toMatchObject({
			columns: [], rows: [], metadata: { physicalResultSetCount: 0 },
		});
	});
});