/**
 * SchemaTracker — testable state machine for monaco-kusto schema operations.
 *
 * Encapsulates ALL tracking state (loaded schemas, context, cache) and the
 * logic that decides which worker operation to perform. Worker calls are
 * delegated to an injectable interface so the class can be tested with mocks.
 *
 * Usage in production: a single global instance wraps the module-level state.
 * Usage in tests: create a fresh instance per test with a mock worker.
 */
import { decideSchemaOperation, type SchemaOperation } from './schema-decision';

// ── Worker interface (mockable) ─────────────────────────────────────────────
export interface ISchemaWorker {
	setSchemaFromShowSchema(schema: any, clusterUrl: string, database: string): Promise<void>;
	addDatabaseToSchema(modelUri: string, clusterUrl: string, databaseSchema: any): Promise<void>;
	normalizeSchema(schema: any, clusterUrl: string, database: string): Promise<{ database?: any; cluster?: { databases?: any[] } }>;
}

// ── Input for processSchema ─────────────────────────────────────────────────
export interface ProcessSchemaInput {
	rawSchemaJson: any;
	clusterUrl: string;
	database: string;
	setAsContext: boolean;
	modelUri: string;
	forceRefresh: boolean;
	/** URI used for addDatabaseToSchema calls (typically models[0].uri). */
	syncedModelUri: string;
}

// ── Result from processSchema (for testing / diagnostics) ───────────────────
export interface ProcessSchemaResult {
	/** The decision made. */
	operation: SchemaOperation;
	/** Which worker method was called ('setSchemaFromShowSchema' | 'addDatabaseToSchema' | 'none'). */
	workerCall: 'setSchemaFromShowSchema' | 'addDatabaseToSchema' | 'none';
	/** Schema keys re-added after a replace. */
	reAddedSchemas: string[];
}

// ── SchemaTracker ───────────────────────────────────────────────────────────
export class SchemaTracker {
	/** Has any schema ever been loaded via setSchemaFromShowSchema? */
	globalInitialized = false;

	/** Global loaded-schema tracking: `clusterUrl|database` → true. */
	loadedSchemas: Record<string, boolean> = {};

	/** Per-model loaded-schema tracking: `modelUri` → { `clusterUrl|database` → true }. */
	loadedSchemasByModel: Record<string, Record<string, boolean>> = {};

	/** Global "database in context" — reflects the ACTUAL worker state after last replace/first-load. */
	databaseInContext: { clusterUrl: string; database: string } | null = null;

	/** Raw schema cache for re-adds after replace. `clusterUrl|database` → data. */
	schemaCache: Record<string, { rawSchemaJson: any; clusterUrl: string; database: string }> = {};

	// ── helpers ──────────────────────────────────────────────────────────
	private ensureModelTracking(modelUri: string): Record<string, boolean> {
		if (!this.loadedSchemasByModel[modelUri]) {
			this.loadedSchemasByModel[modelUri] = {};
		}
		return this.loadedSchemasByModel[modelUri];
	}

	/** Clean up tracking state for a disposed model. */
	disposeModel(modelUri: string): void {
		delete this.loadedSchemasByModel[modelUri];
	}

	/** Decide which schema operation to perform (pure, no side-effects). */
	decide(modelUri: string, clusterUrl: string, database: string, setAsContext: boolean, forceRefresh: boolean): { operation: SchemaOperation; alreadyLoaded: boolean } {
		const perModel = this.ensureModelTracking(modelUri);
		const schemaKey = `${clusterUrl}|${database}`;
		if (forceRefresh && perModel[schemaKey]) {
			delete perModel[schemaKey];
		}
		const alreadyLoaded = !!perModel[schemaKey];
		const operation = decideSchemaOperation({
			globalInitialized: this.globalInitialized,
			perModelLoaded: alreadyLoaded,
			currentClusterUrl: this.databaseInContext?.clusterUrl ?? null,
			currentDatabase: this.databaseInContext?.database ?? null,
			newClusterUrl: clusterUrl,
			newDatabase: database,
			setAsContext,
			forceRefresh,
		});
		return { operation, alreadyLoaded };
	}

	/** Record state after a successful first-load (setSchemaFromShowSchema). */
	recordFirstLoad(modelUri: string, schemaKey: string, clusterUrl: string, database: string, rawSchemaJson: any): void {
		this.globalInitialized = true;
		this.ensureModelTracking(modelUri)[schemaKey] = true;
		this.loadedSchemas[schemaKey] = true;
		this.databaseInContext = { clusterUrl, database };
		this.schemaCache[schemaKey] = { rawSchemaJson, clusterUrl, database };
	}

	/** Record state after a successful replace (setSchemaFromShowSchema). Returns cache keys to re-add. */
	recordReplace(modelUri: string, schemaKey: string, clusterUrl: string, database: string, rawSchemaJson: any): string[] {
		// Clear ALL models' per-model tracking — the worker schema was completely replaced
		for (const uri of Object.keys(this.loadedSchemasByModel)) {
			const map = this.loadedSchemasByModel[uri];
			if (map) {
				for (const k of Object.keys(map)) delete map[k];
			}
		}
		this.ensureModelTracking(modelUri)[schemaKey] = true;
		this.loadedSchemas = {};
		this.loadedSchemas[schemaKey] = true;
		this.databaseInContext = { clusterUrl, database };
		this.schemaCache[schemaKey] = { rawSchemaJson, clusterUrl, database };
		return Object.keys(this.schemaCache).filter(k => k !== schemaKey);
	}

	/** Record state after a successful add (addDatabaseToSchema). */
	recordAdd(modelUri: string, schemaKey: string, clusterUrl: string, database: string, rawSchemaJson: any, setAsContext: boolean): void {
		this.ensureModelTracking(modelUri)[schemaKey] = true;
		this.loadedSchemas[schemaKey] = true;
		this.schemaCache[schemaKey] = { rawSchemaJson, clusterUrl, database };
		if (setAsContext) {
			this.databaseInContext = { clusterUrl, database };
		}
	}

	/** Record that a globally-loaded schema was adopted by this model (no worker call needed). */
	recordAdoptGlobal(modelUri: string, schemaKey: string, clusterUrl: string, database: string, rawSchemaJson: any): void {
		this.ensureModelTracking(modelUri)[schemaKey] = true;
		this.schemaCache[schemaKey] = this.schemaCache[schemaKey] || { rawSchemaJson, clusterUrl, database };
	}

	/** Check if a schema is loaded globally (by any model). */
	isLoadedGlobally(schemaKey: string): boolean {
		return !!this.loadedSchemas[schemaKey];
	}

	/** Invalidate global tracking for a schema key (when context switch fails). */
	invalidateGlobal(schemaKey: string, modelUri: string): void {
		delete this.loadedSchemas[schemaKey];
		const perModel = this.loadedSchemasByModel[modelUri];
		if (perModel) delete perModel[schemaKey];
	}

	// ── main entry point (for tests + can be used in production) ────────
	async processSchema(input: ProcessSchemaInput, worker: ISchemaWorker): Promise<ProcessSchemaResult> {
		const { rawSchemaJson, clusterUrl, database, setAsContext, modelUri, forceRefresh, syncedModelUri } = input;
		const schemaKey = `${clusterUrl}|${database}`;

		const { operation, alreadyLoaded } = this.decide(modelUri, clusterUrl, database, setAsContext, forceRefresh);

		if (operation.action === 'skip') {
			return { operation, workerCall: 'none', reAddedSchemas: [] };
		}

		// Clear stale per-model tracking if needed
		if (alreadyLoaded) {
			const perModel = this.loadedSchemasByModel[modelUri];
			if (perModel) delete perModel[schemaKey];
		}

		// Resolve database name case from schema
		let databaseInContext = database;
		if (rawSchemaJson?.Databases) {
			const dbKeys = Object.keys(rawSchemaJson.Databases);
			if (!dbKeys.includes(database)) {
				const matchedKey = dbKeys.find((k: string) => k.toLowerCase() === database.toLowerCase());
				if (matchedKey) databaseInContext = matchedKey;
			}
		}

		let schemaObj = rawSchemaJson;
		if (schemaObj?.Databases && !schemaObj.Plugins) {
			schemaObj = { Plugins: [], ...schemaObj };
		}

		// ── FIRST-LOAD ──────────────────────────────────────────────────
		if (operation.action === 'first-load') {
			await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
			this.recordFirstLoad(modelUri, schemaKey, clusterUrl, databaseInContext, schemaObj);
			return { operation, workerCall: 'setSchemaFromShowSchema', reAddedSchemas: [] };
		}

		// ── REPLACE ─────────────────────────────────────────────────────
		if (operation.action === 'replace') {
			await worker.setSchemaFromShowSchema(schemaObj, clusterUrl, databaseInContext);
			const otherKeys = this.recordReplace(modelUri, schemaKey, clusterUrl, databaseInContext, schemaObj);

			// Re-add all other cached schemas
			for (const otherKey of otherKeys) {
				const cached = this.schemaCache[otherKey];
				if (cached?.rawSchemaJson) {
					try {
						const engineSchema = await worker.normalizeSchema(cached.rawSchemaJson, cached.clusterUrl, cached.database);
						const databaseSchema = engineSchema?.database ??
							engineSchema?.cluster?.databases?.find((db: any) => db.name?.toLowerCase() === cached.database.toLowerCase());
						if (databaseSchema) {
							await worker.addDatabaseToSchema(syncedModelUri, cached.clusterUrl, databaseSchema);
						}
					} catch { /* best effort */ }
				}
			}

			return { operation, workerCall: 'setSchemaFromShowSchema', reAddedSchemas: otherKeys };
		}

		// ── ADD ──────────────────────────────────────────────────────────
		const alreadyGlobally = !forceRefresh && this.isLoadedGlobally(schemaKey);
		if (alreadyGlobally) {
			this.recordAdoptGlobal(modelUri, schemaKey, clusterUrl, databaseInContext, schemaObj);
			return { operation, workerCall: 'none', reAddedSchemas: [] };
		}

		const engineSchema = await worker.normalizeSchema(schemaObj, clusterUrl, databaseInContext);
		const databaseSchema = engineSchema?.database ??
			engineSchema?.cluster?.databases?.find((db: any) => db.name?.toLowerCase() === databaseInContext.toLowerCase());

		if (databaseSchema) {
			await worker.addDatabaseToSchema(syncedModelUri, clusterUrl, databaseSchema);
			this.recordAdd(modelUri, schemaKey, clusterUrl, databaseInContext, schemaObj, setAsContext);
			return { operation, workerCall: 'addDatabaseToSchema', reAddedSchemas: [] };
		}

		return { operation, workerCall: 'none', reAddedSchemas: [] };
	}
}
