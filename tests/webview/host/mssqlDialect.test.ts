import { describe, it, expect } from 'vitest';
import { MssqlDialect } from '../../../src/host/sql/mssqlDialect';

const dialect = new MssqlDialect();

// ── Properties ────────────────────────────────────────────────────────────────

describe('MssqlDialect properties', () => {
	it('has id "mssql"', () => {
		expect(dialect.id).toBe('mssql');
	});

	it('has defaultPort 1433', () => {
		expect(dialect.defaultPort).toBe(1433);
	});

	it('supports aad and sql-login auth types', () => {
		const ids = dialect.authTypes.map(a => a.id);
		expect(ids).toContain('aad');
		expect(ids).toContain('sql-login');
	});
});

// ── Error classification ──────────────────────────────────────────────────────

describe('MssqlDialect.isAuthError', () => {
	it('returns true for SQL error 18456 (login failed)', () => {
		const err = Object.assign(new Error('Login failed'), { number: 18456 });
		expect(dialect.isAuthError(err)).toBe(true);
	});

	it('returns true for SQL error 18452', () => {
		const err = Object.assign(new Error('Login failed'), { number: 18452 });
		expect(dialect.isAuthError(err)).toBe(true);
	});

	it('returns true for ELOGIN code', () => {
		const err = Object.assign(new Error('connection refused'), { code: 'ELOGIN' });
		expect(dialect.isAuthError(err)).toBe(true);
	});

	it('returns true for "Login failed" message', () => {
		expect(dialect.isAuthError(new Error('Login failed for user "sa"'))).toBe(true);
	});

	it('returns true for "unauthorized" message', () => {
		expect(dialect.isAuthError(new Error('unauthorized request'))).toBe(true);
	});

	it('returns false for non-auth errors', () => {
		expect(dialect.isAuthError(new Error('timeout'))).toBe(false);
	});

	it('returns false for non-Error objects', () => {
		expect(dialect.isAuthError('some string')).toBe(false);
	});
});

describe('MssqlDialect.isCancelError', () => {
	it('returns true for ECANCEL code', () => {
		const err = Object.assign(new Error('cancelled'), { code: 'ECANCEL' });
		expect(dialect.isCancelError(err)).toBe(true);
	});

	it('returns true for EABORT code', () => {
		const err = Object.assign(new Error('aborted'), { code: 'EABORT' });
		expect(dialect.isCancelError(err)).toBe(true);
	});

	it('returns true for "cancelled" in message', () => {
		expect(dialect.isCancelError(new Error('query was cancelled'))).toBe(true);
	});

	it('returns true for "canceled" (US spelling)', () => {
		expect(dialect.isCancelError(new Error('request canceled'))).toBe(true);
	});

	it('returns false for non-cancel errors', () => {
		expect(dialect.isCancelError(new Error('timeout'))).toBe(false);
	});
});

describe('MssqlDialect.formatError', () => {
	it('includes SQL error number when present', () => {
		const err = Object.assign(new Error('bad query'), { number: 102 });
		expect(dialect.formatError(err)).toContain('SQL Error 102');
	});

	it('includes error code when present', () => {
		const err = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
		expect(dialect.formatError(err)).toContain('[ETIMEOUT]');
	});

	it('falls back to String() for non-Error', () => {
		expect(dialect.formatError('raw string')).toBe('raw string');
	});
});
