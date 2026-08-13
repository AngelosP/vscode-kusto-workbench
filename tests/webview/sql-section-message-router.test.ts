import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearSqlSectionSessionsForTest,
	registerSqlDerivedComparisonSession,
	registerSqlSectionSession,
	routeSqlSectionMessage,
	type SqlSectionMessageRouterEffects,
	type SqlSectionSessionTarget,
} from '../../src/webview/core/sql-section-message-router.js';
import { SqlStsRequestCoordinator } from '../../src/webview/monaco/sql-sts-request-coordinator.js';

function createTarget(boxId = 'sql-1'): SqlSectionSessionTarget {
	let generation = 0;
	let ownerToken = '';
	let requestId = '';
	return {
		boxId,
		instanceId: `instance-${boxId}`,
		get targetGeneration() { return generation; },
		get ownerToken() { return ownerToken; },
		stsReady: false,
		advanceTargetGeneration: vi.fn(() => ++generation),
		adoptHostGeneration: vi.fn((next: number) => {
			if (!Number.isSafeInteger(next) || next < generation) return false;
			generation = next;
			requestId = '';
			return true;
		}),
		clearDatabaseRequest: vi.fn(() => { requestId = ''; }),
		beginDatabaseRequest: vi.fn((nextRequestId: string, nextGeneration: number) => {
			if (!nextRequestId || nextGeneration !== generation) return false;
			requestId = nextRequestId;
			return true;
		}),
		acceptDatabaseResponse: vi.fn((candidate: string | undefined, nextGeneration: number) =>
			!!candidate && nextGeneration === generation && candidate === requestId),
		completeDatabaseRequest: vi.fn((candidate: string) => {
			if (!candidate || candidate !== requestId) return false;
			requestId = '';
			return true;
		}),
		setStsReady: vi.fn((ready: boolean, token = '') => { ownerToken = ready ? token : ''; return true; }),
		setExecutionOwner: vi.fn((token: string) => { ownerToken = token; return !!token; }),
		requestSts: vi.fn(() => Promise.resolve(null)),
		admitOwnedMessage: vi.fn(message => ownerToken === String(message.ownerToken || '')),
		resolveStsResponse: vi.fn(() => true),
		clear: vi.fn(),
	};
}

function createEffects(target: SqlSectionSessionTarget) {
	const section = {
		sqlSession: target,
		getSqlConnectionId: vi.fn(() => 'sql-a'),
		getConnectionId: vi.fn(() => 'sql-a'),
		getDatabase: vi.fn(() => 'Db'),
		invalidateOwner: vi.fn(),
		clearResults: vi.fn(),
		setDatabasesLoading: vi.fn(),
		setSchemaInfo: vi.fn(),
		setStsReady: vi.fn(),
		setExecutionOwner: vi.fn(),
	};
	const effects: SqlSectionMessageRouterEffects = {
		getSection: vi.fn(() => section),
		clearSchema: vi.fn(),
		setSchema: vi.fn(),
		updateDatabases: vi.fn(),
		reportDatabasesError: vi.fn(),
		handleStsResponse: vi.fn(),
		handleStsDiagnostics: vi.fn(),
		clearPolicyBox: vi.fn(),
	};
	return { effects };
}

describe('routeSqlSectionMessage', () => {
	beforeEach(() => clearSqlSectionSessionsForTest());

	it('rejects stale database responses and handles the exact request', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.adoptHostGeneration(4);
		expect(routeSqlSectionMessage({ type: 'sqlDatabasesLoading', boxId: 'sql-1', sectionInstanceId: target.instanceId, sqlConnectionId: 'sql-a', requestId: 'current', targetGeneration: 4 }, effects)).toBe('handled');
		expect(routeSqlSectionMessage({ type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId, sqlConnectionId: 'sql-a', targetGeneration: 4, databases: ['Db'] }, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({ type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId, sqlConnectionId: 'sql-a', requestId: 'stale', targetGeneration: 4, databases: ['Db'] }, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({ type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId, sqlConnectionId: 'sql-a', requestId: 'current', targetGeneration: 4, databases: ['Db'] }, effects)).toBe('handled');
		expect(effects.updateDatabases).toHaveBeenCalledOnce();
	});

	it('does not clear a reentrant newer database request', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.adoptHostGeneration(4);
		expect(routeSqlSectionMessage({
			type: 'sqlDatabasesLoading', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', requestId: 'first', targetGeneration: 4,
		}, effects)).toBe('handled');
		(effects.updateDatabases as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			target.beginDatabaseRequest('newer', 4);
		});

		expect(routeSqlSectionMessage({
			type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', requestId: 'first', targetGeneration: 4, databases: ['Db'],
		}, effects)).toBe('handled');
		expect(target.completeDatabaseRequest).toHaveReturnedWith(false);
		expect(target.acceptDatabaseResponse('newer', 4)).toBe(true);
	});

	it('rejects malformed current database data before ledger or UI effects', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		const inheritedDatabases = new Array<string>(1);
		const inheritedDatabasePrototype = Object.create(Array.prototype) as string[];
		inheritedDatabasePrototype[0] = 'InheritedDb';
		Object.setPrototypeOf(inheritedDatabases, inheritedDatabasePrototype);
		target.adoptHostGeneration(4);
		expect(routeSqlSectionMessage({
			type: 'sqlDatabasesLoading', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', requestId: 'current', targetGeneration: 4,
		}, effects)).toBe('handled');

		expect(routeSqlSectionMessage({
			type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', requestId: 'current', targetGeneration: 4,
			databases: ['CurrentDb', 42],
		}, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({
			type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', requestId: 'current', targetGeneration: 4,
			databases: inheritedDatabases,
		}, effects)).toBe('rejected');

		expect(target.acceptDatabaseResponse('current', 4)).toBe(true);
		expect(effects.updateDatabases).not.toHaveBeenCalled();
		expect(effects.reportDatabasesError).not.toHaveBeenCalled();
		expect(target.completeDatabaseRequest).not.toHaveBeenCalled();
	});

	it('rejects malformed current schema data before catalog or schema-info effects', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.adoptHostGeneration(4);

		expect(routeSqlSectionMessage({
			type: 'sqlSchemaData', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', database: 'Db', targetGeneration: 4,
			serverUrl: 'tcp:server.example',
			schema: {
				tables: ['Events', 42],
				columnsByTable: { Events: { Id: 'int' } },
			},
			schemaMeta: { fromCache: false, tablesCount: 2, columnsCount: 1 },
		}, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({
			type: 'sqlSchemaData', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', database: 'Db', targetGeneration: 4,
			serverUrl: 'tcp:server.example', schema: null,
			schemaMeta: {
				error: true, errorMessage: 'failed', fromCache: false,
			},
		}, effects)).toBe('rejected');

		expect(effects.setSchema).not.toHaveBeenCalled();
		const section = effects.getSection('sql-1') as { setSchemaInfo: ReturnType<typeof vi.fn> };
		expect(section.setSchemaInfo).not.toHaveBeenCalled();
	});

	it('preserves the fallback for a valid empty schema error message', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.adoptHostGeneration(4);

		expect(routeSqlSectionMessage({
			type: 'sqlSchemaData', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			sqlConnectionId: 'sql-a', database: 'Db', targetGeneration: 4,
			serverUrl: 'tcp:server.example', schema: null,
			schemaMeta: { error: true, errorMessage: '' },
		}, effects)).toBe('handled');

		const section = effects.getSection('sql-1') as { setSchemaInfo: ReturnType<typeof vi.fn> };
		expect(section.setSchemaInfo).toHaveBeenCalledWith({
			status: 'error',
			statusText: 'Error',
			errorMessage: 'Schema failed',
			cached: false,
			tables: undefined,
			cols: undefined,
			funcs: undefined,
		});
		expect(effects.setSchema).not.toHaveBeenCalled();
	});

	it('rejects owner-sensitive messages after owner rotation', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.setStsReady(true, 'owner-new', 0);
		expect(routeSqlSectionMessage({ type: 'queryResult', boxId: 'sql-1', ownerToken: 'owner-old' }, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({ type: 'queryResult', boxId: 'sql-1', ownerToken: 'owner-new' }, effects)).toBe('not-sql');
	});

	it('routes an execution-only owner without marking STS language ready', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.adoptHostGeneration(3);

		expect(routeSqlSectionMessage({
			type: 'sqlExecutionOwnerState', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			targetGeneration: 3, ownerToken: 'protected-owner',
		}, effects)).toBe('handled');
		const section = effects.getSection('sql-1') as any;
		expect(section.setExecutionOwner).toHaveBeenCalledWith('protected-owner', 3);
		expect(section.setStsReady).not.toHaveBeenCalled();
	});

	it('routes STS responses directly to the addressed section', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		expect(routeSqlSectionMessage({
			type: 'stsResponse', boxId: 'sql-1', sectionInstanceId: target.instanceId, requestId: 'sts-1', result: { items: [] },
			ownerToken: 'owner-a', targetGeneration: 2,
		}, effects)).toBe('handled');
		expect(effects.handleStsResponse).toHaveBeenCalledWith('sql-1', 'sts-1', { items: [] }, 'owner-a', 2);
	});

	it('leaves the exact STS resolver and timer pending after malformed matching ownership', async () => {
		const target = createTarget();
		target.adoptHostGeneration(1);
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		const coordinator = new SqlStsRequestCoordinator();
		const owner = { ownerToken: 'owner-a', targetGeneration: 1 };
		coordinator.setOwner('sql-1', owner);
		let requestId = '';
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const request = coordinator.request('sql-1', 60_000, id => { requestId = id; });
		const timer = setTimeoutSpy.mock.results.at(-1)?.value;
		const settled = vi.fn();
		void request.then(settled);
		(effects.handleStsResponse as ReturnType<typeof vi.fn>).mockImplementation(
			(_boxId: string, responseRequestId: string, result: unknown, ownerToken: string, targetGeneration: number) => {
				const responseOwner = { ownerToken, targetGeneration };
				coordinator.resolve(responseRequestId, result, responseOwner);
			},
		);

		try {
			const malformedRoute = routeSqlSectionMessage({
				type: 'stsResponse', boxId: 'sql-1', sectionInstanceId: target.instanceId,
				requestId, result: { forged: true }, ownerToken: ['owner-a'], targetGeneration: 1,
			}, effects);
			await Promise.resolve();

			expect(malformedRoute).toBe('rejected');
			expect(settled).not.toHaveBeenCalled();
			expect(clearTimeoutSpy).not.toHaveBeenCalled();

			const canonicalResult = { items: [{ label: 'canonical' }] };
			expect(routeSqlSectionMessage({
				type: 'stsResponse', boxId: 'sql-1', sectionInstanceId: target.instanceId,
				requestId, result: canonicalResult, ownerToken: 'owner-a', targetGeneration: 1,
			}, effects)).toBe('handled');
			await expect(request).resolves.toBe(canonicalResult);
			expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
			expect(clearTimeoutSpy).toHaveBeenCalledWith(timer);
		} finally {
			coordinator.clearBox('sql-1');
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
		}
	});

	it('rejects malformed diagnostics and connection state before SQL state effects', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		const section = effects.getSection('sql-1') as {
			setStsReady: ReturnType<typeof vi.fn>;
			notifyStsConnectionError?: ReturnType<typeof vi.fn>;
		};
		section.notifyStsConnectionError = vi.fn();

		for (const malformed of [
			{ type: 'stsDiagnostics', boxId: 'sql-1', sectionInstanceId: target.instanceId, markers: null },
			{ type: 'stsDiagnostics', boxId: 'sql-1', sectionInstanceId: target.instanceId, markers: [42] },
			{
				type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: target.instanceId,
				state: 'ready', ownerToken: ['owner-a'], connectionId: 'sql-a', database: 'Db', targetGeneration: 0,
			},
			{
				type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: target.instanceId,
				state: 'error', error: ['failed'],
			},
		]) {
			expect(routeSqlSectionMessage(malformed as Record<string, unknown>, effects)).toBe('rejected');
		}

		expect(effects.handleStsDiagnostics).not.toHaveBeenCalled();
		expect(section.setStsReady).not.toHaveBeenCalled();
		expect(section.notifyStsConnectionError).not.toHaveBeenCalled();

		expect(routeSqlSectionMessage({
			type: 'stsDiagnostics', boxId: 'sql-1', sectionInstanceId: target.instanceId, markers: [],
		}, effects)).toBe('handled');
		expect(routeSqlSectionMessage({
			type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			state: 'ready', ownerToken: 'owner-a', connectionId: 'sql-a', database: 'Db', targetGeneration: 0,
		}, effects)).toBe('handled');
		expect(routeSqlSectionMessage({
			type: 'stsConnectionState', boxId: 'sql-1', sectionInstanceId: target.instanceId,
			state: 'error', error: '',
		}, effects)).toBe('handled');

		expect(effects.handleStsDiagnostics).toHaveBeenCalledOnce();
		expect(section.setStsReady).toHaveBeenCalledWith(true, 'owner-a', 0);
		expect(section.notifyStsConnectionError).toHaveBeenCalledWith('SQL Tools Service connection failed.');
	});

	it('rejects metadata from a retired section instance', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.adoptHostGeneration(2);

		expect(routeSqlSectionMessage({
			type: 'sqlDatabasesLoading', boxId: 'sql-1', sectionInstanceId: 'retired-instance',
			sqlConnectionId: 'sql-a', requestId: 'stale', targetGeneration: 2,
		}, effects)).toBe('rejected');
		expect(target.beginDatabaseRequest).not.toHaveBeenCalled();
	});

	it('admits a derived SQL comparison only for the source owner and exact execution', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		registerSqlDerivedComparisonSession('query-comparison', 'sql-1');
		const { effects } = createEffects(target);
		const sourceSection = effects.getSection('sql-1');
		(effects.getSection as ReturnType<typeof vi.fn>).mockImplementation((boxId: string) =>
			boxId === 'sql-1' ? sourceSection : boxId === 'query-comparison' ? {} : null);
		target.setStsReady(true, 'owner-current', 0);

		expect(routeSqlSectionMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'query-comparison', ownerToken: 'owner-current',
			executionId: 'comparison-1', executing: true,
		}, effects)).toBe('not-sql');
		expect(routeSqlSectionMessage({
			type: 'queryResult', boxId: 'query-comparison', ownerToken: 'owner-old', executionId: 'comparison-1',
		}, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({
			type: 'queryResult', boxId: 'query-comparison', ownerToken: 'owner-current', executionId: 'comparison-stale',
		}, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({
			type: 'queryResult', boxId: 'query-comparison', ownerToken: 'owner-current', executionId: 'comparison-1',
		}, effects)).toBe('not-sql');
	});

	it('uses the source owner when the derived comparison has its own SQL session', () => {
		const source = createTarget('sql-1');
		const comparison = createTarget('sql-comparison');
		registerSqlSectionSession(source);
		registerSqlSectionSession(comparison);
		registerSqlDerivedComparisonSession('sql-comparison', 'sql-1');
		const { effects } = createEffects(source);
		const sourceSection = effects.getSection('sql-1') as any;
		const comparisonSection = { ...sourceSection, sqlSession: comparison };
		(effects.getSection as ReturnType<typeof vi.fn>).mockImplementation((boxId: string) =>
			boxId === 'sql-1' ? sourceSection : boxId === 'sql-comparison' ? comparisonSection : null);
		source.setStsReady(true, 'source-owner', 0);
		comparison.setStsReady(true, 'comparison-owner', 0);

		expect(routeSqlSectionMessage({
			type: 'copilotWriteQueryExecuting', boxId: 'sql-comparison', ownerToken: 'source-owner',
			executionId: 'comparison-1', executing: true,
		}, effects)).toBe('not-sql');
		expect(routeSqlSectionMessage({
			type: 'queryResult', boxId: 'sql-comparison', ownerToken: 'source-owner', executionId: 'comparison-1',
		}, effects)).toBe('not-sql');
		expect(comparison.admitOwnedMessage).not.toHaveBeenCalled();
	});

	it('admits a direct terminal owned by the derived comparison SQL session', () => {
		const source = createTarget('sql-1');
		const comparison = createTarget('sql-comparison');
		registerSqlSectionSession(source);
		registerSqlSectionSession(comparison);
		registerSqlDerivedComparisonSession('sql-comparison', 'sql-1');
		const { effects } = createEffects(source);
		const sourceSection = effects.getSection('sql-1') as any;
		const comparisonSection = { ...sourceSection, sqlSession: comparison };
		(effects.getSection as ReturnType<typeof vi.fn>).mockImplementation((boxId: string) =>
			boxId === 'sql-1' ? sourceSection : boxId === 'sql-comparison' ? comparisonSection : null);
		source.setStsReady(true, 'source-owner', 0);
		comparison.setStsReady(true, 'comparison-owner', 0);

		expect(routeSqlSectionMessage({
			type: 'queryResult', boxId: 'sql-comparison', ownerToken: 'comparison-owner', executionId: 'direct-1',
		}, effects)).toBe('not-sql');
		expect(comparison.admitOwnedMessage).toHaveBeenCalledWith(expect.objectContaining({
			ownerToken: 'comparison-owner', executionId: 'direct-1',
		}));
	});
});