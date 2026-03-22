import { describe, it, expect } from 'vitest';
import {
	formatCellValue,
	isLikelyCancellationError,
	isAuthError,
	extractSchemaFromJson,
	finalizeSchema,
	parseDatabaseSchemaResultWithRaw
} from '../../../src/host/kustoClientUtils';

// ---------------------------------------------------------------------------
// formatCellValue
// ---------------------------------------------------------------------------

describe('formatCellValue', () => {
	it('returns "null" for null', () => {
		expect(formatCellValue(null)).toEqual({ display: 'null', full: 'null' });
	});

	it('returns "null" for undefined', () => {
		expect(formatCellValue(undefined)).toEqual({ display: 'null', full: 'null' });
	});

	it('formats Date objects as ISO without milliseconds', () => {
		const d = new Date('2024-03-15T10:30:45.123Z');
		const result = formatCellValue(d);
		expect(result.display).toBe('2024-03-15 10:30:45');
		expect(result.full).toBe(d.toString());
	});

	it('formats ISO date strings', () => {
		const result = formatCellValue('2024-01-01T00:00:00Z');
		expect(result.display).toBe('2024-01-01 00:00:00');
	});

	it('returns plain string for non-date strings', () => {
		expect(formatCellValue('hello')).toEqual({ display: 'hello', full: 'hello' });
	});

	it('returns number as string', () => {
		expect(formatCellValue(42)).toEqual({ display: '42', full: '42' });
	});

	it('formats empty array as []', () => {
		expect(formatCellValue([])).toEqual({ display: '[]', full: '[]' });
	});

	it('formats empty object as {}', () => {
		expect(formatCellValue({})).toEqual({ display: '{}', full: '{}' });
	});

	it('formats non-empty objects as [object] with JSON', () => {
		const obj = { key: 'value' };
		const result = formatCellValue(obj);
		expect(result.display).toBe('[object]');
		expect(result.isObject).toBe(true);
		expect(result.rawObject).toBe(obj);
		expect(JSON.parse(result.full)).toEqual(obj);
	});

	it('formats non-empty arrays as [object] with JSON', () => {
		const arr = [1, 2, 3];
		const result = formatCellValue(arr);
		expect(result.display).toBe('[object]');
		expect(result.isObject).toBe(true);
	});

	it('handles boolean values', () => {
		expect(formatCellValue(true)).toEqual({ display: 'true', full: 'true' });
		expect(formatCellValue(false)).toEqual({ display: 'false', full: 'false' });
	});

	it('does not treat non-ISO date-like strings as dates', () => {
		const result = formatCellValue('March 15, 2024');
		expect(result.display).toBe('March 15, 2024');
	});
});

// ---------------------------------------------------------------------------
// isLikelyCancellationError
// ---------------------------------------------------------------------------

describe('isLikelyCancellationError', () => {
	it('returns true for error with isCancelled flag', () => {
		expect(isLikelyCancellationError({ isCancelled: true })).toBe(true);
	});

	it('returns true for error with __CANCEL flag', () => {
		expect(isLikelyCancellationError({ __CANCEL: true })).toBe(true);
	});

	it('returns true for AbortError', () => {
		expect(isLikelyCancellationError({ name: 'AbortError' })).toBe(true);
	});

	it('returns true for "cancelled" in message', () => {
		expect(isLikelyCancellationError(new Error('Operation cancelled'))).toBe(true);
	});

	it('returns true for "canceled" (US spelling) in message', () => {
		expect(isLikelyCancellationError(new Error('Request canceled'))).toBe(true);
	});

	it('returns true for "User did not consent"', () => {
		expect(isLikelyCancellationError(new Error('User did not consent to the requested scope'))).toBe(true);
	});

	it('returns false for generic errors', () => {
		expect(isLikelyCancellationError(new Error('Network error'))).toBe(false);
	});

	it('returns false for null', () => {
		expect(isLikelyCancellationError(null)).toBe(false);
	});

	it('returns false for non-error objects', () => {
		expect(isLikelyCancellationError({ message: 'timeout' })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isAuthError
// ---------------------------------------------------------------------------

describe('isAuthError', () => {
	it('returns true for AADSTS error messages', () => {
		expect(isAuthError(new Error('AADSTS700054: some problem'))).toBe(true);
	});

	it('returns true for "unauthorized" in message', () => {
		expect(isAuthError(new Error('Request unauthorized'))).toBe(true);
	});

	it('returns true for "authentication" in message', () => {
		expect(isAuthError(new Error('Authentication failed'))).toBe(true);
	});

	it('returns true for "authorization" in message', () => {
		expect(isAuthError(new Error('Authorization denied'))).toBe(true);
	});

	it('returns false if error is also a cancellation', () => {
		expect(isAuthError({ isCancelled: true, message: 'unauthorized' })).toBe(false);
	});

	it('returns false for cancelled message even with auth keywords', () => {
		expect(isAuthError(new Error('User cancelled authentication'))).toBe(false);
	});

	it('returns true for 401 status code', () => {
		expect(isAuthError({ statusCode: 401, message: 'fail' })).toBe(true);
	});

	it('returns true for 403 status code', () => {
		expect(isAuthError({ status: 403, message: 'fail' })).toBe(true);
	});

	it('returns true for nested response status', () => {
		expect(isAuthError({ response: { status: 401 }, message: 'fail' })).toBe(true);
	});

	it('returns true for status code in message text', () => {
		expect(isAuthError(new Error('status code 401 received'))).toBe(true);
	});

	it('returns false for generic errors', () => {
		expect(isAuthError(new Error('Network timeout'))).toBe(false);
	});

	it('returns false for non-auth status codes', () => {
		expect(isAuthError({ statusCode: 500, message: 'fail' })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// extractSchemaFromJson
// ---------------------------------------------------------------------------

describe('extractSchemaFromJson', () => {
	it('extracts tables from Databases shape', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		extractSchemaFromJson({
			Databases: {
				TestDb: {
					Tables: {
						Events: {
							Name: 'Events',
							OrderedColumns: [
								{ Name: 'Timestamp', Type: 'datetime' },
								{ Name: 'Level', Type: 'string' }
							]
						}
					}
				}
			}
		}, columnTypesByTable);
		expect(columnTypesByTable['Events']).toEqual({ Timestamp: 'datetime', Level: 'string' });
	});

	it('extracts tables from array shape', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		extractSchemaFromJson({
			Tables: [
				{ Name: 'Logs', Columns: [{ Name: 'Message', Type: 'string' }] }
			]
		}, columnTypesByTable);
		expect(columnTypesByTable['Logs']).toEqual({ Message: 'string' });
	});

	it('extracts table docstrings', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		const tableDocStrings: Record<string, string> = {};
		extractSchemaFromJson({
			Tables: [
				{ Name: 'Events', DocString: 'Event logs', Columns: [{ Name: 'Id', Type: 'int' }] }
			]
		}, columnTypesByTable, tableDocStrings);
		expect(tableDocStrings['Events']).toBe('Event logs');
	});

	it('extracts column docstrings', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		const columnDocStrings: Record<string, string> = {};
		extractSchemaFromJson({
			Databases: {
				Db: {
					Tables: {
						T: { Name: 'T', OrderedColumns: [{ Name: 'C', Type: 'string', DocString: 'A col' }] }
					}
				}
			}
		}, columnTypesByTable, undefined, columnDocStrings);
		expect(columnDocStrings['T.C']).toBe('A col');
	});

	it('extracts functions', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		const functions: any[] = [];
		extractSchemaFromJson({
			Databases: {
				Db: {
					Tables: {},
					Functions: {
						myFunc: { Name: 'myFunc', Body: 'T | count', InputParameters: [] }
					}
				}
			}
		}, columnTypesByTable, undefined, undefined, undefined, functions);
		expect(functions).toHaveLength(1);
		expect(functions[0].name).toBe('myFunc');
		expect(functions[0].body).toBe('T | count');
	});

	it('extracts materialized views', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		extractSchemaFromJson({
			Databases: {
				Db: {
					Tables: {},
					MaterializedViews: {
						MV1: { Name: 'MV1', Columns: [{ Name: 'Col1', Type: 'long' }] }
					}
				}
			}
		}, columnTypesByTable);
		expect(columnTypesByTable['MV1']).toEqual({ Col1: 'long' });
	});

	it('handles null input', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		extractSchemaFromJson(null, columnTypesByTable);
		expect(Object.keys(columnTypesByTable)).toHaveLength(0);
	});

	it('handles Tables as dictionary (object map)', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		extractSchemaFromJson({
			Tables: {
				Logs: { Name: 'Logs', Columns: [{ Name: 'Id', Type: 'int' }] }
			}
		}, columnTypesByTable);
		expect(columnTypesByTable['Logs']).toEqual({ Id: 'int' });
	});

	it('extracts table folders', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		const tableFolders: Record<string, string> = {};
		extractSchemaFromJson({
			Databases: {
				Db: {
					Tables: {
						T: { Name: 'T', Folder: 'MyFolder', OrderedColumns: [{ Name: 'C', Type: 'string' }] }
					}
				}
			}
		}, columnTypesByTable, undefined, undefined, tableFolders);
		expect(tableFolders['T']).toBe('MyFolder');
	});

	it('extracts function parameters', () => {
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		const functions: any[] = [];
		extractSchemaFromJson({
			Databases: {
				Db: {
					Tables: {},
					Functions: {
						myFunc: {
							Name: 'myFunc',
							Body: 'T | where x == p',
							InputParameters: [{ Name: 'p', CslType: 'string' }]
						}
					}
				}
			}
		}, columnTypesByTable, undefined, undefined, undefined, functions);
		expect(functions[0].parameters).toEqual([{ name: 'p', type: 'string', defaultValue: undefined }]);
		expect(functions[0].parametersText).toBe('(p:string)');
	});
});

// ---------------------------------------------------------------------------
// finalizeSchema
// ---------------------------------------------------------------------------

describe('finalizeSchema', () => {
	it('sorts tables alphabetically', () => {
		const result = finalizeSchema({ Zebra: { a: 'int' }, Alpha: { b: 'string' } });
		expect(result.tables).toEqual(['Alpha', 'Zebra']);
	});

	it('includes columnTypesByTable', () => {
		const result = finalizeSchema({ T: { C: 'string' } });
		expect(result.columnTypesByTable).toEqual({ T: { C: 'string' } });
	});

	it('includes tableDocStrings when non-empty', () => {
		const result = finalizeSchema({ T: {} }, { T: 'doc' });
		expect(result.tableDocStrings).toEqual({ T: 'doc' });
	});

	it('omits tableDocStrings when empty', () => {
		const result = finalizeSchema({ T: {} }, {});
		expect(result.tableDocStrings).toBeUndefined();
	});

	it('deduplicates functions by name (case-insensitive)', () => {
		const result = finalizeSchema({}, undefined, undefined, undefined, [
			{ name: 'myFunc' },
			{ name: 'MYFUNC' },
			{ name: 'other' }
		]);
		expect(result.functions).toHaveLength(2);
		expect(result.functions![0].name).toBe('myFunc');
		expect(result.functions![1].name).toBe('other');
	});

	it('sorts functions alphabetically', () => {
		const result = finalizeSchema({}, undefined, undefined, undefined, [
			{ name: 'zebra' },
			{ name: 'alpha' }
		]);
		expect(result.functions![0].name).toBe('alpha');
	});
});

// ---------------------------------------------------------------------------
// parseDatabaseSchemaResultWithRaw
// ---------------------------------------------------------------------------

describe('parseDatabaseSchemaResultWithRaw', () => {
	it('returns empty schema when no primary results', () => {
		const result = parseDatabaseSchemaResultWithRaw({}, '.show database schema');
		expect(result.schema.tables).toEqual([]);
	});

	it('returns empty schema for null result', () => {
		const result = parseDatabaseSchemaResultWithRaw(null, '.show database schema');
		expect(result.schema.tables).toEqual([]);
	});

	it('parses JSON-based schema from rows', () => {
		const mockResult = {
			primaryResults: [{
				rows: function* () {
					yield {
						DatabaseSchema: JSON.stringify({
							Databases: {
								TestDb: {
									Tables: {
										Events: {
											Name: 'Events',
											OrderedColumns: [
												{ Name: 'Timestamp', Type: 'datetime' },
												{ Name: 'Message', Type: 'string' }
											]
										}
									}
								}
							}
						})
					};
				},
				columns: []
			}]
		};
		const result = parseDatabaseSchemaResultWithRaw(mockResult, '.show database schema as json');
		expect(result.schema.tables).toContain('Events');
		expect(result.schema.columnTypesByTable['Events']).toBeDefined();
	});

	it('extracts rawSchemaJson for json commands', () => {
		const schemaObj = {
			Databases: {
				Db: {
					Tables: {
						T: { Name: 'T', OrderedColumns: [{ Name: 'C', Type: 'string' }] }
					}
				}
			}
		};
		const mockResult = {
			primaryResults: [{
				rows: function* () {
					yield { Schema: schemaObj };
				},
				columns: []
			}]
		};
		const result = parseDatabaseSchemaResultWithRaw(mockResult, '.show database schema as json');
		expect(result.rawSchemaJson).toBeDefined();
	});

	it('falls back to tabular parsing', () => {
		const mockResult = {
			primaryResults: [{
				rows: function* () {
					yield { TableName: 'Logs', ColumnName: 'Id', ColumnType: 'int' };
					yield { TableName: 'Logs', ColumnName: 'Text', ColumnType: 'string' };
				},
				columns: [
					{ name: 'TableName' },
					{ name: 'ColumnName' },
					{ name: 'ColumnType' }
				]
			}]
		};
		const result = parseDatabaseSchemaResultWithRaw(mockResult, '.show database schema');
		expect(result.schema.tables).toContain('Logs');
		expect(result.schema.columnTypesByTable['Logs']).toEqual({ Id: 'int', Text: 'string' });
	});
});
