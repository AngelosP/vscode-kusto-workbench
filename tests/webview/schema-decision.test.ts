import { describe, it, expect } from 'vitest';
import { decideSchemaOperation, SchemaDecisionInput } from '../../src/webview/shared/schema-decision';

// ── Helpers ──────────────────────────────────────────────────────────────────
const CLUSTER_A = 'https://clusterA.kusto.windows.net';
const CLUSTER_B = 'https://clusterB.kusto.windows.net';
const DB_A = 'DatabaseA';
const DB_B = 'DatabaseB';

/** Build an input with sensible defaults. */
function input(overrides: Partial<SchemaDecisionInput> = {}): SchemaDecisionInput {
	return {
		globalInitialized: true,
		perModelLoaded: false,
		currentClusterUrl: null,
		currentDatabase: null,
		newClusterUrl: CLUSTER_A,
		newDatabase: DB_A,
		setAsContext: true,
		forceRefresh: false,
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('decideSchemaOperation', () => {

	// ── First-ever load ──────────────────────────────────────────────────
	describe('first-ever schema load', () => {
		it('returns first-load when globalInitialized=false', () => {
			const result = decideSchemaOperation(input({ globalInitialized: false }));
			expect(result.action).toBe('first-load');
		});
	});

	// ── Already-loaded fast paths ────────────────────────────────────────
	describe('already-loaded fast paths', () => {
		it('skips when same cluster+database and setAsContext=true', () => {
			const result = decideSchemaOperation(input({
				perModelLoaded: true,
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_A,
			}));
			expect(result.action).toBe('skip');
		});

		it('skips when perModelLoaded and setAsContext=false', () => {
			const result = decideSchemaOperation(input({
				perModelLoaded: true,
				setAsContext: false,
			}));
			expect(result.action).toBe('skip');
		});
	});

	// ── Same cluster, different database ─────────────────────────────────
	// THIS IS THE KEY SCENARIO THAT WAS BROKEN
	describe('same cluster, different database', () => {
		it('returns replace when switching from DatabaseA to DatabaseB', () => {
			const result = decideSchemaOperation(input({
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_B,
			}));
			expect(result.action).toBe('replace');
			if (result.action === 'replace') {
				expect(result.reason).toBe('different-database');
			}
		});

		it('returns replace even when perModelLoaded is true (needs context switch)', () => {
			const result = decideSchemaOperation(input({
				perModelLoaded: true,
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_B,
			}));
			// Must NOT skip — must replace to switch context
			expect(result.action).toBe('replace');
		});

		it('returns add (not replace) when forceRefresh=true even if database differs', () => {
			const result = decideSchemaOperation(input({
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_B,
				forceRefresh: true,
			}));
			expect(result.action).toBe('add');
		});

		it('returns add when setAsContext=false even if database differs', () => {
			const result = decideSchemaOperation(input({
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_B,
				setAsContext: false,
			}));
			expect(result.action).toBe('add');
		});
	});

	// ── Different cluster ────────────────────────────────────────────────
	describe('different cluster', () => {
		it('returns replace when switching to a different cluster', () => {
			const result = decideSchemaOperation(input({
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_B,
				newDatabase: DB_A,
			}));
			expect(result.action).toBe('replace');
			if (result.action === 'replace') {
				expect(result.reason).toBe('different-cluster');
			}
		});

		it('returns replace when switching cluster AND database', () => {
			const result = decideSchemaOperation(input({
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_B,
				newDatabase: DB_B,
			}));
			expect(result.action).toBe('replace');
		});
	});

	// ── Round-trip scenario (the exact user bug) ─────────────────────────
	describe('round-trip: A→B→A (same cluster)', () => {
		it('correctly switches context on each step', () => {
			// Step 1: First load of ClusterA/DatabaseA
			const step1 = decideSchemaOperation(input({
				globalInitialized: false,
				currentClusterUrl: null,
				currentDatabase: null,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_A,
			}));
			expect(step1.action).toBe('first-load');

			// Step 2: Switch to ClusterA/DatabaseB (after first-load set context to A/A)
			const step2 = decideSchemaOperation(input({
				globalInitialized: true,
				perModelLoaded: false,
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_A,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_B,
			}));
			expect(step2.action).toBe('replace');

			// Step 3: Switch back to ClusterA/DatabaseA (after replace set context to A/B)
			const step3 = decideSchemaOperation(input({
				globalInitialized: true,
				perModelLoaded: false,  // cleared by the replace in step 2
				currentClusterUrl: CLUSTER_A,
				currentDatabase: DB_B,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_A,
			}));
			expect(step3.action).toBe('replace');
		});
	});

	// ── No context yet (null current) ────────────────────────────────────
	describe('no current context', () => {
		it('returns replace when setAsContext=true and no prior context', () => {
			const result = decideSchemaOperation(input({
				globalInitialized: true,
				currentClusterUrl: null,
				currentDatabase: null,
				newClusterUrl: CLUSTER_A,
				newDatabase: DB_A,
			}));
			// null current means isSameDatabase=false → replace
			expect(result.action).toBe('replace');
		});
	});

	// ── Cluster URL normalization ────────────────────────────────────────
	describe('cluster URL normalization', () => {
		it('treats http and https URLs as same cluster', () => {
			const result = decideSchemaOperation(input({
				perModelLoaded: true,
				currentClusterUrl: 'https://clusterA.kusto.windows.net',
				currentDatabase: DB_A,
				newClusterUrl: 'http://clusterA.kusto.windows.net',
				newDatabase: DB_A,
			}));
			expect(result.action).toBe('skip');
		});

		it('treats URLs with trailing slash as same cluster', () => {
			const result = decideSchemaOperation(input({
				perModelLoaded: true,
				currentClusterUrl: 'https://clusterA.kusto.windows.net/',
				currentDatabase: DB_A,
				newClusterUrl: 'https://clusterA.kusto.windows.net',
				newDatabase: DB_A,
			}));
			expect(result.action).toBe('skip');
		});

		it('is case-insensitive for cluster URLs', () => {
			const result = decideSchemaOperation(input({
				perModelLoaded: true,
				currentClusterUrl: 'https://ClusterA.Kusto.Windows.Net',
				currentDatabase: DB_A,
				newClusterUrl: 'https://clustera.kusto.windows.net',
				newDatabase: DB_A,
			}));
			expect(result.action).toBe('skip');
		});

		it('is case-insensitive for database names', () => {
			const result = decideSchemaOperation(input({
				perModelLoaded: true,
				currentClusterUrl: CLUSTER_A,
				currentDatabase: 'DATABASEA',
				newClusterUrl: CLUSTER_A,
				newDatabase: 'databasea',
			}));
			expect(result.action).toBe('skip');
		});
	});
});
