import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchemaTracker, type ISchemaWorker, type ProcessSchemaInput } from '../../src/webview/shared/schema-tracker';

// ── Constants ────────────────────────────────────────────────────────────────
const CLUSTER_A = 'https://clusterA.kusto.windows.net';
const CLUSTER_B = 'https://clusterB.kusto.windows.net';
const DB_1 = 'Database1';
const DB_2 = 'Database2';
const DB_3 = 'Database3';

const MODEL_1 = 'inmemory://model/1';
const MODEL_2 = 'inmemory://model/2';
const MODEL_3 = 'inmemory://model/3';
const SYNCED = 'inmemory://model/1'; // first model

/** Minimal schema object that mimics the Kusto showSchema format. */
function makeSchema(database: string) {
	return {
		Plugins: [],
		Databases: {
			[database]: {
				Tables: { SomeTable: { OrderedColumns: {}, EntityType: 'Table' } },
				Functions: {},
			},
		},
	};
}

/** Build a ProcessSchemaInput with sensible defaults. */
function input(overrides: Partial<ProcessSchemaInput> = {}): ProcessSchemaInput {
	return {
		rawSchemaJson: makeSchema(overrides.database ?? DB_1),
		clusterUrl: CLUSTER_A,
		database: DB_1,
		setAsContext: true,
		modelUri: MODEL_1,
		forceRefresh: false,
		syncedModelUri: SYNCED,
		...overrides,
	};
}

/** Create a mock worker that records calls. */
function mockWorker(): ISchemaWorker & {
	calls: { method: string; args: any[] }[];
} {
	const calls: { method: string; args: any[] }[] = [];
	return {
		calls,
		async setSchemaFromShowSchema(schema, clusterUrl, database) {
			calls.push({ method: 'setSchemaFromShowSchema', args: [clusterUrl, database] });
		},
		async addDatabaseToSchema(modelUri, clusterUrl, databaseSchema) {
			calls.push({ method: 'addDatabaseToSchema', args: [clusterUrl, databaseSchema?.name ?? '?'] });
		},
		async normalizeSchema(_schema, clusterUrl, database) {
			return { database: { name: database, tables: [], functions: [] } };
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('SchemaTracker', () => {
	let tracker: SchemaTracker;
	let worker: ReturnType<typeof mockWorker>;

	beforeEach(() => {
		tracker = new SchemaTracker();
		worker = mockWorker();
	});

	// ── First load ───────────────────────────────────────────────────────
	describe('first-ever schema load', () => {
		it('calls setSchemaFromShowSchema and sets global context', async () => {
			const result = await tracker.processSchema(input(), worker);

			expect(result.operation.action).toBe('first-load');
			expect(result.workerCall).toBe('setSchemaFromShowSchema');
			expect(tracker.globalInitialized).toBe(true);
			expect(tracker.databaseInContext).toEqual({ clusterUrl: CLUSTER_A, database: DB_1 });
			expect(tracker.loadedSchemas[`${CLUSTER_A}|${DB_1}`]).toBe(true);
		});
	});

	// ── Same cluster, different databases — THE EXACT BUG ────────────────
	describe('same cluster, different databases (round-trip)', () => {
		it('A→B→A: every switch uses replace and updates context', async () => {
			// Step 1: First load A/DB1
			const r1 = await tracker.processSchema(
				input({ modelUri: MODEL_1, clusterUrl: CLUSTER_A, database: DB_1 }),
				worker,
			);
			expect(r1.operation.action).toBe('first-load');
			expect(tracker.databaseInContext?.database).toBe(DB_1);

			// Step 2: Switch to A/DB2 (model 2, setAsContext=true)
			const r2 = await tracker.processSchema(
				input({ modelUri: MODEL_2, clusterUrl: CLUSTER_A, database: DB_2, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);
			expect(r2.operation.action).toBe('replace');
			expect(tracker.databaseInContext?.database).toBe(DB_2);

			// Step 3: Switch back to A/DB1 (model 1, setAsContext=true)
			const r3 = await tracker.processSchema(
				input({ modelUri: MODEL_1, clusterUrl: CLUSTER_A, database: DB_1 }),
				worker,
			);
			expect(r3.operation.action).toBe('replace');
			expect(tracker.databaseInContext?.database).toBe(DB_1);
		});

		it('perModelLoaded is cleared for ALL models after replace', async () => {
			// Load DB1 for model 1, DB2 for model 2
			await tracker.processSchema(input({ modelUri: MODEL_1, database: DB_1 }), worker);
			await tracker.processSchema(
				input({ modelUri: MODEL_2, database: DB_2, setAsContext: false, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);

			expect(tracker.loadedSchemasByModel[MODEL_1]?.[`${CLUSTER_A}|${DB_1}`]).toBe(true);
			expect(tracker.loadedSchemasByModel[MODEL_2]?.[`${CLUSTER_A}|${DB_2}`]).toBe(true);

			// Now replace via model 2 setting context
			await tracker.processSchema(
				input({ modelUri: MODEL_2, database: DB_2, setAsContext: true, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);

			// Model 1's tracking should have been wiped
			expect(Object.keys(tracker.loadedSchemasByModel[MODEL_1] || {}).length).toBe(0);
			// Model 2's tracking should only have DB2
			expect(tracker.loadedSchemasByModel[MODEL_2]?.[`${CLUSTER_A}|${DB_2}`]).toBe(true);
		});
	});

	// ── Different clusters ───────────────────────────────────────────────
	describe('different clusters', () => {
		it('switching clusters uses replace', async () => {
			await tracker.processSchema(input({ clusterUrl: CLUSTER_A, database: DB_1 }), worker);

			const r = await tracker.processSchema(
				input({ modelUri: MODEL_2, clusterUrl: CLUSTER_B, database: DB_1, rawSchemaJson: makeSchema(DB_1) }),
				worker,
			);
			expect(r.operation.action).toBe('replace');
			expect(tracker.databaseInContext?.clusterUrl).toBe(CLUSTER_B);
		});
	});

	// ── Skip when same database ──────────────────────────────────────────
	describe('skip when context already correct', () => {
		it('skips when same cluster+database & perModelLoaded', async () => {
			await tracker.processSchema(input({ modelUri: MODEL_1, database: DB_1 }), worker);
			worker.calls.length = 0;

			const r = await tracker.processSchema(input({ modelUri: MODEL_1, database: DB_1 }), worker);
			expect(r.operation.action).toBe('skip');
			expect(worker.calls).toHaveLength(0);
		});
	});

	// ── Add path (no context switch) ─────────────────────────────────────
	describe('add path (setAsContext=false)', () => {
		it('uses addDatabaseToSchema and does NOT change context', async () => {
			await tracker.processSchema(input({ modelUri: MODEL_1, database: DB_1 }), worker);
			worker.calls.length = 0;

			const r = await tracker.processSchema(
				input({ modelUri: MODEL_2, database: DB_2, setAsContext: false, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);
			expect(r.operation.action).toBe('add');
			expect(r.workerCall).toBe('addDatabaseToSchema');
			// Context should still be DB_1
			expect(tracker.databaseInContext?.database).toBe(DB_1);
		});
	});

	// ── Force refresh ────────────────────────────────────────────────────
	describe('force refresh', () => {
		it('uses add path even when database differs (no disruption)', async () => {
			await tracker.processSchema(input({ modelUri: MODEL_1, database: DB_1 }), worker);

			const r = await tracker.processSchema(
				input({
					modelUri: MODEL_2,
					database: DB_2,
					setAsContext: true,
					forceRefresh: true,
					rawSchemaJson: makeSchema(DB_2),
				}),
				worker,
			);
			expect(r.operation.action).toBe('add');
		});
	});

	// ── Re-add after replace ─────────────────────────────────────────────
	describe('schema cache re-add after replace', () => {
		it('re-adds previously loaded schemas from cache', async () => {
			// Load two schemas
			await tracker.processSchema(input({ modelUri: MODEL_1, database: DB_1 }), worker);
			await tracker.processSchema(
				input({ modelUri: MODEL_2, database: DB_2, setAsContext: false, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);
			worker.calls.length = 0;

			// Replace with DB_3
			const r = await tracker.processSchema(
				input({ modelUri: MODEL_3, database: DB_3, rawSchemaJson: makeSchema(DB_3) }),
				worker,
			);

			expect(r.operation.action).toBe('replace');
			expect(r.reAddedSchemas).toContain(`${CLUSTER_A}|${DB_1}`);
			expect(r.reAddedSchemas).toContain(`${CLUSTER_A}|${DB_2}`);
			// Worker should have: 1 setSchemaFromShowSchema + 2 addDatabaseToSchema (re-adds)
			expect(worker.calls.filter(c => c.method === 'setSchemaFromShowSchema')).toHaveLength(1);
			expect(worker.calls.filter(c => c.method === 'addDatabaseToSchema')).toHaveLength(2);
		});
	});

	// ── Real bug scenario from diagnostics ───────────────────────────────
	describe('real scenario: 14-section file, bottom→up→back', () => {
		it('reproduces the exact sequence from diagnostic logs', async () => {
			// Initial loads: schemas arrive for various models (setAsContext=false)
			// Models 1-5: VSCodeExt, Models 7-10: VSCode, Model 6: VSCodeExt
			// Model 11: VSCodeExt, Model 12: AzureDevExp, Model 13: AzureCli, Model 14: AzureDevExp
			for (let i = 1; i <= 5; i++) {
				await tracker.processSchema(
					input({
						modelUri: `inmemory://model/${i}`,
						clusterUrl: CLUSTER_A,
						database: DB_1,
						setAsContext: false,
					}),
					worker,
				);
			}
			for (let i = 7; i <= 10; i++) {
				await tracker.processSchema(
					input({
						modelUri: `inmemory://model/${i}`,
						clusterUrl: CLUSTER_A,
						database: DB_2,
						setAsContext: false,
						rawSchemaJson: makeSchema(DB_2),
					}),
					worker,
				);
			}
			await tracker.processSchema(
				input({
					modelUri: `inmemory://model/12`,
					clusterUrl: CLUSTER_B,
					database: DB_1,
					setAsContext: false,
				}),
				worker,
			);
			await tracker.processSchema(
				input({
					modelUri: `inmemory://model/13`,
					clusterUrl: CLUSTER_B,
					database: DB_2,
					setAsContext: false,
					rawSchemaJson: makeSchema(DB_2),
				}),
				worker,
			);
			await tracker.processSchema(
				input({
					modelUri: `inmemory://model/14`,
					clusterUrl: CLUSTER_B,
					database: DB_1,
					setAsContext: false,
				}),
				worker,
			);

			// ── Step 1: User scrolls to bottom, focuses model 14 (ClusterB/DB1) ──
			const step1 = await tracker.processSchema(
				input({
					modelUri: `inmemory://model/14`,
					clusterUrl: CLUSTER_B,
					database: DB_1,
					setAsContext: true,
				}),
				worker,
			);
			expect(step1.operation.action).toBe('replace');
			expect(tracker.databaseInContext).toEqual({ clusterUrl: CLUSTER_B, database: DB_1 });

			// ── Step 2: User moves up to model 13 (ClusterB/DB2) ──
			const step2 = await tracker.processSchema(
				input({
					modelUri: `inmemory://model/13`,
					clusterUrl: CLUSTER_B,
					database: DB_2,
					setAsContext: true,
					rawSchemaJson: makeSchema(DB_2),
				}),
				worker,
			);
			expect(step2.operation.action).toBe('replace');
			expect(tracker.databaseInContext).toEqual({ clusterUrl: CLUSTER_B, database: DB_2 });

			// ── Step 3: User goes back to model 14 (ClusterB/DB1) — THIS WAS THE BUG ──
			const step3 = await tracker.processSchema(
				input({
					modelUri: `inmemory://model/14`,
					clusterUrl: CLUSTER_B,
					database: DB_1,
					setAsContext: true,
				}),
				worker,
			);
			// MUST be replace, NOT skip!
			expect(step3.operation.action).toBe('replace');
			expect(tracker.databaseInContext).toEqual({ clusterUrl: CLUSTER_B, database: DB_1 });
		});
	});

	// ── Three-database round-robin ───────────────────────────────────────
	describe('three-database round-robin on same cluster', () => {
		it('A→B→C→A: context is correct at every step', async () => {
			const dbs = [DB_1, DB_2, DB_3];
			const models = [MODEL_1, MODEL_2, MODEL_3];

			// Initial load
			await tracker.processSchema(
				input({ modelUri: models[0], database: dbs[0] }),
				worker,
			);
			expect(tracker.databaseInContext?.database).toBe(dbs[0]);

			// Cycle through all databases twice
			const sequence = [1, 2, 0, 1, 2, 0];
			for (const idx of sequence) {
				const r = await tracker.processSchema(
					input({
						modelUri: models[idx],
						database: dbs[idx],
						rawSchemaJson: makeSchema(dbs[idx]),
					}),
					worker,
				);
				if (tracker.databaseInContext?.database !== dbs[idx]) {
					// This would indicate a regression
					expect.fail(
						`After switching to ${dbs[idx]}, context is ${tracker.databaseInContext?.database}`,
					);
				}
				// Every switch should be a replace (since database differs from previous)
				expect(r.operation.action).toBe('replace');
			}
		});
	});

	// ── No-focus race condition (regression) ─────────────────────────────
	describe('no-focus schema race condition', () => {
		// Simulates the bug: multiple schemaData responses arrive while no
		// editor has focus. Previously they all pushed to the worker queue;
		// the first-load set context to the wrong database and the user's
		// subsequent focus-triggered replace got stuck behind queued ADDs.
		//
		// The fix: skip worker pushes when no editor has focus (setAsContext=false).
		// Only the focus-driven call with setAsContext=true should push.
		// This test verifies that if we obey the new gating rule, the FIRST
		// worker call is always the focus-driven one with the correct context.

		it('first worker call is the focused section, not a prefetched one', async () => {
			// Phase 1: N schema responses arrive with setAsContext=false.
			// Under the fix, message-handler skips calling processSchema entirely.
			// We simulate what would happen if they DID leak through (old behavior),
			// then show the focus call must still produce the correct context.

			// Simulate: Section A (DB_1) schema arrives first, no focus → first-load
			await tracker.processSchema(
				input({ modelUri: MODEL_1, clusterUrl: CLUSTER_A, database: DB_1, setAsContext: false }),
				worker,
			);
			expect(tracker.databaseInContext?.database).toBe(DB_1); // first-load always sets context

			// Simulate: Section B (DB_2) schema arrives, no focus → add (not context)
			await tracker.processSchema(
				input({ modelUri: MODEL_2, clusterUrl: CLUSTER_A, database: DB_2, setAsContext: false, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);
			// Context should NOT have changed — setAsContext was false
			expect(tracker.databaseInContext?.database).toBe(DB_1);

			// Phase 2: User focuses Section B → setAsContext=true
			const focusResult = await tracker.processSchema(
				input({ modelUri: MODEL_2, clusterUrl: CLUSTER_A, database: DB_2, setAsContext: true, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);
			// Context MUST now be DB_2
			expect(tracker.databaseInContext?.database).toBe(DB_2);
			expect(focusResult.operation.action).toBe('replace');
		});

		it('skipping all no-focus pushes means first focus gets first-load (clean queue)', async () => {
			// Under the fix, ALL prefetch responses are skipped. The tracker
			// stays uninitialised. The first focus-driven call gets first-load.
			expect(tracker.globalInitialized).toBe(false);
			expect(tracker.databaseInContext).toBeNull();

			// User focuses Section B (DB_2) — first-ever schema load
			const result = await tracker.processSchema(
				input({ modelUri: MODEL_2, clusterUrl: CLUSTER_A, database: DB_2, setAsContext: true, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);
			expect(result.operation.action).toBe('first-load');
			expect(tracker.databaseInContext?.database).toBe(DB_2);
			expect(worker.calls).toHaveLength(1);
			expect(worker.calls[0].method).toBe('setSchemaFromShowSchema');
			expect(worker.calls[0].args[1]).toBe(DB_2);
		});

		it('cross-cluster focus after skipped prefetches gets correct context', async () => {
			// Prefetch for Cluster A / DB_1 was skipped (no focus).
			// Tracker is still uninitialised.
			// User focuses a section on Cluster B / DB_2.
			const result = await tracker.processSchema(
				input({ modelUri: MODEL_2, clusterUrl: CLUSTER_B, database: DB_2, setAsContext: true, rawSchemaJson: makeSchema(DB_2) }),
				worker,
			);
			expect(result.operation.action).toBe('first-load');
			expect(tracker.databaseInContext).toEqual({ clusterUrl: CLUSTER_B, database: DB_2 });
		});
	});
});
