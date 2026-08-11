import { describe, expect, it } from 'vitest';
import {
	admitKqlTableReferenceRanges,
	applyKqlTableReferenceReplacements
} from '../../src/webview/shared/kql-table-reference-ranges';

describe('KQL table reference range admission', () => {
	it('preserves exact CRLF text for a successful empty response', () => {
		const text = 'TableA\r\n| take 1';
		expect(admitKqlTableReferenceRanges(text, [])).toEqual([]);
		expect(applyKqlTableReferenceReplacements(text, [])).toBe(text);
	});

	it('sorts and deduplicates exact ranges before replacement', () => {
		const text = 'TableA | join TableB on id';
		const ranges = admitKqlTableReferenceRanges(text, [
			{ name: 'TableB', startOffset: 14, endOffset: 20 },
			{ name: 'TableA', startOffset: 0, endOffset: 6 },
			{ name: 'TableA', startOffset: 0, endOffset: 6 }
		]);

		expect(ranges).toEqual([
			{ value: 'TableA', start: 0, end: 6 },
			{ value: 'TableB', start: 14, end: 20 }
		]);
		expect(applyKqlTableReferenceReplacements(text, [
			{ start: 0, end: 6, text: 'QualifiedA' },
			{ start: 14, end: 20, text: 'QualifiedB' }
		])).toBe('QualifiedA | join QualifiedB on id');
	});

	it.each([
		[{ name: 'TableA', startOffset: -1, endOffset: 6 }],
		[{ name: 'TableA', startOffset: 0.5, endOffset: 6 }],
		[{ name: 'TableA', startOffset: 0, endOffset: 99 }],
		[{ name: 'Wrong', startOffset: 0, endOffset: 6 }],
		[
			{ name: 'TableA', startOffset: 0, endOffset: 6 },
			{ name: 'bleA', startOffset: 2, endOffset: 6 }
		]
	])('rejects malformed or overlapping range sets', (ranges) => {
		expect(admitKqlTableReferenceRanges('TableA | take 1', ranges)).toEqual([]);
	});

	it.each([
		['TableA', [{ name: 'ble', startOffset: 2, endOffset: 5 }]],
		['union Events*', [{ name: 'Events', startOffset: 6, endOffset: 12 }]],
		["database('Db').Events", [{ name: 'Events', startOffset: 15, endOffset: 21 }]],
		['StoredFunction()', [{ name: 'StoredFunction', startOffset: 0, endOffset: 14 }]]
	])('rejects non-standalone identifier ranges in %s', (text, ranges) => {
		expect(admitKqlTableReferenceRanges(text, ranges)).toEqual([]);
	});
});
