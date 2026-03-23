import { describe, it, expect } from 'vitest';
import type { DatabaseSchemaIndex } from '../../../src/host/kustoClient';
import {
	getColumnsByTable,
	countColumns,
	formatSchemaWithOptions,
	formatSchemaWithTokenBudget,
	abbreviateType,
	addPruneNotice,
	formatSchemaAsCompactText,
	TYPE_ABBREVIATIONS,
} from '../../../src/host/schemaIndexUtils';

function makeSchema(overrides?: Partial<DatabaseSchemaIndex>): DatabaseSchemaIndex {
	return {
		tables: [],
		columnTypesByTable: {},
		...overrides
	};
}

describe('getColumnsByTable', () => {
	it('schema with 2 tables → correct column mapping', () => {
		const schema = makeSchema({
			tables: ['Orders', 'Users'],
			columnTypesByTable: {
				Orders: { Id: 'long', Amount: 'real', Date: 'datetime' },
				Users: { Id: 'long', Name: 'string', Email: 'string' }
			}
		});
		const result = getColumnsByTable(schema);
		expect(result['Orders']).toEqual(['Amount', 'Date', 'Id']);
		expect(result['Users']).toEqual(['Email', 'Id', 'Name']);
	});

	it('empty schema → empty object', () => {
		const result = getColumnsByTable(makeSchema());
		expect(result).toEqual({});
	});

	it('null/undefined schema → empty object', () => {
		expect(getColumnsByTable(null)).toEqual({});
		expect(getColumnsByTable(undefined)).toEqual({});
	});

	it('table with no column types → empty array for that table', () => {
		const schema = makeSchema({
			tables: ['Empty'],
			columnTypesByTable: { Empty: {} }
		});
		const result = getColumnsByTable(schema);
		expect(result['Empty']).toEqual([]);
	});

	it('columns are sorted alphabetically', () => {
		const schema = makeSchema({
			tables: ['T'],
			columnTypesByTable: { T: { Zebra: 'string', Alpha: 'string', Middle: 'string' } }
		});
		const result = getColumnsByTable(schema);
		expect(result['T']).toEqual(['Alpha', 'Middle', 'Zebra']);
	});
});

describe('countColumns', () => {
	it('2 tables with 3+2 columns → 5', () => {
		const schema = makeSchema({
			tables: ['A', 'B'],
			columnTypesByTable: {
				A: { c1: 'string', c2: 'long', c3: 'bool' },
				B: { c4: 'datetime', c5: 'real' }
			}
		});
		expect(countColumns(schema)).toBe(5);
	});

	it('empty schema → 0', () => {
		expect(countColumns(makeSchema())).toBe(0);
	});

	it('null/undefined schema → 0', () => {
		expect(countColumns(null)).toBe(0);
		expect(countColumns(undefined)).toBe(0);
	});

	it('single table with 10 columns → 10', () => {
		const cols: Record<string, string> = {};
		for (let i = 0; i < 10; i++) {
			cols[`col${i}`] = 'string';
		}
		const schema = makeSchema({
			tables: ['Big'],
			columnTypesByTable: { Big: cols }
		});
		expect(countColumns(schema)).toBe(10);
	});
});

describe('formatSchemaWithOptions', () => {
	const schema: DatabaseSchemaIndex = {
		tables: ['Orders', 'Users'],
		columnTypesByTable: {
			Orders: { Id: 'long', Amount: 'real' },
			Users: { Name: 'string', Active: 'bool' }
		},
		tableDocStrings: { Orders: 'All orders' },
		columnDocStrings: { 'Users.Name': 'Full name' },
		functions: [
			{
				name: 'GetOrders',
				parameters: [{ name: 'startDate', type: 'datetime' }],
				docString: 'Returns orders'
			}
		]
	};

	it('default options (no pruning) → full output with types, docstrings, columns', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		expect(text).toContain('Database: TestDb');
		expect(text).toContain('Types:');
		expect(text).toContain('Id(l)');
		expect(text).toContain('Amount(r)');
		expect(text).toContain('// All orders');
		expect(text).toContain('"Full name"');
		expect(text).toContain('GetOrders(startDate:dt)');
		expect(text).toContain('// Returns orders');
	});

	it('dropTypes: true → no type annotations on columns', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropTypes: true });
		expect(text).toContain('Id');
		expect(text).not.toContain('Id(l)');
		expect(text).not.toContain('Amount(r)');
		expect(text).not.toContain('Types:');
		expect(text).toContain('GetOrders(startDate)');
		expect(text).not.toContain('startDate:dt');
	});

	it('dropDocStrings: true → no docstring comments', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropDocStrings: true });
		expect(text).not.toContain('// All orders');
		expect(text).not.toContain('"Full name"');
		expect(text).not.toContain('// Returns orders');
		expect(text).toContain('Id(l)');
	});

	it('dropColumns: true → tables listed but no column details', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropColumns: true });
		expect(text).toContain('Orders');
		expect(text).toContain('Users');
		expect(text).not.toContain('Id(');
		expect(text).not.toContain('Amount(');
		expect(text).not.toContain('Name(');
	});

	it('dropFunctionParams: true → functions listed without parameters', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropFunctionParams: true });
		expect(text).toContain('GetOrders()');
		expect(text).not.toContain('startDate');
	});

	it('combined: dropTypes + dropDocStrings → both removed', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, {
			dropTypes: true,
			dropDocStrings: true
		});
		expect(text).not.toContain('Types:');
		expect(text).not.toContain('// All orders');
		expect(text).not.toContain('"Full name"');
		expect(text).not.toContain('(l)');
		expect(text).toContain('Id');
		expect(text).toContain('Amount');
	});

	it('empty schema → shows (none) for tables', () => {
		const text = formatSchemaWithOptions('EmptyDb', makeSchema(), undefined, {});
		expect(text).toContain('# Tables');
		expect(text).toContain('(none)');
	});

	it('meta info is included when provided', () => {
		const text = formatSchemaWithOptions('TestDb', schema, {
			tablesCount: 2,
			columnsCount: 4,
			functionsCount: 1
		}, {});
		expect(text).toContain('Info:');
		expect(text).toContain('2 tables');
		expect(text).toContain('4 columns');
		expect(text).toContain('1 functions');
	});
});

describe('formatSchemaWithTokenBudget', () => {
	const schema: DatabaseSchemaIndex = {
		tables: ['Orders', 'Users'],
		columnTypesByTable: {
			Orders: { Id: 'long', Amount: 'real', Date: 'datetime' },
			Users: { Name: 'string', Active: 'bool', Email: 'string' }
		},
		tableDocStrings: { Orders: 'All orders table' },
		functions: [
			{
				name: 'GetOrders',
				parameters: [{ name: 'startDate', type: 'datetime' }],
				docString: 'Returns orders for a date range'
			}
		]
	};

	const charCountTokenizer = (text: string) => Promise.resolve(text.length);

	it('large budget → phase 0 (full schema, no pruning)', async () => {
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 100000, charCountTokenizer);
		expect(result.phase).toBe(0);
		expect(result.text).toContain('Types:');
		expect(result.text).toContain('Id(l)');
		expect(result.tokenCount).toBeLessThanOrEqual(result.tokenBudget);
	});

	it('small budget → higher pruning phase', async () => {
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 80, charCountTokenizer);
		expect(result.phase).toBeGreaterThanOrEqual(3);
		expect(result.tokenCount).toBeLessThanOrEqual(result.tokenBudget);
	});

	it('intermediate budget → uses progressive pruning', async () => {
		const fullText = formatSchemaWithOptions('TestDb', schema, undefined, {});
		const fullLen = fullText.length;
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullLen - 1, charCountTokenizer);
		expect(result.phase).toBeGreaterThanOrEqual(1);
	});

	it('very small budget → phase 5 hard truncation with cut-off notice', async () => {
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 5, charCountTokenizer);
		expect(result.phase).toBe(5);
		expect(result.text).toContain('schema cut off due to context window limits');
	});

	it('phase 5 with budget smaller than notice itself still returns notice', async () => {
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 1, charCountTokenizer);
		expect(result.phase).toBe(5);
		expect(result.text.length).toBeGreaterThan(0);
	});

	it('prune notice is appended for phases 1-4', async () => {
		const phase0Text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		const phase1Text = formatSchemaWithOptions('TestDb', schema, undefined, { dropTypes: true });
		if (phase1Text.length < phase0Text.length) {
			const budget = phase0Text.length - 1;
			const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, budget, charCountTokenizer);
			if (result.phase >= 1 && result.phase <= 4) {
				expect(result.text).toContain('[Note: Schema was reduced');
			}
		}
	});
});

describe('formatSchemaWithOptions – additional coverage', () => {
	it('tables are grouped by tableFolders', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['RootTable', 'SalesOrders', 'SalesProducts', 'SystemLogs'],
			columnTypesByTable: {
				RootTable: { Id: 'long' },
				SalesOrders: { Id: 'long', Amount: 'decimal' },
				SalesProducts: { Id: 'long', Name: 'string' },
				SystemLogs: { Id: 'long', Message: 'string' }
			},
			tableFolders: {
				SalesOrders: 'Sales',
				SalesProducts: 'Sales',
				SystemLogs: 'System'
			}
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		expect(text).toContain('## Sales');
		expect(text).toContain('## System');
		const rootIdx = text.indexOf('RootTable');
		const salesIdx = text.indexOf('## Sales');
		expect(rootIdx).toBeLessThan(salesIdx);
	});

	it('.NET type names are abbreviated correctly', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['T'],
			columnTypesByTable: {
				T: {
					col_str: 'System.String',
					col_long: 'System.Int64',
					col_int: 'System.Int32',
					col_dt: 'System.DateTime',
					col_ts: 'System.TimeSpan',
					col_dbl: 'System.Double',
					col_bool: 'System.Boolean',
					col_obj: 'System.Object',
					col_guid: 'System.Guid'
				}
			}
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		expect(text).toContain('col_str(s)');
		expect(text).toContain('col_long(l)');
		expect(text).toContain('col_int(i)');
		expect(text).toContain('col_dt(dt)');
		expect(text).toContain('col_ts(ts)');
		expect(text).toContain('col_dbl(r)');
		expect(text).toContain('col_bool(b)');
		expect(text).toContain('col_obj(d)');
		expect(text).toContain('col_guid(g)');
	});

	it('dropColumns: true preserves table docstrings', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['Users'],
			columnTypesByTable: { Users: { Id: 'long', Name: 'string' } },
			tableDocStrings: { Users: 'All registered users' }
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropColumns: true });
		expect(text).toContain('Users');
		expect(text).toContain('// All registered users');
		expect(text).not.toContain('Id');
	});

	it('function with defaultValue in parameters includes =value', () => {
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {},
			functions: [
				{
					name: 'GetData',
					parameters: [
						{ name: 'startDate', type: 'datetime' },
						{ name: 'limit', type: 'int', defaultValue: '100' }
					]
				}
			]
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		expect(text).toContain('limit:i=100');
		expect(text).toContain('startDate:dt');
	});

	it('dropFunctionParams: true with parametersText → just FuncName()', () => {
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {},
			functions: [
				{ name: 'Legacy', parametersText: 'x:string, y:long' }
			]
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropFunctionParams: true });
		expect(text).toContain('Legacy()');
		expect(text).not.toContain('x:string');
	});

	it('functions grouped by folder', () => {
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {},
			functions: [
				{ name: 'RootFunc' },
				{ name: 'GetOrders', folder: 'Sales' },
				{ name: 'GetRevenue', folder: 'Sales' },
				{ name: 'GetLogs', folder: 'System' }
			]
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		expect(text).toContain('## Sales');
		expect(text).toContain('## System');
		const rootIdx = text.indexOf('RootFunc');
		const salesIdx = text.indexOf('## Sales');
		expect(rootIdx).toBeLessThan(salesIdx);
	});
});

describe('getColumnsByTable – additional coverage', () => {
	it('backward compat: legacy columnsByTable field used when present', () => {
		const schema = {
			tables: ['T'],
			columnsByTable: { T: ['Alpha', 'Bravo', 'Charlie'] },
			columnTypesByTable: { T: { Alpha: 'string', Bravo: 'long', Charlie: 'bool' } }
		} as any;

		const result = getColumnsByTable(schema);
		expect(result['T']).toEqual(['Alpha', 'Bravo', 'Charlie']);
	});

	it('table with null column types entry is skipped', () => {
		const schema = makeSchema({
			tables: ['Good', 'Bad'],
			columnTypesByTable: {
				Good: { Id: 'long' },
				Bad: null as any
			}
		});
		const result = getColumnsByTable(schema);
		expect(result['Good']).toEqual(['Id']);
		expect(result['Bad']).toBeUndefined();
	});
});

// ── abbreviateType ───────────────────────────────────────────────────────────

describe('abbreviateType', () => {
	it('abbreviates standard KQL types', () => {
		expect(abbreviateType('string')).toBe('s');
		expect(abbreviateType('long')).toBe('l');
		expect(abbreviateType('int')).toBe('i');
		expect(abbreviateType('datetime')).toBe('dt');
		expect(abbreviateType('timespan')).toBe('ts');
		expect(abbreviateType('real')).toBe('r');
		expect(abbreviateType('double')).toBe('r');
		expect(abbreviateType('bool')).toBe('b');
		expect(abbreviateType('boolean')).toBe('b');
		expect(abbreviateType('dynamic')).toBe('d');
		expect(abbreviateType('guid')).toBe('g');
		expect(abbreviateType('decimal')).toBe('dec');
	});

	it('abbreviates .NET type names (case-insensitive)', () => {
		expect(abbreviateType('System.String')).toBe('s');
		expect(abbreviateType('System.Int64')).toBe('l');
		expect(abbreviateType('System.Int32')).toBe('i');
		expect(abbreviateType('System.DateTime')).toBe('dt');
		expect(abbreviateType('System.TimeSpan')).toBe('ts');
		expect(abbreviateType('System.Double')).toBe('r');
		expect(abbreviateType('System.Single')).toBe('r');
		expect(abbreviateType('System.SByte')).toBe('b');
		expect(abbreviateType('System.Boolean')).toBe('b');
		expect(abbreviateType('System.Object')).toBe('d');
		expect(abbreviateType('System.Guid')).toBe('g');
		expect(abbreviateType('System.Decimal')).toBe('dec');
	});

	it('returns original type for unknown types', () => {
		expect(abbreviateType('customtype')).toBe('customtype');
		expect(abbreviateType('SomeOtherType')).toBe('SomeOtherType');
	});

	it('handles empty/null input', () => {
		expect(abbreviateType('')).toBe('');
		// null/undefined fall through to the || type fallback, returning the original value
		expect(abbreviateType(null as any)).toBe(null);
		expect(abbreviateType(undefined as any)).toBe(undefined);
	});

	it('is case-insensitive', () => {
		expect(abbreviateType('STRING')).toBe('s');
		expect(abbreviateType('DateTime')).toBe('dt');
		expect(abbreviateType('BOOL')).toBe('b');
	});

	it('trims whitespace', () => {
		expect(abbreviateType('  string  ')).toBe('s');
		expect(abbreviateType(' long ')).toBe('l');
	});

	it('maps every entry in TYPE_ABBREVIATIONS correctly', () => {
		for (const [input, expected] of Object.entries(TYPE_ABBREVIATIONS)) {
			expect(abbreviateType(input)).toBe(expected);
		}
	});
});

// ── addPruneNotice ───────────────────────────────────────────────────────────

describe('addPruneNotice', () => {
	it('returns text unchanged for phase 0', () => {
		expect(addPruneNotice('hello', 0)).toBe('hello');
	});

	it('appends notice for phase 1', () => {
		const result = addPruneNotice('schema text', 1);
		expect(result).toContain('schema text');
		expect(result).toContain('[Note: Schema was reduced');
		expect(result).toContain('data types removed');
	});

	it('appends notice for phase 2', () => {
		const result = addPruneNotice('schema text', 2);
		expect(result).toContain('data types and docstrings removed');
	});

	it('appends notice for phase 3', () => {
		const result = addPruneNotice('schema text', 3);
		expect(result).toContain('column details removed');
	});

	it('appends notice for phase 4', () => {
		const result = addPruneNotice('schema text', 4);
		expect(result).toContain('column and function parameter details removed');
	});

	it('appends notice for phase 5', () => {
		const result = addPruneNotice('schema text', 5);
		expect(result).toContain('schema truncated due to context window limits');
	});

	it('preserves original text content', () => {
		const original = 'Database: TestDb\nTables: Orders, Users';
		const result = addPruneNotice(original, 3);
		expect(result.startsWith(original)).toBe(true);
	});
});

// ── formatSchemaAsCompactText ────────────────────────────────────────────────

describe('formatSchemaAsCompactText', () => {
	it('includes database name', () => {
		const schema = makeSchema({ tables: ['T'], columnTypesByTable: { T: { Id: 'long' } } });
		const text = formatSchemaAsCompactText('MyDb', schema);
		expect(text).toContain('Database: MyDb');
	});

	it('includes type legend', () => {
		const schema = makeSchema({ tables: ['T'], columnTypesByTable: { T: { Id: 'long' } } });
		const text = formatSchemaAsCompactText('MyDb', schema);
		expect(text).toContain('Types: s=string');
	});

	it('includes meta info when provided', () => {
		const schema = makeSchema({ tables: ['T'], columnTypesByTable: { T: { Id: 'long' } } });
		const text = formatSchemaAsCompactText('MyDb', schema, { tablesCount: 5, columnsCount: 20, functionsCount: 3 });
		expect(text).toContain('5 tables');
		expect(text).toContain('20 columns');
		expect(text).toContain('3 functions');
	});

	it('shows (none) for empty tables', () => {
		const text = formatSchemaAsCompactText('EmptyDb', makeSchema());
		expect(text).toContain('(none)');
	});

	it('shows (unknown) for null database name', () => {
		const text = formatSchemaAsCompactText('', makeSchema());
		expect(text).toContain('Database: (unknown)');
	});

	it('uses abbreviated types in column listing', () => {
		const schema = makeSchema({
			tables: ['T'],
			columnTypesByTable: { T: { Name: 'string', Created: 'datetime', Count: 'long' } },
		});
		const text = formatSchemaAsCompactText('Db', schema);
		expect(text).toContain('Name(s)');
		expect(text).toContain('Created(dt)');
		expect(text).toContain('Count(l)');
	});

	it('includes functions with abbreviated parameter types', () => {
		const schema = makeSchema({
			tables: ['T'],
			columnTypesByTable: { T: { Id: 'long' } },
			functions: [{ name: 'MyFunc', parameters: [{ name: 'start', type: 'datetime' }], docString: '' }],
		});
		const text = formatSchemaAsCompactText('Db', schema);
		expect(text).toContain('MyFunc(start:dt)');
	});
});
