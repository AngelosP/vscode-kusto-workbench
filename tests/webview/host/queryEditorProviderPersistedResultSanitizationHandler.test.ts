import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const sanitationEffects = vi.hoisted(() => ({
	reconcileComparisonOwners: vi.fn(),
	invalidateSqlPersistence: undefined as (() => void) | undefined,
	invalidateKustoPersistence: undefined as (() => void) | undefined,
}));

vi.mock('../../../src/host/kustoExecutionCoordinator', () => ({
	KustoExecutionCoordinator: class {
		revokeConnections(): void {}
	},
}));

vi.mock('../../../src/host/kustoClient', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/kustoClient')>(),
	KustoQueryClient: class {},
}));

vi.mock('../../../src/host/kustoAuthPreferenceService', () => ({
	KustoAuthPreferenceService: {
		getInstance: () => ({ onDidChange: () => ({ dispose() {} }) }),
	},
}));

vi.mock('../../../src/host/queryEditorConnection', () => ({
	ConnectionService: class {},
}));

vi.mock('../../../src/host/queryEditorSchema', () => ({
	SchemaService: class {},
}));

vi.mock('../../../src/host/sql/sqlEditorLifecycleCoordinator', () => ({
	SqlEditorLifecycleCoordinator: class {
		readonly executionBroker = {};
		constructor(options: { effects: { invalidatePersistence: () => void } }) {
			sanitationEffects.invalidateSqlPersistence = options.effects.invalidatePersistence;
		}
		startSession(): void {}
		reconcileComparisonOwners(sections: unknown[]): void {
			sanitationEffects.reconcileComparisonOwners(sections);
		}
		getComparisonOwner(): undefined { return undefined; }
		getConnectionId(): undefined { return undefined; }
	},
}));

vi.mock('../../../src/host/queryEditorCopilot', () => ({
	CopilotService: class {
		invalidateKustoConnections(): void {}
	},
}));

vi.mock('../../../src/host/kustoConnectionLifecycle', () => ({
	KustoConnectionLifecycle: class {
		constructor(_connectionManager: unknown, effects: {
			invalidatePersistence: () => void;
		}) {
			sanitationEffects.invalidateKustoPersistence = effects.invalidatePersistence;
		}
	},
}));

vi.mock('../../../src/host/extension', () => ({
	toolOrchestrator: undefined,
}));

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';

type PersistedState = { sections: unknown[] };

type StructuralPersistedResultSanitizationHandler = {
	sanitizeSqlLeaveNoTraceState: ReturnType<typeof vi.fn>;
	sanitizeSqlLeaveNoTraceStateFresh: ReturnType<typeof vi.fn>;
	sanitizeSqlLeaveNoTraceStateFailClosed: ReturnType<typeof vi.fn>;
	publishSqlLeaveNoTraceStateFresh: ReturnType<typeof vi.fn>;
	onDidInvalidateSqlPersistence: vscode.Event<void>;
	onDidInvalidateKustoPersistence: vscode.Event<void>;
	invalidateSqlPersistence: ReturnType<typeof vi.fn>;
	invalidateKustoPersistence: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function emptyEvent(): vscode.Event<void> {
	return () => ({ dispose() {} });
}

function createProvider(handler: StructuralPersistedResultSanitizationHandler) {
	const kustoGetConnections = vi.fn(() => []);
	const runWithLeaveNoTraceSnapshotLock = vi.fn(async (dispatch: (snapshot: unknown) => unknown) => dispatch({
		clusterKeys: [],
		globallyBlocked: false,
		version: 1,
		revocationGenerations: {},
	}));
	const sqlGetConnection = vi.fn();
	const sqlGetConnections = vi.fn(() => []);
	const retrySqlOwnerSnapshotAcquisition = vi.fn(async (acquire: () => Promise<{ acquired: boolean; value?: unknown }>) => {
		const result = await acquire();
		if (!result.acquired) throw new Error('SQL owner snapshot was not acquired.');
		return result.value;
	});
	const tryDispatchSqlOwnerSnapshot = vi.fn();
	const tryRunWithSqlOwnerSnapshotLock = vi.fn();
	const publish = vi.fn(async () => 'direct-publication');
	const projectionHandler = {
		handleMessage: vi.fn(),
		refresh: vi.fn(async () => true),
		dispose: vi.fn(),
	};
	const constructorArgs: unknown[] = [
		vscode.Uri.file('C:\\extension'),
		{
			getConnection: vi.fn(),
			getConnections: kustoGetConnections,
			runWithLeaveNoTraceSnapshotLock,
		},
		{
			globalStorageUri: vscode.Uri.file('C:\\storage'),
			globalState: { get: vi.fn(), update: vi.fn(async () => undefined) },
			extensionMode: vscode.ExtensionMode.Test,
		},
		{
			connectionManager: {
				getConnection: sqlGetConnection,
				getConnections: sqlGetConnections,
			},
			client: {},
			leaveNoTracePolicy: { getRevocationGeneration: vi.fn(() => 0) },
			retrySqlOwnerSnapshotAcquisition,
			tryDispatchSqlOwnerSnapshot,
			tryRunWithSqlOwnerSnapshotLock,
		},
	];
	while (constructorArgs.length < 22) constructorArgs.push(undefined);
	constructorArgs.push({
		handleMessage: vi.fn(),
		getFavorites: vi.fn(() => []),
		dispose: vi.fn(),
	});
	while (constructorArgs.length < 41) constructorArgs.push(undefined);
	constructorArgs.push(projectionHandler);
	constructorArgs.push(handler);
	const provider = Reflect.construct(QueryEditorProvider, constructorArgs) as QueryEditorProvider;
	vi.clearAllMocks();
	return {
		provider,
		publish,
		kustoGetConnections,
		runWithLeaveNoTraceSnapshotLock,
		sqlGetConnection,
		sqlGetConnections,
		retrySqlOwnerSnapshotAcquisition,
		tryDispatchSqlOwnerSnapshot,
		tryRunWithSqlOwnerSnapshotLock,
	};
}

describe('QueryEditorProvider persisted result sanitization application', () => {
	afterEach(() => {
		sanitationEffects.invalidateSqlPersistence = undefined;
		sanitationEffects.invalidateKustoPersistence = undefined;
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reference-identically forwards and awaits lock-held publication without direct effects', async () => {
		const state: PersistedState = { sections: [] };
		const settlement = deferred<string>();
		const handler: StructuralPersistedResultSanitizationHandler = {
			sanitizeSqlLeaveNoTraceState: vi.fn(),
			sanitizeSqlLeaveNoTraceStateFresh: vi.fn(),
			sanitizeSqlLeaveNoTraceStateFailClosed: vi.fn(),
			publishSqlLeaveNoTraceStateFresh: vi.fn((candidateState, candidatePublish) =>
				candidateState === state && candidatePublish === publish
					? settlement.promise
					: Promise.reject(new Error('Provider changed the sanitation arguments.'))),
			onDidInvalidateSqlPersistence: emptyEvent(),
			onDidInvalidateKustoPersistence: emptyEvent(),
			invalidateSqlPersistence: vi.fn(),
			invalidateKustoPersistence: vi.fn(),
			dispose: vi.fn(),
		};
		const {
			provider,
			publish,
			kustoGetConnections,
			runWithLeaveNoTraceSnapshotLock,
			sqlGetConnection,
			sqlGetConnections,
			retrySqlOwnerSnapshotAcquisition,
			tryDispatchSqlOwnerSnapshot,
			tryRunWithSqlOwnerSnapshotLock,
		} = createProvider(handler);
		let settled = false;
		const publication = provider.publishSqlLeaveNoTraceStateFresh(state, publish);
		void publication.finally(() => { settled = true; });
		await Promise.resolve();

		expect(handler.publishSqlLeaveNoTraceStateFresh).toHaveBeenCalledOnce();
		expect(handler.publishSqlLeaveNoTraceStateFresh.mock.calls[0][0]).toBe(state);
		expect(handler.publishSqlLeaveNoTraceStateFresh.mock.calls[0][1]).toBe(publish);
		expect((provider as unknown as { persistedResultSanitizationApplication: unknown })
			.persistedResultSanitizationApplication).toBe(handler);
		expect(settled).toBe(false);
		expect(sanitationEffects.reconcileComparisonOwners).not.toHaveBeenCalled();
		expect(kustoGetConnections).not.toHaveBeenCalled();
		expect(runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(sqlGetConnection).not.toHaveBeenCalled();
		expect(sqlGetConnections).not.toHaveBeenCalled();
		expect(retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
		expect(tryDispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
		expect(tryRunWithSqlOwnerSnapshotLock).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();

		settlement.resolve('handler-publication');
		await expect(publication).resolves.toBe('handler-publication');
		expect(settled).toBe(true);
	});

	it('reference-identically delegates synchronous, fresh, and fail-closed sanitation', async () => {
		const state: PersistedState = { sections: [{ id: 'exact-state' }] };
		const synchronousResult: PersistedState = { sections: [{ id: 'sync-result' }] };
		const freshResult: PersistedState = { sections: [{ id: 'fresh-result' }] };
		const failClosedResult: PersistedState = { sections: [{ id: 'fail-closed-result' }] };
		const sqlEvent = emptyEvent();
		const kustoEvent = emptyEvent();
		const handler: StructuralPersistedResultSanitizationHandler = {
			sanitizeSqlLeaveNoTraceState: vi.fn(() => synchronousResult),
			sanitizeSqlLeaveNoTraceStateFresh: vi.fn(async () => freshResult),
			sanitizeSqlLeaveNoTraceStateFailClosed: vi.fn(() => failClosedResult),
			publishSqlLeaveNoTraceStateFresh: vi.fn(),
			onDidInvalidateSqlPersistence: sqlEvent,
			onDidInvalidateKustoPersistence: kustoEvent,
			invalidateSqlPersistence: vi.fn(),
			invalidateKustoPersistence: vi.fn(),
			dispose: vi.fn(),
		};
		const {
			provider,
			kustoGetConnections,
			runWithLeaveNoTraceSnapshotLock,
			sqlGetConnection,
			sqlGetConnections,
			retrySqlOwnerSnapshotAcquisition,
			tryDispatchSqlOwnerSnapshot,
			tryRunWithSqlOwnerSnapshotLock,
		} = createProvider(handler);

		expect(provider.sanitizeSqlLeaveNoTraceState(state)).toBe(synchronousResult);
		await expect(provider.sanitizeSqlLeaveNoTraceStateFresh(state)).resolves.toBe(freshResult);
		expect(provider.sanitizeSqlLeaveNoTraceStateFailClosed(state)).toBe(failClosedResult);
		expect(handler.sanitizeSqlLeaveNoTraceState.mock.calls[0][0]).toBe(state);
		expect(handler.sanitizeSqlLeaveNoTraceStateFresh.mock.calls[0][0]).toBe(state);
		expect(handler.sanitizeSqlLeaveNoTraceStateFailClosed.mock.calls[0][0]).toBe(state);
		expect(provider.onDidInvalidateSqlPersistence).toBe(sqlEvent);
		expect(provider.onDidInvalidateKustoPersistence).toBe(kustoEvent);
		expect(sanitationEffects.reconcileComparisonOwners).not.toHaveBeenCalled();
		expect(kustoGetConnections).not.toHaveBeenCalled();
		expect(runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(sqlGetConnection).not.toHaveBeenCalled();
		expect(sqlGetConnections).not.toHaveBeenCalled();
		expect(retrySqlOwnerSnapshotAcquisition).not.toHaveBeenCalled();
		expect(tryDispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
		expect(tryRunWithSqlOwnerSnapshotLock).not.toHaveBeenCalled();
	});

	it('routes SQL and Kusto lifecycle invalidation through the same owner', () => {
		const handler: StructuralPersistedResultSanitizationHandler = {
			sanitizeSqlLeaveNoTraceState: vi.fn(),
			sanitizeSqlLeaveNoTraceStateFresh: vi.fn(),
			sanitizeSqlLeaveNoTraceStateFailClosed: vi.fn(),
			publishSqlLeaveNoTraceStateFresh: vi.fn(),
			onDidInvalidateSqlPersistence: emptyEvent(),
			onDidInvalidateKustoPersistence: emptyEvent(),
			invalidateSqlPersistence: vi.fn(),
			invalidateKustoPersistence: vi.fn(),
			dispose: vi.fn(),
		};
		createProvider(handler);

		sanitationEffects.invalidateSqlPersistence?.();
		sanitationEffects.invalidateKustoPersistence?.();

		expect(handler.invalidateSqlPersistence).toHaveBeenCalledOnce();
		expect(handler.invalidateKustoPersistence).toHaveBeenCalledOnce();
	});

	it('keeps persisted-result sanitation authority out of the provider', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const providerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/queryEditorProvider.ts'),
			'utf8',
		);
		const handlerSource = fs.readFileSync(
			path.join(workspaceRoot, 'src/host/persistedResultSanitizationApplicationHandler.ts'),
			'utf8',
		);

		expect(providerSource).not.toContain('stripLegacyResultPayloads');
		expect(providerSource).not.toContain('sanitizeKustoLeaveNoTraceStateFromSnapshot');
		expect(providerSource).not.toContain('stripAllKustoOwnedResults');
		expect(providerSource).not.toContain('stripOrphanedSqlPrincipalFingerprints');
		expect(providerSource).not.toContain('stripAllSqlOwnedResults');
		expect(providerSource).not.toContain('sanitizeSqlPrincipalOwnedResultsFromSnapshot');
		expect(providerSource).not.toContain('hasSqlOwnedState');
		expect(providerSource).not.toContain('sqlPersistenceInvalidationEmitter');
		expect(providerSource).not.toContain('kustoPersistenceInvalidationEmitter');
		expect(providerSource).not.toContain('runWithLeaveNoTraceSnapshotLock');
		expect(providerSource).not.toContain('tryRunWithSqlOwnerSnapshotLock');
		expect(providerSource).toContain('this.persistedResultSanitizationApplication.dispose();');
		expect(handlerSource).toContain('private stripLegacyResultPayloads');
		expect(handlerSource).toContain('private sanitizeKustoLeaveNoTraceStateFromSnapshot');
		expect(handlerSource).toContain('this.options.connectionManager.runWithLeaveNoTraceSnapshotLock');
		expect(handlerSource).toContain('this.options.sqlWorkbench.tryRunWithSqlOwnerSnapshotLock');
		expect(handlerSource).toContain('private readonly sqlPersistenceInvalidationEmitter');
		expect(handlerSource).toContain('private readonly kustoPersistenceInvalidationEmitter');
	});
});
