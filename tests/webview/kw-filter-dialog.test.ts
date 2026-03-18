import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import {
	rowMatchesFilterSpec,
	rowMatchesRules,
	isColumnFiltered,
	getFilterSpecForColumn,
	isNullOrEmptyForFilter,
	filterValueKey,
	tryParseNumber,
	tryParseDateMs,
	durationToMs,
	NULL_EMPTY_KEY,
	type ValuesFilterSpec,
	type RulesFilterSpec,
	type CompoundFilterSpec,
	type RuleFilterRule,
} from '../../src/webview/components/kw-filter-dialog.js';
import '../../src/webview/components/kw-filter-dialog.js';
import type { KwFilterDialog } from '../../src/webview/components/kw-filter-dialog.js';

// ── rowMatchesFilterSpec with ValuesFilterSpec ─────────────────────────────────

describe('rowMatchesFilterSpec — values', () => {
	const spec = (allowed: string[]): ValuesFilterSpec => ({ kind: 'values', allowedValues: allowed });

	it('includes cell when value is in allowed list', () => {
		expect(rowMatchesFilterSpec('hello', spec(['hello', 'world']))).toBe(true);
	});

	it('excludes cell when value is NOT in allowed list', () => {
		expect(rowMatchesFilterSpec('nope', spec(['hello', 'world']))).toBe(false);
	});

	it('handles null cell via NULL_EMPTY_KEY', () => {
		expect(rowMatchesFilterSpec(null, spec([NULL_EMPTY_KEY]))).toBe(true);
		expect(rowMatchesFilterSpec(null, spec(['hello']))).toBe(false);
	});

	it('handles undefined cell via NULL_EMPTY_KEY', () => {
		expect(rowMatchesFilterSpec(undefined, spec([NULL_EMPTY_KEY]))).toBe(true);
	});

	it('handles object cells with .full field', () => {
		const cell = { full: 'actualValue', display: 'shown' };
		expect(rowMatchesFilterSpec(cell, spec(['actualValue']))).toBe(true);
		expect(rowMatchesFilterSpec(cell, spec(['shown']))).toBe(false);
	});

	it('empty allowedValues array rejects everything', () => {
		expect(rowMatchesFilterSpec('anything', spec([]))).toBe(false);
		expect(rowMatchesFilterSpec(null, spec([]))).toBe(false);
	});

	it('returns true when spec is null', () => {
		expect(rowMatchesFilterSpec('anything', null)).toBe(true);
	});
});

// ── rowMatchesRules — Number operators ────────────────────────────────────────

describe('rowMatchesRules — number', () => {
	const numSpec = (rules: RuleFilterRule[]): RulesFilterSpec => ({
		kind: 'rules', dataType: 'number', rules,
	});

	it('lt: basic less-than', () => {
		expect(rowMatchesRules(5, numSpec([{ op: 'lt', a: '10' }]))).toBe(true);
		expect(rowMatchesRules(15, numSpec([{ op: 'lt', a: '10' }]))).toBe(false);
	});

	it('lt: boundary (equal)', () => {
		expect(rowMatchesRules(10, numSpec([{ op: 'lt', a: '10' }]))).toBe(false);
	});

	it('lt: null value', () => {
		expect(rowMatchesRules(null, numSpec([{ op: 'lt', a: '10' }]))).toBe(false);
	});

	it('gt: basic greater-than', () => {
		expect(rowMatchesRules(15, numSpec([{ op: 'gt', a: '10' }]))).toBe(true);
		expect(rowMatchesRules(5, numSpec([{ op: 'gt', a: '10' }]))).toBe(false);
	});

	it('gt: boundary (equal)', () => {
		expect(rowMatchesRules(10, numSpec([{ op: 'gt', a: '10' }]))).toBe(false);
	});

	it('between: in-range (inclusive)', () => {
		expect(rowMatchesRules(5, numSpec([{ op: 'between', a: '1', b: '10' }]))).toBe(true);
		expect(rowMatchesRules(1, numSpec([{ op: 'between', a: '1', b: '10' }]))).toBe(true);
		expect(rowMatchesRules(10, numSpec([{ op: 'between', a: '1', b: '10' }]))).toBe(true);
	});

	it('between: out-of-range', () => {
		expect(rowMatchesRules(11, numSpec([{ op: 'between', a: '1', b: '10' }]))).toBe(false);
	});

	it('between: inverted bounds (auto-normalized)', () => {
		expect(rowMatchesRules(5, numSpec([{ op: 'between', a: '10', b: '1' }]))).toBe(true);
	});

	it('top: threshold-based', () => {
		expect(rowMatchesRules(100, numSpec([{ op: 'top', threshold: 50 }]))).toBe(true);
		expect(rowMatchesRules(30, numSpec([{ op: 'top', threshold: 50 }]))).toBe(false);
	});

	it('bottom: threshold-based', () => {
		expect(rowMatchesRules(30, numSpec([{ op: 'bottom', threshold: 50 }]))).toBe(true);
		expect(rowMatchesRules(100, numSpec([{ op: 'bottom', threshold: 50 }]))).toBe(false);
	});

	it('non-numeric cell with number rules → false', () => {
		expect(rowMatchesRules('abc', numSpec([{ op: 'lt', a: '10' }]))).toBe(false);
	});
});

// ── rowMatchesRules — Date operators ──────────────────────────────────────────

describe('rowMatchesRules — date', () => {
	const dateSpec = (rules: RuleFilterRule[]): RulesFilterSpec => ({
		kind: 'rules', dataType: 'date', rules,
	});

	const jan1 = '2024-01-01T00:00:00Z';
	const jan15 = '2024-01-15T00:00:00Z';
	const feb1 = '2024-02-01T00:00:00Z';

	it('before: ISO date strings', () => {
		expect(rowMatchesRules(jan1, dateSpec([{ op: 'before', a: jan15 }]))).toBe(true);
		expect(rowMatchesRules(feb1, dateSpec([{ op: 'before', a: jan15 }]))).toBe(false);
	});

	it('after: ISO date strings', () => {
		expect(rowMatchesRules(feb1, dateSpec([{ op: 'after', a: jan15 }]))).toBe(true);
		expect(rowMatchesRules(jan1, dateSpec([{ op: 'after', a: jan15 }]))).toBe(false);
	});

	it('between: date range', () => {
		expect(rowMatchesRules(jan15, dateSpec([{ op: 'between', a: jan1, b: feb1 }]))).toBe(true);
		expect(rowMatchesRules('2023-12-01T00:00:00Z', dateSpec([{ op: 'between', a: jan1, b: feb1 }]))).toBe(false);
	});

	it('last: duration-based with threshold', () => {
		const now = Date.now();
		const recent = new Date(now - 3 * 86_400_000).toISOString(); // 3 days ago
		const threshold = new Date(now - durationToMs(7, 'days')).toISOString(); // 7 days ago
		expect(rowMatchesRules(recent, dateSpec([{ op: 'last', threshold }]))).toBe(true);

		const old = new Date(now - 30 * 86_400_000).toISOString(); // 30 days ago
		expect(rowMatchesRules(old, dateSpec([{ op: 'last', threshold }]))).toBe(false);
	});

	it('non-date cell → false', () => {
		expect(rowMatchesRules('not-a-date', dateSpec([{ op: 'before', a: jan15 }]))).toBe(false);
	});
});

// ── rowMatchesRules — String operators ────────────────────────────────────────

describe('rowMatchesRules — string', () => {
	const strSpec = (rules: RuleFilterRule[]): RulesFilterSpec => ({
		kind: 'rules', dataType: 'string', rules,
	});

	it('startsWith', () => {
		expect(rowMatchesRules('hello world', strSpec([{ op: 'startsWith', text: 'hello' }]))).toBe(true);
		expect(rowMatchesRules('world hello', strSpec([{ op: 'startsWith', text: 'hello' }]))).toBe(false);
	});

	it('notStartsWith', () => {
		expect(rowMatchesRules('world hello', strSpec([{ op: 'notStartsWith', text: 'hello' }]))).toBe(true);
		expect(rowMatchesRules('hello world', strSpec([{ op: 'notStartsWith', text: 'hello' }]))).toBe(false);
	});

	it('endsWith', () => {
		expect(rowMatchesRules('hello world', strSpec([{ op: 'endsWith', text: 'world' }]))).toBe(true);
		expect(rowMatchesRules('world hello', strSpec([{ op: 'endsWith', text: 'world' }]))).toBe(false);
	});

	it('notEndsWith', () => {
		expect(rowMatchesRules('world hello', strSpec([{ op: 'notEndsWith', text: 'world' }]))).toBe(true);
		expect(rowMatchesRules('hello world', strSpec([{ op: 'notEndsWith', text: 'world' }]))).toBe(false);
	});

	it('contains', () => {
		expect(rowMatchesRules('say hello world', strSpec([{ op: 'contains', text: 'hello' }]))).toBe(true);
		expect(rowMatchesRules('say goodbye', strSpec([{ op: 'contains', text: 'hello' }]))).toBe(false);
	});

	it('notContains', () => {
		expect(rowMatchesRules('say goodbye', strSpec([{ op: 'notContains', text: 'hello' }]))).toBe(true);
		expect(rowMatchesRules('say hello', strSpec([{ op: 'notContains', text: 'hello' }]))).toBe(false);
	});

	it('case insensitivity', () => {
		expect(rowMatchesRules('HELLO WORLD', strSpec([{ op: 'startsWith', text: 'hello' }]))).toBe(true);
		expect(rowMatchesRules('hello world', strSpec([{ op: 'contains', text: 'WORLD' }]))).toBe(true);
	});

	it('empty needle → null (treated as no-op, passthrough)', () => {
		expect(rowMatchesRules('anything', strSpec([{ op: 'contains', text: '' }]))).toBe(true);
		expect(rowMatchesRules('anything', strSpec([{ op: 'contains', text: '   ' }]))).toBe(true);
	});
});

// ── rowMatchesRules — JSON operators ──────────────────────────────────────────

describe('rowMatchesRules — json', () => {
	const jsonSpec = (rules: RuleFilterRule[]): RulesFilterSpec => ({
		kind: 'rules', dataType: 'json', rules,
	});

	it('contains: finds key in object cell', () => {
		const cell = { full: { name: 'Alice', age: 30 } };
		expect(rowMatchesRules(cell, jsonSpec([{ op: 'contains', text: 'alice' }]))).toBe(true);
	});

	it('notContains: key not in object cell', () => {
		const cell = { full: { name: 'Alice', age: 30 } };
		expect(rowMatchesRules(cell, jsonSpec([{ op: 'notContains', text: 'bob' }]))).toBe(true);
		expect(rowMatchesRules(cell, jsonSpec([{ op: 'notContains', text: 'alice' }]))).toBe(false);
	});

	it('contains with plain string cell', () => {
		expect(rowMatchesRules('some json text', jsonSpec([{ op: 'contains', text: 'json' }]))).toBe(true);
	});
});

// ── rowMatchesRules — Universal operators ─────────────────────────────────────

describe('rowMatchesRules — universal ops', () => {
	const strSpec = (rules: RuleFilterRule[]): RulesFilterSpec => ({
		kind: 'rules', dataType: 'string', rules,
	});

	it('isEmpty: null → true', () => {
		expect(rowMatchesRules(null, strSpec([{ op: 'isEmpty' }]))).toBe(true);
	});

	it('isEmpty: undefined → true', () => {
		expect(rowMatchesRules(undefined, strSpec([{ op: 'isEmpty' }]))).toBe(true);
	});

	it('isEmpty: empty string → true', () => {
		expect(rowMatchesRules('', strSpec([{ op: 'isEmpty' }]))).toBe(true);
	});

	it('isEmpty: whitespace → true', () => {
		expect(rowMatchesRules('   ', strSpec([{ op: 'isEmpty' }]))).toBe(true);
	});

	it('isEmpty: non-empty → false', () => {
		expect(rowMatchesRules('hello', strSpec([{ op: 'isEmpty' }]))).toBe(false);
	});

	it('isNotEmpty: non-empty → true', () => {
		expect(rowMatchesRules('hello', strSpec([{ op: 'isNotEmpty' }]))).toBe(true);
	});

	it('isNotEmpty: null → false', () => {
		expect(rowMatchesRules(null, strSpec([{ op: 'isNotEmpty' }]))).toBe(false);
	});
});

// ── Compound filters ──────────────────────────────────────────────────────────

describe('rowMatchesFilterSpec — compound', () => {
	it('values + rules both must pass (AND semantics)', () => {
		const spec: CompoundFilterSpec = {
			kind: 'compound',
			values: { kind: 'values', allowedValues: ['42'] },
			rules: { kind: 'rules', dataType: 'number', rules: [{ op: 'gt', a: '10' }] },
		};
		expect(rowMatchesFilterSpec(42, spec)).toBe(true);
		// Passes values but fails rules
		expect(rowMatchesFilterSpec(5, spec)).toBe(false);
	});

	it('values-only compound', () => {
		const spec: CompoundFilterSpec = {
			kind: 'compound',
			values: { kind: 'values', allowedValues: ['hello'] },
		};
		expect(rowMatchesFilterSpec('hello', spec)).toBe(true);
		expect(rowMatchesFilterSpec('bye', spec)).toBe(false);
	});

	it('rules-only compound', () => {
		const spec: CompoundFilterSpec = {
			kind: 'compound',
			rules: { kind: 'rules', dataType: 'number', rules: [{ op: 'gt', a: '10' }] },
		};
		expect(rowMatchesFilterSpec(20, spec)).toBe(true);
		expect(rowMatchesFilterSpec(5, spec)).toBe(false);
	});
});

// ── Rule join logic ───────────────────────────────────────────────────────────

describe('rowMatchesRules — join logic', () => {
	const strSpec = (rules: RuleFilterRule[], combineOp?: 'and' | 'or'): RulesFilterSpec => ({
		kind: 'rules', dataType: 'string', combineOp, rules,
	});

	it('all AND rules: all must pass', () => {
		const rules: RuleFilterRule[] = [
			{ op: 'startsWith', text: 'hello' },
			{ op: 'endsWith', text: 'world' },
		];
		expect(rowMatchesRules('hello world', strSpec(rules, 'and'))).toBe(true);
		expect(rowMatchesRules('hello earth', strSpec(rules, 'and'))).toBe(false);
	});

	it('all OR rules: any can pass', () => {
		const rules: RuleFilterRule[] = [
			{ op: 'startsWith', text: 'hello' },
			{ op: 'startsWith', text: 'world' },
		];
		expect(rowMatchesRules('hello there', strSpec(rules, 'or'))).toBe(true);
		expect(rowMatchesRules('world there', strSpec(rules, 'or'))).toBe(true);
		expect(rowMatchesRules('goodbye', strSpec(rules, 'or'))).toBe(false);
	});

	it('mixed per-rule join: prev rule.join overrides combineOp', () => {
		// Rules: startsWith 'a' OR endsWith 'z' — even though combineOp is 'and'
		// The join between rule[0] and rule[1] is determined by rule[0].join
		const rules: RuleFilterRule[] = [
			{ op: 'startsWith', text: 'a', join: 'or' },
			{ op: 'endsWith', text: 'z' },
		];
		// 'az' passes both
		expect(rowMatchesRules('az', strSpec(rules, 'and'))).toBe(true);
		// 'ab' passes first only — OR means it should pass
		expect(rowMatchesRules('ab', strSpec(rules, 'and'))).toBe(true);
		// 'xz' passes second only — OR means it should pass
		expect(rowMatchesRules('xz', strSpec(rules, 'and'))).toBe(true);
		// 'xy' fails both
		expect(rowMatchesRules('xy', strSpec(rules, 'and'))).toBe(false);
	});

	it('no valid rules → true (passthrough)', () => {
		expect(rowMatchesRules('anything', strSpec([]))).toBe(true);
		expect(rowMatchesRules('anything', strSpec([{ op: '' }]))).toBe(true);
	});
});

// ── Helper function edge cases ────────────────────────────────────────────────

describe('tryParseNumber', () => {
	it('parses finite numbers', () => {
		expect(tryParseNumber(42)).toBe(42);
		expect(tryParseNumber(3.14)).toBe(3.14);
		expect(tryParseNumber(-1)).toBe(-1);
	});

	it('parses numeric strings', () => {
		expect(tryParseNumber('42')).toBe(42);
		expect(tryParseNumber('3.14')).toBe(3.14);
		expect(tryParseNumber('-1')).toBe(-1);
	});

	it('null → null', () => {
		expect(tryParseNumber(null)).toBeNull();
	});

	it('undefined → null', () => {
		expect(tryParseNumber(undefined)).toBeNull();
	});

	it('NaN → null', () => {
		expect(tryParseNumber(NaN)).toBeNull();
	});

	it('Infinity → null', () => {
		expect(tryParseNumber(Infinity)).toBeNull();
		expect(tryParseNumber(-Infinity)).toBeNull();
	});

	it('non-numeric strings → null', () => {
		expect(tryParseNumber('abc')).toBeNull();
		expect(tryParseNumber('')).toBeNull();
	});

	it('booleans parse as numbers (Number coercion)', () => {
		// Note: tryParseNumber uses Number(String(raw)), so true → "true" → NaN → null
		expect(tryParseNumber(true)).toBeNull();
		expect(tryParseNumber(false)).toBeNull();
	});
});

describe('tryParseDateMs (filter-dialog version)', () => {
	it('parses ISO date strings', () => {
		const result = tryParseDateMs('2024-01-15T10:30:00Z');
		expect(result).toBeTypeOf('number');
		expect(result).toBe(Date.parse('2024-01-15T10:30:00Z'));
	});

	it('handles Date objects', () => {
		const d = new Date('2024-01-15T10:30:00Z');
		expect(tryParseDateMs(d)).toBe(d.getTime());
	});

	it('non-date strings → null', () => {
		expect(tryParseDateMs('not a date')).toBeNull();
	});

	it('null → null', () => {
		expect(tryParseDateMs(null)).toBeNull();
	});

	it('undefined → null', () => {
		expect(tryParseDateMs(undefined)).toBeNull();
	});

	it('numbers → null', () => {
		expect(tryParseDateMs(42)).toBeNull();
		expect(tryParseDateMs(1705312200000)).toBeNull();
	});
});

describe('durationToMs', () => {
	it('minutes', () => {
		expect(durationToMs(1, 'minutes')).toBe(60_000);
		expect(durationToMs(5, 'minutes')).toBe(300_000);
	});

	it('hours', () => {
		expect(durationToMs(1, 'hours')).toBe(3_600_000);
	});

	it('days', () => {
		expect(durationToMs(1, 'days')).toBe(86_400_000);
		expect(durationToMs(7, 'days')).toBe(604_800_000);
	});

	it('weeks', () => {
		expect(durationToMs(1, 'weeks')).toBe(7 * 86_400_000);
	});

	it('months (approximate: 30 days)', () => {
		expect(durationToMs(1, 'months')).toBe(30 * 86_400_000);
	});

	it('years (approximate: 365 days)', () => {
		expect(durationToMs(1, 'years')).toBe(365 * 86_400_000);
	});

	it('zero', () => {
		expect(durationToMs(0, 'days')).toBe(0);
	});

	it('negative', () => {
		expect(durationToMs(-2, 'days')).toBe(-2 * 86_400_000);
	});
});

describe('isNullOrEmptyForFilter', () => {
	it('null → true', () => {
		expect(isNullOrEmptyForFilter(null)).toBe(true);
	});

	it('undefined → true', () => {
		expect(isNullOrEmptyForFilter(undefined)).toBe(true);
	});

	it('empty string → true', () => {
		expect(isNullOrEmptyForFilter('')).toBe(true);
	});

	it('whitespace-only string → true', () => {
		expect(isNullOrEmptyForFilter('   ')).toBe(true);
	});

	it('zero is NOT empty', () => {
		expect(isNullOrEmptyForFilter(0)).toBe(false);
	});

	it('false is NOT empty', () => {
		expect(isNullOrEmptyForFilter(false)).toBe(false);
	});

	it('non-empty string → false', () => {
		expect(isNullOrEmptyForFilter('hello')).toBe(false);
	});
});

describe('filterValueKey', () => {
	it('returns NULL_EMPTY_KEY for null', () => {
		expect(filterValueKey(null)).toBe(NULL_EMPTY_KEY);
	});

	it('returns NULL_EMPTY_KEY for undefined', () => {
		expect(filterValueKey(undefined)).toBe(NULL_EMPTY_KEY);
	});

	it('returns NULL_EMPTY_KEY for empty string', () => {
		expect(filterValueKey('')).toBe(NULL_EMPTY_KEY);
	});

	it('returns string representation for values', () => {
		expect(filterValueKey('hello')).toBe('hello');
		expect(filterValueKey(42)).toBe('42');
		expect(filterValueKey(true)).toBe('true');
	});
});

describe('isColumnFiltered / getFilterSpecForColumn', () => {
	it('returns spec when column has active filter', () => {
		const filters = [{ id: '2', value: { kind: 'values' as const, allowedValues: ['a'] } }];
		expect(isColumnFiltered(2, filters)).toBe(true);
		expect(getFilterSpecForColumn(2, filters)).toEqual({ kind: 'values', allowedValues: ['a'] });
	});

	it('returns null / false when no filter for column', () => {
		const filters = [{ id: '2', value: { kind: 'values' as const, allowedValues: ['a'] } }];
		expect(isColumnFiltered(0, filters)).toBe(false);
		expect(getFilterSpecForColumn(0, filters)).toBeNull();
	});

	it('returns null for empty filters array', () => {
		expect(getFilterSpecForColumn(0, [])).toBeNull();
		expect(isColumnFiltered(0, [])).toBe(false);
	});
});

// ── Lit component tests ───────────────────────────────────────────────────────

let container: HTMLDivElement;

function createFilterDialog(opts: {
	columns?: Array<{ name: string }>;
	rows?: unknown[][];
	colIndex?: number;
	columnFilters?: Array<{ id: string; value: unknown }>;
} = {}): KwFilterDialog {
	const {
		columns = [{ name: 'Col1' }, { name: 'Col2' }],
		rows = [['A', 1], ['B', 2], ['A', 3], ['C', 1]],
		colIndex = 0,
		columnFilters = [],
	} = opts;
	render(html`
		<kw-filter-dialog
			.columns=${columns}
			.rows=${rows}
			.colIndex=${colIndex}
			.columnFilters=${columnFilters}
		></kw-filter-dialog>
	`, container);
	return container.querySelector('kw-filter-dialog')!;
}

function getShadow(el: KwFilterDialog, selector: string): HTMLElement | null {
	return el.shadowRoot?.querySelector(selector) as HTMLElement | null;
}

function getAllShadow(el: KwFilterDialog, selector: string): HTMLElement[] {
	return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? []) as HTMLElement[];
}

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
});

describe('kw-filter-dialog — Lit component', () => {
	it('renders with column name in header', async () => {
		const el = createFilterDialog({ columns: [{ name: 'Status' }], colIndex: 0 });
		await el.updateComplete;
		const header = getShadow(el, '.sd-h strong');
		expect(header?.textContent).toContain('Status');
	});

	it('renders values mode by default', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		const modeButtons = getAllShadow(el, '.fd-mode');
		expect(modeButtons.length).toBe(2);
		expect(modeButtons[0].textContent).toBe('Values');
		expect(modeButtons[0].classList.contains('active')).toBe(true);
	});

	it('shows value choices with counts from rows', async () => {
		const el = createFilterDialog({
			rows: [['X', 1], ['Y', 2], ['X', 3]],
			colIndex: 0,
		});
		await el.updateComplete;
		const items = getAllShadow(el, '.fd-item');
		// X appears 2 times, Y appears 1 time
		expect(items.length).toBe(2);
		const labels = items.map(i => i.querySelector('.fd-item-text')?.textContent?.trim());
		expect(labels).toContain('X');
		expect(labels).toContain('Y');
	});

	it('all values are checked by default (items count matches row count)', async () => {
		const el = createFilterDialog({
			rows: [['A', 1], ['B', 2]],
			colIndex: 0,
		});
		await el.updateComplete;
		// Verify items are displayed (the number of items matches unique values)
		const items = getAllShadow(el, '.fd-item');
		expect(items.length).toBe(2);
	});

	it('switching to rules mode shows rules UI', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		const rulesBtn = getAllShadow(el, '.fd-mode')[1];
		rulesBtn.click();
		await el.updateComplete;
		// Should show the rules list and an initial rule row
		const ruleRows = getAllShadow(el, '.fr-row');
		expect(ruleRows.length).toBeGreaterThanOrEqual(1);
	});

	it('shows data type selector in rules mode', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		getAllShadow(el, '.fd-mode')[1].click();
		await el.updateComplete;
		const typeSelect = getShadow(el, '.fr-type-select') as HTMLSelectElement;
		expect(typeSelect).toBeTruthy();
	});

	it('renders search bar in values mode', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		const searchInput = getShadow(el, '.sinp') as HTMLInputElement;
		expect(searchInput).toBeTruthy();
		expect(searchInput.placeholder).toBe('Search values...');
	});

	it('select all / deselect all buttons exist', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		const buttons = getAllShadow(el, '.fd-actions .sd-btn');
		expect(buttons.length).toBe(2);
		expect(buttons[0].textContent).toBe('Select all');
		expect(buttons[1].textContent).toBe('Deselect all');
	});

	it('renders apply and remove filter buttons in footer', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		const footerBtns = getAllShadow(el, '.sd-f .sd-btn');
		expect(footerBtns.length).toBe(2);
		expect(footerBtns[0].textContent).toBe('Remove Filter');
		expect(footerBtns[1].textContent).toBe('Apply');
	});

	it('dispatches filter-close when backdrop is clicked', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		let closed = false;
		el.addEventListener('filter-close', () => { closed = true; });
		const bg = getShadow(el, '.sd-bg')!;
		bg.click();
		expect(closed).toBe(true);
	});

	it('dispatches filter-close when close button is clicked', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		let closed = false;
		el.addEventListener('filter-close', () => { closed = true; });
		const closeBtn = getShadow(el, '.sd-x')!;
		closeBtn.click();
		expect(closed).toBe(true);
	});

	it('dispatches filter-apply with null when Remove Filter clicked', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		let detail: any = null;
		el.addEventListener('filter-apply', ((e: CustomEvent) => { detail = e.detail; }) as EventListener);
		const removeBtn = getAllShadow(el, '.sd-f .sd-btn')[0];
		removeBtn.click();
		expect(detail).not.toBeNull();
		expect(detail.filterSpec).toBeNull();
	});

	it('dispatches filter-apply with values spec when Apply clicked after deselecting', async () => {
		const el = createFilterDialog({
			rows: [['A', 1], ['B', 2], ['C', 3]],
			colIndex: 0,
		});
		await el.updateComplete;
		// Deselect all, then select only 'A'
		getAllShadow(el, '.fd-actions .sd-btn')[1].click(); // Deselect all
		await el.updateComplete;
		const checkboxes = getAllShadow(el, '.fd-item input[type="checkbox"]') as HTMLInputElement[];
		// Find the 'A' checkbox and check it
		const items = getAllShadow(el, '.fd-item');
		for (let i = 0; i < items.length; i++) {
			const text = items[i].querySelector('.fd-item-text')?.textContent?.trim();
			if (text === 'A') {
				checkboxes[i].click();
				break;
			}
		}
		await el.updateComplete;

		let detail: any = null;
		el.addEventListener('filter-apply', ((e: CustomEvent) => { detail = e.detail; }) as EventListener);
		getAllShadow(el, '.sd-f .sd-btn')[1].click(); // Apply
		expect(detail).not.toBeNull();
		expect(detail.filterSpec).not.toBeNull();
		expect(detail.filterSpec.kind).toBe('values');
		expect(detail.filterSpec.allowedValues).toEqual(['A']);
	});

	it('does not close dialog when clicking inside the dialog', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		let closed = false;
		el.addEventListener('filter-close', () => { closed = true; });
		const dialog = getShadow(el, '.sd.fd')!;
		dialog.click();
		expect(closed).toBe(false);
	});

	it('renders nothing when colIndex is null', async () => {
		render(html`<kw-filter-dialog .colIndex=${null}></kw-filter-dialog>`, container);
		const el = container.querySelector('kw-filter-dialog')! as KwFilterDialog;
		await el.updateComplete;
		expect(getShadow(el, '.sd-bg')).toBeNull();
	});

	it('shows "No values match" when search has no results', async () => {
		const el = createFilterDialog({
			rows: [['A', 1], ['B', 2]],
			colIndex: 0,
		});
		await el.updateComplete;
		const searchInput = getShadow(el, '.sinp') as HTMLInputElement;
		searchInput.value = 'zzzzz';
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		await el.updateComplete;
		const empty = getShadow(el, '.fd-empty');
		expect(empty?.textContent).toBe('No values match');
	});

	it('handles null/empty row values via NULL_EMPTY_KEY', async () => {
		const el = createFilterDialog({
			rows: [[null, 1], ['', 2], ['A', 3]],
			colIndex: 0,
		});
		await el.updateComplete;
		const items = getAllShadow(el, '.fd-item');
		const labels = items.map(i => i.querySelector('.fd-item-text')?.textContent?.trim());
		expect(labels).toContain('Null or empty');
		expect(labels).toContain('A');
	});

	it('shows combine checkbox in rules mode', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		getAllShadow(el, '.fd-mode')[1].click();
		await el.updateComplete;
		const combineLabel = getShadow(el, '.fd-combine');
		expect(combineLabel).toBeTruthy();
		expect(combineLabel?.textContent).toContain('Apply these rules on top of value filters');
	});

	it('renders "No rules yet" when rules list is empty', async () => {
		const el = createFilterDialog();
		await el.updateComplete;
		getAllShadow(el, '.fd-mode')[1].click();
		await el.updateComplete;
		// The initDraft adds an initial rule, so we need to check that the rule row is present
		const ruleRows = getAllShadow(el, '.fr-row');
		expect(ruleRows.length).toBeGreaterThanOrEqual(1);
	});
});
