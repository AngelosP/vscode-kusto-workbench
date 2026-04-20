import { describe, it, expect, beforeEach } from 'vitest';
import { registerDialect, getDialect, listDialects } from '../../../src/host/sql/sqlDialectRegistry';
import type { SqlDialect } from '../../../src/host/sql/sqlDialect';

describe('SqlDialectRegistry', () => {
	it('has mssql pre-registered', () => {
		const mssql = getDialect('mssql');
		expect(mssql).toBeDefined();
		expect(mssql!.id).toBe('mssql');
	});

	it('returns undefined for unknown dialect', () => {
		expect(getDialect('pg')).toBeUndefined();
		expect(getDialect('')).toBeUndefined();
	});

	it('lists all registered dialects', () => {
		const dialects = listDialects();
		expect(dialects.length).toBeGreaterThanOrEqual(1);
		expect(dialects.some(d => d.id === 'mssql')).toBe(true);
	});

	it('can register a custom dialect', () => {
		const fake: SqlDialect = {
			id: 'fake',
			displayName: 'Fake DB',
			defaultPort: 9999,
			authTypes: [],
			createPool: async () => ({}),
			closePool: async () => {},
			executeQuery: async () => ({ columns: [], rows: [], metadata: { cluster: '', database: '', executionTime: '' } }),
			cancelQuery: async () => {},
			getDatabases: async () => [],
			getDatabaseSchema: async () => ({ tables: [], columnsByTable: {} }),
			formatError: (e) => String(e),
			isAuthError: () => false,
			isCancelError: () => false,
		};
		registerDialect(fake);
		expect(getDialect('fake')).toBe(fake);
	});

	it('overwrites existing dialect on re-register', () => {
		const first = getDialect('mssql');
		const replacement: SqlDialect = {
			...first!,
			displayName: 'Replaced',
		};
		registerDialect(replacement);
		expect(getDialect('mssql')!.displayName).toBe('Replaced');
		// Restore original
		registerDialect(first!);
	});
});
