import * as assert from 'assert';

import { extractKqlSchemaMatchTokens, scoreSchemaMatch } from '../../src/kqlSchemaInference';
import type { DatabaseSchemaIndex } from '../../src/kustoClient';
import { formatSchemaAsCompactText, formatSchemaWithOptions, formatSchemaWithTokenBudget, PRUNE_PHASE_DESCRIPTIONS } from '../../src/schemaIndexUtils';
import type { SchemaPrunePhase } from '../../src/schemaIndexUtils';

suite('kqlSchemaInference', () => {
	test('extracts table references and function calls (best-effort)', () => {
		const q = `
// comment TableX | where x == 1
TableA
| where col == 1
| invoke MyDbFunc(123)
| join kind=inner (TableB) on id
`;
		const t = extractKqlSchemaMatchTokens(q);
		assert.ok(t.tableNamesLower.has('tablea'));
		assert.ok(t.tableNamesLower.has('tableb'));
		assert.ok(t.functionNamesLower.has('mydbfunc'));
		assert.ok(!t.allNamesLower.has('tablex'));
	});

	test('scores schemas with higher table match higher', () => {
		const tokens = extractKqlSchemaMatchTokens('TableA | invoke MyFunc()');
		const s1: DatabaseSchemaIndex = {
			tables: ['TableA'],
			columnTypesByTable: { TableA: { c: 'string' } },
			functions: [{ name: 'MyFunc' }]
		};
		const s2: DatabaseSchemaIndex = {
			tables: ['Other'],
			columnTypesByTable: { Other: { c: 'string' } },
			functions: [{ name: 'MyFunc' }]
		};
		assert.ok(scoreSchemaMatch(tokens, s1) > scoreSchemaMatch(tokens, s2));
	});
});

suite('formatSchemaAsCompactText', () => {
	test('formats schema with tables, columns, and functions', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['Users', 'Orders'],
			columnTypesByTable: {
				Users: { Id: 'long', Name: 'string', Email: 'string', CreatedAt: 'datetime' },
				Orders: { Id: 'long', UserId: 'long', Amount: 'decimal', Status: 'string' }
			},
			functions: [
				{ name: 'GetActiveUsers', parameters: [{ name: 'minDate', type: 'datetime' }, { name: 'maxAge', type: 'int' }] },
				{ name: 'SimpleFunc', parameters: [] }
			]
		};

		const result = formatSchemaAsCompactText('TestDb', schema, {
			tablesCount: 2,
			columnsCount: 8,
			functionsCount: 2,
			cacheAgeMs: 120000 // 2 minutes
		});

		// Check header
		assert.ok(result.includes('Database: TestDb'), 'should include database name');
		assert.ok(result.includes('Types: s=string'), 'should include type legend');

		// Check meta info
		assert.ok(result.includes('2 tables'), 'should include table count');
		assert.ok(result.includes('8 columns'), 'should include column count');
		assert.ok(result.includes('2 functions'), 'should include function count');
		assert.ok(result.includes('cached 2m ago'), 'should include cache age');

		// Check tables with abbreviated types
		assert.ok(result.includes('# Tables'), 'should have Tables section');
		assert.ok(result.includes('Users:'), 'should list Users table');
		assert.ok(result.includes('Id(l)'), 'should abbreviate long to l');
		assert.ok(result.includes('Name(s)'), 'should abbreviate string to s');
		assert.ok(result.includes('CreatedAt(dt)'), 'should abbreviate datetime to dt');
		assert.ok(result.includes('Amount(dec)'), 'should abbreviate decimal to dec');

		// Check functions
		assert.ok(result.includes('# Functions'), 'should have Functions section');
		assert.ok(result.includes('GetActiveUsers(minDate:dt, maxAge:i)'), 'should format function with params');
		assert.ok(result.includes('SimpleFunc()'), 'should format function without params');
	});

	test('uses abbreviated types correctly', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['TypeTest'],
			columnTypesByTable: {
				TypeTest: {
					col_string: 'string',
					col_long: 'long',
					col_int: 'int',
					col_datetime: 'datetime',
					col_timespan: 'timespan',
					col_real: 'real',
					col_double: 'double',
					col_bool: 'bool',
					col_dynamic: 'dynamic',
					col_guid: 'guid',
					col_unknown: 'customtype'
				}
			}
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		assert.ok(result.includes('col_string(s)'), 'string → s');
		assert.ok(result.includes('col_long(l)'), 'long → l');
		assert.ok(result.includes('col_int(i)'), 'int → i');
		assert.ok(result.includes('col_datetime(dt)'), 'datetime → dt');
		assert.ok(result.includes('col_timespan(ts)'), 'timespan → ts');
		assert.ok(result.includes('col_real(r)'), 'real → r');
		assert.ok(result.includes('col_double(r)'), 'double → r');
		assert.ok(result.includes('col_bool(b)'), 'bool → b');
		assert.ok(result.includes('col_dynamic(d)'), 'dynamic → d');
		assert.ok(result.includes('col_guid(g)'), 'guid → g');
		assert.ok(result.includes('col_unknown(customtype)'), 'unknown types preserved as-is');
	});

	test('handles empty schema gracefully', () => {
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {}
		};

		const result = formatSchemaAsCompactText('EmptyDb', schema);

		assert.ok(result.includes('Database: EmptyDb'));
		assert.ok(result.includes('# Tables'));
		assert.ok(result.includes('(none)'));
		assert.ok(!result.includes('# Functions'), 'should not include Functions section when empty');
	});

	test('handles functions with parametersText fallback', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['T'],
			columnTypesByTable: { T: { c: 'string' } },
			functions: [{ name: 'LegacyFunc', parametersText: 'x:string, y:long' }]
		};

		const result = formatSchemaAsCompactText('TestDb', schema);
		assert.ok(result.includes('LegacyFunc(x:string, y:long)'), 'should use parametersText fallback');
	});

	test('compact format is significantly smaller than JSON', () => {
		// Create a moderately large schema
		const tables: string[] = [];
		const columnTypesByTable: Record<string, Record<string, string>> = {};

		for (let i = 0; i < 50; i++) {
			const tableName = `Table${i}`;
			tables.push(tableName);
			columnTypesByTable[tableName] = {};
			for (let j = 0; j < 20; j++) {
				columnTypesByTable[tableName][`Column${j}`] = j % 2 === 0 ? 'string' : 'long';
			}
		}

		const schema: DatabaseSchemaIndex = { tables, columnTypesByTable };

		const compactText = formatSchemaAsCompactText('LargeDb', schema);
		const jsonText = JSON.stringify({ database: 'LargeDb', schema }, null, 2);

		// Compact format should be at least 50% smaller
		assert.ok(
			compactText.length < jsonText.length * 0.5,
			`Compact (${compactText.length}) should be <50% of JSON (${jsonText.length})`
		);
	});

	test('includes table docstrings as comments', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['Users', 'Orders'],
			columnTypesByTable: {
				Users: { Id: 'long', Name: 'string' },
				Orders: { Id: 'long', Amount: 'decimal' }
			},
			tableDocStrings: {
				Users: 'Contains all registered users',
				Orders: 'Transaction records for purchases'
			}
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		assert.ok(result.includes('Users:') && result.includes('// Contains all registered users'), 'should include Users table docstring');
		assert.ok(result.includes('Orders:') && result.includes('// Transaction records for purchases'), 'should include Orders table docstring');
	});

	test('includes column docstrings inline', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['Users'],
			columnTypesByTable: {
				Users: { Id: 'long', Email: 'string', Status: 'int' }
			},
			columnDocStrings: {
				'Users.Id': 'Unique user identifier',
				'Users.Email': 'Primary contact email'
			}
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		assert.ok(result.includes('Id(l "Unique user identifier")'), 'should include Id column docstring');
		assert.ok(result.includes('Email(s "Primary contact email")'), 'should include Email column docstring');
		assert.ok(result.includes('Status(i)'), 'should not include docstring for Status (none provided)');
	});

	test('includes function docstrings as comments', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['T'],
			columnTypesByTable: { T: { c: 'string' } },
			functions: [
				{ name: 'GetActiveUsers', parameters: [{ name: 'days', type: 'int' }], docString: 'Returns users active in the last N days' },
				{ name: 'SimpleFunc', parameters: [], docString: 'A simple utility function' }
			]
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		assert.ok(result.includes('GetActiveUsers(days:i)  // Returns users active in the last N days'), 'should include GetActiveUsers docstring');
		assert.ok(result.includes('SimpleFunc()  // A simple utility function'), 'should include SimpleFunc docstring');
	});

	test('includes full docstrings without truncation', () => {
		const longTableDoc = 'This is a very long table documentation string that exceeds the maximum allowed length for compact display';
		const longColDoc = 'This is a very long column documentation string that should be included in full';

		const schema: DatabaseSchemaIndex = {
			tables: ['LongDocTable'],
			columnTypesByTable: {
				LongDocTable: { LongDocCol: 'string' }
			},
			tableDocStrings: {
				LongDocTable: longTableDoc
			},
			columnDocStrings: {
				'LongDocTable.LongDocCol': longColDoc
			}
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		// Full table docstring should be included
		assert.ok(result.includes(`// ${longTableDoc}`), 'should include full table docstring');
		// Full column docstring should be included
		assert.ok(result.includes(`"${longColDoc}"`), 'should include full column docstring');
	});

	test('should group tables by folder', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['Orders', 'Users', 'Logs', 'Products'],
			columnTypesByTable: {
				Orders: { Id: 'long', Amount: 'decimal' },
				Users: { Id: 'long', Name: 'string' },
				Logs: { Id: 'long', Message: 'string' },
				Products: { Id: 'long', Name: 'string' }
			},
			tableFolders: {
				Orders: 'Sales',
				Products: 'Sales',
				Logs: 'System'
				// Users has no folder (root level)
			}
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		// Tables without folder should come first
		const usersIdx = result.indexOf('Users:');
		const salesIdx = result.indexOf('## Sales');
		const systemIdx = result.indexOf('## System');

		assert.ok(usersIdx !== -1, 'should include Users table');
		assert.ok(salesIdx !== -1, 'should include Sales folder header');
		assert.ok(systemIdx !== -1, 'should include System folder header');
		assert.ok(usersIdx < salesIdx, 'unfolderedtables should appear before folder headers');
		assert.ok(salesIdx < systemIdx, 'Sales folder should appear before System folder (alphabetically)');

		// Verify tables are under correct folders
		const ordersIdx = result.indexOf('Orders:');
		const productsIdx = result.indexOf('Products:');
		const logsIdx = result.indexOf('Logs:');

		assert.ok(ordersIdx > salesIdx, 'Orders should appear after Sales folder');
		assert.ok(productsIdx > salesIdx, 'Products should appear after Sales folder');
		assert.ok(logsIdx > systemIdx, 'Logs should appear after System folder');
	});

	test('should group functions by folder', () => {
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {},
			functions: [
				{ name: 'GetOrders', parametersText: 'startDate:datetime', folder: 'Sales' },
				{ name: 'GetUsers', parametersText: '', folder: undefined },
				{ name: 'LogEvent', parametersText: 'message:string', folder: 'System' },
				{ name: 'GetProducts', parametersText: '', folder: 'Sales' }
			]
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		// Functions without folder should come first
		const getUsersIdx = result.indexOf('GetUsers()');
		const salesIdx = result.indexOf('## Sales', result.indexOf('# Functions'));
		const systemIdx = result.indexOf('## System', result.indexOf('# Functions'));

		assert.ok(getUsersIdx !== -1, 'should include GetUsers function');
		assert.ok(salesIdx !== -1, 'should include Sales folder header in functions');
		assert.ok(systemIdx !== -1, 'should include System folder header in functions');
		assert.ok(getUsersIdx < salesIdx, 'unfoldered functions should appear before folder headers');

		// Verify functions are under correct folders
		const getOrdersIdx = result.indexOf('GetOrders(');
		const getProductsIdx = result.indexOf('GetProducts(');
		const logEventIdx = result.indexOf('LogEvent(');

		assert.ok(getOrdersIdx > salesIdx && getOrdersIdx < systemIdx, 'GetOrders should appear under Sales folder');
		assert.ok(getProductsIdx > salesIdx && getProductsIdx < systemIdx, 'GetProducts should appear under Sales folder');
		assert.ok(logEventIdx > systemIdx, 'LogEvent should appear under System folder');
	});

	test('should handle nested folder paths', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['RootTable', 'ChildTable', 'GrandchildTable'],
			columnTypesByTable: {
				RootTable: { Id: 'long' },
				ChildTable: { Id: 'long' },
				GrandchildTable: { Id: 'long' }
			},
			tableFolders: {
				ChildTable: 'Parent',
				GrandchildTable: 'Parent/Child'
			}
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		assert.ok(result.includes('## Parent\n'), 'should include Parent folder header');
		assert.ok(result.includes('## Parent/Child\n'), 'should include nested Parent/Child folder header');

		// Verify order: unfoldered, then Parent, then Parent/Child (alphabetically)
		const rootIdx = result.indexOf('RootTable:');
		const parentIdx = result.indexOf('## Parent\n');
		const parentChildIdx = result.indexOf('## Parent/Child');

		assert.ok(rootIdx < parentIdx, 'unfoldered table should come before Parent folder');
		assert.ok(parentIdx < parentChildIdx, 'Parent folder should come before Parent/Child folder');
	});
});

// ── Tests for formatSchemaWithOptions (phase-level formatting) ───────────

suite('formatSchemaWithOptions', () => {
	const richSchema: DatabaseSchemaIndex = {
		tables: ['Users', 'Orders'],
		columnTypesByTable: {
			Users: { Id: 'long', Name: 'string', Email: 'string' },
			Orders: { Id: 'long', UserId: 'long', Amount: 'decimal' }
		},
		tableDocStrings: {
			Users: 'All registered users',
			Orders: 'Purchase transactions'
		},
		columnDocStrings: {
			'Users.Id': 'Unique user ID',
			'Orders.Amount': 'Total order value'
		},
		functions: [
			{ name: 'GetActiveUsers', parameters: [{ name: 'days', type: 'int' }], docString: 'Returns active users' },
			{ name: 'CalcRevenue', parameters: [{ name: 'year', type: 'int' }, { name: 'region', type: 'string' }] }
		]
	};

	test('phase 0: identical to formatSchemaAsCompactText', () => {
		const full = formatSchemaAsCompactText('TestDb', richSchema);
		const withOpts = formatSchemaWithOptions('TestDb', richSchema, undefined, {});
		assert.strictEqual(withOpts, full);
	});

	test('phase 1 (dropTypes): removes type abbreviations from columns and function params', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, { dropTypes: true });
		// Column entries: should have the name without parenthesized type
		assert.ok(result.includes('Id, '), 'columns should be listed by name only');
		assert.ok(!result.includes('Id(l)'), 'should NOT have type abbreviation');
		// Docstrings should still be present
		assert.ok(result.includes('"Unique user ID"'), 'column docstrings should remain');
		assert.ok(result.includes('// All registered users'), 'table docstrings should remain');
		// Type legend should be omitted
		assert.ok(!result.includes('Types: s=string'), 'type legend should be omitted when dropTypes');
		// Function parameter types should be dropped
		assert.ok(result.includes('GetActiveUsers(days, ') || result.includes('GetActiveUsers(days)'), 'function param types dropped');
		assert.ok(!result.includes(':i)') && !result.includes(':dt)'), 'no type annotations on function params');
	});

	test('phase 2 (dropTypes + dropDocStrings): removes all docstrings', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, { dropTypes: true, dropDocStrings: true });
		assert.ok(!result.includes('Unique user ID'), 'column docstrings should be gone');
		assert.ok(!result.includes('All registered users'), 'table docstrings should be gone');
		assert.ok(!result.includes('Returns active users'), 'function docstrings should be gone');
		// Columns should still be listed
		assert.ok(result.includes('Id, '), 'columns should still be listed by name');
	});

	test('phase 3 (dropColumns): table lines have just the name, no columns', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, {
			dropTypes: true, dropDocStrings: true, dropColumns: true
		});
		// Each table is just its name on a line (no colon, no columns)
		const lines = result.split('\n');
		const usersLine = lines.find(l => l.trim().startsWith('Users'));
		assert.ok(usersLine, 'should have Users line');
		assert.ok(!usersLine!.includes(':'), 'Users line should not have a colon (no columns)');
		assert.ok(!usersLine!.includes('Id'), 'Users line should not have column names');
		// Functions should still have params
		assert.ok(result.includes('GetActiveUsers(days'), 'functions should still have params');
	});

	test('phase 4 (dropFunctionParams): function lines have just the name', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, {
			dropTypes: true, dropDocStrings: true, dropColumns: true, dropFunctionParams: true
		});
		assert.ok(result.includes('GetActiveUsers()'), 'function should have empty parens');
		assert.ok(result.includes('CalcRevenue()'), 'function should have empty parens');
		assert.ok(!result.includes('days'), 'should not have param name');
	});

	test('meta info is preserved across all phases', () => {
		const meta = { tablesCount: 2, columnsCount: 6, functionsCount: 2, cacheAgeMs: 60000 };
		const result = formatSchemaWithOptions('TestDb', richSchema, meta, {
			dropTypes: true, dropDocStrings: true, dropColumns: true, dropFunctionParams: true
		});
		assert.ok(result.includes('2 tables'), 'should include meta table count');
		assert.ok(result.includes('6 columns'), 'should include meta column count');
		assert.ok(result.includes('cached 1m ago'), 'should include meta cache age');
	});
});

// ── Tests for formatSchemaWithTokenBudget (progressive pruning) ──────────

suite('formatSchemaWithTokenBudget', () => {
	// Simple mock tokenizer: 1 token per 4 characters (rough approximation)
	const mockCountTokens = async (text: string): Promise<number> => Math.ceil(text.length / 4);

	function makeLargeSchema(tableCount: number, colsPerTable: number): DatabaseSchemaIndex {
		const tables: string[] = [];
		const columnTypesByTable: Record<string, Record<string, string>> = {};
		const tableDocStrings: Record<string, string> = {};
		const columnDocStrings: Record<string, string> = {};
		for (let i = 0; i < tableCount; i++) {
			const tableName = `Table${String(i).padStart(4, '0')}`;
			tables.push(tableName);
			columnTypesByTable[tableName] = {};
			tableDocStrings[tableName] = `Documentation for ${tableName} with some extra text to pad it out`;
			for (let j = 0; j < colsPerTable; j++) {
				const colName = `Column${String(j).padStart(3, '0')}`;
				columnTypesByTable[tableName][colName] = j % 3 === 0 ? 'string' : j % 3 === 1 ? 'long' : 'datetime';
				columnDocStrings[`${tableName}.${colName}`] = `Description of ${colName}`;
			}
		}
		return {
			tables,
			columnTypesByTable,
			tableDocStrings,
			columnDocStrings,
			functions: Array.from({ length: 20 }, (_, i) => ({
				name: `Func${i}`,
				parameters: [{ name: 'param1', type: 'string' }, { name: 'param2', type: 'int' }],
				docString: `Function ${i} documentation`
			}))
		};
	}

	test('phase 0: returns full schema when it fits', async () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['T1'],
			columnTypesByTable: { T1: { Id: 'long' } }
		};
		const result = await formatSchemaWithTokenBudget('SmallDb', schema, undefined, 100000, mockCountTokens);
		assert.strictEqual(result.phase, 0, 'should be phase 0 (full schema)');
		assert.ok(result.text.includes('Id(l)'), 'should include full column types');
	});

	test('returns decreasing text length for each successive phase', async () => {
		const schema = makeLargeSchema(100, 15); // reasonably large
		const fullText = formatSchemaAsCompactText('TestDb', schema);
		const fullTokens = await mockCountTokens(fullText);

		// Phase 0 fits
		const r0 = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullTokens + 100, mockCountTokens);
		assert.strictEqual(r0.phase, 0);

		// Force each phase by using progressively smaller budgets
		const sizes: number[] = [r0.text.length];

		for (let targetPhase = 1; targetPhase <= 4; targetPhase++) {
			// Budget that just barely doesn't fit the previous phase
			const prevTokens = await mockCountTokens(sizes[sizes.length - 1].toString().length > 0
				? formatSchemaWithOptions('TestDb', schema, undefined,
					targetPhase === 1 ? {} :
					targetPhase === 2 ? { dropTypes: true } :
					targetPhase === 3 ? { dropTypes: true, dropDocStrings: true } :
					{ dropTypes: true, dropDocStrings: true, dropColumns: true })
				: '');
			// Use a budget smaller than previous phase but large enough for current
			const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, prevTokens - 1, mockCountTokens);
			assert.ok(result.phase >= targetPhase, `should reach at least phase ${targetPhase}, got phase ${result.phase}`);
			sizes.push(result.text.length);
		}

		// Each phase's output should be smaller or equal in length
		for (let i = 1; i < sizes.length; i++) {
			assert.ok(sizes[i] <= sizes[i - 1], `phase ${i} text (${sizes[i]} chars) should be <= phase ${i - 1} text (${sizes[i - 1]} chars)`);
		}
	});

	test('phase 5: truncates with cut-off message when budget is very small', async () => {
		const schema = makeLargeSchema(200, 10);
		// Very small budget that can't even fit table names
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 50, mockCountTokens);
		assert.strictEqual(result.phase, 5, 'should be phase 5 (truncated)');
		assert.ok(result.text.includes('schema cut off due to context window limits'), 'should include cut-off notice');
	});

	test('prune notice is included for phases 1-4', async () => {
		const schema = makeLargeSchema(50, 10);
		const fullText = formatSchemaAsCompactText('TestDb', schema);
		const fullTokens = await mockCountTokens(fullText);

		// Use a budget that's just under the full schema
		const r1 = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullTokens - 1, mockCountTokens);
		if (r1.phase >= 1 && r1.phase <= 4) {
			const desc = PRUNE_PHASE_DESCRIPTIONS[r1.phase as SchemaPrunePhase];
			assert.ok(r1.text.includes(desc), `should include prune phase description "${desc}"`);
			assert.ok(r1.text.includes('[Note:'), 'should include [Note: prefix');
		}
	});

	test('tokenCount is within budget', async () => {
		const schema = makeLargeSchema(100, 10);
		const budget = 500;
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, budget, mockCountTokens);
		assert.ok(result.tokenCount <= budget, `tokenCount (${result.tokenCount}) should be within budget (${budget})`);
		assert.strictEqual(result.tokenBudget, budget, 'should report the budget used');
	});

	test('handles schema with no functions gracefully during pruning', async () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['A', 'B', 'C'],
			columnTypesByTable: {
				A: { x: 'string' },
				B: { y: 'long' },
				C: { z: 'datetime' }
			}
		};
		// Budget smaller than full but reasonable
		const fullText = formatSchemaAsCompactText('TestDb', schema);
		const fullTokens = await mockCountTokens(fullText);
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullTokens - 1, mockCountTokens);
		assert.ok(result.phase >= 1, 'should prune since budget is under full');
		assert.ok(!result.text.includes('# Functions'), 'should have no functions section');
	});
});
