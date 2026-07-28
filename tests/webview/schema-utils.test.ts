import { describe, it, expect } from 'vitest';
import { buildSchemaInfo, shouldForceKustoFocusedSchemaApply, shouldScheduleKustoSupplementalSchemaEnhancement, shouldStartKustoSchemaPrewarm } from '../../src/webview/shared/schema-utils';

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

describe('shouldStartKustoSchemaPrewarm', () => {
	it('does not supersede an active full fetch or preparation transaction', () => {
		expect(shouldStartKustoSchemaPrewarm({ schemaFetchInFlight: true })).toBe(false);
		expect(shouldStartKustoSchemaPrewarm({ schemaFetchInFlight: false, authoritativeRequestToken: 'schema_full_1' })).toBe(false);
		expect(shouldStartKustoSchemaPrewarm({ schemaFetchInFlight: false, preparationStatus: 'preparing' })).toBe(false);
		expect(shouldStartKustoSchemaPrewarm({ schemaFetchInFlight: false, diagnosticsTrusted: false })).toBe(false);
	});

	it('allows an idle cache-only prewarm and its own replacement token', () => {
		expect(shouldStartKustoSchemaPrewarm({ schemaFetchInFlight: false, preparationStatus: 'idle' })).toBe(true);
		expect(shouldStartKustoSchemaPrewarm({ schemaFetchInFlight: false, authoritativeRequestToken: 'schema_prewarm_old', preparationStatus: 'idle' })).toBe(true);
	});

	it('does not restart prewarm while schema hydration waits for editor focus', () => {
		expect(shouldStartKustoSchemaPrewarm({
			schemaFetchInFlight: false,
			authoritativeRequestToken: 'schema_prewarm_current',
			preparationStatus: 'deferred',
		})).toBe(false);
	});
});

describe('shouldForceKustoFocusedSchemaApply', () => {
	it('forces the first focus after same-key target invalidation', () => {
		expect(shouldForceKustoFocusedSchemaApply({
			workerApplyRequired: true,
			baseWorkerReady: false,
			workerContextMatches: false,
		})).toBe(true);
	});

	it('reuses a ready worker when its primary context matches', () => {
		expect(shouldForceKustoFocusedSchemaApply({
			workerApplyRequired: false,
			baseWorkerReady: true,
			workerContextMatches: true,
		})).toBe(false);
	});

	it('forces a ready worker whose primary context could not be switched', () => {
		expect(shouldForceKustoFocusedSchemaApply({
			workerApplyRequired: false,
			baseWorkerReady: true,
			workerContextMatches: false,
		})).toBe(true);
	});
});

describe('shouldScheduleKustoSupplementalSchemaEnhancement', () => {
	it('skips supplemental work that would supersede the same primary schema enhancement', () => {
		expect(shouldScheduleKustoSupplementalSchemaEnhancement({
			primarySchemaKey: 'cluster|db',
			supplementalSchemaKey: 'cluster|db',
		})).toBe(false);
	});

	it('keeps supplemental work for a distinct cross-cluster schema', () => {
		expect(shouldScheduleKustoSupplementalSchemaEnhancement({
			primarySchemaKey: 'cluster-a|db',
			supplementalSchemaKey: 'cluster-b|db',
		})).toBe(true);
	});
});
