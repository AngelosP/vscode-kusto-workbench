import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { __kustoAreEquivalentMonacoMarkers, __kustoDisableMonacoKustoWorkerHover, __kustoGetColumnsByTable } from '../../src/webview/monaco/monaco.js';
import { __kustoNormalizeCollapsedMonacoMarkers } from '../../src/webview/monaco/marker-ranges.js';

function makeMonacoModel(text: string) {
	const lines = text.split('\n');
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
	};
}

// ── __kustoGetColumnsByTable ──────────────────────────────────────────────────

describe('__kustoGetColumnsByTable', () => {
	it('derives columns from columnTypesByTable', () => {
		const schema = {
			columnTypesByTable: {
				MyTable: { Name: 'string', Age: 'int', Timestamp: 'datetime' },
			},
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(result).toBeTruthy();
		expect(result.MyTable).toEqual(['Age', 'Name', 'Timestamp']); // sorted
	});

	it('returns null for null schema', () => {
		expect(__kustoGetColumnsByTable(null)).toBeNull();
	});

	it('returns null for non-object schema', () => {
		expect(__kustoGetColumnsByTable('not an object')).toBeNull();
	});

	it('prefers legacy columnsByTable when present', () => {
		const schema = {
			columnsByTable: { T: ['x', 'y'] },
			columnTypesByTable: { T: { a: 'string', b: 'int' } },
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(result).toEqual({ T: ['x', 'y'] });
	});

	it('handles empty columnTypesByTable', () => {
		const schema = { columnTypesByTable: {} };
		const result = __kustoGetColumnsByTable(schema);
		expect(result).toEqual({});
	});

	it('handles multiple tables', () => {
		const schema = {
			columnTypesByTable: {
				T1: { a: 'string', b: 'int' },
				T2: { x: 'real', y: 'datetime' },
			},
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(Object.keys(result)).toHaveLength(2);
		expect(result.T1).toEqual(['a', 'b']);
		expect(result.T2).toEqual(['x', 'y']);
	});

	it('returns null when no columnTypesByTable and no columnsByTable', () => {
		expect(__kustoGetColumnsByTable({})).toBeNull();
		expect(__kustoGetColumnsByTable({ tables: ['T'] })).toBeNull();
	});

	it('skips non-object table entries', () => {
		const schema = {
			columnTypesByTable: {
				T1: { a: 'string' },
				T2: null,
				T3: 'invalid',
			},
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(result.T1).toEqual(['a']);
		expect(result).not.toHaveProperty('T2');
		expect(result).not.toHaveProperty('T3');
	});
});

// ── __kustoDisableMonacoKustoWorkerHover ─────────────────────────────────────

describe('__kustoDisableMonacoKustoWorkerHover', () => {
	it('disables only the monaco-kusto worker hover setting', () => {
		let applied: any = null;
		const settings = {
			includeControlCommands: true,
			newlineAfterPipe: true,
			enableHover: true,
			formatter: { indentationSize: 4, pipeOperatorStyle: 'Smart' },
			completionOptions: { includeExtendedSyntax: false },
		};
		const monacoApi = {
			languages: {
				kusto: {
					kustoDefaults: {
						languageSettings: settings,
						setLanguageSettings(next: any) {
							applied = next;
						},
					},
				},
			},
		};

		expect(__kustoDisableMonacoKustoWorkerHover(monacoApi)).toBe(true);
		expect(applied).toEqual({ ...settings, enableHover: false });
		expect(applied.formatter).toBe(settings.formatter);
		expect(applied.completionOptions).toBe(settings.completionOptions);
	});

	it('does not replace missing language settings with a partial object', () => {
		let called = false;
		const monacoApi = {
			languages: {
				kusto: {
					kustoDefaults: {
						languageSettings: null,
						setLanguageSettings() {
							called = true;
						},
					},
				},
			},
		};

		expect(__kustoDisableMonacoKustoWorkerHover(monacoApi)).toBe(false);
		expect(called).toBe(false);
	});

	it('is called before local Kusto hover registration during Monaco bootstrap', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const contributionLoadIndex = source.indexOf("['vs/language/kusto/monaco.contribution']");
		const disableCallIndex = source.indexOf('__kustoDisableMonacoKustoWorkerHover(monaco)', contributionLoadIndex);
		const localHoverIndex = source.indexOf("monaco.languages.registerHoverProvider('kusto'", contributionLoadIndex);

		expect(contributionLoadIndex).toBeGreaterThan(-1);
		expect(disableCallIndex).toBeGreaterThan(contributionLoadIndex);
		expect(localHoverIndex).toBeGreaterThan(disableCallIndex);
		expect(source).toContain('hover: { enabled: true, above: true, sticky: true }');
	});

	it('keeps the focused Kusto editor caret solid so hover widgets do not flicker on blink ticks', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const editorCreateIndex = source.indexOf('const editor = monaco.editor.create(container, {');
		const editorCreateEndIndex = source.indexOf('\n\t\t});', editorCreateIndex);
		const editorCreateBlock = source.slice(editorCreateIndex, editorCreateEndIndex);

		expect(editorCreateIndex).toBeGreaterThan(-1);
		expect(editorCreateEndIndex).toBeGreaterThan(editorCreateIndex);
		expect(editorCreateBlock).toContain("language: 'kusto'");
		expect(editorCreateBlock).toContain("cursorBlinking: 'solid'");
	});
});

// ── __kustoAreEquivalentMonacoMarkers ───────────────────────────────────────

describe('__kustoAreEquivalentMonacoMarkers', () => {
	it('treats repeated empty marker writes as equivalent', () => {
		expect(__kustoAreEquivalentMonacoMarkers([], [])).toBe(true);
	});

	it('ignores Monaco-owned metadata when comparing stored and incoming markers', () => {
		const current = [{
			owner: 'kusto',
			resource: { toString: () => 'inmemory://model.kusto' },
			severity: 8,
			message: 'Unknown column Foo',
			source: 'Kusto',
			code: { value: 'KS204', target: { toString: () => 'https://example.test/KS204' } },
			startLineNumber: 2,
			startColumn: 7,
			endLineNumber: 2,
			endColumn: 10,
			tags: [1],
			relatedInformation: [{
				resource: { toString: () => 'inmemory://model.kusto' },
				message: 'Related detail',
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: 1,
				endColumn: 5,
			}],
		}];
		const next = [{
			severity: 8,
			message: 'Unknown column Foo',
			source: 'Kusto',
			code: { value: 'KS204', target: { toString: () => 'https://example.test/KS204' } },
			startLineNumber: 2,
			startColumn: 7,
			endLineNumber: 2,
			endColumn: 10,
			tags: [1],
			relatedInformation: [{
				resource: { toString: () => 'inmemory://model.kusto' },
				message: 'Related detail',
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: 1,
				endColumn: 5,
			}],
		}];

		expect(__kustoAreEquivalentMonacoMarkers(current, next)).toBe(true);
	});

	it('treats marker order changes as equivalent while preserving duplicates', () => {
		const markerA = { severity: 4, message: 'A', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 };
		const markerB = { severity: 8, message: 'B', startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 };

		expect(__kustoAreEquivalentMonacoMarkers([markerA, markerB], [markerB, markerA])).toBe(true);
		expect(__kustoAreEquivalentMonacoMarkers([markerA, markerA], [markerA, markerB])).toBe(false);
	});

	it('detects real diagnostic changes', () => {
		const base = { severity: 8, message: 'Unknown column Foo', startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 10 };

		expect(__kustoAreEquivalentMonacoMarkers([base], [{ ...base, message: 'Unknown column Bar' }])).toBe(false);
		expect(__kustoAreEquivalentMonacoMarkers([base], [{ ...base, startColumn: 8 }])).toBe(false);
		expect(__kustoAreEquivalentMonacoMarkers([base], [])).toBe(false);
	});

	it('fails open for non-array inputs', () => {
		expect(__kustoAreEquivalentMonacoMarkers([], null)).toBe(false);
		expect(__kustoAreEquivalentMonacoMarkers(null, [])).toBe(false);
	});

	it('guards Kusto marker writes before forwarding to Monaco', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const interceptorIndex = source.indexOf("monaco.editor.setModelMarkers = function(model: any, owner: any, markers: any)");
		const normalizeIndex = source.indexOf('__kustoNormalizeCollapsedMonacoMarkers(model, markers)', interceptorIndex);
		const guardIndex = source.indexOf('__kustoAreEquivalentMonacoMarkers(currentMarkers, normalizedMarkers)', interceptorIndex);
		const forwardIndex = source.indexOf('return originalSetModelMarkers.call(this, model, owner, normalizedMarkers)', interceptorIndex);

		expect(interceptorIndex).toBeGreaterThan(-1);
		expect(normalizeIndex).toBeGreaterThan(interceptorIndex);
		expect(guardIndex).toBeGreaterThan(normalizeIndex);
		expect(forwardIndex).toBeGreaterThan(guardIndex);
	});
});

// ── __kustoNormalizeCollapsedMonacoMarkers ─────────────────────────────────

describe('__kustoNormalizeCollapsedMonacoMarkers', () => {
	it('expands an EOF collapsed marker backward over the trailing operator', () => {
		const line = '| project It, ExpectedValue, ActualValue, Passed+';
		const model = makeMonacoModel(`print Passed = true\n${line}`);
		const eofColumn = line.length + 1;
		const marker = {
			severity: 8,
			message: 'Missing expression',
			code: 'KS006',
			startLineNumber: 2,
			startColumn: eofColumn,
			endLineNumber: 2,
			endColumn: eofColumn,
			source: 'Kusto',
		};
		const markers = [marker];

		const normalized = __kustoNormalizeCollapsedMonacoMarkers(model, markers);

		expect(normalized).not.toBe(markers);
		expect(normalized[0]).toMatchObject({
			severity: 8,
			message: 'Missing expression',
			code: 'KS006',
			source: 'Kusto',
			startLineNumber: 2,
			startColumn: eofColumn - 1,
			endLineNumber: 2,
			endColumn: eofColumn,
		});
		expect(marker.startColumn).toBe(eofColumn);
		expect(line[normalized[0].startColumn as number - 1]).toBe('+');
	});

	it('expands a token-start collapsed marker forward', () => {
		const marker = {
			message: 'Missing expression',
			startLineNumber: 1,
			startColumn: 7,
			endLineNumber: 1,
			endColumn: 7,
		};

		const normalized = __kustoNormalizeCollapsedMonacoMarkers(makeMonacoModel('print value'), [marker]);

		expect(normalized[0]).toMatchObject({
			startLineNumber: 1,
			startColumn: 7,
			endLineNumber: 1,
			endColumn: 8,
		});
		expect(marker.endColumn).toBe(7);
	});

	it('expands a whitespace-gap collapsed marker to the nearest visible character', () => {
		const marker = {
			message: 'Missing expression',
			startLineNumber: 1,
			startColumn: 6,
			endLineNumber: 1,
			endColumn: 6,
		};

		const normalized = __kustoNormalizeCollapsedMonacoMarkers(makeMonacoModel('abc     def'), [marker]);

		expect(normalized[0]).toMatchObject({
			startLineNumber: 1,
			startColumn: 3,
			endLineNumber: 1,
			endColumn: 4,
		});
	});

	it('keeps non-collapsed markers and empty marker arrays unchanged', () => {
		const model = makeMonacoModel('print value');
		const marker = {
			message: 'Already visible',
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 1,
			endColumn: 6,
		};
		const markers = [marker];
		const empty: typeof markers = [];

		expect(__kustoNormalizeCollapsedMonacoMarkers(model, markers)).toBe(markers);
		expect(__kustoNormalizeCollapsedMonacoMarkers(model, empty)).toBe(empty);
	});

	it('leaves collapsed markers unchanged when the line has no visible character', () => {
		const marker = {
			message: 'Missing expression',
			startLineNumber: 1,
			startColumn: 2,
			endLineNumber: 1,
			endColumn: 2,
		};
		const markers = [marker];

		expect(__kustoNormalizeCollapsedMonacoMarkers(makeMonacoModel('   '), markers)).toBe(markers);
	});
});
