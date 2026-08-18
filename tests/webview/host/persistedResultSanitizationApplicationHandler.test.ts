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

function legacyResultJson(cluster = 'cluster', database = 'Db'): string {
	return JSON.stringify({
		columns: [{ name: 'Value', type: 'long' }],
		rows: [[42]],
		metadata: { cluster, database },
	});
}

function legacyKustoState(section: Record<string, unknown> = {}) {
	return {
		sections: [{
			id: 'legacy-query',
			type: 'query',
			clusterUrl: kustoConnection.clusterUrl,
			connectionIdHint: kustoConnection.id,
			database: 'Db',
			resultJson: legacyResultJson(),
			...section,
		}],
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

	it('adopts an eligible legacy Kusto result without changing its serialized payload', async () => {
		const { handler } = createHandler();
		const resultJson = ` {
			"columns": [{ "name": "Value", "type": "long" }],
			"rows": [[42]],
			"metadata": {
				"cluster": "cluster",
				"database": "db"
			}
		} `;
		const state = {
			sections: [{
				id: 'legacy-query',
				type: 'query',
				clusterUrl: kustoConnection.clusterUrl,
				connectionIdHint: kustoConnection.id,
				database: 'Db',
				resultJson,
			}],
		};

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).not.toBe(state);
		expect(sanitized.sections[0]).toMatchObject({
			resultJson,
			kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		});
		expect(state.sections[0]).not.toHaveProperty('kustoAccountPartition');
		expect(state.sections[0]).not.toHaveProperty('kustoLeaveNoTraceRevision');
	});

	it('drops a preexisting legacy artifact descriptor during adoption', async () => {
		const { handler } = createHandler();
		const state = legacyKustoState({
			resultArtifact: {
				version: 1, artifactId: 'result:legacy-query:9', sourceBoxId: 'legacy-query',
				revision: 9, createdAt: 1,
				policy: {
					exposeToActiveContent: true, sendToModel: true,
					shareToClipboard: true, exportToCsv: true,
				},
			},
		});

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
		expect(sanitized.sections[0]).not.toHaveProperty('resultArtifact');
		expect(sanitized.sections[0]).toMatchObject({
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		});
	});

	it('is byte-stable and reference-stable on the second migration pass', async () => {
		const { handler } = createHandler();
		const first = await handler.sanitizeSqlLeaveNoTraceStateFresh(legacyKustoState());
		const firstBytes = JSON.stringify(first);

		const second = await handler.sanitizeSqlLeaveNoTraceStateFresh(first);

		expect(second).toBe(first);
		expect(JSON.stringify(second)).toBe(firstBytes);
	});

	it.each([
		['connection', (harness: ReturnType<typeof createHandler>) => harness.getKustoConnections.mockReturnValue([])],
		['account', (harness: ReturnType<typeof createHandler>) => harness.getAccountPartition.mockReturnValue('')],
	])('defers an unresolved %s without modifying the legacy source', async (_kind, arrange) => {
		const harness = createHandler();
		arrange(harness);
		const state = legacyKustoState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
		expect(sanitized.sections[0]).not.toHaveProperty('kustoAccountPartition');
		expect(sanitized.sections[0]).not.toHaveProperty('kustoLeaveNoTraceRevision');
	});

	it('defers ambiguous Kusto ownership without modifying the legacy source', async () => {
		const harness = createHandler();
		harness.getKustoConnections.mockReturnValue([
			{ ...kustoConnection, id: 'kusto-a', authorityId: 'common' },
			{ ...kustoConnection, id: 'kusto-b', authorityId: 'organizations' },
		]);
		const state = legacyKustoState({ connectionIdHint: undefined });

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
	});

	it.each([
		['cluster', legacyResultJson('other', 'Db')],
		['database', legacyResultJson('cluster', 'OtherDb')],
		['malformed JSON', '{"rows":'],
		['non-string target', JSON.stringify({
			columns: [{ name: 'Value', type: 'long' }], rows: [[42]],
			metadata: { cluster: ['cluster'], database: ['Db'] },
		})],
	])('does not adopt or erase a legacy result with invalid %s metadata', async (_kind, resultJson) => {
		const { handler } = createHandler();
		const state = legacyKustoState({ resultJson });

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', resultJson);
	});

	it.each([
		['account marker only', { kustoAccountPartition: 'partition-a' }],
		['revision marker only', { kustoLeaveNoTraceRevision: 0 }],
	])('treats %s as malformed modern state instead of legacy', async (_kind, marker) => {
		const { handler } = createHandler();
		const state = legacyKustoState(marker);

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('kustoAccountPartition');
		expect(sanitized.sections[0]).not.toHaveProperty('kustoLeaveNoTraceRevision');
	});

	it.each(['global', 'cluster'])('blocks legacy adoption under %s Leave No Trace without erasing the source', async kind => {
		const harness = createHandler();
		if (kind === 'global') harness.kustoSnapshot.globallyBlocked = true;
		else harness.kustoSnapshot.clusterKeys = ['cluster'];
		const state = legacyKustoState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
	});

	it('does not bypass a nonzero Kusto revocation generation', async () => {
		const harness = createHandler();
		harness.kustoSnapshot.revocationGenerations.cluster = 1;
		const state = legacyKustoState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
	});

	it('adopts canonical legacy aliases and the effective Kusto comparison owner', async () => {
		const { handler } = createHandler();
		const state = {
			sections: [
				{
					id: 'legacy-source', type: 'copilotQuery', clusterUrl: kustoConnection.clusterUrl,
					connectionIdHint: kustoConnection.id, database: 'Db', query: 'T',
					resultJson: legacyResultJson(),
				},
				{
					id: 'legacy-comparison', type: 'query', comparisonSourceBoxId: 'legacy-source',
					query: 'T | count', resultJson: legacyResultJson(),
				},
			],
		};

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).toMatchObject({
			resultJson: state.sections[0].resultJson,
			kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		});
		expect(sanitized.sections[1]).toMatchObject({
			resultJson: state.sections[1].resultJson,
			kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		});
	});

	it('keeps a markerless comparison inert when its query source has no cached result', async () => {
		const { handler } = createHandler();
		const resultJson = legacyResultJson();
		const state = {
			sections: [
				{
					id: 'legacy-source', type: 'query', clusterUrl: kustoConnection.clusterUrl,
					connectionIdHint: kustoConnection.id, database: 'Db', query: 'T',
				},
				{
					id: 'legacy-comparison', type: 'query', comparisonSourceBoxId: 'legacy-source',
					query: 'T | count', resultJson,
				},
			],
		};

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[1]).toHaveProperty('resultJson', resultJson);
		expect(sanitized.sections[1]).not.toHaveProperty('kustoAccountPartition');
	});

	it('keeps existing modern Kusto provenance mismatch fail-closed', async () => {
		const { handler } = createHandler();
		const state = legacyKustoState({
			kustoAccountPartition: 'partition-old',
			kustoLeaveNoTraceRevision: 0,
			resultArtifact: { version: 1, artifactId: 'forged' },
		});

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('resultArtifact');
		expect(sanitized.sections[0]).not.toHaveProperty('kustoAccountPartition');
		expect(sanitized.sections[0]).not.toHaveProperty('kustoLeaveNoTraceRevision');
	});

	it('keeps an orphaned missing-marker query comparison inert for later owner resolution', async () => {
		const { handler } = createHandler();
		const state = legacyKustoState({
			comparisonSourceBoxId: 'missing-source',
			clusterUrl: undefined,
			connectionIdHint: undefined,
			database: undefined,
		});

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
	});

	it('keeps a markerless comparison with a non-query source inert', async () => {
		const { handler } = createHandler();
		const resultJson = legacyResultJson();
		const state = {
			sections: [
				{
					id: 'not-a-query', type: 'markdown', text: 'notes',
					clusterUrl: kustoConnection.clusterUrl, connectionIdHint: kustoConnection.id, database: 'Db',
				},
				{
					id: 'legacy-comparison', type: 'query', comparisonSourceBoxId: 'not-a-query',
					query: 'T | count', resultJson,
				},
			],
		};

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[1]).toHaveProperty('resultJson', resultJson);
		expect(sanitized.sections[1]).not.toHaveProperty('kustoAccountPartition');
		expect(sanitized.sections[1]).not.toHaveProperty('kustoLeaveNoTraceRevision');
	});

	it('keeps a missing-source markerless comparison inert when fresh owner acquisition fails', async () => {
		const harness = createHandler();
		harness.retrySqlOwnerSnapshotAcquisition.mockRejectedValueOnce(new Error('owner snapshot unavailable'));
		const state = legacyKustoState({
			comparisonSourceBoxId: 'missing-source',
			clusterUrl: kustoConnection.clusterUrl,
			connectionIdHint: kustoConnection.id,
			database: 'Db',
		});

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
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
