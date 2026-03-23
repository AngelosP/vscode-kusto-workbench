import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { extractConstAssignment } from './helpers/vm-extract';

suite('KQL completions - column inference', () => {
	const createCompute = () => {
		// When compiled, this test runs from `out/tests/integration`, so repo root is three levels up.
		const repoRoot = path.resolve(__dirname, '..', '..', '..');
		const monacoCompletionsPath = path.join(repoRoot, 'src', 'webview', 'monaco', 'completions.ts');
		let monacoSource = fs.readFileSync(monacoCompletionsPath, 'utf8');
		// Strip TypeScript annotations so the source can run in a JS VM sandbox
		monacoSource = monacoSource
			.replace(/:\s*Record<[^>]+>/g, '')
			.replace(/:\s*any\b(\[\])?/g, '')
			.replace(/\(\w+ as any\)/g, (m) => m.slice(1, m.indexOf(' ')))
			.replace(/\b_win\./g, 'window.')
			.replace(/as HTMLElement\)/g, ')')
			.replace(/ as string\b/g, '')
			.replace(/ as any\b/g, '');
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
