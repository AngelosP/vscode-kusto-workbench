import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function extractConstAssignment(source: string, constName: string): string {
	const needle = `const ${constName} =`;
	const start = source.indexOf(needle);
	assert.ok(start >= 0, `Could not find '${needle}' in monaco.js`);

	// Find the first '{' after the arrow '=>', then scan to the matching '}' and include the trailing ';'.
	const arrowIdx = source.indexOf('=>', start);
	assert.ok(arrowIdx >= 0, `Could not find '=>' for ${constName}`);

	const firstBrace = source.indexOf('{', arrowIdx);
	assert.ok(firstBrace >= 0, `Could not find '{' for ${constName}`);

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
		// Heuristic: a '/' can start a regex literal when it appears after an operator/delimiter.
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

	assert.ok(depth === 0, `Unbalanced braces while extracting ${constName}`);

	// Capture until the semicolon terminating the const assignment.
	const endSemi = source.indexOf(';', i);
	assert.ok(endSemi >= 0, `Could not find terminating ';' for ${constName}`);
	return source.slice(start, endSemi + 1);
}

suite('KQL completions - column inference', () => {
	const createCompute = () => {
		// When compiled, this test runs from `out/test`, so repo root is two levels up.
		const repoRoot = path.resolve(__dirname, '..', '..');
		const monacoPath = path.join(repoRoot, 'media', 'queryEditor', 'monaco.js');
		const monacoSource = fs.readFileSync(monacoPath, 'utf8');
		const fnSrc = extractConstAssignment(monacoSource, '__kustoComputeAvailableColumnsAtOffset');

		const sandbox: any = {
			exports: {},
			console,
			schema: {
				tables: ['TableA', 'TableB'],
				__columnsByTable: {
					TableA: ['DevDeviceId', 'ToolCount', 'OtherCol'],
					TableB: ['DevDeviceId', 'RightCol']
				}
			},
			__kustoGetColumnsByTable: (sch: any) => sch && sch.__columnsByTable ? sch.__columnsByTable : null,
			__kustoSplitCommaList: (s: string) => {
				if (!s) return [];
				return String(s)
					.split(',')
					.map(x => x.trim())
					.filter(Boolean);
			},
			__kustoEnsureSchemaForClusterDb: async () => null,
			__kustoParseFullyQualifiedTableExpr: () => null,
			__kustoSplitTopLevelStatements: (text: string) => {
				// Simplified splitter for these test cases.
				const raw = String(text || '');
				return raw
					.split(';')
					.map((t) => ({ startOffset: 0, text: t }))
					.filter(s => String(s.text || '').trim().length > 0);
			},
			__kustoSplitPipelineStagesDeep: (text: string) => String(text || '').split('|'),
			__kustoGetStatementStartAtOffset: (text: string, offset: number) => {
				const s = String(text || '');
				const idx = s.lastIndexOf(';', Math.max(0, offset - 1));
				return idx >= 0 ? idx + 1 : 0;
			},
			inferActiveTable: (text: string) => {
				const t = String(text || '').trim();
				if (/^let\s+/i.test(t)) return null;
				const m = t.match(/^([A-Za-z_][\w-]*)\b/);
				return m && m[1] ? m[1] : null;
			},
			__kustoFindSchemaTableName: (name: string) => {
				const lower = String(name || '').toLowerCase();
				if (lower === 'tablea') return 'TableA';
				if (lower === 'tableb') return 'TableB';
				return null;
			}
		};

		const exportedFnSrc = fnSrc.replace(
			/const\s+__kustoComputeAvailableColumnsAtOffset\s*=\s*/,
			'exports.__kustoComputeAvailableColumnsAtOffset = '
		);
		vm.runInNewContext(exportedFnSrc, sandbox, { filename: 'monaco.extract.js' });
		const compute = sandbox.exports.__kustoComputeAvailableColumnsAtOffset as (fullText: string, offset: number) => Promise<string[] | null>;
		assert.ok(typeof compute === 'function', 'Expected extracted compute function');
		return compute;
	};

	test('autocomplete after semicolon uses let summarize output columns', async () => {
		const compute = createCompute();
		const text = [
			"let data = TableA | take 10 | summarize TotalCalls = sum(ToolCount) by DevDeviceId;",
			"data | where "
		].join('\n');
		const cols = await compute(text, text.length);
		assert.ok(Array.isArray(cols), 'Expected a column list');
		assert.ok(cols.includes('DevDeviceId'), 'Expected group-by key column');
		assert.ok(cols.includes('TotalCalls'), 'Expected aggregate output column');
		assert.ok(!cols.includes('ToolCount'), 'Did not expect base-table-only column after summarize');
	});

	test('let extend adds columns for completions', async () => {
		const compute = createCompute();
		const text = [
			"let data = TableA | extend NewMetric = ToolCount * 2;",
			"data | where "
		].join('\n');
		const cols = await compute(text, text.length);
		assert.ok(cols && cols.includes('NewMetric'), 'Expected extended column');
		assert.ok(cols && cols.includes('ToolCount'), 'Expected original column still present');
	});

	test('let project-rename renames columns for completions', async () => {
		const compute = createCompute();
		const text = [
			"let data = TableA | project-rename RenamedToolCount = ToolCount;",
			"data | where "
		].join('\n');
		const cols = await compute(text, text.length);
		assert.ok(cols && cols.includes('RenamedToolCount'), 'Expected renamed column');
		assert.ok(cols && !cols.includes('ToolCount'), 'Did not expect old column name');
	});

	test('let project-away removes columns for completions', async () => {
		const compute = createCompute();
		const text = [
			"let data = TableA | project-away ToolCount;",
			"data | where "
		].join('\n');
		const cols = await compute(text, text.length);
		assert.ok(cols && !cols.includes('ToolCount'), 'Expected project-away to remove column');
		assert.ok(cols && cols.includes('DevDeviceId'), 'Expected other columns still present');
	});

	test('let project-keep keeps only specified columns for completions', async () => {
		const compute = createCompute();
		const text = [
			"let data = TableA | project-keep DevDeviceId;",
			"data | where "
		].join('\n');
		const cols = await compute(text, text.length);
		assert.ok(cols && cols.includes('DevDeviceId'), 'Expected kept column');
		assert.ok(cols && cols.length === 1, 'Expected only kept column');
	});

	test('let count returns Count column for completions', async () => {
		const compute = createCompute();
		const text = [
			"let data = TableA | count;",
			"data | where "
		].join('\n');
		const cols = await compute(text, text.length);
		assert.ok(cols && cols.includes('Count'), 'Expected Count column');
		assert.ok(cols && cols.length === 1, 'Expected only Count column');
	});

	test('let union unions columns across sources for completions', async () => {
		const compute = createCompute();
		const text = [
			"let data = TableA | union TableB;",
			"data | where "
		].join('\n');
		const cols = await compute(text, text.length);
		assert.ok(cols && cols.includes('ToolCount'), 'Expected TableA column');
		assert.ok(cols && cols.includes('RightCol'), 'Expected TableB column');
	});
});
