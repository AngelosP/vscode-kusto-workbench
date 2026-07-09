import { describe, expect, it, vi } from 'vitest';
import {
	enhanceKustoFunctionBodiesForSchemaChunked,
	findKustoRawSchemaEntity,
	prepareKustoSchemaForWorkerFast,
	prepareKustoSchemaForWorkerFull,
	resolveKustoRawSchemaEntityColumns,
} from '../../src/webview/shared/kusto-function-output-schema';

function makeSchema() {
	return {
		Plugins: [],
		Databases: {
			TelemetryDb: {
				Tables: {
					Events: {
						Name: 'Events',
						OrderedColumns: [
							{ Name: 'Timestamp', CslType: 'datetime' },
							{ Name: 'EventName', CslType: 'string' },
						],
					},
				},
				MaterializedViews: {
					DailyEvents: {
						Name: 'DailyEvents',
						OrderedColumns: [{ Name: 'Day', CslType: 'datetime' }],
					},
				},
				ExternalTables: {
					ExternalEvents: {
						Name: 'ExternalEvents',
						OrderedColumns: [{ Name: 'ExternalId', CslType: 'string' }],
					},
				},
				Functions: {
					ExplicitFn: {
						Name: 'ExplicitFn',
						OutputColumns: [{ Name: 'ExplicitColumn', CslType: 'string' }],
						Body: '{ Events | take 10 }',
					},
					InferredFn: {
						Name: 'InferredFn',
						Body: '{ Events | project EventName }',
					},
				},
			},
		},
	};
}

describe('Kusto function output schema preparation', () => {
	it('fast prep preserves explicit output columns without inferring missing function outputs', () => {
		const schema = makeSchema();
		prepareKustoSchemaForWorkerFast(schema);

		expect(schema.Databases.TelemetryDb.Functions.ExplicitFn.Body).toContain('ExplicitColumn');
		expect(schema.Databases.TelemetryDb.Functions.InferredFn.OutputColumns).toBeUndefined();
		expect(schema.Databases.TelemetryDb.Functions.InferredFn.Body).toBe('{ Events | project EventName }');
	});

	it('full prep infers missing function output columns using indexed raw-schema lookups', () => {
		const schema = makeSchema();
		prepareKustoSchemaForWorkerFull(schema);

		const inferred = schema.Databases.TelemetryDb.Functions.InferredFn;
		expect(inferred.OutputColumns.map((column: any) => column.Name)).toEqual(['EventName']);
		expect(inferred.Body).toContain('EventName');
	});

	it('indexed entity lookup is case-insensitive and covers table/view/external/function containers', () => {
		const schema = makeSchema();

		expect(resolveKustoRawSchemaEntityColumns(schema, 'telemetrydb', 'events')).toEqual(['Timestamp', 'EventName']);
		expect(resolveKustoRawSchemaEntityColumns(schema, 'TELEMETRYDB', 'dailyevents')).toEqual(['Day']);
		expect(resolveKustoRawSchemaEntityColumns(schema, 'TelemetryDb', 'externalevents')).toEqual(['ExternalId']);
		expect(findKustoRawSchemaEntity(schema, 'TelemetryDb', 'explicitfn')?.Name).toBe('ExplicitFn');
	});

	it('chunked enhancement yields while preserving inferred output functionality', async () => {
		const schema = makeSchema();
		const yieldFn = vi.fn(async () => undefined);

		const result = await enhanceKustoFunctionBodiesForSchemaChunked(schema, {
			maxBatchSize: 1,
			maxSliceMs: 1000,
			yieldFn,
		});

		expect(result).toEqual({ processedCount: 1, enhancedCount: 1, canceled: false });
		expect(yieldFn).toHaveBeenCalled();
		expect(schema.Databases.TelemetryDb.Functions.InferredFn.OutputColumns.map((column: any) => column.Name)).toEqual(['EventName']);
	});
});
