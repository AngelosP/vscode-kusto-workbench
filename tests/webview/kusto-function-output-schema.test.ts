import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { getKustoClusterAliases, parseKustoClusterRef } from '../../src/shared/kustoClusterUrls';
import {
	buildKustoFunctionBodyFromOutputColumns,
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

function workerAliasHarness() {
	const source = ts.createSourceFile('monaco.ts', readFileSync('src/webview/monaco/monaco.ts', 'utf8'), ts.ScriptTarget.Latest, true);
	const names = ['__kustoGetCrossClusterClusterAliases', '__kustoAddDatabaseAliasesToWorker'];
	const declarations = names.map(name => {
		const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
		if (!declaration) throw new Error(`Missing actual worker alias function: ${name}`);
		return declaration.getText(source);
	});
	const databases = new Map<string, Record<string, unknown>>();
	const lease = { active: true };
	const errors = vi.fn();
	const worker = {
		normalizeSchema: vi.fn(async (schema: ReturnType<typeof makeSchema>) => ({
			database: {
				name: 'TelemetryDb',
				tables: [{
					name: 'Events',
					columns: schema.Databases.TelemetryDb.Tables.Events.OrderedColumns.map(column => ({
						name: column.Name, type: column.CslType,
					})),
				}],
				functions: [],
			},
		})),
		addDatabaseToSchema: vi.fn(async (_model: string, alias: string, database: Record<string, unknown>) => {
			databases.set(parseKustoClusterRef(alias).host, structuredClone(database));
		}),
		addDatabaseAliasesToSchema: vi.fn(async (_model: string, _clusterUrl: string, aliases: readonly string[], database: Record<string, unknown>) => {
			const sharedDatabase = structuredClone(database);
			for (const alias of aliases) databases.set(parseKustoClusterRef(alias).host, sharedDatabase);
		}),
	};
	const context = createContext({
		getKustoClusterAliases, parseKustoClusterRef, stampKustoSchemaMajorVersion, buildKustoFunctionBodyFromOutputColumns,
		__kustoPrepareSchemaForKustoWorker: prepareKustoSchemaForWorkerFast,
		__kustoGetAutocompleteTraceIdForModel: () => '',
		__kustoGetCrossClusterSchemaKey: () => 'schema',
		__kustoCommitWorkerMutation: () => lease.active,
		recordAutocompleteTrace: vi.fn(),
		console: { error: errors },
	});
	runInContext(ts.transpileModule(declarations.join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
	return {
		worker, databases, lease, errors,
		apply: (schema: ReturnType<typeof makeSchema>, name: string, url: string, revision = 17): Promise<number> =>
			context.__kustoAddDatabaseAliasesToWorker(worker, 'model', schema, name, url, 'TelemetryDb', {
				id: revision, isActive: () => lease.active,
			}),
	};
}

describe('Kusto worker alias allocations', () => {
	it('registers one database batch without constructing a separate copy for each alias', async () => {
		const harness = workerAliasHarness();

		expect(await harness.apply(makeSchema(), 'help', 'https://help.kusto.windows.net')).toBe(2);

		expect(harness.worker.addDatabaseAliasesToSchema).toHaveBeenCalledOnce();
		expect(harness.worker.addDatabaseToSchema).not.toHaveBeenCalled();
		expect(harness.databases.get('help')).toBe(harness.databases.get('help.kusto.windows.net'));
	});

	it.each([
		['public', 'help', 'https://help.kusto.windows.net', ['help', 'help.kusto.windows.net']],
		['regional', 'help.westus', 'https://help.westus.kusto.windows.net', ['help.westus', 'help.westus.kusto.windows.net']],
		['sovereign', 'https://help.kusto.usgovcloudapi.net', 'https://help.kusto.usgovcloudapi.net', ['help.kusto.usgovcloudapi.net']],
		['custom endpoint', 'https://events.example.test', 'https://events.example.test', ['events.example.test']],
		['distinct alias', 'friendly', 'https://events.example.test', ['friendly', 'friendly.kusto.windows.net', 'events.example.test']],
	] as const)('registers each %s worker host once without losing tables or function columns', async (_label, name, url, hosts) => {
		const harness = workerAliasHarness();
		const schema = makeSchema();
		const original = JSON.stringify(schema);
		freezeSchema(schema);

		const count = await harness.apply(schema, name, url);

		expect(harness.worker.addDatabaseAliasesToSchema.mock.calls.flatMap(call => call[2].map(alias => parseKustoClusterRef(alias).host))).toEqual(hosts);
		expect(harness.worker.addDatabaseAliasesToSchema).toHaveBeenCalledOnce();
		expect(harness.worker.addDatabaseToSchema).not.toHaveBeenCalled();
		expect(count).toBe(hosts.length);
		expect(harness.worker.normalizeSchema).toHaveBeenCalledOnce();
		for (const host of hosts) {
			expect(harness.databases.get(host)).toMatchObject({
				name: 'TelemetryDb',
				majorVersion: 17,
				tables: [{ name: 'Events', columns: [{ name: 'Timestamp', type: 'datetime' }, { name: 'EventName', type: 'string' }] }],
				functions: [
					{ name: 'ExplicitFn', outputColumns: [{ name: 'ExplicitColumn', type: 'string' }], body: expect.stringContaining('ExplicitColumn') },
					{ name: 'InferredFn', body: '{ Events | project EventName }' },
				],
			});
		}
		expect(JSON.stringify(schema)).toBe(original);
		expect(harness.errors).not.toHaveBeenCalled();
	});

	it('updates both host identities again for the next schema revision', async () => {
		const harness = workerAliasHarness();
		const schema = makeSchema();
		await harness.apply(schema, 'help', 'https://help.kusto.windows.net', 17);
		const next = makeSchema();
		next.Databases.TelemetryDb.Tables.Events.OrderedColumns.push({ Name: 'NewColumn', CslType: 'long' });

		expect(await harness.apply(next, 'help', 'https://help.kusto.windows.net', 18)).toBe(2);

		expect(harness.worker.addDatabaseAliasesToSchema).toHaveBeenCalledTimes(2);
		expect(harness.worker.addDatabaseToSchema).not.toHaveBeenCalled();
		for (const database of harness.databases.values()) {
			expect(database).toMatchObject({ majorVersion: 18, tables: [{ columns: [
				{ name: 'Timestamp', type: 'datetime' }, { name: 'EventName', type: 'string' }, { name: 'NewColumn', type: 'long' },
			] }] });
		}
	});

	it('does not begin an alias update for a retired transaction', async () => {
		const harness = workerAliasHarness();
		harness.lease.active = false;

		expect(await harness.apply(makeSchema(), 'help', 'https://help.kusto.windows.net')).toBe(0);
		expect(harness.worker.normalizeSchema).not.toHaveBeenCalled();
		expect(harness.worker.addDatabaseAliasesToSchema).not.toHaveBeenCalled();
		expect(harness.worker.addDatabaseToSchema).not.toHaveBeenCalled();
	});

	it('does not claim the batch after its transaction is retired during the update', async () => {
		const harness = workerAliasHarness();
		harness.worker.addDatabaseAliasesToSchema.mockImplementation(async () => { harness.lease.active = false; });

		expect(await harness.apply(makeSchema(), 'help', 'https://help.kusto.windows.net')).toBe(0);
		expect(harness.worker.addDatabaseAliasesToSchema).toHaveBeenCalledOnce();
		expect(harness.worker.addDatabaseToSchema).not.toHaveBeenCalled();
	});

	it('reports a failed worker update instead of claiming that aliases were registered', async () => {
		const harness = workerAliasHarness();
		const error = new Error('Schema update failed');
		harness.worker.addDatabaseAliasesToSchema.mockRejectedValue(error);

		expect(await harness.apply(makeSchema(), 'help', 'https://help.kusto.windows.net')).toBe(0);
		expect(harness.worker.addDatabaseAliasesToSchema).toHaveBeenCalledOnce();
		expect(harness.errors).toHaveBeenCalledWith('[kusto] Failed to add database aliases:', error);
	});

	it('stamps the fallback database with the current transaction revision', async () => {
		const harness = workerAliasHarness();
		Object.defineProperty(harness.worker, 'normalizeSchema', { value: undefined });

		expect(await harness.apply(makeSchema(), 'help', 'https://help.kusto.windows.net', 42)).toBe(2);
		expect(harness.worker.addDatabaseAliasesToSchema.mock.calls[0][3].majorVersion).toBe(42);
	});

	it('reports a missing batch API instead of silently using per-alias copies', async () => {
		const harness = workerAliasHarness();
		Object.defineProperty(harness.worker, 'addDatabaseAliasesToSchema', { value: undefined });

		expect(await harness.apply(makeSchema(), 'help', 'https://help.kusto.windows.net')).toBe(0);
		expect(harness.worker.addDatabaseToSchema).not.toHaveBeenCalled();
		expect(harness.errors.mock.calls[0][1].message).toContain('does not support batched database aliases');
	});
});

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
			addDatabaseAliasesToSchema: vi.fn(async (
				_model: string, _clusterUrl: string, _aliases: readonly string[], _database: Record<string, unknown>,
			) => undefined),
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
		expect(worker.addDatabaseAliasesToSchema).toHaveBeenCalledOnce();
		expect(worker.addDatabaseAliasesToSchema.mock.calls[0][2]).toEqual(['https://cluster.kusto.windows.net']);
		expect(worker.addDatabaseAliasesToSchema.mock.calls[0][3].majorVersion).toBe(23);
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
