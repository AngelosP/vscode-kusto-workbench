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
	__kustoParseFullyQualifiedTableExpr,
	__kustoExtractSourceLower,
	__kustoSplitTopLevelCommaList,
	__kustoGetDotChainRoot,
	__kustoExtractJoinTable,
} from '../../src/webview/monaco/diagnostics.js';

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

// ── __kustoParseFullyQualifiedTableExpr ───────────────────────────────────────

describe('__kustoParseFullyQualifiedTableExpr', () => {
	it('parses cluster.database.table', () => {
		const result = __kustoParseFullyQualifiedTableExpr("cluster('mycluster.kusto.windows.net').database('MyDb').MyTable");
		expect(result).toEqual({
			cluster: 'mycluster.kusto.windows.net',
			database: 'MyDb',
			table: 'MyTable',
		});
	});

	it('ignores whitespace variations', () => {
		const result = __kustoParseFullyQualifiedTableExpr("cluster( 'a.com' ) . database( 'db1' ) . T1");
		expect(result).toEqual({ cluster: 'a.com', database: 'db1', table: 'T1' });
	});

	it('returns null for plain table name', () => {
		expect(__kustoParseFullyQualifiedTableExpr('MyTable')).toBeNull();
	});

	it('returns null for database-only qualifier', () => {
		expect(__kustoParseFullyQualifiedTableExpr("database('db').Table")).toBeNull();
	});

	it('returns null for empty input', () => {
		expect(__kustoParseFullyQualifiedTableExpr('')).toBeNull();
		expect(__kustoParseFullyQualifiedTableExpr(null)).toBeNull();
	});

	it('handles table name with hyphens and underscores', () => {
		const result = __kustoParseFullyQualifiedTableExpr("cluster('c').database('d').my_table-1");
		expect(result).toEqual({ cluster: 'c', database: 'd', table: 'my_table-1' });
	});

	it('case-insensitive keywords', () => {
		const result = __kustoParseFullyQualifiedTableExpr("CLUSTER('c').DATABASE('d').T");
		expect(result).toEqual({ cluster: 'c', database: 'd', table: 'T' });
	});
});

// ── __kustoExtractSourceLower ─────────────────────────────────────────────────

describe('__kustoExtractSourceLower', () => {
	it('extracts plain table name', () => {
		expect(__kustoExtractSourceLower('MyTable')).toBe('mytable');
	});

	it('extracts from cluster().database().table', () => {
		expect(__kustoExtractSourceLower("cluster('c').database('d').Table1")).toBe('table1');
	});

	it('extracts from database().table', () => {
		expect(__kustoExtractSourceLower("database('d').Table2")).toBe('table2');
	});

	it('strips leading parentheses', () => {
		expect(__kustoExtractSourceLower('(  MyTable | where x > 1)')).toBe('mytable');
	});

	it('returns null for empty input', () => {
		expect(__kustoExtractSourceLower('')).toBeNull();
		expect(__kustoExtractSourceLower(null)).toBeNull();
	});

	it('returns null for only whitespace', () => {
		expect(__kustoExtractSourceLower('   ')).toBeNull();
	});

	it('returns first identifier even with trailing operators', () => {
		expect(__kustoExtractSourceLower('SomeTable | where x > 1')).toBe('sometable');
	});
});

// ── __kustoSplitTopLevelCommaList ─────────────────────────────────────────────

describe('__kustoSplitTopLevelCommaList', () => {
	it('splits simple comma-separated values', () => {
		expect(__kustoSplitTopLevelCommaList('a, b, c')).toEqual(['a', 'b', 'c']);
	});

	it('does not split inside parentheses', () => {
		expect(__kustoSplitTopLevelCommaList('f(a, b), c')).toEqual(['f(a, b)', 'c']);
	});

	it('does not split inside brackets', () => {
		expect(__kustoSplitTopLevelCommaList('[a, b], c')).toEqual(['[a, b]', 'c']);
	});

	it('does not split inside braces', () => {
		expect(__kustoSplitTopLevelCommaList('{a, b}, c')).toEqual(['{a, b}', 'c']);
	});

	it('does not split inside double quotes', () => {
		expect(__kustoSplitTopLevelCommaList('"a, b", c')).toEqual(['"a, b"', 'c']);
	});

	it('does not split inside single quotes', () => {
		expect(__kustoSplitTopLevelCommaList("'a, b', c")).toEqual(["'a, b'", 'c']);
	});

	it('handles empty input', () => {
		expect(__kustoSplitTopLevelCommaList('')).toEqual([]);
		expect(__kustoSplitTopLevelCommaList(null)).toEqual([]);
	});

	it('handles single item (no commas)', () => {
		expect(__kustoSplitTopLevelCommaList('only_one')).toEqual(['only_one']);
	});

	it('handles nested parens and commas', () => {
		expect(__kustoSplitTopLevelCommaList('f(g(1, 2), 3), x')).toEqual(['f(g(1, 2), 3)', 'x']);
	});

	it('handles escaped quotes', () => {
		expect(__kustoSplitTopLevelCommaList('"a\\"b, c", d')).toEqual(['"a\\"b, c"', 'd']);
	});
});

// ── __kustoGetDotChainRoot ────────────────────────────────────────────────────

describe('__kustoGetDotChainRoot', () => {
	it('returns root for simple dot chain', () => {
		const s = 'col.sub';
		// identStart points to 'sub' at index 4
		expect(__kustoGetDotChainRoot(s, 4)).toBe('col');
	});

	it('returns deepest root for multi-level chain', () => {
		const s = 'root.mid.leaf';
		// identStart points to 'leaf' at index 9
		expect(__kustoGetDotChainRoot(s, 9)).toBe('root');
	});

	it('returns null when no preceding dot', () => {
		expect(__kustoGetDotChainRoot('hello', 0)).toBeNull();
		expect(__kustoGetDotChainRoot('hello world', 6)).toBeNull();
	});

	it('handles whitespace before dot', () => {
		const s = 'col .sub';
		// identStart points to 'sub' at index 5
		expect(__kustoGetDotChainRoot(s, 5)).toBe('col');
	});

	it('returns null for dot at start of string', () => {
		const s = '.sub';
		expect(__kustoGetDotChainRoot(s, 1)).toBeNull();
	});

	it('handles identifiers with hyphens', () => {
		const s = 'my-col.sub';
		expect(__kustoGetDotChainRoot(s, 7)).toBe('my-col');
	});
});

// ── __kustoExtractJoinTable ───────────────────────────────────────────────────

describe('__kustoExtractJoinTable', () => {
	it('extracts table from join(Table)', () => {
		expect(__kustoExtractJoinTable('join(MyTable)')).toBe('MyTable');
	});

	it('extracts from join kind=inner (Table)', () => {
		expect(__kustoExtractJoinTable('join kind=inner (OtherTable)')).toBe('OtherTable');
	});

	it('extracts from join with hint', () => {
		expect(__kustoExtractJoinTable('join hint.remote=auto (T2)')).toBe('T2');
	});

	it('extracts from lookup(Table)', () => {
		expect(__kustoExtractJoinTable('lookup(RefTable)')).toBe('RefTable');
	});

	it('extracts from join kind=leftouter hint.strategy=broadcast (T3)', () => {
		expect(__kustoExtractJoinTable('join kind=leftouter hint.strategy=broadcast (T3)')).toBe('T3');
	});

	it('returns null for empty input', () => {
		expect(__kustoExtractJoinTable('')).toBeNull();
		expect(__kustoExtractJoinTable(null)).toBeNull();
	});

	it('handles withsource option', () => {
		expect(__kustoExtractJoinTable('join withsource=Source (T4)')).toBe('T4');
	});

	it('handles table with hyphens/underscores', () => {
		expect(__kustoExtractJoinTable('join(my_table-1)')).toBe('my_table-1');
	});
});

// ── Additional edge cases for existing functions ──────────────────────────────

describe('__kustoSplitTopLevelStatements — additional edge cases', () => {
	it('handles double-quoted strings with escaped quotes', () => {
		const result = __kustoSplitTopLevelStatements('print "a\\"b"; T');
		expect(result).toHaveLength(2);
	});

	it('handles single-quoted strings with escaped quotes (Kusto \'\')', () => {
		const result = __kustoSplitTopLevelStatements("print 'it''s'; T");
		expect(result).toHaveLength(2);
	});

	it('handles CRLF line endings', () => {
		const result = __kustoSplitTopLevelStatements('T1\r\n\r\nT2');
		expect(result).toHaveLength(2);
	});

	it('handles mixed bracket types without splitting', () => {
		const result = __kustoSplitTopLevelStatements('T | where f({a; b}; [c; d])');
		expect(result).toHaveLength(1);
	});
});

describe('__kustoSplitPipelineStagesDeep — additional edge cases', () => {
	it('handles double-quoted strings with escape', () => {
		const result = __kustoSplitPipelineStagesDeep('T | where x == "a|b"');
		expect(result).toHaveLength(2);
	});

	it('handles block comments with pipes', () => {
		const result = __kustoSplitPipelineStagesDeep('T /* | fake */ | where x > 5');
		expect(result).toHaveLength(2);
	});

	it('multiple pipes at different depths — splits at shallowest', () => {
		// 2 top-level pipes, plus nested pipes inside parens
		const result = __kustoSplitPipelineStagesDeep('T | where (a | b) | project x');
		expect(result).toHaveLength(3);
	});
});

describe('__kustoScanIdentifiers — additional edge cases', () => {
	it('handles multiple bracket types for depth tracking', () => {
		const tokens = __kustoScanIdentifiers('f(a, [b], {c})');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents.find((t: any) => t.value === 'a')?.depth).toBe(1);
		expect(idents.find((t: any) => t.value === 'b')?.depth).toBe(2);
		expect(idents.find((t: any) => t.value === 'c')?.depth).toBe(2);
	});

	it('handles escaped double quotes in strings', () => {
		const tokens = __kustoScanIdentifiers('T | where x == "say \\"hi\\""');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents.map((t: any) => t.value)).not.toContain('say');
		expect(idents.map((t: any) => t.value)).not.toContain('hi');
	});

	it('returns empty for whitespace only input', () => {
		expect(__kustoScanIdentifiers('   \n\t  ')).toEqual([]);
	});

	it('handles consecutive pipes', () => {
		const tokens = __kustoScanIdentifiers('||');
		const pipes = tokens.filter((t: any) => t.type === 'pipe');
		expect(pipes).toHaveLength(2);
	});
});

describe('__kustoLevenshtein — additional edge cases', () => {
	it('handles single-character strings', () => {
		expect(__kustoLevenshtein('a', 'b')).toBe(1);
		expect(__kustoLevenshtein('a', 'a')).toBe(0);
	});

	it('completely different strings', () => {
		expect(__kustoLevenshtein('abc', 'xyz')).toBe(3);
	});
});

describe('__kustoBestMatches — additional edge cases', () => {
	it('returns empty array when needle is empty and no candidates', () => {
		expect(__kustoBestMatches('', [], 5)).toEqual([]);
	});

	it('sorts by edit distance with prefix boost', () => {
		const result = __kustoBestMatches('coun', ['counter', 'count', 'county'], 3);
		// 'count' should be first (prefix match with short length)
		expect(result[0]).toBe('count');
	});

	it('uses default maxCount when not given', () => {
		const candidates = Array.from({ length: 20 }, (_, i) => 'item' + i);
		const result = __kustoBestMatches('item', candidates, undefined);
		expect(result.length).toBeLessThanOrEqual(5);
	});
});

describe('__kustoParsePipeHeaderFromLine — additional edge cases', () => {
	it('handles null input', () => {
		expect(__kustoParsePipeHeaderFromLine(null)).toBeNull();
	});

	it('parses distinct operator', () => {
		const result = __kustoParsePipeHeaderFromLine('| distinct col1, col2');
		expect(result?.key).toBe('distinct');
	});

	it('parses extend operator', () => {
		const result = __kustoParsePipeHeaderFromLine('| extend x = 1');
		expect(result?.key).toBe('extend');
	});

	it('parses project-away', () => {
		const result = __kustoParsePipeHeaderFromLine('| project-away col1');
		expect(result?.key).toBe('project-away');
	});
});

describe('__kustoPipeHeaderAllowsIndentedContinuation — additional edge cases', () => {
	it('allows lookup', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'lookup', rest: '' })).toBe(true);
	});

	it('allows distinct with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'distinct', rest: '' })).toBe(true);
	});

	it('does not allow distinct with rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'distinct', rest: 'col1' })).toBe(false);
	});

	it('allows project-away/project-keep/project-rename with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-away', rest: '' })).toBe(true);
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-keep', rest: '' })).toBe(true);
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-rename', rest: '' })).toBe(true);
	});

	it('does not allow project-away with rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-away', rest: 'col1' })).toBe(false);
	});

	it('allows sort by with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'sort by', rest: '' })).toBe(true);
	});

	it('allows project-reorder and project-smart with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-reorder', rest: '' })).toBe(true);
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-smart', rest: '' })).toBe(true);
	});

	it('returns false for empty/missing key', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: '', rest: '' })).toBe(false);
	});
});

describe('__kustoGetActivePipeStageInfoBeforeOffset — additional edge cases', () => {
	it('handles sort by', () => {
		const text = 'T | sort by col desc';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result?.key).toBe('sort by');
	});

	it('maps parse-where to parse', () => {
		const text = 'T | parse-where msg with "prefix" val';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result?.key).toBe('parse');
	});

	it('returns null for empty pipe', () => {
		const text = 'T |';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result).toBeNull();
	});

	it('returns pipeIdx in the result', () => {
		const text = 'T | where x > 5';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result?.pipeIdx).toBe(2);
	});
});

describe('__kustoMaskCommentsPreserveLayout — additional edge cases', () => {
	it('handles adjacent comments', () => {
		const input = '// line1\n// line2\n';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toHaveLength(input.length);
		expect(result.split('\n')).toHaveLength(3);
	});

	it('handles block comment immediately followed by content', () => {
		const input = '/*c*/T';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toContain('T');
		expect(result).toHaveLength(input.length);
	});

	it('handles nested-looking block comment (not truly nested)', () => {
		const input = '/* a /* b */ c';
		const result = __kustoMaskCommentsPreserveLayout(input);
		// Block comment ends at first */, so ' c' is outside
		expect(result.endsWith(' c')).toBe(true);
	});
});

describe('__kustoOffsetToPosition — additional edge cases', () => {
	it('handles offset beyond end of text', () => {
		const starts = __kustoBuildLineStarts('abc');
		const result = __kustoOffsetToPosition(starts, 100);
		expect(result.lineNumber).toBe(1);
		expect(result.column).toBeGreaterThan(1);
	});

	it('handles single empty line', () => {
		const starts = __kustoBuildLineStarts('');
		const result = __kustoOffsetToPosition(starts, 0);
		expect(result).toEqual({ lineNumber: 1, column: 1 });
	});

	it('handles multi-line boundary positions', () => {
		const starts = __kustoBuildLineStarts('ab\ncd\nef');
		// Offset pointing to 'c' on line 2
		expect(__kustoOffsetToPosition(starts, 3)).toEqual({ lineNumber: 2, column: 1 });
		// Offset pointing to 'e' on line 3
		expect(__kustoOffsetToPosition(starts, 6)).toEqual({ lineNumber: 3, column: 1 });
	});
});

describe('__kustoGetStatementStartAtOffset — additional edge cases', () => {
	it('handles multiple semicolons', () => {
		const text = 'A; B; C';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		// Should point after the last semicolon
		expect(result).toBe(5);
	});

	it('handles blank lines with tabs and spaces', () => {
		const text = 'Statement1\n \t \nStatement2';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		expect(result).toBeGreaterThan(0);
	});

	it('does not split on semicolons inside block comments', () => {
		const text = 'T /* a; b */ | where x > 5';
		expect(__kustoGetStatementStartAtOffset(text, text.length)).toBe(0);
	});

	it('does not split on semicolons inside double-quoted strings', () => {
		const text = 'print "a;b" | where x > 5';
		expect(__kustoGetStatementStartAtOffset(text, text.length)).toBe(0);
	});

	it('handles brackets correctly (does not split inside)', () => {
		const text = 'T | where f(a; b)';
		expect(__kustoGetStatementStartAtOffset(text, text.length)).toBe(0);
	});
});

// ── More deep path edge cases for coverage ────────────────────────────────────

describe('__kustoSplitTopLevelStatements — deep edge cases', () => {
	it('handles carriage return only', () => {
		const result = __kustoSplitTopLevelStatements('T1\r\rT2');
		expect(result).toHaveLength(2);
	});

	it('does not split on single newline', () => {
		const result = __kustoSplitTopLevelStatements('T | where x > 5\n| project a');
		expect(result).toHaveLength(1);
	});

	it('handles line comments across blank line separator', () => {
		const result = __kustoSplitTopLevelStatements('T1 // comment\n| project a\n\nT2');
		expect(result).toHaveLength(2);
	});

	it('handles closing brackets decreasing depth', () => {
		const result = __kustoSplitTopLevelStatements('f(a); g(b)');
		expect(result).toHaveLength(2);
	});

	it('handles triple backtick strings spanning semicolons', () => {
		const result = __kustoSplitTopLevelStatements('print ```hello;world```');
		expect(result).toHaveLength(1);
	});

	it('handles multiple blank lines between statements', () => {
		const result = __kustoSplitTopLevelStatements('T1\n\n\n\n\nT2');
		expect(result).toHaveLength(2);
		expect(result[0].text).toContain('T1');
		expect(result[1].text).toContain('T2');
	});
});

describe('__kustoSplitPipelineStagesDeep — deep edge cases', () => {
	it('handles nested brackets at multiple depths', () => {
		const result = __kustoSplitPipelineStagesDeep('T | where f(g(a | b)) | project x');
		expect(result).toHaveLength(3);
	});

	it('handles single-quoted string with pipe inside', () => {
		const result = __kustoSplitPipelineStagesDeep("T | where x == 'a|b'");
		expect(result).toHaveLength(2);
	});

	it('handles text without any pipes', () => {
		const result = __kustoSplitPipelineStagesDeep('Table');
		expect(result).toHaveLength(1);
		expect(result[0]).toBe('Table');
	});

	it('handles line comments with pipes', () => {
		const result = __kustoSplitPipelineStagesDeep('T // | fake\n| where x > 5');
		expect(result).toHaveLength(2);
	});
});

describe('__kustoScanIdentifiers — deep edge cases', () => {
	it('handles block comment with no closing', () => {
		// Unclosed block comment — should still parse without error
		const tokens = __kustoScanIdentifiers('T /* unclosed');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents.map((t: any) => t.value)).toContain('T');
		// Content inside unclosed comment should be skipped
		expect(idents.map((t: any) => t.value)).not.toContain('unclosed');
	});

	it('handles multiple pipes and identifiers in complex query', () => {
		const tokens = __kustoScanIdentifiers('T | where x > 5 | summarize count() by col | project col, count_');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		const pipes = tokens.filter((t: any) => t.type === 'pipe');
		expect(pipes).toHaveLength(3);
		expect(idents.map((t: any) => t.value)).toContain('T');
		expect(idents.map((t: any) => t.value)).toContain('where');
		expect(idents.map((t: any) => t.value)).toContain('summarize');
		expect(idents.map((t: any) => t.value)).toContain('count');
		expect(idents.map((t: any) => t.value)).toContain('project');
	});

	it('handles unclosed single-quoted string', () => {
		const tokens = __kustoScanIdentifiers("T | where x == 'unclosed");
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents.map((t: any) => t.value)).toContain('T');
	});

	it('handles unclosed double-quoted string', () => {
		const tokens = __kustoScanIdentifiers('T | where x == "unclosed');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents.map((t: any) => t.value)).toContain('T');
	});
});

describe('__kustoMaskCommentsPreserveLayout — deep edge cases', () => {
	it('handles unclosed block comment', () => {
		const input = 'Table /* unclosed block';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toHaveLength(input.length);
		expect(result).toContain('Table');
	});

	it('handles unclosed single-quoted string', () => {
		const input = "Table 'unclosed string";
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toHaveLength(input.length);
	});

	it('handles unclosed double-quoted string', () => {
		const input = 'Table "unclosed string';
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toHaveLength(input.length);
	});

	it('handles alternating string types', () => {
		const input = "T | where a == 'x' and b == \"y\"";
		const result = __kustoMaskCommentsPreserveLayout(input);
		expect(result).toContain('T');
		expect(result).toContain("'x'");
		expect(result).toContain('"y"');
	});
});

describe('__kustoBestMatches — more edge cases', () => {
	it('handles maxCount of 1', () => {
		const result = __kustoBestMatches('x', ['xa', 'xb', 'xc'], 1);
		expect(result).toHaveLength(1);
	});

	it('produces stable order for equal distances', () => {
		const result = __kustoBestMatches('x', ['b', 'a', 'c'], 3);
		// Equal distance — sorted alphabetically
		expect(result).toEqual(['a', 'b', 'c']);
	});
});

describe('__kustoParseFullyQualifiedTableExpr — more edge cases', () => {
	it('handles whitespace in quotes', () => {
		const result = __kustoParseFullyQualifiedTableExpr("cluster('my cluster').database('my db').T");
		expect(result).toEqual({ cluster: 'my cluster', database: 'my db', table: 'T' });
	});

	it('does not match partial patterns', () => {
		expect(__kustoParseFullyQualifiedTableExpr("cluster('c').T")).toBeNull();
		expect(__kustoParseFullyQualifiedTableExpr("database('d').T")).toBeNull();
	});
});

describe('__kustoExtractSourceLower — more edge cases', () => {
	it('handles function call RHS (returns the function name)', () => {
		expect(__kustoExtractSourceLower('range(1, 10, 1)')).toBe('range');
	});

	it('handles parenthesized expression', () => {
		expect(__kustoExtractSourceLower('( T | where x > 5 )')).toBe('t');
	});
});

describe('__kustoSplitTopLevelCommaList — more edge cases', () => {
	it('handles whitespace-only items', () => {
		const result = __kustoSplitTopLevelCommaList('a,   , b');
		expect(result).toEqual(['a', 'b']);
	});

	it('handles complex nested structures', () => {
		const result = __kustoSplitTopLevelCommaList('f(a, b), g({c: [1, 2]})');
		expect(result).toEqual(['f(a, b)', 'g({c: [1, 2]})']);
	});
});

describe('__kustoExtractJoinTable — more edge cases', () => {
	it('handles join without parens (extracts from stripped text)', () => {
		// Without parens, the function strips join/lookup and options, then matches first identifier
		const result = __kustoExtractJoinTable('join TableName');
		expect(result).toBe('TableName');
	});

	it('handles join with whitespace in parens', () => {
		expect(__kustoExtractJoinTable('join (  MyTable  )')).toBe('MyTable');
	});

	it('handles join with complex options', () => {
		expect(__kustoExtractJoinTable('join kind=inner hint.remote=auto hint.strategy=broadcast (BigTable)')).toBe('BigTable');
	});
});

describe('__kustoFindLastTopLevelPipeBeforeOffset — more edge cases', () => {
	it('handles multiple pipes and returns last before offset', () => {
		const text = 'T | a | b | c';
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, 9);
		// Before '| c', should be at the '| b' position
		expect(result).toBe(6);
	});

	it('handles pipes inside block comments', () => {
		const text = 'T /* | */ | where x > 5';
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(result).toBeGreaterThan(5);
	});
});

// ── Additional branch-coverage edge cases ─────────────────────────────────────

describe('__kustoSplitPipelineStagesDeep — double quotes & comments', () => {
	it('does not split pipes inside double-quoted strings', () => {
		const result = __kustoSplitPipelineStagesDeep('T | where x == "a | b"');
		expect(result).toHaveLength(2);
	});

	it('handles backslash escapes inside double-quoted strings', () => {
		const result = __kustoSplitPipelineStagesDeep('T | where x == "a\\"b | c"');
		expect(result).toHaveLength(2);
	});

	it('handles block comment containing pipe', () => {
		const result = __kustoSplitPipelineStagesDeep('T /* | fake */ | where x > 5');
		expect(result).toHaveLength(2);
	});

	it('handles closing brackets decreasing depth', () => {
		const result = __kustoSplitPipelineStagesDeep('T | where f([a | b]) | project x');
		expect(result).toHaveLength(3);
	});

	it('handles Kusto single-quote escaping inside pipeline', () => {
		const result = __kustoSplitPipelineStagesDeep("T | where x == 'it''s fine' | project a");
		expect(result).toHaveLength(3);
	});

	it('handles let body at depth 1 with multiple pipes', () => {
		const result = __kustoSplitPipelineStagesDeep('let f = () { T | where x > 5 | project a }; f');
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});

describe('__kustoSplitTopLevelStatements — string escape coverage', () => {
	it('handles backslash-escaped double quote character', () => {
		const result = __kustoSplitTopLevelStatements('print "a\\"b"; T');
		expect(result).toHaveLength(2);
	});

	it('handles triple backtick spanning multiple lines', () => {
		const result = __kustoSplitTopLevelStatements('print ```\nhello;\nworld\n```; T');
		expect(result).toHaveLength(2);
	});

	it('handles mixed string types in one statement', () => {
		const result = __kustoSplitTopLevelStatements("print 'a', \"b\"; T");
		expect(result).toHaveLength(2);
	});

	it('handles blank line inside block comment (no split)', () => {
		const result = __kustoSplitTopLevelStatements('T /* first\n\nsecond */ | where x > 0');
		expect(result).toHaveLength(1);
	});
});

describe('__kustoGetStatementStartAtOffset — more branch coverage', () => {
	it('handles triple semicolons', () => {
		const text = 'A; B; C';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		expect(result).toBeGreaterThan(0);
	});

	it('handles double-quoted strings with backslash escapes', () => {
		const text = 'print "a\\"b"; T';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		// Should split after the semicolon outside the string
		expect(result).toBeGreaterThan(0);
	});

	it('handles single-quote escaping (Kusto style)', () => {
		const text = "print 'it''s'; T | where x > 5";
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		expect(result).toBeGreaterThan(0);
	});

	it('handles NaN offset', () => {
		const text = 'T | where x > 5';
		expect(__kustoGetStatementStartAtOffset(text, NaN)).toBe(0);
	});

	it('handles blank line with \\r\\n', () => {
		const text = 'Statement1\r\n\r\nStatement2';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		expect(result).toBeGreaterThan(0);
	});

	it('handles whitespace-only line between statements', () => {
		const text = 'T1\n   \nT2';
		const result = __kustoGetStatementStartAtOffset(text, text.length);
		expect(result).toBeGreaterThan(0);
	});
});

describe('__kustoScanIdentifiers — string and depth edge cases', () => {
	it('handles double-quoted string with backslash escape', () => {
		const tokens = __kustoScanIdentifiers('T | where x == "a\\"b"');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		const names = idents.map((t: any) => t.value);
		expect(names).not.toContain('a');
		expect(names).not.toContain('b');
		expect(names).toContain('T');
		expect(names).toContain('x');
	});

	it('tracks bracket depth correctly', () => {
		const tokens = __kustoScanIdentifiers('T | where f([a, b])');
		const a = tokens.find((t: any) => t.type === 'ident' && t.value === 'a');
		const b = tokens.find((t: any) => t.type === 'ident' && t.value === 'b');
		expect(a).toBeTruthy();
		expect(a.depth).toBe(2); // inside () and []
		expect(b).toBeTruthy();
		expect(b.depth).toBe(2);
	});

	it('handles brace depth', () => {
		const tokens = __kustoScanIdentifiers('T | where {a, b}');
		const a = tokens.find((t: any) => t.type === 'ident' && t.value === 'a');
		expect(a).toBeTruthy();
		expect(a.depth).toBe(1);
	});

	it('handles closing bracket past zero depth (clamped)', () => {
		const tokens = __kustoScanIdentifiers(') T');
		const t = tokens.find((t: any) => t.type === 'ident' && t.value === 'T');
		expect(t).toBeTruthy();
		expect(t.depth).toBe(0);
	});

	it('handles tab and carriage return whitespace', () => {
		const tokens = __kustoScanIdentifiers('T\t|\r\nwhere x > 5');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents.map((t: any) => t.value)).toContain('T');
		expect(idents.map((t: any) => t.value)).toContain('where');
	});

	it('handles standalone numeric-like chars (no identifier)', () => {
		const tokens = __kustoScanIdentifiers('1 + 2');
		const idents = tokens.filter((t: any) => t.type === 'ident');
		expect(idents).toHaveLength(0);
	});
});

describe('__kustoFindLastTopLevelPipeBeforeOffset — string & escape edges', () => {
	it('handles single-quote escaped string containing pipe', () => {
		const text = "T | where x == 'a|b' | project y";
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(result).toBe(text.indexOf('| project'));
	});

	it('handles double-quoted string with backslash escape', () => {
		const text = 'T | where x == "a\\"b | c" | project y';
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(result).toBe(text.indexOf('| project'));
	});

	it('handles bracket depth with pipe inside', () => {
		const text = 'T | where (a | b) | project y';
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(result).toBe(text.indexOf('| project'));
	});

	it('handles line comment containing pipe', () => {
		const text = 'T // | fake\n| where x > 5';
		const result = __kustoFindLastTopLevelPipeBeforeOffset(text, text.length);
		expect(result).toBe(text.indexOf('| where'));
	});
});

describe('__kustoLevenshtein — both null', () => {
	it('returns 0 when both are null', () => {
		expect(__kustoLevenshtein(null, null)).toBe(0);
	});

	it('returns 0 when both are undefined', () => {
		expect(__kustoLevenshtein(undefined, undefined)).toBe(0);
	});
});

describe('__kustoGetDotChainRoot — deep edge cases', () => {
	it('returns null when dot preceded by non-identifier', () => {
		const s = '1.sub';
		// identStart=2, preceding dot at 1, char at 0 is '1' not an ident start
		expect(__kustoGetDotChainRoot(s, 2)).toBeNull();
	});

	it('handles three-level chain', () => {
		const s = 'a.b.c';
		expect(__kustoGetDotChainRoot(s, 4)).toBe('a');
	});
});

describe('__kustoExtractJoinTable — lookup and edge cases', () => {
	it('extracts table from lookup(Table)', () => {
		expect(__kustoExtractJoinTable('lookup(MyTable)')).toBe('MyTable');
	});

	it('extracts from join with all hint types', () => {
		expect(__kustoExtractJoinTable('join kind=inner hint.remote=auto hint.strategy=broadcast (BigTable)')).toBe('BigTable');
	});

	it('returns null for empty input', () => {
		expect(__kustoExtractJoinTable('')).toBeNull();
	});

	it('returns null for null input', () => {
		expect(__kustoExtractJoinTable(null)).toBeNull();
	});

	it('handles join without parens — strips join keyword', () => {
		expect(__kustoExtractJoinTable('join T1')).toBe('T1');
	});

	it('handles lookup without parens', () => {
		expect(__kustoExtractJoinTable('lookup T2')).toBe('T2');
	});
});

describe('__kustoPipeHeaderAllowsIndentedContinuation — more operators', () => {
	it('allows project-away with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-away', rest: '' })).toBe(true);
	});

	it('does not allow project-away with content', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-away', rest: 'col1' })).toBe(false);
	});

	it('allows project-keep with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'project-keep', rest: '' })).toBe(true);
	});

	it('allows distinct with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'distinct', rest: '' })).toBe(true);
	});

	it('does not allow distinct with content', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'distinct', rest: 'col1' })).toBe(false);
	});

	it('allows lookup (always multiline)', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'lookup', rest: '' })).toBe(true);
	});

	it('allows sort by with empty rest', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'sort by', rest: '' })).toBe(true);
	});

	it('does not allow sort by with content', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'sort by', rest: 'col1 desc' })).toBe(false);
	});

	it('allows top ending with trailing-by and spaces', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'top', rest: '10 by   ' })).toBe(true);
	});

	it('does not allow take', () => {
		expect(__kustoPipeHeaderAllowsIndentedContinuation({ key: 'take', rest: '' })).toBe(false);
	});
});

describe('__kustoGetActivePipeStageInfoBeforeOffset — sort by & edge cases', () => {
	it('handles sort by', () => {
		const text = 'T | sort by col asc';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result).toBeTruthy();
		expect(result.key).toBe('sort by');
	});

	it('returns null for empty string', () => {
		expect(__kustoGetActivePipeStageInfoBeforeOffset('', 0)).toBeNull();
	});

	it('returns null for pipe followed by only whitespace', () => {
		const text = 'T | ';
		const result = __kustoGetActivePipeStageInfoBeforeOffset(text, text.length);
		expect(result).toBeNull();
	});
});

describe('__kustoSplitTopLevelCommaList — escape edge cases', () => {
	it('handles backslash-escaped single quotes in single-quoted strings', () => {
		// This tests the backslash escape path (ch === '\\') in quote mode
		const result = __kustoSplitTopLevelCommaList("'a\\'b, c', d");
		// The escaped quote may or may not close the string (depends on impl),
		// but the function should not crash
		expect(result.length).toBeGreaterThanOrEqual(1);
	});

	it('handles multiple levels of nesting', () => {
		const result = __kustoSplitTopLevelCommaList('f(g([{a, b}]), c), d');
		expect(result).toEqual(['f(g([{a, b}]), c)', 'd']);
	});
});
