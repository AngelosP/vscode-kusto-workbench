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

// ── Edge cases: nested queries, multiline strings, comments in summarize ──

describe('__kustoPrettifyKusto — edge cases', () => {
	it('handles nested subquery in join', () => {
		const input = 'T | join (T2 | where y > 3 | project y) on x';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| join');
		expect(result).toContain('T2');
	});

	it('handles comment inside summarize block', () => {
		const input = 'T | summarize count(), // count items\navg(x) by category';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| summarize');
		expect(result).toContain('count()');
		expect(result).toContain('avg(x)');
		expect(result).toContain('by');
	});

	it('handles block comment between pipe stages', () => {
		const input = 'T\n| where x > 5\n/* filter by category */\n| project a, b';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| where');
		expect(result).toContain('| project');
	});

	it('handles multiline where with nested function calls', () => {
		const input = 'T | where strlen(name) > 5 and toupper(category) == "TEST"';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| where');
		expect(result).toContain('strlen(name)');
	});

	it('handles summarize with multiple by columns', () => {
		const input = 'T | summarize count(), sum(val), avg(x) by bin(timestamp, 1h), category, region';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| summarize');
		expect(result).toContain('count()');
		expect(result).toContain('sum(val)');
		expect(result).toContain('by');
		expect(result).toContain('category');
		expect(result).toContain('region');
	});

	it('handles query with union', () => {
		const input = 'T1 | union T2 | where x > 5';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| union');
	});

	it('preserves multiline string literals', () => {
		const input = "T | where msg contains 'line1\\nline2'";
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain("'line1\\nline2'");
	});

	it('handles empty where clause', () => {
		const input = 'T | where';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| where');
	});

	it('handles long project-away list', () => {
		const input = 'T | project-away col1, col2, col3, col4, col5';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| project');
		expect(result).toContain('col1');
		expect(result).toContain('col5');
	});

	it('handles where with or and parenthesized groups', () => {
		const input = 'T | where (a > 5 and b < 10) or (c == 1 and d == 2)';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| where');
		expect(result).toContain('or');
	});

	it('formats let statement with function body', () => {
		const input = 'let f = (x:int) { T | where col == x | project a, b };';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('let f');
		expect(result).toContain('| where');
		expect(result).toContain('| project');
	});

	it('formats let with table body and pipes', () => {
		const input = 'let Base = T | where x > 5 | project a; Base | take 10';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('let Base');
		expect(result).toContain('| take');
	});

	it('handles project with single column (inline)', () => {
		const input = 'T | project col1';
		const result = __kustoPrettifyKusto(input);
		// Single column should remain inline
		expect(result).toContain('| project col1');
	});

	it('handles project with multiple columns (expanded)', () => {
		const input = 'T | project col1, col2, col3';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| project');
		expect(result).toContain('col1');
		expect(result).toContain('col2');
		expect(result).toContain('col3');
	});

	it('handles extend with single assignment (inline)', () => {
		const input = 'T | extend x = 1';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| extend x = 1');
	});

	it('handles extend with multiple assignments (expanded)', () => {
		const input = 'T | extend x = 1, y = strlen(name), z = 42';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| extend');
		expect(result).toContain('x = 1');
		expect(result).toContain('y = strlen(name)');
		expect(result).toContain('z = 42');
	});

	it('handles distinct with multiple columns', () => {
		const input = 'T | distinct col1, col2, col3';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| distinct');
		expect(result).toContain('col1');
		expect(result).toContain('col3');
	});

	it('preserves project-rename operator name', () => {
		const input = 'T | project-rename NewName = OldName, Other = Old2';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| project-rename');
	});

	it('preserves project-reorder operator name', () => {
		const input = 'T | project-reorder a, b, c';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| project-reorder');
	});

	it('preserves project-smart operator name', () => {
		const input = 'T | project-smart a, b';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| project-smart');
	});

	it('handles project-reorder with columns', () => {
		const input = 'T | project-reorder a, b, c';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| project-reorder');
		expect(result).toContain('a');
		expect(result).toContain('c');
	});

	it('handles where with multiple and conditions split across lines', () => {
		const input = 'T | where a > 5 and b < 10 and c != 0';
		const result = __kustoPrettifyKusto(input);
		const lines = result.split('\n');
		// Should have the table, where, and continuation lines
		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(result).toContain('| where');
		expect(result).toContain('and');
	});

	it('handles summarize with no by clause', () => {
		const input = 'T | summarize count(), avg(val)';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| summarize');
		expect(result).toContain('count()');
		expect(result).toContain('avg(val)');
		// No 'by' should appear
		expect(result).not.toContain('by');
	});

	it('handles summarize with single aggregate', () => {
		const input = 'T | summarize count()';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| summarize');
		expect(result).toContain('count()');
	});

	it('collapses blank lines between pipes', () => {
		const input = 'T\n\n\n| where x > 5\n\n\n| project a';
		const result = __kustoPrettifyKusto(input);
		const lines = result.split('\n');
		// Should not have multiple consecutive empty lines
		for (let i = 0; i < lines.length - 1; i++) {
			expect(lines[i].trim() === '' && lines[i + 1].trim() === '').toBe(false);
		}
	});

	it('handles multiline where clause', () => {
		const input = 'T\n| where\n    a > 5\n    and b < 10';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| where');
		expect(result).toContain('a > 5');
		expect(result).toContain('b < 10');
	});

	it('handles single-line commented-out condition in where', () => {
		const input = 'T | where a > 5 // and b < 10';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('a > 5');
		expect(result).toContain('//');
	});

	it('handles multiline summarize spread across lines', () => {
		const input = 'T\n| summarize\n    count(),\n    avg(x)\n    by category';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| summarize');
		expect(result).toContain('count()');
		expect(result).toContain('avg(x)');
		expect(result).toContain('by');
		expect(result).toContain('category');
	});

	it('preserves content in single-quoted strings during formatting', () => {
		const input = "T | where name == 'hello | world'";
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain("'hello | world'");
	});

	it('preserves content in double-quoted strings during formatting', () => {
		const input = 'T | where name == "hello | world"';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('"hello | world"');
	});

	it('handles pipe at different indentation levels', () => {
		const input = '  T\n  | where x > 5\n  | project a';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('T');
		expect(result).toContain('| where');
		expect(result).toContain('| project');
	});

	it('handles query starting with pipe', () => {
		const input = '| where x > 5\n| project a';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('| where');
		expect(result).toContain('| project');
	});

	it('produces idempotent output (prettify twice same result)', () => {
		const input = 'T | where x > 5 and y < 10 | summarize count() by category | project category, count_';
		const first = __kustoPrettifyKusto(input);
		const second = __kustoPrettifyKusto(first);
		expect(second).toBe(first);
	});
});

describe('__kustoSplitKustoStatementsBySemicolon — additional edge cases', () => {
	it('handles escaped quotes inside strings', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('print "a\\"b;c"; T');
		expect(result).toHaveLength(2);
	});

	it('handles Kusto single-quote escaping (\'\')', () => {
		const result = __kustoSplitKustoStatementsBySemicolon("print 'it''s here'; T");
		expect(result).toHaveLength(2);
	});

	it('preserves trailing semicolons', () => {
		const result = __kustoSplitKustoStatementsBySemicolon('A; B;');
		expect(result.length).toBeGreaterThanOrEqual(2);
	});
});

describe('__kustoPrettifyWhereClause — additional edge cases', () => {
	it('handles where with only comments', () => {
		const input = '// comment only';
		const result = __kustoPrettifyWhereClause(input);
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result[0].type).toBe('comment');
	});

	it('handles inline comment after condition', () => {
		const input = 'a > 5 // check upper bound';
		const result = __kustoPrettifyWhereClause(input);
		expect(result.length).toBeGreaterThanOrEqual(1);
		expect(result[0].type).toBe('cond');
		expect(result[0].text).toContain('// check upper bound');
	});

	it('handles empty input', () => {
		expect(__kustoPrettifyWhereClause('').length).toBe(0);
	});

	it('handles nested parens with and/or inside', () => {
		const input = '(a or b) and (c or d)';
		const result = __kustoPrettifyWhereClause(input);
		// The 'and' between groups should be detected, splitting into 2 conditions
		expect(result.length).toBe(2);
		expect(result[0].type).toBe('cond');
		expect(result[1].type).toBe('cond');
		expect(result[1].op).toBe('and');
	});

	it('does not split "and"/"or" that are part of identifier names', () => {
		const input = 'isanderson == true';
		const result = __kustoPrettifyWhereClause(input);
		expect(result.length).toBe(1);
	});

	it('handles multiple or conditions', () => {
		const input = 'a == 1 or b == 2 or c == 3';
		const result = __kustoPrettifyWhereClause(input);
		expect(result.length).toBe(3);
	});
});

describe('__kustoToSingleLineKusto — additional edge cases', () => {
	it('handles block comments spanning multiple lines', () => {
		const input = 'T\n/* line1\nline2\nline3 */\n| where x > 5';
		const result = __kustoToSingleLineKusto(input);
		expect(result).toContain('/* line1');
		expect(result).not.toContain('\n');
	});

	it('handles mixed line and block comments', () => {
		const input = 'T // line comment\n| where x > 5 /* block */';
		const result = __kustoToSingleLineKusto(input);
		expect(result).toContain('/*');
		expect(result).toContain('/* block */');
	});

	it('handles query with only whitespace', () => {
		expect(__kustoToSingleLineKusto('   \n\n   ')).toBe('');
	});

	it('handles triple backtick strings', () => {
		const input = 'print ```hello\nworld```';
		const result = __kustoToSingleLineKusto(input);
		// Triple backtick content should be preserved
		expect(result).toContain('```');
	});
});

describe('__kustoExplodePipesToLines — additional edge cases', () => {
	it('does not split pipes inside block comments', () => {
		const input = 'T /* a | b */ | where x > 5';
		const result = __kustoExplodePipesToLines(input);
		const lines = result.split('\n');
		// The pipe inside /* */ is a comment, not a real pipe — only 2 lines expected
		expect(lines.length).toBe(2);
	});

	it('does not split pipes inside line comments', () => {
		const input = 'T // note | fake\n| where x > 5';
		const result = __kustoExplodePipesToLines(input);
		const lines = result.split('\n');
		// The pipe inside // is a comment, not a real pipe — only 2 lines expected
		expect(lines.length).toBe(2);
	});

	it('does not split pipes inside double-quoted strings', () => {
		const input = 'T | where x == "a | b" | project x';
		const result = __kustoExplodePipesToLines(input);
		const lines = result.split('\n');
		expect(lines.length).toBe(3);
		expect(result).toContain('"a | b"');
	});

	it('handles no pipes', () => {
		const input = 'Table';
		const result = __kustoExplodePipesToLines(input);
		expect(result).toBe('Table');
	});
});

describe('__kustoSplitTopLevel — additional edge cases', () => {
	it('handles semicolon delimiter', () => {
		// Default is comma; semicolons should not split
		const result = __kustoSplitTopLevel('a; b', ',');
		expect(result).toHaveLength(1);
	});

	it('handles nested quoted commas', () => {
		const result = __kustoSplitTopLevel('"a,b", c', ',');
		expect(result).toHaveLength(2);
		expect(result[0]).toContain('"a,b"');
	});

	it('handles deeply nested parentheses', () => {
		const result = __kustoSplitTopLevel('f(g(h(1, 2), 3), 4), b', ',');
		expect(result).toHaveLength(2);
	});

	it('does not split inside triple-backtick strings', () => {
		const result = __kustoSplitTopLevel('```a,b```, c', ',');
		// The comma inside triple-backtick string literal is not a real delimiter
		expect(result).toHaveLength(2);
		expect(result[0].trim()).toBe('```a,b```');
	});

	it('does not split inside block comments', () => {
		const result = __kustoSplitTopLevel('/* a, b */ c, d', ',');
		// The comma inside /* */ is a comment, not a real delimiter
		expect(result).toHaveLength(2);
	});

	it('does not split inside line comments', () => {
		const result = __kustoSplitTopLevel('x // a, b\n, y', ',');
		// The comma inside // is a comment, not a real delimiter
		expect(result).toHaveLength(2);
	});
});

describe('__kustoFindTopLevelKeyword — additional edge cases', () => {
	it('finds keyword after nested parens', () => {
		const result = __kustoFindTopLevelKeyword('f(a, b) by c', 'by');
		expect(result).toBeGreaterThan(0);
	});

	it('does not find keyword inside single-quoted string', () => {
		const result = __kustoFindTopLevelKeyword("'by test' other", 'by');
		expect(result).toBe(-1);
	});

	it('does not find keyword inside double-quoted string', () => {
		const result = __kustoFindTopLevelKeyword('"by test" other', 'by');
		expect(result).toBe(-1);
	});

	it('handles keyword at very start', () => {
		const result = __kustoFindTopLevelKeyword('by column', 'by');
		expect(result).toBe(0);
	});

	it('handles null/undefined input', () => {
		expect(__kustoFindTopLevelKeyword(null, 'by')).toBe(-1);
		expect(__kustoFindTopLevelKeyword('text', null)).toBe(-1);
	});

	it('skips keyword inside block comment', () => {
		const result = __kustoFindTopLevelKeyword('/* by */ other by here', 'by');
		// Should find the 'by' outside the comment (at index 15), not the one inside
		expect(result).toBe(15);
	});

	it('skips keyword inside line comment', () => {
		const result = __kustoFindTopLevelKeyword('// by\nby col', 'by');
		// Should skip the 'by' inside the line comment and find the one on the next line
		expect(result).toBe(6);
	});
});

describe('__kustoPrettifyKusto — .create function formatting', () => {
	it('formats .create function with parameter list', () => {
		const input = '.create function MyFunc(arg1:string, arg2:int) {';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('.create function');
		expect(result).toContain('MyFunc');
	});

	it('formats .create-or-alter function', () => {
		const input = '.create-or-alter function MyFunc(a:string) { T | where x > 1 }';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('.create-or-alter function');
	});

	it('formats .create function with with() section', () => {
		const input = '.create function with (folder="Test", docstring="My doc") MyFunc(a:string) { T }';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('.create function');
		expect(result).toContain('with');
	});

	it('formats .create function with no brace on same line', () => {
		const input = '.create function MyFunc()';
		const result = __kustoPrettifyKusto(input);
		expect(result).toContain('.create function');
		expect(result).toContain('MyFunc');
	});
});

describe('__kustoPrettifyKustoTextWithSemicolonStatements — more edge cases', () => {
	it('handles let followed by query followed by let', () => {
		const input = 'let X = 1; T | where x == X | project a; let Y = 2';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('let X');
		expect(result).toContain('| where');
		expect(result).toContain('let Y');
	});

	it('handles empty statements between semicolons', () => {
		const input = 'T | project a;; let x = 1';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('| project');
		expect(result).toContain('let x');
	});

	it('preserves semicolons in multi-statement text', () => {
		const input = 'let A = 1; let B = 2; A';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain(';');
	});

	it('handles trailing semicolon', () => {
		const input = 'T | project a;';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('| project');
	});

	it('handles CRLF line endings', () => {
		const input = 'let A = 1;\r\nT | where x > 5';
		const result = __kustoPrettifyKustoTextWithSemicolonStatements(input);
		expect(result).toContain('let A');
		expect(result).toContain('| where');
	});
});

describe('__kustoPrettifyKusto — indentation edge cases', () => {
	it('indents pipe lines under table name', () => {
		const input = 'Table | where x > 5 | project a';
		const result = __kustoPrettifyKusto(input);
		const lines = result.split('\n');
		// First line should be Table, subsequent should be indented
		expect(lines[0].trim()).toBe('Table');
		expect(lines[1]).toMatch(/^\s+\| where/);
	});

	it('indentation carries through for summarize blocks', () => {
		const input = 'Table | summarize count() by x';
		const result = __kustoPrettifyKusto(input);
		const lines = result.split('\n');
		expect(lines[0].trim()).toBe('Table');
		// Summarize line should be indented
		expect(lines[1]).toMatch(/^\s+\| summarize/);
	});

	it('handles multiple blank lines at start', () => {
		const input = '\n\n\nTable | where x > 5';
		const result = __kustoPrettifyKusto(input);
		// Leading blank lines should be trimmed
		expect(result.startsWith('Table')).toBe(true);
	});

	it('handles multiple blank lines at end', () => {
		const input = 'Table | where x > 5\n\n\n';
		const result = __kustoPrettifyKusto(input);
		// Trailing blank lines should be trimmed
		expect(result.endsWith('x > 5')).toBe(true);
	});
});
