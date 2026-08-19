import { describe, expect, it } from 'vitest';

import {
	createKustoResultBatch,
	getKustoResultSets,
	parseKustoResultBatch,
	serializeKustoResultBatchForPersistence,
} from '../../src/shared/kustoResultBatch.js';

describe('Kusto result batch contract', () => {
	it('keeps Result 1 flat while preserving ordered additional results', () => {
		const created = createKustoResultBatch([
			{
				columns: [{ name: 'FirstValue', type: 'long' }],
				rows: [[1]],
				metadata: { cluster: 'https://cluster', database: 'Db', executionTime: '0.001s' },
			},
			{
				columns: [{ name: 'SecondValue', type: 'string' }],
				rows: [['two']],
				metadata: {
					cluster: 'https://cluster', database: 'Db', executionTime: '0.001s',
					resultName: 'ResultTable_1', resultId: 1, resultKind: 'PrimaryResult',
				},
			},
		]);

		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.value).toMatchObject({
			columns: [{ name: 'FirstValue', type: 'long' }],
			rows: [[1]],
			additionalResults: {
				version: 1,
				sets: [{
					resultIndex: 1,
					columns: [{ name: 'SecondValue', type: 'string' }],
					rows: [['two']],
				}],
			},
		});
		expect(getKustoResultSets(created.value).map(set => set.resultIndex)).toEqual([0, 1]);
		expect(Object.isFrozen(created.value)).toBe(true);
		expect(Object.isFrozen(created.value.additionalResults?.sets)).toBe(true);
		expect(Object.isFrozen(getKustoResultSets(created.value)[1].rows[0])).toBe(true);
	});

	it('accepts the legacy flat result as a one-set batch', () => {
		const legacy = {
			columns: ['Value'],
			rows: [[42]],
			metadata: { cluster: 'https://cluster', database: 'Db', executionTime: '0.002s' },
		};

		const parsed = parseKustoResultBatch(legacy);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.additionalResults).toBeUndefined();
		expect(getKustoResultSets(parsed.value)).toEqual([
			expect.objectContaining({ resultIndex: 0, columns: ['Value'], rows: [[42]] }),
		]);
	});

	it('creates one synthetic empty Result 1 when ADX returns no primary tables', () => {
		const created = createKustoResultBatch([], {
			cluster: 'https://cluster', database: 'Db', executionTime: '0.003s',
		});

		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.value).toEqual({
			columns: [], rows: [],
			metadata: {
				cluster: 'https://cluster', database: 'Db', executionTime: '0.003s',
				physicalResultSetCount: 0,
			},
		});
	});

	it('rejects malformed, sparse, duplicate, or noncontiguous additional sets', () => {
		const base = {
			columns: ['Value'], rows: [[1]],
			metadata: { cluster: 'https://cluster', database: 'Db', executionTime: '0.001s' },
		};
		const sparse: unknown[] = [];
		sparse.length = 1;

		for (const additionalResults of [
			{ version: 2, sets: [] },
			{ version: 1, sets: sparse },
			{ version: 1, sets: [{ resultIndex: 2, columns: [], rows: [], metadata: {} }] },
			{ version: 1, sets: [
				{ resultIndex: 1, columns: [], rows: [], metadata: {} },
				{ resultIndex: 1, columns: [], rows: [], metadata: {} },
			] },
		]) {
			expect(parseKustoResultBatch({ ...base, additionalResults }).ok).toBe(false);
		}
	});

	it('projects ragged rows to the declared width in every result set', () => {
		const created = createKustoResultBatch([
			{ columns: ['A', 'B'], rows: [[1, 2, 3], [4]], metadata: {} },
			{ columns: ['C'], rows: [[5, 6]], metadata: {} },
		]);

		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(getKustoResultSets(created.value).map(set => set.rows)).toEqual([
			[[1, 2], [4, undefined]],
			[[5]],
		]);
	});

	it('rejects non-array rows instead of coercing them to null cells', () => {
		expect(parseKustoResultBatch({
			columns: ['A'], rows: [{ A: 1 }], metadata: {},
		}).ok).toBe(false);
		expect(createKustoResultBatch([{
			columns: ['A'], rows: [null] as unknown as unknown[][], metadata: {},
		}]).ok).toBe(false);
	});

	it('truncates rows fairly under one aggregate persistence budget', () => {
		const created = createKustoResultBatch([
			{ columns: ['A'], rows: Array.from({ length: 10 }, (_, index) => [`a-${index}`]), metadata: {} },
			{ columns: ['B'], rows: Array.from({ length: 10 }, (_, index) => [`b-${index}`]), metadata: {} },
		]);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const persisted = serializeKustoResultBatchForPersistence(created.value, 1024 * 1024, 8);

		expect(persisted.json).not.toBeNull();
		expect(persisted.truncated).toBe(true);
		expect(persisted.rowCounts.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(8);
		expect(Math.abs(persisted.rowCounts[0] - persisted.rowCounts[1])).toBeLessThanOrEqual(1);
		const parsed = parseKustoResultBatch(JSON.parse(persisted.json!));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const sets = getKustoResultSets(parsed.value);
		expect(sets.map(set => set.columns)).toEqual([['A'], ['B']]);
		expect(sets.map(set => set.metadata)).toEqual([
			expect.objectContaining({ persistedTruncated: true, persistedTotalRows: 10 }),
			expect.objectContaining({ persistedTruncated: true, persistedTotalRows: 10 }),
		]);
	});

	it('reduces the aggregate row prefixes until the exact UTF-8 byte budget fits', () => {
		const created = createKustoResultBatch([
			{ columns: ['A'], rows: Array.from({ length: 10 }, (_, index) => [`a-${index}-${'x'.repeat(200)}`]), metadata: {} },
			{ columns: ['B'], rows: Array.from({ length: 10 }, (_, index) => [`b-${index}-${'y'.repeat(200)}`]), metadata: {} },
		]);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const persisted = serializeKustoResultBatchForPersistence(created.value, 1500, 5000);

		expect(persisted.json).not.toBeNull();
		expect(new TextEncoder().encode(persisted.json!).length).toBeLessThanOrEqual(1500);
		expect(persisted.truncated).toBe(true);
		expect(persisted.rowCounts.every(count => count < 10)).toBe(true);
	});

	it('preserves unknown envelope and result-set extension fields', () => {
		const parsed = parseKustoResultBatch({
			columns: ['A'], rows: [[1]], metadata: {}, rootFuture: { enabled: true },
			additionalResults: {
				version: 1, futureEnvelope: 'keep',
				sets: [{
					resultIndex: 1, columns: ['B'], rows: [[2]], metadata: {}, futureSet: ['keep'],
				}],
			},
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const persisted = serializeKustoResultBatchForPersistence(parsed.value, 1024 * 1024, 5000);
		const value = JSON.parse(persisted.json!);

		expect(value.rootFuture).toEqual({ enabled: true });
		expect(value.additionalResults.futureEnvelope).toBe('keep');
		expect(value.additionalResults.sets[0].futureSet).toEqual(['keep']);
	});

	it('persists nothing when the complete schema envelope exceeds the byte budget', () => {
		const created = createKustoResultBatch([
			{ columns: ['A'.repeat(500)], rows: [[1]], metadata: {} },
			{ columns: ['B'.repeat(500)], rows: [[2]], metadata: {} },
		]);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const persisted = serializeKustoResultBatchForPersistence(created.value, 100, 5000);

		expect(persisted).toEqual({ json: null, truncated: false, rowCounts: [] });
	});
});