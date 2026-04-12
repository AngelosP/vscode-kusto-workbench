import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { extractConstObjectAssignment } from './helpers/vm-extract';

type MonacoPosition = { lineNumber: number; column: number };

class FakeRange {
	constructor(
		public startLineNumber: number,
		public startColumn: number,
		public endLineNumber: number,
		public endColumn: number
	) {}
}

class FakeModel {
	public uri: { toString(): string };
	private lines: string[];
	private text: string;

	constructor(text: string) {
		this.text = text;
		this.lines = text.split(/\r?\n/);
		this.uri = { toString: () => 'inmemory://model/columns-fnargs' };
	}

	getValue(): string {
		return this.text;
	}

	getLineContent(lineNumber: number): string {
		return this.lines[lineNumber - 1] ?? '';
	}

	getWordUntilPosition(position: MonacoPosition): { word: string; startColumn: number; endColumn: number } {
		const line = this.getLineContent(position.lineNumber);
		const idx0 = Math.max(0, position.column - 1);
		let start = idx0;
		while (start > 0 && /[A-Za-z0-9_\-]/.test(line[start - 1])) start--;
		let end = idx0;
		while (end < line.length && /[A-Za-z0-9_\-]/.test(line[end])) end++;
		return { word: line.slice(start, end), startColumn: start + 1, endColumn: end + 1 };
	}

	getValueInRange(range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): string {
		const off = this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
		return this.text.slice(0, off);
	}

	getOffsetAt(position: MonacoPosition): number {
		const ln = Math.max(1, position.lineNumber);
		const col = Math.max(1, position.column);
		let offset = 0;
		for (let i = 1; i < ln; i++) {
			offset += (this.lines[i - 1]?.length ?? 0) + 1;
		}
		offset += col - 1;
		return offset;
	}
}

suite('KQL completions - columns inside function args', () => {
	const createCompletionProvider = () => {
		const repoRoot = path.resolve(__dirname, '..', '..', '..');
		const monacoPath = path.join(repoRoot, 'src', 'webview', 'monaco', 'completions.ts');
		let monacoSource = fs.readFileSync(monacoPath, 'utf8');
		// Strip TypeScript annotations so the source can run in a JS VM sandbox
		monacoSource = monacoSource
			.replace(/:\s*Record<[^>]+>/g, '')
			.replace(/:\s*(?:any|string|number|boolean)\b(\[\])?/g, '')
			.replace(/\(\w+ as any\)/g, (m) => m.slice(1, m.indexOf(' ')))
			.replace(/\b_win\./g, 'window.')
			.replace(/as HTMLElement\)/g, ')')
			.replace(/ as string\b/g, '')
			.replace(/ as any\b/g, '');
		const providerSrc = extractConstObjectAssignment(monacoSource, '__kustoCompletionProvider');

		const sandbox: any = {
			exports: {},
			console,
			window: null, // will be set to sandbox itself below

			queryEditorBoxByModelUri: {},
			activeQueryEditorBoxId: 'box1',
			schemaByBoxId: {
				box1: {
					tables: ['RawEventsVSCodeExt'],
					__columnsByTable: {
						RawEventsVSCodeExt: ['ServerTimestamp', 'ServerRegion', 'ExtensionName', 'EventName', 'VSCodeMachineId']
					}
				}
			},
			ensureSchemaForBox: () => undefined,
			connections: [],

			__kustoControlCommands: [],
			__kustoTryGetDotCommandCompletionContext: () => null,
			__kustoGetStatementStartAtOffset: (text: string, offset: number) => {
				const s = String(text || '');
				const idx = s.lastIndexOf(';', Math.max(0, offset - 1));
				return idx >= 0 ? idx + 1 : 0;
			},
			__kustoScanIdentifiers: () => [],
			findEnclosingFunctionCall: () => ({ name: 'startofday', openParenOffset: 0 }),
			getTokenAtPosition: () => null,

			// Column inference used by the completion provider.
			__kustoComputeAvailableColumnsAtOffset: async () => ['ServerTimestamp', 'ServerRegion', 'ExtensionName', 'EventName', 'VSCodeMachineId'],

			// Minimal helpers used when schema is present.
			__kustoGetColumnsByTable: (sch: any) => sch && sch.__columnsByTable ? sch.__columnsByTable : null,
			__kustoSplitCommaList: (s: string) => String(s || '').split(',').map(x => x.trim()).filter(Boolean),
			__kustoEnsureSchemaForClusterDb: async () => null,
			__kustoParseFullyQualifiedTableExpr: () => null,
			__kustoSplitTopLevelStatements: (text: string) => {
				const raw = String(text || '');
				return raw
					.split(';')
					.map((t) => ({ startOffset: 0, text: t }))
					.filter(s => String(s.text || '').trim().length > 0);
			},
			__kustoSplitPipelineStagesDeep: (text: string) => String(text || '').split('|'),
			inferActiveTable: (text: string) => {
				const t = String(text || '').trim();
				if (/^let\s+/i.test(t)) return null;
				const m = t.match(/^([A-Za-z_][\w-]*)\b/);
				return m && m[1] ? m[1] : null;
			},
			__kustoFindSchemaTableName: (name: string) => {
				const lower = String(name || '').toLowerCase();
				if (lower === 'raweventsvscodeext') return 'RawEventsVSCodeExt';
				return null;
			},

			KUSTO_PIPE_OPERATOR_SUGGESTIONS: [],
			KUSTO_KEYWORD_DOCS: {},
			KUSTO_FUNCTION_DOCS: {},

			monaco: {
				Range: FakeRange,
				languages: {
					CompletionItemKind: {
						Keyword: 1,
						Variable: 2,
						Function: 3,
						Field: 4,
						Class: 5
					},
					CompletionItemInsertTextRule: {
						InsertAsSnippet: 4
					}
				}
			}
		};

		const exportedProvider = providerSrc.replace(/const\s+__kustoCompletionProvider\s*=\s*/, 'exports.__kustoCompletionProvider = ');
		sandbox.window = sandbox; // Allow window.xxx to resolve to sandbox.xxx
		vm.runInNewContext(exportedProvider, sandbox, { filename: 'monaco.completionProvider.extract.js' });

		assert.ok(sandbox.exports.__kustoCompletionProvider, 'Expected extracted __kustoCompletionProvider');
		return sandbox.exports.__kustoCompletionProvider as { provideCompletionItems: (model: any, position: any) => Promise<{ suggestions: any[] }> };
	};

	test('does not pin filterText to the currently-typed fragment', async () => {
		const provider = createCompletionProvider();

		const text = [
			'RawEventsVSCodeExt',
			'| summarize',
			'    Day = startofday(Ser'
		].join('\n');

		const model = new FakeModel(text);
		const lineNumber = 3;
		const column = model.getLineContent(lineNumber).length + 1;
		const res = await provider.provideCompletionItems(model as any, { lineNumber, column });

		const cols = (res.suggestions || []).filter((s: any) => s && s.kind === 4);
		assert.ok(cols.length > 0, 'Expected some column suggestions');

		// Regression: we must not set filterText to the currently typed fragment (e.g. "Ser"),
		// otherwise Monaco can\'t re-filter properly as the cursor moves left/right.
		for (const s of cols) {
			assert.ok(
				s.filterText === undefined || String(s.filterText) === String(s.label),
				`Expected filterText to be unset (or equal to label), got filterText=${JSON.stringify(s.filterText)} label=${JSON.stringify(s.label)}`
			);
		}
	});
});
