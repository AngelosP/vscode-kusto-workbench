import { describe, it, expect } from 'vitest';
import { buildSchemaInfo } from '../../src/webview/shared/schema-utils';

describe('buildSchemaInfo', () => {
	it('returns not-loaded when text is empty', () => {
		const info = buildSchemaInfo('', false);
		expect(info.status).toBe('not-loaded');
		expect(info.statusText).toBe('Not loaded');
		expect(info.cached).toBe(false);
		expect(info.tables).toBeUndefined();
		expect(info.cols).toBeUndefined();
		expect(info.funcs).toBeUndefined();
	});

	it('returns loaded when text is non-empty and no meta', () => {
		const info = buildSchemaInfo('5 tables, 20 cols', false);
		expect(info.status).toBe('loaded');
		expect(info.statusText).toBe('5 tables, 20 cols');
		expect(info.cached).toBe(false);
		expect(info.errorMessage).toBeUndefined();
	});

	it('returns error when isError is true and no meta', () => {
		const info = buildSchemaInfo('Connection failed', true);
		expect(info.status).toBe('error');
		expect(info.statusText).toBe('Error');
		expect(info.errorMessage).toBe('Connection failed');
		expect(info.cached).toBe(false);
	});

	it('returns cached status with meta.fromCache', () => {
		const info = buildSchemaInfo('5 tables, 20 cols', false, {
			tablesCount: 5,
			columnsCount: 20,
			functionsCount: 3,
			fromCache: true,
		});
		expect(info.status).toBe('cached');
		expect(info.statusText).toBe('Cached');
		expect(info.tables).toBe(5);
		expect(info.cols).toBe(20);
		expect(info.funcs).toBe(3);
		expect(info.cached).toBe(true);
		expect(info.errorMessage).toBeUndefined();
	});

	it('returns loaded status with meta and no cache', () => {
		const info = buildSchemaInfo('5 tables, 20 cols', false, {
			tablesCount: 5,
			columnsCount: 20,
			functionsCount: 3,
			fromCache: false,
		});
		expect(info.status).toBe('loaded');
		expect(info.statusText).toBe('Loaded');
		expect(info.tables).toBe(5);
		expect(info.cols).toBe(20);
		expect(info.funcs).toBe(3);
		expect(info.cached).toBe(false);
	});

	it('returns error status with meta', () => {
		const info = buildSchemaInfo('Schema failed', true, {
			tablesCount: 0,
			columnsCount: 0,
			functionsCount: 0,
			fromCache: false,
			errorMessage: 'Authentication failed',
		});
		expect(info.status).toBe('error');
		expect(info.statusText).toBe('Authentication failed');
		expect(info.tables).toBe(0);
		expect(info.cols).toBe(0);
		expect(info.funcs).toBe(0);
		expect(info.errorMessage).toBe('Schema failed');
	});

	it('clamps negative counts to 0', () => {
		const info = buildSchemaInfo('schema', false, {
			tablesCount: -1,
			columnsCount: -5,
			functionsCount: -3,
			fromCache: false,
		});
		expect(info.tables).toBe(0);
		expect(info.cols).toBe(0);
		expect(info.funcs).toBe(0);
	});

	it('handles NaN counts as 0', () => {
		const info = buildSchemaInfo('schema', false, {
			tablesCount: 'abc',
			columnsCount: undefined,
			functionsCount: null,
			fromCache: false,
		});
		expect(info.tables).toBe(0);
		expect(info.cols).toBe(0);
		expect(info.funcs).toBe(0);
	});
});
