import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * Extracts a top-level function from JavaScript source code.
 * Finds `function funcName(` and extracts the entire function body.
 */
function extractFunction(source: string, funcName: string): string {
	const needle = `function ${funcName}(`;
	const start = source.indexOf(needle);
	assert.ok(start >= 0, `Could not find '${needle}' in monaco.js`);

	// Find the first '{' after the function signature.
	const firstBrace = source.indexOf('{', start);
	assert.ok(firstBrace >= 0, `Could not find '{' for ${funcName}`);

	let i = firstBrace;
	let depth = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inSingle = false;
	let inDouble = false;
	let inTemplate = false;
	let inRegex = false;
	let inRegexCharClass = false;

	const isRegexStart = (pos: number): boolean => {
		for (let j = pos - 1; j >= 0; j--) {
			const c = source[j];
			if (c === ' ' || c === '\t' || c === '\r' || c === '\n') continue;
			return /[=({\[,:;!?&|+\-~*%<>]/.test(c);
		}
		return true;
	};

	for (; i < source.length; i++) {
		const ch = source[i];
		const next = source[i + 1];

		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i++;
			}
			continue;
		}
		if (inRegex) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (inRegexCharClass) {
				if (ch === ']') inRegexCharClass = false;
				continue;
			}
			if (ch === '[') {
				inRegexCharClass = true;
				continue;
			}
			if (ch === '/') {
				inRegex = false;
				continue;
			}
			continue;
		}
		if (inSingle) {
			if (ch === "'") {
				if (next === "'") {
					i++;
					continue;
				}
				inSingle = false;
			}
			continue;
		}
		if (inDouble) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (inTemplate) {
			if (ch === '\\') {
				i++;
				continue;
			}
			if (ch === '`') inTemplate = false;
			continue;
		}

		if (ch === '/' && next === '/') {
			inLineComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlockComment = true;
			i++;
			continue;
		}
		if (ch === '/' && next !== '/' && next !== '*') {
			if (isRegexStart(i)) {
				inRegex = true;
				inRegexCharClass = false;
				continue;
			}
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === '`') {
			inTemplate = true;
			continue;
		}

		if (ch === '{') {
			depth++;
			continue;
		}
		if (ch === '}') {
			depth--;
			if (depth === 0) {
				i++;
				break;
			}
			continue;
		}
	}

	assert.ok(depth === 0, `Unbalanced braces while extracting ${funcName}`);
	return source.slice(start, i);
}

suite('KQL prettify', () => {
	const createPrettify = () => {
		// When compiled, this test runs from `out/test`, so repo root is two levels up.
		const repoRoot = path.resolve(__dirname, '..', '..');
		const monacoPath = path.join(repoRoot, 'media', 'queryEditor', 'monaco.js');
		const monacoSource = fs.readFileSync(monacoPath, 'utf8');

		// Extract helper functions needed by __kustoPrettifyKusto
		const explodePipesFn = extractFunction(monacoSource, '__kustoExplodePipesToLines');
		const splitTopLevelFn = extractFunction(monacoSource, '__kustoSplitTopLevel');
		const findKeywordFn = extractFunction(monacoSource, '__kustoFindTopLevelKeyword');
		const prettifyWhereFn = extractFunction(monacoSource, '__kustoPrettifyWhereClause');
		const prettifyFn = extractFunction(monacoSource, '__kustoPrettifyKusto');

		const sandbox: any = {
			exports: {},
			console,
		};

		// Combine all functions and export the prettify function
		const combinedSrc = `
			${explodePipesFn}
			${splitTopLevelFn}
			${findKeywordFn}
			${prettifyWhereFn}
			${prettifyFn}
			exports.__kustoPrettifyKusto = __kustoPrettifyKusto;
		`;

		vm.runInNewContext(combinedSrc, sandbox, { filename: 'monaco.extract.js' });
		const prettify = sandbox.exports.__kustoPrettifyKusto as (input: string) => string;
		assert.ok(typeof prettify === 'function', 'Expected extracted prettify function');
		return prettify;
	};

	test('preserves commas between aggregation fields in summarize clause', () => {
		const prettify = createPrettify();

		// This is the bug scenario - multiline summarize with multiple aggregations
		// The comma between aggregation fields was being dropped
		const input = [
			'| summarize',
			'    TotalCount = count(),',
			'    AvgValue = avg(Value)',
			'    by',
			'    Group1,',
			'    Group2'
		].join('\n');

		const result = prettify(input);
		const lines = result.split('\n');

		// Find the aggregation lines (after "| summarize" but before "    by")
		const summarizeIdx = lines.findIndex(l => l.trim() === '| summarize');
		assert.ok(summarizeIdx >= 0, 'Expected to find "| summarize" line');

		const byIdx = lines.findIndex((l, i) => i > summarizeIdx && l.trim() === 'by');
		assert.ok(byIdx >= 0, `Expected to find "by" line in:\n${result}`);

		// The aggregation lines are between summarizeIdx and byIdx
		const aggLines = lines.slice(summarizeIdx + 1, byIdx);
		assert.ok(aggLines.length >= 2, `Expected at least 2 aggregation lines, got: ${aggLines.length}\nFull output:\n${result}`);

		// All but the last aggregation line should end with a comma
		for (let i = 0; i < aggLines.length - 1; i++) {
			const line = aggLines[i].trimEnd();
			assert.ok(
				line.endsWith(','),
				`Expected aggregation line ${i + 1} to end with comma, got: "${line}"\nFull output:\n${result}`
			);
		}
		// Last aggregation line should NOT end with comma
		const lastAgg = aggLines[aggLines.length - 1].trimEnd();
		assert.ok(
			!lastAgg.endsWith(','),
			`Expected last aggregation line to NOT end with comma, got: "${lastAgg}"`
		);
	});

	test('preserves commas between by fields in summarize clause', () => {
		const prettify = createPrettify();

		const input = 'SampleEvents | summarize count() by Group1, Group2';
		const result = prettify(input);

		// The by clause fields should have commas
		assert.ok(result.includes('Group1,'), `Expected Group1 with trailing comma in: ${result}`);
	});

	test('formats simple summarize without commas on single aggregation', () => {
		const prettify = createPrettify();

		const input = 'SampleEvents | summarize count() by Group1';
		const result = prettify(input);

		// Single aggregation should not have trailing comma
		const lines = result.split('\n');
		const countLine = lines.find(l => l.includes('count()'));
		assert.ok(countLine, 'Expected to find count() line');
		assert.ok(!countLine.trimEnd().endsWith(','), 'Single aggregation should not end with comma');
	});

	test('formats multiple aggregations with commas', () => {
		const prettify = createPrettify();

		const input = 'SampleEvents | summarize cnt = count(), avg_val = avg(Value), total = sum(Amount) by Category';
		const result = prettify(input);

		// Multiple aggregations - check commas are preserved
		assert.ok(result.includes('cnt = count(),') || result.includes('count(),'),
			`Expected count() with trailing comma in: ${result}`);
		assert.ok(result.includes('avg_val = avg(Value),') || result.includes('avg(Value),'),
			`Expected avg(Value) with trailing comma in: ${result}`);
	});
});
