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
});
