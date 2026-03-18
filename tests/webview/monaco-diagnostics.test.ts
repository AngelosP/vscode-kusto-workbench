import { describe, it, expect } from 'vitest';
import {
	__kustoMaskCommentsPreserveLayout,
	__kustoClamp,
	__kustoSplitTopLevelStatements,
	__kustoSplitPipelineStagesDeep,
	__kustoFindLastTopLevelPipeBeforeOffset,
	__kustoGetStatementStartAtOffset,
	__kustoBuildLineStarts,
	__kustoOffsetToPosition,
	__kustoIsIdentStart,
	__kustoIsIdentPart,
	__kustoScanIdentifiers,
	__kustoLevenshtein,
	__kustoBestMatches,
	__kustoParsePipeHeaderFromLine,
	__kustoPipeHeaderAllowsIndentedContinuation,
	__kustoGetActivePipeStageInfoBeforeOffset,
} from '../../src/webview/modules/monaco-diagnostics.js';

// ── __kustoMaskCommentsPreserveLayout ─────────────────────────────────────────

describe('__kustoMaskCommentsPreserveLayout', () => {
	it('masks line comments preserving layout', () => {
		const input = 'Table\n// comment here\n| where x > 5';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toHaveLength(input.length);
		expect(result).toContain('Table');
		expect(result).toContain('| where x > 5');
		// Comment body replaced with spaces, but // delimiters and newline preserved
		expect(result).toContain('//');
		expect(result.split('\n')).toHaveLength(3);
	});

	it('masks block comments preserving layout', () => {
		const input = 'Table /* block comment */ | where x > 5';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toHaveLength(input.length);
		expect(result).toContain('/*');
		expect(result).toContain('*/');
		expect(result).not.toContain('block comment');
	});

	it('preserves single-quoted strings', () => {
		const input = "print 'hello // not a comment'";
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toContain("'hello // not a comment'");
	});

	it('preserves double-quoted strings', () => {
		const input = 'print "hello /* not a comment */"';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toContain('"hello /* not a comment */"');
	});

	it('handles escaped single quotes (Kusto \'\')', () => {
		const input = "print 'it''s a test'";
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toContain("'it''s a test'");
	});

	it('handles escaped double quotes', () => {
		const input = 'print "say \\"hello\\""';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toContain('"say \\"hello\\""');
	});

	it('handles empty input', () => {
		expect(__kustoMaskCommentsPreserveLayout('')).toBe('');
		expect(__kustoMaskCommentsPreserveLayout(null)).toBe('');
	});

	it('preserves newlines inside block comments', () => {
		const input = 'Table\n/* multi\nline\ncomment */\n| where x > 5';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result.split('\n')).toHaveLength(5);
		expect(result).toHaveLength(input.length);
	});

	it('handles mixed comments and strings', () => {
		const input = "T | where x == '//test' // real comment\n| project a";
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toContain("'//test'");
		expect(result).toContain('//');
	});

	it('handles no comments', () => {
		const input = 'Table | where x > 5';
		expect(__kustoMaskCommentsPreserveLayout(input)).toBe(input);
	});
});

// ── __kustoClamp ──────────────────────────────────────────────────────────────

describe('__kustoClamp', () => {
	it('clamps within range', () => {
		expect(__kustoClamp(5, 0, 10)).toBe(5);
	});

	it('clamps below minimum', () => {
		expect(__kustoClamp(-5, 0, 10)).toBe(0);
	});

	it('clamps above maximum', () => {
		expect(__kustoClamp(15, 0, 10)).toBe(10);
	});

	it('handles equal min and max', () => {
		expect(__kustoClamp(5, 3, 3)).toBe(3);
	});

	it('handles boundary values', () => {
		expect(__kustoClamp(0, 0, 10)).toBe(0);
		expect(__kustoClamp(10, 0, 10)).toBe(10);
	});
});

// ── __kustoSplitTopLevelStatements ────────────────────────────────────────────

describe('__kustoSplitTopLevelStatements', () => {
	it('splits on semicolons', () => {
		const result = __kustoSplitTopLevelStatements('let a = 1; T | where x > 5');
		expect(result).toHaveLength(2);
		expect(result[0].text).toBe('let a = 1');
		expect(result[1].text).toBe(' T | where x > 5');
	});

	it('splits on blank lines', () => {
		const result = __kustoSplitTopLevelStatements('Table1 | where x > 5\n\nTable2 | where y > 3');
		expect(result).toHaveLength(2);
		expect(result[0].text).toContain('Table1');
		expect(result[1].text).toContain('Table2');
	});

	it('does not split inside strings', () => {
		const result = __kustoSplitTopLevelStatements("print 'a;b'");
		expect(result).toHaveLength(1);
	});

	it('does not split inside block comments', () => {
		const result = __kustoSplitTopLevelStatements('T /* ; */ | where x > 5');
		expect(result).toHaveLength(1);
	});

	it('does not split inside line comments', () => {
		const result = __kustoSplitTopLevelStatements('T // comment;\n| where x > 5');
		expect(result).toHaveLength(1);
	});

	it('does not split inside brackets', () => {
		const result = __kustoSplitTopLevelStatements('T | where f(a; b)');
		expect(result).toHaveLength(1);
	});

	it('handles empty input', () => {
		const result = __kustoSplitTopLevelStatements('');
		expect(result).toHaveLength(0);
	});

	it('handles triple-backtick strings', () => {
		const result = __kustoSplitTopLevelStatements('print ```hello;world```');
		expect(result).toHaveLength(1);
	});

	it('tracks startOffset correctly', () => {
		const result = __kustoSplitTopLevelStatements('let a = 1; T');
		expect(result[0].startOffset).toBe(0);
		expect(result[1].startOffset).toBe(10);
	});

	it('handles multiple blank lines as single separator', () => {
		const result = __kustoSplitTopLevelStatements('Table1\n\n\n\nTable2');
		expect(result).toHaveLength(2);
	});

	it('skips empty statements', () => {
		const result = __kustoSplitTopLevelStatements(';;; T');
		expect(result.every((s: any) => String(s.text || '').trim().length > 0)).toBe(true);
	});
});

// ── __kustoSplitPipelineStagesDeep ────────────────────────────────────────────

describe('__kustoSplitPipelineStagesDeep', () => {
	it('splits simple pipeline', () => {
		const result = __kustoSplitPipelineStagesDeep('Table | where x > 5 | project a');
		expect(result).toHaveLength(3);
		expect(result[0].trim()).toBe('Table');
		expect(result[1].trim()).toContain('where');
		expect(result[2].trim()).toContain('project');
	});

	it('does not split pipes inside parentheses', () => {
		const result = __kustoSplitPipelineStagesDeep('T | where f(a | b)');
		expect(result).toHaveLength(2);
	});

	it('does not split pipes inside strings', () => {
		const result = __kustoSplitPipelineStagesDeep("T | where x == 'a | b'");
		expect(result).toHaveLength(2);
	});

	it('does not split pipes inside comments', () => {
		const result = __kustoSplitPipelineStagesDeep('T | where x > 5 // | fake pipe');
		expect(result).toHaveLength(2);
	});

	it('handles empty input', () => {
		const result = __kustoSplitPipelineStagesDeep('');
		expect(result).toHaveLength(1);
		expect(result[0]).toBe('');
	});

	it('handles no pipes', () => {
		const result = __kustoSplitPipelineStagesDeep('Table');
		expect(result).toHaveLength(1);
	});

	it('handles let body with pipes at depth 1', () => {
		// Pipes inside { } should be split at the shallowest pipe depth
		const result = __kustoSplitPipelineStagesDeep('let f = () { T | where x > 5 | project a }');
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});

// ── __kustoFindLastTopLevelPipeBeforeOffset ────────────────────────────────────

describe('__kustoFindLastTopLevelPipeBeforeOffset', () => {
	it('finds last pipe before offset', () => {
		const text = 'T | where x > 5 | project a';
		const pipeIdx = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(pipeIdx).toBe(text.indexOf('| project'));
	});

	it('returns -1 when no pipe exists', () => {
		expect(__kustoFindLastTopLevelPipeBeforeOffset('Table', 5)).toBe(-1);
	});

	it('skips pipes inside parentheses', () => {
		const text = 'T | where f(a | b)';
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(result).toBe(text.indexOf('| where'));
	});

	it('skips pipes inside strings', () => {
		const text = "T | where x == 'a | b'";
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(result).toBe(text.indexOf('| where'));
	});

	it('respects offset boundary', () => {
		const text = 'T | where x > 5 | project a';
		// Search only within first 10 chars: "T | where "
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, 10);
		expect(result).toBe(2); // the first |
	});

	it('handles empty input', () => {
		expect(__kustoFindLastTopLevelPipeBeforeOffset('', 0)).toBe(-1);
	});
});

// ── __kustoGetStatementStartAtOffset ──────────────────────────────────────────

describe('__kustoGetStatementStartAtOffset', () => {
	it('finds start after semicolon', () => {
		const text = 'let a = 1; T | where x > 5';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		expect(result).toBe(10); // after the semicolon
	});

	it('returns 0 for single statement', () => {
		const text = 'T | where x > 5';
		expect(__kustoGetStatementStartAtOffset(text, text.length)).toBe(0);
	});

	it('finds start after blank line', () => {
		const text = 'Statement1\n\nStatement2';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		expect(result).toBeGreaterThan(0);
	});

	it('does not split on semicolons inside strings', () => {
		const text = "print 'a;b' | where x > 5";
		expect(__kustoGetStatementStartAtOffset(text, text.length)).toBe(0);
	});

	it('does not split on semicolons inside comments', () => {
		const text = 'T // comment;\n| where x > 5';
		expect(__kustoGetStatementStartAtOffset(text, text.length)).toBe(0);
	});

	it('handles empty input', () => {
		expect(__kustoGetStatementStartAtOffset('', 0)).toBe(0);
	});
});

// ── __kustoBuildLineStarts ────────────────────────────────────────────────────

describe('__kustoBuildLineStarts', () => {
	it('returns [0] for single line', () => {
		expect(__kustoBuildLineStarts('hello')).toEqual([0]);
	});

	it('returns correct starts for multi-line', () => {
		const starts = __kustoBuildLineStarts('abc\ndef\nghi');
		expect(starts).toEqual([0, 4, 8]);
	});

	it('handles empty string', () => {
		expect(__kustoBuildLineStarts('')).toEqual([0]);
	});

	it('handles trailing newline', () => {
		const starts = __kustoBuildLineStarts('abc\n');
		expect(starts).toEqual([0, 4]);
	});

	it('handles consecutive newlines', () => {
		const starts = __kustoBuildLineStarts('a\n\nb');
		expect(starts).toEqual([0, 2, 3]);
	});
});

// ── __kustoOffsetToPosition ───────────────────────────────────────────────────

describe('__kustoOffsetToPosition', () => {
	it('maps offset 0 to line 1 col 1', () => {
		const starts = __kustoBuildLineStarts('abc\ndef');
		expect(__kustoOffsetToPosition(starts, 0)).toEqual({ lineNumber: 1, column: 1 });
	});

	it('maps offset at second line start', () => {
		const starts = __kustoBuildLineStarts('abc\ndef');
		expect(__kustoOffsetToPosition(starts, 4)).toEqual({ lineNumber: 2, column: 1 });
	});

	it('maps offset mid-line', () => {
		const starts = __kustoBuildLineStarts('abc\ndef');
		expect(__kustoOffsetToPosition(starts, 5)).toEqual({ lineNumber: 2, column: 2 });
	});

	it('maps offset at end of line', () => {
		const starts = __kustoBuildLineStarts('abc\ndef');
		expect(__kustoOffsetToPosition(starts, 3)).toEqual({ lineNumber: 1, column: 4 });
	});

	it('handles negative offset', () => {
		const starts = __kustoBuildLineStarts('abc');
		const result = __kustoOffsetToPosition(starts, -1);
		expect(result.lineNumber).toBe(1);
		expect(result.column).toBe(1);
	});
});

// ── __kustoIsIdentStart / __kustoIsIdentPart ──────────────────────────────────

describe('__kustoIsIdentStart', () => {
	it('accepts uppercase letters', () => {
		expect(__kustoIsIdentStart(65)).toBe(true); // A
		expect(__kustoIsIdentStart(90)).toBe(true); // Z
	});

	it('accepts lowercase letters', () => {
		expect(__kustoIsIdentStart(97)).toBe(true); // a
		expect(__kustoIsIdentStart(122)).toBe(true); // z
	});

	it('accepts underscore', () => {
		expect(__kustoIsIdentStart(95)).toBe(true); // _
	});

	it('rejects digits', () => {
		expect(__kustoIsIdentStart(48)).toBe(false); // 0
		expect(__kustoIsIdentStart(57)).toBe(false); // 9
	});

	it('rejects special chars', () => {
		expect(__kustoIsIdentStart(45)).toBe(false); // -
		expect(__kustoIsIdentStart(32)).toBe(false); // space
	});
});

describe('__kustoIsIdentPart', () => {
	it('accepts letters and underscore', () => {
		expect(__kustoIsIdentPart(65)).toBe(true); // A
		expect(__kustoIsIdentPart(95)).toBe(true); // _
	});

	it('accepts digits', () => {
		expect(__kustoIsIdentPart(48)).toBe(true); // 0
		expect(__kustoIsIdentPart(57)).toBe(true); // 9
	});

	it('accepts hyphen', () => {
		expect(__kustoIsIdentPart(45)).toBe(true); // -
	});

	it('rejects special chars', () => {
		expect(__kustoIsIdentPart(32)).toBe(false); // space
		expect(__kustoIsIdentPart(46)).toBe(false); // .
		expect(__kustoIsIdentPart(40)).toBe(false); // (
	});
});

// ── __kustoScanIdentifiers ────────────────────────────────────────────────────

describe('__kustoScanIdentifiers', () => {
	it('scans simple identifiers', () => {
		const tokens = __kustoScanIdentifiers('Table | where x > 5');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents.map((t: any) => t.value)).toContain('Table');
		expect(idents.map((t: any) => t.value)).toContain('where');
		expect(idents.map((t: any) => t.value)).toContain('x');
	});

	it('detects pipe tokens', () => {
		const tokens = __kustoScanIdentifiers('T | where x > 5');
		const pipes = tokens.filter((t: any) => t.type === 'pipe');
		expect(pipes).toHaveLength(1);
		expect(pipes[0].value).toBe('|');
	});

	it('skips line comments', () => {
		const tokens = __kustoScanIdentifiers('T // comment\n| where x > 5');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		const names = idents.map((t: any) => t.value);
		expect(names).not.toContain('comment');
	});

	it('skips block comments', () => {
		const tokens = __kustoScanIdentifiers('T /* skip this */ | where x > 5');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		const names = idents.map((t: any) => t.value);
		expect(names).not.toContain('skip');
		expect(names).not.toContain('this');
	});

	it('skips single-quoted strings', () => {
		const tokens = __kustoScanIdentifiers("T | where x == 'hello'");
		const idents = tokens.filter((t: any) => t.type === 'ident');
		const names = idents.map((t: any) => t.value);
		expect(names).not.toContain('hello');
	});

	it('skips double-quoted strings', () => {
		const tokens = __kustoScanIdentifiers('T | where x == "hello"');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		const names = idents.map((t: any) => t.value);
		expect(names).not.toContain('hello');
	});

	it('tracks depth for brackets', () => {
		const tokens = __kustoScanIdentifiers('T | where f(a, b)');
		const innerA = tokens.find((t: any) => t.type === 'ident' && t.value === 'a');
		expect(innerA).toBeTruthy();
		expect(innerA.depth).toBe(1);
	});

	it('records correct offsets', () => {
		const text = 'Table | where';
		const tokens = __kustoScanIdentifiers(text);
		const tableToken = tokens.find((t: any) => t.value === 'Table');
		expect(tableToken.offset).toBe(0);
		expect(tableToken.endOffset).toBe(5);
		const whereToken = tokens.find((t: any) => t.value === 'where');
		expect(whereToken.offset).toBe(8);
		expect(whereToken.endOffset).toBe(13);
	});

	it('handles empty input', () => {
		expect(__kustoScanIdentifiers('')).toEqual([]);
	});

	it('handles hyphenated identifiers', () => {
		const tokens = __kustoScanIdentifiers('project-away col1');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents[0].value).toBe('project-away');
	});

	it('handles escaped quotes in strings (Kusto single-quote)', () => {
		const tokens = __kustoScanIdentifiers("T | where name == 'it''s'");
		const idents = tokens.filter((t: any) => t.type === 'ident');
		const names = idents.map((t: any) => t.value);
		expect(names).not.toContain('s');
		expect(names).toContain('name');
	});
});

// ── __kustoLevenshtein ────────────────────────────────────────────────────────

describe('__kustoLevenshtein', () => {
	it('returns 0 for identical strings', () => {
		expect(__kustoLevenshtein('abc', 'abc')).toBe(0);
	});

	it('returns length for empty vs non-empty', () => {
		expect(__kustoLevenshtein('', 'abc')).toBe(3);
		expect(__kustoLevenshtein('abc', '')).toBe(3);
	});

	it('returns 0 for both empty', () => {
		expect(__kustoLevenshtein('', '')).toBe(0);
	});

	it('computes single substitution', () => {
		expect(__kustoLevenshtein('cat', 'hat')).toBe(1);
	});

	it('computes single insertion', () => {
		expect(__kustoLevenshtein('ab', 'abc')).toBe(1);
	});

	it('computes single deletion', () => {
		expect(__kustoLevenshtein('abc', 'ab')).toBe(1);
	});

	it('handles null inputs', () => {
		expect(__kustoLevenshtein(null, 'abc')).toBe(3);
		expect(__kustoLevenshtein('abc', null)).toBe(3);
	});

	it('computes multi-character edit distances', () => {
		expect(__kustoLevenshtein('kitten', 'sitting')).toBe(3);
	});
});

// ── __kustoBestMatches ────────────────────────────────────────────────────────

describe('__kustoBestMatches', () => {
	it('returns closest matches', () => {
		const result = __kustoBestMatches('cnt', ['count', 'cnt', 'container'], 3);
		expect(result[0]).toBe('cnt'); // exact match has distance 0
	});

	it('prefers prefix matches', () => {
		const result = __kustoBestMatches('cou', ['count', 'abc', 'xyz'], 3);
		expect(result[0]).toBe('count');
	});

	it('limits results to maxCount', () => {
		const result = __kustoBestMatches('a', ['a', 'ab', 'abc', 'abcd', 'abcde', 'abcdef'], 3);
		expect(result).toHaveLength(3);
	});

	it('deduplicates case-insensitively', () => {
		const result = __kustoBestMatches('test', ['Test', 'TEST', 'test'], 5);
		expect(result).toHaveLength(1);
	});

	it('handles empty candidates', () => {
		expect(__kustoBestMatches('x', [], 5)).toEqual([]);
	});

	it('handles null needle', () => {
		const result = __kustoBestMatches(null, ['a', 'b'], 5);
		expect(result.length).toBeGreaterThanOrEqual(1);
	});
});

// ── __kustoParsePipeHeaderFromLine ────────────────────────────────────────────

describe('__kustoParsePipeHeaderFromLine', () => {
	it('parses where', () => {
		const result = __kustoParsePipeHeaderFromLine('| where x > 5');
		expect(result).toBeTruthy();
		expect(result.key).toBe('where');
	});

	it('maps filter to where', () => {
		const result = __kustoParsePipeHeaderFromLine('| filter x > 5');
		expect(result).toBeTruthy();
		expect(result.key).toBe('where');
	});

	it('maps parse-where to parse', () => {
		const result = __kustoParsePipeHeaderFromLine('| parse-where msg with "prefix" val');
		expect(result.key).toBe('parse');
	});

	it('parses order by', () => {
		const result = __kustoParsePipeHeaderFromLine('| order by timestamp desc');
		expect(result).toBeTruthy();
		expect(result.key).toBe('order by');
	});

	it('parses sort by', () => {
		const result = __kustoParsePipeHeaderFromLine('| sort by timestamp');
		expect(result.key).toBe('sort by');
	});

	it('returns null for non-pipe line', () => {
		expect(__kustoParsePipeHeaderFromLine('Table')).toBeNull();
	});

	it('returns null for empty pipe', () => {
		expect(__kustoParsePipeHeaderFromLine('|')).toBeNull();
	});

	it('returns null for pipe with only whitespace', () => {
		expect(__kustoParsePipeHeaderFromLine('|   ')).toBeNull();
	});

	it('handles leading whitespace', () => {
		const result = __kustoParsePipeHeaderFromLine('  | project a, b');
		expect(result).toBeTruthy();
		expect(result.key).toBe('project');
	});
});

// ── __kustoPipeHeaderAllowsIndentedContinuation ───────────────────────────────

describe('__kustoPipeHeaderAllowsIndentedContinuation', () => {
	it('allows where', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'where', rest: 'x > 5' })).toBe(true);
	});

	it('allows summarize', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'summarize', rest: '' })).toBe(true);
	});

	it('allows join', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'join', rest: '' })).toBe(true);
	});

	it('allows extend with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'extend', rest: '' })).toBe(true);
	});

	it('does not allow extend with rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'extend', rest: 'x = 1' })).toBe(false);
	});

	it('allows project with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project', rest: '' })).toBe(true);
	});

	it('does not allow project with rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project', rest: 'a, b' })).toBe(false);
	});

	it('allows order by with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'order by', rest: '' })).toBe(true);
	});

	it('does not allow order by with rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'order by', rest: 'col desc' })).toBe(false);
	});

	it('allows top ending with by', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'top', rest: '5 by' })).toBe(true);
	});

	it('does not allow top without by', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'top', rest: '5' })).toBe(false);
	});

	it('rejects unknown operator', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'render', rest: '' })).toBe(false);
	});

	it('returns false for null', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation(null)).toBe(false);
	});
});

// ── __kustoGetActivePipeStageInfoBeforeOffset ─────────────────────────────────

describe('__kustoGetActivePipeStageInfoBeforeOffset', () => {
	it('returns info for where clause', () => {
		const text = 'T | where x > 5';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result).toBeTruthy();
		expect(result.key).toBe('where');
		expect(result.headerHasArgs).toBe(true);
	});

	it('returns null for no pipe', () => {
		const result = __kustoGetActivePipeStageInfoBeforeOffset('Table', 5);
		expect(result).toBeNull();
	});

	it('maps filter to where', () => {
		const text = 'T | filter x == 1';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result.key).toBe('where');
	});

	it('detects headerHasArgs = false for bare operator', () => {
		const text = 'T | project';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result).toBeTruthy();
		expect(result.key).toBe('project');
		expect(result.headerHasArgs).toBe(false);
	});

	it('handles order by', () => {
		const text = 'T | order by timestamp desc';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result.key).toBe('order by');
		expect(result.headerHasArgs).toBe(true);
	});
});
