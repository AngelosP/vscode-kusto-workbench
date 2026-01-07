import * as assert from 'assert';

import { extractKqlSchemaMatchTokens, scoreSchemaMatch } from '../kqlSchemaInference';
import type { DatabaseSchemaIndex } from '../kustoClient';

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
