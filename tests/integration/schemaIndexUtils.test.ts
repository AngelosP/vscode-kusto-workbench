import * as assert from 'assert';
import { DatabaseSchemaIndex } from '../../src/host/kustoClient';
import {
	getColumnsByTable,
	countColumns,
	formatSchemaWithOptions,
	formatSchemaWithTokenBudget,
	SchemaFormatOptions
} from '../../src/host/schemaIndexUtils';

function makeSchema(overrides?: Partial<DatabaseSchemaIndex>): DatabaseSchemaIndex {
	return {
		tables: [],
		columnTypesByTable: {},
		...overrides
	};
}

suite('getColumnsByTable', () => {
	test('schema with 2 tables → correct column mapping', () => {
		const schema = makeSchema({
			tables: ['Orders', 'Users'],
			columnTypesByTable: {
				Orders: { Id: 'long', Amount: 'real', Date: 'datetime' },
				Users: { Id: 'long', Name: 'string', Email: 'string' }
			}
		});
		const result = getColumnsByTable(schema);
		assert.deepStrictEqual(result['Orders'], ['Amount', 'Date', 'Id']);
		assert.deepStrictEqual(result['Users'], ['Email', 'Id', 'Name']);
	});

	test('empty schema → empty object', () => {
		const result = getColumnsByTable(makeSchema());
		assert.deepStrictEqual(result, {});
	});

	test('null/undefined schema → empty object', () => {
		assert.deepStrictEqual(getColumnsByTable(null), {});
		assert.deepStrictEqual(getColumnsByTable(undefined), {});
	});

	test('table with no column types → empty array for that table', () => {
		const schema = makeSchema({
			tables: ['Empty'],
			columnTypesByTable: { Empty: {} }
		});
		const result = getColumnsByTable(schema);
		assert.deepStrictEqual(result['Empty'], []);
	});

	test('columns are sorted alphabetically', () => {
		const schema = makeSchema({
			tables: ['T'],
			columnTypesByTable: { T: { Zebra: 'string', Alpha: 'string', Middle: 'string' } }
		});
		const result = getColumnsByTable(schema);
		assert.deepStrictEqual(result['T'], ['Alpha', 'Middle', 'Zebra']);
	});
});

suite('countColumns', () => {
	test('2 tables with 3+2 columns → 5', () => {
		const schema = makeSchema({
			tables: ['A', 'B'],
			columnTypesByTable: {
				A: { c1: 'string', c2: 'long', c3: 'bool' },
				B: { c4: 'datetime', c5: 'real' }
			}
		});
		assert.strictEqual(countColumns(schema), 5);
	});

	test('empty schema → 0', () => {
		assert.strictEqual(countColumns(makeSchema()), 0);
	});

	test('null/undefined schema → 0', () => {
		assert.strictEqual(countColumns(null), 0);
		assert.strictEqual(countColumns(undefined), 0);
	});

	test('single table with 10 columns → 10', () => {
		const cols: Record<string, string> = {};
		for (let i = 0; i < 10; i++) {
			cols[`col${i}`] = 'string';
		}
		const schema = makeSchema({
			tables: ['Big'],
			columnTypesByTable: { Big: cols }
		});
		assert.strictEqual(countColumns(schema), 10);
	});
});

suite('formatSchemaWithOptions', () => {
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

	test('default options (no pruning) → full output with types, docstrings, columns', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		assert.ok(text.includes('Database: TestDb'));
		assert.ok(text.includes('Types:'));
		assert.ok(text.includes('Id(l)'));
		assert.ok(text.includes('Amount(r)'));
		assert.ok(text.includes('// All orders'));
		assert.ok(text.includes('"Full name"'));
		assert.ok(text.includes('GetOrders(startDate:dt)'));
		assert.ok(text.includes('// Returns orders'));
	});

	test('dropTypes: true → no type annotations on columns', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropTypes: true });
		// Column names present, but no (l), (r), etc.
		assert.ok(text.includes('Id'));
		assert.ok(!text.includes('Id(l)'));
		assert.ok(!text.includes('Amount(r)'));
		// Type legend line should be absent
		assert.ok(!text.includes('Types:'));
		// Function parameter should not have type either
		assert.ok(text.includes('GetOrders(startDate)'));
		assert.ok(!text.includes('startDate:dt'));
	});

	test('dropDocStrings: true → no docstring comments', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropDocStrings: true });
		assert.ok(!text.includes('// All orders'));
		assert.ok(!text.includes('"Full name"'));
		assert.ok(!text.includes('// Returns orders'));
		// Types should still be present
		assert.ok(text.includes('Id(l)'));
	});

	test('dropColumns: true → tables listed but no column details', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropColumns: true });
		assert.ok(text.includes('Orders'));
		assert.ok(text.includes('Users'));
		// Individual columns should not appear
		assert.ok(!text.includes('Id('));
		assert.ok(!text.includes('Amount('));
		assert.ok(!text.includes('Name('));
	});

	test('dropFunctionParams: true → functions listed without parameters', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropFunctionParams: true });
		assert.ok(text.includes('GetOrders()'));
		assert.ok(!text.includes('startDate'));
	});

	test('combined: dropTypes + dropDocStrings → both removed', () => {
		const text = formatSchemaWithOptions('TestDb', schema, undefined, {
			dropTypes: true,
			dropDocStrings: true
		});
		assert.ok(!text.includes('Types:'));
		assert.ok(!text.includes('// All orders'));
		assert.ok(!text.includes('"Full name"'));
		assert.ok(!text.includes('(l)'));
		// Column names still present
		assert.ok(text.includes('Id'));
		assert.ok(text.includes('Amount'));
	});

	test('empty schema → shows (none) for tables', () => {
		const text = formatSchemaWithOptions('EmptyDb', makeSchema(), undefined, {});
		assert.ok(text.includes('# Tables'));
		assert.ok(text.includes('(none)'));
	});

	test('meta info is included when provided', () => {
		const text = formatSchemaWithOptions('TestDb', schema, {
			tablesCount: 2,
			columnsCount: 4,
			functionsCount: 1
		}, {});
		assert.ok(text.includes('Info:'));
		assert.ok(text.includes('2 tables'));
		assert.ok(text.includes('4 columns'));
		assert.ok(text.includes('1 functions'));
	});
});

suite('formatSchemaWithTokenBudget', () => {
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

	// Simple character-count tokenizer mock
	const charCountTokenizer = (text: string) => Promise.resolve(text.length);

	test('large budget → phase 0 (full schema, no pruning)', async () => {
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 100000, charCountTokenizer);
		assert.strictEqual(result.phase, 0);
		assert.ok(result.text.includes('Types:'));
		assert.ok(result.text.includes('Id(l)'));
		assert.ok(result.tokenCount <= result.tokenBudget);
	});

	test('small budget → higher pruning phase', async () => {
		// Use a budget that fits the header but not the full schema, forcing pruning
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 80, charCountTokenizer);
		assert.ok(result.phase >= 3, `expected phase >= 3, got ${result.phase}`);
		assert.ok(result.tokenCount <= result.tokenBudget, 'token count should be within budget');
	});

	test('intermediate budget → uses progressive pruning', async () => {
		// Find the full text length, then set budget just below to trigger pruning
		const fullText = formatSchemaWithOptions('TestDb', schema, undefined, {});
		const fullLen = fullText.length;
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullLen - 1, charCountTokenizer);
		assert.ok(result.phase >= 1, `expected phase >= 1, got ${result.phase}`);
	});

	test('very small budget → phase 5 hard truncation with cut-off notice', async () => {
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 5, charCountTokenizer);
		assert.strictEqual(result.phase, 5, 'extremely small budget should trigger phase 5');
		assert.ok(result.text.includes('schema cut off due to context window limits'),
			'phase 5 output should include cut-off notice');
	});

	test('phase 5 with budget smaller than notice itself still returns notice', async () => {
		// Budget of 1 is smaller than the cut-off notice alone
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 1, charCountTokenizer);
		assert.strictEqual(result.phase, 5);
		// Should not throw; text should contain at least the notice
		assert.ok(result.text.length > 0, 'output should not be empty');
	});

	test('prune notice is appended for phases 1-4', async () => {
		// Use a budget that only fits phase 1 (dropTypes)
		const phase0Text = formatSchemaWithOptions('TestDb', schema, undefined, {});
		const phase1Text = formatSchemaWithOptions('TestDb', schema, undefined, { dropTypes: true });
		// Budget fits phase1 but not phase0
		if (phase1Text.length < phase0Text.length) {
			const budget = phase0Text.length - 1; // too small for phase 0
			const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, budget, charCountTokenizer);
			if (result.phase >= 1 && result.phase <= 4) {
				assert.ok(result.text.includes('[Note: Schema was reduced'),
					'phases 1-4 should include prune notice');
			}
		}
	});
});

suite('formatSchemaWithOptions – additional coverage', () => {
	test('tables are grouped by tableFolders', () => {
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
		assert.ok(text.includes('## Sales'), 'should have Sales folder header');
		assert.ok(text.includes('## System'), 'should have System folder header');
		// RootTable should appear before any folder header (it has no folder)
		const rootIdx = text.indexOf('RootTable');
		const salesIdx = text.indexOf('## Sales');
		assert.ok(rootIdx < salesIdx, 'root table should appear before folder sections');
	});

	test('.NET type names are abbreviated correctly', () => {
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
		assert.ok(text.includes('col_str(s)'), 'System.String → s');
		assert.ok(text.includes('col_long(l)'), 'System.Int64 → l');
		assert.ok(text.includes('col_int(i)'), 'System.Int32 → i');
		assert.ok(text.includes('col_dt(dt)'), 'System.DateTime → dt');
		assert.ok(text.includes('col_ts(ts)'), 'System.TimeSpan → ts');
		assert.ok(text.includes('col_dbl(r)'), 'System.Double → r');
		assert.ok(text.includes('col_bool(b)'), 'System.Boolean → b');
		assert.ok(text.includes('col_obj(d)'), 'System.Object → d');
		assert.ok(text.includes('col_guid(g)'), 'System.Guid → g');
	});

	test('dropColumns: true preserves table docstrings', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['Users'],
			columnTypesByTable: { Users: { Id: 'long', Name: 'string' } },
			tableDocStrings: { Users: 'All registered users' }
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropColumns: true });
		assert.ok(text.includes('Users'), 'table name should still be present');
		assert.ok(text.includes('// All registered users'), 'table docstring should be preserved');
		assert.ok(!text.includes('Id'), 'column names should be hidden');
	});

	test('function with defaultValue in parameters includes =value', () => {
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
		assert.ok(text.includes('limit:i=100'), 'should include default value');
		assert.ok(text.includes('startDate:dt'), 'should include type without default');
	});

	test('dropFunctionParams: true with parametersText → just FuncName()', () => {
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {},
			functions: [
				{ name: 'Legacy', parametersText: 'x:string, y:long' }
			]
		};

		const text = formatSchemaWithOptions('TestDb', schema, undefined, { dropFunctionParams: true });
		assert.ok(text.includes('Legacy()'), 'should show function with empty parens');
		assert.ok(!text.includes('x:string'), 'parameters should be hidden');
	});

	test('functions grouped by folder', () => {
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
		assert.ok(text.includes('## Sales'), 'should have Sales folder header');
		assert.ok(text.includes('## System'), 'should have System folder header');
		const rootIdx = text.indexOf('RootFunc');
		const salesIdx = text.indexOf('## Sales');
		assert.ok(rootIdx < salesIdx, 'root functions should appear before folder sections');
	});
});

suite('getColumnsByTable – additional coverage', () => {
	test('backward compat: legacy columnsByTable field used when present', () => {
		const schema = {
			tables: ['T'],
			columnsByTable: { T: ['Alpha', 'Bravo', 'Charlie'] },
			columnTypesByTable: { T: { Alpha: 'string', Bravo: 'long', Charlie: 'bool' } }
		} as any;

		const result = getColumnsByTable(schema);
		// When columnsByTable is present, it takes precedence
		assert.deepStrictEqual(result['T'], ['Alpha', 'Bravo', 'Charlie']);
	});

	test('table with null column types entry is skipped', () => {
		const schema = makeSchema({
			tables: ['Good', 'Bad'],
			columnTypesByTable: {
				Good: { Id: 'long' },
				Bad: null as any
			}
		});
		const result = getColumnsByTable(schema);
		assert.deepStrictEqual(result['Good'], ['Id']);
		assert.strictEqual(result['Bad'], undefined, 'null entry should be skipped');
	});
});
