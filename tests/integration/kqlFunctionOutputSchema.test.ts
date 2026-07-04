import * as assert from 'assert';
import { ensureKustoFunctionBodiesForSchema } from '../../src/webview/shared/kusto-function-output-schema';

suite('KQL Monaco schema - function output columns', () => {
	test('synthesizes function body from OutputColumns for Monaco Kusto worker', () => {
		const schema = {
			Plugins: [],
			Databases: {
				TelemetryDb: {
					Name: 'TelemetryDb',
					Tables: {},
					MaterializedViews: {},
					ExternalTables: {},
					Functions: {
						v_autocomplete_events: {
							Name: 'v_autocomplete_events',
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
		const fn = result.Databases.TelemetryDb.Functions.v_autocomplete_events;
		assert.strictEqual(fn.Body, fn.body, 'Expected both raw and normalized body fields');
		assert.ok(fn.Body.includes('TIMESTAMP = datetime(2026-01-01)'), 'Expected TIMESTAMP projection in synthetic body');
		assert.ok(fn.Body.includes('EventName = ""'), 'Expected EventName projection in synthetic body');
		assert.ok(fn.Body.includes('Kind = ""'), 'Expected Kind projection in synthetic body');
		assert.ok(fn.Body.includes('env_dt_traceId = ""'), 'Expected env_dt_traceId projection in synthetic body');
	});

	test('prefers OutputColumns over existing body for worker inference', () => {
		const schema = {
			Databases: {
				TelemetryDb: {
					Functions: {
						v_autocomplete_events: {
							Name: 'v_autocomplete_events',
							Body: "{ cluster('semantic-remote.westus').database('TelemetryDb').Events | where TIMESTAMP > ago(1d) }",
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
		const fn = schema.Databases.TelemetryDb.Functions.v_autocomplete_events as any;
		assert.ok(fn.Body.includes('TIMESTAMP = datetime(2026-01-01)'), 'Expected worker-facing body to expose TIMESTAMP');
		assert.ok(fn.Body.includes('EventName = ""'), 'Expected worker-facing body to expose EventName');
		assert.strictEqual(fn.__kustoOriginalBody, "{ cluster('semantic-remote.westus').database('TelemetryDb').Events | where TIMESTAMP > ago(1d) }");
	});
});
