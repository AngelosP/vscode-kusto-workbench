import { describe, it, expect } from 'vitest';
import {
	normalizeValue,
	normalizeSection,
	normalizeStateForComparison,
	normalizeHeight,
	deepEqual,
	sanitizeStateForKind
} from '../../../src/host/kqlxEditorProvider';

// ---------------------------------------------------------------------------
// normalizeValue
// ---------------------------------------------------------------------------

describe('normalizeValue', () => {
	it('returns undefined for null', () => {
		expect(normalizeValue(null)).toBeUndefined();
	});

	it('returns undefined for undefined', () => {
		expect(normalizeValue(undefined)).toBeUndefined();
	});

	it('returns undefined for empty string', () => {
		expect(normalizeValue('')).toBeUndefined();
	});

	it('returns string as-is for non-empty', () => {
		expect(normalizeValue('hello')).toBe('hello');
	});

	it('returns undefined for empty array', () => {
		expect(normalizeValue([])).toBeUndefined();
	});

	it('normalizes nested arrays', () => {
		expect(normalizeValue([null, 'a'])).toEqual([undefined, 'a']);
	});

	it('returns undefined for empty object', () => {
		expect(normalizeValue({})).toBeUndefined();
	});

	it('strips undefined values from objects', () => {
		expect(normalizeValue({ a: 'x', b: null })).toEqual({ a: 'x' });
	});

	it('rounds height fields', () => {
		expect(normalizeValue(123.7, 'editorHeightPx')).toBe(124);
	});

	it('returns undefined for non-positive heights', () => {
		expect(normalizeValue(0, 'editorHeightPx')).toBeUndefined();
		expect(normalizeValue(-10, 'wrapperWidthPx')).toBeUndefined();
	});

	it('returns undefined for non-finite numbers', () => {
		expect(normalizeValue(NaN)).toBeUndefined();
		expect(normalizeValue(Infinity)).toBeUndefined();
	});

	it('passes through booleans', () => {
		expect(normalizeValue(true)).toBe(true);
		expect(normalizeValue(false)).toBe(false);
	});

	it('passes through regular numbers', () => {
		expect(normalizeValue(42)).toBe(42);
	});
});

// ---------------------------------------------------------------------------
// normalizeSection
// ---------------------------------------------------------------------------

describe('normalizeSection', () => {
	it('returns undefined for null', () => {
		expect(normalizeSection(null)).toBeUndefined();
	});

	it('returns undefined for unknown section type', () => {
		expect(normalizeSection({ type: 'unknown' })).toBeUndefined();
	});

	it('normalizes copilotQuery type to query', () => {
		const result = normalizeSection({ type: 'copilotQuery', query: 'T' });
		expect(result?.type).toBe('query');
	});

	it('normalizes query section', () => {
		const result = normalizeSection({ type: 'query', query: 'T | take 10' });
		expect(result).toEqual({ type: 'query', query: 'T | take 10' });
	});

	it('strips undefined/null values from sections', () => {
		const result = normalizeSection({ type: 'markdown', content: 'hello', extra: null });
		expect(result).toEqual({ type: 'markdown', content: 'hello' });
	});
});

// ---------------------------------------------------------------------------
// normalizeStateForComparison
// ---------------------------------------------------------------------------

describe('normalizeStateForComparison', () => {
	it('normalizes an empty state', () => {
		const result = normalizeStateForComparison({ sections: [] } as any);
		expect(result).toEqual({ caretDocsEnabled: true, sections: [] });
	});

	it('defaults caretDocsEnabled to true', () => {
		const result = normalizeStateForComparison({ sections: [] } as any);
		expect(result.caretDocsEnabled).toBe(true);
	});

	it('preserves explicit caretDocsEnabled false', () => {
		const result = normalizeStateForComparison({ caretDocsEnabled: false, sections: [] } as any);
		expect(result.caretDocsEnabled).toBe(false);
	});

	it('filters out unknown section types', () => {
		const result = normalizeStateForComparison({
			sections: [{ type: 'query', query: 'T' }, { type: 'unknown' }]
		} as any);
		expect((result.sections as any[]).length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// normalizeHeight
// ---------------------------------------------------------------------------

describe('normalizeHeight', () => {
	it('returns undefined for undefined', () => {
		expect(normalizeHeight(undefined)).toBeUndefined();
	});

	it('returns undefined for non-number', () => {
		expect(normalizeHeight('100')).toBeUndefined();
	});

	it('returns undefined for zero', () => {
		expect(normalizeHeight(0)).toBeUndefined();
	});

	it('returns undefined for negative', () => {
		expect(normalizeHeight(-50)).toBeUndefined();
	});

	it('rounds to integer', () => {
		expect(normalizeHeight(123.7)).toBe(124);
	});

	it('returns positive integer as-is', () => {
		expect(normalizeHeight(200)).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// deepEqual
// ---------------------------------------------------------------------------

describe('deepEqual', () => {
	it('returns true for identical primitives', () => {
		expect(deepEqual(1, 1)).toBe(true);
		expect(deepEqual('a', 'a')).toBe(true);
		expect(deepEqual(true, true)).toBe(true);
		expect(deepEqual(null, null)).toBe(true);
	});

	it('returns false for different primitives', () => {
		expect(deepEqual(1, 2)).toBe(false);
		expect(deepEqual('a', 'b')).toBe(false);
	});

	it('returns false for different types', () => {
		expect(deepEqual(1, '1')).toBe(false);
		expect(deepEqual(null, undefined)).toBe(false);
	});

	it('compares arrays element-by-element', () => {
		expect(deepEqual([1, 2], [1, 2])).toBe(true);
		expect(deepEqual([1, 2], [1, 3])).toBe(false);
		expect(deepEqual([1, 2], [1])).toBe(false);
	});

	it('compares objects key-by-key', () => {
		expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
		expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});

	it('handles nested structures', () => {
		expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
		expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
	});

	it('distinguishes arrays from objects', () => {
		expect(deepEqual([], {})).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// sanitizeStateForKind
// ---------------------------------------------------------------------------

describe('sanitizeStateForKind', () => {
	it('returns state unchanged for kqlx kind', () => {
		const state = { caretDocsEnabled: true, sections: [{ type: 'query' }] } as any;
		expect(sanitizeStateForKind('kqlx', state)).toBe(state);
	});

	it('filters sections for mdx kind', () => {
		const state = {
			caretDocsEnabled: true,
			sections: [
				{ type: 'markdown' },
				{ type: 'query' },
				{ type: 'url' },
				{ type: 'chart' },
				{ type: 'transformation' }
			]
		} as any;
		const result = sanitizeStateForKind('mdx', state);
		expect(result.sections).toHaveLength(3);
		expect(result.sections.map((s: any) => s.type)).toEqual(['markdown', 'url', 'transformation']);
	});

	it('preserves caretDocsEnabled', () => {
		const state = { caretDocsEnabled: false, sections: [] } as any;
		const result = sanitizeStateForKind('mdx', state);
		expect(result.caretDocsEnabled).toBe(false);
	});

	it('allows devnotes in mdx', () => {
		const state = { caretDocsEnabled: true, sections: [{ type: 'devnotes' }] } as any;
		const result = sanitizeStateForKind('mdx', state);
		expect(result.sections).toHaveLength(1);
	});
});
