import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
	initCaretDocsDeps,
	buildFunctionSignatureMarkdown,
	findEnclosingFunctionCall,
	computeArgIndex,
	getTokenAtPosition,
	getMultiWordOperatorAt,
	getWordRangeAt,
	KUSTO_FUNCTION_DOCS,
	KUSTO_KEYWORD_DOCS,
	__kustoNormalizeControlCommand,
	__kustoExtractWithOptionArgsFromSyntax,
	__kustoParseControlCommandSyntaxFromLearnHtml,
	__kustoFindWithOptionsParenRange,
	__kustoFindEnclosingWithOptionsParen,
	getHoverInfoAt,
	getSchemaFunctionDoc,
	getSchemaTableDoc,
	_abbreviateType,
	__kustoBuildControlCommandIndex,
	__kustoEnsureGeneratedFunctionsMerged,
	__kustoGeneratedFunctionsMerged,
	setGeneratedFunctionsMerged,
	__kustoGetControlCommandHoverAt,
	__kustoControlCommands,
} from '../../src/webview/monaco/caret-docs';
import { __kustoGetStatementStartAtOffset } from '../../src/webview/monaco/diagnostics.js';

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
		expect(result).toBe('{{sig}}dcount(expr, accuracy?): long{{/sig}}');
	});

	it('bolds the active argument', () => {
		const doc = { args: ['expr', 'accuracy?'], returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('dcount', doc, 0);
		expect(result).toBe('{{sig}}dcount(**expr**, accuracy?): long{{/sig}}');
	});

	it('bolds the second argument', () => {
		const doc = { args: ['expr', 'accuracy?'], returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('dcount', doc, 1);
		expect(result).toBe('{{sig}}dcount(expr, **accuracy?**): long{{/sig}}');
	});

	it('handles empty args', () => {
		const doc = { args: [], returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('count', doc, -1);
		expect(result).toBe('{{sig}}count(): long{{/sig}}');
	});

	it('handles missing returnType', () => {
		const doc = { args: ['x'] };
		const result = buildFunctionSignatureMarkdown('f', doc, -1);
		expect(result).toBe('{{sig}}f(x){{/sig}}');
	});

	it('handles undefined args', () => {
		const doc = { returnType: 'long' };
		const result = buildFunctionSignatureMarkdown('count', doc, -1);
		expect(result).toBe('{{sig}}count(): long{{/sig}}');
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

	it('stops at semicolon — does not cross statement boundary', () => {
		const model = makeModel('f(x)\n;\nlet variable = y');
		// Cursor on 'variable' (offset 10 = after ';\nlet v')
		const offset = 'f(x)\n;\nlet v'.length;
		expect(findEnclosingFunctionCall(model, offset)).toBeNull();
	});

	it('stops at semicolon on same line', () => {
		const model = makeModel('f(x); let y = 1');
		const offset = 'f(x); let y'.length;
		expect(findEnclosingFunctionCall(model, offset)).toBeNull();
	});

	it('ignores semicolon inside single-quoted string', () => {
		const model = makeModel("f('a;b', ");
		const offset = "f('a;b', ".length;
		const result = findEnclosingFunctionCall(model, offset);
		expect(result).toBeTruthy();
		expect(result!.name).toBe('f');
	});

	it('still finds function within same statement (no semicolon)', () => {
		const model = makeModel('f(x,\n y');
		const offset = 'f(x,\n y'.length;
		const result = findEnclosingFunctionCall(model, offset);
		expect(result).toBeTruthy();
		expect(result!.name).toBe('f');
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

	it('does not show function docs across semicolon statement boundary', () => {
		const model = makeModel('dcount(x)\n;\nlet variable = something');
		// Cursor on 'variable' in line 3
		const result = getHoverInfoAt(model, { lineNumber: 3, column: 6 });
		// Should NOT show dcount docs — semicolon separates statements
		expect(result).toBeNull();
	});

	it('does not show schema function docs across semicolon boundary', () => {
		const boxId = '__test_semicolon_box__';
		(window as any).schemaByBoxId = { [boxId]: { functions: [{
			name: 'getAzdEvents',
			parameters: [
				{ name: 'startDate', type: 'datetime' },
				{ name: 'endDate', type: 'datetime' },
			],
			docString: 'Get events.',
		}] } };
		try {
			const model = makeModel('getAzdEvents(startDate, endDate)\n;\nlet variable = something');
			// Cursor on 'variable' in line 3
			const result = getHoverInfoAt(model, { lineNumber: 3, column: 6 }, boxId);
			expect(result).toBeNull();
		} finally {
			delete (window as any).schemaByBoxId;
		}
	});

	it('does not show pipe operator docs across semicolon boundary', () => {
		const model = makeModel('T\n| where x > 5\n;\nlet variable = something');
		// Cursor on 'variable' in line 4 — should NOT show 'where' docs from the prior statement
		const result = getHoverInfoAt(model, { lineNumber: 4, column: 6 });
		expect(result).toBeNull();
	});

	it('does not show pipe operator context across semicolon on its own line', () => {
		const model = makeModel('T\n| summarize count()\n;\nOtherTable');
		// Cursor on 'OtherTable' line 4 — should NOT show 'summarize' docs
		const result = getHoverInfoAt(model, { lineNumber: 4, column: 5 });
		expect(result).toBeNull();
	});

	it('still shows pipe operator docs within same statement (no semicolon)', () => {
		const model = makeModel('T\n| where x > 5\n    and y < 10');
		// Cursor on 'and' in line 3 — should show 'where' docs (same statement)
		const result = getHoverInfoAt(model, { lineNumber: 3, column: 8 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('where');
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

	it('clamps active arg index to args.length - 1', () => {
		// f(a, b, c, d) — dcount only has 2 args, so index should clamp
		const model = makeModel('dcount(x, y, extra)');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 14 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('dcount');
		// Second arg (accuracy?) should be highlighted since index is clamped
		expect(result!.markdown).toContain('**accuracy?**');
	});

	it('finds function call with offset+1 probe', () => {
		// Cursor exactly on open paren — first attempt misses, probe offset+1 hits
		const model = makeModel('avg(col)');
		// Column 4 = on '('
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 4 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('avg');
	});

	it('provides hover for functions when cursor is just before parens', () => {
		const model = makeModel('count()');
		// Column 6 = on '('
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 6 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('count');
	});

	it('returns pipe operator docs for project-away', () => {
		const model = makeModel('T\n| project-away Col1');
		const result = getHoverInfoAt(model, { lineNumber: 2, column: 4 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('project-away');
	});

	it('returns pipe operator docs for mv-expand', () => {
		const model = makeModel('T\n| mv-expand Col');
		const result = getHoverInfoAt(model, { lineNumber: 2, column: 4 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('mv-expand');
	});

	it('recognizes "filter" as alias for "where"', () => {
		const model = makeModel('T\n| filter x > 5');
		const result = getHoverInfoAt(model, { lineNumber: 2, column: 4 });
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('where');
	});
});

// ── getWordRangeAt ────────────────────────────────────────────────────────────

describe('getWordRangeAt', () => {
	it('returns a range for a word at the cursor', () => {
		const model = makeModel('hello world');
		const result = getWordRangeAt(model, { lineNumber: 1, column: 2 });
		expect(result).toBeInstanceOf(MockRange);
		expect(result!.startColumn).toBe(1);
		expect(result!.endColumn).toBe(6);
	});

	it('returns null when getWordAtPosition returns null', () => {
		const model = makeModel('   ');
		model.getWordAtPosition = () => null;
		expect(getWordRangeAt(model, { lineNumber: 1, column: 2 })).toBeNull();
	});

	it('returns range for the second word', () => {
		const model = makeModel('hello world');
		const result = getWordRangeAt(model, { lineNumber: 1, column: 8 });
		expect(result).toBeInstanceOf(MockRange);
		expect(result!.startColumn).toBe(7);
		expect(result!.endColumn).toBe(12);
	});
});

// ── __kustoBuildControlCommandIndex ───────────────────────────────────────────

describe('__kustoBuildControlCommandIndex', () => {
	it('returns empty array when no entries on window', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = undefined;
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result).toEqual([]);
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('builds index from tuple entries', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			['.show tables', 'management/show-tables'],
			['.show databases', 'management/show-databases'],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result.length).toBe(2);
			expect(result[0].commandLower).toBe('.show databases'); // longer first
			expect(result[1].commandLower).toBe('.show tables');
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('builds index from object entries', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			{ title: '.show tables', href: 'management/show-tables' },
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result.length).toBe(1);
			expect(result[0].command).toBe('.show tables');
			expect(result[0].href).toBe('management/show-tables');
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('handles comma-separated aliases', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			['.show tables, .show table', 'management/show-tables'],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result.length).toBe(2);
			const keys = result.map((r: any) => r.commandLower);
			expect(keys).toContain('.show tables');
			expect(keys).toContain('.show table');
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('handles pipe-separated aliases', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			['.show tables|.list tables', 'management/show-tables'],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			const keys = result.map((r: any) => r.commandLower);
			expect(keys).toContain('.show tables');
			expect(keys).toContain('.list tables');
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('skips entries without dot prefix', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			['show tables', 'management/show-tables'],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result).toEqual([]);
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('skips entries without title or href', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			[null, 'management/show-tables'],
			['.show tables', null],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result).toEqual([]);
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('deduplicates by lower-cased command', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			['.show tables', 'url1'],
			['.Show Tables', 'url2'],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result.length).toBe(1);
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('sorts longest-first', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			['.show', 'url1'],
			['.show tables details', 'url3'],
			['.show tables', 'url2'],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result[0].commandLower).toBe('.show tables details');
			expect(result[1].commandLower).toBe('.show tables');
			expect(result[2].commandLower).toBe('.show');
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});

	it('strips trailing "command" word from 3+ part titles', () => {
		const old = (window as any).__kustoControlCommandEntries;
		(window as any).__kustoControlCommandEntries = [
			['.show tables command', 'management/show-tables'],
		];
		try {
			const result = __kustoBuildControlCommandIndex();
			expect(result.length).toBe(1);
			expect(result[0].command).toBe('.show tables');
		} finally {
			(window as any).__kustoControlCommandEntries = old;
		}
	});
});

// ── __kustoEnsureGeneratedFunctionsMerged ─────────────────────────────────────

describe('__kustoEnsureGeneratedFunctionsMerged', () => {
	beforeEach(() => {
		// Reset the merge flag before each test
		setGeneratedFunctionsMerged(false);
	});

	it('merges function entries from window.__kustoFunctionEntries', () => {
		const uniqueName = '_test_func_' + Date.now();
		(window as any).__kustoFunctionEntries = [{ name: uniqueName }];
		(window as any).__kustoFunctionDocs = {};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			const key = uniqueName.toLowerCase();
			expect(KUSTO_FUNCTION_DOCS[key]).toBeTruthy();
			expect(KUSTO_FUNCTION_DOCS[key].description).toBe('Kusto function.');
			expect(KUSTO_FUNCTION_DOCS[key].returnType).toBe('scalar');
		} finally {
			delete KUSTO_FUNCTION_DOCS[uniqueName.toLowerCase()];
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});

	it('merges function entries from tuple format', () => {
		const uniqueName = '_test_tuple_' + Date.now();
		(window as any).__kustoFunctionEntries = [[uniqueName]];
		(window as any).__kustoFunctionDocs = {};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			const key = uniqueName.toLowerCase();
			expect(KUSTO_FUNCTION_DOCS[key]).toBeTruthy();
		} finally {
			delete KUSTO_FUNCTION_DOCS[uniqueName.toLowerCase()];
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});

	it('picks up detailed docs from window.__kustoFunctionDocs', () => {
		const uniqueName = '_test_docs_' + Date.now();
		(window as any).__kustoFunctionEntries = [{ name: uniqueName }];
		(window as any).__kustoFunctionDocs = {
			[uniqueName]: {
				args: ['x', 'y'],
				description: 'Test function description.',
				signature: 'test_func(x, y)',
				docUrl: 'https://example.com/test',
			},
		};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			const key = uniqueName.toLowerCase();
			expect(KUSTO_FUNCTION_DOCS[key]).toBeTruthy();
			expect(KUSTO_FUNCTION_DOCS[key].args).toEqual(['x', 'y']);
			expect(KUSTO_FUNCTION_DOCS[key].description).toBe('Test function description.');
			expect(KUSTO_FUNCTION_DOCS[key].signature).toBe('test_func(x, y)');
			expect(KUSTO_FUNCTION_DOCS[key].docUrl).toBe('https://example.com/test');
		} finally {
			delete KUSTO_FUNCTION_DOCS[uniqueName.toLowerCase()];
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});

	it('does not overwrite existing built-in function docs', () => {
		const originalDcount = { ...KUSTO_FUNCTION_DOCS['dcount'] };
		(window as any).__kustoFunctionEntries = [{ name: 'dcount' }];
		(window as any).__kustoFunctionDocs = {
			dcount: { args: ['overridden'], description: 'Should not overwrite.' },
		};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			expect(KUSTO_FUNCTION_DOCS['dcount'].description).toBe(originalDcount.description);
		} finally {
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});

	it('skips invalid function names (non-identifier)', () => {
		(window as any).__kustoFunctionEntries = [{ name: '123invalid' }, { name: 'has space' }];
		(window as any).__kustoFunctionDocs = {};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			expect(KUSTO_FUNCTION_DOCS['123invalid']).toBeUndefined();
			expect(KUSTO_FUNCTION_DOCS['has space']).toBeUndefined();
		} finally {
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});

	it('skips entries with empty or null names', () => {
		(window as any).__kustoFunctionEntries = [{ name: '' }, { name: null }, [null]];
		(window as any).__kustoFunctionDocs = {};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			// No crash, no entries added
			expect(KUSTO_FUNCTION_DOCS['']).toBeUndefined();
		} finally {
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});

	it('is idempotent — does not re-merge after first call', () => {
		const uniqueName = '_test_idempotent_' + Date.now();
		(window as any).__kustoFunctionEntries = [{ name: uniqueName }];
		(window as any).__kustoFunctionDocs = {};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			const key = uniqueName.toLowerCase();
			expect(KUSTO_FUNCTION_DOCS[key]).toBeTruthy();

			// Clear entries and call again — since flag is set, should not re-merge
			(window as any).__kustoFunctionEntries = [{ name: uniqueName + '2' }];
			__kustoEnsureGeneratedFunctionsMerged();
			expect(KUSTO_FUNCTION_DOCS[(uniqueName + '2').toLowerCase()]).toBeUndefined();
		} finally {
			delete KUSTO_FUNCTION_DOCS[uniqueName.toLowerCase()];
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});

	it('handles missing window.__kustoFunctionEntries gracefully', () => {
		delete (window as any).__kustoFunctionEntries;
		delete (window as any).__kustoFunctionDocs;
		// Should not throw
		__kustoEnsureGeneratedFunctionsMerged();
	});

	it('case-insensitive doc lookup — matches lowercase key', () => {
		const uniqueName = '_Test_CaseDoc_' + Date.now();
		(window as any).__kustoFunctionEntries = [{ name: uniqueName }];
		(window as any).__kustoFunctionDocs = {
			[uniqueName.toLowerCase()]: {
				args: ['a'],
				description: 'Lower key match.',
			},
		};
		try {
			__kustoEnsureGeneratedFunctionsMerged();
			const key = uniqueName.toLowerCase();
			expect(KUSTO_FUNCTION_DOCS[key]).toBeTruthy();
			expect(KUSTO_FUNCTION_DOCS[key].description).toBe('Lower key match.');
		} finally {
			delete KUSTO_FUNCTION_DOCS[uniqueName.toLowerCase()];
			delete (window as any).__kustoFunctionEntries;
			delete (window as any).__kustoFunctionDocs;
		}
	});
});

// ── __kustoGetControlCommandHoverAt ───────────────────────────────────────────

describe('__kustoGetControlCommandHoverAt', () => {
	// Set up the bare global that caret-docs uses without importing
	beforeAll(() => {
		(globalThis as any).__kustoGetStatementStartAtOffset = __kustoGetStatementStartAtOffset;
	});

	it('returns null when __kustoControlCommands is empty', () => {
		// By default, window.__kustoControlCommandEntries was not set before module load,
		// so __kustoControlCommands is empty. Verify the function handles this.
		const model = makeModel('.show tables');
		const result = __kustoGetControlCommandHoverAt(model, new MockPosition(1, 3));
		// With empty command index, should return null
		expect(result).toBeNull();
	});

	it('returns null for non-dot-prefixed text', () => {
		const model = makeModel('Events | where x > 5');
		const result = __kustoGetControlCommandHoverAt(model, new MockPosition(1, 3));
		expect(result).toBeNull();
	});

	it('returns null for empty model', () => {
		const model = makeModel('');
		const result = __kustoGetControlCommandHoverAt(model, new MockPosition(1, 1));
		expect(result).toBeNull();
	});
});

// ── getSchemaFunctionDoc ──────────────────────────────────────────────────────

describe('getSchemaFunctionDoc', () => {
	const boxId = '__test_schema_box__';

	function setSchemaFunctions(fns: any[]) {
		(window as any).schemaByBoxId = { [boxId]: { functions: fns } };
	}

	afterEach(() => {
		delete (window as any).schemaByBoxId;
	});

	it('returns null when boxId is falsy', () => {
		setSchemaFunctions([{ name: 'foo', parameters: [] }]);
		expect(getSchemaFunctionDoc('', 'foo')).toBeNull();
		expect(getSchemaFunctionDoc(null, 'foo')).toBeNull();
		expect(getSchemaFunctionDoc(undefined, 'foo')).toBeNull();
	});

	it('returns null when fnName is falsy', () => {
		setSchemaFunctions([{ name: 'foo', parameters: [] }]);
		expect(getSchemaFunctionDoc(boxId, '')).toBeNull();
		expect(getSchemaFunctionDoc(boxId, null)).toBeNull();
	});

	it('returns null when schema is not loaded', () => {
		// No schemaByBoxId set
		expect(getSchemaFunctionDoc(boxId, 'foo')).toBeNull();
	});

	it('returns null when functions array is empty', () => {
		setSchemaFunctions([]);
		expect(getSchemaFunctionDoc(boxId, 'foo')).toBeNull();
	});

	it('returns null when functions is undefined', () => {
		(window as any).schemaByBoxId = { [boxId]: {} };
		expect(getSchemaFunctionDoc(boxId, 'foo')).toBeNull();
	});

	it('returns null when function name is not found', () => {
		setSchemaFunctions([{ name: 'bar', parameters: [] }]);
		expect(getSchemaFunctionDoc(boxId, 'foo')).toBeNull();
	});

	it('matches function name case-insensitively', () => {
		setSchemaFunctions([{ name: 'GetAzdEvents', parameters: [{ name: 'x', type: 'long' }] }]);
		const result = getSchemaFunctionDoc(boxId, 'getazdevents');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual(['x:long']);
	});

	it('builds args from parsed parameters with types', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [
				{ name: 'startDate', type: 'datetime' },
				{ name: 'endDate', type: 'datetime' },
				{ name: 'flag', type: 'bool' },
			],
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual(['startDate:datetime', 'endDate:datetime', 'flag:bool']);
	});

	it('builds args from parameters without types', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [{ name: 'x' }, { name: 'y' }],
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual(['x', 'y']);
	});

	it('builds args with default values', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [{ name: 'x', type: 'long', defaultValue: '10' }],
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual(['x:long=10']);
	});

	it('handles tabular parameters with column definitions', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [{ name: 'T', type: '(col1:string, col2:int)' }],
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual(['T:(col1:string, col2:int)']);
	});

	it('falls back to parametersText when parameters array is empty', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [],
			parametersText: '(x:long, y:string)',
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual(['x:long', 'y:string']);
	});

	it('falls back to parametersText when parameters is undefined', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parametersText: '(a:real)',
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual(['a:real']);
	});

	it('returns empty args for function with no parameters', () => {
		setSchemaFunctions([{ name: 'noArgs' }]);
		const result = getSchemaFunctionDoc(boxId, 'noargs');
		expect(result).toBeTruthy();
		expect(result!.args).toEqual([]);
	});

	it('uses docString for description', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [],
			docString: 'Returns events for a given date range.',
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.description).toBe('Returns events for a given date range.');
	});

	it('falls back to body preview when docString is missing', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [],
			body: 'T | where Time > ago(1d) | summarize count()',
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.description).toContain('T | where Time > ago(1d)');
	});

	it('truncates long body previews', () => {
		const longBody = 'T | where x > 0 | '.repeat(20);
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [],
			body: longBody,
		}]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		// Body preview should be capped — description wraps in backticks plus ellipsis
		expect(result!.description.length).toBeLessThan(200);
		expect(result!.description).toContain('\u2026'); // ellipsis
	});

	it('returns empty description when both docString and body are missing', () => {
		setSchemaFunctions([{ name: 'myFunc', parameters: [] }]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		expect(result!.description).toBe('');
	});

	it('does not include returnType in result', () => {
		setSchemaFunctions([{ name: 'myFunc', parameters: [] }]);
		const result = getSchemaFunctionDoc(boxId, 'myfunc');
		expect(result).toBeTruthy();
		// Omit returnType since schema doesn't distinguish scalar vs tabular
		expect(result!).not.toHaveProperty('returnType');
	});
});

// ── _abbreviateType ───────────────────────────────────────────────────────────

describe('_abbreviateType', () => {
	it('abbreviates .NET System types', () => {
		expect(_abbreviateType('System.String')).toBe('string');
		expect(_abbreviateType('System.DateTime')).toBe('datetime');
		expect(_abbreviateType('System.Int64')).toBe('long');
		expect(_abbreviateType('System.Int32')).toBe('int');
		expect(_abbreviateType('System.Double')).toBe('real');
		expect(_abbreviateType('System.Boolean')).toBe('bool');
		expect(_abbreviateType('System.TimeSpan')).toBe('timespan');
		expect(_abbreviateType('System.Guid')).toBe('guid');
		expect(_abbreviateType('System.Object')).toBe('dynamic');
		expect(_abbreviateType('System.SByte')).toBe('bool');
		expect(_abbreviateType('System.Decimal')).toBe('decimal');
	});

	it('passes through short KQL types unchanged', () => {
		expect(_abbreviateType('string')).toBe('string');
		expect(_abbreviateType('datetime')).toBe('datetime');
		expect(_abbreviateType('long')).toBe('long');
		expect(_abbreviateType('real')).toBe('real');
		expect(_abbreviateType('bool')).toBe('bool');
		expect(_abbreviateType('dynamic')).toBe('dynamic');
		expect(_abbreviateType('guid')).toBe('guid');
		expect(_abbreviateType('int')).toBe('int');
		expect(_abbreviateType('timespan')).toBe('timespan');
		expect(_abbreviateType('decimal')).toBe('decimal');
	});

	it('is case-insensitive', () => {
		expect(_abbreviateType('system.string')).toBe('string');
		expect(_abbreviateType('SYSTEM.INT64')).toBe('long');
		expect(_abbreviateType('String')).toBe('string');
	});

	it('returns ? for empty or falsy input', () => {
		expect(_abbreviateType('')).toBe('?');
		expect(_abbreviateType(null)).toBe('?');
		expect(_abbreviateType(undefined)).toBe('?');
	});

	it('passes through unknown types as-is', () => {
		expect(_abbreviateType('custom_type')).toBe('custom_type');
		expect(_abbreviateType('MyEnum')).toBe('MyEnum');
	});
});

// ── getSchemaTableDoc ─────────────────────────────────────────────────────────

describe('getSchemaTableDoc', () => {
	const boxId = '__test_table_doc_box__';

	function setSchema(schema: any) {
		(window as any).schemaByBoxId = { [boxId]: schema };
	}

	afterEach(() => {
		delete (window as any).schemaByBoxId;
	});

	it('returns null when boxId is falsy', () => {
		setSchema({ tables: ['T'], columnTypesByTable: { T: {} } });
		expect(getSchemaTableDoc('', 'T')).toBeNull();
		expect(getSchemaTableDoc(null, 'T')).toBeNull();
		expect(getSchemaTableDoc(undefined, 'T')).toBeNull();
	});

	it('returns null when name is falsy', () => {
		setSchema({ tables: ['T'], columnTypesByTable: { T: {} } });
		expect(getSchemaTableDoc(boxId, '')).toBeNull();
		expect(getSchemaTableDoc(boxId, null)).toBeNull();
	});

	it('returns null when schema is not loaded', () => {
		expect(getSchemaTableDoc(boxId, 'T')).toBeNull();
	});

	it('returns null when tables array is empty', () => {
		setSchema({ tables: [], columnTypesByTable: {} });
		expect(getSchemaTableDoc(boxId, 'T')).toBeNull();
	});

	it('returns null when table not found', () => {
		setSchema({ tables: ['StormEvents'], columnTypesByTable: { StormEvents: {} } });
		expect(getSchemaTableDoc(boxId, 'Unknown')).toBeNull();
	});

	it('matches table name case-insensitively', () => {
		setSchema({ tables: ['StormEvents'], columnTypesByTable: { StormEvents: { StartTime: 'datetime' } } });
		const result = getSchemaTableDoc(boxId, 'stormevents');
		expect(result).toBeTruthy();
		expect(result!.name).toBe('StormEvents');
	});

	it('preserves original-case name in result', () => {
		setSchema({ tables: ['MyTable'], columnTypesByTable: { MyTable: {} } });
		const result = getSchemaTableDoc(boxId, 'mytable');
		expect(result).toBeTruthy();
		expect(result!.name).toBe('MyTable');
	});

	it('builds column summary from columnTypesByTable', () => {
		setSchema({
			tables: ['T'],
			columnTypesByTable: { T: { Id: 'long', Name: 'string', Timestamp: 'datetime' } },
		});
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.columnSummary).toContain('Id `long`');
		expect(result!.columnSummary).toContain('Name `string`');
		expect(result!.columnSummary).toContain('Timestamp `datetime`');
	});

	it('uses \u00b7 separators between columns on a single line', () => {
		setSchema({
			tables: ['T'],
			columnTypesByTable: { T: { A: 'string', B: 'long' } },
		});
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		// Single line, no newlines
		expect(result!.columnSummary).not.toContain('\n');
		expect(result!.columnSummary).toContain('\u00b7');
		expect(result!.columnSummary).toBe('A `string` \u00b7 B `long`');
	});

	it('abbreviates .NET types in column summary', () => {
		setSchema({
			tables: ['T'],
			columnTypesByTable: {
				T: { UserType: 'System.String', Day: 'System.DateTime', Users: 'System.Int64' },
			},
		});
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.columnSummary).toContain('UserType `string`');
		expect(result!.columnSummary).toContain('Day `datetime`');
		expect(result!.columnSummary).toContain('Users `long`');
		// Should NOT contain the .NET form
		expect(result!.columnSummary).not.toContain('System.');
	});

	it('shows all columns without truncation', () => {
		const cols: Record<string, string> = {};
		for (let i = 1; i <= 20; i++) cols[`Col${i}`] = 'string';
		setSchema({ tables: ['T'], columnTypesByTable: { T: cols } });
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		// All 20 columns should be present, no truncation
		expect(result!.columnSummary).toContain('Col1 `string`');
		expect(result!.columnSummary).toContain('Col20 `string`');
		expect(result!.columnSummary).not.toContain('\u2026');
	});

	it('returns empty columnSummary when no columns', () => {
		setSchema({ tables: ['T'], columnTypesByTable: { T: {} } });
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.columnSummary).toBe('');
	});

	it('returns empty columnSummary when columnTypesByTable missing for table', () => {
		setSchema({ tables: ['T'], columnTypesByTable: {} });
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.columnSummary).toBe('');
	});

	it('uses tableDocStrings for description', () => {
		setSchema({
			tables: ['T'],
			columnTypesByTable: { T: {} },
			tableDocStrings: { T: 'Storm event records from NOAA.' },
		});
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.description).toBe('Storm event records from NOAA.');
	});

	it('returns empty description when tableDocStrings missing', () => {
		setSchema({ tables: ['T'], columnTypesByTable: { T: {} } });
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.description).toBe('');
	});

	it('returns empty description when table has no docstring entry', () => {
		setSchema({
			tables: ['T'],
			columnTypesByTable: { T: {} },
			tableDocStrings: { Other: 'docs' },
		});
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.description).toBe('');
	});

	it('uses ? for columns with missing type', () => {
		setSchema({
			tables: ['T'],
			columnTypesByTable: { T: { Col1: '', Col2: 'string' } },
		});
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.columnSummary).toContain('Col1 `?`');
		expect(result!.columnSummary).toContain('Col2 `string`');
	});

	it('finds table from cross-database schema via schemaByConnDb', () => {
		// Primary schema has no match, but a cross-db schema does
		(window as any).schemaByBoxId = { [boxId]: { tables: ['LocalT'], columnTypesByTable: { LocalT: {} } } };
		(window as any).schemaByConnDb = {
			'conn|otherDb': {
				tables: ['RemoteTable'],
				columnTypesByTable: { RemoteTable: { X: 'long' } },
				tableDocStrings: { RemoteTable: 'From another database.' },
			},
		};
		const result = getSchemaTableDoc(boxId, 'remotetable');
		expect(result).toBeTruthy();
		expect(result!.name).toBe('RemoteTable');
		expect(result!.columnSummary).toContain('X `long`');
		expect(result!.description).toBe('From another database.');
	});

	it('prefers primary schema over cross-database for same table name', () => {
		(window as any).schemaByBoxId = { [boxId]: {
			tables: ['T'],
			columnTypesByTable: { T: { A: 'string' } },
			tableDocStrings: { T: 'Primary.' },
		} };
		(window as any).schemaByConnDb = {
			'conn|otherDb': {
				tables: ['T'],
				columnTypesByTable: { T: { B: 'long' } },
				tableDocStrings: { T: 'Cross-db.' },
			},
		};
		const result = getSchemaTableDoc(boxId, 't');
		expect(result).toBeTruthy();
		expect(result!.description).toBe('Primary.');
		expect(result!.columnSummary).toContain('A `string`');
	});
});

// ── getHoverInfoAt — schema tables integration ────────────────────────────────

describe('getHoverInfoAt — schema tables', () => {
	const boxId = '__test_hover_table_box__';

	function setSchema(schema: any) {
		(window as any).schemaByBoxId = { [boxId]: schema };
	}

	afterEach(() => {
		delete (window as any).schemaByBoxId;
	});

	it('shows table hover with docstring', () => {
		setSchema({
			tables: ['StormEvents'],
			columnTypesByTable: { StormEvents: { StartTime: 'datetime', State: 'string' } },
			tableDocStrings: { StormEvents: 'Storm event records.' },
		});
		const model = makeModel('StormEvents | where State == "TX"');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 5 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('StormEvents');
		expect(result!.markdown).toContain('StartTime `datetime`');
		expect(result!.markdown).toContain('Storm event records.');
	});

	it('shows table hover with columns but no docstring', () => {
		setSchema({
			tables: ['T'],
			columnTypesByTable: { T: { Id: 'long', Name: 'string' } },
		});
		const model = makeModel('T | take 10');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 1 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('Id `long`');
		expect(result!.markdown).toContain('Name `string`');
	});

	it('built-in function name takes precedence over table name', () => {
		setSchema({
			tables: ['count'],
			columnTypesByTable: { count: { x: 'long' } },
			tableDocStrings: { count: 'Should not show.' },
		});
		const model = makeModel('count');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 3 }, boxId);
		expect(result).toBeTruthy();
		// Built-in function 'count' docs should win
		expect(result!.markdown).not.toContain('Should not show.');
	});

	it('schema function takes precedence over table with same name', () => {
		setSchema({
			tables: ['GetEvents'],
			columnTypesByTable: { GetEvents: { x: 'long' } },
			tableDocStrings: { GetEvents: 'Table doc.' },
			functions: [{ name: 'GetEvents', parameters: [{ name: 'x' }], docString: 'Function doc.' }],
		});
		const model = makeModel('GetEvents');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 3 }, boxId);
		expect(result).toBeTruthy();
		// Schema function should win over table
		expect(result!.markdown).toContain('Function doc.');
		expect(result!.markdown).not.toContain('Table doc.');
	});

	it('table doc wins over keyword when table exists in schema', () => {
		setSchema({
			tables: ['where'],
			columnTypesByTable: { where: { x: 'long' } },
			tableDocStrings: { where: 'A table named where.' },
		});
		const model = makeModel('where');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 3 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('A table named where.');
	});

	it('returns null for table token without boxId', () => {
		setSchema({
			tables: ['StormEvents'],
			columnTypesByTable: { StormEvents: {} },
		});
		const model = makeModel('StormEvents');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 5 }, undefined);
		expect(result).toBeNull();
	});

	it('falls through to pipe operator context when no table match', () => {
		setSchema({
			tables: ['StormEvents'],
			columnTypesByTable: { StormEvents: {} },
		});
		const model = makeModel('StormEvents\n| where SomeCol > 5');
		// Cursor on 'SomeCol' — not a table, function, or keyword
		const result = getHoverInfoAt(model, { lineNumber: 2, column: 12 }, boxId);
		expect(result).toBeTruthy();
		// Should fall through to pipe operator context and show 'where' docs
		expect(result!.markdown).toContain('where');
	});
});

// ── getHoverInfoAt — schema function integration ──────────────────────────────

describe('getHoverInfoAt — schema functions', () => {
	const boxId = '__test_hover_schema_box__';

	function setSchemaFunctions(fns: any[]) {
		(window as any).schemaByBoxId = { [boxId]: { functions: fns } };
	}

	afterEach(() => {
		delete (window as any).schemaByBoxId;
	});

	it('shows schema function hover when cursor is on function name', () => {
		setSchemaFunctions([{
			name: 'getAzdEvents',
			parameters: [
				{ name: 'startDate', type: 'datetime' },
				{ name: 'endDate', type: 'datetime' },
			],
			docString: 'Get Azure Developer CLI events.',
		}]);
		const model = makeModel('getAzdEvents(x, y)');
		// Cursor on function name
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 5 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('getazdevents');
		expect(result!.markdown).toContain('startDate:datetime');
	});

	it('shows active-arg tracking for schema functions inside parens', () => {
		setSchemaFunctions([{
			name: 'getAzdEvents',
			parameters: [
				{ name: 'startDate', type: 'datetime' },
				{ name: 'endDate', type: 'datetime' },
				{ name: 'flag', type: 'bool' },
			],
		}]);
		const model = makeModel('getAzdEvents(x, y, z)');
		// Cursor on second arg 'y'
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 17 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('**endDate:datetime**');
	});

	it('shows first arg bolded when cursor is in first arg position', () => {
		setSchemaFunctions([{
			name: 'getAzdEvents',
			parameters: [
				{ name: 'startDate', type: 'datetime' },
				{ name: 'endDate', type: 'datetime' },
			],
		}]);
		const model = makeModel('getAzdEvents(x, y)');
		// Cursor on first arg 'x'
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 15 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('**startDate:datetime**');
	});

	it('built-in function takes precedence over schema function with same name', () => {
		setSchemaFunctions([{
			name: 'dcount',
			parameters: [{ name: 'overridden' }],
			docString: 'Should not appear.',
		}]);
		const model = makeModel('dcount(x)');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 3 }, boxId);
		expect(result).toBeTruthy();
		// Should show built-in dcount docs, not schema override
		expect(result!.markdown).not.toContain('overridden');
		expect(result!.markdown).not.toContain('Should not appear');
	});

	it('returns null for unknown function when no schema loaded', () => {
		const model = makeModel('myCustomFunc(x)');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 5 }, boxId);
		// No schema loaded, no built-in match  — pipe-operator fallback or null
		// The function name isn't a pipe operator, so should be null
		expect(result).toBeNull();
	});

	it('schema function hover works without boxId (falls through)', () => {
		setSchemaFunctions([{
			name: 'getAzdEvents',
			parameters: [{ name: 'x' }],
		}]);
		const model = makeModel('getAzdEvents(x)');
		// No boxId — should not crash, should fall through to pipe-operator or null
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 5 }, undefined);
		expect(result).toBeNull();
	});

	it('shows schema function docs in pipe context', () => {
		setSchemaFunctions([{
			name: 'getAzdEvents',
			parameters: [
				{ name: 'startDate', type: 'datetime' },
				{ name: 'endDate', type: 'datetime' },
			],
			docString: 'Get events.',
		}]);
		const model = makeModel('let x = getAzdEvents(a, b)');
		// Cursor inside parens on first arg
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 22 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('getazdevents');
		expect(result!.markdown).toContain('**startDate:datetime**');
		expect(result!.markdown).toContain('Get events.');
	});

	it('shows description from docString in hover', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [],
			docString: 'Custom function docs here.',
		}]);
		const model = makeModel('myFunc()');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 3 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('Custom function docs here.');
	});

	it('shows body preview when docString is absent', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [],
			body: 'Events | take 10',
		}]);
		const model = makeModel('myFunc()');
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 3 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('Events | take 10');
	});

	it('clamps active-arg index to last parameter for excess args', () => {
		setSchemaFunctions([{
			name: 'myFunc',
			parameters: [{ name: 'a', type: 'long' }],
		}]);
		const model = makeModel('myFunc(x, y, z)');
		// Cursor on third arg — function only has 1 param, should clamp to last (index 0)
		const result = getHoverInfoAt(model, { lineNumber: 1, column: 14 }, boxId);
		expect(result).toBeTruthy();
		expect(result!.markdown).toContain('**a:long**');
	});
});
