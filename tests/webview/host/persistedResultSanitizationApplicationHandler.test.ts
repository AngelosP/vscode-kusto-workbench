import { describe, expect, it, vi } from 'vitest';

import {
	HostPersistedResultSanitizationApplicationHandler,
	type PersistedResultSanitizationApplicationHandlerOptions,
} from '../../../src/host/persistedResultSanitizationApplicationHandler';
import { kustoLeaveNoTracePolicyFingerprint } from '../../../src/host/kustoLeaveNoTracePolicyStore';
import type { KqlxStateV1 } from '../../../src/host/kqlxFormat';
import { preserveKqlxResultAttachments } from '../../../src/host/kqlxOverlay';
import { getKustoConnectionIdentityKey } from '../../../src/shared/kustoAuth';
import type { KustoExecutionSuccessStamp } from '../../../src/shared/kustoExecution';
import {
	createPrimaryResultArtifactIdentity,
	type PersistedResultArtifactV1,
	type ResultArtifactProducer,
} from '../../../src/shared/resultArtifact';
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
	const sqlConnections = [sqlConnection];
	const sqlSnapshot = {
		policy: {
			connectionIds: [] as string[],
			version: 1,
			globallyBlocked: false,
			revocationGenerations: {} as Record<string, number>,
		},
		connections: sqlConnections,
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
		sqlConnections.find(connection => connection.id === connectionId));
	const getSqlConnections = vi.fn(() => [...sqlConnections]);
	const reconcileComparisonOwners = vi.fn();
	const getComparisonOwner = vi.fn(() => undefined);
	const getConnectionId = vi.fn(() => undefined);
	const isLeaveNoTraceConnection = vi.fn(() => false);
	const tryDispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: typeof sqlSnapshot) => unknown) => ({
		acquired: true as const,
		value: await dispatch(sqlSnapshot),
	}));
	const tryRunWithSqlOwnerSnapshotLock = vi.fn(async (
		dispatch: (snapshot: typeof sqlSnapshot) => unknown,
	): Promise<{ acquired: true; value: unknown } | { acquired: false }> => {
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
		sqlConnections,
		getKustoConnections,
		runWithLeaveNoTraceSnapshotLock,
		getAccountPartition,
		getSqlConnection,
		getSqlConnections,
		reconcileComparisonOwners,
		getComparisonOwner,
		getConnectionId,
		isLeaveNoTraceConnection,
		retrySqlOwnerSnapshotAcquisition,
		tryDispatchSqlOwnerSnapshot,
		tryRunWithSqlOwnerSnapshotLock,
	};
}

function admittedState() {
	const principalFingerprint = 'principal-a';
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
			{
				id: 'future-1', type: 'future', result: { opaque: true }, resultJson: undefined,
				resultArtifact: { futureDescriptor: true }, selectedResultIndex: null,
				principalFingerprint: undefined, revocationGeneration: 'future',
			},
		],
	};
}

function freezeState<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezeState(child);
		Object.freeze(value);
	}
	return value;
}

function existingState() {
	const state = admittedState();
	const sections: Record<string, unknown>[] = [
		...state.sections,
		{
			...state.sections[0], id: 'kusto-comparison', comparisonSourceBoxId: 'query-1',
			selectedResultIndex: 2, resultArtifact: { provenance: { opaque: ['kusto'] } },
		},
		{
			...state.sections[1], id: 'sql-comparison', type: 'query', comparisonSourceBoxId: 'sql-1',
			selectedResultIndex: 0, resultArtifact: { provenance: { opaque: ['sql'] } },
		},
		{
			...legacyKustoState().sections[0], result: { rows: [['legacy']] },
			resultArtifact: { policy: { exposeToActiveContent: true }, future: undefined },
		},
		{
			id: 'legacy-sql', type: 'sql', result: { rows: [['legacy sql']] },
			resultJson: undefined, principalFingerprint: null, revocationGeneration: 'invalid',
			resultArtifact: { policy: { sendToModel: true } }, selectedResultIndex: null,
		},
		{
			id: 'partial-markers', type: 'query', resultJson: '{malformed',
			kustoAccountPartition: undefined, selectedResultIndex: -1,
			futureMetadata: { malformed: [null, {}, ''], retained: undefined },
		},
	];
	return freezeState({ ...state, sections });
}

function newCandidateState() {
	const state = admittedState();
	const ordinarySql = { ...sqlConnection, id: 'sql-ordinary', database: 'OrdinaryDb' };
	const sections: Record<string, unknown>[] = [
		...state.sections,
		{
			...state.sections[0], id: 'kusto-ordinary', clusterUrl: 'ordinary.kusto.windows.net',
			connectionIdHint: 'missing-ordinary-kusto', kustoAccountPartition: undefined,
		},
		{
			...state.sections[1], id: ordinarySql.id, connectionIdHint: ordinarySql.id,
			targetSignature: sqlConnectionTargetSignature(ordinarySql), serverUrl: ordinarySql.serverUrl,
			principalFingerprint: undefined, revocationGeneration: -1,
		},
		{
			...state.sections[0], id: 'kusto-comparison', comparisonSourceBoxId: 'query-1',
			clusterUrl: 'stale-target.kusto.windows.net', selectedResultIndex: 1,
		},
		{
			...state.sections[1], id: 'sql-comparison', type: 'query', comparisonSourceBoxId: 'sql-1',
			connectionIdHint: 'stale-sql-target', selectedResultIndex: 0,
		},
		{
			id: 'nested-sql-comparison', type: 'query', comparisonSourceBoxId: 'sql-comparison',
			resultJson: '{"nested":true}', resultArtifact: { future: true }, selectedResultIndex: 0,
		},
	];
	return { ...state, sections };
}

function expectNoAuthorizationReads(harness: ReturnType<typeof createHandler>) {
	expect(harness.getAccountPartition).not.toHaveBeenCalled();
	expect(harness.getSqlConnection).not.toHaveBeenCalled();
	expect(harness.getSqlConnections).not.toHaveBeenCalled();
	expect(harness.getComparisonOwner).not.toHaveBeenCalled();
	expect(harness.getConnectionId).not.toHaveBeenCalled();
	expect(harness.isLeaveNoTraceConnection).not.toHaveBeenCalled();
	expect(harness.tryDispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
}

function legacyResultJson(cluster = 'cluster', database = 'Db'): string {
	return JSON.stringify({
		columns: [{ name: 'Value', type: 'long' }],
		rows: [[42]],
		metadata: { cluster, database },
	});
}

function legacyKustoState(section: Record<string, unknown> = {}): { sections: Record<string, unknown>[] } {
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

function kustoResultProducer(connection = kustoConnection, boxId = 'query-1'): KustoExecutionSuccessStamp {
	return {
		engine: 'kusto', boxId, executionId: 'run-b', sectionInstanceId: 'instance-1',
		targetGeneration: 1, reservationSequence: 2, connectionId: connection.id,
		database: 'DispatchDb', query: 'print Value=2', producer: 'manual',
		dispatch: {
			dispatchAttempt: 1, connectionRevision: 1, leaveNoTraceRevision: 0,
			connectionIdentityKey: getKustoConnectionIdentityKey(connection.clusterUrl),
			clusterEndpoint: connection.clusterUrl, accountPartition: 'dispatch-principal',
			authSessionGeneration: 1, clientActivityId: 'activity-b',
		},
	};
}

function sqlResultProducer(connection = sqlConnection, boxId = 'sql-1'): ResultArtifactProducer {
	return {
		engine: 'sql', boxId, executionId: 'run-b', connectionId: connection.id,
		database: 'DispatchDb', query: 'SELECT 2 AS Value', producer: 'manual',
	};
}

function resultArtifact(producer: ResultArtifactProducer, revision = 2): PersistedResultArtifactV1 {
	return { version: 1, ...createPrimaryResultArtifactIdentity(producer.boxId, revision, 1)!, producer };
}

describe('HostPersistedResultSanitizationApplicationHandler', () => {
	it('bypasses policy snapshot locks when state has no persisted results', async () => {
		const harness = createHandler();
		const state = {
			sections: [
				{ id: 'query-1', type: 'query', query: 'print Value=1' },
				{ id: 'markdown-1', type: 'markdown', text: 'notes' },
			],
		};

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledWith(state.sections);
		expect(harness.runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(harness.retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
		expect(harness.tryDispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
	});

	it.each([
		['empty', ''],
		['undefined', undefined],
	] as const)('preserves an own %s resultJson field without policy locking', async (_label, resultJson) => {
		const harness = createHandler();
		const state = {
			sections: [{ id: 'query-1', type: 'query', query: 'print Value=1', resultJson }],
		};

		expect(await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state)).toBe(state);

		expect(Object.hasOwn(state.sections[0], 'resultJson')).toBe(true);
		expect(harness.runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(harness.retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
	});

	it('retains policy locking when a Kusto sanitation observer is requested', async () => {
		const harness = createHandler();
		const state = { sections: [{ id: 'query-1', type: 'query', query: 'print Value=1' }] };
		const observer = vi.fn();

		await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state, observer);

		expect(harness.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce();
		expect(harness.retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
		expect(observer).toHaveBeenCalledOnce();
		expect(observer).toHaveBeenCalledWith(state, state, { snapshot: harness.kustoSnapshot });
	});

	it('preserves exact admitted Kusto and SQL owners through fresh sanitation', async () => {
		const { handler, reconcileComparisonOwners, tryDispatchSqlOwnerSnapshot } = createHandler();
		const state = admittedState();

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(reconcileComparisonOwners).toHaveBeenCalledWith(state.sections);
		expect(tryDispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
	});

	it.each([
		'unavailable', 'different-account', 'removed-connection', 'ambiguous-connections', 'changed-targets', 'revoked',
	] as const)(
		'preserves existing file results when authentication is %s', async authentication => {
			const harness = createHandler();
			const state = existingState();
			const original = JSON.stringify(state);
			if (authentication === 'removed-connection') {
				harness.getKustoConnections.mockReturnValue([]);
				harness.sqlConnections.splice(0);
			} else if (authentication === 'ambiguous-connections') {
				harness.getKustoConnections.mockReturnValue([
					{ ...kustoConnection, id: 'kusto-a' }, { ...kustoConnection, id: 'kusto-b' },
				]);
				harness.sqlConnections.splice(0, 1,
					{ ...sqlConnection, id: 'sql-a' }, { ...sqlConnection, id: 'sql-b' });
			} else if (authentication === 'changed-targets') {
				harness.getKustoConnections.mockReturnValue([{ ...kustoConnection, clusterUrl: 'different' }]);
				harness.sqlConnections.splice(0, 1, { ...sqlConnection, serverUrl: 'different' });
			} else if (authentication === 'revoked') {
				harness.kustoSnapshot.revocationGenerations.cluster = 42;
				harness.sqlSnapshot.policy.revocationGenerations[sqlConnection.id] = 42;
			} else {
				harness.getAccountPartition.mockReturnValue(authentication === 'unavailable' ? '' : 'partition-b');
				harness.sqlSnapshot.accountsByServer['server.example'] = authentication === 'unavailable' ? '' : 'account-b';
			}

			const restored = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

			expect(restored).toBe(state);
			expect(harness.handler.sanitizeSqlLeaveNoTraceState(state)).toBe(state);
			expect(harness.handler.sanitizeSqlLeaveNoTraceStateFailClosed(state)).toBe(state);
			expect(JSON.stringify(state)).toBe(original);
			expect(restored.sections[0].resultJson).toBe('{"kusto":true}');
			expect(restored.sections[1].resultJson).toBe('{"sql":true}');
			expectNoAuthorizationReads(harness);
			expect(harness.getKustoConnections).not.toHaveBeenCalled();
		},
	);

	it('preserves SQL results through a uniquely recreated connection identity', async () => {
		const harness = createHandler();
		const recreated = { ...sqlConnection, id: 'sql-recreated' };
		harness.sqlConnections.splice(0, harness.sqlConnections.length, recreated);
		const state = admittedState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[1]).toHaveProperty('resultJson', '{"sql":true}');
	});

	it.each(['sync', 'fresh', 'fail-closed'] as const)(
		'preserves existing file results under Leave No Trace during %s loading', async mode => {
			const harness = createHandler();
			const state = existingState();
			harness.kustoSnapshot.globallyBlocked = true;
			harness.sqlSnapshot.policy.globallyBlocked = true;
			harness.isLeaveNoTraceConnection.mockReturnValue(true);
			const original = JSON.stringify(state);

			const restored = mode === 'fresh'
				? await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state)
				: mode === 'fail-closed'
					? harness.handler.sanitizeSqlLeaveNoTraceStateFailClosed(state)
					: harness.handler.sanitizeSqlLeaveNoTraceState(state);

			expect(JSON.stringify(restored)).toBe(original);
			expect(JSON.stringify(state)).toBe(original);
			expect(restored).toBe(state);
			expectNoAuthorizationReads(harness);
		},
	);

	it('preserves existing file results if policy acquisition fails', async () => {
		const harness = createHandler();
		const state = existingState();
		harness.runWithLeaveNoTraceSnapshotLock.mockRejectedValue(new Error('temporarily unavailable'));
		const observer = vi.fn();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state, observer);

		expect(sanitized).toBe(state);
		expect(observer).not.toHaveBeenCalled();
		expect(harness.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce();
		expect(harness.retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
	});

	it('preserves existing file results when comparison reconciliation fails', async () => {
		const harness = createHandler();
		const state = existingState();
		harness.reconcileComparisonOwners.mockImplementation(() => { throw new Error('lifecycle unavailable'); });
		const observer = vi.fn();

		expect(harness.handler.sanitizeSqlLeaveNoTraceState(state)).toBe(state);
		expect(harness.handler.sanitizeSqlLeaveNoTraceStateFailClosed(state)).toBe(state);
		await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state, observer)).resolves.toBe(state);
		expect(observer).toHaveBeenCalledWith(state, state, { snapshot: harness.kustoSnapshot });
		expectNoAuthorizationReads(harness);
	});

	it('preserves malformed containers and opaque own result metadata on every read path', async () => {
		const harness = createHandler();
		const opaque = Object.defineProperties({ type: 'future' }, {
			resultJson: { value: undefined, enumerable: true },
			resultArtifact: { value: { opaque: true }, enumerable: false },
		});
		freezeState(opaque);
		const descriptors = Object.getOwnPropertyDescriptors(opaque);
		for (const state of [
			{}, { sections: undefined }, { sections: null }, { sections: { unknown: true } },
			{ sections: [null, 0, 'opaque', [], opaque, { type: 'query', resultJson: null }] },
		]) {
			const saved = freezeState(state) as { sections?: unknown[] };
			expect(harness.handler.sanitizeSqlLeaveNoTraceState(saved)).toBe(saved);
			expect(harness.handler.sanitizeSqlLeaveNoTraceStateFailClosed(saved)).toBe(saved);
			await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(saved)).resolves.toBe(saved);
		}
		expect(Object.getOwnPropertyDescriptors(opaque)).toEqual(descriptors);
		expectNoAuthorizationReads(harness);
	});

	it('preserves SQL results when a recreated target identity is ambiguous', async () => {
		const harness = createHandler();
		harness.sqlConnections.splice(
			0,
			harness.sqlConnections.length,
			{ ...sqlConnection, id: 'sql-recreated-a' },
			{ ...sqlConnection, id: 'sql-recreated-b' },
		);
		const state = admittedState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
	});

	it('preserves SQL results when the uniquely recreated connection is Leave No Trace', async () => {
		const harness = createHandler();
		const recreated = { ...sqlConnection, id: 'sql-recreated-protected' };
		harness.sqlConnections.splice(0, harness.sqlConnections.length, recreated);
		harness.isLeaveNoTraceConnection.mockImplementation(connectionId => connectionId === recreated.id);
		const state = admittedState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
	});

	it('observes unchanged saved state inside the actual Kusto policy lock without SQL acquisition', async () => {
		const harness = createHandler();
		const state = admittedState();
		harness.kustoSnapshot.globallyBlocked = true;
		const observer = vi.fn((before, after, context) => {
			harness.order.push('kusto-observer');
			expect(before).toBe(state);
			expect(after).toBe(state);
			expect(context.snapshot).toBe(harness.kustoSnapshot);
			expect(harness.tryDispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
		});

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state, observer);

		expect(sanitized).toBe(state);
		expect(observer).toHaveBeenCalledOnce();
		expect(harness.order).toEqual(['kusto-enter', 'kusto-observer', 'kusto-exit']);
		expect(harness.getAccountPartition).not.toHaveBeenCalled();
		expect(harness.getKustoConnections).not.toHaveBeenCalled();
		expect(harness.getSqlConnections).not.toHaveBeenCalled();
		expect(harness.tryRunWithSqlOwnerSnapshotLock).not.toHaveBeenCalled();
	});

	it('propagates a Kusto sanitation observer failure exactly once', async () => {
		const harness = createHandler();
		const failure = new Error('owner observer failed');
		const observer = vi.fn(() => { throw failure; });

		await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(admittedState(), observer))
			.rejects.toBe(failure);
		expect(observer).toHaveBeenCalledOnce();
		expect(harness.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce();
	});

	it('preserves an eligible legacy Kusto result without adopting or changing its serialized payload', async () => {
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

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0].resultJson).toBe(resultJson);
		expect(state.sections[0]).not.toHaveProperty('kustoAccountPartition');
		expect(state.sections[0]).not.toHaveProperty('kustoLeaveNoTraceRevision');
	});

	it('preserves a preexisting legacy artifact descriptor without adoption', async () => {
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

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultArtifact', state.sections[0].resultArtifact);
		expect(sanitized.sections[0]).not.toHaveProperty('kustoAccountPartition');
		expect(sanitized.sections[0]).not.toHaveProperty('kustoLeaveNoTraceRevision');
	});

	it('is byte-stable and reference-stable on repeated legacy reads', async () => {
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

	it('preserves a privileged descriptor with an unresolved legacy payload', async () => {
		const harness = createHandler();
		harness.getKustoConnections.mockReturnValue([]);
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

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
		expect(sanitized.sections[0]).toHaveProperty('resultArtifact', state.sections[0].resultArtifact);
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
	])('preserves %s exactly without treating partial provenance as permission to delete', async (_kind, marker) => {
		const { handler } = createHandler();
		const state = legacyKustoState(marker);

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toMatchObject(marker);
	});

	it.each(['global', 'cluster'])('preserves legacy results under %s Leave No Trace without adoption', async kind => {
		const harness = createHandler();
		if (kind === 'global') harness.kustoSnapshot.globallyBlocked = true;
		else harness.kustoSnapshot.clusterKeys = ['cluster'];
		const state = legacyKustoState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
	});

	it('does not mutate legacy results because of a nonzero Kusto revocation generation', async () => {
		const harness = createHandler();
		harness.kustoSnapshot.revocationGenerations.cluster = 1;
		const state = legacyKustoState();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
	});

	it('preserves canonical legacy aliases and their Kusto comparisons without adoption', async () => {
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

		expect(sanitized).toBe(state);
		for (const section of sanitized.sections) {
			expect(section).not.toHaveProperty('kustoAccountPartition');
			expect(section).not.toHaveProperty('kustoLeaveNoTraceRevision');
		}
	});

	it('preserves nested legacy Kusto comparisons without changing their provenance', async () => {
		const { handler } = createHandler();
		const state = {
			sections: [
				{
					id: 'legacy-source', type: 'query', clusterUrl: kustoConnection.clusterUrl,
					connectionIdHint: kustoConnection.id, database: 'Db', query: 'T',
					resultJson: legacyResultJson(),
				},
				{
					id: 'legacy-comparison-b', type: 'query', comparisonSourceBoxId: 'legacy-source',
					query: 'T | count', resultJson: legacyResultJson(),
				},
				{
					id: 'legacy-comparison-c', type: 'query', comparisonSourceBoxId: 'legacy-comparison-b',
					query: 'T | summarize count()', resultJson: legacyResultJson(),
				},
			],
		};

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
	});

	it('preserves a markerless comparison when its query source has no cached result', async () => {
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

	it('preserves existing modern Kusto provenance despite a live account mismatch', async () => {
		const { handler } = createHandler();
		const state = legacyKustoState({
			kustoAccountPartition: 'partition-old',
			kustoLeaveNoTraceRevision: 0,
			resultArtifact: { version: 1, artifactId: 'forged' },
		});

		const sanitized = await handler.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized).toBe(state);
	});

	it('preserves an orphaned missing-marker query comparison without owner resolution', async () => {
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

	it('preserves a markerless comparison with a non-query source', async () => {
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

	it('preserves a missing-source markerless comparison without invoking unavailable SQL services', async () => {
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
		expect(harness.retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
	});

	it('preserves exact existing state for both engines in the fail-closed read API', () => {
		const { handler } = createHandler();
		const state = admittedState();

		const sanitized = handler.sanitizeSqlLeaveNoTraceStateFailClosed(state);

		expect(sanitized).toBe(state);
		expect(sanitized.futureState).toBe(state.futureState);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', state.sections[0].resultJson);
		expect(sanitized.sections[1]).toHaveProperty('resultJson', state.sections[1].resultJson);
		expect(sanitized.sections[2]).toHaveProperty('result', { opaque: true });
	});

	it('does not fabricate a blocked observer snapshot when canonical policy acquisition fails', async () => {
		const harness = createHandler();
		const state = admittedState();
		harness.runWithLeaveNoTraceSnapshotLock.mockRejectedValueOnce(new Error('policy unavailable'));
		const observer = vi.fn();

		const sanitized = await harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state, observer);

		expect(sanitized).toBe(state);
		expect(observer).not.toHaveBeenCalled();
		expect(harness.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce();
	});

	it('does not retry an observer after Kusto lock settlement fails', async () => {
		const harness = createHandler();
		const state = admittedState();
		const failure = new Error('policy unavailable');
		harness.runWithLeaveNoTraceSnapshotLock.mockImplementationOnce(async dispatch => {
			await dispatch(harness.kustoSnapshot);
			throw failure;
		});
		const observer = vi.fn();

		await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(state, observer))
			.resolves.toBe(state);
		expect(observer).toHaveBeenCalledOnce();
		expect(observer).toHaveBeenCalledWith(state, state, { snapshot: harness.kustoSnapshot });
		expect(harness.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce();
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

	it('reports Kusto sanitation before entering the SQL publication lock', async () => {
		const harness = createHandler();
		const state = admittedState();
		harness.kustoSnapshot.globallyBlocked = true;
		const observer = vi.fn(() => harness.order.push('kusto-observer'));
		const publish = vi.fn(async (sanitized: typeof state) => {
			harness.order.push('publish');
			expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
			return 'published';
		});

		await expect(harness.handler.publishSqlLeaveNoTraceStateFresh(
			state,
			publish,
			observer,
		)).resolves.toBe('published');

		expect(harness.order).toEqual([
			'retry', 'kusto-enter', 'kusto-observer', 'sql-enter', 'publish', 'sql-exit', 'kusto-exit',
		]);
	});

	it.each([true, false])(
		'filters by the captured Kusto producing target after retarget (protected producer: %s)', async protectedProducer => {
			const harness = createHandler();
			const ordinary = { ...kustoConnection, id: 'kusto-ordinary', clusterUrl: 'https://ordinary.kusto.windows.net' };
			harness.getKustoConnections.mockReturnValue([kustoConnection, ordinary]);
			harness.kustoSnapshot.clusterKeys = ['cluster'];
			const producingConnection = protectedProducer ? kustoConnection : ordinary;
			const authoredConnection = protectedProducer ? ordinary : kustoConnection;
			const producer = kustoResultProducer(producingConnection);
			const state = freezeState({
				sections: [{
					id: producer.boxId, type: 'query', query: producer.query,
					clusterUrl: authoredConnection.clusterUrl, connectionIdHint: authoredConnection.id,
					database: 'AuthoredDb', resultJson: '{"rows":[[2]]}', selectedResultIndex: 1,
					resultArtifact: {
						version: 1, ...createPrimaryResultArtifactIdentity(producer.boxId, 2, 1)!, producer,
					},
				}],
			});
			const original = JSON.stringify(state);

			const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

			if (protectedProducer) {
				expect(published.sections[0]).not.toHaveProperty('resultJson');
				expect(published.sections[0]).not.toHaveProperty('resultArtifact');
				expect(published.sections[0]).not.toHaveProperty('selectedResultIndex');
			} else {
				expect(published).toBe(state);
			}
			expect(published.sections[0]).toMatchObject({
				clusterUrl: authoredConnection.clusterUrl, connectionIdHint: authoredConnection.id, database: 'AuthoredDb',
			});
			expect(JSON.stringify(state)).toBe(original);
			expectNoAuthorizationReads(harness);
		},
	);

	it.each([true, false])(
		'filters by the captured SQL producing target after retarget (protected producer: %s)', async protectedProducer => {
			const harness = createHandler();
			const ordinary = { ...sqlConnection, id: 'sql-ordinary', serverUrl: 'ordinary.example' };
			harness.sqlConnections.push(ordinary);
			harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
			const producer = sqlResultProducer(protectedProducer ? sqlConnection : ordinary);
			const authoredConnection = protectedProducer ? ordinary : sqlConnection;
			const state = freezeState({
				sections: [{
					id: producer.boxId, type: 'sql', query: producer.query, database: 'AuthoredDb',
					connectionIdHint: authoredConnection.id, serverUrl: authoredConnection.serverUrl,
					targetSignature: sqlConnectionTargetSignature(authoredConnection),
					resultJson: '{"rows":[[2]]}', resultArtifact: resultArtifact(producer), selectedResultIndex: 0,
					principalFingerprint: undefined, revocationGeneration: -1,
				}],
			});

			const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

			if (protectedProducer) {
				expect(published.sections[0]).not.toHaveProperty('resultJson');
				expect(published.sections[0]).not.toHaveProperty('resultArtifact');
				expect(published.sections[0]).not.toHaveProperty('selectedResultIndex');
			} else {
				expect(published).toBe(state);
			}
			expect(published.sections[0]).toMatchObject({
				connectionIdHint: authoredConnection.id, serverUrl: authoredConnection.serverUrl, database: 'AuthoredDb',
			});
			expect(state.sections[0]).toHaveProperty('resultJson', '{"rows":[[2]]}');
			expectNoAuthorizationReads(harness);
		},
	);

	it.each([
		['kusto', true], ['kusto', false], ['sql', true], ['sql', false],
	] as const)(
		'uses descriptorless %s producing metadata after retarget (protected producer: %s)', async (engine, protectedProducer) => {
			const harness = createHandler();
			harness.kustoSnapshot.clusterKeys = ['cluster'];
			harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
			const protectedCluster = engine === 'kusto' ? kustoConnection.clusterUrl : sqlConnection.serverUrl;
			const ordinaryCluster = engine === 'kusto' ? 'ordinary.kusto.windows.net' : 'ordinary.example';
			const authoredCluster = protectedProducer ? ordinaryCluster : protectedCluster;
			const resultJson = legacyResultJson(protectedProducer ? protectedCluster : ordinaryCluster, 'DispatchDb');
			const state = freezeState({
				sections: [{
					id: 'descriptorless-b', type: engine === 'kusto' ? 'query' : 'sql',
					clusterUrl: authoredCluster, serverUrl: authoredCluster, database: 'AuthoredDb',
					connectionIdHint: protectedProducer ? 'ordinary' : engine === 'kusto' ? kustoConnection.id : sqlConnection.id,
					resultJson, selectedResultIndex: 0,
				}],
			});

			const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

			if (protectedProducer) expect(published.sections[0]).not.toHaveProperty('resultJson');
			else expect(published).toBe(state);
			expect(published.sections[0]).toMatchObject({ clusterUrl: authoredCluster, database: 'AuthoredDb' });
			expect(state.sections[0].resultJson).toBe(resultJson);
			expectNoAuthorizationReads(harness);
		},
	);

	it.each(['identity', 'endpoint', 'connection'] as const)('uses partial Kusto producing %s without authentication fields', async identity => {
		const harness = createHandler();
		const ordinary = { ...kustoConnection, id: 'kusto-ordinary', clusterUrl: 'ordinary.kusto.windows.net' };
		harness.getKustoConnections.mockReturnValue([kustoConnection, ordinary]);
		harness.kustoSnapshot.clusterKeys = ['cluster'];
		const state = freezeState({
			sections: [kustoConnection, ordinary].map((connection, index) => {
				const producer: ResultArtifactProducer = {
					boxId: `partial-${index}`, database: 'DispatchDb',
					...(identity === 'connection' ? { connectionId: connection.id } : {}),
					...(identity === 'identity' ? {
						dispatch: { connectionIdentityKey: getKustoConnectionIdentityKey(connection.clusterUrl, 'organizations') },
					} : identity === 'endpoint' ? {
						engine: 'kusto', dispatch: { connectionIdentityKey: '', clusterEndpoint: connection.clusterUrl },
					} : {}),
				};
				return {
					id: producer.boxId, type: 'query', clusterUrl: index === 0 ? ordinary.clusterUrl : kustoConnection.clusterUrl,
					resultJson: '{"rows":[[2]]}', resultArtifact: {
						...resultArtifact(producer), policy: { accountPartition: null, leaveNoTraceRevision: -1, sendToModel: 'opaque' },
					},
				};
			}),
		});

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		expect(published.sections[0]).not.toHaveProperty('resultJson');
		expect(published.sections[1]).toBe(state.sections[1]);
		expectNoAuthorizationReads(harness);
	});

	it.each(['recreated', 'repointed', 'inverse-repointed'] as const)('resolves SQL producing metadata when its captured identity is %s', async identity => {
		const harness = createHandler();
		const ordinary = { ...sqlConnection, id: 'sql-ordinary', serverUrl: 'ordinary.example' };
		const recreated = { ...sqlConnection, id: 'sql-recreated', credentialRevision: 99, database: 'DispatchDb' };
		if (identity === 'inverse-repointed') {
			harness.sqlConnections.push(ordinary);
			harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		} else {
			harness.sqlConnections.splice(0, 1, recreated, ordinary);
			if (identity === 'repointed') harness.sqlConnections.push({ ...ordinary, id: sqlConnection.id });
			harness.sqlSnapshot.policy.connectionIds = [recreated.id];
		}
		Object.defineProperty(harness.sqlSnapshot, 'accountsByServer', {
			get: () => { throw new Error('SQL principals must not be consulted'); },
		});
		const producer = sqlResultProducer();
		const state = freezeState({
			sections: [{
				id: producer.boxId, type: 'sql', connectionIdHint: identity === 'inverse-repointed' ? sqlConnection.id : ordinary.id,
				serverUrl: identity === 'inverse-repointed' ? sqlConnection.serverUrl : ordinary.serverUrl,
				database: 'AuthoredDb', resultArtifact: resultArtifact(producer),
				resultJson: legacyResultJson(identity === 'inverse-repointed' ? ordinary.serverUrl : sqlConnection.serverUrl, 'DispatchDb'),
			}],
		});

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		if (identity === 'inverse-repointed') expect(published).toBe(state);
		else expect(published.sections[0]).not.toHaveProperty('resultJson');
		expectNoAuthorizationReads(harness);
	});

	it('distinguishes SQL producing metadata databases without borrowing the current target signature', async () => {
		const harness = createHandler();
		const protectedConnection = { ...sqlConnection, database: 'ProtectedDb' };
		harness.sqlConnections.splice(0, 1, protectedConnection);
		harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		const state = freezeState({
			sections: ['protecteddb', 'OrdinaryDb'].map(database => ({
				id: database, type: 'sql', connectionIdHint: sqlConnection.id,
				targetSignature: sqlConnectionTargetSignature(protectedConnection), database: 'ProtectedDb',
				resultJson: legacyResultJson(' SERVER.EXAMPLE,1433 ', database),
			})),
		});

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		expect(published.sections[0]).not.toHaveProperty('resultJson');
		expect(published.sections[1]).toBe(state.sections[1]);
		expectNoAuthorizationReads(harness);
	});

	it.each([
		['kusto', true], ['kusto', false], ['sql', true], ['sql', false],
	] as const)(
		'uses the comparison %s producing target instead of its changed source (protected producer: %s)', async (engine, protectedProducer) => {
			const harness = createHandler();
			const ordinaryKusto = { ...kustoConnection, id: 'kusto-ordinary', clusterUrl: 'ordinary.kusto.windows.net' };
			const ordinarySql = { ...sqlConnection, id: 'sql-ordinary', serverUrl: 'ordinary.example' };
			harness.getKustoConnections.mockReturnValue([kustoConnection, ordinaryKusto]);
			harness.sqlConnections.push(ordinarySql);
			harness.kustoSnapshot.clusterKeys = ['cluster'];
			harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
			const producer = engine === 'kusto'
				? kustoResultProducer(protectedProducer ? kustoConnection : ordinaryKusto, 'comparison')
				: sqlResultProducer(protectedProducer ? sqlConnection : ordinarySql, 'comparison');
			const currentSourceProducer = engine === 'kusto'
				? kustoResultProducer(protectedProducer ? ordinaryKusto : kustoConnection, 'source')
				: sqlResultProducer(protectedProducer ? ordinarySql : sqlConnection, 'source');
			const state = freezeState({
				sections: [{
					id: 'source', type: engine === 'kusto' ? 'query' : 'sql',
					resultJson: '{"rows":[[3]]}', resultArtifact: resultArtifact(currentSourceProducer, 3),
				}, {
					id: 'comparison', type: 'query', comparisonSourceBoxId: 'source',
					resultJson: '{"rows":[[2]]}', selectedResultIndex: 1,
					resultArtifact: {
						...resultArtifact({ ...producer, producer: 'comparison' }),
						lineage: [{ sourceArtifactId: resultArtifact({ ...producer, boxId: 'source' }).artifactId, role: 'comparison-source' }],
					},
				}],
			});

			const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

			if (protectedProducer) {
				expect(published.sections[1]).not.toHaveProperty('resultJson');
				expect(published.sections[0]).toBe(state.sections[0]);
			} else {
				expect(published.sections[1]).toBe(state.sections[1]);
				expect(published.sections[0]).not.toHaveProperty('resultJson');
			}
			expect(state.sections[1].resultJson).toBe('{"rows":[[2]]}');
			expectNoAuthorizationReads(harness);
		},
	);

	it.each(['kusto', 'sql'] as const)('resolves exact %s comparison producing lineage after source retarget', async engine => {
		const harness = createHandler();
		harness.kustoSnapshot.clusterKeys = ['cluster'];
		harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		const sourceArtifact = resultArtifact(engine === 'kusto'
			? kustoResultProducer(kustoConnection, 'actual-source') : sqlResultProducer(sqlConnection, 'actual-source'));
		const state = freezeState({
			sections: [{
				id: 'actual-source', type: engine === 'kusto' ? 'query' : 'sql',
				clusterUrl: 'ordinary.kusto.windows.net', serverUrl: 'ordinary.example', connectionIdHint: 'ordinary',
				resultJson: '{"rows":[[1]]}', resultArtifact: sourceArtifact,
			}, {
				id: 'comparison', type: 'query', comparisonSourceBoxId: 'missing-or-replaced-source',
				resultJson: '{"rows":[[2]]}',
				resultArtifact: {
					...resultArtifact({ engine, boxId: 'comparison', producer: 'comparison' }),
					lineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'comparison-source' }],
				},
			}],
		});

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		for (const section of published.sections) expect(section).not.toHaveProperty('resultJson');
		for (const section of state.sections) expect(section).toHaveProperty('resultJson');
		expectNoAuthorizationReads(harness);
	});

	it.each([true, false])('uses an orphaned SQL comparison producing target under the SQL lock (protected: %s)', async protectedProducer => {
		const harness = createHandler();
		harness.kustoSnapshot.globallyBlocked = true;
		if (protectedProducer) harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		const state = freezeState({
			sections: [{
				id: 'orphan', type: 'query', comparisonSourceBoxId: 'missing', resultJson: '{"rows":[[2]]}',
				resultArtifact: resultArtifact(sqlResultProducer(sqlConnection, 'orphan')),
			}],
		});

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		if (protectedProducer) expect(published.sections[0]).not.toHaveProperty('resultJson');
		else expect(published).toBe(state);
		expect(harness.order).toEqual(['retry', 'kusto-enter', 'sql-enter', 'sql-exit', 'kusto-exit']);
		expectNoAuthorizationReads(harness);
	});

	it.each([
		['kusto', true], ['kusto', false], ['sql', true], ['sql', false],
	] as const)('keeps the %s durable baseline separate from protected B after retarget (saved A: %s)', async (engine, hasBaseline) => {
		const harness = createHandler();
		const producer = engine === 'kusto' ? kustoResultProducer() : sqlResultProducer();
		const initial: KqlxStateV1 = freezeState({
			sections: [{
				id: producer.boxId, type: engine === 'kusto' ? 'query' : 'sql', query: producer.query!,
				clusterUrl: kustoConnection.clusterUrl, serverUrl: sqlConnection.serverUrl,
				connectionIdHint: producer.connectionId, database: producer.database,
				resultJson: legacyResultJson(engine === 'kusto' ? kustoConnection.clusterUrl : sqlConnection.serverUrl, producer.database),
				resultArtifact: resultArtifact(producer), selectedResultIndex: 0,
			}],
		});
		const savedA = freezeState({
			...initial.sections[0], resultJson: ' {"columns":["Value"],"rows":[[1]]} ',
			resultArtifact: { legacy: 'saved-A', policy: { sendToModel: true } }, selectedResultIndex: 1,
			kustoAccountPartition: undefined, principalFingerprint: null,
		});
		const baseline = hasBaseline ? freezeState({ sections: [savedA] }) as KqlxStateV1 : undefined;
		await expect(harness.handler.publishSqlLeaveNoTraceStateFresh(initial, async candidate => candidate)).resolves.toBe(initial);
		harness.kustoSnapshot.clusterKeys = ['cluster'];
		harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		const submitted: KqlxStateV1 = freezeState({
			...initial, sections: [{
				...initial.sections[0], clusterUrl: 'ordinary.kusto.windows.net', serverUrl: 'ordinary.example',
				connectionIdHint: 'ordinary', database: 'AuthoredDb',
			}],
		});
		const original = JSON.stringify(submitted);
		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(submitted, async filtered => {
			expect(filtered.sections[0]).not.toHaveProperty('resultJson');
			expect(filtered.sections[0]).not.toHaveProperty('resultArtifact');
			return preserveKqlxResultAttachments(baseline, filtered, submitted);
		});

		if (hasBaseline) {
			expect(published.sections[0]).toMatchObject({
				resultJson: savedA.resultJson, resultArtifact: savedA.resultArtifact, selectedResultIndex: 1,
			});
			expect(Object.hasOwn(published.sections[0], 'kustoAccountPartition')).toBe(true);
		} else {
			expect(published.sections[0]).not.toHaveProperty('resultJson');
			expect(published.sections[0]).not.toHaveProperty('resultArtifact');
		}
		expect(published.sections[0]).toMatchObject({
			clusterUrl: 'ordinary.kusto.windows.net', serverUrl: 'ordinary.example', connectionIdHint: 'ordinary', database: 'AuthoredDb',
		});
		expect(JSON.stringify(submitted)).toBe(original);
		const reopened = freezeState(JSON.parse(JSON.stringify(published)) as KqlxStateV1);
		await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(reopened)).resolves.toBe(reopened);
		expectNoAuthorizationReads(harness);
	});

	it.each(['kusto-cluster', 'kusto-hint', 'sql-id', 'sql-recreated', 'sql-ambiguous', 'sql-server'] as const)(
		'filters only protected new candidates by %s policy without mutating input', async policy => {
			const harness = createHandler();
			const state = newCandidateState();
			const kustoPolicy = policy.startsWith('kusto');
			if (kustoPolicy) {
				harness.kustoSnapshot.clusterKeys = ['cluster'];
				if (policy === 'kusto-hint') delete state.sections[0].clusterUrl;
			} else {
				harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
				if (policy === 'sql-id') delete state.sections[1].targetSignature;
				if (policy === 'sql-recreated' || policy === 'sql-ambiguous') {
					harness.sqlConnections.splice(0, 1, { ...sqlConnection, id: 'sql-recreated' });
					harness.sqlSnapshot.policy.connectionIds = ['sql-recreated'];
					if (policy === 'sql-ambiguous') harness.sqlConnections.push({ ...sqlConnection, id: 'sql-other' });
				}
				if (policy === 'sql-server') {
					delete state.sections[1].targetSignature;
					state.sections[1].connectionIdHint = 'missing';
					state.sections[1].serverUrl = ' SERVER.EXAMPLE,1433 ';
				}
			}
			harness.getAccountPartition.mockImplementation(() => { throw new Error('auth must not be consulted'); });
			Object.defineProperty(harness.sqlSnapshot, 'accountsByServer', {
				get: () => { throw new Error('SQL principals must not be consulted'); },
			});
			freezeState(state);
			const original = JSON.stringify(state);
			const publish = vi.fn(async (candidate: typeof state) => candidate);

			const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, publish);

			const protectedIds = kustoPolicy
				? ['query-1', 'kusto-comparison']
				: ['sql-1', 'sql-comparison', 'nested-sql-comparison'];
			for (const [index, section] of published.sections.entries()) {
				if (protectedIds.includes(String(section.id))) {
					expect(section).not.toHaveProperty('resultJson');
					expect(section).not.toHaveProperty('resultArtifact');
					expect(section).not.toHaveProperty('selectedResultIndex');
				} else {
					expect(section).toBe(state.sections[index]);
				}
			}
			expect(published.futureState).toBe(state.futureState);
			expect(JSON.stringify(state)).toBe(original);
			expect(publish).toHaveBeenCalledOnce();
			expectNoAuthorizationReads(harness);
		},
	);

	it.each(['kusto', 'sql'] as const)('applies global %s LNT to new rows and orphaned attachments only', async engine => {
		const harness = createHandler();
		const type = engine === 'kusto' ? 'copilotQuery' : 'sql';
		if (engine === 'kusto') harness.kustoSnapshot.globallyBlocked = true;
		else harness.sqlSnapshot.policy.globallyBlocked = true;
		harness.getKustoConnections.mockReturnValue([]);
		harness.sqlConnections.splice(0);
		const state = freezeState({
			sections: [
				{
					id: 'protected', type, result: { rows: [[1]] }, resultJson: '{malformed',
					resultArtifact: { opaque: true }, selectedResultIndex: 1,
					kustoAccountPartition: undefined, kustoLeaveNoTraceRevision: 'invalid',
					principalFingerprint: null, revocationGeneration: -1, future: { keep: true },
				},
				{ id: 'attachment-only', type, resultArtifact: { opaque: true }, selectedResultIndex: 2 },
				admittedState().sections[2],
			],
		});

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		expect(published.sections[0]).toEqual({ id: 'protected', type, future: { keep: true } });
		expect(published.sections[1]).toEqual({ id: 'attachment-only', type });
		expect(published.sections[2]).toBe(state.sections[2]);
		expectNoAuthorizationReads(harness);
	});

	it.each(['removed', 'mismatched', 'ambiguous'] as const)(
		'keeps ordinary new candidates with %s owners without provenance cleanup', async ownership => {
			const harness = createHandler();
			harness.getAccountPartition.mockReturnValue('');
			harness.sqlSnapshot.accountsByServer['server.example'] = '';
			harness.kustoSnapshot.revocationGenerations.cluster = 99;
			harness.sqlSnapshot.policy.revocationGenerations[sqlConnection.id] = 99;
			if (ownership === 'removed') {
				harness.getKustoConnections.mockReturnValue([]);
				harness.sqlConnections.splice(0);
			} else if (ownership === 'mismatched') {
				harness.getAccountPartition.mockReturnValue('different-partition');
				harness.sqlSnapshot.accountsByServer['server.example'] = 'different-account';
				harness.getKustoConnections.mockReturnValue([{ ...kustoConnection, clusterUrl: 'different' }]);
				harness.sqlConnections.splice(0, 1, { ...sqlConnection, serverUrl: 'different' });
			} else {
				harness.getKustoConnections.mockReturnValue([
					{ ...kustoConnection, id: 'kusto-a' }, { ...kustoConnection, id: 'kusto-b' },
				]);
				harness.sqlConnections.splice(0, 1,
					{ ...sqlConnection, id: 'sql-a' }, { ...sqlConnection, id: 'sql-b' });
			}
			const state = newCandidateState();
			state.sections.push(
				...legacyKustoState({ resultArtifact: { policy: { sendToModel: true } } }).sections,
				{ type: 'sql', resultArtifact: { orphaned: true }, principalFingerprint: undefined, selectedResultIndex: 1 },
				{ type: 'query', resultJson: '', kustoAccountPartition: undefined, resultArtifact: { opaque: true } },
				{ id: 'orphan', type: 'query', comparisonSourceBoxId: 'missing', resultJson: '{malformed' },
				{ id: 'cycle-a', type: 'query', comparisonSourceBoxId: 'cycle-b', resultJson: '[]' },
				{ id: 'cycle-b', type: 'query', comparisonSourceBoxId: 'cycle-a', resultJson: 'null' },
			);
			freezeState(state);

			await expect(harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate))
				.resolves.toBe(state);
			expectNoAuthorizationReads(harness);
			expect(harness.getKustoConnections).not.toHaveBeenCalled();
		},
	);

	it.each(['query', 'sql'] as const)('inherits %s source LNT even without source rows or matching comparison targets', async type => {
		const harness = createHandler();
		const state = newCandidateState();
		const sourceIndex = type === 'query' ? 0 : 1;
		delete state.sections[sourceIndex].resultJson;
		delete state.sections[sourceIndex].resultArtifact;
		if (type === 'query') harness.kustoSnapshot.clusterKeys = ['cluster'];
		else harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		freezeState(state);

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		expect(published.sections[type === 'query' ? 5 : 6]).not.toHaveProperty('resultJson');
		expect(published.sections[3]).toBe(state.sections[3]);
		expect(published.sections[4]).toBe(state.sections[4]);
	});

	it.each(['query', 'sql'] as const)('inherits known %s LNT through cyclic comparisons without leaking new rows', async type => {
		const harness = createHandler();
		if (type === 'query') harness.kustoSnapshot.clusterKeys = ['cluster'];
		else harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		const state = freezeState({
			sections: [
				{ id: 'comparison', type: 'query', comparisonSourceBoxId: 'source', resultJson: '{"comparison":true}' },
				{
					id: 'source', type, comparisonSourceBoxId: 'comparison',
					clusterUrl: kustoConnection.clusterUrl, connectionIdHint: sqlConnection.id,
					resultJson: '{"source":true}',
				},
			],
		});

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate);

		for (const section of published.sections) expect(section).not.toHaveProperty('resultJson');
		for (const section of state.sections) expect(section).toHaveProperty('resultJson');
	});

	it('removes only legacy result fields on known new sections without adopting their metadata', async () => {
		const harness = createHandler();
		const state = freezeState({
			sections: [
				...['query', 'copilotQuery', 'sql'].map(type => ({
					id: type, type, result: { rows: [[1]] }, resultJson: '{malformed',
					resultArtifact: { opaque: true }, selectedResultIndex: 0,
				})),
				admittedState().sections[2],
			],
		});
		const observer = vi.fn();

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate, observer);

		for (let index = 0; index < 3; index += 1) {
			expect(published.sections[index]).not.toHaveProperty('result');
			expect(published.sections[index]).toHaveProperty('resultJson', '{malformed');
			expect(published.sections[index]).toHaveProperty('resultArtifact', state.sections[index].resultArtifact);
			expect(published.sections[index]).toHaveProperty('selectedResultIndex', 0);
			expect(published.sections[index]).not.toHaveProperty('kustoAccountPartition');
			expect(state.sections[index]).toHaveProperty('result');
		}
		expect(published.sections[3]).toBe(state.sections[3]);
		expect(observer.mock.calls[0][0]).toBe(state);
	});

	it.each(['kusto-lock', 'sql-lock', 'retry', 'kusto-target'] as const)(
		'aborts new-result publication exactly when %s acquisition fails', async stage => {
			const harness = createHandler();
			const state = newCandidateState();
			const failure = new Error('snapshot unavailable');
			if (stage === 'kusto-lock') harness.runWithLeaveNoTraceSnapshotLock.mockRejectedValueOnce(failure);
			if (stage === 'sql-lock') harness.tryRunWithSqlOwnerSnapshotLock.mockRejectedValueOnce(failure);
			if (stage === 'retry') harness.retrySqlOwnerSnapshotAcquisition.mockRejectedValueOnce(failure);
			if (stage === 'kusto-target') {
				harness.kustoSnapshot.clusterKeys = ['cluster'];
				delete state.sections[0].clusterUrl;
				harness.getKustoConnections.mockImplementation(() => { throw failure; });
			}
			freezeState(state);
			const publish = vi.fn(async (candidate: typeof state) => candidate);

			await expect(harness.handler.publishSqlLeaveNoTraceStateFresh(state, publish)).rejects.toBe(failure);

			expect(publish).not.toHaveBeenCalled();
			expect(state.sections[0]).toHaveProperty('resultJson', '{"kusto":true}');
			expect(state.sections[1]).toHaveProperty('resultJson', '{"sql":true}');
		},
	);

	it('publishes Kusto-only state without consulting unavailable SQL snapshot services', async () => {
		const harness = createHandler();
		const state = freezeState(legacyKustoState());
		harness.retrySqlOwnerSnapshotAcquisition.mockRejectedValue(new Error('SQL unavailable'));
		harness.tryRunWithSqlOwnerSnapshotLock.mockRejectedValue(new Error('SQL unavailable'));

		await expect(harness.handler.publishSqlLeaveNoTraceStateFresh(state, async candidate => candidate)).resolves.toBe(state);

		expect(harness.order).toEqual(['kusto-enter', 'kusto-exit']);
		expect(harness.retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
		expect(harness.tryRunWithSqlOwnerSnapshotLock).not.toHaveBeenCalled();
	});

	it('releases Kusto on SQL contention and refilters the original candidate under fresh policies', async () => {
		const harness = createHandler();
		const state = freezeState(admittedState());
		harness.tryRunWithSqlOwnerSnapshotLock.mockImplementationOnce(async () => {
			harness.order.push('sql-contended');
			harness.kustoSnapshot.globallyBlocked = true;
			harness.sqlSnapshot.policy.globallyBlocked = true;
			return { acquired: false };
		});
		const publish = vi.fn(async (candidate: typeof state) => {
			harness.order.push('publish');
			return candidate;
		});
		const observer = vi.fn();

		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(state, publish, observer);

		expect(published.sections[0]).not.toHaveProperty('resultJson');
		expect(published.sections[1]).not.toHaveProperty('resultJson');
		expect(published.sections[2]).toBe(state.sections[2]);
		expect(publish).toHaveBeenCalledOnce();
		expect(observer.mock.calls.map(call => call[0])).toEqual([state, state]);
		expect(harness.order).toEqual([
			'retry', 'kusto-enter', 'sql-contended', 'kusto-exit',
			'kusto-enter', 'sql-enter', 'publish', 'sql-exit', 'kusto-exit',
		]);
	});

	it.each(['observer', 'publisher'] as const)('propagates exact %s publication failure once and releases its locks', async stage => {
		const harness = createHandler();
		const failure = Object.assign(new Error('callback failed'), { code: 'ELOCKED' });
		const observer = vi.fn(() => { if (stage === 'observer') throw failure; });
		const publish = vi.fn(async () => { throw failure; });

		await expect(harness.handler.publishSqlLeaveNoTraceStateFresh(admittedState(), publish, observer)).rejects.toBe(failure);

		expect(observer).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledTimes(stage === 'publisher' ? 1 : 0);
		expect(harness.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce();
		expect(harness.order).toEqual(stage === 'observer'
			? ['retry', 'kusto-enter', 'kusto-exit']
			: ['retry', 'kusto-enter', 'sql-enter', 'sql-exit', 'kusto-exit']);
	});

	it('keeps saved reads exact across protected new publication, failed write, and policy recovery', async () => {
		const harness = createHandler();
		const saved = existingState();
		const candidate = freezeState(newCandidateState());
		harness.kustoSnapshot.clusterKeys = ['cluster'];
		harness.sqlSnapshot.policy.connectionIds = [sqlConnection.id];
		const observer = vi.fn();
		await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(saved, observer)).resolves.toBe(saved);
		expect(observer).toHaveBeenCalledWith(saved, saved, { snapshot: harness.kustoSnapshot });

		const publish = vi.fn(async (filtered: typeof candidate) => filtered);
		const filtered = await harness.handler.publishSqlLeaveNoTraceStateFresh(candidate, publish);
		expect(filtered.sections[0]).not.toHaveProperty('resultJson');
		expect(filtered.sections[1]).not.toHaveProperty('resultJson');
		expect(filtered.sections[3]).toBe(candidate.sections[3]);
		const failure = new Error('policy unavailable');
		harness.runWithLeaveNoTraceSnapshotLock.mockRejectedValueOnce(failure);
		await expect(harness.handler.publishSqlLeaveNoTraceStateFresh(candidate, publish)).rejects.toBe(failure);
		expect(publish).toHaveBeenCalledOnce();
		await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(saved)).resolves.toBe(saved);

		harness.kustoSnapshot.clusterKeys = [];
		harness.sqlSnapshot.policy.connectionIds = [];
		const published = await harness.handler.publishSqlLeaveNoTraceStateFresh(candidate, publish);
		expect(published).toBe(candidate);
		await expect(harness.handler.sanitizeSqlLeaveNoTraceStateFresh(published)).resolves.toBe(published);
		expect(publish).toHaveBeenCalledTimes(2);
	});

	it('commits a Kusto source admission only under the same canonical policy fingerprint', async () => {
		const harness = createHandler();
		const commit = vi.fn(() => true);
		const fingerprint = kustoLeaveNoTracePolicyFingerprint(harness.kustoSnapshot);

		await expect(harness.handler.commitKustoSourceAdmissionFresh(fingerprint, commit))
			.resolves.toBe(true);
		expect(commit).toHaveBeenCalledOnce();
		expect(harness.order).toEqual(['kusto-enter', 'kusto-exit']);
	});

	it('awaits an asynchronous Kusto source admission under the policy lock', async () => {
		const harness = createHandler();
		let releaseCommit!: () => void;
		const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
		const fingerprint = kustoLeaveNoTracePolicyFingerprint(harness.kustoSnapshot);
		const commit = vi.fn(async () => {
			harness.order.push('commit-start');
			await commitGate;
			harness.order.push('commit-end');
			return true;
		});

		const pending = harness.handler.commitKustoSourceAdmissionFresh(fingerprint, commit);
		await vi.waitFor(() => expect(harness.order).toEqual(['kusto-enter', 'commit-start']));
		releaseCommit();

		await expect(pending).resolves.toBe(true);
		expect(harness.order).toEqual(['kusto-enter', 'commit-start', 'commit-end', 'kusto-exit']);
	});

	it('rejects a Kusto source admission when canonical policy changed without a watcher event', async () => {
		const harness = createHandler();
		const commit = vi.fn(() => true);
		const fingerprint = kustoLeaveNoTracePolicyFingerprint(harness.kustoSnapshot);
		harness.kustoSnapshot.version = 2;
		harness.kustoSnapshot.globallyBlocked = true;

		await expect(harness.handler.commitKustoSourceAdmissionFresh(fingerprint, commit))
			.resolves.toBe(false);
		expect(commit).not.toHaveBeenCalled();
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
