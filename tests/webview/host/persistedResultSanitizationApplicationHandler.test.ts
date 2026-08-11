import { describe, expect, it, vi } from 'vitest';

import {
	HostPersistedResultSanitizationApplicationHandler,
	type PersistedResultSanitizationApplicationHandlerOptions,
} from '../../../src/host/persistedResultSanitizationApplicationHandler';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../../../src/shared/sqlConnectionIdentity';

const kustoConnection = {
	id: 'kusto-1',
	name: 'Kusto',
	clusterUrl: 'https://cluster.kusto.windows.net',
};

const sqlConnection = {
	id: 'sql-1',
	name: 'SQL',
	dialect: 'mssql',
	serverUrl: 'server.example',
	authType: 'aad' as const,
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function createHandler() {
	const order: string[] = [];
	const kustoSnapshot = {
		clusterKeys: [] as string[],
		globallyBlocked: false,
		version: 1,
		revocationGenerations: {} as Record<string, number>,
	};
	const sqlSnapshot = {
		policy: {
			connectionIds: [] as string[],
			version: 1,
			globallyBlocked: false,
			revocationGenerations: {} as Record<string, number>,
		},
		connections: [sqlConnection],
		connectionVersion: 1,
		accountsByServer: { 'server.example': 'account-a' },
		principalVersion: 1,
	};
	const getKustoConnections = vi.fn(() => [kustoConnection]);
	const runWithLeaveNoTraceSnapshotLock = vi.fn(async (dispatch: (snapshot: typeof kustoSnapshot) => unknown) => {
		order.push('kusto-enter');
		try {
			return await dispatch(kustoSnapshot);
		} finally {
			order.push('kusto-exit');
		}
	});
	const getAccountPartition = vi.fn(() => 'partition-a');
	const getSqlConnection = vi.fn((connectionId: string) =>
		connectionId === sqlConnection.id ? sqlConnection : undefined);
	const getSqlConnections = vi.fn(() => [sqlConnection]);
	const reconcileComparisonOwners = vi.fn();
	const getComparisonOwner = vi.fn(() => undefined);
	const getConnectionId = vi.fn(() => undefined);
	const isLeaveNoTraceConnection = vi.fn(() => false);
	const tryDispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: typeof sqlSnapshot) => unknown) => ({
		acquired: true as const,
		value: await dispatch(sqlSnapshot),
	}));
	const tryRunWithSqlOwnerSnapshotLock = vi.fn(async (dispatch: (snapshot: typeof sqlSnapshot) => unknown) => {
		order.push('sql-enter');
		try {
			return { acquired: true as const, value: await dispatch(sqlSnapshot) };
		} finally {
			order.push('sql-exit');
		}
	});
	const retrySqlOwnerSnapshotAcquisition = vi.fn(async (
		acquire: () => Promise<{ acquired: boolean; value?: unknown }>,
	) => {
		order.push('retry');
		for (;;) {
			const result = await acquire();
			if (result.acquired) return result.value;
		}
	});
	const options = {
		connectionManager: {
			getConnections: getKustoConnections,
			runWithLeaveNoTraceSnapshotLock,
		},
		kustoClient: { getAccountPartition },
		sqlConnectionManager: {
			getConnection: getSqlConnection,
			getConnections: getSqlConnections,
		},
		sqlLifecycle: {
			reconcileComparisonOwners,
			getComparisonOwner,
			getConnectionId,
		},
		sqlWorkbench: {
			isLeaveNoTraceConnection,
			retrySqlOwnerSnapshotAcquisition,
			tryDispatchSqlOwnerSnapshot,
			tryRunWithSqlOwnerSnapshotLock,
		},
	} as unknown as PersistedResultSanitizationApplicationHandlerOptions;
	return {
		handler: new HostPersistedResultSanitizationApplicationHandler(options),
		order,
		kustoSnapshot,
		sqlSnapshot,
		getKustoConnections,
		runWithLeaveNoTraceSnapshotLock,
		getAccountPartition,
		getSqlConnection,
		getSqlConnections,
		reconcileComparisonOwners,
		isLeaveNoTraceConnection,
		retrySqlOwnerSnapshotAcquisition,
		tryDispatchSqlOwnerSnapshot,
		tryRunWithSqlOwnerSnapshotLock,
	};
}

function admittedState() {
	const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(sqlConnection, 'account-a');
	return {
		futureState: { keep: true },
		sections: [
			{
				id: 'query-1', type: 'query', clusterUrl: kustoConnection.clusterUrl,
				connectionIdHint: kustoConnection.id, database: 'Db', resultJson: '{"kusto":true}',
				resultArtifact: { version: 1, artifactId: 'kusto-result' },
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			},
			{
				id: 'sql-1', type: 'sql', connectionIdHint: sqlConnection.id,
				targetSignature: sqlConnectionTargetSignature(sqlConnection),
				principalFingerprint, revocationGeneration: 0, resultJson: '{"sql":true}',
				resultArtifact: { version: 1, artifactId: 'sql-result' },
			},
			{ id: 'future-1', type: 'future', result: { opaque: true } },
		],
	};
}

describe('HostPersistedResultSanitizationApplicationHandler', () => {
	it('preserves exact admitted Kusto and SQL owners through fresh sanitation', async () => {
		const { handler, reconcileComparisonOwners, tryDispatchSqlOwnerSnapshot } = createHandler();
		const state = admittedState();

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(reconcileComparisonOwners).toHaveBeenCalledWith(state.sections);
		expect(tryDispatchSqlOwnerSnapshot).toHaveBeenCalledOnce();
	});

	it('fails closed for both engines while retaining opaque future data', () => {
		const { handler } = createHandler();
		const state = admittedState();

		const sanitized = handler.sanitizeSqlLeaveNoTraceStateFailClosed(state);

		expect(sanitized).not.toBe(state);
		expect(sanitized.futureState).toBe(state.futureState);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('resultArtifact');
		expect(sanitized.sections[0]).not.toHaveProperty('kustoAccountPartition');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).not.toHaveProperty('resultArtifact');
		expect(sanitized.sections[1]).not.toHaveProperty('principalFingerprint');
		expect(sanitized.sections[2]).toHaveProperty('result', { opaque: true });
	});

	it('uses the same fail-closed result when fresh owner acquisition fails', async () => {
		const { handler, retrySqlOwnerSnapshotAcquisition } = createHandler();
		const state = admittedState();
		retrySqlOwnerSnapshotAcquisition.mockRejectedValueOnce(new Error('policy unavailable'));

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[2]).toHaveProperty('result', { opaque: true });
	});

	it('holds Kusto then SQL owner locks through exact publication settlement', async () => {
		const { handler, order } = createHandler();
		const state = admittedState();
		const release = deferred<void>();
		const publish = vi.fn(async (sanitizedState: typeof state) => {
			order.push('publish');
			expect(sanitizedState).toBe(state);
			await release.promise;
			expect(order).toEqual(['retry', 'kusto-enter', 'sql-enter', 'publish']);
			return 'published';
		});

		const publication = handler.publishSqlLeaveNoTraceStateFresh(state, publish);
		await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
		expect(order).toEqual(['retry', 'kusto-enter', 'sql-enter', 'publish']);
		release.resolve();

		await expect(publication).resolves.toBe('published');
		expect(order).toEqual([
			'retry', 'kusto-enter', 'sql-enter', 'publish', 'sql-exit', 'kusto-exit',
		]);
	});

	it('owns invalidation events and disposal without disabling close sanitation', async () => {
		const { handler, reconcileComparisonOwners } = createHandler();
		const sqlInvalidated = vi.fn();
		const kustoInvalidated = vi.fn();
		handler.onDidInvalidateSqlPersistence(sqlInvalidated);
		handler.onDidInvalidateKustoPersistence(kustoInvalidated);

		handler.invalidateSqlPersistence();
		handler.invalidateKustoPersistence();
		expect(sqlInvalidated).toHaveBeenCalledOnce();
		expect(kustoInvalidated).toHaveBeenCalledOnce();

		handler.dispose();
		handler.dispose();
		handler.invalidateSqlPersistence();
		handler.invalidateKustoPersistence();
		expect(sqlInvalidated).toHaveBeenCalledOnce();
		expect(kustoInvalidated).toHaveBeenCalledOnce();

		const state = { sections: [] };
		expect(handler.sanitizeSqlLeaveNoTraceState(state)).toBe(state);
		await expect(handler.sanitizeSqlLeaveNoTraceStateFresh(state)).resolves.toBe(state);
		expect(handler.sanitizeSqlLeaveNoTraceStateFailClosed(state)).toBe(state);
		await expect(handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate))
			.resolves.toBe(state);
		expect(reconcileComparisonOwners).toHaveBeenCalledWith(state.sections);
	});
});
