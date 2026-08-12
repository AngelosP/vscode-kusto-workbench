import { describe, expect, it, vi } from 'vitest';

import { SqlSectionSessionController } from '../../src/webview/sections/sql-section-session.controller.js';

function createController() {
	const host = { addController: vi.fn(), requestUpdate: vi.fn() } as any;
	const controller = new SqlSectionSessionController(host);
	controller.attach('sql-1');
	return { controller, host };
}

function createLifecycleEffects(options?: { restore?: boolean }) {
	return {
		isRestoreInProgress: vi.fn(() => !!options?.restore),
		clearSchema: vi.fn(),
		setSchemaStatus: vi.fn(),
		setDatabases: vi.fn(),
		setDatabasesLoading: vi.fn(),
		setRefreshLoading: vi.fn(),
		getConnectionId: vi.fn(() => 'sql-a'),
		getDatabase: vi.fn(() => 'Db'),
		postMessage: vi.fn(),
		persist: vi.fn(),
	};
}

describe('SqlSectionSessionController', () => {
	it('owns monotonic target generations and exact database requests', () => {
		const { controller } = createController();
		expect(controller.advanceTargetGeneration()).toBe(1);
		expect(controller.beginDatabaseRequest('db-1', 1)).toBe(true);
		expect(controller.acceptDatabaseResponse('stale', 1)).toBe(false);
		expect(controller.acceptDatabaseResponse('db-1', 0)).toBe(false);
		expect(controller.acceptDatabaseResponse('db-1', 1)).toBe(true);
		expect(controller.acceptDatabaseResponse(undefined, 1)).toBe(false);
		expect(controller.completeDatabaseRequest('stale')).toBe(false);
		expect(controller.completeDatabaseRequest('db-1')).toBe(true);
		expect(controller.acceptDatabaseResponse('db-1', 1)).toBe(false);
	});

	it('admits only current owner-tokened execution terminals', () => {
		const { controller } = createController();
		controller.advanceTargetGeneration();
		controller.setStsReady(true, 'owner-a', 1);
		expect(controller.beginExecution('execution-a')).toBe(true);
		expect(controller.admitOwnedMessage({ type: 'queryResult', ownerToken: 'owner-b', executionId: 'execution-a' })).toBe(false);
		expect(controller.admitOwnedMessage({ type: 'queryResult', ownerToken: 'owner-a', executionId: 'execution-a' })).toBe(true);
		controller.rememberCancelledExecution('execution-a');
		expect(controller.admitOwnedMessage({ type: 'queryResult', ownerToken: 'owner-a', executionId: 'execution-a' })).toBe(false);
	});

	it('settles per-section STS requests when ownership changes', async () => {
		const { controller } = createController();
		controller.setStsReady(true, 'owner-a', 0);
		let requestId = '';
		const request = controller.requestSts('hover', 1, 1, 1000, id => { requestId = id; });
		controller.setStsReady(true, 'owner-b', 0);
		await expect(request).resolves.toBeNull();
		expect(controller.resolveStsResponse(requestId, { secret: true }, 'owner-a', 0)).toBe(false);
	});

	it('rejects stale host generations and clears state on detach', () => {
		const { controller } = createController();
		expect(controller.adoptHostGeneration(4)).toBe(true);
		expect(controller.adoptHostGeneration(3)).toBe(false);
		controller.setStsReady(true, 'owner-a', 4);
		controller.detach();
		expect(controller.boxId).toBe('');
	});

	it('settles only the exact tool execution with its captured owner', async () => {
		const { controller } = createController();
		controller.adoptHostGeneration(3);
		controller.setStsReady(true, 'owner-a', 3);
		const run = controller.beginToolRun('tool-a');
		expect(controller.capturePendingToolOwner('sql-a', 'Db')).toBe(true);
		expect(controller.resolvePendingToolRun('tool-b', 99)).toBe(false);
		expect(controller.resolvePendingToolRun('tool-a', 2)).toBe(true);
		await expect(run).resolves.toEqual({
			rowCount: 2,
			executionId: 'tool-a',
			owner: { connectionId: 'sql-a', database: 'Db', ownerToken: 'owner-a', generation: 3 },
		});
	});

	it('rejects a pending tool execution on exact cancellation', async () => {
		const { controller } = createController();
		const run = controller.beginToolRun('tool-a');
		expect(controller.rejectPendingToolRun(new Error('cancelled'), 'tool-b')).toBe(false);
		expect(controller.rejectPendingToolRun(new Error('cancelled'), 'tool-a')).toBe(true);
		await expect(run).rejects.toThrow('cancelled');
	});

	it('clears staged tool ownership when lifecycle invalidation happens before admission', () => {
		const { controller } = createController();
		controller.setToolExpectedOwner({
			connectionId: 'sql-a', database: 'Db', targetSignature: 'target-a',
			principalFingerprint: 'principal-a', revocationGeneration: 0,
		});

		expect(controller.rejectPendingToolRun(new Error('target changed'))).toBe(false);
		expect(controller.toolExpectedOwner).toBeUndefined();
	});

	it('bounds tool readiness with a controller-owned timeout', async () => {
		vi.useFakeTimers();
		try {
			const { controller } = createController();
			const run = controller.beginToolRun('tool-timeout', 25);
			const completion = expect(run).rejects.toThrow('did not become ready');
			await vi.advanceTimersByTimeAsync(25);
			await completion;
			expect(controller.hasPendingToolRun).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('retains a terminal watchdog after tool ownership is captured', async () => {
		vi.useFakeTimers();
		try {
			const { controller } = createController();
			controller.setStsReady(true, 'owner-a', 0);
			const run = controller.beginToolRun('tool-terminal-timeout', 25, 50);
			expect(controller.capturePendingToolOwner('sql-a', 'Db')).toBe(true);
			const completion = expect(run).rejects.toThrow('terminal response');
			await vi.advanceTimersByTimeAsync(25);
			expect(controller.hasPendingToolRun).toBe(true);
			await vi.advanceTimersByTimeAsync(25);
			await completion;
			expect(controller.hasPendingToolRun).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('owns connection and database transition generations and metadata requests', () => {
		const { controller } = createController();
		const effects = createLifecycleEffects();
		controller.configureLifecycleEffects(effects);

		controller.handleConnectionChanged({ connectionId: 'sql-a' });
		expect(controller.targetGeneration).toBe(1);
		expect(effects.postMessage).toHaveBeenNthCalledWith(1, {
			type: 'saveSqlLastSelection', sqlConnectionId: 'sql-a', database: '',
		});
		expect(effects.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'getSqlDatabases', sqlConnectionId: 'sql-a', boxId: 'sql-1',
			sectionInstanceId: controller.instanceId, targetGeneration: 1,
		});

		controller.handleDatabaseChanged({ database: 'Db' });
		expect(controller.targetGeneration).toBe(2);
		expect(effects.postMessage).toHaveBeenLastCalledWith({
			type: 'prefetchSqlSchema', sqlConnectionId: 'sql-a', database: 'Db', boxId: 'sql-1',
			sectionInstanceId: controller.instanceId, targetGeneration: 2,
		});
	});

	it('persists explicit target transitions as authored changes', () => {
		const { controller } = createController();
		const effects = createLifecycleEffects();
		controller.configureLifecycleEffects(effects);

		controller.handleConnectionChanged({ connectionId: 'sql-a', source: 'user' });
		controller.handleDatabaseChanged({ database: 'Db', source: 'user' });

		expect(effects.persist).toHaveBeenNthCalledWith(1, 'sql-target-selection', true);
		expect(effects.persist).toHaveBeenNthCalledWith(2, 'sql-target-selection', true);
	});

	it('adopts a restored database without host metadata requests', () => {
		const { controller } = createController();
		const effects = createLifecycleEffects({ restore: true });
		controller.configureLifecycleEffects(effects);

		controller.handleConnectionChanged({ connectionId: 'sql-a', database: 'RestoredDb' });

		expect(effects.setDatabases).toHaveBeenCalledWith(['RestoredDb'], 'RestoredDb');
		expect(effects.postMessage).not.toHaveBeenCalled();
		expect(effects.persist).not.toHaveBeenCalled();
	});

	it('preserves host generation and suppresses metadata refresh during owner readoption', () => {
		const { controller } = createController();
		const effects = createLifecycleEffects();
		controller.configureLifecycleEffects(effects);
		controller.adoptHostGeneration(7);

		controller.handleConnectionChanged({ connectionId: 'sql-a', preserveTargetGeneration: true, suppressMetadataRefresh: true });
		controller.handleDatabaseChanged({ database: 'Db', preserveTargetGeneration: true, suppressMetadataRefresh: true });

		expect(controller.targetGeneration).toBe(7);
		expect(effects.postMessage).toHaveBeenCalledTimes(1);
		expect(effects.postMessage).toHaveBeenCalledWith({
			type: 'saveSqlLastSelection', sqlConnectionId: 'sql-a', database: '',
		});
	});

	it('uses the current generation for database and schema refreshes', () => {
		const { controller } = createController();
		const effects = createLifecycleEffects();
		controller.configureLifecycleEffects(effects);
		controller.adoptHostGeneration(4);

		controller.handleRefreshDatabases({ connectionId: 'sql-a' });
		controller.handleSchemaRefresh({});

		expect(effects.postMessage).toHaveBeenNthCalledWith(1, {
			type: 'refreshSqlDatabases', sqlConnectionId: 'sql-a', boxId: 'sql-1',
			sectionInstanceId: controller.instanceId, targetGeneration: 4,
		});
		expect(effects.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'prefetchSqlSchema', sqlConnectionId: 'sql-a', database: 'Db', boxId: 'sql-1',
			sectionInstanceId: controller.instanceId, targetGeneration: 4, forceRefresh: true,
		});
	});

	it('retires the host target when the selected database is cleared', () => {
		const { controller } = createController();
		const effects = createLifecycleEffects();
		controller.configureLifecycleEffects(effects);
		controller.adoptHostGeneration(4);

		controller.handleDatabaseChanged({ database: '' });

		expect(controller.targetGeneration).toBe(5);
		expect(effects.postMessage).toHaveBeenNthCalledWith(1, {
			type: 'saveSqlLastSelection', sqlConnectionId: 'sql-a', database: '',
		});
		expect(effects.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'retireSqlTarget', boxId: 'sql-1', sectionInstanceId: controller.instanceId,
			targetGeneration: 5,
		});
	});

	it('retires the host target when the connection is cleared', () => {
		const { controller } = createController();
		const effects = createLifecycleEffects();
		controller.configureLifecycleEffects(effects);
		controller.adoptHostGeneration(6);

		controller.handleConnectionChanged({ connectionId: '' });

		expect(controller.targetGeneration).toBe(7);
		expect(effects.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'retireSqlTarget', boxId: 'sql-1', sectionInstanceId: controller.instanceId,
			targetGeneration: 7,
		});
	});
});