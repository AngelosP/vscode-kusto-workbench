import { describe, it, expect } from 'vitest';
import { appendSqlQueryMode, isSqlDmlStatement } from '../../../src/host/sqlEditorUtils';

// ---------------------------------------------------------------------------
// isSqlDmlStatement
// ---------------------------------------------------------------------------

describe('isSqlDmlStatement', () => {
	it('returns true for INSERT', () => {
		expect(isSqlDmlStatement('INSERT INTO t VALUES (1)')).toBe(true);
	});

	it('returns true for UPDATE', () => {
		expect(isSqlDmlStatement('UPDATE t SET x = 1')).toBe(true);
	});

	it('returns true for DELETE', () => {
		expect(isSqlDmlStatement('DELETE FROM t WHERE id = 1')).toBe(true);
	});

	it('returns true for EXEC', () => {
		expect(isSqlDmlStatement('EXEC sp_help')).toBe(true);
	});

	it('returns true for CREATE', () => {
		expect(isSqlDmlStatement('CREATE TABLE t (id INT)')).toBe(true);
	});

	it('returns true for DROP', () => {
		expect(isSqlDmlStatement('DROP TABLE t')).toBe(true);
	});

	it('returns false for SELECT', () => {
		expect(isSqlDmlStatement('SELECT * FROM t')).toBe(false);
	});

	it('returns false for WITH (CTE)', () => {
		expect(isSqlDmlStatement('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(false);
	});

	it('returns true for DML with leading comments', () => {
		expect(isSqlDmlStatement('-- comment\nINSERT INTO t VALUES (1)')).toBe(true);
	});

	it('returns true for DML with block comments', () => {
		expect(isSqlDmlStatement('/* block */ DELETE FROM t')).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// appendSqlQueryMode
// ---------------------------------------------------------------------------

describe('appendSqlQueryMode', () => {
	// ── Mode passthrough ──

	it('returns unchanged for plain mode', () => {
		expect(appendSqlQueryMode('SELECT * FROM t', 'plain')).toBe('SELECT * FROM t');
	});

	it('returns unchanged for empty mode', () => {
		expect(appendSqlQueryMode('SELECT * FROM t', '')).toBe('SELECT * FROM t');
	});

	it('returns unchanged for undefined mode', () => {
		expect(appendSqlQueryMode('SELECT * FROM t')).toBe('SELECT * FROM t');
	});

	// ── Simple SELECT ──

	it('injects TOP 100 into simple SELECT', () => {
		expect(appendSqlQueryMode('SELECT * FROM t', 'top100')).toBe('SELECT TOP 100 * FROM t');
	});

	it('injects TOP 100 with columns', () => {
		expect(appendSqlQueryMode('SELECT col1, col2 FROM t', 'top100')).toBe('SELECT TOP 100 col1, col2 FROM t');
	});

	// ── DISTINCT / ALL ──

	it('injects TOP 100 after DISTINCT', () => {
		expect(appendSqlQueryMode('SELECT DISTINCT col FROM t', 'top100'))
			.toBe('SELECT DISTINCT TOP 100 col FROM t');
	});

	it('injects TOP 100 after ALL', () => {
		expect(appendSqlQueryMode('SELECT ALL col FROM t', 'top100'))
			.toBe('SELECT ALL TOP 100 col FROM t');
	});

	// ── Existing TOP ──

	it('skips injection when TOP already present', () => {
		expect(appendSqlQueryMode('SELECT TOP 50 * FROM t', 'top100')).toBe('SELECT TOP 50 * FROM t');
	});

	it('skips injection when DISTINCT TOP already present', () => {
		const q = 'SELECT DISTINCT TOP 10 col FROM t';
		expect(appendSqlQueryMode(q, 'top100')).toBe(q);
	});

	// ── Leading comments ──

	it('handles line comments before SELECT', () => {
		expect(appendSqlQueryMode('-- comment\nSELECT * FROM t', 'top100'))
			.toBe('-- comment\nSELECT TOP 100 * FROM t');
	});

	it('handles block comments before SELECT', () => {
		expect(appendSqlQueryMode('/* block */ SELECT * FROM t', 'top100'))
			.toBe('/* block */ SELECT TOP 100 * FROM t');
	});

	// ── DML / DDL skip ──

	it('skips INSERT', () => {
		expect(appendSqlQueryMode('INSERT INTO t VALUES (1)', 'top100')).toBe('INSERT INTO t VALUES (1)');
	});

	it('skips UPDATE', () => {
		expect(appendSqlQueryMode('UPDATE t SET x = 1', 'top100')).toBe('UPDATE t SET x = 1');
	});

	it('skips DELETE', () => {
		expect(appendSqlQueryMode('DELETE FROM t', 'top100')).toBe('DELETE FROM t');
	});

	it('skips EXEC', () => {
		expect(appendSqlQueryMode('EXEC sp_who', 'top100')).toBe('EXEC sp_who');
	});

	it('skips CREATE TABLE', () => {
		expect(appendSqlQueryMode('CREATE TABLE t (id INT)', 'top100')).toBe('CREATE TABLE t (id INT)');
	});

	// ── Trailing semicolons / whitespace ──

	it('strips trailing semicolons', () => {
		expect(appendSqlQueryMode('SELECT * FROM t;', 'top100')).toBe('SELECT TOP 100 * FROM t');
	});

	it('strips trailing whitespace', () => {
		expect(appendSqlQueryMode('SELECT * FROM t   ', 'top100')).toBe('SELECT TOP 100 * FROM t');
	});

	// ── CTE handling ──

	it('injects TOP 100 in final SELECT after single CTE', () => {
		const q = 'WITH cte AS (SELECT id FROM t) SELECT * FROM cte';
		expect(appendSqlQueryMode(q, 'top100'))
			.toBe('WITH cte AS (SELECT id FROM t) SELECT TOP 100 * FROM cte');
	});

	it('injects TOP 100 in final SELECT after multiple CTEs', () => {
		const q = 'WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT * FROM a, b';
		expect(appendSqlQueryMode(q, 'top100'))
			.toBe('WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS y) SELECT TOP 100 * FROM a, b');
	});

	it('does not inject TOP inside CTE body', () => {
		const q = 'WITH cte AS (SELECT id FROM t) SELECT * FROM cte';
		const result = appendSqlQueryMode(q, 'top100');
		// CTE body should be untouched — only one TOP 100 in the result
		const topCount = (result.match(/TOP 100/gi) || []).length;
		expect(topCount).toBe(1);
	});

	it('handles CTE with column list', () => {
		const q = 'WITH cte (a, b) AS (SELECT 1, 2) SELECT * FROM cte';
		expect(appendSqlQueryMode(q, 'top100'))
			.toBe('WITH cte (a, b) AS (SELECT 1, 2) SELECT TOP 100 * FROM cte');
	});

	it('skips when CTE final SELECT already has TOP', () => {
		const q = 'WITH cte AS (SELECT id FROM t) SELECT TOP 20 * FROM cte';
		expect(appendSqlQueryMode(q, 'top100')).toBe(q);
	});

	it('handles CTE with DISTINCT in final SELECT', () => {
		const q = 'WITH cte AS (SELECT id FROM t) SELECT DISTINCT id FROM cte';
		expect(appendSqlQueryMode(q, 'top100'))
			.toBe('WITH cte AS (SELECT id FROM t) SELECT DISTINCT TOP 100 id FROM cte');
	});

	// ── Edge cases ──

	it('returns empty string unchanged', () => {
		expect(appendSqlQueryMode('', 'top100')).toBe('');
	});

	it('returns whitespace-only unchanged', () => {
		expect(appendSqlQueryMode('   ', 'top100')).toBe('   ');
	});

	it('handles case-insensitive SELECT', () => {
		expect(appendSqlQueryMode('select * from t', 'top100')).toBe('select TOP 100 * from t');
	});

	it('handles nested subqueries — only injects into outer SELECT', () => {
		const q = 'SELECT * FROM (SELECT id FROM t) sub';
		const result = appendSqlQueryMode(q, 'top100');
		expect(result).toBe('SELECT TOP 100 * FROM (SELECT id FROM t) sub');
	});

	it('handles CTE with nested parens in body', () => {
		const q = 'WITH cte AS (SELECT id, (SELECT MAX(x) FROM y) AS mx FROM t) SELECT * FROM cte';
		expect(appendSqlQueryMode(q, 'top100'))
			.toBe('WITH cte AS (SELECT id, (SELECT MAX(x) FROM y) AS mx FROM t) SELECT TOP 100 * FROM cte');
	});

	it('handles WITH followed by comment before SELECT', () => {
		const q = 'WITH cte AS (SELECT 1 AS x)\n-- final\nSELECT * FROM cte';
		expect(appendSqlQueryMode(q, 'top100'))
			.toBe('WITH cte AS (SELECT 1 AS x)\n-- final\nSELECT TOP 100 * FROM cte');
	});
});
