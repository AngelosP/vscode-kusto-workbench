import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock setup ───────────────────────────────────────────────────────────────

// We test the join logic by creating a KwTransformationSection instance
// and calling its configure/serialize methods. Since the component relies on
// global window state and DOM, we set up minimal mocks.

const mockSchedulePersist = vi.fn();
const mockGetChartDatasetsInDomOrder = vi.fn(() => []);
const mockRefreshAllDataSourceDropdowns = vi.fn();
const mockRenderChart = vi.fn();
const mockSetResultsState = vi.fn();
const mockNormalizeResultsColumnName = vi.fn((c: string) => c);
const mockGetRawCellValue = vi.fn((v: unknown) => {
	if (v === null || v === undefined) return null;
	if (typeof v === 'object' && v !== null && 'value' in (v as Record<string, unknown>)) return (v as Record<string, unknown>).value;
	return v;
});

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: mockSchedulePersist,
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	setResultsState: mockSetResultsState,
	getResultsStateRevision: vi.fn(() => 0),
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoGetChartDatasetsInDomOrder: mockGetChartDatasetsInDomOrder,
	__kustoCleanupSectionModeResizeObserver: vi.fn(),
	__kustoRefreshAllDataSourceDropdowns: mockRefreshAllDataSourceDropdowns,
}));

vi.mock('../../src/webview/shared/chart-renderer.js', () => ({
	renderChart: mockRenderChart,
}));

vi.mock('../../src/webview/shared/data-utils.js', () => ({
	normalizeResultsColumnName: mockNormalizeResultsColumnName,
}));

vi.mock('../../src/webview/core/utils.js', () => ({
	addPageScrollListener: vi.fn(() => vi.fn()),
	getScrollY: vi.fn(() => 0),
	maybeAutoScrollWhileDragging: vi.fn(),
}));

vi.mock('../../src/webview/shared/transform-expr.js', () => ({
	tokenizeExpr: vi.fn(),
	parseExprToRpn: vi.fn(),
	evalRpn: vi.fn(),
	getRawCellValue: mockGetRawCellValue,
}));

// Set up minimal window globals
beforeEach(() => {
	(window as any).transformationStateByBoxId = {};
	(window as any).__kustoTransformationBoxes = [];
	(window as any).vscode = { postMessage: vi.fn() };
	mockGetChartDatasetsInDomOrder.mockReturnValue([]);
	mockSchedulePersist.mockClear();
	mockSetResultsState.mockClear();
});

// Dynamic import after mocks are set up
const { KwTransformationSection } =
	await import('../../src/webview/sections/kw-transformation-section.js');

// ─── Helper ───────────────────────────────────────────────────────────────────

function createSection(overrides: Record<string, unknown> = {}): InstanceType<typeof KwTransformationSection> {
	const el = new KwTransformationSection();
	el.boxId = overrides.boxId as string || 'transformation_test';
	el.applyOptions({
		transformationType: 'join',
		...overrides,
	});
	return el;
}

/**
 * Provide datasets to the section by mocking __kustoGetChartDatasetsInDomOrder.
 * Then call el.refresh() to trigger recomputation.
 */
function configureAndCompute(
	el: InstanceType<typeof KwTransformationSection>,
	leftDs: { id: string; label: string; columns: string[]; rows: unknown[][] },
	rightDs: { id: string; label: string; columns: string[]; rows: unknown[][] },
	config: Record<string, unknown>,
): void {
	mockGetChartDatasetsInDomOrder.mockReturnValue([leftDs, rightDs]);
	el.configure({ dataSourceId: leftDs.id, ...config });
}

function getResults(el: InstanceType<typeof KwTransformationSection>): {
	columns: string[];
	rows: unknown[][];
	error: string;
} {
	const data = el.serialize();
	// Inspect the internal setResultsState call to get actual results
	const lastCall = mockSetResultsState.mock.calls.at(-1);
	if (lastCall) {
		const state = lastCall[1] as { columns: string[]; rows: unknown[][] };
		return {
			columns: state.columns,
			rows: state.rows,
			error: '',
		};
	}
	return { columns: [], rows: [], error: 'no results' };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('transformation-join', () => {
	const leftDs = {
		id: 'query_1',
		label: 'Query 1',
		columns: ['Id', 'Name', 'Dept'],
		rows: [
			[1, 'Alice', 'Eng'],
			[2, 'Bob', 'Sales'],
			[3, 'Carol', 'Eng'],
			[4, 'Dave', 'HR'],
		],
	};

	const rightDs = {
		id: 'query_2',
		label: 'Query 2',
		columns: ['DeptId', 'Dept', 'Budget'],
		rows: [
			['D1', 'Eng', 500],
			['D2', 'Sales', 300],
			['D3', 'Marketing', 200],
		],
	};

	describe('serialize/applyOptions roundtrip', () => {
		it('serializes join fields correctly', () => {
			const el = createSection({
				joinRightDataSourceId: 'query_2',
				joinKind: 'leftouter',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
				joinOmitDuplicateColumns: false,
			});
			const data = el.serialize();
			expect(data.transformationType).toBe('join');
			expect(data.joinRightDataSourceId).toBe('query_2');
			expect(data.joinKind).toBe('leftouter');
			expect(data.joinKeys).toEqual([{ left: 'Dept', right: 'Dept' }]);
			expect(data.joinOmitDuplicateColumns).toBe(false);
		});

		it('preserves join data across applyOptions', () => {
			const el = createSection();
			el.applyOptions({
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'rightsemi',
				joinKeys: [
					{ left: 'A', right: 'B' },
					{ left: 'C', right: 'D' },
				],
				joinOmitDuplicateColumns: true,
			});
			const data = el.serialize();
			expect(data.joinKind).toBe('rightsemi');
			expect(data.joinKeys).toHaveLength(2);
			expect(data.joinOmitDuplicateColumns).toBe(true);
		});

		it('defaults joinOmitDuplicateColumns to true', () => {
			const el = createSection();
			const data = el.serialize();
			expect(data.joinOmitDuplicateColumns).toBe(true);
		});
	});

	describe('inner join', () => {
		it('joins on single key, omit duplicates ON', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'inner',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
				joinOmitDuplicateColumns: true,
			});
			const res = getResults(el);
			// Inner join on Dept: Alice-Eng, Bob-Sales, Carol-Eng match
			expect(res.columns).toEqual(['Id', 'Name', 'Dept', 'DeptId', 'Budget']);
			expect(res.rows).toHaveLength(3);
			// Alice matched Eng
			expect(res.rows[0]).toEqual([1, 'Alice', 'Eng', 'D1', 500]);
			// Bob matched Sales
			expect(res.rows[1]).toEqual([2, 'Bob', 'Sales', 'D2', 300]);
			// Carol matched Eng
			expect(res.rows[2]).toEqual([3, 'Carol', 'Eng', 'D1', 500]);
		});

		it('joins on single key, omit duplicates OFF (prefixed)', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'inner',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
				joinOmitDuplicateColumns: false,
			});
			const res = getResults(el);
			// Dept collides, so both get prefixed
			expect(res.columns).toEqual(['Id', 'Name', 'Left.Dept', 'DeptId', 'Right.Dept', 'Budget']);
			expect(res.rows).toHaveLength(3);
			expect(res.rows[0]).toEqual([1, 'Alice', 'Eng', 'D1', 'Eng', 500]);
		});
	});

	describe('leftouter join', () => {
		it('includes unmatched left rows with null right cols', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'leftouter',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
				joinOmitDuplicateColumns: true,
			});
			const res = getResults(el);
			// Dave (HR) has no match - should get nulls on right
			expect(res.rows).toHaveLength(4);
			const daveRow = res.rows.find(r => r[0] === 4);
			expect(daveRow).toEqual([4, 'Dave', 'HR', null, null]);
		});
	});

	describe('rightouter join', () => {
		it('includes unmatched right rows with null left cols', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'rightouter',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
				joinOmitDuplicateColumns: true,
			});
			const res = getResults(el);
			// Marketing has no match in left
			const marketingRow = res.rows.find(r => r[3] === 'D3');
			expect(marketingRow).toBeTruthy();
			expect(marketingRow![0]).toBeNull(); // Left Id is null
			expect(marketingRow![1]).toBeNull(); // Left Name is null
		});
	});

	describe('fullouter join', () => {
		it('includes unmatched rows from both sides', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'fullouter',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
				joinOmitDuplicateColumns: true,
			});
			const res = getResults(el);
			// 3 matches + 1 unmatched left (Dave/HR) + 1 unmatched right (Marketing) = 5
			expect(res.rows).toHaveLength(5);
		});
	});

	describe('leftanti join', () => {
		it('returns only left rows without a match', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'leftanti',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
			});
			const res = getResults(el);
			// Only Dave (HR) has no match
			expect(res.columns).toEqual(['Id', 'Name', 'Dept']);
			expect(res.rows).toHaveLength(1);
			expect(res.rows[0]).toEqual([4, 'Dave', 'HR']);
		});
	});

	describe('rightanti join', () => {
		it('returns only right rows without a match', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'rightanti',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
			});
			const res = getResults(el);
			// Only Marketing has no match
			expect(res.columns).toEqual(['DeptId', 'Dept', 'Budget']);
			expect(res.rows).toHaveLength(1);
			expect(res.rows[0]).toEqual(['D3', 'Marketing', 200]);
		});
	});

	describe('leftsemi join', () => {
		it('returns left rows that have a match (deduplicated)', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'leftsemi',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
			});
			const res = getResults(el);
			// Alice (Eng), Bob (Sales), Carol (Eng) have matches.
			// But leftsemi deduplicates by key - Eng appears once
			expect(res.columns).toEqual(['Id', 'Name', 'Dept']);
			expect(res.rows).toHaveLength(2); // Eng key and Sales key
		});
	});

	describe('rightsemi join', () => {
		it('returns right rows that have a match (deduplicated)', () => {
			const el = createSection();
			configureAndCompute(el, leftDs, rightDs, {
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'rightsemi',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
			});
			const res = getResults(el);
			// Eng and Sales from right have matches
			expect(res.columns).toEqual(['DeptId', 'Dept', 'Budget']);
			expect(res.rows).toHaveLength(2);
		});
	});

	describe('multi-key join', () => {
		it('joins on two keys', () => {
			const left = {
				id: 'q1',
				label: 'Q1',
				columns: ['A', 'B', 'Val'],
				rows: [
					[1, 'x', 10],
					[1, 'y', 20],
					[2, 'x', 30],
				],
			};
			const right = {
				id: 'q2',
				label: 'Q2',
				columns: ['A', 'B', 'Score'],
				rows: [
					[1, 'x', 100],
					[2, 'y', 200],
				],
			};
			const el = createSection();
			configureAndCompute(el, left, right, {
				transformationType: 'join',
				joinRightDataSourceId: 'q2',
				joinKind: 'inner',
				joinKeys: [
					{ left: 'A', right: 'A' },
					{ left: 'B', right: 'B' },
				],
				joinOmitDuplicateColumns: true,
			});
			const res = getResults(el);
			// Only (1, x) matches
			expect(res.rows).toHaveLength(1);
			expect(res.rows[0]).toEqual([1, 'x', 10, 100]);
			// Omit dups removes A and B from right, leaving only Score
			expect(res.columns).toEqual(['A', 'B', 'Val', 'Score']);
		});
	});

	describe('error cases', () => {
		it('errors when no right data source selected', () => {
			const el = createSection({
				joinRightDataSourceId: '',
			});
			mockGetChartDatasetsInDomOrder.mockReturnValue([leftDs]);
			el.configure({
				dataSourceId: 'query_1',
				transformationType: 'join',
				joinKind: 'inner',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
			});
			const data = el.serialize();
			// Should not produce results since no right DS
			expect(data.transformationType).toBe('join');
		});

		it('errors when no key pairs provided', () => {
			const el = createSection({
				joinKeys: [{ left: '', right: '' }],
			});
			mockGetChartDatasetsInDomOrder.mockReturnValue([leftDs, rightDs]);
			el.configure({
				dataSourceId: 'query_1',
				transformationType: 'join',
				joinRightDataSourceId: 'query_2',
				joinKind: 'inner',
				joinKeys: [{ left: '', right: '' }],
			});
			const data = el.serialize();
			expect(data.transformationType).toBe('join');
		});
	});

	describe('configure() from tool', () => {
		it('accepts all join fields', () => {
			const el = createSection();
			mockGetChartDatasetsInDomOrder.mockReturnValue([leftDs, rightDs]);
			const ok = el.configure({
				transformationType: 'join',
				dataSourceId: 'query_1',
				joinRightDataSourceId: 'query_2',
				joinKind: 'fullouter',
				joinKeys: [{ left: 'Dept', right: 'Dept' }],
				joinOmitDuplicateColumns: false,
			});
			expect(ok).toBe(true);
			const data = el.serialize();
			expect(data.joinKind).toBe('fullouter');
			expect(data.joinOmitDuplicateColumns).toBe(false);
		});
	});
});
