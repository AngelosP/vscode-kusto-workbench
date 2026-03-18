import { describe, it, expect } from 'vitest';
import {
	__kustoToSingleLineKusto,
	__kustoExplodePipesToLines,
	__kustoSplitTopLevel,
	__kustoFindTopLevelKeyword,
	__kustoPrettifyWhereClause,
	__kustoPrettifyKusto,
	__kustoSplitKustoStatementsBySemicolon,
	__kustoPrettifyKustoTextWithSemicolonStatements,
} from '../../src/webview/modules/monaco-prettify.js';

// ── __kustoToSingleLineKusto ──────────────────────────────────────────────────

describe('__kustoToSingleLineKusto', () => {
	it('collapses multiline query to one line', () => {
		const input = 'Table\n| where x > 5\n| project a, b';
		expect(__kustoToSingleLineKusto(input)).toBe('Table | where x > 5 | project a, b');
	});

	it('preserves content inside single quotes', () => {
		const input = "print 'hello   world'";
		// Note: the final .replace(/\s+/g, ' ') collapses all whitespace including inside strings
		expect(__kustoToSingleLineKusto(input)).toBe("print 'hello world'");
	});

	it('preserves content inside double quotes', () => {
		const input = 'print "hello   world"';
		expect(__kustoToSingleLineKusto(input)).toBe('print "hello world"');
	});

	it('converts line comments to block comments', () => {
		const input = 'Table\n// this is a comment\n| where x > 5';
		const result = __kustoToSingleLineKusto(input);
		expect(result).toContain('/* this is a comment */');
		expect(result).not.toContain('//');
	});

	it('preserves block comments', () => {
		const input = 'Table /* block */ | where x > 5';
		expect(__kustoToSingleLineKusto(input)).toContain('/* block */');
	});

	it('handles empty input', () => {
		expect(__kustoToSingleLineKusto('')).toBe('');
		expect(__kustoToSingleLineKusto(null)).toBe('');
	});

	it('collapses multiple spaces', () => {
		const input = 'Table    |   where    x > 5';
		expect(__kustoToSingleLineKusto(input)).toBe('Table | where x > 5');
	});

	it('drops empty line comments', () => {
		const input = 'Table\n//\n| where x > 5';
		const result = __kustoToSingleLineKusto(input);
		expect(result).not.toContain('/*');
		expect(result).toContain('Table');
	});
});

// ── __kustoExplodePipesToLines ────────────────────────────────────────────────

describe('__kustoExplodePipesToLines', () => {
	it('puts pipes on new lines', () => {
		const input = 'Table | where x > 5 | project a';
		const result = __kustoExplodePipesToLines(input);
		const lines = result.split('\n');
		expect(lines.length).toBeGreaterThanOrEqual(3);
	});

	it('does not split pipes inside parentheses', () => {
		const input = 'Table | where f(a | b)';
		const result = __kustoExplodePipesToLines(input);
		expect(result).toContain('f(a | b)');
	});

	it('does not split pipes inside strings', () => {
		const input = "Table | where x == 'a | b'";
		const result = __kustoExplodePipesToLines(input);
		expect(result).toContain("'a | b'");
	});

	it('handles empty input', () => {
		expect(__kustoExplodePipesToLines('')).toBe('');
		expect(__kustoExplodePipesToLines(null)).toBe('');
	});
});

// ── __kustoSplitTopLevel ──────────────────────────────────────────────────────

describe('__kustoSplitTopLevel', () => {
	it('splits by comma at top level', () => {
		expect(__kustoSplitTopLevel('a, b, c', ',')).toEqual(['a', ' b', ' c']);
	});

	it('does not split inside parentheses', () => {
		expect(__kustoSplitTopLevel('f(a, b), c', ',')).toEqual(['f(a, b)', ' c']);
	});

	it('does not split inside brackets', () => {
		expect(__kustoSplitTopLevel('a, [b, c], d', ',')).toEqual(['a', ' [b, c]', ' d']);
	});

	it('does not split inside braces', () => {
		expect(__kustoSplitTopLevel('a, {b, c}, d', ',')).toEqual(['a', ' {b, c}', ' d']);
	});

	it('does not split inside strings', () => {
		expect(__kustoSplitTopLevel("'a, b', c", ',')).toEqual(["'a, b'", ' c']);
		expect(__kustoSplitTopLevel('"a, b", c', ',')).toEqual(['"a, b"', ' c']);
	});

	it('handles no delimiter', () => {
		expect(__kustoSplitTopLevel('abc', ',')).toEqual(['abc']);
	});
});

// ── __kustoFindTopLevelKeyword ────────────────────────────────────────────────

describe('__kustoFindTopLevelKeyword', () => {
	it('finds keyword at top level', () => {
		expect(__kustoFindTopLevelKeyword('count by timestamp', 'by')).toBe(6);
	});

	it('does not find keyword inside parentheses', () => {
		expect(__kustoFindTopLevelKeyword('f(x by y) by z', 'by')).toBe(10);
	});

	it('does not match partial words', () => {
		expect(__kustoFindTopLevelKeyword('bypass the test', 'by')).toBe(-1);
	});

	it('is case-insensitive', () => {
		expect(__kustoFindTopLevelKeyword('count BY timestamp', 'by')).toBe(6);
	});

	it('returns -1 for empty keyword', () => {
		expect(__kustoFindTopLevelKeyword('anything', '')).toBe(-1);
	});

	it('returns -1 when keyword not found', () => {
		expect(__kustoFindTopLevelKeyword('no match here', 'by')).toBe(-1);
	});
});

// ── __kustoPrettifyWhereClause ────────────────────────────────────────────────

describe('__kustoPrettifyWhereClause', () => {
	it('splits simple and conditions', () => {
		const items = __kustoPrettifyWhereClause('a > 5 and b < 10');
		const conds = items.filter((i: any) => i.type === 'cond');
		expect(conds).toHaveLength(2);
		expect(conds[0].text).toBe('a > 5');
		expect(conds[1].text).toBe('b < 10');
		expect(conds[1].op).toBe('and');
	});

	it('splits or conditions', () => {
		const items = __kustoPrettifyWhereClause('x == 1 or y == 2');
		const conds = items.filter((i: any) => i.type === 'cond');
		expect(conds).toHaveLength(2);
		expect(conds[1].op).toBe('or');
	});

	it('preserves conditions inside parentheses', () => {
		const items = __kustoPrettifyWhereClause('(a and b) and c');
		const conds = items.filter((i: any) => i.type === 'cond');
		expect(conds).toHaveLength(2);
		expect(conds[0].text).toBe('(a and b)');
		expect(conds[1].text).toBe('c');
	});

	it('handles inline comments', () => {
		const items = __kustoPrettifyWhereClause('a > 5 // inline comment\nand b < 10');
		const conds = items.filter((i: any) => i.type === 'cond');
		expect(conds[0].text).toContain('inline comment');
	});

	it('handles full-line comments', () => {
		const items = __kustoPrettifyWhereClause('// full line comment\na > 5');
		const comments = items.filter((i: any) => i.type === 'comment');
		expect(comments).toHaveLength(1);
	});

	it('handles single condition', () => {
		const items = __kustoPrettifyWhereClause('x > 5');
		const conds = items.filter((i: any) => i.type === 'cond');
		expect(conds).toHaveLength(1);
		expect(conds[0].text).toBe('x > 5');
	});
});

// ── __kustoPrettifyKusto ──────────────────────────────────────────────────────

describe('__kustoPrettifyKusto', () => {
	it('formats a simple query', () => {
		const input = 'Table | where x > 5 | project a, b';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('Table');
		expect(result).toContain('| where');
		expect(result).toContain('| project');
	});

	it('formats summarize clause with by', () => {
		const input = 'T | summarize count(), avg(x) by bin(timestamp, 1h), category';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| summarize');
		expect(result).toContain('by');
		expect(result).toContain('count()');
	});

	it('formats where clause with multiple conditions', () => {
		const input = 'T | where a > 5 and b < 10 and c == "test"';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| where');
		expect(result).toContain('and');
	});

	it('formats extend clause', () => {
		const input = 'T | extend a = x + 1, b = y * 2, c = z - 3';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| extend');
	});

	it('formats project clause with multiple columns', () => {
		const input = 'T | project col1, col2, col3';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| project');
	});

	it('handles empty input', () => {
		expect(__kustoPrettifyKusto('')).toBe('');
		expect(__kustoPrettifyKusto(null)).toBe('');
	});

	it('preserves strings during formatting', () => {
		const input = "T | where name == 'hello | world'";
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain("'hello | world'");
	});

	it('indents pipe clauses under table name', () => {
		const input = 'Table\n| where x > 5\n| project a';
		const result = __kustoPrettifyKusto(input);
		const lines = result.split('\n');
		const tableLine = lines.find(l => l.trim() === 'Table');
		const whereLine = lines.find(l => l.trim().startsWith('| where'));
		expect(tableLine).toBeTruthy();
		expect(whereLine).toBeTruthy();
		// where line should be indented
		expect(whereLine!.startsWith('    ')).toBe(true);
	});

	it('handles single-line query with no pipes', () => {
		expect(__kustoPrettifyKusto('print 42')).toBe('print 42');
	});

	it('trims trailing whitespace and blank lines', () => {
		const input = '\n\nTable | where x > 5\n\n';
		const result = __kustoPrettifyKusto(input);
		expect(result).not.toMatch(/^\s*\n/);
		expect(result).not.toMatch(/\n\s*$/);
	});
});

// ── __kustoSplitKustoStatementsBySemicolon ────────────────────────────────────

describe('__kustoSplitKustoStatementsBySemicolon', () => {
	it('splits two statements', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('let x = 1; T | where y > x');
		expect(result).toHaveLength(2);
		expect(result[0].hasSemicolonAfter).toBe(true);
		expect(result[1].hasSemicolonAfter).toBe(false);
		expect(result[0].statement).toBe('let x = 1');
		expect(result[1].statement).toBe(' T | where y > x');
	});

	it('does not split inside single-quoted strings', () => {
		const result = __kustoSplitKustoStatementsBySemicolon("print 'a;b'");
		expect(result).toHaveLength(1);
	});

	it('does not split inside double-quoted strings', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('print "a;b"');
		expect(result).toHaveLength(1);
	});

	it('does not split inside line comments', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('T // comment;\n| where x > 5');
		expect(result).toHaveLength(1);
	});

	it('does not split inside block comments', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('T /* ; */ | where x > 5');
		expect(result).toHaveLength(1);
	});

	it('handles no semicolons', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('T | where x > 5');
		expect(result).toHaveLength(1);
		expect(result[0].hasSemicolonAfter).toBe(false);
	});

	it('handles empty input', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('');
		expect(result).toHaveLength(1);
		expect(result[0].statement).toBe('');
	});

	it('handles multiple semicolons', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('a; b; c');
		expect(result).toHaveLength(3);
		expect(result[0].hasSemicolonAfter).toBe(true);
		expect(result[1].hasSemicolonAfter).toBe(true);
		expect(result[2].hasSemicolonAfter).toBe(false);
	});
});

// ── __kustoPrettifyKustoTextWithSemicolonStatements ───────────────────────────

describe('__kustoPrettifyKustoTextWithSemicolonStatements', () => {
	it('formats multi-statement text', () => {
		const input = 'let x = 5; T | where a > x | project a';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('let x = 5');
		expect(result).toContain(';');
		expect(result).toContain('| where');
	});

	it('delegates to __kustoPrettifyKusto for single statement', () => {
		const input = 'T | where x > 5 | project a, b';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		const direct = __kustoPrettifyKusto(input);
		expect(result).toBe(direct);
	});

	it('handles empty input', () => {
		expect(__kustoPrettifyKustoTextWithSemicolonStatements('')).toBe('');
	});

	it('handles multiple let statements', () => {
		const input = 'let a = 1; let b = 2; T | where x == a';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('let a = 1');
		expect(result).toContain('let b = 2');
		const semicolons = (result.match(/^;$/gm) || []).length;
		expect(semicolons).toBe(2);
	});
});
