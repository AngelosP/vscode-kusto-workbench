import { describe, it, expect } from 'vitest';
import { extractKqlSchemaMatchTokens, scoreSchemaMatch } from '../../../src/host/kqlSchemaInference';
import type { DatabaseSchemaIndex } from '../../../src/host/kustoClient';
import { formatSchemaAsCompactText, formatSchemaWithOptions, formatSchemaWithTokenBudget, PRUNE_PHASE_DESCRIPTIONS } from '../../../src/host/schemaIndexUtils';
import type { SchemaPrunePhase } from '../../../src/host/schemaIndexUtils';

describe('kqlSchemaInference', () => {
	it('extracts table references and function calls (best-effort)', () => {
		const q = `
// comment TableX | where x == 1
TableA
| where col == 1
| invoke MyDbFunc(123)
| join kind=inner (TableB) on id
`;
		const t = extractKqlSchemaMatchTokens(q);
		expect(t.tableNamesLower.has('tablea')).toBe(true);
		expect(t.tableNamesLower.has('tableb')).toBe(true);
		expect(t.functionNamesLower.has('mydbfunc')).toBe(true);
		expect(t.allNamesLower.has('tablex')).toBe(false);
	});

	it('scores schemas with higher table match higher', () => {
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
		expect(scoreSchemaMatch(tokens, s1)).toBeGreaterThan(scoreSchemaMatch(tokens, s2));
	});

	it('empty query returns empty token sets', () => {
		const t = extractKqlSchemaMatchTokens('');
		expect(t.tableNamesLower.size).toBe(0);
		expect(t.functionNamesLower.size).toBe(0);
		expect(t.allNamesLower.size).toBe(0);
	});

	it('whitespace-only query returns empty token sets', () => {
		const t = extractKqlSchemaMatchTokens('   \t\n  ');
		expect(t.tableNamesLower.size).toBe(0);
		expect(t.functionNamesLower.size).toBe(0);
	});

	it('query with only comments returns empty token sets', () => {
		const t = extractKqlSchemaMatchTokens('// TableA\n/* TableB */\n');
		expect(t.tableNamesLower.size).toBe(0);
		expect(t.functionNamesLower.size).toBe(0);
	});

	it('function names inside string literals are not extracted', () => {
		const t = extractKqlSchemaMatchTokens('TableA | where col == "MyFunc()"');
		expect(t.functionNamesLower.has('myfunc')).toBe(false);
		expect(t.tableNamesLower.has('tablea')).toBe(true);
	});

	it('function names inside single-quoted strings are not extracted', () => {
		const t = extractKqlSchemaMatchTokens("TableA | where col == 'SomeFunc()'");
		expect(t.functionNamesLower.has('somefunc')).toBe(false);
	});

	it('built-in operator names are excluded from function extraction (stoplist)', () => {
		const q = 'TableA | where(x > 1) | summarize count() | extend y = iif(x,1,0) | join(TableB) on id';
		const t = extractKqlSchemaMatchTokens(q);
		expect(t.functionNamesLower.has('count')).toBe(false);
		expect(t.functionNamesLower.has('iif')).toBe(false);
		expect(t.functionNamesLower.has('where')).toBe(false);
		expect(t.functionNamesLower.has('summarize')).toBe(false);
		expect(t.functionNamesLower.has('join')).toBe(false);
	});

	it('scoreSchemaMatch returns 0 for null/undefined inputs', () => {
		const tokens = extractKqlSchemaMatchTokens('TableA');
		expect(scoreSchemaMatch(tokens, null)).toBe(0);
		expect(scoreSchemaMatch(tokens, undefined)).toBe(0);
		expect(scoreSchemaMatch(null as any, { tables: ['TableA'], columnTypesByTable: {} })).toBe(0);
	});

	it('scoreSchemaMatch scores function matches at weight 1', () => {
		const tokens = extractKqlSchemaMatchTokens('invoke MyFunc()');
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {},
			functions: [{ name: 'MyFunc' }]
		};
		expect(scoreSchemaMatch(tokens, schema)).toBe(1);
	});

	it('scoreSchemaMatch weights table matches higher than function matches', () => {
		const tokens = extractKqlSchemaMatchTokens('TableA | invoke MyFunc()');
		const tableOnly: DatabaseSchemaIndex = {
			tables: ['TableA'],
			columnTypesByTable: { TableA: { c: 's' } }
		};
		const funcOnly: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {},
			functions: [{ name: 'MyFunc' }]
		};
		expect(scoreSchemaMatch(tokens, tableOnly)).toBeGreaterThan(scoreSchemaMatch(tokens, funcOnly));
	});
});

describe('formatSchemaAsCompactText', () => {
	it('formats schema with tables, columns, and functions', () => {
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
			cacheAgeMs: 120000
		});

		expect(result).toContain('Database: TestDb');
		expect(result).toContain('Types: s=string');
		expect(result).toContain('2 tables');
		expect(result).toContain('8 columns');
		expect(result).toContain('2 functions');
		expect(result).toContain('cached 2m ago');
		expect(result).toContain('# Tables');
		expect(result).toContain('Users:');
		expect(result).toContain('Id(l)');
		expect(result).toContain('Name(s)');
		expect(result).toContain('CreatedAt(dt)');
		expect(result).toContain('Amount(dec)');
		expect(result).toContain('# Functions');
		expect(result).toContain('GetActiveUsers(minDate:dt, maxAge:i)');
		expect(result).toContain('SimpleFunc()');
	});

	it('uses abbreviated types correctly', () => {
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

		expect(result).toContain('col_string(s)');
		expect(result).toContain('col_long(l)');
		expect(result).toContain('col_int(i)');
		expect(result).toContain('col_datetime(dt)');
		expect(result).toContain('col_timespan(ts)');
		expect(result).toContain('col_real(r)');
		expect(result).toContain('col_double(r)');
		expect(result).toContain('col_bool(b)');
		expect(result).toContain('col_dynamic(d)');
		expect(result).toContain('col_guid(g)');
		expect(result).toContain('col_unknown(customtype)');
	});

	it('handles empty schema gracefully', () => {
		const schema: DatabaseSchemaIndex = {
			tables: [],
			columnTypesByTable: {}
		};

		const result = formatSchemaAsCompactText('EmptyDb', schema);

		expect(result).toContain('Database: EmptyDb');
		expect(result).toContain('# Tables');
		expect(result).toContain('(none)');
		expect(result).not.toContain('# Functions');
	});

	it('handles functions with parametersText fallback', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['T'],
			columnTypesByTable: { T: { c: 'string' } },
			functions: [{ name: 'LegacyFunc', parametersText: 'x:string, y:long' }]
		};

		const result = formatSchemaAsCompactText('TestDb', schema);
		expect(result).toContain('LegacyFunc(x:string, y:long)');
	});

	it('compact format is significantly smaller than JSON', () => {
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

		expect(compactText.length).toBeLessThan(jsonText.length * 0.5);
	});

	it('includes table docstrings as comments', () => {
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

		expect(result).toContain('// Contains all registered users');
		expect(result).toContain('// Transaction records for purchases');
	});

	it('includes column docstrings inline', () => {
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

		expect(result).toContain('Id(l "Unique user identifier")');
		expect(result).toContain('Email(s "Primary contact email")');
		expect(result).toContain('Status(i)');
	});

	it('includes function docstrings as comments', () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['T'],
			columnTypesByTable: { T: { c: 'string' } },
			functions: [
				{ name: 'GetActiveUsers', parameters: [{ name: 'days', type: 'int' }], docString: 'Returns users active in the last N days' },
				{ name: 'SimpleFunc', parameters: [], docString: 'A simple utility function' }
			]
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		expect(result).toContain('GetActiveUsers(days:i)  // Returns users active in the last N days');
		expect(result).toContain('SimpleFunc()  // A simple utility function');
	});

	it('includes full docstrings without truncation', () => {
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

		expect(result).toContain(`// ${longTableDoc}`);
		expect(result).toContain(`"${longColDoc}"`);
	});

	it('should group tables by folder', () => {
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
			}
		};

		const result = formatSchemaAsCompactText('TestDb', schema);

		const usersIdx = result.indexOf('Users:');
		const salesIdx = result.indexOf('## Sales');
		const systemIdx = result.indexOf('## System');

		expect(usersIdx).not.toBe(-1);
		expect(salesIdx).not.toBe(-1);
		expect(systemIdx).not.toBe(-1);
		expect(usersIdx).toBeLessThan(salesIdx);
		expect(salesIdx).toBeLessThan(systemIdx);

		const ordersIdx = result.indexOf('Orders:');
		const productsIdx = result.indexOf('Products:');
		const logsIdx = result.indexOf('Logs:');

		expect(ordersIdx).toBeGreaterThan(salesIdx);
		expect(productsIdx).toBeGreaterThan(salesIdx);
		expect(logsIdx).toBeGreaterThan(systemIdx);
	});

	it('should group functions by folder', () => {
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

		const getUsersIdx = result.indexOf('GetUsers()');
		const salesIdx = result.indexOf('## Sales', result.indexOf('# Functions'));
		const systemIdx = result.indexOf('## System', result.indexOf('# Functions'));

		expect(getUsersIdx).not.toBe(-1);
		expect(salesIdx).not.toBe(-1);
		expect(systemIdx).not.toBe(-1);
		expect(getUsersIdx).toBeLessThan(salesIdx);

		const getOrdersIdx = result.indexOf('GetOrders(');
		const getProductsIdx = result.indexOf('GetProducts(');
		const logEventIdx = result.indexOf('LogEvent(');

		expect(getOrdersIdx).toBeGreaterThan(salesIdx);
		expect(getOrdersIdx).toBeLessThan(systemIdx);
		expect(getProductsIdx).toBeGreaterThan(salesIdx);
		expect(getProductsIdx).toBeLessThan(systemIdx);
		expect(logEventIdx).toBeGreaterThan(systemIdx);
	});

	it('should handle nested folder paths', () => {
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

		expect(result).toContain('## Parent\n');
		expect(result).toContain('## Parent/Child\n');

		const rootIdx = result.indexOf('RootTable:');
		const parentIdx = result.indexOf('## Parent\n');
		const parentChildIdx = result.indexOf('## Parent/Child');

		expect(rootIdx).toBeLessThan(parentIdx);
		expect(parentIdx).toBeLessThan(parentChildIdx);
	});
});

// ── Tests for formatSchemaWithOptions (phase-level formatting) ───────────

describe('formatSchemaWithOptions', () => {
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

	it('phase 0: identical to formatSchemaAsCompactText', () => {
		const full = formatSchemaAsCompactText('TestDb', richSchema);
		const withOpts = formatSchemaWithOptions('TestDb', richSchema, undefined, {});
		expect(withOpts).toBe(full);
	});

	it('phase 1 (dropTypes): removes type abbreviations from columns and function params', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, { dropTypes: true });
		expect(result).toContain('Id, ');
		expect(result).not.toContain('Id(l)');
		expect(result).toContain('"Unique user ID"');
		expect(result).toContain('// All registered users');
		expect(result).not.toContain('Types: s=string');
		expect(result.includes('GetActiveUsers(days, ') || result.includes('GetActiveUsers(days)')).toBe(true);
		expect(result.includes(':i)') || result.includes(':dt)')).toBe(false);
	});

	it('phase 2 (dropTypes + dropDocStrings): removes all docstrings', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, { dropTypes: true, dropDocStrings: true });
		expect(result).not.toContain('Unique user ID');
		expect(result).not.toContain('All registered users');
		expect(result).not.toContain('Returns active users');
		expect(result).toContain('Id, ');
	});

	it('phase 3 (dropColumns): table lines have just the name, no columns', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, {
			dropTypes: true, dropDocStrings: true, dropColumns: true
		});
		const lines = result.split('\n');
		const usersLine = lines.find(l => l.trim().startsWith('Users'));
		expect(usersLine).toBeDefined();
		expect(usersLine!).not.toContain(':');
		expect(usersLine!).not.toContain('Id');
		expect(result).toContain('GetActiveUsers(days');
	});

	it('phase 4 (dropFunctionParams): function lines have just the name', () => {
		const result = formatSchemaWithOptions('TestDb', richSchema, undefined, {
			dropTypes: true, dropDocStrings: true, dropColumns: true, dropFunctionParams: true
		});
		expect(result).toContain('GetActiveUsers()');
		expect(result).toContain('CalcRevenue()');
		expect(result).not.toContain('days');
	});

	it('meta info is preserved across all phases', () => {
		const meta = { tablesCount: 2, columnsCount: 6, functionsCount: 2, cacheAgeMs: 60000 };
		const result = formatSchemaWithOptions('TestDb', richSchema, meta, {
			dropTypes: true, dropDocStrings: true, dropColumns: true, dropFunctionParams: true
		});
		expect(result).toContain('2 tables');
		expect(result).toContain('6 columns');
		expect(result).toContain('cached 1m ago');
	});
});

// ── Tests for formatSchemaWithTokenBudget (progressive pruning) ──────────

describe('formatSchemaWithTokenBudget', () => {
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

	it('phase 0: returns full schema when it fits', async () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['T1'],
			columnTypesByTable: { T1: { Id: 'long' } }
		};
		const result = await formatSchemaWithTokenBudget('SmallDb', schema, undefined, 100000, mockCountTokens);
		expect(result.phase).toBe(0);
		expect(result.text).toContain('Id(l)');
	});

	it('returns decreasing text length for each successive phase', async () => {
		const schema = makeLargeSchema(100, 15);
		const fullText = formatSchemaAsCompactText('TestDb', schema);
		const fullTokens = await mockCountTokens(fullText);

		const r0 = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullTokens + 100, mockCountTokens);
		expect(r0.phase).toBe(0);

		const sizes: number[] = [r0.text.length];

		for (let targetPhase = 1; targetPhase <= 4; targetPhase++) {
			const prevTokens = await mockCountTokens(sizes[sizes.length - 1].toString().length > 0
				? formatSchemaWithOptions('TestDb', schema, undefined,
					targetPhase === 1 ? {} :
					targetPhase === 2 ? { dropTypes: true } :
					targetPhase === 3 ? { dropTypes: true, dropDocStrings: true } :
					{ dropTypes: true, dropDocStrings: true, dropColumns: true })
				: '');
			const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, prevTokens - 1, mockCountTokens);
			expect(result.phase).toBeGreaterThanOrEqual(targetPhase);
			sizes.push(result.text.length);
		}

		for (let i = 1; i < sizes.length; i++) {
			expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
		}
	});

	it('phase 5: truncates with cut-off message when budget is very small', async () => {
		const schema = makeLargeSchema(200, 10);
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, 50, mockCountTokens);
		expect(result.phase).toBe(5);
		expect(result.text).toContain('schema cut off due to context window limits');
	});

	it('prune notice is included for phases 1-4', async () => {
		const schema = makeLargeSchema(50, 10);
		const fullText = formatSchemaAsCompactText('TestDb', schema);
		const fullTokens = await mockCountTokens(fullText);

		const r1 = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullTokens - 1, mockCountTokens);
		if (r1.phase >= 1 && r1.phase <= 4) {
			const desc = PRUNE_PHASE_DESCRIPTIONS[r1.phase as SchemaPrunePhase];
			expect(r1.text).toContain(desc);
			expect(r1.text).toContain('[Note:');
		}
	});

	it('tokenCount is within budget', async () => {
		const schema = makeLargeSchema(100, 10);
		const budget = 500;
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, budget, mockCountTokens);
		expect(result.tokenCount).toBeLessThanOrEqual(budget);
		expect(result.tokenBudget).toBe(budget);
	});

	it('handles schema with no functions gracefully during pruning', async () => {
		const schema: DatabaseSchemaIndex = {
			tables: ['A', 'B', 'C'],
			columnTypesByTable: {
				A: { x: 'string' },
				B: { y: 'long' },
				C: { z: 'datetime' }
			}
		};
		const fullText = formatSchemaAsCompactText('TestDb', schema);
		const fullTokens = await mockCountTokens(fullText);
		const result = await formatSchemaWithTokenBudget('TestDb', schema, undefined, fullTokens - 1, mockCountTokens);
		expect(result.phase).toBeGreaterThanOrEqual(1);
		expect(result.text).not.toContain('# Functions');
	});
});
