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
}

suite('KQL completions - functions list', () => {
	const createCompletionProvider = () => {
		const repoRoot = path.resolve(__dirname, '..', '..');
		const monacoPath = path.join(repoRoot, 'media', 'queryEditor', 'monaco.js');
		const monacoSource = fs.readFileSync(monacoPath, 'utf8');
		const generatedFunctionsPath = path.join(repoRoot, 'media', 'queryEditor', 'functions.generated.js');
		const generatedFunctionsSource = fs.readFileSync(generatedFunctionsPath, 'utf8');

		const fnDocsSrc = extractConstObjectAssignment(monacoSource, 'KUSTO_FUNCTION_DOCS');
		const providerSrc = extractConstObjectAssignment(monacoSource, '__kustoCompletionProvider');

		const sandbox: any = {
			exports: {},
			console,
			window: {},

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
		vm.runInNewContext(generatedFunctionsSource, sandbox, { filename: 'functions.generated.js' });

		const exportedFnDocs = fnDocsSrc.replace(/const\s+KUSTO_FUNCTION_DOCS\s*=\s*/, 'exports.KUSTO_FUNCTION_DOCS = ');
		const exportedProvider = providerSrc.replace(/const\s+__kustoCompletionProvider\s*=\s*/, 'exports.__kustoCompletionProvider = ');

		vm.runInNewContext(exportedFnDocs, sandbox, { filename: 'monaco.fnDocs.extract.js' });
		// The completion provider references `KUSTO_FUNCTION_DOCS` as a free variable.
		// Make it available as a global in the same sandbox context.
		sandbox.KUSTO_FUNCTION_DOCS = sandbox.exports.KUSTO_FUNCTION_DOCS;
		// The completion provider also expects `window.__kustoFunctionEntries`.
		sandbox.window = sandbox.window || {};
		(sandbox.window as any).__kustoFunctionEntries = (sandbox.window as any).__kustoFunctionEntries || (sandbox as any).__kustoFunctionEntries;
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
});
