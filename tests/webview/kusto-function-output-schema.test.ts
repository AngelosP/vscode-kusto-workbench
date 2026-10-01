import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import {
	enhanceKustoFunctionBodiesForSchemaChunked,
	findKustoRawSchemaEntity,
	prepareKustoSchemaForWorkerFast,
	prepareKustoSchemaForWorkerFull,
	resolveKustoRawSchemaEntityColumns,
	stampKustoSchemaMajorVersion,
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

function freezeSchema(value: unknown): void {
	if (!value || typeof value !== 'object') return;
	for (const child of Object.values(value)) freezeSchema(child);
	Object.freeze(value);
}

describe('Kusto function output schema preparation', () => {
	it.each([
		['fast', prepareKustoSchemaForWorkerFast],
		['full', prepareKustoSchemaForWorkerFull],
	] as const)('%s preparation owns mutable function records without changing a frozen delivery', async (mode, prepare) => {
		const original = makeSchema();
		const originalText = JSON.stringify(original);
		freezeSchema(original);
		const prepared = prepare(original);
		expect(prepared).not.toBe(original);
		expect(prepared.Databases.TelemetryDb.Functions.ExplicitFn).not.toBe(original.Databases.TelemetryDb.Functions.ExplicitFn);
		expect(prepared.Databases.TelemetryDb.Tables).toBe(original.Databases.TelemetryDb.Tables);
		expect(prepared.Databases.TelemetryDb.Functions.ExplicitFn.Body).toContain('ExplicitColumn');
		if (mode === 'fast') await enhanceKustoFunctionBodiesForSchemaChunked(prepared, { yieldFn: async () => undefined });
		expect(prepared.Databases.TelemetryDb.Functions.InferredFn.OutputColumns.map((column: any) => column.Name)).toEqual(['EventName']);
		expect(JSON.stringify(original)).toBe(originalText);
	});

	it('background enhancement owns frozen retry input through normalization, aliases, cache, and completion', async () => {
		const source = ts.createSourceFile('monaco.ts', readFileSync('src/webview/monaco/monaco.ts', 'utf8'), ts.ScriptTarget.Latest, true);
		const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement)
			&& statement.name?.text === '__kustoScheduleEnhancedSchemaApply');
		expect(declaration).toBeDefined();
		const code = ts.transpileModule(declaration!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
		const original = makeSchema();
		const originalText = JSON.stringify(original);
		freezeSchema(original);
		const pending = new Set<string>();
		const ready = vi.fn();
		const failed = vi.fn();
		const aliases = vi.fn(async () => undefined);
		const tracker = { loadedSchemasByModel: {}, schemaCache: {} as Record<string, any> };
		const context = createContext({
			__kustoSchemaEnhancementToken: 0,
			__kustoSchemaEnhancementTokenByModelSchemaKey: {},
			__kustoSchemaEnhancementPendingByModelSchemaKey: pending,
			__kustoSchemaTracker: tracker,
			getKustoPreparationState: () => ({ target: { schemaSignature: 'signature' } }),
			isKustoPreparationCurrent: () => true,
			markSchemaEnhancementPending: vi.fn(), markSchemaEnhancementCanceled: vi.fn(),
			markSchemaEnhancementReady: ready, markSchemaEnhancementFailed: failed,
			__kustoYieldForSchemaEnhancement: async () => undefined,
			prepareKustoSchemaForWorkerFast, enhanceKustoFunctionBodiesForSchemaChunked, stampKustoSchemaMajorVersion,
			traceFileOpen: vi.fn(), kustoSupplementalTraceId: (value: string) => value,
			KUSTO_SCHEMA_ENHANCEMENT_TIMEOUT_MS: 1000,
			__kustoWorkerMutations: { enqueueLeased: async (operation: any) => ({
				status: 'completed', value: await operation.run({ id: 23, isActive: () => true }),
			}) },
			__kustoCommitWorkerMutation: () => true,
			__kustoAddDatabaseAliasesToWorker: aliases,
			queryEditorBoxByModelUri: { model: 'query_1' },
			__kustoTriggerRevalidation: vi.fn(),
		});
		runInContext(code, context);
		const worker = {
			normalizeSchema: vi.fn(async () => ({ database: { name: 'TelemetryDb' } })),
			addDatabaseToSchema: vi.fn(async () => undefined),
		};
		expect(context.__kustoScheduleEnhancedSchemaApply({
			schemaObj: original, worker, modelKey: 'model', schemaKey: 'schema',
			clusterUrl: 'https://cluster.kusto.windows.net', databaseInContext: 'TelemetryDb',
			connectionId: 'connection', accountPartition: 'account', setAsContext: false,
			isCurrent: () => true, preparationToken: { boxId: 'query_1' },
		})).toBe(true);
		await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
		expect(failed).not.toHaveBeenCalled();
		expect(pending.size).toBe(0);
		expect(worker.addDatabaseToSchema).toHaveBeenCalledOnce();
		const normalized = worker.normalizeSchema.mock.calls[0][0] as any;
		expect(normalized.Databases.TelemetryDb.Functions.InferredFn.OutputColumns.map((column: any) => column.Name)).toEqual(['EventName']);
		const cached = tracker.schemaCache.schema.rawSchemaJson;
		expect(cached).not.toBe(original);
		expect(cached.Databases.TelemetryDb.Functions.InferredFn.OutputColumns.map((column: any) => column.Name)).toEqual(['EventName']);
		expect(aliases.mock.calls[0][2]).toBe(cached);
		expect(JSON.stringify(original)).toBe(originalText);
	});

	it('stamps serialized A-to-B worker applies with increasing database versions', () => {
		const schemaA = stampKustoSchemaMajorVersion(makeSchema(), 17);
		const schemaB = stampKustoSchemaMajorVersion(makeSchema(), 18);

		expect(schemaA.Databases.TelemetryDb.MajorVersion).toBe(17);
		expect(schemaB.Databases.TelemetryDb.MajorVersion).toBe(18);
		expect(schemaB.Databases.TelemetryDb.MajorVersion).toBeGreaterThan(schemaA.Databases.TelemetryDb.MajorVersion);
	});

	it('fast prep preserves explicit output columns without inferring missing function outputs', () => {
		const schema = prepareKustoSchemaForWorkerFast(makeSchema());

		expect(schema.Databases.TelemetryDb.Functions.ExplicitFn.Body).toContain('ExplicitColumn');
		expect(schema.Databases.TelemetryDb.Functions.InferredFn.OutputColumns).toBeUndefined();
		expect(schema.Databases.TelemetryDb.Functions.InferredFn.Body).toBe('{ Events | project EventName }');
	});

	it('full prep infers missing function output columns using indexed raw-schema lookups', () => {
		const schema = prepareKustoSchemaForWorkerFull(makeSchema());

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
