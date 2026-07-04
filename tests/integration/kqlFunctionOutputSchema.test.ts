import * as assert from 'assert';
import { ensureKustoFunctionBodiesForSchema } from '../../src/webview/shared/kusto-function-output-schema';

suite('KQL Monaco schema - function output columns', () => {
	test('synthesizes function body from OutputColumns for Monaco Kusto worker', () => {
		const schema = {
			Plugins: [],
			Databases: {
				prod: {
					Name: 'prod',
					Tables: {},
					MaterializedViews: {},
					ExternalTables: {},
					Functions: {
						v_bizops: {
							Name: 'v_bizops',
							InputParameters: [],
							OutputColumns: [
								{ Name: 'TIMESTAMP', CslType: 'datetime', Type: 'datetime' },
								{ Name: 'EventName', CslType: 'string', Type: 'string' },
								{ Name: 'Kind', CslType: 'string', Type: 'string' },
								{ Name: 'env_dt_traceId', CslType: 'string', Type: 'string' },
							],
						},
					},
				},
			},
		};

		const result = ensureKustoFunctionBodiesForSchema(schema);
		const fn = result.Databases.prod.Functions.v_bizops;
		assert.strictEqual(fn.Body, fn.body, 'Expected both raw and normalized body fields');
		assert.ok(fn.Body.includes('TIMESTAMP = datetime(2026-01-01)'), 'Expected TIMESTAMP projection in synthetic body');
		assert.ok(fn.Body.includes('EventName = ""'), 'Expected EventName projection in synthetic body');
		assert.ok(fn.Body.includes('Kind = ""'), 'Expected Kind projection in synthetic body');
		assert.ok(fn.Body.includes('env_dt_traceId = ""'), 'Expected env_dt_traceId projection in synthetic body');
	});

	test('prefers OutputColumns over existing body for worker inference', () => {
		const schema = {
			Databases: {
				prod: {
					Functions: {
						v_bizops: {
							Name: 'v_bizops',
							Body: "{ cluster('aoaiagents1.westus').database('prod').bizops | where TIMESTAMP > ago(1d) }",
							OutputColumns: [
								{ Name: 'TIMESTAMP', CslType: 'datetime' },
								{ Name: 'EventName', CslType: 'string' },
							],
						},
					},
				},
			},
		};
		ensureKustoFunctionBodiesForSchema(schema);
		const fn = schema.Databases.prod.Functions.v_bizops as any;
		assert.ok(fn.Body.includes('TIMESTAMP = datetime(2026-01-01)'), 'Expected worker-facing body to expose TIMESTAMP');
		assert.ok(fn.Body.includes('EventName = ""'), 'Expected worker-facing body to expose EventName');
		assert.strictEqual(fn.__kustoOriginalBody, "{ cluster('aoaiagents1.westus').database('prod').bizops | where TIMESTAMP > ago(1d) }");
	});
});
