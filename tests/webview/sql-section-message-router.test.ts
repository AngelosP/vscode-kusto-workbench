import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearSqlSectionSessionsForTest,
	registerSqlDerivedComparisonSession,
	registerSqlSectionSession,
	routeSqlSectionMessage,
	type SqlSectionMessageRouterEffects,
	type SqlSectionSessionTarget,
} from '../../src/webview/core/sql-section-message-router.js';

function createTarget(): SqlSectionSessionTarget {
	let generation = 0;
	let ownerToken = '';
	let requestId = '';
	return {
		boxId: 'sql-1',
		instanceId: 'instance-sql-1',
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
			if (nextGeneration !== generation) return false;
			requestId = nextRequestId;
			return true;
		}),
		acceptDatabaseResponse: vi.fn((candidate: string | undefined, nextGeneration: number) =>
			nextGeneration === generation && (!candidate || candidate === requestId)),
		completeDatabaseRequest: vi.fn(() => { requestId = ''; }),
		setStsReady: vi.fn((ready: boolean, token = '') => { ownerToken = ready ? token : ''; return true; }),
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
		expect(routeSqlSectionMessage({ type: 'sqlDatabasesLoading', boxId: 'sql-1', sectionInstanceId: target.instanceId, requestId: 'current', targetGeneration: 4 }, effects)).toBe('handled');
		expect(routeSqlSectionMessage({ type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId, requestId: 'stale', targetGeneration: 4 }, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({ type: 'sqlDatabasesData', boxId: 'sql-1', sectionInstanceId: target.instanceId, requestId: 'current', targetGeneration: 4 }, effects)).toBe('handled');
		expect(effects.updateDatabases).toHaveBeenCalledOnce();
	});

	it('rejects owner-sensitive messages after owner rotation', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.setStsReady(true, 'owner-new', 0);
		expect(routeSqlSectionMessage({ type: 'queryResult', boxId: 'sql-1', ownerToken: 'owner-old' }, effects)).toBe('rejected');
		expect(routeSqlSectionMessage({ type: 'queryResult', boxId: 'sql-1', ownerToken: 'owner-new' }, effects)).toBe('not-sql');
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

	it('rejects metadata from a retired section instance', () => {
		const target = createTarget();
		registerSqlSectionSession(target);
		const { effects } = createEffects(target);
		target.adoptHostGeneration(2);

		expect(routeSqlSectionMessage({
			type: 'sqlDatabasesLoading', boxId: 'sql-1', sectionInstanceId: 'retired-instance',
			requestId: 'stale', targetGeneration: 2,
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
});