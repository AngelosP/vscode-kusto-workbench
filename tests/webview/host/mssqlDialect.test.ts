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
