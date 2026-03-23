import { describe, it, expect, beforeAll } from 'vitest';
import {
	initCaretDocsDeps,
	buildFunctionSignatureMarkdown,
	findEnclosingFunctionCall,
	computeArgIndex,
	getTokenAtPosition,
	getMultiWordOperatorAt,
	KUSTO_FUNCTION_DOCS,
	KUSTO_KEYWORD_DOCS,
	__kustoNormalizeControlCommand,
	__kustoExtractWithOptionArgsFromSyntax,
	__kustoParseControlCommandSyntaxFromLearnHtml,
	__kustoFindWithOptionsParenRange,
	getHoverInfoAt,
} from '../../src/webview/monaco/caret-docs';

// ── Minimal model + monaco mocks ──────────────────────────────────────────────

class MockRange {
	constructor(
		public startLineNumber: number,
		public startColumn: number,
		public endLineNumber: number,
		public endColumn: number
	) {}
}

class MockPosition {
	constructor(public lineNumber: number, public column: number) {}
}

function makeModel(text: string) {
	const lines = text.split('\n');
	return {
		getValue: () => text,
		getLineContent: (ln: number) => lines[ln - 1] || '',
		getLineCount: () => lines.length,
		getOffsetAt: (pos: { lineNumber: number; column: number }) => {
			let offset = 0;
			for (let i = 0; i < pos.lineNumber - 1; i++) {
				offset += lines[i].length + 1; // +1 for \n
			}
			return offset + pos.column - 1;
		},
		getPositionAt: (offset: number) => {
			let remaining = offset;
			for (let i = 0; i < lines.length; i++) {
				if (remaining <= lines[i].length) {
					return new MockPosition(i + 1, remaining + 1);
				}
				remaining -= lines[i].length + 1;
			}
			return new MockPosition(lines.length, (lines[lines.length - 1]?.length ?? 0) + 1);
		},
		getWordAtPosition: (pos: { lineNumber: number; column: number }) => {
			const line = lines[pos.lineNumber - 1] || '';
			let start = pos.column - 1;
			let end = pos.column - 1;
			while (start > 0 && /[A-Za-z0-9_\-]/.test(line[start - 1])) start--;
			while (end < line.length && /[A-Za-z0-9_\-]/.test(line[end])) end++;
			if (start === end) return null;
			return { word: line.slice(start, end), startColumn: start + 1, endColumn: end + 1 };
		},
	};
}

beforeAll(() => {
	initCaretDocsDeps({ Range: MockRange, Position: MockPosition });
});

// ── buildFunctionSignatureMarkdown ────────────────────────────────────────────

describe('buildFunctionSignatureMarkdown', () => {
	it('formats function with no active arg', () => {
		const doc = { args: ['expr', 'accuracy?'], returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('dcount', doc, -1);
		expect(result).toBe('`dcount(expr, accuracy?): long`');
	});

	it('bolds the active argument', () => {
		const doc = { args: ['expr', 'accuracy?'], returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('dcount', doc, 0);
		expect(result).toBe('`dcount(**expr**, accuracy?): long`');
	});

	it('bolds the second argument', () => {
		const doc = { args: ['expr', 'accuracy?'], returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('dcount', doc, 1);
		expect(result).toBe('`dcount(expr, **accuracy?**): long`');
	});

	it('handles empty args', () => {
		const doc = { args: [], returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('count', doc, -1);
		expect(result).toBe('`count(): long`');
	});

	it('handles missing returnType', () => {
		const doc = { args: ['x'] };
		const result = buildFunctionSignatureMarkdown('f', doc, -1);
		expect(result).toBe('`f(x)`');
	});

	it('handles undefined args', () => {
		const doc = { returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('count', doc, -1);
		expect(result).toBe('`count(): long`');
	});
});

// ── findEnclosingFunctionCall ─────────────────────────────────────────────────

describe('findEnclosingFunctionCall', () => {
	it('finds function name for cursor inside parens', () => {
		const model = makeModel('dcount(x)');
		const result = findEnclosingFunctionCall(model, 7); // inside '('
		expect(result).toBeTruthy();
		expect(result!.name).toBe('dcount');
		expect(result!.openParenOffset).toBe(6);
	});

	it('returns null when not inside any parens', () => {
		const model = makeModel('Table | where x > 5');
		expect(findEnclosingFunctionCall(model, 0)).toBeNull();
	});

	it('returns null for empty model', () => {
		const model = makeModel('');
		expect(findEnclosingFunctionCall(model, 0)).toBeNull();
	});

	it('handles nested calls — returns innermost', () => {
		const model = makeModel('f(g(x))');
		const result = findEnclosingFunctionCall(model, 5); // inside g()
		expect(result).toBeTruthy();
		expect(result!.name).toBe('g');
	});

	it('handles whitespace before open paren', () => {
		const model = makeModel('dcount (x)');
		const result = findEnclosingFunctionCall(model, 8); // inside '('
		expect(result).toBeTruthy();
		expect(result!.name).toBe('dcount');
	});

	it('skips strings when scanning backward', () => {
		const model = makeModel("f(')')");
		// Cursor after the closing quote, inside f()
		const result = findEnclosingFunctionCall(model, 5);
		expect(result).toBeTruthy();
		expect(result!.name).toBe('f');
	});

	it('returns null when open paren has no preceding identifier', () => {
		const model = makeModel('(x + y)');
		expect(findEnclosingFunctionCall(model, 2)).toBeNull();
	});
});

// ── computeArgIndex ───────────────────────────────────────────────────────────

describe('computeArgIndex', () => {
	it('returns 0 for first argument', () => {
		const model = makeModel('f(a, b, c)');
		expect(computeArgIndex(model, 1, 3)).toBe(0); // between ( and first comma
	});

	it('returns 1 for second argument', () => {
		const model = makeModel('f(a, b, c)');
		expect(computeArgIndex(model, 1, 5)).toBe(1); // after first comma
	});

	it('returns 2 for third argument', () => {
		const model = makeModel('f(a, b, c)');
		expect(computeArgIndex(model, 1, 8)).toBe(2);
	});

	it('does not count commas inside nested parens', () => {
		const model = makeModel('f(g(a, b), c)');
		expect(computeArgIndex(model, 1, 11)).toBe(1); // 'c' is arg 1
	});

	it('does not count commas inside strings', () => {
		const model = makeModel("f('a, b', c)");
		expect(computeArgIndex(model, 1, 10)).toBe(1); // 'c' is arg 1
	});

	it('returns 0 when no commas', () => {
		const model = makeModel('f(x)');
		expect(computeArgIndex(model, 1, 3)).toBe(0);
	});
});

// ── getTokenAtPosition ────────────────────────────────────────────────────────

describe('getTokenAtPosition', () => {
	it('returns the token under the cursor', () => {
		const model = makeModel('Table | where x > 5');
		const result = getTokenAtPosition(model, { lineNumber: 1, column: 3 }); // on 'b' in Table
		expect(result).toBeTruthy();
		expect(result!.word).toBe('Table');
	});

	it('returns null for whitespace position', () => {
		const model = makeModel('T  W');
		const result = getTokenAtPosition(model, { lineNumber: 1, column: 3 }); // space
		expect(result).toBeNull();
	});

	it('returns null for empty line', () => {
		const model = makeModel('');
		expect(getTokenAtPosition(model, { lineNumber: 1, column: 1 })).toBeNull();
	});

	it('probes one char left at EOL', () => {
		const model = makeModel('Table');
		// Column 6 = past end of "Table" (1-based: Table occupies 1-5)
		const result = getTokenAtPosition(model, { lineNumber: 1, column: 6 });
		expect(result).toBeTruthy();
		expect(result!.word).toBe('Table');
	});

	it('handles hyphenated identifiers', () => {
		const model = makeModel('project-away col');
		const result = getTokenAtPosition(model, { lineNumber: 1, column: 5 });
		expect(result).toBeTruthy();
		expect(result!.word).toBe('project-away');
	});
});

// ── getMultiWordOperatorAt ────────────────────────────────────────────────────

describe('getMultiWordOperatorAt', () => {
	it('detects "order by"', () => {
		const model = makeModel('| order by col desc');
		const result = getMultiWordOperatorAt(model, { lineNumber: 1, column: 5 }); // on 'r' of order
		expect(result).toBeTruthy();
		expect(result!.key).toBe('order by');
	});

	it('detects "sort by"', () => {
		const model = makeModel('| sort by col');
		const result = getMultiWordOperatorAt(model, { lineNumber: 1, column: 4 });
		expect(result).toBeTruthy();
		expect(result!.key).toBe('sort by');
	});

	it('returns null for regular keywords', () => {
		const model = makeModel('| where x > 5');
		expect(getMultiWordOperatorAt(model, { lineNumber: 1, column: 5 })).toBeNull();
	});

	it('returns null for empty line', () => {
		const model = makeModel('');
		expect(getMultiWordOperatorAt(model, { lineNumber: 1, column: 1 })).toBeNull();
	});
});

// ── __kustoNormalizeControlCommand ────────────────────────────────────────────

describe('__kustoNormalizeControlCommand', () => {
	it('normalizes whitespace', () => {
		expect(__kustoNormalizeControlCommand('.show   tables')).toBe('.show tables');
	});

	it('returns empty for non-dot-prefixed', () => {
		expect(__kustoNormalizeControlCommand('show tables')).toBe('');
	});

	it('returns empty for empty input', () => {
		expect(__kustoNormalizeControlCommand('')).toBe('');
	});

	it('strips trailing "command" word', () => {
		expect(__kustoNormalizeControlCommand('.show tables command')).toBe('.show tables');
	});

	it('does not strip "command" if only two parts', () => {
		expect(__kustoNormalizeControlCommand('.show command')).toBe('.show command');
	});

	it('trims leading/trailing whitespace', () => {
		expect(__kustoNormalizeControlCommand('  .show tables  ')).toBe('.show tables');
	});

	it('handles null/undefined gracefully', () => {
		expect(__kustoNormalizeControlCommand(null)).toBe('');
		expect(__kustoNormalizeControlCommand(undefined)).toBe('');
	});
});

// ── __kustoExtractWithOptionArgsFromSyntax ────────────────────────────────────

describe('__kustoExtractWithOptionArgsFromSyntax', () => {
	it('extracts named arguments from with(...)', () => {
		const result = __kustoExtractWithOptionArgsFromSyntax('.ingest with (format=csv, ingestionMappingReference=MyMapping)');
		expect(result).toContain('format');
		expect(result).toContain('ingestionMappingReference');
	});

	it('returns empty array when no with()', () => {
		expect(__kustoExtractWithOptionArgsFromSyntax('.show tables')).toEqual([]);
	});

	it('returns empty array for empty input', () => {
		expect(__kustoExtractWithOptionArgsFromSyntax('')).toEqual([]);
	});

	it('returns empty array for null', () => {
		expect(__kustoExtractWithOptionArgsFromSyntax(null)).toEqual([]);
	});

	it('deduplicates argument names', () => {
		const result = __kustoExtractWithOptionArgsFromSyntax('.cmd with (a=1, a=2)');
		expect(result).toEqual(['a']);
	});

	it('handles multiple arguments with whitespace', () => {
		const result = __kustoExtractWithOptionArgsFromSyntax('.cmd with ( foo = bar , baz = qux )');
		expect(result).toContain('foo');
		expect(result).toContain('baz');
	});
});

// ── __kustoParseControlCommandSyntaxFromLearnHtml ─────────────────────────────

describe('__kustoParseControlCommandSyntaxFromLearnHtml', () => {
	it('returns null for empty input', () => {
		expect(__kustoParseControlCommandSyntaxFromLearnHtml('')).toBeNull();
	});

	it('returns null for null input', () => {
		expect(__kustoParseControlCommandSyntaxFromLearnHtml(null)).toBeNull();
	});

	it('extracts syntax from <h2>Syntax</h2> followed by <pre><code>', () => {
		const html = `
			<h2>Syntax</h2>
			<pre><code>.show tables</code></pre>
		`;
		expect(__kustoParseControlCommandSyntaxFromLearnHtml(html)).toBe('.show tables');
	});

	it('trims blank lines from code blocks', () => {
		const html = `
			<h2>Syntax</h2>
			<pre><code>
			.show tables
			</code></pre>
		`;
		const result = __kustoParseControlCommandSyntaxFromLearnHtml(html);
		expect(result).toBeTruthy();
		expect(result!.trim()).toContain('.show tables');
	});

	it('falls back to first <pre><code> if no Syntax heading', () => {
		const html = `
			<h2>Overview</h2>
			<pre><code>.show version</code></pre>
		`;
		expect(__kustoParseControlCommandSyntaxFromLearnHtml(html)).toBe('.show version');
	});

	it('returns null for HTML with no code blocks', () => {
		const html = '<h2>Syntax</h2><p>Some text</p>';
		expect(__kustoParseControlCommandSyntaxFromLearnHtml(html)).toBeNull();
	});
});

// ── __kustoFindWithOptionsParenRange ──────────────────────────────────────────

describe('__kustoFindWithOptionsParenRange', () => {
	it('finds with(...) range', () => {
		const text = '.ingest with (format=csv)';
		const result = __kustoFindWithOptionsParenRange(text, 0);
		expect(result).toBeTruthy();
		expect(result!.open).toBe(text.indexOf('('));
		expect(result!.close).toBe(text.indexOf(')'));
	});

	it('returns null when no with keyword', () => {
		expect(__kustoFindWithOptionsParenRange('.show tables', 0)).toBeNull();
	});

	it('returns null for empty text', () => {
		expect(__kustoFindWithOptionsParenRange('', 0)).toBeNull();
	});

	it('skips with inside single-quoted strings', () => {
		const text = ".set T with (a=1)\nprint 'with (x=1)'";
		const result = __kustoFindWithOptionsParenRange(text, 0);
		expect(result).toBeTruthy();
		expect(result!.open).toBeLessThan(20);
	});

	it('skips with inside line comments', () => {
		const text = '// with (x=1)\n.cmd with (a=1)';
		const result = __kustoFindWithOptionsParenRange(text, 0);
		expect(result).toBeTruthy();
		expect(result!.open).toBeGreaterThan(13);
	});

	it('skips with inside block comments', () => {
		const text = '/* with (x=1) */\n.cmd with (a=1)';
		const result = __kustoFindWithOptionsParenRange(text, 0);
		expect(result).toBeTruthy();
		expect(result!.open).toBeGreaterThan(16);
	});

	it('does not match "with" embedded in identifier', () => {
		const text = 'withhold something\n.cmd with (a=1)';
		const result = __kustoFindWithOptionsParenRange(text, 0);
		expect(result).toBeTruthy();
		// Should match the .cmd with, not the "withhold"
		expect(result!.open).toBeGreaterThan(18);
	});

	it('returns null for unclosed with paren', () => {
		const text = '.cmd with (a=1, b=2';
		expect(__kustoFindWithOptionsParenRange(text, 0)).toBeNull();
	});
});

// ── KUSTO_FUNCTION_DOCS / KUSTO_KEYWORD_DOCS ─────────────────────────────────

describe('KUSTO_FUNCTION_DOCS', () => {
	it('contains core aggregation functions', () => {
		expect(KUSTO_FUNCTION_DOCS['dcount']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['sum']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['avg']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['min']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['max']).toBeTruthy();
	});

	it('has args arrays', () => {
		expect(Array.isArray(KUSTO_FUNCTION_DOCS['dcount'].args)).toBe(true);
		expect(KUSTO_FUNCTION_DOCS['dcount'].args.length).toBeGreaterThan(0);
	});

	it('has returnType', () => {
		expect(KUSTO_FUNCTION_DOCS['dcount'].returnType).toBe('long');
	});

	it('has description', () => {
		expect(typeof KUSTO_FUNCTION_DOCS['dcount'].description).toBe('string');
	});

	it('contains string functions', () => {
		expect(KUSTO_FUNCTION_DOCS['strlen']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['tolower']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['strcat']).toBeTruthy();
	});

	it('contains datetime functions', () => {
		expect(KUSTO_FUNCTION_DOCS['ago']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['todatetime']).toBeTruthy();
		expect(KUSTO_FUNCTION_DOCS['bin']).toBeTruthy();
	});
});

describe('KUSTO_KEYWORD_DOCS', () => {
	it('contains core operators', () => {
		expect(KUSTO_KEYWORD_DOCS['where']).toBeTruthy();
		expect(KUSTO_KEYWORD_DOCS['summarize']).toBeTruthy();
		expect(KUSTO_KEYWORD_DOCS['project']).toBeTruthy();
		expect(KUSTO_KEYWORD_DOCS['extend']).toBeTruthy();
		expect(KUSTO_KEYWORD_DOCS['join']).toBeTruthy();
	});

	it('has signature and description', () => {
		const where = KUSTO_KEYWORD_DOCS['where'];
		expect(typeof where.signature).toBe('string');
		expect(typeof where.description).toBe('string');
	});

	it('contains multi-word operators', () => {
		expect(KUSTO_KEYWORD_DOCS['order by']).toBeTruthy();
		expect(KUSTO_KEYWORD_DOCS['sort by']).toBeTruthy();
	});

	it('contains project variants', () => {
		expect(KUSTO_KEYWORD_DOCS['project-away']).toBeTruthy();
		expect(KUSTO_KEYWORD_DOCS['project-keep']).toBeTruthy();
		expect(KUSTO_KEYWORD_DOCS['project-rename']).toBeTruthy();
	});
});

// ── getHoverInfoAt integration tests ──────────────────────────────────────────

describe('getHoverInfoAt', () => {
	it('returns function hover for token on a known function', () => {
		const model = makeModel('| summarize dcount(x)');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 14 }); // on 'dcount'
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('dcount');
	});

	it('returns keyword hover for "where"', () => {
		const model = makeModel('T | where x > 5');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 6 }); // on 'where'
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('where');
	});

	it('shows active argument in function hover', () => {
		const model = makeModel('dcount(x, 2)');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 11 }); // on '2', second arg
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('**accuracy?**');
	});

	it('returns operator hover from pipe context', () => {
		const model = makeModel('T\n| summarize count()');
		const result = getHoverInfoAt(model, { lineNumber: 2, column: 5 }); // on 'summarize'
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('summarize');
	});

	it('returns null for unknown tokens', () => {
		const model = makeModel('myCustomTable');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 5 });
		expect(result).toBeNull();
	});

	it('detects multi-word "order by" operator', () => {
		const model = makeModel('T | order by col desc');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 7 }); // on 'order'
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('order by');
	});

	it('provides function hover inside nested call', () => {
		const model = makeModel('| summarize dcount(tolower(x))');
		// Place cursor on 'x' inside tolower()
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 28 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('tolower');
	});

	it('provides pipe operator context when typing arguments', () => {
		const model = makeModel('T\n| where ');
		const result = getHoverInfoAt(model, { lineNumber: 2, column: 9 }); // after "where "
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('where');
	});
});
