import { describe, it, expect } from 'vitest';
import { __kustoDisableMonacoKustoWorkerHover, __kustoGetColumnsByTable } from '../../src/webview/monaco/monaco.js';

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
});
