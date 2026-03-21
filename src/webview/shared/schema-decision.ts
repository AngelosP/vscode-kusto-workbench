/**
 * Pure decision logic for monaco-kusto schema operations.
 *
 * Extracted from the massive __kustoSetMonacoKustoSchemaInternal so it can be
 * unit-tested without mocking Monaco, workers, or the DOM.
 *
 * Given the current tracking state, returns the *operation* the caller should perform.
 */

export type SchemaOperation =
	| { action: 'skip'; reason: string }
	| { action: 'first-load' }
	| { action: 'replace'; reason: string }
	| { action: 'add'; setContext: boolean };

export interface SchemaDecisionInput {
	/** Has any schema ever been loaded via setSchemaFromShowSchema? */
	globalInitialized: boolean;
	/** Is this schema already tracked as loaded for the current model? */
	perModelLoaded: boolean;
	/** Cluster URL of the database currently in context for this model (null if none). */
	currentClusterUrl: string | null;
	/** Database name currently in context for this model (null if none). */
	currentDatabase: string | null;
	/** Cluster URL of the schema being loaded. */
	newClusterUrl: string;
	/** Database name of the schema being loaded. */
	newDatabase: string;
	/** Should this schema become the active autocomplete context? */
	setAsContext: boolean;
	/** Is this a force-refresh of the same database's schema? */
	forceRefresh: boolean;
}

/** Normalize a cluster URL for comparison (strip scheme, trailing slash, lowercase). */
function normalizeClusterUrl(url: string | null | undefined): string {
	if (!url) return '';
	let normalized = String(url).trim().toLowerCase();
	normalized = normalized.replace(/^https?:\/\//, '');
	normalized = normalized.replace(/\/+$/, '');
	return normalized;
}

/**
 * Determine which schema operation to perform.
 *
 * The caller is responsible for executing the operation against the Monaco worker.
 */
export function decideSchemaOperation(input: SchemaDecisionInput): SchemaOperation {
	const currentClusterNorm = normalizeClusterUrl(input.currentClusterUrl);
	const newClusterNorm = normalizeClusterUrl(input.newClusterUrl);
	const isSameCluster = !!currentClusterNorm && currentClusterNorm === newClusterNorm;
	const isSameDatabase = isSameCluster &&
		(input.currentDatabase || '').toLowerCase() === (input.newDatabase || '').toLowerCase();

	// ── Already loaded? ──────────────────────────────────────────────────
	if (input.perModelLoaded) {
		if (!input.setAsContext) {
			return { action: 'skip', reason: 'already-loaded-no-context-switch' };
		}
		if (isSameDatabase) {
			return { action: 'skip', reason: 'already-loaded-same-database' };
		}
		// Different database — need to reload. Fall through (caller should
		// clear perModelLoaded tracking before calling the worker).
	}

	// ── First-ever schema load ───────────────────────────────────────────
	if (!input.globalInitialized) {
		return { action: 'first-load' };
	}

	// ── Subsequent loads ─────────────────────────────────────────────────
	// When setAsContext is true and database differs, we MUST use
	// setSchemaFromShowSchema (replace) to guarantee autocomplete switches.
	// forceRefresh deliberately uses the ADD path to avoid disrupting context.
	const needsReplace = input.setAsContext && !isSameDatabase && !input.forceRefresh;
	if (needsReplace) {
		const reason = !isSameCluster ? 'different-cluster' : 'different-database';
		return { action: 'replace', reason };
	}

	// ADD path: addDatabaseToSchema (preserves existing schemas)
	return { action: 'add', setContext: input.setAsContext };
}
