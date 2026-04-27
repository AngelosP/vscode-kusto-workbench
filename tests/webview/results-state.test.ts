import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	tryStoreQueryResult: vi.fn(),
	setResultsVisible: vi.fn(),
	setQueryExecuting: vi.fn(),
	notifyResultsUpdated: vi.fn(),
}));

vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: {
		resultsVisibleByBoxId: {},
		lastExecutedBox: '',
	}
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	__kustoTryStoreQueryResult: mocks.tryStoreQueryResult,
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	__kustoSetResultsVisible: mocks.setResultsVisible,
	setQueryExecuting: mocks.setQueryExecuting,
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoNotifyResultsUpdated: mocks.notifyResultsUpdated,
}));

import {
	displayResultForBox,
	getRawCellValue,
	getResultsState,
	setResultsState,
	ensureResultsStateMap,
	resetCurrentResult,
	currentResult,
	ensureResultsShownForTool,
} from '../../src/webview/core/results-state.js';

describe('results-state displayResultForBox', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		resetCurrentResult();
		vi.clearAllMocks();
	});

	it('renders and updates shared result state without owning persistence', () => {
		const section = document.createElement('div') as HTMLDivElement & {
			displayResult: ReturnType<typeof vi.fn>;
		};
		section.id = 'query_1';
		section.displayResult = vi.fn();
		document.body.appendChild(section);

		const result = {
			columns: [
				{ name: 'Name', type: 'string' },
				{ name: 'Value', type: 'long' },
			],
			rows: [
				['alpha', 1],
				['beta', 2],
			],
			metadata: { executionTime: '00:00:00.123' },
		};

		displayResultForBox(result, 'query_1', { label: 'Results', showExecutionTime: true });

		expect(section.displayResult).toHaveBeenCalledWith(result, { label: 'Results', showExecutionTime: true });
		expect(mocks.notifyResultsUpdated).toHaveBeenCalledWith('query_1');
		expect(mocks.tryStoreQueryResult).not.toHaveBeenCalled();

		const state = getResultsState('query_1') as any;
		expect(state).toMatchObject({
			boxId: 'query_1',
			columns: result.columns,
			rows: result.rows,
			metadata: result.metadata,
			displayRowIndices: [0, 1],
			rowIndexToDisplayIndex: [0, 1],
		});
		expect(state.selectedRows).toBeInstanceOf(Set);
	});
});

// ── getRawCellValue ───────────────────────────────────────────────────────────

describe('getRawCellValue', () => {
	it('returns null for null', () => {
		expect(getRawCellValue(null)).toBeNull();
	});

	it('returns null for undefined', () => {
		expect(getRawCellValue(undefined)).toBeNull();
	});

	it('returns primitive string as-is', () => {
		expect(getRawCellValue('hello')).toBe('hello');
	});

	it('returns primitive number as-is', () => {
		expect(getRawCellValue(42)).toBe(42);
	});

	it('returns primitive boolean as-is', () => {
		expect(getRawCellValue(true)).toBe(true);
	});

	it('returns empty string as-is', () => {
		expect(getRawCellValue('')).toBe('');
	});

	it('returns 0 as-is', () => {
		expect(getRawCellValue(0)).toBe(0);
	});

	it('unwraps object with "full" property', () => {
		expect(getRawCellValue({ full: 'the-value' })).toBe('the-value');
	});

	it('unwraps object with "display" property', () => {
		expect(getRawCellValue({ display: 'shown' })).toBe('shown');
	});

	it('prefers "full" over "display"', () => {
		expect(getRawCellValue({ full: 'a', display: 'b' })).toBe('a');
	});

	it('unwraps nested "full" values recursively', () => {
		expect(getRawCellValue({ full: { full: 'deep' } })).toBe('deep');
	});

	it('unwraps nested "display" values recursively', () => {
		expect(getRawCellValue({ display: { display: 'deep' } })).toBe('deep');
	});

	it('returns object without full/display as-is', () => {
		const obj = { foo: 'bar' };
		expect(getRawCellValue(obj)).toBe(obj);
	});

	it('handles full=null — falls back to display', () => {
		expect(getRawCellValue({ full: null, display: 'fallback' })).toBe('fallback');
	});

	it('handles full=undefined — falls back to display', () => {
		expect(getRawCellValue({ full: undefined, display: 'fallback' })).toBe('fallback');
	});

	it('handles display=null — returns object', () => {
		const obj = { display: null };
		expect(getRawCellValue(obj)).toBe(obj);
	});

	it('handles full=0 (falsy but valid)', () => {
		expect(getRawCellValue({ full: 0 })).toBe(0);
	});

	it('handles display=0 (falsy but valid)', () => {
		// full is not present, display is 0 — falsy but not null/undefined
		expect(getRawCellValue({ display: 0 })).toBe(0);
	});

	it('handles full="" (empty string, valid)', () => {
		expect(getRawCellValue({ full: '' })).toBe('');
	});
});

// ── getResultsState / setResultsState ─────────────────────────────────────────

describe('getResultsState', () => {
	it('returns null for unknown boxId', () => {
		expect(getResultsState('nonexistent-box-id-xyz')).toBeNull();
	});

	it('returns null for empty/falsy boxId', () => {
		expect(getResultsState('')).toBeNull();
		expect(getResultsState(null)).toBeNull();
		expect(getResultsState(undefined)).toBeNull();
	});
});

describe('setResultsState', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('stores and retrieves state by boxId', () => {
		const state = { columns: [], rows: [] };
		setResultsState('test-box-set', state);
		expect(getResultsState('test-box-set')).toBe(state);
	});

	it('does not store when boxId is falsy', () => {
		setResultsState('', { data: 1 });
		expect(getResultsState('')).toBeNull();
	});

	it('does not store when boxId is null', () => {
		setResultsState(null, { data: 1 });
		expect(getResultsState(null)).toBeNull();
	});
});

// ── ensureResultsStateMap ─────────────────────────────────────────────────────

describe('ensureResultsStateMap', () => {
	it('returns the internal map object', () => {
		const map = ensureResultsStateMap();
		expect(map).toBeDefined();
		expect(typeof map).toBe('object');
	});
});

// ── resetCurrentResult ────────────────────────────────────────────────────────

describe('resetCurrentResult', () => {
	it('resets currentResult to null', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		setResultsState('reset-test-box', { test: true });
		resetCurrentResult();
		// After import, currentResult is a module-level let — we re-import to check
		// The function sets the module-level var to null
		expect(currentResult).toBeNull();
	});
});
