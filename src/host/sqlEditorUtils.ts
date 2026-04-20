/**
 * Pure utility functions for SQL query mode injection.
 *
 * Zero VS Code imports — can be unit-tested with Vitest.
 */

// ---------------------------------------------------------------------------
// isSqlDmlStatement
// ---------------------------------------------------------------------------

/** Strip leading whitespace and SQL comments, return first keyword (uppercased). */
function firstKeyword(query: string): string {
	let s = query;
	// Strip leading whitespace + line comments (--) + block comments (/* ... */)
	for (;;) {
		const prev = s;
		s = s.replace(/^\s+/, '');
		// Line comment
		if (s.startsWith('--')) {
			const nl = s.indexOf('\n');
			s = nl < 0 ? '' : s.slice(nl + 1);
			continue;
		}
		// Block comment
		if (s.startsWith('/*')) {
			const end = s.indexOf('*/');
			s = end < 0 ? '' : s.slice(end + 2);
			continue;
		}
		if (s === prev) break;
	}
	const m = s.match(/^([A-Za-z_]+)/);
	return m ? m[1].toUpperCase() : '';
}

const DML_DDL_KEYWORDS = new Set([
	'INSERT', 'UPDATE', 'DELETE', 'MERGE',
	'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
	'EXEC', 'EXECUTE',
	'GRANT', 'REVOKE', 'DENY',
	'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVE',
	'SET', 'USE', 'PRINT', 'RAISERROR', 'THROW',
	'IF', 'WHILE', 'DECLARE', 'GOTO', 'RETURN', 'WAITFOR',
	'BACKUP', 'RESTORE', 'DBCC', 'BULK',
]);

export function isSqlDmlStatement(query: string): boolean {
	const kw = firstKeyword(query);
	return DML_DDL_KEYWORDS.has(kw);
}

// ---------------------------------------------------------------------------
// appendSqlQueryMode
// ---------------------------------------------------------------------------

/**
 * Inject `TOP 100` into a SQL SELECT query when `queryMode` is `'top100'`.
 *
 * CTE-aware: skips `WITH ... AS (...)` definitions and injects into the
 * outermost (final) SELECT only.
 *
 * Returns the query unchanged when:
 * - mode is `'plain'`, empty, or undefined
 * - first keyword is not SELECT / WITH (DML / DDL)
 * - the target SELECT already contains TOP
 */
export function appendSqlQueryMode(query: string, queryMode?: string): string {
	const mode = (queryMode ?? '').toLowerCase();
	if (mode !== 'top100') return query;

	if (isSqlDmlStatement(query)) return query;

	const kw = firstKeyword(query);
	if (kw !== 'SELECT' && kw !== 'WITH') return query;

	// Trim trailing whitespace + semicolons for clean injection.
	const base = query.replace(/\s+$/g, '').replace(/;+\s*$/g, '');

	if (kw === 'SELECT') {
		return injectTopIntoSelect(base);
	}

	// WITH ... AS (...) [, name AS (...)]* SELECT ...
	return injectTopAfterCte(base);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Given a string that starts at the SELECT keyword (possibly after stripping
 * comments), inject `TOP 100` respecting DISTINCT / ALL / existing TOP.
 *
 * Returns the modified full string (prefix + injected SELECT + rest).
 */
function injectTopIntoSelect(sql: string): string {
	// Find the SELECT keyword position (after any leading comments/whitespace).
	const selectIdx = findSelectKeyword(sql);
	if (selectIdx < 0) return sql;

	const prefix = sql.slice(0, selectIdx);
	const selectWord = sql.slice(selectIdx, selectIdx + 6); // preserve original case
	const afterSelect = sql.slice(selectIdx + 6); // len('SELECT') = 6

	// Check what follows SELECT (whitespace then next token).
	const afterTrimmed = afterSelect.replace(/^\s+/, '');
	const nextToken = afterTrimmed.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? '';

	// Already has TOP → leave unchanged.
	if (nextToken === 'TOP') return sql;

	// DISTINCT / ALL → inject after that keyword (but check for TOP after it).
	if (nextToken === 'DISTINCT' || nextToken === 'ALL') {
		const kwLen = nextToken.length;
		const kwIdx = afterSelect.search(/[A-Za-z]/);
		const originalKw = afterSelect.slice(kwIdx, kwIdx + kwLen);
		const afterKw = afterSelect.slice(kwIdx + kwLen);
		const afterKwToken = afterKw.replace(/^\s+/, '').match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? '';
		if (afterKwToken === 'TOP') return sql; // DISTINCT TOP already present
		const beforeKw = afterSelect.slice(0, kwIdx);
		return prefix + selectWord + beforeKw + originalKw + ' TOP 100' + afterKw;
	}

	// Simple case: SELECT ... → SELECT TOP 100 ...
	return prefix + selectWord + ' TOP 100' + afterSelect;
}

/** Find the position of the outermost SELECT after CTE definitions. */
function injectTopAfterCte(sql: string): string {
	// Strategy: scan past the WITH keyword, then skip each CTE definition
	// (name AS (...balanced parens...)), separated by commas, until we
	// reach the final SELECT.
	const withIdx = findWithKeyword(sql);
	if (withIdx < 0) return sql;

	let pos = withIdx + 4; // skip 'WITH'

	// Skip CTEs: each is `name AS (...)`
	for (;;) {
		pos = skipWhitespaceAndComments(sql, pos);
		// CTE name
		const nameMatch = sql.slice(pos).match(/^[\["]?[A-Za-z_][\w]*[\]"]?/);
		if (!nameMatch) break;
		pos += nameMatch[0].length;
		pos = skipWhitespaceAndComments(sql, pos);

		// Optional column list
		if (sql[pos] === '(') {
			pos = skipBalancedParens(sql, pos);
			pos = skipWhitespaceAndComments(sql, pos);
		}

		// AS keyword
		const asMatch = sql.slice(pos).match(/^AS\b/i);
		if (!asMatch) break;
		pos += 2; // skip 'AS'
		pos = skipWhitespaceAndComments(sql, pos);

		// CTE body (balanced parens)
		if (sql[pos] === '(') {
			pos = skipBalancedParens(sql, pos);
		} else {
			break;
		}

		pos = skipWhitespaceAndComments(sql, pos);

		// Comma → another CTE follows
		if (sql[pos] === ',') {
			pos++;
			continue;
		}
		break;
	}

	// Now pos should be at the final SELECT.
	const rest = sql.slice(pos);
	const restKw = firstKeyword(rest);
	if (restKw !== 'SELECT') return sql;

	const injected = injectTopIntoSelect(rest);
	return sql.slice(0, pos) + injected;
}

/** Find the index of the SELECT keyword, skipping leading comments/whitespace. */
function findSelectKeyword(sql: string): number {
	let i = 0;
	for (;;) {
		// Whitespace
		while (i < sql.length && /\s/.test(sql[i])) i++;
		// Line comment
		if (sql[i] === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl < 0 ? sql.length : nl + 1;
			continue;
		}
		// Block comment
		if (sql[i] === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end < 0 ? sql.length : end + 2;
			continue;
		}
		break;
	}
	if (sql.slice(i, i + 6).toUpperCase() === 'SELECT') return i;
	return -1;
}

/** Find the index of the WITH keyword, skipping leading comments/whitespace. */
function findWithKeyword(sql: string): number {
	let i = 0;
	for (;;) {
		while (i < sql.length && /\s/.test(sql[i])) i++;
		if (sql[i] === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl < 0 ? sql.length : nl + 1;
			continue;
		}
		if (sql[i] === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end < 0 ? sql.length : end + 2;
			continue;
		}
		break;
	}
	if (sql.slice(i, i + 4).toUpperCase() === 'WITH') return i;
	return -1;
}

/** Skip balanced parentheses starting at `pos` (which must be '('). */
function skipBalancedParens(sql: string, pos: number): number {
	if (sql[pos] !== '(') return pos;
	let depth = 0;
	let i = pos;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === '(') { depth++; }
		else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
		else if (ch === '\'' || ch === '"') { i = skipStringLiteral(sql, i); continue; }
		else if (ch === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl < 0 ? sql.length : nl + 1;
			continue;
		}
		else if (ch === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end < 0 ? sql.length : end + 2;
			continue;
		}
		i++;
	}
	return i;
}

/** Skip a single-quoted or double-quoted string literal. */
function skipStringLiteral(sql: string, pos: number): number {
	const quote = sql[pos];
	let i = pos + 1;
	while (i < sql.length) {
		if (sql[i] === quote) {
			if (sql[i + 1] === quote) { i += 2; continue; } // escaped quote
			return i + 1;
		}
		i++;
	}
	return i;
}

/** Skip whitespace and comments starting at `pos`. */
function skipWhitespaceAndComments(sql: string, pos: number): number {
	let i = pos;
	for (;;) {
		while (i < sql.length && /\s/.test(sql[i])) i++;
		if (sql[i] === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl < 0 ? sql.length : nl + 1;
			continue;
		}
		if (sql[i] === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end < 0 ? sql.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}
