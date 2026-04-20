import type { SqlDialect } from './sqlDialect';
import { MssqlDialect } from './mssqlDialect';

// ---------------------------------------------------------------------------
// SqlDialectRegistry — register / get / list SQL dialect implementations
// ---------------------------------------------------------------------------

const dialects = new Map<string, SqlDialect>();

/** Register a dialect. Overwrites any previous registration with the same id. */
export function registerDialect(dialect: SqlDialect): void {
	dialects.set(dialect.id, dialect);
}

/** Get a dialect by id. Returns `undefined` if not registered. */
export function getDialect(id: string): SqlDialect | undefined {
	return dialects.get(id);
}

/** List all registered dialects. */
export function listDialects(): SqlDialect[] {
	return [...dialects.values()];
}

// ── Pre-register built-in dialects ──────────────────────────────────────────

registerDialect(new MssqlDialect());
