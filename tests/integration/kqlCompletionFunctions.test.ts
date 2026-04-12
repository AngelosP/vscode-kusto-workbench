import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { extractConstObjectAssignment, extractConstAssignmentStatement } from './helpers/vm-extract';

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
		this.uri = { toString: () => 'inmemory://model/1' };
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
		// Only used by completion provider with start at 1,1.
		const off = this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
		return this.text.slice(0, off);
	}

	getOffsetAt(position: MonacoPosition): number {
		const ln = Math.max(1, position.lineNumber);
		const col = Math.max(1, position.column);
		let offset = 0;
		for (let i = 1; i < ln; i++) {
			offset += (this.lines[i - 1]?.length ?? 0) + 1; // '\n'
		}
		offset += col - 1;
		return offset;
	}

	getPositionAt(offset: number): MonacoPosition {
		const off = Math.max(0, Math.min(this.text.length, offset));
		let running = 0;
		for (let i = 0; i < this.lines.length; i++) {
			const lineLen = this.lines[i]?.length ?? 0;
			const nextRunning = running + lineLen;
			if (off <= nextRunning) {
				return { lineNumber: i + 1, column: (off - running) + 1 };
			}
			running = nextRunning + 1; // '\n'
		}
		return { lineNumber: this.lines.length, column: (this.lines[this.lines.length - 1]?.length ?? 0) + 1 };
	}
}

suite('KQL completions - functions list', () => {
	const createCompletionProvider = () => {
		const repoRoot = path.resolve(__dirname, '..', '..', '..');
		const monacoPath = path.join(repoRoot, 'src', 'webview', 'monaco', 'caret-docs.ts');
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
		const monacoCompletionsPath = path.join(repoRoot, 'src', 'webview', 'monaco', 'completions.ts');
		let completionsSource = fs.readFileSync(monacoCompletionsPath, 'utf8');
		completionsSource = completionsSource
			.replace(/:\s*Record<[^>]+>/g, '')
			.replace(/:\s*(?:any|string|number|boolean)\b(\[\])?/g, '')
			.replace(/\(\w+ as any\)/g, (m) => m.slice(1, m.indexOf(' ')))
			.replace(/\b_win\./g, 'window.')
			.replace(/as HTMLElement\)/g, ')')
			.replace(/ as string\b/g, '')
			.replace(/ as any\b/g, '');
		const generatedFunctionsPath = path.join(repoRoot, 'src', 'webview', 'generated', 'functions.generated.js');
		const generatedFunctionsSource = fs.readFileSync(generatedFunctionsPath, 'utf8');

		const fnDocsSrc = extractConstObjectAssignment(monacoSource, 'KUSTO_FUNCTION_DOCS');
		const providerSrc = extractConstObjectAssignment(completionsSource, '__kustoCompletionProvider');

		const sandbox: any = {
			exports: {},
			console,
			window: null, // will be set to sandbox itself below
			__kustoGeneratedFunctionsMerged: false,
			setGeneratedFunctionsMerged: (v: boolean) => { sandbox.__kustoGeneratedFunctionsMerged = !!v; },

			// Stubs for the webview globals referenced by the completion provider.
			queryEditorBoxByModelUri: {},
			activeQueryEditorBoxId: null,
			schemaByBoxId: {},
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
			findEnclosingFunctionCall: () => null,
			getTokenAtPosition: () => null,

			KUSTO_PIPE_OPERATOR_SUGGESTIONS: [],
			KUSTO_KEYWORD_DOCS: {},

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

		// Populate window.__kustoFunctionEntries from the generated file.
		sandbox.window = sandbox; // Allow window.xxx to resolve to sandbox.xxx
		vm.runInNewContext(generatedFunctionsSource, sandbox, { filename: 'functions.generated.js' });

		const exportedFnDocs = fnDocsSrc.replace(/const\s+KUSTO_FUNCTION_DOCS\s*=\s*/, 'exports.KUSTO_FUNCTION_DOCS = ');
		const exportedProvider = providerSrc.replace(/const\s+__kustoCompletionProvider\s*=\s*/, 'exports.__kustoCompletionProvider = ');

		vm.runInNewContext(exportedFnDocs, sandbox, { filename: 'monaco.fnDocs.extract.js' });
		// The completion provider references `KUSTO_FUNCTION_DOCS` as a free variable.
		// Make it available as a global in the same sandbox context.
		sandbox.KUSTO_FUNCTION_DOCS = sandbox.exports.KUSTO_FUNCTION_DOCS;
		vm.runInNewContext(exportedProvider, sandbox, { filename: 'monaco.completionProvider.extract.js' });

		assert.ok(sandbox.exports.KUSTO_FUNCTION_DOCS, 'Expected extracted KUSTO_FUNCTION_DOCS');
		assert.ok(sandbox.exports.__kustoCompletionProvider, 'Expected extracted __kustoCompletionProvider');

		return sandbox.exports.__kustoCompletionProvider as { provideCompletionItems: (model: any, position: any) => Promise<{ suggestions: any[] }> };
	};

	test('includes startofday in expression completions for summarize-by assignment', async () => {
		const provider = createCompletionProvider();

		const text = [
			'RawEventsVSCodeExt',
			'| where ServerTimestamp >= ago(30d)',
			'| where ExtensionName == "GitHub.copilot-chat"',
			'| where EventName == "github.copilot-chat/response.success"',
			'| summarize',
			'    GenTPS = sum(todouble(Measures.tokencount)),',
			'    RPS = count(),',
			'    Users = dcount(VSCodeMachineId)',
			'    by',
			'    Day = st'
		].join('\n');

		const model = new FakeModel(text);
		const lineNumber = 10;
		const column = model.getLineContent(lineNumber).length + 1;
		const res = await provider.provideCompletionItems(model as any, { lineNumber, column });

		const labelsLower = (res.suggestions || [])
			.map((s: any) => String(s && s.label ? s.label : ''))
			.filter(Boolean)
			.map((s: string) => s.toLowerCase());

		// Sanity: we do have some function suggestions.
		assert.ok(labelsLower.includes('strcat'), 'Expected strcat to appear in function completions');

		// Regression: this is currently missing, but should be present.
		assert.ok(labelsLower.includes('startofday'), 'Expected startofday to appear in function completions');
	});

	test('Smart Docs hover resolves generated built-in function docs (row_number) without autocomplete', async () => {
		const repoRoot = path.resolve(__dirname, '..', '..', '..');
		const monacoPath = path.join(repoRoot, 'src', 'webview', 'monaco', 'caret-docs.ts');
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
		const generatedFunctionsPath = path.join(repoRoot, 'src', 'webview', 'generated', 'functions.generated.js');
		const generatedFunctionsSource = fs.readFileSync(generatedFunctionsPath, 'utf8');

		const fnDocsSrc = extractConstObjectAssignment(monacoSource, 'KUSTO_FUNCTION_DOCS');
		const ensureMergeSrc = extractConstAssignmentStatement(monacoSource, '__kustoEnsureGeneratedFunctionsMerged');
		const findCallSrc = extractConstAssignmentStatement(monacoSource, 'findEnclosingFunctionCall');
		const computeArgIndexSrc = extractConstAssignmentStatement(monacoSource, 'computeArgIndex');
		const buildSignatureSrc = extractConstAssignmentStatement(monacoSource, 'buildFunctionSignatureMarkdown');
		const schemaFnDocSrc = extractConstAssignmentStatement(monacoSource, 'getSchemaFunctionDoc');
		const abbreviateTypeSrc = extractConstAssignmentStatement(monacoSource, '_abbreviateType');
		const schemaTableDocSrc = extractConstAssignmentStatement(monacoSource, 'getSchemaTableDoc');
		const getHoverSrc = extractConstAssignmentStatement(monacoSource, 'getHoverInfoAt');
		const isIdentCharSrc = extractConstAssignmentStatement(monacoSource, 'isIdentChar');
		const isIdentStartSrc = extractConstAssignmentStatement(monacoSource, 'isIdentStart');

		const sandbox: any = {
			exports: {},
			console,
			window: null, // will be set to sandbox itself below
			__kustoGeneratedFunctionsMerged: false,
			_monaco: null,
			_monacoRange: FakeRange,
			_monacoPosition: class FakePosition {
				constructor(public lineNumber: number, public column: number) {}
			},
			KUSTO_KEYWORD_DOCS: {},
			__kustoGetControlCommandHoverAt: () => null,
			getMultiWordOperatorAt: () => null,
			getTokenAtPosition: () => null,
			getWordRangeAt: () => null,
			monaco: {
				Range: FakeRange,
				Position: class FakePosition {
					constructor(public lineNumber: number, public column: number) {}
				}
			}
		};

		// Populate window.__kustoFunctionEntries + window.__kustoFunctionDocs from the generated file.
		sandbox.window = sandbox; // Allow window.xxx to resolve to sandbox.xxx
		sandbox._monaco = sandbox.monaco;
		vm.runInNewContext(generatedFunctionsSource, sandbox, { filename: 'functions.generated.js' });

		const exportedFnDocs = fnDocsSrc.replace(/const\s+KUSTO_FUNCTION_DOCS\s*=\s*/, 'exports.KUSTO_FUNCTION_DOCS = ');
		vm.runInNewContext(exportedFnDocs, sandbox, { filename: 'monaco.fnDocs.extract.js' });
		sandbox.KUSTO_FUNCTION_DOCS = sandbox.exports.KUSTO_FUNCTION_DOCS;

		// Helpers required for hover path.
		vm.runInNewContext(isIdentCharSrc, sandbox, { filename: 'monaco.isIdentChar.extract.js' });
		vm.runInNewContext(isIdentStartSrc, sandbox, { filename: 'monaco.isIdentStart.extract.js' });
		vm.runInNewContext(findCallSrc, sandbox, { filename: 'monaco.findEnclosingFunctionCall.extract.js' });
		vm.runInNewContext(computeArgIndexSrc, sandbox, { filename: 'monaco.computeArgIndex.extract.js' });
		vm.runInNewContext(buildSignatureSrc, sandbox, { filename: 'monaco.buildFunctionSignatureMarkdown.extract.js' });
		vm.runInNewContext(ensureMergeSrc, sandbox, { filename: 'monaco.ensureMerge.extract.js' });
		vm.runInNewContext(schemaFnDocSrc, sandbox, { filename: 'monaco.getSchemaFunctionDoc.extract.js' });
		vm.runInNewContext(abbreviateTypeSrc, sandbox, { filename: 'monaco._abbreviateType.extract.js' });
		vm.runInNewContext(schemaTableDocSrc, sandbox, { filename: 'monaco.getSchemaTableDoc.extract.js' });

		const exportedHover = getHoverSrc.replace(/const\s+getHoverInfoAt\s*=\s*/, 'exports.getHoverInfoAt = ');
		vm.runInNewContext(exportedHover, sandbox, { filename: 'monaco.getHoverInfoAt.extract.js' });
		assert.ok(typeof sandbox.exports.getHoverInfoAt === 'function', 'Expected getHoverInfoAt to be extracted');

		{
			const text = [
				'range a from 1 to 3 step 1',
				'| sort by a desc',
				'| extend rn=row_number()'
			].join('\n');
			const model = new FakeModel(text);

			// Place caret inside the function call parens to force the function-call hover path.
			const line3 = model.getLineContent(3);
			const col = line3.indexOf('row_number') + 'row_number('.length + 1;
			const info = sandbox.exports.getHoverInfoAt(model as any, { lineNumber: 3, column: col });

			assert.ok(info && typeof info.markdown === 'string' && info.markdown.length > 0, 'Expected hover markdown');
			assert.ok(/row_number\s*\(/i.test(info.markdown), 'Expected hover to include row_number() docs');
			assert.ok(/StartingIndex\??/i.test(info.markdown), 'Expected hover signature to include StartingIndex');
			assert.ok(/Restart\??/i.test(info.markdown), 'Expected hover signature to include Restart');
		}

		{
			const text = [
				'range a from 1 to 3 step 1',
				'| sort by a desc',
				'| extend rn=row_number(7, true)'
			].join('\n');
			const model = new FakeModel(text);
			const line3 = model.getLineContent(3);
			const col = line3.indexOf(', true') + 3; // inside second arg
			const info = sandbox.exports.getHoverInfoAt(model as any, { lineNumber: 3, column: col });

			assert.ok(info && typeof info.markdown === 'string' && info.markdown.length > 0, 'Expected hover markdown');
			assert.ok(/\*\*Restart\??\*\*/i.test(info.markdown), 'Expected active arg highlighting for Restart');
		}
	});
});
