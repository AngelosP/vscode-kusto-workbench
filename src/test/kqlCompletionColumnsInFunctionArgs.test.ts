import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function extractConstObjectAssignment(source: string, constName: string): string {
	const needle = `const ${constName} =`;
	const start = source.indexOf(needle);
	assert.ok(start >= 0, `Could not find '${needle}' in monaco.js`);

	const eqIdx = source.indexOf('=', start);
	assert.ok(eqIdx >= 0, `Could not find '=' for ${constName}`);

	const firstBrace = source.indexOf('{', eqIdx);
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

	const endSemi = source.indexOf(';', i);
	assert.ok(endSemi >= 0, `Could not find terminating ';' for ${constName}`);
	return source.slice(start, endSemi + 1);
}

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
		const repoRoot = path.resolve(__dirname, '..', '..');
		const monacoPath = path.join(repoRoot, 'media', 'queryEditor', 'monaco.js');
		const monacoSource = fs.readFileSync(monacoPath, 'utf8');
		const providerSrc = extractConstObjectAssignment(monacoSource, '__kustoCompletionProvider');

		const sandbox: any = {
			exports: {},
			console,
			window: {},

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
