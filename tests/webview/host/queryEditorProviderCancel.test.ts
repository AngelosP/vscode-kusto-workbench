import type * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';
import { ConnectionManager, type KustoConnection } from '../../../src/host/connectionManager';
import type { ExecuteQueryMessage } from '../../../src/host/queryEditorTypes';
import { appendQueryMode, isControlCommand, normalizeControlCommandForExecution } from '../../../src/host/queryEditorUtils';
import { kustoClusterKey } from '../../../src/shared/kustoClusterUrls';
import { getKustoConnectionIdentityKey } from '../../../src/shared/kustoAuth';
import { sqlConnectionTargetSignature } from '../../../src/shared/sqlConnectionIdentity';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import type { KustoExecutionCoordinator } from '../../../src/host/kustoExecutionCoordinator';
import {
	SqlEditorSessionRegistry,
	type SqlComparisonOwner,
	type SqlEditorTarget,
	type SqlIssuedOwnerToken,
	type SqlReadyToolOwner,
	type SqlResultOwner,
} from '../../../src/host/sql/sqlEditorSessionRegistry';
import { SqlExecutionBroker } from '../../../src/host/sql/sqlExecutionBroker';
import { SqlWorkbenchService } from '../../../src/host/sql/sqlWorkbenchService';
import { withSqlStateFileLock } from '../../../src/host/sql/sqlStateTransaction';
import { HostCopilotQueryWorkflowApplicationHandler } from '../../../src/host/copilotQueryWorkflowApplicationHandler';
import { HostKustoSectionExecutionApplicationHandler } from '../../../src/host/kustoSectionExecutionApplicationHandler';
import { HostComparisonPreparationApplicationHandler } from '../../../src/host/comparisonPreparationApplicationHandler';
import { HostSqlSectionExecutionApplicationHandler } from '../../../src/host/sqlSectionExecutionApplicationHandler';
import { HostSqlSchemaRequestApplicationHandler } from '../../../src/host/sqlSchemaRequestApplicationHandler';
import { HostPersistedResultSanitizationApplicationHandler } from '../../../src/host/persistedResultSanitizationApplicationHandler';
import {
	clearSqlSectionSessionsForTest,
	registerSqlSectionSession,
	routeSqlSectionMessage,
} from '../../../src/webview/core/sql-section-message-router';

const TEST_CONNECTION: KustoConnection = {
	id: 'conn-1',
	name: 'Test cluster',
	clusterUrl: 'https://example.kusto.windows.net',
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function queryResult(label: string) {
	return {
		columns: ['label'],
		rows: [[label]],
		metadata: {
			cluster: TEST_CONNECTION.clusterUrl,
			database: 'Samples',
			executionTime: '0.001s',
		},
	};
}

function kustoDispatchIdentity(leaveNoTraceRevision: number) {
	return {
		dispatchAttempt: 1,
		connectionRevision: 0,
		leaveNoTraceRevision,
		connectionIdentityKey: getKustoConnectionIdentityKey(TEST_CONNECTION.clusterUrl, TEST_CONNECTION.authorityId),
		clusterEndpoint: TEST_CONNECTION.clusterUrl,
		accountPartition: 'partition-current',
		authSessionGeneration: 0,
		clientActivityId: 'KW.execute_query;dispatch',
	};
}

function dispatchingKustoExecution(execution: Record<string, unknown>, leaveNoTraceRevision = 0) {
	return (_connection: unknown, _database: string, _query: string, _key: string, options: any) => {
		options.onDispatch(kustoDispatchIdentity(leaveNoTraceRevision));
		return execution;
	};
}

let executeMessageSequence = 0;
let publicationIdSequence = 0;
let comparisonRequestSequence = 0;

function executeMessage(boxId: string, query: string = 'print x=1', executionId = `kusto-test-${++executeMessageSequence}`): ExecuteQueryMessage {
	return {
		type: 'executeQuery',
		query,
		connectionId: TEST_CONNECTION.id,
		database: 'Samples',
		boxId,
		executionId,
		sectionInstanceId: `instance-${boxId}`,
		targetGeneration: 1,
		producer: 'manual',
		queryMode: 'plain',
		cacheEnabled: false,
		cacheValue: 1,
		cacheUnit: 'h',
	};
}

function installKustoSectionExecutionApplication(
	provider: QueryEditorProvider & Record<string, any>,
): void {
	provider.kustoSectionExecutionApplication = new HostKustoSectionExecutionApplicationHandler({
		coordinator: provider.kustoExecutionCoordinator,
		kustoClient: provider.kustoClient,
		connection: provider.connection,
		connectionManager: provider.connectionManager,
		postMessage: (message: unknown) => provider.postMessage(message),
		refreshConnectionsData: () => provider.refreshConnectionsData(),
		cancelKustoCopilotSection: (boxId, sectionInstanceId) =>
			provider.copilot?.cancelKustoCopilotSection?.(boxId, sectionInstanceId),
		getErrorMessage: error => provider.getErrorMessage(error),
		formatQueryExecutionErrorForUser: (error, connection, database) =>
			provider.formatQueryExecutionErrorForUser(error, connection, database),
		logQueryExecutionError: (error, connection, database, boxId, query) =>
			provider.logQueryExecutionError(error, connection, database, boxId, query),
		appendQueryMode: (query, queryMode) => provider.appendQueryMode(query, queryMode),
		isControlCommand: query => provider.isControlCommand(query),
		normalizeControlCommandForExecution: query => provider.normalizeControlCommandForExecution(query),
		buildCacheDirective: (enabled, value, unit) => provider.buildCacheDirective(enabled, value, unit),
		showErrorMessage: message => { void message; },
		isDisposed: () => provider._panelDisposed === true,
		createPublicationId: () => `test-${++publicationIdSequence}`,
		now: () => Date.now(),
	});
}

function createProviderHarness() {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.postMessage = vi.fn(() => true);
	provider.postKustoPublication = vi.fn(async (message: unknown) => await Promise.resolve(provider.postMessage(message)) !== false);
	provider.refreshConnectionsData = vi.fn(async () => undefined);
	provider.connection = {
		saveLastSelection: vi.fn(async () => undefined),
		findConnection: vi.fn(() => TEST_CONNECTION),
	};
	provider.connectionManager = {
		policyRevision: 0,
		getConnections: vi.fn(() => [TEST_CONNECTION]),
		getConnectionIncarnation: vi.fn(() => 0),
		admitLeaveNoTraceRevision: vi.fn(async (_clusterUrl: string, expectedRevision: number, admit: () => unknown) =>
			expectedRevision === provider.connectionManager.policyRevision
				? { admitted: true, value: await Promise.resolve(admit()) }
				: { admitted: false }),
	};
	provider.getCurrentKustoConnectionForDispatch = vi.fn(() => TEST_CONNECTION);
	provider.kustoClient = {
		executeQueryCancelable: vi.fn(),
		getAccountPartition: vi.fn(() => 'partition-current'),
		getConnectionSessionGeneration: vi.fn(() => 0),
		waitForProviderAccountRefresh: vi.fn(async () => undefined),
	};
	provider.appendQueryMode = vi.fn((query: string) => query);
	provider.isControlCommand = vi.fn(() => false);
	provider.normalizeControlCommandForExecution = vi.fn((query: string) => normalizeControlCommandForExecution(query));
	provider.buildCacheDirective = vi.fn(() => '');
	provider.logQueryExecutionError = vi.fn();
	provider.formatQueryExecutionErrorForUser = vi.fn((error: unknown) => error instanceof Error ? error.message : String(error));
	provider.output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() };
	installKustoSectionExecutionApplication(provider);
	provider.kustoExecutionCoordinator.openSection('query_1', 'instance-query_1');
	provider.kustoExecutionCoordinator.adoptTarget({
		boxId: 'query_1', sectionInstanceId: 'instance-query_1', targetGeneration: 1,
		connectionId: TEST_CONNECTION.id, database: 'Samples', connectionRevision: 0,
		connectionIdentityKey: getKustoConnectionIdentityKey(TEST_CONNECTION.clusterUrl, TEST_CONNECTION.authorityId),
	});
	return provider;
}

class TestSqlLifecycle {
	private readonly registry: SqlEditorSessionRegistry;
	private readonly sectionInstances = new Map<string, string>();
	private readonly issuedOwners = new Map<string, SqlIssuedOwnerToken>();
	private assertAllowed: (boxId: string, owner: SqlResultOwner) => Promise<void>;
	readonly executionBroker: SqlExecutionBroker;

	constructor(
		context: vscode.ExtensionContext,
		sqlWorkbench: SqlWorkbenchService,
		queryRuns: QueryRunCoordinator,
		postMessage: (message: unknown) => boolean | PromiseLike<boolean>,
	) {
		this.registry = new SqlEditorSessionRegistry({ context, sqlWorkbench });
		this.assertAllowed = (boxId, owner) => this.registry.assertOwnerAllowed(boxId, owner);
		this.executionBroker = new SqlExecutionBroker({
			queryRuns,
			getOwnerToken: boxId => this.getOwnerToken(boxId),
			postMessage,
		});
	}

	startSession(): void {}

	disposeSubscriptions(): void {}

	dispose(): void {
		this.executionBroker.clear();
		this.registry.clear();
		this.sectionInstances.clear();
		this.issuedOwners.clear();
	}

	openSection(boxId: string, sectionInstanceId: string): void {
		this.sectionInstances.set(boxId, sectionInstanceId);
	}

	getSectionInstanceId(boxId: string): string | undefined {
		return this.sectionInstances.get(boxId);
	}

	isSectionCurrent(boxId: string, sectionInstanceId: string): boolean {
		return this.sectionInstances.get(boxId) === sectionInstanceId;
	}

	adoptTarget(
		boxId: string,
		sectionInstanceId: string,
		connectionId: string,
		database: string | undefined,
		generation: number,
	): boolean {
		if (!this.isSectionCurrent(boxId, sectionInstanceId)) return false;
		return this.registry.adoptTarget(boxId, connectionId, database, generation, () => {
			this.executionBroker.supersede(boxId);
			this.issuedOwners.delete(boxId);
		}) !== 'rejected';
	}

	retireTarget(boxId: string, sectionInstanceId: string, generation: number): boolean {
		if (!this.isSectionCurrent(boxId, sectionInstanceId)) return false;
		return this.registry.retireTarget(boxId, generation, () => {
			this.executionBroker.supersede(boxId);
			this.issuedOwners.delete(boxId);
		}) !== 'rejected';
	}

	setTarget(
		boxId: string,
		connectionId: string,
		database: string,
		generation: number,
		ownerToken?: string,
	): void {
		const result = this.registry.adoptTarget(boxId, connectionId, database, generation, () => {
			this.executionBroker.supersede(boxId);
			this.issuedOwners.delete(boxId);
		});
		if (result === 'rejected') throw new Error(`Unable to set SQL target for ${boxId}.`);
		if (!ownerToken) return;
		const owner = this.registry.getOwner(boxId);
		if (!owner) throw new Error(`Unable to resolve SQL owner for ${boxId}.`);
		this.issuedOwners.set(boxId, { token: ownerToken, owner });
	}

	removeTarget(boxId: string): SqlEditorTarget | undefined {
		this.executionBroker.supersede(boxId);
		this.issuedOwners.delete(boxId);
		return this.registry.removeTarget(boxId);
	}

	getTarget(boxId: string): SqlEditorTarget | undefined {
		return this.registry.getTarget(boxId);
	}

	getGeneration(boxId: string): number {
		return this.registry.getGeneration(boxId);
	}

	isTargetCurrent(boxId: string, connectionId: string, database: string | undefined, generation: number): boolean {
		return this.registry.isTargetCurrent(boxId, connectionId, database, generation);
	}

	getResultOwner(boxId: string): SqlResultOwner | undefined {
		return this.registry.getOwner(boxId);
	}

	getCanonicalResultOwner(boxId: string): Promise<SqlResultOwner | undefined> {
		return this.registry.getCanonicalOwner(boxId);
	}

	dispatchResultOwnerAllowed<T>(boxId: string, owner: SqlResultOwner, dispatch: () => T | PromiseLike<T>): Promise<T> {
		return this.registry.dispatchOwnerAllowed(boxId, owner, dispatch);
	}

	dispatchResultOwnerProtection<T>(
		boxId: string,
		owner: SqlResultOwner,
		expectedProtected: boolean,
		dispatch: () => T | PromiseLike<T>,
	): Promise<T> {
		return this.registry.dispatchOwnerProtection(boxId, owner, expectedProtected, dispatch);
	}

	assertResultOwnerAllowed(boxId: string, owner: SqlResultOwner): Promise<void> {
		return this.assertAllowed(boxId, owner);
	}

	assertResultOwnerProtection(boxId: string, owner: SqlResultOwner, expectedProtected: boolean): Promise<void> {
		return this.registry.assertOwnerProtection(boxId, owner, expectedProtected);
	}

	async assertOwnerToken(boxId: string, token: string | undefined): Promise<SqlIssuedOwnerToken> {
		const issued = this.issuedOwners.get(boxId);
		if (!issued || !token || issued.token !== token) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		await this.assertAllowed(boxId, issued.owner);
		if (this.issuedOwners.get(boxId) !== issued) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		return issued;
	}

	async assertOwnerTokenProtection(
		boxId: string,
		token: string | undefined,
		expectedProtected: boolean,
	): Promise<SqlIssuedOwnerToken> {
		const issued = this.issuedOwners.get(boxId);
		if (!issued || !token || issued.token !== token) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		await this.registry.assertOwnerProtection(boxId, issued.owner, expectedProtected);
		if (this.issuedOwners.get(boxId) !== issued) {
			throw new Error('SQL section owner token changed. Reconnect and retry.');
		}
		return issued;
	}

	setOwnerAllowedAssertion(assertion: (boxId: string, owner: SqlResultOwner) => Promise<void>): void {
		this.assertAllowed = assertion;
	}

	getIssuedOwner(boxId: string): SqlIssuedOwnerToken | undefined {
		return this.issuedOwners.get(boxId);
	}

	getOwnerToken(boxId: string): string | undefined {
		const direct = this.issuedOwners.get(boxId)?.token;
		if (direct) return direct;
		const sourceBoxId = this.registry.getComparisonOwner(boxId)?.sourceBoxId;
		return sourceBoxId ? this.issuedOwners.get(sourceBoxId)?.token : undefined;
	}

	revokeToken(boxId: string): void {
		this.issuedOwners.delete(boxId);
	}

	getConnectionId(boxId: string): string | undefined {
		return this.registry.getConnectionId(boxId);
	}

	getFirstConnectionId(): string | undefined {
		return this.registry.listTargets()[0]?.connectionId;
	}

	getReadyToolOwner(boxId: string): SqlReadyToolOwner | undefined {
		const comparison = this.registry.getComparisonOwner(boxId);
		const sourceBoxId = comparison?.sourceBoxId ?? boxId;
		const issued = this.issuedOwners.get(boxId) ?? this.issuedOwners.get(sourceBoxId);
		const target = this.registry.getTarget(sourceBoxId);
		if (!issued || !target?.database || issued.owner.connectionId !== target.connectionId
			|| issued.owner.database !== target.database) return undefined;
		return {
			connectionId: target.connectionId,
			database: target.database,
			ownerToken: issued.token,
			generation: issued.owner.generation,
		};
	}

	getComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		return this.registry.getComparisonOwner(boxId);
	}

	setComparisonOwner(boxId: string, owner: SqlComparisonOwner): void {
		this.registry.setComparisonOwner(boxId, owner);
	}

	setOwnerToken(boxId: string, token: string): void {
		const owner = this.registry.getOwner(boxId);
		if (!owner) throw new Error(`Unable to resolve SQL owner for ${boxId}.`);
		this.issuedOwners.set(boxId, { token, owner });
	}

	removeComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		this.issuedOwners.delete(boxId);
		return this.registry.removeComparisonOwner(boxId);
	}

	listComparisonBoxIds(): readonly string[] {
		return this.registry.listComparisonOwners().map(({ boxId }) => boxId);
	}

	reconcileComparisonOwners(sections: unknown[]): void {
		this.registry.reconcileComparisonOwners(sections);
	}
}

function createSqlProviderHarness() {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.postMessage = vi.fn(async (message: any) => {
		if (message?.type === 'sqlComparisonAdmissionRollback') {
			queueMicrotask(() => void provider.handleWebviewMessage({
				type: 'sqlComparisonAdmissionAck', phase: 'rolledBack',
				requestId: message.requestId, sourceBoxId: message.sourceBoxId,
				comparisonBoxId: message.comparisonBoxId, accepted: true,
			} as any));
		}
		return true;
	});
	provider.output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	provider.context = {
		globalState: {
			get: vi.fn((key: string) => key === 'sql.auth.serverAccountMap' ? { 'server.example': 'account-a' } : undefined),
		},
	};
	provider.connectionManager = {
		getConnections: vi.fn(() => [TEST_CONNECTION]),
		runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
			clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
		})),
	};
	provider.kustoClient = { getAccountPartition: vi.fn(() => 'partition-current') };
	const connectionManager = {
		getConnection: vi.fn(() => ({ id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' })),
		getConnections: vi.fn(() => [{ id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' }]),
		assertConnectionCurrent: vi.fn(async () => undefined),
	};
	const client = { executeQueryCancelable: vi.fn(() => { throw new Error('Leave No Trace blocked'); }) };
	provider.sqlWorkbench = {
		connectionManager,
		client,
		leaveNoTracePolicy: {
			getRevocationGeneration: vi.fn(() => 0),
			assertProtectionMode: vi.fn(async () => undefined),
		},
		ready: vi.fn(async () => undefined),
		serverAccountMap: {
			refresh: vi.fn(async () => undefined),
			getAccountsByServer: vi.fn(() => provider.context.globalState.get('sql.auth.serverAccountMap') ?? {}),
		},
		isLeaveNoTraceConnection: vi.fn(() => false),
		assertSqlConnectionAllowed: vi.fn(async () => undefined),
		dispatchSqlConnectionAllowed: vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerAllowed: vi.fn(async (_connection: unknown, _principal: string, _revocation: number, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerProtection: vi.fn(async (_connection: unknown, _principal: string, _revocation: number, _protected: boolean, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connectionManager.getConnections(), connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		})),
		runWithSqlOwnerSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => await run({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connectionManager.getConnections(), connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		})),
		tryDispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => ({ acquired: true, value: await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connectionManager.getConnections(), connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		}) })),
		tryRunWithSqlOwnerSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => ({ acquired: true, value: await run({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connectionManager.getConnections(), connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		}) })),
		retrySqlOwnerSnapshotAcquisition: vi.fn(async (attempt: () => Promise<any>) => {
			const result = await attempt();
			if (!result.acquired) throw new Error('Unexpected SQL snapshot contention in test harness.');
			return result.value;
		}),
	};
	provider.sqlConnectionsProjectionApplication = {
		handleMessage: vi.fn(),
		refresh: vi.fn(async () => true),
		dispose: vi.fn(),
	};
	const sqlLifecycle = new TestSqlLifecycle(
		provider.context,
		provider.sqlWorkbench,
		new QueryRunCoordinator(),
		(message: unknown) => provider.postMessage(message),
	);
	sqlLifecycle.openSection('sql_1', 'instance-1');
	sqlLifecycle.setTarget('sql_1', 'sql-1', 'Db', 1, 'owner-token');
	provider.sqlLifecycle = sqlLifecycle;
	provider.persistedResultSanitizationApplication = new HostPersistedResultSanitizationApplicationHandler({
		connectionManager: provider.connectionManager,
		kustoClient: provider.kustoClient,
		sqlConnectionManager: provider.sqlWorkbench.connectionManager,
		sqlLifecycle: provider.sqlLifecycle,
		sqlWorkbench: provider.sqlWorkbench,
	});
	installSqlSchemaRequestApplication(provider);
	let executionSequence = 0;
	installSqlSectionExecutionApplication(provider);
	provider.executeSqlQueryFromWebview = (message: Record<string, unknown>) => provider.sqlSectionExecutionApplication.handleMessage({
		sectionInstanceId: 'instance-1',
		executionId: `test-execution-${++executionSequence}`,
		...message,
	}) ?? Promise.resolve();
	installComparisonPreparationApplication(provider);
	return provider;
}

function installSqlSchemaRequestApplication(
	provider: QueryEditorProvider & Record<string, any>,
): void {
	provider.sqlSchemaRequestApplication = new HostSqlSchemaRequestApplicationHandler({
		lifecycle: provider.sqlLifecycle,
		connectionManager: provider.sqlConnectionManager,
		getSchemaService: () => provider.sqlSchemaService,
		postMessage: (message: Record<string, unknown>) => provider.postMessage(message),
		output: provider.output,
	});
}

function installCopilotQueryWorkflowApplication(
	provider: QueryEditorProvider & Record<string, any>,
): void {
	provider.copilotQueryWorkflowApplication = new HostCopilotQueryWorkflowApplicationHandler({
		copilot: provider.copilot,
		sqlExecutionBroker: provider.sqlExecutionBroker,
		sqlLifecycle: provider.sqlLifecycle,
		getSqlConnectionManager: () => provider.sqlConnectionManager,
		getSqlSchemaService: () => provider.sqlSchemaService,
		getSqlClient: () => provider.sqlClient,
		postMessage: (message: unknown) => provider.postMessage(message),
	});
}

function installComparisonPreparationApplication(
	provider: QueryEditorProvider & Record<string, any>,
): void {
	provider.comparisonPreparationApplication = new HostComparisonPreparationApplicationHandler({
		sqlLifecycle: provider.sqlLifecycle,
		sqlExecutionBroker: provider.sqlExecutionBroker,
		sqlWorkbench: provider.sqlWorkbench,
		kustoExecutionCoordinator: {
			openSection: (...args: Parameters<KustoExecutionCoordinator['openSection']>) =>
				provider.kustoExecutionCoordinator.openSection(...args),
			adoptTarget: (...args: Parameters<KustoExecutionCoordinator['adoptTarget']>) =>
				provider.kustoExecutionCoordinator.adoptTarget(...args),
			getActive: (...args: Parameters<KustoExecutionCoordinator['getActive']>) =>
				provider.kustoExecutionCoordinator.getActive(...args),
			cancelExpected: (...args: Parameters<KustoExecutionCoordinator['cancelExpected']>) =>
				provider.kustoExecutionCoordinator.cancelExpected(...args),
		},
		postMessage: (message: unknown) => provider.postMessage(message),
		hasWebview: () => !!provider.panel,
		cancelCopilotQueryTarget: (sourceBoxId, targetBoxId, expectedSequence) =>
			provider.copilot?.cancelCopilotQueryTarget?.(sourceBoxId, targetBoxId, expectedSequence),
		cancelCopilotWriteQuery: (boxId, expectedSequence) =>
			provider.copilot?.cancelCopilotWriteQuery?.(boxId, expectedSequence),
		createRequestId: () => `comparison-test-${++comparisonRequestSequence}`,
	});
}

function installSqlSectionExecutionApplication(
	provider: QueryEditorProvider & Record<string, any>,
): void {
	provider.sqlSectionExecutionApplication = new HostSqlSectionExecutionApplicationHandler({
		sqlLifecycle: {
			isSectionCurrent: (...args) => provider.sqlLifecycle.isSectionCurrent(...args),
			assertOwnerToken: (...args) => provider.assertSqlOwnerToken(...args),
			assertOwnerTokenProtection: (...args) => provider.sqlLifecycle.assertOwnerTokenProtection(...args),
			assertResultOwnerAllowed: (...args) => provider.assertSqlResultOwnerAllowed(...args),
			assertResultOwnerProtection: (...args) => provider.sqlLifecycle.assertResultOwnerProtection(...args),
			dispatchResultOwnerAllowed: (...args) => provider.dispatchSqlResultOwnerAllowed(...args),
			dispatchResultOwnerProtection: (...args) => provider.sqlLifecycle.dispatchResultOwnerProtection(...args),
		},
		sqlExecutionBroker: provider.sqlExecutionBroker,
		sqlWorkbench: {
			isLeaveNoTraceConnection: connectionId =>
				provider.sqlWorkbench.isLeaveNoTraceConnection(connectionId),
		},
		connectionManager: {
			getConnection: connectionId => provider.sqlConnectionManager.getConnection(connectionId),
		},
		client: {
			executeQueryCancelable: (sqlConnection, database, query) =>
				provider.sqlClient.executeQueryCancelable(sqlConnection, database, query),
		},
		postMessage: message => provider.postMessage(message),
		refreshConnectionsData: () => provider.sqlConnectionsProjectionApplication.refresh(),
		output: provider.output,
	});
}

function comparisonPreparationState(provider: QueryEditorProvider & Record<string, any>): Record<string, any> {
	return provider.comparisonPreparationApplication;
}

describe('QueryEditorProvider cancellation orchestration', () => {
	it('stamps SQL comparison preparation with the SQL engine', async () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		provider.panel = {};
		provider.sqlLifecycle = {
			executionBroker: { supersede: vi.fn() },
			getConnectionId: vi.fn(() => 'sql-a'),
			getComparisonOwner: vi.fn(() => undefined),
			getSectionInstanceId: vi.fn(() => 'instance-sql-source'),
			getGeneration: vi.fn(() => 4),
			getTarget: vi.fn(() => ({ boxId: 'sql-source', connectionId: 'sql-a', database: 'Db', generation: 4 })),
		};
		provider.sqlWorkbench = { assertSqlConnectionAllowed: vi.fn(async () => undefined) };
		provider.postMessage = vi.fn();
		installComparisonPreparationApplication(provider);
		let cancel!: () => void;
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: (listener: () => void) => {
				cancel = listener;
				return { dispose() {} };
			},
		} as vscode.CancellationToken;

		const preparing = provider.ensureComparisonBoxInWebview('sql-source', 'SELECT 2', token);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql-source', query: 'SELECT 2', engine: 'sql',
			sourceSectionInstanceId: 'instance-sql-source', sourceTargetGeneration: 4,
		})));
		cancel();

		await expect(preparing).rejects.toThrow('Canceled');
	});

	it('rejects a derived SQL comparison as a nested comparison source before webview mutation', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-1', 'Db', 1);
		provider.sqlLifecycle.setComparisonOwner('comparison_1', {
			sourceBoxId: 'sql_1', connectionId: 'sql-1',
		});
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;

		await expect(provider.ensureComparisonBoxInWebview('comparison_1', 'SELECT 3', token))
			.rejects.toThrow('cannot be used as another comparison source');
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox',
		}));
	});

	it.each([
		['nonexistent comparison', 'comparison_ghost', 'instance-ghost', 'sql-1', 'Db', false],
		['self-referential comparison', 'sql_1', 'instance-1', 'sql-1', 'Db', false],
		['stale comparison incarnation', 'comparison_1', 'instance-stale', 'sql-1', 'Db', true],
		['wrong comparison target', 'comparison_1', 'instance-comparison', 'sql-other', 'OtherDb', true],
	] as const)('rejects %s before recording SQL comparison ownership', async (
		_label, comparisonBoxId, responseInstanceId, responseConnectionId, responseDatabase, registerComparison,
	) => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		if (registerComparison) {
			provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
			provider.sqlLifecycle.setTarget(
				'comparison_1', responseConnectionId === 'sql-other' ? 'sql-other' : 'sql-1',
				responseDatabase, 1,
			);
		}
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;
		const preparing = provider.ensureComparisonBoxInWebview('sql_1', 'SELECT 2', token);
		void preparing.catch(() => undefined);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql_1', engine: 'sql',
		})));
		const request = provider.postMessage.mock.calls.find((call: any[]) => call[0]?.type === 'ensureComparisonBox')![0];

		await provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId,
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: responseInstanceId, comparisonTargetGeneration: 1,
			comparisonConnectionId: responseConnectionId, comparisonDatabase: responseDatabase,
		} as any);

		await expect(preparing).rejects.toThrow(/missing, stale, self-referential, or mismatched/);
		expect(provider.sqlLifecycle.getComparisonOwner(comparisonBoxId)).toBeUndefined();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRollback', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId,
		});
	});

	it('rejects a late SQL comparison proposal after its host request expired', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};

		await provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: 'expired-request',
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_late',
		} as any);

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRollback', requestId: 'expired-request',
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_late',
		});
	});

	it('rejects SQL comparison preparation retargeted during deferred policy admission', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-1', 'Db', 1);
		const policy = deferred<void>();
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn()
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(() => policy.promise);
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;
		const preparing = provider.ensureComparisonBoxInWebview('sql_1', 'SELECT 2', token);
		void preparing.catch(() => undefined);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql_1', engine: 'sql',
		})));
		const request = provider.postMessage.mock.calls.find((call: any[]) => call[0]?.type === 'ensureComparisonBox')![0];
		const admission = provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: 'instance-comparison', comparisonTargetGeneration: 1,
			comparisonConnectionId: 'sql-1', comparisonDatabase: 'Db',
		} as any);
		await vi.waitFor(() => expect(provider.sqlWorkbench.assertSqlConnectionAllowed).toHaveBeenCalledTimes(2));
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();

		provider.sqlLifecycle.setTarget('comparison_1', 'sql-other', 'OtherDb', 2);
		policy.resolve(undefined);
		await admission;

		await expect(preparing).rejects.toThrow(/changed during policy admission/);
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
	});

	it('restores the prior comparison owner and token when reused admission is rejected', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		const previousOwner = { sourceBoxId: 'sql_1', connectionId: 'sql-1' };
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-1', 'Db', 1);
		provider.sqlLifecycle.setComparisonOwner('comparison_1', previousOwner);
		provider.sqlLifecycle.setOwnerToken('comparison_1', 'previous-token');
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('Policy rejected reuse'));
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;
		const preparing = provider.ensureComparisonBoxInWebview('sql_1', 'SELECT 3', token);
		void preparing.catch(() => undefined);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql_1', engine: 'sql',
		})));
		const request = provider.postMessage.mock.calls.find((call: any[]) => call[0]?.type === 'ensureComparisonBox')![0];

		await provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: 'instance-comparison', comparisonTargetGeneration: 1,
			comparisonConnectionId: 'sql-1', comparisonDatabase: 'Db',
		} as any);

		await expect(preparing).rejects.toThrow('Policy rejected reuse');
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBe(previousOwner);
		expect(provider.sqlLifecycle.getOwnerToken('comparison_1')).toBe('previous-token');
	});

	it('does not resolve SQL comparison preparation before exact webview admission acknowledgement', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		provider.postMessage.mockResolvedValue(true);
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-1', 'Db', 1);
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;
		let resolved = false;
		const preparing = provider.ensureComparisonBoxInWebview('sql_1', 'SELECT 2', token)
			.then(value => { resolved = true; return value; });
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql_1', engine: 'sql',
		})));
		const request = provider.postMessage.mock.calls.find((call: any[]) => call[0]?.type === 'ensureComparisonBox')![0];

		const response = provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: 'instance-comparison', comparisonTargetGeneration: 1,
			comparisonConnectionId: 'sql-1', comparisonDatabase: 'Db',
		} as any);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmission', requestId: request.requestId,
			comparisonBoxId: 'comparison_1', accepted: true,
		})));
		expect(resolved).toBe(false);

		await provider.handleWebviewMessage({
			type: 'sqlComparisonAdmissionAck', phase: 'staged', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1', accepted: true,
		} as any);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionCommit', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
		}));
		expect(resolved).toBe(false);
		await provider.handleWebviewMessage({
			type: 'sqlComparisonAdmissionAck', phase: 'committed', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1', accepted: true,
		} as any);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionFinalize', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
		}));
		expect(resolved).toBe(false);
		await provider.handleWebviewMessage({
			type: 'sqlComparisonAdmissionAck', phase: 'finalized', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1', accepted: true,
		} as any);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionComplete', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
		}));
		expect(resolved).toBe(false);
		await provider.handleWebviewMessage({
			type: 'sqlComparisonAdmissionAck', phase: 'completed', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1', accepted: true,
		} as any);
		await response;
		await expect(preparing).resolves.toEqual({ boxId: 'comparison_1' });
	});

	it('retries completion forward without rollback after a lost completion delivery', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-1', 'Db', 1);
		let completionAttempts = 0;
		provider.postMessage.mockImplementation(async (message: any) => {
			if (message?.type === 'sqlComparisonAdmissionComplete') {
				completionAttempts += 1;
				if (completionAttempts === 1) return false;
				queueMicrotask(() => void provider.handleWebviewMessage({
					type: 'sqlComparisonAdmissionAck', phase: 'completed',
					requestId: message.requestId, sourceBoxId: message.sourceBoxId,
					comparisonBoxId: message.comparisonBoxId, accepted: true,
				} as any));
			}
			return true;
		});
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;
		const preparing = provider.ensureComparisonBoxInWebview('sql_1', 'SELECT 2', token);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql_1', engine: 'sql',
		})));
		const request = provider.postMessage.mock.calls.find((call: any[]) => call[0]?.type === 'ensureComparisonBox')![0];
		const response = provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: 'instance-comparison', comparisonTargetGeneration: 1,
			comparisonConnectionId: 'sql-1', comparisonDatabase: 'Db',
		} as any);
		for (const phase of ['staged', 'committed', 'finalized'] as const) {
			const type = phase === 'staged' ? 'sqlComparisonAdmission'
				: phase === 'committed' ? 'sqlComparisonAdmissionCommit'
					: 'sqlComparisonAdmissionFinalize';
			await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
				type, requestId: request.requestId,
			})));
			await provider.handleWebviewMessage({
				type: 'sqlComparisonAdmissionAck', phase, requestId: request.requestId,
				sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1', accepted: true,
			} as any);
		}
		await response;

		await expect(preparing).resolves.toEqual({ boxId: 'comparison_1' });
		expect(completionAttempts).toBe(2);
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmissionRollback', requestId: request.requestId,
		}));
	});

	it('rejects SQL comparison preparation when commit delivery fails', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-1', 'Db', 1);
		provider.postMessage.mockImplementation(async (message: any) => {
			if (message?.type === 'sqlComparisonAdmissionRollback') {
				queueMicrotask(() => void provider.handleWebviewMessage({
					type: 'sqlComparisonAdmissionAck', phase: 'rolledBack',
					requestId: message.requestId, sourceBoxId: message.sourceBoxId,
					comparisonBoxId: message.comparisonBoxId, accepted: true,
				} as any));
			}
			return message?.type !== 'sqlComparisonAdmissionCommit';
		});
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;
		const preparing = provider.ensureComparisonBoxInWebview('sql_1', 'SELECT 2', token);
		void preparing.catch(() => undefined);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql_1', engine: 'sql',
		})));
		const request = provider.postMessage.mock.calls.find((call: any[]) => call[0]?.type === 'ensureComparisonBox')![0];
		const response = provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: 'instance-comparison', comparisonTargetGeneration: 1,
			comparisonConnectionId: 'sql-1', comparisonDatabase: 'Db',
		} as any);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmission', requestId: request.requestId, accepted: true,
		})));
		await provider.handleWebviewMessage({
			type: 'sqlComparisonAdmissionAck', phase: 'staged', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1', accepted: true,
		} as any);
		await response;

		await expect(preparing).rejects.toThrow('commit was not applied');
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRollback', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
		});
	});

	it('does not settle rejection or restore ownership before exact rollback acknowledgement', async () => {
		const provider = createSqlProviderHarness();
		provider.panel = {};
		provider.postMessage.mockResolvedValue(true);
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-other', 'OtherDb', 1);
		const token = {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose() {} }),
		} as vscode.CancellationToken;
		let settled = false;
		const preparing = provider.ensureComparisonBoxInWebview('sql_1', 'SELECT 2', token)
			.finally(() => { settled = true; });
		void preparing.catch(() => undefined);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'ensureComparisonBox', boxId: 'sql_1', engine: 'sql',
		})));
		const request = provider.postMessage.mock.calls.find((call: any[]) => call[0]?.type === 'ensureComparisonBox')![0];

		await provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: 'instance-comparison', comparisonTargetGeneration: 1,
			comparisonConnectionId: 'sql-other', comparisonDatabase: 'OtherDb',
		} as any);
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRollback', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
		}));
		expect(settled).toBe(false);
		expect(comparisonPreparationState(provider).pendingComparisonEnsureByRequestId.has(request.requestId)).toBe(true);

		await provider.handleWebviewMessage({
			type: 'sqlComparisonAdmissionAck', phase: 'rolledBack', requestId: request.requestId,
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1', accepted: true,
		} as any);
		await expect(preparing).rejects.toThrow(/missing, stale, self-referential, or mismatched/);
		expect(comparisonPreparationState(provider).pendingComparisonEnsureByRequestId.has(request.requestId)).toBe(false);
	});

	it('waits for webview application acknowledgement after transport accepts a Kusto publication', async () => {
		const provider = createProviderHarness();
		provider.postMessage = vi.fn(async () => true);

		let settled = false;
		const publishing = provider.kustoSectionExecutionApplication
			.postKustoPublication({ type: 'queryCancelled', executionId: 'ack-test' })
			.then(value => { settled = true; return value; });
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		const stage = provider.postMessage.mock.calls[0][0];
		await provider.handleWebviewMessage({ type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'staged', accepted: true });
		await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledTimes(2));
		await provider.handleWebviewMessage({ type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'applied', accepted: true });

		await expect(publishing).resolves.toBe(true);
	});

	it('fails a Kusto publication closed when applied and revoke acknowledgements are lost', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProviderHarness();
			provider.postMessage = vi.fn(async () => true);

			const publishing = provider.kustoSectionExecutionApplication
				.postKustoPublication({ type: 'queryResult', result: { rows: [['secret']] } });
			await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledOnce());
			const stage = provider.postMessage.mock.calls[0][0];
			await provider.handleWebviewMessage({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'staged', accepted: true,
			});
			await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledTimes(2));

			await vi.advanceTimersByTimeAsync(6_000);

			await expect(publishing).resolves.toBe(false);
			expect(provider.postMessage).toHaveBeenCalledWith({
				type: 'kustoPublicationRevoke', publicationId: stage.publicationId,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('treats revoke status as success when commit applied but its acknowledgement was lost', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProviderHarness();
			provider.postMessage = vi.fn(async (message: any) => {
				if (message.type === 'kustoPublicationStage') {
					queueMicrotask(() => void provider.handleWebviewMessage({
						type: 'kustoPublicationAck', publicationId: message.publicationId,
						phase: 'staged', accepted: true,
					}));
				}
				if (message.type === 'kustoPublicationRevoke') {
					queueMicrotask(() => void provider.handleWebviewMessage({
						type: 'kustoPublicationAck', publicationId: message.publicationId,
						phase: 'applied', accepted: true,
					}));
				}
				return true;
			});

			const publishing = provider.kustoSectionExecutionApplication
				.postKustoPublication({ type: 'queryResult', result: { rows: [['applied']] } });
			await vi.waitFor(() => expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'kustoPublicationCommit' })));
			await vi.advanceTimersByTimeAsync(5_000);

			await expect(publishing).resolves.toBe(true);
			expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'kustoPublicationRevoke' }));
		} finally {
			vi.useRealTimers();
		}
	});
	it('rejects an owner token removed while canonical validation is pending', async () => {
		const provider = createSqlProviderHarness();
		const validation = deferred<void>();
		const issued = provider.sqlLifecycle.getIssuedOwner('sql_1');
		const assertOwnerAllowed = vi.fn(() => validation.promise);
		provider.sqlLifecycle.setOwnerAllowedAssertion(assertOwnerAllowed);

		const assertion = provider.assertSqlOwnerToken('sql_1', 'owner-token');
		await vi.waitFor(() => expect(assertOwnerAllowed).toHaveBeenCalledOnce());
		provider.sqlLifecycle.revokeToken('sql_1');
		validation.resolve();

		await expect(assertion).rejects.toThrow('owner token changed');
		expect(issued).toBeTruthy();
	});

	it('posts a correlated generic terminal response when SQL owner preflight rejects', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.setOwnerAllowedAssertion(
			vi.fn(async () => { throw new Error('C:\\private\\sql-policy.lock failed'); }),
		);
		provider.copilot = {
			startCopilotWriteQuery: vi.fn(),
		};
		installCopilotQueryWorkflowApplication(provider);

		await provider.handleWebviewMessage({
			type: 'startCopilotWriteQuery', boxId: 'sql_1', flavor: 'sql', sqlOwnerToken: 'owner-token',
		} as any);

		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'copilotWriteQueryDone', boxId: 'sql_1', ok: false,
			message: 'SQL section owner changed. Retry the request.', ownerToken: 'owner-token',
		});
		expect(JSON.stringify(provider.postMessage.mock.calls)).not.toContain('sql-policy.lock');
		expect(provider.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
	});

	it('Stop during SQL owner preflight prevents service dispatch', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<void>();
		const assertOwnerAllowed = vi.fn(() => ownerValidation.promise);
		provider.sqlLifecycle.setOwnerAllowedAssertion(assertOwnerAllowed);
		provider.copilot = {
			startCopilotWriteQuery: vi.fn(),
			cancelCopilotWriteQuery: vi.fn(),
		};
		installCopilotQueryWorkflowApplication(provider);

		const start = provider.handleWebviewMessage({
			type: 'startCopilotWriteQuery', boxId: 'sql_1', flavor: 'sql', sqlOwnerToken: 'owner-token',
		} as any);
		await vi.waitFor(() => expect(assertOwnerAllowed).toHaveBeenCalledOnce());
		await provider.handleWebviewMessage({ type: 'cancelCopilotWriteQuery', boxId: 'sql_1' } as any);
		ownerValidation.resolve();
		await start;

		expect(provider.copilot.startCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1');
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'copilotWriteQueryDone', boxId: 'sql_1', ok: false, message: 'Canceled.', ownerToken: 'owner-token',
		});
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'SQL section owner changed. Retry the request.' }));
	});

	it('invalidates all SQL Copilot owners before panel disposal clears editor state', () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		let disposePanel!: () => void;
		const disposePanelSubscription = vi.fn();
		const rejectComparison = vi.fn();
		const comparisonTimer = setTimeout(() => undefined, 30_000);
		const panel = {
			onDidDispose: vi.fn((handler: () => void) => {
				disposePanel = handler;
				return { dispose: disposePanelSubscription };
			}),
		} as any;
		provider.panel = panel;
		provider._panelDisposed = false;
		provider.sqlLifecycle = {
			listComparisonBoxIds: () => ['comparison_1'],
			disposeSubscriptions: vi.fn(),
			dispose: vi.fn(),
		};
		provider._comparisonOwnerByBoxId = new Map([['kusto_comparison', { sourceBoxId: 'kusto_1' }]]);
		provider.copilot = { disposeKustoOwners: vi.fn(), invalidateSqlConnections: vi.fn() };
		provider.persistedResultSanitizationApplication = { dispose: vi.fn() };
		provider.dashboardApplication = { dispose: vi.fn() };
		provider.artifactCsvSaveApplication = { dispose: vi.fn() };
		provider.pythonExecutionApplication = { dispose: vi.fn() };
		provider.importedCsvSaveApplication = { dispose: vi.fn() };
		provider.querySharingApplication = { dispose: vi.fn() };
		provider.urlContentApplication = { dispose: vi.fn() };
		provider.controlCommandSyntaxApplication = { dispose: vi.fn() };
		provider.resourceUriApplication = { dispose: vi.fn() };
		provider.copilotContentOpenApplication = { dispose: vi.fn() };
		provider.informationNotificationApplication = { dispose: vi.fn() };
		provider.cachedValuesOpenApplication = { dispose: vi.fn() };
		provider.copilotAgentOpenApplication = { dispose: vi.fn() };
		provider.editorCursorStatusApplication = { dispose: vi.fn() };
		provider.editingPreferencesApplication = { dispose: vi.fn() };
		provider.kustoConnectionIntakeApplication = { dispose: vi.fn() };
		provider.kustoConnectionOnboardingApplication = { dispose: vi.fn() };
		provider.sqlConnectionOnboardingApplication = { dispose: vi.fn() };
		provider.sqlFavoritesApplication = { dispose: vi.fn() };
		provider.kustoFavoritesApplication = { dispose: vi.fn() };
		provider.sqlDatabaseDiscoveryApplication = { dispose: vi.fn() };
		provider.sqlSchemaRequestApplication = { dispose: vi.fn() };
		provider.kqlLanguageRequestApplication = { dispose: vi.fn() };
		provider.sqlLastSelectionApplication = { dispose: vi.fn() };
		provider.developmentNoteMutationApplication = { dispose: vi.fn() };
		provider.copilotInlineCompletionApplication = { dispose: vi.fn() };
		provider.copilotAvailabilityApplication = { dispose: vi.fn() };
		provider.copilotWriteQueryPreparationApplication = { dispose: vi.fn() };
		provider.copilotConversationClearApplication = { dispose: vi.fn() };
		provider.copilotHistoryRemovalApplication = { dispose: vi.fn() };
		provider.copilotChatFirstTimeApplication = { dispose: vi.fn() };
		provider.workbenchToolSessionApplication = { dispose: vi.fn() };
		provider.kustoConnectionBrowsingApplication = { dispose: vi.fn() };
		provider.kustoConnectionsProjectionApplication = { dispose: vi.fn() };
		provider.copilotQueryWorkflowApplication = { dispose: vi.fn() };
		provider.kustoSectionExecutionApplication = { dispose: vi.fn() };
		provider.comparisonPreparationApplication = { dispose: vi.fn(() => rejectComparison(new Error('Canceled'))) };
		provider.sqlSectionExecutionApplication = { dispose: vi.fn() };
		provider.sqlConnectionsProjectionApplication = { dispose: vi.fn() };
		provider.cancelAllRunningQueries = vi.fn();
		provider.kustoClient = { dispose: vi.fn() };
		provider.connection = { dispose: vi.fn() };
		provider.kustoConnectionLifecycle = { dispose: vi.fn() };
		provider.registerPanelDisposal(panel);
		disposePanel();
		provider.disposePanel(panel);
		clearTimeout(comparisonTimer);

		expect(provider.copilot.invalidateSqlConnections).toHaveBeenCalledWith([], ['comparison_1']);
		expect(provider.copilot.disposeKustoOwners).toHaveBeenCalledOnce();
		expect(provider.copilot.invalidateSqlConnections.mock.invocationCallOrder[0])
			.toBeLessThan(provider.sqlLifecycle.dispose.mock.invocationCallOrder[0]);
		expect(provider.kustoConnectionLifecycle.dispose).toHaveBeenCalledOnce();
		expect(provider.kustoSectionExecutionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.comparisonPreparationApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.sqlSectionExecutionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.sqlConnectionsProjectionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.persistedResultSanitizationApplication.dispose).toHaveBeenCalledOnce();
		expect(rejectComparison).toHaveBeenCalledWith(expect.objectContaining({ message: 'Canceled' }));
		expect(provider.dashboardApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.artifactCsvSaveApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.pythonExecutionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.importedCsvSaveApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.querySharingApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.urlContentApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.controlCommandSyntaxApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.resourceUriApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotContentOpenApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.informationNotificationApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.cachedValuesOpenApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotAgentOpenApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.editorCursorStatusApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.editingPreferencesApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.kustoConnectionIntakeApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.kustoConnectionOnboardingApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.sqlConnectionOnboardingApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.sqlFavoritesApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.kustoFavoritesApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.sqlDatabaseDiscoveryApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.sqlSchemaRequestApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.kqlLanguageRequestApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.sqlLastSelectionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.developmentNoteMutationApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotInlineCompletionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotAvailabilityApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotWriteQueryPreparationApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotConversationClearApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotHistoryRemovalApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotChatFirstTimeApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.workbenchToolSessionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.kustoConnectionBrowsingApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.kustoConnectionsProjectionApplication.dispose).toHaveBeenCalledOnce();
		expect(provider.copilotQueryWorkflowApplication.dispose).toHaveBeenCalledOnce();
		expect(provider._panelDisposed).toBe(true);
		expect(provider.panel).toBeUndefined();
		expect(disposePanelSubscription).toHaveBeenCalledOnce();
	});

	it('ignores policy messages after the panel webview getter is disposed', () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		provider._panelDisposed = true;
		provider.output = { warn: vi.fn() };
		provider.panel = Object.defineProperty({}, 'webview', {
			get: () => { throw new Error('Webview is disposed'); },
		});

		expect(() => provider.postMessage({ type: 'sqlLeaveNoTraceData', connectionIds: ['sql-1'] })).not.toThrow();
		expect(provider.output.warn).not.toHaveBeenCalled();
	});

	it('contains a rejected live webview post without an unhandled rejection', async () => {
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		provider._panelDisposed = false;
		provider.output = { warn: vi.fn() };
		provider.panel = { webview: { postMessage: vi.fn(() => Promise.reject(new Error('delivery failed'))) } };

		await expect(provider.postMessage({ type: 'test' })).resolves.toBe(false);
		expect(provider.output.warn).toHaveBeenCalledWith('[webview] postMessage failed: delivery failed');
	});

	it.each(['schema-result', 'schema-error'] as const)('suppresses %s details when schema owner admission rejects', async mode => {
		const provider = createSqlProviderHarness();
		provider._sqlSchemaService = {
			getSchema: vi.fn(async () => {
				if (mode === 'schema-error') throw new Error('SECRET_SCHEMA_ERROR');
				return {
					schema: { tables: ['SECRET_SCHEMA_TABLE'], columnsByTable: { SECRET_SCHEMA_TABLE: { SecretColumn: 'string' } } },
					fromCache: false,
				};
			}),
		};
		provider.sqlLifecycle.dispatchResultOwnerAllowed = vi.fn(async () => { throw new Error('owner invalid'); });

		await provider.sqlSchemaRequestApplication.handleMessage({
			type: 'prefetchSqlSchema', sqlConnectionId: 'sql-1', database: 'Db', boxId: 'sql_1',
			sectionInstanceId: 'instance-1', targetGeneration: 1, forceRefresh: false,
		});

		expect(JSON.stringify(provider.output.info.mock.calls)).not.toContain('SECRET_SCHEMA');
		expect(JSON.stringify(provider.output.error.mock.calls)).not.toContain('SECRET_SCHEMA');
		expect(provider.output.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sqlSchemaData' }));
	});

	it('admits only the newest same-target SQL schema request to cache and the real router', async () => {
		clearSqlSectionSessionsForTest();
		const provider = createSqlProviderHarness();
		const requestA = deferred<{ schema: { tables: string[]; columnsByTable: Record<string, Record<string, string>> }; fromCache: boolean }>();
		const requestB = deferred<{ schema: { tables: string[]; columnsByTable: Record<string, Record<string, string>> }; fromCache: boolean }>();
		const cachePublications: string[] = [];
		let schemaRequest = 0;
		provider._sqlSchemaService = {
			getSchema: vi.fn((_connection, _database, _forceRefresh, options?: { assertRequestCurrent?: () => void | Promise<void> }) => {
				const request = schemaRequest++ === 0 ? requestA : requestB;
				return request.promise.then(async result => {
					await options?.assertRequestCurrent?.();
					cachePublications.push(result.schema.tables[0]);
					return result;
				});
			}),
		};
		const session = {
			boxId: 'sql_1',
			instanceId: 'instance-1',
			targetGeneration: 1,
			ownerToken: '',
			stsReady: false,
			advanceTargetGeneration: vi.fn(() => 1),
			adoptHostGeneration: vi.fn(() => true),
			clearDatabaseRequest: vi.fn(),
			beginDatabaseRequest: vi.fn(() => true),
			acceptDatabaseResponse: vi.fn(() => true),
			completeDatabaseRequest: vi.fn(() => true),
			setStsReady: vi.fn(() => true),
			setExecutionOwner: vi.fn(() => true),
			requestSts: vi.fn(async () => null),
			admitOwnedMessage: vi.fn(() => true),
			resolveStsResponse: vi.fn(() => true),
			clear: vi.fn(),
		};
		registerSqlSectionSession(session);
		const setSchema = vi.fn();
		const section = {
			sqlSession: session,
			getSqlConnectionId: vi.fn(() => 'sql-1'),
			getDatabase: vi.fn(() => 'Db'),
			setSchemaInfo: vi.fn(),
		};
		const terminalMessages: Array<Record<string, unknown>> = [];
		provider.postMessage = vi.fn(async (message: Record<string, unknown>) => {
			if (message.type === 'sqlSchemaData') {
				terminalMessages.push(message);
				expect(routeSqlSectionMessage(message, {
					getSection: vi.fn(() => section),
					clearSchema: vi.fn(),
					setSchema,
					updateDatabases: vi.fn(),
					reportDatabasesError: vi.fn(),
					handleStsResponse: vi.fn(),
					handleStsDiagnostics: vi.fn(),
					clearPolicyBox: vi.fn(),
				})).toBe('handled');
			}
			return true;
		});

		const first = provider.handleWebviewMessage({
			type: 'prefetchSqlSchema', sqlConnectionId: 'sql-1', database: 'Db', boxId: 'sql_1',
			sectionInstanceId: 'instance-1', targetGeneration: 1, forceRefresh: true,
		});
		await vi.waitFor(() => expect(provider._sqlSchemaService.getSchema).toHaveBeenCalledTimes(1));
		const second = provider.handleWebviewMessage({
			type: 'prefetchSqlSchema', sqlConnectionId: 'sql-1', database: 'Db', boxId: 'sql_1',
			sectionInstanceId: 'instance-1', targetGeneration: 1, forceRefresh: true,
		});
		await vi.waitFor(() => expect(provider._sqlSchemaService.getSchema).toHaveBeenCalledTimes(2));

		requestB.resolve({ schema: { tables: ['SchemaB'], columnsByTable: {} }, fromCache: false });
		await second;
		requestA.resolve({ schema: { tables: ['SchemaA'], columnsByTable: {} }, fromCache: false });
		await first;

		expect(cachePublications).toEqual(['SchemaB']);
		expect(terminalMessages).toHaveLength(1);
		expect(terminalMessages[0]).toMatchObject({ schema: { tables: ['SchemaB'] } });
		expect(setSchema).toHaveBeenCalledOnce();
		expect(setSchema).toHaveBeenCalledWith('sql_1', expect.objectContaining({ tables: ['SchemaB'] }));
		clearSqlSectionSessionsForTest();
	});

	it('posts queryError when SQL setup fails synchronously', async () => {
		const provider = createSqlProviderHarness();

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'setup-failure',
		});

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'Leave No Trace blocked', boxId: 'sql_1', ownerToken: 'owner-token' }));
	});

	it('admits a protected SQL result through the execution-only owner mode', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[{ full: '42', display: '42' }]], metadata: {} }),
			cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 42 AS Value', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'protected-run',
		});

		expect(provider.sqlWorkbench.dispatchSqlOwnerProtection).toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'protected-run',
		}));
	});

	it('echoes direct SQL comparison source identity on the result terminal', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[2]], metadata: {} }),
			cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 2', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'comparison-direct',
			comparisonSourceBoxId: 'sql_source', comparisonSourceExecutionId: 'source-run-1',
		});

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', boxId: 'sql_1', executionId: 'comparison-direct',
			comparisonSourceBoxId: 'sql_source', comparisonSourceExecutionId: 'source-run-1',
		}));
	});

	it('keeps protected SQL error details out of the persistent output log', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.reject(new Error('SECRET_BACKEND_DETAIL')),
			cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT secret', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'protected-error',
		});

		expect(JSON.stringify([
			...provider.output.error.mock.calls,
			...provider.output.warn.mock.calls,
		])).not.toContain('SECRET_BACKEND_DETAIL');
		expect(provider.output.warn).toHaveBeenCalledWith(expect.stringContaining('details were not logged'));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'SECRET_BACKEND_DETAIL', executionId: 'protected-error',
		}));
	});

	it('retires manual SQL preflight after owner validation rejects', async () => {
		const provider = createSqlProviderHarness();
		provider.assertSqlOwnerToken = vi.fn(async () => { throw new Error('owner rejected'); });

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'rejected-preflight',
		});

		expect(provider.sqlExecutionBroker.cancelExpected('sql_1', 'rejected-preflight', false)).toBe(false);
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', boxId: 'sql_1', executionId: 'rejected-preflight', error: 'owner rejected',
		}));
	});

	it('does not dispatch SQL after Cancel during asynchronous owner validation', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<any>();
		provider.assertSqlOwnerToken = vi.fn(() => ownerValidation.promise);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn();

		const run = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'UPDATE dbo.T SET Value = 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'manual-cancel',
		});
		await Promise.resolve();
		await provider.handleWebviewMessage({ type: 'cancelSqlQuery', boxId: 'sql_1', sectionInstanceId: 'instance-1', executionId: 'manual-cancel' });
		ownerValidation.resolve({ token: 'owner-token', owner: provider.getSqlResultOwner('sql_1') });
		await run;

		expect(provider.sqlWorkbench.client.executeQueryCancelable).not.toHaveBeenCalled();
	});

	it('does not dispatch an older SQL run after Copilot supersedes its paused owner validation', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<any>();
		provider.assertSqlOwnerToken = vi.fn(() => ownerValidation.promise);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn();

		const oldRun = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT old', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'manual-old',
		});
		await vi.waitFor(() => expect(provider.assertSqlOwnerToken).toHaveBeenCalledOnce());
		provider.sqlExecutionBroker.supersede('sql_1', { notifyWebview: true });
		ownerValidation.resolve(provider.sqlLifecycle.getIssuedOwner('sql_1'));
		await oldRun;

		expect(provider.sqlWorkbench.client.executeQueryCancelable).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'manual-old',
		});
	});

	it('does not post a stale validation error after Cancel supersedes SQL preflight', async () => {
		const provider = createSqlProviderHarness();
		const ownerValidation = deferred<any>();
		provider.assertSqlOwnerToken = vi.fn(() => ownerValidation.promise);

		const run = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'stale-validation',
		});
		await Promise.resolve();
		await provider.handleWebviewMessage({ type: 'cancelSqlQuery', boxId: 'sql_1', sectionInstanceId: 'instance-1', executionId: 'stale-validation' });
		ownerValidation.reject(new Error('stale owner failure'));
		await run;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'stale owner failure' }));
	});

	it('does not post an older validation error after a newer SQL Run starts', async () => {
		const provider = createSqlProviderHarness();
		const firstValidation = deferred<any>();
		const issued = provider.sqlLifecycle.getIssuedOwner('sql_1');
		provider.assertSqlOwnerToken = vi.fn()
			.mockReturnValueOnce(firstValidation.promise)
			.mockResolvedValueOnce(issued);
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[2]], metadata: {} }),
			cancel: vi.fn(),
		}));

		const first = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await Promise.resolve();
		const second = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 2', queryMode: 'plain', ownerToken: 'owner-token',
		});
		firstValidation.reject(new Error('older validation failed'));
		await Promise.all([first, second]);

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'older validation failed' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
	});

	it('echoes the SQL tool execution ID on the accepted terminal result', async () => {
		const provider = createSqlProviderHarness();
		const owner = provider.getSqlResultOwner('sql_1');
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} }), cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'tool-execution-1', toolExecution: true,
			expectedOwner: {
				connectionId: owner.connectionId, database: owner.database, targetSignature: owner.targetSignature,
				principalFingerprint: owner.principalFingerprint, revocationGeneration: owner.revocationGeneration,
			},
		});

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'tool-execution-1',
		}));
	});

	it('rejects a changed SQL tool principal before query dispatch', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn();

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'UPDATE Sensitive SET Value = 1', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'tool-execution-drift', toolExecution: true,
			expectedOwner: {
				connectionId: 'sql-1', database: 'Db', targetSignature: provider.getSqlResultOwner('sql_1').targetSignature,
				principalFingerprint: 'stale-principal', revocationGeneration: 0,
			},
		});

		expect(provider.sqlWorkbench.client.executeQueryCancelable).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', executionId: 'tool-execution-drift', error: 'SQL tool execution owner changed before query dispatch.',
		}));
	});

	it('accepts the real manual SQL payload without a tool expected owner', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} }), cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT 1 AS Value', queryMode: 'plain', ownerToken: 'owner-token', executionId: 'sql-run-manual-1',
		});

		expect(provider.sqlWorkbench.client.executeQueryCancelable).toHaveBeenCalledOnce();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: 'sql-run-manual-1', result: expect.objectContaining({ rows: [[1]] }),
		}));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			error: 'SQL tool execution owner changed before query dispatch.',
		}));
	});

	it.each([
		['error', () => Promise.reject(new Error('SECRET_OBJECT_NAME'))],
		['cancellation', () => Promise.reject({ isCancelled: true })],
	] as const)('suppresses a stale SQL %s terminal when canonical owner admission rejects', async (_label, terminalPromise) => {
		const provider = createSqlProviderHarness();
		const admission = deferred<void>();
		provider.dispatchSqlResultOwnerAllowed = vi.fn(async () => {
			await admission.promise;
			throw new Error('Leave No Trace committed');
		});
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: terminalPromise(), cancel: vi.fn(),
		}));

		const run = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT * FROM SensitiveObject', queryMode: 'plain', ownerToken: 'owner-token', executionId: `manual-${_label}`,
		});
		await vi.waitFor(() => expect(provider.dispatchSqlResultOwnerAllowed).toHaveBeenCalledOnce());
		admission.resolve();
		await run;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryCancelled' }));
		expect(JSON.stringify(provider.postMessage.mock.calls)).not.toContain('SECRET_OBJECT_NAME');
		expect(JSON.stringify(provider.output.error.mock.calls)).not.toContain('SECRET_OBJECT_NAME');
		if (_label === 'error') expect(provider.output.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
	});

	it('notifies the exact tool execution before a newer SQL run supersedes it', async () => {
		const provider = createSqlProviderHarness();
		const toolCancel = vi.fn();
		const toolAdmission = provider.sqlExecutionBroker.reserve('sql_1', 'tool-execution-1');
		provider.sqlExecutionBroker.start(toolAdmission, () => ({ cancel: toolCancel }));
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [], rows: [], metadata: {} }), cancel: vi.fn(),
		}));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT newer', queryMode: 'plain', ownerToken: 'owner-token',
		});

		expect(toolCancel).toHaveBeenCalledOnce();
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'queryCancelled', boxId: 'sql_1', ownerToken: 'owner-token', executionId: 'tool-execution-1',
		});
	});

	it('suppresses a completed SQL result when the final Leave No Trace assertion fails', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		const cancel = vi.fn();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel }));
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(async () => { throw new Error('Leave No Trace blocked'); });

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError', error: 'Leave No Trace blocked', boxId: 'sql_1', ownerToken: 'owner-token' }));
	});

	it('suppresses a completed SQL result when canonical publication admission rejects', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({
			promise: Promise.resolve({ columns: [{ name: 'Secret' }], rows: [['blocked-row']], metadata: {} }),
			cancel: vi.fn(),
		}));
		provider.sqlWorkbench.dispatchSqlOwnerAllowed.mockRejectedValueOnce(new Error('Leave No Trace committed'));

		await provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db',
			query: 'SELECT Secret FROM T', queryMode: 'plain', ownerToken: 'owner-token',
		});

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', error: 'Leave No Trace committed', boxId: 'sql_1',
		}));
	});

	it('does not publish section rows after a same-ID target changes A to B and back to A', async () => {
		const provider = createProviderHarness();
		provider.getCurrentKustoConnectionForDispatch = QueryEditorProvider.prototype.getCurrentKustoConnectionForDispatch;
		let incarnation = 1;
		provider.connectionManager.getConnectionIncarnation.mockImplementation(() => incarnation);
		const result = deferred<ReturnType<typeof queryResult>>();
		provider.kustoClient.executeQueryCancelable.mockImplementationOnce((
			_connection: unknown, _database: string, _query: string, _key: string, options: any,
		) => {
			options.onDispatch({ ...kustoDispatchIdentity(0), connectionRevision: 1 });
			return {
				promise: result.promise, cancel: vi.fn(), clientActivityId: 'KW.execute_query;aba',
				getAccountPartition: () => 'partition-current',
			};
		});

		const task = provider.handleWebviewMessage(executeMessage('query_1'));
		await flushPromises();
		incarnation = 3;
		result.resolve(queryResult('stale-aba'));
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
	});

	it('does not dispatch a stale request after its same-ID physical connection was replaced', async () => {
		const provider = createProviderHarness();
		const original = { ...TEST_CONNECTION };
		const replacement = { ...TEST_CONNECTION, clusterUrl: 'https://replacement.kusto.windows.net', authorityId: 'organizations' };
		let current: KustoConnection = original;
		let incarnation = 1;
		provider.connectionManager.getConnections.mockImplementation(() => [current]);
		provider.connectionManager.getConnectionIncarnation.mockImplementation(() => incarnation);
		provider._kustoExecutionCoordinator = undefined;
		installKustoSectionExecutionApplication(provider);
		provider.kustoExecutionCoordinator.openSection('query_1', 'instance-query_1');
		provider.kustoExecutionCoordinator.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'instance-query_1', targetGeneration: 1,
			connectionId: original.id, database: 'Samples', connectionRevision: 1,
			connectionIdentityKey: getKustoConnectionIdentityKey(original.clusterUrl, original.authorityId),
		});
		current = replacement;
		incarnation = 2;

		await provider.handleWebviewMessage(executeMessage('query_1', 'print stale=1', 'stale-before-reservation'));

		expect(provider.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'stale-before-reservation', reason: 'retired',
		}));
	});

	it('rejects delayed SQL rows after the section switches target', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() }));

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		provider.sqlExecutionBroker.supersede('sql_1');
		provider.sqlLifecycle.setTarget('sql_1', 'sql-2', 'OtherDb', 2);
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
	});

	it('rejects delayed SQL rows after the saved connection target changes under the same ID', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() }));

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		provider.sqlWorkbench.connectionManager.getConnection.mockReturnValue({
			id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', port: 1434, authType: 'aad',
		});
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
	});

	it('rejects delayed SQL rows after the AAD principal rotates under the same ID', async () => {
		const provider = createSqlProviderHarness();
		const pending = deferred<any>();
		provider.sqlWorkbench.client.executeQueryCancelable = vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() }));

		const task = provider.executeSqlQueryFromWebview({
			type: 'executeSqlQuery', boxId: 'sql_1', sqlConnectionId: 'sql-1', database: 'Db', query: 'SELECT 1', queryMode: 'plain', ownerToken: 'owner-token',
		});
		await flushPromises();
		provider.context.globalState.get.mockImplementation((key: string) => key === 'sql.auth.serverAccountMap'
			? { 'server.example': 'account-b' }
			: undefined);
		pending.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} });
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryError' }));
	});

	it('strips persisted SQL results for a protected runtime connection', () => {
		const provider = createSqlProviderHarness();
		const state = {
			sections: [
				{ id: 'sql_1', type: 'sql', query: 'SELECT 1', principalFingerprint: 'principal-a', resultJson: '{"secret":true}' },
				{ id: 'chart_1', type: 'chart', dataSourceId: 'sql_1' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized).not.toBe(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
		expect(sanitized.sections[1]).toEqual(state.sections[1]);
	});

	it('removes an orphaned SQL principal fingerprint even when no result remains', () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		const state = { sections: [{
			id: 'sql_1', type: 'sql', query: 'SELECT 1', principalFingerprint: 'principal-a',
		}] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);

		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
	});

	it('strips restored SQL results by protected server before box ownership is known', () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.removeTarget('sql_1');
		const state = {
			sections: [{ id: 'sql_restored', type: 'sql', serverUrl: 'server.example', resultJson: '{"secret":true}' }],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
	});

	it('strips restored SQL results by protected connection hint after target-signature drift', () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.removeTarget('sql_1');
		const state = {
			sections: [{
				id: 'sql_restored', type: 'sql', connectionIdHint: 'sql-1',
				serverUrl: 'old.example', targetSignature: 'old-target', resultJson: '{"secret":true}',
			}],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
	});

	it('resolves a stale SQL hint through one exact target signature and strips protected rows', () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => true);
		const recreated = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const targetSignature = sqlConnectionTargetSignature(recreated);
		const state = { sections: [{
			id: 'sql_restored', type: 'sql', connectionIdHint: 'sql_deleted', targetSignature,
			serverUrl: recreated.serverUrl, resultJson: '{"secret":true}',
		}] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
	});

	it('fails closed when restored SQL result ownership is ambiguous', () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		provider.sqlWorkbench.connectionManager.getConnections = vi.fn(() => [connection, { ...connection, id: 'sql-2' }]);
		provider.sqlWorkbench.connectionManager.getConnection = vi.fn((id: string) => id === 'sql-1' ? connection : id === 'sql-2' ? { ...connection, id: 'sql-2' } : undefined);
		const targetSignature = sqlConnectionTargetSignature(connection);
		const state = { sections: [{
			id: 'sql_restored', type: 'sql', connectionIdHint: 'sql_deleted', targetSignature,
			resultJson: '{"secret":true}', resultArtifact: { version: 1, artifactId: 'sql-secret' },
		}] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('resultArtifact');
	});

	it('strips persisted comparison results by durable SQL source lineage', () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.removeTarget('sql_1');
		const state = {
			sections: [
				{ id: 'sql_source', type: 'sql', serverUrl: 'server.example', query: 'SELECT 1' },
				{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson: '{"secret":true}' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).toMatchObject({ comparisonSourceBoxId: 'sql_source', query: 'SELECT 2' });
	});

	it('strips SQL comparison rows when the persisted source owner cannot be resolved', () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.removeTarget('sql_1');
		const state = {
			sections: [
				{ id: 'sql_source', type: 'sql', connectionIdHint: 'missing', targetSignature: 'missing-target', serverUrl: 'unknown.example', query: 'SELECT 1' },
				{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson: '{"secret":true}' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
	});

	it('uses persisted SQL owner B instead of a stale same-box live owner A during reload', () => {
		const provider = createSqlProviderHarness();
		const ownerA = { id: 'sql-a', name: 'A', dialect: 'mssql', serverUrl: 'shared.example', authType: 'sql-login', username: 'UserA' };
		const ownerB = { id: 'sql-b', name: 'B', dialect: 'mssql', serverUrl: 'shared.example', authType: 'sql-login', username: 'UserB' };
		provider.sqlLifecycle.setTarget('sql_source', 'sql-a', 'Db', 1);
		provider.sqlWorkbench.connectionManager.getConnection = vi.fn((id: string) => id === 'sql-a' ? ownerA : id === 'sql-b' ? ownerB : undefined);
		provider.sqlWorkbench.connectionManager.getConnections = vi.fn(() => [ownerA, ownerB]);
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn((id: string) => id === 'sql-b');
		const state = { sections: [
			{
				id: 'sql_source', type: 'sql', connectionIdHint: 'sql-b',
				targetSignature: sqlConnectionTargetSignature(ownerB), serverUrl: 'shared.example',
				query: 'SELECT 1', resultJson: '{"owner":"B"}',
			},
			{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2', resultJson: '{"owner":"B-comparison"}' },
		] };

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
	});

	it('preserves persisted Kusto comparison results during SQL privacy sanitization', () => {
		const provider = createSqlProviderHarness();
		const state = {
			sections: [
				{ id: 'query_source', type: 'query', clusterUrl: 'https://cluster.kusto.windows.net', database: 'Db', query: 'T | count' },
				{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'query_source', query: 'T | summarize count()', resultJson: '{"value":2}' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[1]).toHaveProperty('resultJson', '{"value":2}');
		expect(provider.sqlLifecycle.getComparisonOwner('query_cmp')).toBeUndefined();
	});

	it('strips persisted Kusto comparison rows when the comparison target differs from its source', async () => {
		const provider = createSqlProviderHarness();
		provider.connectionManager.getConnections = vi.fn(() => [
			{ id: 'source', name: 'Source', clusterUrl: 'https://source.kusto.windows.net' },
			{ id: 'other', name: 'Other', clusterUrl: 'https://other.kusto.windows.net' },
		]);
		const state = { sections: [
			{ id: 'query_source', type: 'query', clusterUrl: 'https://source.kusto.windows.net', connectionIdHint: 'source', database: 'Db', query: 'T' },
			{ id: 'query_cmp', type: 'query', comparisonSourceBoxId: 'query_source', clusterUrl: 'https://other.kusto.windows.net', connectionIdHint: 'other', database: 'OtherDb', query: 'T | count', resultJson: '{"secret":true}', resultArtifact: { version: 1, artifactId: 'kusto-secret' } },
		] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).not.toHaveProperty('resultArtifact');
	});

	it('always strips legacy row-bearing result payloads without dropping future fields', async () => {
		const provider = createSqlProviderHarness();
		const state = { futureState: { keep: true }, sections: [
			{ id: 'query_1', type: 'query', query: 'T', result: { rows: [['kusto-secret']] }, futureQuerySetting: 1 },
			{ id: 'sql_1', type: 'sql', query: 'select 1', result: { rows: [['sql-secret']] }, futureSqlSetting: 2 },
			{ id: 'future_1', type: 'future-section', result: { opaque: true } },
		] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect((sanitized as any).futureState).toEqual({ keep: true });
		expect(sanitized.sections[0]).not.toHaveProperty('result');
		expect(sanitized.sections[0]).toHaveProperty('futureQuerySetting', 1);
		expect(sanitized.sections[1]).not.toHaveProperty('result');
		expect(sanitized.sections[1]).toHaveProperty('futureSqlSetting', 2);
		expect(sanitized.sections[2]).toHaveProperty('result', { opaque: true });
	});

	it('does not read SQL policy storage for pure Kusto, Markdown, and Chart state', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => { throw new Error('SQL policy unavailable'); });
		const state = {
			sections: [
				{ id: 'query_1', type: 'query', query: 'T | count' },
				{ id: 'markdown_1', type: 'markdown', text: 'Notes' },
				{ id: 'chart_1', type: 'chart', dataSourceId: 'query_1' },
			],
		};

		await expect(provider.sanitizeSqlLeaveNoTraceStateFresh(state)).resolves.toBe(state);
		expect(provider.sqlWorkbench.refreshLeaveNoTracePolicy).not.toHaveBeenCalled();
	});

	it('holds canonical SQL owner admission through publication and never exposes pre-admission rows', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const principal = sqlSchemaPrincipalFingerprintForPrincipal(connection, 'account-a')!;
		let lockHeld = false;
		provider.sqlWorkbench.tryRunWithSqlOwnerSnapshotLock = vi.fn(async (run: (snapshot: any) => unknown) => {
			lockHeld = true;
			try {
				return { acquired: true, value: await run({
					policy: { connectionIds: ['sql-1'], version: 2, globallyBlocked: false, revocationGenerations: { 'sql-1': 1 } },
					connections: [connection], connectionVersion: 1,
					accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
				}) };
			} finally {
				lockHeld = false;
			}
		});
		let releasePublish!: () => void;
		const publishGate = new Promise<void>(resolve => { releasePublish = resolve; });
		const state = { sections: [{
			id: 'sql_1', type: 'sql', connectionIdHint: 'sql-1',
			targetSignature: sqlConnectionTargetSignature(connection), principalFingerprint: principal,
			revocationGeneration: 0, resultJson: '{"secret":true}',
		}] };

		const publishing = provider.publishSqlLeaveNoTraceStateFresh(state, async (sanitized: typeof state) => {
			expect(lockHeld).toBe(true);
			expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
			await publishGate;
			expect(lockHeld).toBe(true);
			return 'published';
		});
		await vi.waitFor(() => expect(provider.sqlWorkbench.tryRunWithSqlOwnerSnapshotLock).toHaveBeenCalledOnce());
		expect(lockHeld).toBe(true);
		releasePublish();

		await expect(publishing).resolves.toBe('published');
		expect(lockHeld).toBe(false);
	});

	it('holds canonical Kusto policy admission through publication and strips newly protected rows', async () => {
		const provider = createSqlProviderHarness();
		let lockHeld = false;
		provider.connectionManager.runWithLeaveNoTraceSnapshotLock = vi.fn(async (run: (snapshot: any) => unknown) => {
			lockHeld = true;
			try {
				return await run({
					clusterKeys: [kustoClusterKey(TEST_CONNECTION.clusterUrl)], globallyBlocked: false, version: 2,
				});
			} finally {
				lockHeld = false;
			}
		});
		let releasePublish!: () => void;
		const publishGate = new Promise<void>(resolve => { releasePublish = resolve; });
		const state = { sections: [{
			id: 'query_1', type: 'query', clusterUrl: TEST_CONNECTION.clusterUrl,
			connectionIdHint: TEST_CONNECTION.id, database: 'Samples', resultJson: '{"secret":true}',
		}] };

		const publishing = provider.publishSqlLeaveNoTraceStateFresh(state, async sanitized => {
			expect(lockHeld).toBe(true);
			expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
			await publishGate;
			expect(lockHeld).toBe(true);
			return 'published';
		});
		await vi.waitFor(() => expect(provider.connectionManager.runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledOnce());
		expect(lockHeld).toBe(true);
		releasePublish();

		await expect(publishing).resolves.toBe('published');
		expect(lockHeld).toBe(false);
	});

	it('releases the Kusto policy lock while a canonical SQL snapshot lock is contended', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-cross-store-lock-contention-'));
		const values = new Map<string, unknown>([
			['kusto.connections', [TEST_CONNECTION]],
			['sql.connections', [{ id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' }]],
			['sql.auth.serverAccountMap', { 'server.example': 'account-a' }],
		]);
		const context = {
			globalStorageUri: { fsPath: directory }, logUri: { fsPath: path.join(directory, 'logs') }, subscriptions: [],
			globalState: {
				get: vi.fn((key: string) => values.get(key)),
				update: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
			},
			secrets: { get: vi.fn(async () => undefined), store: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
		} as any;
		const output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() } as any;
		const connectionManager = new ConnectionManager(context);
		const sqlWorkbench = new SqlWorkbenchService(context, output);
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		provider.connectionManager = connectionManager;
		provider.sqlWorkbench = sqlWorkbench;
		provider.kustoClient = { getAccountPartition: vi.fn(() => 'partition-current') };
		provider.sqlLifecycle = {
			reconcileComparisonOwners: vi.fn(),
			getComparisonOwner: vi.fn(() => undefined),
			getConnectionId: vi.fn((boxId: string) => boxId === 'sql_1' ? 'sql-1' : undefined),
		};
		provider.context = context;
		provider.persistedResultSanitizationApplication = new HostPersistedResultSanitizationApplicationHandler({
			connectionManager,
			kustoClient: provider.kustoClient,
			sqlConnectionManager: sqlWorkbench.connectionManager,
			sqlLifecycle: provider.sqlLifecycle,
			sqlWorkbench,
		});
		const releaseSqlLock = deferred<void>();
		const sqlLockEntered = deferred<void>();
		let sqlLock: Promise<void> | undefined;
		try {
			await Promise.all([connectionManager.refreshLeaveNoTracePolicy(), sqlWorkbench.ready()]);
			sqlLock = withSqlStateFileLock(
				path.join(directory, 'sql-server-account-map.v1.json.write'),
				async () => { sqlLockEntered.resolve(); await releaseSqlLock.promise; },
			);
			await sqlLockEntered.promise;
			const sqlConnection = sqlWorkbench.connectionManager.getConnection('sql-1')!;
			const principal = sqlSchemaPrincipalFingerprintForPrincipal(sqlConnection, 'account-a')!;
			const state = { sections: [{
				id: 'sql_1', type: 'sql', connectionIdHint: 'sql-1', serverUrl: 'server.example',
				targetSignature: sqlConnectionTargetSignature(sqlConnection), principalFingerprint: principal,
				resultJson: '{"secret":true}',
			}] };

			const sanitation = provider.sanitizeSqlLeaveNoTraceStateFresh(state);
			await vi.waitFor(() => expect(sqlWorkbench.serverAccountMap.getVersion()).toBeGreaterThanOrEqual(0));
			await expect(connectionManager.addLeaveNoTrace(TEST_CONNECTION.clusterUrl)).resolves.toBeUndefined();
			await expect(Promise.race([
				sanitation.then(() => 'settled', () => 'rejected'),
				Promise.resolve('pending'),
			])).resolves.toBe('pending');

			releaseSqlLock.resolve();
			await sqlLock;
			await expect(sanitation).resolves.toEqual(expect.objectContaining({ sections: expect.any(Array) }));
		} finally {
			releaseSqlLock.resolve();
			await sqlLock?.catch(() => undefined);
			await sqlWorkbench.dispose();
			connectionManager.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('fails closed for ownerless and ambiguous Kusto rows while preserving a unique public owner', async () => {
		const provider = createSqlProviderHarness();
		provider.connectionManager.getConnections = vi.fn(() => [
			TEST_CONNECTION,
			{ id: 'shared-a', name: 'Shared A', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'common' },
			{ id: 'shared-b', name: 'Shared B', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'organizations' },
		]);
		const state = { sections: [
			{ id: 'query_public', type: 'query', clusterUrl: TEST_CONNECTION.clusterUrl, connectionIdHint: TEST_CONNECTION.id, database: 'Samples', resultJson: '{"public":true}', kustoAccountPartition: 'partition-current', kustoLeaveNoTraceRevision: 0 },
			{ id: 'query_ownerless', type: 'query', query: 'print 1', resultJson: '{"ownerless":true}' },
			{ id: 'query_ambiguous', type: 'query', clusterUrl: 'https://shared.kusto.windows.net', database: 'Db', resultJson: '{"ambiguous":true}' },
		] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).toHaveProperty('resultJson', '{"public":true}');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[2]).not.toHaveProperty('resultJson');
	});

	it('treats sql_-prefixed Kusto connection and section IDs as Kusto ownership', async () => {
		const provider = createSqlProviderHarness();
		const connection = { id: 'sql_kusto_connection', name: 'Kusto', clusterUrl: 'https://opaque-id.kusto.windows.net' };
		provider.connectionManager.getConnections = vi.fn(() => [connection]);
		provider.connectionManager.runWithLeaveNoTraceSnapshotLock = vi.fn(async (run: (snapshot: any) => unknown) => await run({
			clusterKeys: [kustoClusterKey(connection.clusterUrl)], globallyBlocked: false, version: 2,
		}));
		const state = { sections: [
			{ id: 'sql_kusto_source', type: 'query', clusterUrl: connection.clusterUrl, connectionIdHint: connection.id, database: 'Db', resultJson: '{"source":true}' },
			{ id: 'sql_kusto_comparison', type: 'query', comparisonSourceBoxId: 'sql_kusto_source', clusterUrl: connection.clusterUrl, connectionIdHint: connection.id, database: 'Db', resultJson: '{"comparison":true}' },
		] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
		expect(provider.sqlWorkbench.dispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
	});

	it('strips orphaned comparison rows before SQL policy I/O during fresh save', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => { throw new Error('SQL policy unavailable'); });
		const state = { sections: [{
			id: 'query_orphan', type: 'query', comparisonSourceBoxId: 'missing_source',
			query: 'SELECT 2', resultJson: '{"secret":true}',
		}] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(provider.sqlWorkbench.refreshLeaveNoTracePolicy).not.toHaveBeenCalled();
	});

	it('strips unresolved opaque query rows without inferring SQL ownership from their connection ID', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => { throw new Error('SQL policy unavailable'); });
		const state = { sections: [{
			id: 'legacy_sql_cmp', type: 'query', connectionIdHint: 'sql_old',
			query: 'SELECT 2', resultJson: '{"secret":true}',
		}] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);
		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(provider.sqlWorkbench.dispatchSqlOwnerSnapshot).not.toHaveBeenCalled();
	});

	it('strips persisted AAD source and comparison rows after the canonical principal rotates', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const principalA = sqlSchemaPrincipalFingerprintForPrincipal(connection, 'account-a')!;
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => []);
		provider.sqlWorkbench.tryDispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: any) => unknown) => ({ acquired: true, value: await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: [connection], connectionVersion: 1,
			accountsByServer: { 'server.example': 'account-b' }, principalVersion: 2,
		}) }));
		const state = {
			sections: [
				{
					id: 'sql_1', type: 'sql', connectionIdHint: 'sql-1', serverUrl: 'server.example',
					targetSignature: sqlConnectionTargetSignature(connection), principalFingerprint: principalA,
					resultJson: '{"rows":[["source-a"]]}',
				},
				{
					id: 'comparison_1', type: 'query', comparisonSourceBoxId: 'sql_1',
					resultJson: '{"rows":[["comparison-a"]]}',
				},
			],
		};

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
		expect(sanitized.sections[1]).not.toHaveProperty('resultJson');
	});

	it('strips persisted SQL rows when the canonical connection target changed before the watcher refresh', async () => {
		const provider = createSqlProviderHarness();
		const connection = provider.sqlWorkbench.connectionManager.getConnection('sql-1');
		const principal = sqlSchemaPrincipalFingerprintForPrincipal(connection, 'account-a')!;
		provider.sqlWorkbench.isLeaveNoTraceConnection = vi.fn(() => false);
		provider.sqlWorkbench.refreshLeaveNoTracePolicy = vi.fn(async () => []);
		provider.sqlWorkbench.tryDispatchSqlOwnerSnapshot = vi.fn(async (dispatch: (snapshot: any) => unknown) => ({ acquired: true, value: await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: [{ ...connection, port: 1444 }], connectionVersion: 2,
			accountsByServer: { 'server.example': 'account-a' }, principalVersion: 1,
		}) }));
		const state = { sections: [{
			id: 'sql_1', type: 'sql', connectionIdHint: 'sql-1', serverUrl: 'server.example',
			targetSignature: sqlConnectionTargetSignature(connection), principalFingerprint: principal,
			resultJson: '{"rows":[["old-target"]]}',
		}] };

		const sanitized = await provider.sanitizeSqlLeaveNoTraceStateFresh(state);

		expect(sanitized.sections[0]).not.toHaveProperty('resultJson');
		expect(sanitized.sections[0]).not.toHaveProperty('principalFingerprint');
	});

	it('does not infer SQL ownership from opaque query connection IDs', () => {
		const provider = createSqlProviderHarness();
		const state = {
			sections: [
				{ id: 'legacy_sql_cmp', type: 'query', connectionIdHint: 'sql_legacy', query: 'SELECT 2', resultJson: '{"secret":true}' },
				{ id: 'kusto_query', type: 'query', connectionIdHint: 'kusto-1', query: 'T | count', resultJson: '{"count":1}' },
				{ id: 'markdown_1', type: 'markdown', text: 'Keep me' },
				{ id: 'chart_1', type: 'chart', chartType: 'bar' },
			],
		};

		const sanitized = provider.sanitizeSqlLeaveNoTraceState(state);
		expect(sanitized.sections[0]).toHaveProperty('resultJson', '{"secret":true}');
		expect(sanitized.sections[1]).toHaveProperty('resultJson', '{"count":1}');
		expect(sanitized.sections[2]).toMatchObject({ text: 'Keep me' });
		expect(sanitized.sections[3]).toMatchObject({ chartType: 'bar' });
	});

	it('cancels and removes a SQL comparison owner immediately when the webview removes it', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7 });
		provider.sqlLifecycle.setOwnerToken('comparison_1', 'token');
		const supersede = vi.spyOn(provider.sqlExecutionBroker, 'supersede');
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_1' } as any);

		expect(supersede).toHaveBeenCalledWith('comparison_1', { notifyWebview: true });
		expect(supersede).not.toHaveBeenCalledWith('sql_1', expect.anything());
		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison_1', 7);
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1', 7);
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.sqlLifecycle.getOwnerToken('comparison_1')).toBeUndefined();
	});

	it('ignores comparison removal events that are not tracked as SQL comparisons', async () => {
		const provider = createSqlProviderHarness();
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'kusto_comparison', sourceBoxId: 'kusto_1' } as any);

		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
	});

	it('cancels a tracked Kusto comparison and its exact Copilot sequence when removed', async () => {
		const provider = createSqlProviderHarness();
		comparisonPreparationState(provider).comparisonOwnerByBoxId.set('kusto_comparison', {
			sourceBoxId: 'kusto_1', copilotSequence: 9, comparisonRequestId: 'request-kusto',
		});
		provider._kustoExecutionCoordinator = { getActive: vi.fn(() => ({
			boxId: 'kusto_comparison', executionId: 'comparison-run', sectionInstanceId: 'comparison-instance',
			targetGeneration: 1, reservationSequence: 1,
		})), cancelExpected: vi.fn(() => true) };
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({
			type: 'sqlComparisonRemoved', boxId: 'kusto_comparison', sourceBoxId: 'kusto_1',
		} as any);

		expect(provider._kustoExecutionCoordinator.cancelExpected).toHaveBeenCalledWith(expect.objectContaining({
			boxId: 'kusto_comparison', executionId: 'comparison-run',
		}));
		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('kusto_1', 'kusto_comparison', 9);
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('kusto_1', 9);
		expect(comparisonPreparationState(provider).comparisonOwnerByBoxId.has('kusto_comparison')).toBe(false);
	});

	it('tombstones a SQL comparison but rejects a mismatched source cancellation', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7 });
		provider.sqlLifecycle.setOwnerToken('comparison_1', 'token');
		const supersede = vi.spyOn(provider.sqlExecutionBroker, 'supersede');
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_new' } as any);

		expect(supersede).toHaveBeenCalledWith('comparison_1', { notifyWebview: true });
		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison_1', 7);
		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.sqlLifecycle.getOwnerToken('comparison_1')).toBeUndefined();
	});

	it('tombstones a SQL comparison but rejects whole-sequence cancellation when the source is omitted', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7 });
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1' } as any);

		expect(provider.copilot.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison_1', 7);
		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
	});

	it('does not cancel newer source work for a restored comparison without a live sequence', async () => {
		const provider = createSqlProviderHarness();
		provider.sqlLifecycle.setComparisonOwner('comparison_1', { sourceBoxId: 'sql_1', connectionId: 'sql-1' });
		provider.copilot = { cancelCopilotWriteQuery: vi.fn() };

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_1' } as any);

		expect(provider.copilot.cancelCopilotWriteQuery).not.toHaveBeenCalled();
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
	});

	it('preserves a live comparison sequence while rebuilding owners from persisted state', () => {
		const provider = createSqlProviderHarness();
		const liveOwner = { sourceBoxId: 'sql_1', connectionId: 'sql-1', copilotSequence: 7, comparisonRequestId: 'request-1' };
		provider.sqlLifecycle.setComparisonOwner('comparison_1', liveOwner);

		provider.sqlLifecycle.reconcileComparisonOwners([
			{ id: 'sql_1', type: 'sql' },
			{ id: 'comparison_1', type: 'query', comparisonSourceBoxId: 'sql_1' },
		]);

		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBe(liveOwner);
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')?.copilotSequence).toBe(7);
	});

	it('tombstones a comparison removed while SQL policy admission is pending', async () => {
		const provider = createSqlProviderHarness();
		const policy = deferred<void>();
		const resolve = vi.fn();
		const reject = vi.fn();
		comparisonPreparationState(provider).pendingComparisonEnsureByRequestId = new Map([['request-1', {
			resolve,
			reject,
			timer: setTimeout(() => undefined, 10_000),
			sourceBoxId: 'sql_1',
			sqlConnectionId: 'sql-1',
			sqlSourceSectionInstanceId: 'instance-1',
			sqlSourceTargetGeneration: 1,
			sqlSourceDatabase: 'Db',
			copilotSequence: 7,
		}]]);
		provider.copilot = { cancelCopilotWriteQuery: vi.fn(), cancelCopilotQueryTarget: vi.fn() };
		provider.sqlWorkbench.assertSqlConnectionAllowed = vi.fn(() => policy.promise);
		provider.sqlLifecycle.openSection('comparison_1', 'instance-comparison');
		provider.sqlLifecycle.setTarget('comparison_1', 'sql-1', 'Db', 1);

		const ensured = provider.handleWebviewMessage({
			type: 'comparisonBoxEnsured', engine: 'sql', requestId: 'request-1',
			sourceBoxId: 'sql_1', comparisonBoxId: 'comparison_1',
			sourceSectionInstanceId: 'instance-1', sourceTargetGeneration: 1,
			comparisonSectionInstanceId: 'instance-comparison', comparisonTargetGeneration: 1,
			comparisonConnectionId: 'sql-1', comparisonDatabase: 'Db',
		} as any);
		await vi.waitFor(() => expect(provider.sqlWorkbench.assertSqlConnectionAllowed).toHaveBeenCalledOnce());
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();

		await provider.handleWebviewMessage({ type: 'sqlComparisonRemoved', boxId: 'comparison_1', sourceBoxId: 'sql_1' } as any);

		await vi.waitFor(() => expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Canceled' })));
		expect(comparisonPreparationState(provider).pendingComparisonEnsureByRequestId.has('request-1')).toBe(false);
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
		expect(provider.copilot.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1', 7);

		policy.resolve(undefined);
		await ensured;
		expect(resolve).not.toHaveBeenCalled();
		expect(provider.sqlLifecycle.getComparisonOwner('comparison_1')).toBeUndefined();
	});

	it('publishes a successful Kusto terminal with the initiating execution identity', async () => {
		const provider = createProviderHarness();
		const result = queryResult('success');
		const message = executeMessage('query_1', 'print label="success"', 'execution-success');
		provider.kustoClient.executeQueryCancelable.mockImplementationOnce(dispatchingKustoExecution({
			promise: Promise.resolve(result),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;success',
			getAccountPartition: () => 'partition-current',
		}));

		await provider.handleWebviewMessage(message);

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', result, boxId: 'query_1', executionId: 'execution-success',
			sectionInstanceId: 'instance-query_1', targetGeneration: 1,
		}));
	});

	it('does not revoke unrelated owners when a forgotten account maps to no connections', () => {
		const provider = createProviderHarness();
		provider.copilot = { invalidateKustoConnections: vi.fn() };
		provider.kustoConnectionsProjectionApplication = { refresh: vi.fn(async () => undefined) };
		const reservation = provider.kustoExecutionCoordinator.reserve({
			boxId: 'query_1', executionId: 'execution-unrelated', sectionInstanceId: 'instance-query_1',
			targetGeneration: 1, connectionId: TEST_CONNECTION.id, database: 'Samples', producer: 'manual',
		});
		expect(reservation).toBeTruthy();

		provider.handleKustoAuthPreferenceChange({
			connectionIds: [], reason: 'account-forgotten', accountId: 'unmapped-account',
		});

		expect(provider.kustoExecutionCoordinator.getActive('query_1')).toBe(reservation);
		expect(provider.copilot.invalidateKustoConnections).not.toHaveBeenCalled();
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kustoAuthIdentityChanged' }));
		expect(provider.kustoConnectionsProjectionApplication.refresh).toHaveBeenCalledOnce();
	});

	it('requires the exact Kusto execution-start acknowledgement before Copilot dispatch', async () => {
		const provider = createProviderHarness();
		const result = queryResult('copilot');
		provider.postMessage.mockImplementation((message: any) => {
			if (message?.type === 'kustoExecutionStarted') {
				queueMicrotask(() => void provider.handleWebviewMessage({
					type: 'kustoExecutionStartedAck', boxId: message.boxId, executionId: message.executionId,
					sectionInstanceId: message.sectionInstanceId, targetGeneration: message.targetGeneration,
					accepted: true,
				}));
			}
			return true;
		});
		provider.kustoClient.executeQueryCancelable.mockImplementationOnce(dispatchingKustoExecution({
			promise: Promise.resolve(result), cancel: vi.fn(), clientActivityId: 'KW.execute_query;copilot',
			getAccountPartition: () => 'partition-current',
		}));
		const target = provider.getKustoSectionExecutionTarget('query_1');

		const outcome = await provider.executeKustoSectionQuery({
			target, executionId: 'copilot-execution', producer: 'copilot', query: 'print x=1',
		});

		expect(outcome).toEqual({ status: 'success', executionId: 'copilot-execution', result });
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'kustoExecutionStarted', executionId: 'copilot-execution', producer: 'copilot',
			query: 'print x=1',
		}));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: 'copilot-execution', query: 'print x=1',
		}));
		expect(provider.postMessage.mock.invocationCallOrder[0])
			.toBeLessThan(provider.kustoClient.executeQueryCancelable.mock.invocationCallOrder[0]);
	});

	it('does not request a second start claim for a webview-preclaimed comparison run', async () => {
		const provider = createProviderHarness();
		const result = queryResult('comparison');
		provider.kustoClient.executeQueryCancelable.mockImplementationOnce(dispatchingKustoExecution({
			promise: Promise.resolve(result), cancel: vi.fn(), clientActivityId: 'KW.execute_query;comparison',
			getAccountPartition: () => 'partition-current',
		}));
		const target = provider.getKustoSectionExecutionTarget('query_1');
		const comparisonRun = {
			sourceBoxId: 'query_source', sourceExecutionId: 'source-execution', comparisonBoxId: 'query_1',
		};

		const outcome = await provider.executeKustoSectionQuery({
			target, executionId: 'comparison-execution', producer: 'comparison', comparisonRun,
			query: 'print optimized=1', preclaimedByWebview: true,
		});

		expect(outcome).toEqual({ status: 'success', executionId: 'comparison-execution', result });
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'kustoExecutionStarted' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', executionId: 'comparison-execution', comparisonRun,
		}));
	});

	it('does not dispatch Copilot execution when retarget rejects its exact start', async () => {
		const provider = createProviderHarness();
		provider.postMessage.mockImplementation((message: any) => {
			if (message?.type === 'kustoExecutionStarted') {
				queueMicrotask(() => {
					void provider.handleWebviewMessage({
						type: 'kustoSectionTarget', boxId: 'query_1', sectionInstanceId: 'instance-query_1',
						targetGeneration: 2, connectionId: TEST_CONNECTION.id, database: 'Other',
						connectionRevision: 0,
						connectionIdentityKey: getKustoConnectionIdentityKey(TEST_CONNECTION.clusterUrl, TEST_CONNECTION.authorityId),
					});
					void provider.handleWebviewMessage({
						type: 'kustoExecutionStartedAck', boxId: message.boxId, executionId: message.executionId,
						sectionInstanceId: message.sectionInstanceId, targetGeneration: message.targetGeneration,
						accepted: false,
					});
				});
			}
			return true;
		});
		const target = provider.getKustoSectionExecutionTarget('query_1');

		const outcome = await provider.executeKustoSectionQuery({
			target, executionId: 'retargeted-execution', producer: 'copilot', query: 'print x=1',
		});

		expect(outcome).toEqual({ status: 'superseded', executionId: 'retargeted-execution' });
		expect(provider.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'retargeted-execution', reason: 'retired',
		}));
	});

	it('settles a stale manual preclaim with an exact retired terminal before dispatch', async () => {
		const provider = createProviderHarness();
		const staleTarget = {
			engine: 'kusto' as const, boxId: 'query_1', sectionInstanceId: 'instance-query_1',
			targetGeneration: 0, connectionId: TEST_CONNECTION.id, database: 'Samples',
		};

		const outcome = await provider.executeKustoSectionQuery({
			target: staleTarget, executionId: 'manual-stale-preclaim', producer: 'manual', query: 'print x=1',
		});

		expect(outcome).toEqual({ status: 'superseded', executionId: 'manual-stale-preclaim' });
		expect(provider.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'manual-stale-preclaim', sectionInstanceId: 'instance-query_1',
			targetGeneration: 0, reason: 'retired', reservationSequence: expect.any(Number),
		}));
	});

	it('does not cancel a live owner when the same manual envelope is replayed', async () => {
		const provider = createProviderHarness();
		const target = provider.getKustoSectionExecutionTarget('query_1');
		const request = {
			...target, executionId: 'manual-duplicate', producer: 'manual' as const,
		};
		const reservation = provider.kustoExecutionCoordinator.reserve(request);

		const outcome = await provider.executeKustoSectionQuery({
			target, executionId: 'manual-duplicate', producer: 'manual', query: 'print x=1',
		});

		expect(outcome).toEqual({ status: 'superseded', executionId: 'manual-duplicate' });
		expect(provider.kustoExecutionCoordinator.getActive('query_1')).toBe(reservation);
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'manual-duplicate',
		}));
		expect(provider.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
	});

	it('times out an unacknowledged exact Copilot start before physical dispatch', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProviderHarness();
			provider.postMessage.mockReturnValue(true);
			const target = provider.getKustoSectionExecutionTarget('query_1');
			const task = provider.executeKustoSectionQuery({
				target, executionId: 'timed-out-execution', producer: 'copilot', query: 'print x=1',
			});

			await vi.advanceTimersByTimeAsync(5000);
			await expect(task).resolves.toEqual({ status: 'superseded', executionId: 'timed-out-execution' });
			expect(provider.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
			expect(provider.kustoExecutionCoordinator.getActive('query_1')).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not publish a successful Kusto result without authenticated dispatch identity', async () => {
		const provider = createProviderHarness();
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.resolve(queryResult('missing-dispatch')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;missing-dispatch',
			getAccountPartition: () => 'partition-current',
		});

		await provider.handleWebviewMessage(executeMessage('query_1'));

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', reason: 'cancelled',
		}));
	});

	it.each([
		['endpoint', { ...TEST_CONNECTION, clusterUrl: 'https://replacement.kusto.windows.net' }],
		['authority', { ...TEST_CONNECTION, authorityId: 'organizations' }],
	] as const)('does not publish section rows after a same-ID %s replacement', async (_identityPart, replacement) => {
		const provider = createProviderHarness();
		let currentConnection: KustoConnection = TEST_CONNECTION;
		provider.connectionManager.getConnections.mockImplementation(() => [currentConnection]);
		provider.getCurrentKustoConnectionForDispatch = QueryEditorProvider.prototype.getCurrentKustoConnectionForDispatch;
		const result = deferred<ReturnType<typeof queryResult>>();
		provider.kustoClient.executeQueryCancelable.mockImplementationOnce(dispatchingKustoExecution({
			promise: result.promise,
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;physical-replacement',
			getAccountPartition: () => 'partition-current',
		}));

		const task = provider.handleWebviewMessage(executeMessage('query_1'));
		await flushPromises();
		currentConnection = replacement;
		result.resolve(queryResult('stale-physical-target'));
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', reason: 'cancelled',
		}));
	});

	it('does not publish after the Leave No Trace revision advances during snapshot refresh', async () => {
		const provider = createProviderHarness();
		const snapshot = deferred<void>();
		let policyRevision = 1;
		provider.connectionManager.policyRevision = policyRevision;
		provider.refreshConnectionsData.mockImplementationOnce(async () => snapshot.promise);
		provider.kustoClient.executeQueryCancelable.mockImplementationOnce((
			_connection: unknown, _database: string, _query: string, _key: string, options: any,
		) => {
			options.onDispatch(kustoDispatchIdentity(policyRevision));
			return {
				promise: Promise.resolve(queryResult('old-policy')),
				cancel: vi.fn(),
				clientActivityId: 'KW.execute_query;old-policy',
				getAccountPartition: () => 'partition-current',
			};
		});

		const task = provider.handleWebviewMessage(executeMessage('query_1'));
		await flushPromises();
		policyRevision = 2;
		provider.connectionManager.policyRevision = policyRevision;
		snapshot.resolve();
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', reason: 'cancelled',
		}));
	});

	it('publishes a failed Kusto terminal with the initiating execution identity', async () => {
		const provider = createProviderHarness();
		const message = executeMessage('query_1', 'print missing_symbol', 'execution-error');
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.reject(new Error('semantic failure')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;error',
		});

		await provider.handleWebviewMessage(message);

		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryError', boxId: 'query_1', executionId: 'execution-error',
		}));
	});

	it('publishes cancellation with the exact execution identity requested by the webview', async () => {
		const provider = createProviderHarness();
		const pending = deferred<any>();
		const cancel = vi.fn();
		const message = executeMessage('query_1', 'print label="cancel"', 'execution-cancel');
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: pending.promise,
			cancel,
			clientActivityId: 'KW.execute_query;cancel',
		});

		const task = provider.handleWebviewMessage(message);
		await flushPromises();
		await provider.handleWebviewMessage({
			type: 'cancelQuery', boxId: 'query_1', executionId: 'execution-cancel',
			sectionInstanceId: 'instance-query_1', targetGeneration: 1,
		});

		expect(cancel).toHaveBeenCalledOnce();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', boxId: 'query_1', executionId: 'execution-cancel',
			sectionInstanceId: 'instance-query_1', targetGeneration: 1,
		}));

		pending.resolve(queryResult('late'));
		await task;
	});

	it('does not let a stale cancellation retire the newer execution in the same section', async () => {
		const provider = createProviderHarness();
		const currentCancel = vi.fn();
		provider._queryRunCoordinator = new QueryRunCoordinator();
		provider._queryRunCoordinator.register('query_1', {
			cancel: currentCancel,
			runSeq: 2,
			executionId: 'execution-new',
		});

		await provider.handleWebviewMessage({
			type: 'cancelQuery', boxId: 'query_1', executionId: 'execution-old',
			sectionInstanceId: 'instance-query_1', targetGeneration: 1,
		});

		expect(currentCancel).not.toHaveBeenCalled();
		expect(provider._queryRunCoordinator.get('query_1')).toMatchObject({
			executionId: 'execution-new',
		});
		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', executionId: 'execution-new',
		}));
	});

	it('explicit user cancel posts queryCancelled immediately and suppresses a late result', async () => {
		const provider = createProviderHarness();
		const pending = deferred<any>();
		const cancel = vi.fn();
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: pending.promise,
			cancel,
			clientActivityId: 'KW.execute_query;manual-cancel',
		});

		const message = executeMessage('query_1');
		const task = provider.handleWebviewMessage(message);
		await flushPromises();

		await provider.handleWebviewMessage({
			type: 'cancelQuery', boxId: 'query_1', executionId: message.executionId,
			sectionInstanceId: message.sectionInstanceId, targetGeneration: message.targetGeneration,
		});

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(provider.kustoExecutionCoordinator.getActive('query_1')).toBeUndefined();
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryCancelled', boxId: 'query_1', executionId: expect.any(String),
		}));

		pending.resolve(queryResult('late'));
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith({ type: 'queryResult', result: queryResult('late'), boxId: 'query_1' });
	});

	it('rerunning the same box silently cancels the old run and only posts the new result', async () => {
		const provider = createProviderHarness();
		const first = deferred<any>();
		const firstCancel = vi.fn();
		const secondCancel = vi.fn();
		const secondResult = queryResult('second');
		provider.kustoClient.executeQueryCancelable
			.mockImplementationOnce(dispatchingKustoExecution({ promise: first.promise, cancel: firstCancel, clientActivityId: 'KW.execute_query;first', getAccountPartition: () => 'partition-current' }))
			.mockImplementationOnce(dispatchingKustoExecution({ promise: Promise.resolve(secondResult), cancel: secondCancel, clientActivityId: 'KW.execute_query;second', getAccountPartition: () => 'partition-current' }));

		const firstTask = provider.handleWebviewMessage(executeMessage('query_1', 'print label="first"'));
		await flushPromises();

		await provider.handleWebviewMessage(executeMessage('query_1', 'print label="second"'));

		expect(firstCancel).toHaveBeenCalledTimes(1);
		expect(provider.postMessage).not.toHaveBeenCalledWith({ type: 'queryCancelled', boxId: 'query_1' });
		expect(provider.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'queryResult', result: secondResult, boxId: 'query_1', executionId: expect.any(String),
		}));

		first.resolve(queryResult('first'));
		await firstTask;

		const queryResults = provider.postMessage.mock.calls
			.map((call: unknown[]) => call[0] as any)
			.filter((message: any) => message?.type === 'queryResult');
		expect(queryResults).toHaveLength(1);
		expect(queryResults[0].result).toBe(secondResult);
	});

	it('does not publish a result superseded while its identity snapshot is pending', async () => {
		const provider = createProviderHarness();
		const snapshot = deferred<void>();
		const firstResult = queryResult('first');
		const secondResult = queryResult('second');
		provider.refreshConnectionsData.mockImplementationOnce(async () => snapshot.promise);
		provider.kustoClient.executeQueryCancelable
			.mockImplementationOnce(dispatchingKustoExecution({ promise: Promise.resolve(firstResult), cancel: vi.fn(), clientActivityId: 'KW.execute_query;first', getAccountPartition: () => 'partition-current' }))
			.mockImplementationOnce(dispatchingKustoExecution({ promise: Promise.resolve(secondResult), cancel: vi.fn(), clientActivityId: 'KW.execute_query;second', getAccountPartition: () => 'partition-current' }));

		const firstTask = provider.handleWebviewMessage(executeMessage('query_1', 'print label="first"'));
		await flushPromises();
		const secondTask = provider.handleWebviewMessage(executeMessage('query_1', 'print label="second"'));
		snapshot.resolve();
		await Promise.all([firstTask, secondTask]);

		const queryResults = provider.postMessage.mock.calls
			.map((call: unknown[]) => call[0] as any)
			.filter((message: any) => message?.type === 'queryResult');
		expect(queryResults).toEqual([expect.objectContaining({
			type: 'queryResult', result: secondResult, boxId: 'query_1', executionId: expect.any(String),
		})]);
	});

	it('does not publish account A rows after the snapshot adopts account B', async () => {
		const provider = createProviderHarness();
		const snapshot = deferred<void>();
		let currentPartition = 'partition-a';
		provider.kustoClient.getAccountPartition.mockImplementation(() => currentPartition);
		provider.refreshConnectionsData.mockImplementationOnce(async () => snapshot.promise);
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.resolve(queryResult('account-a')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;account-a',
			getAccountPartition: () => 'partition-a',
		});

		const task = provider.handleWebviewMessage(executeMessage('query_1'));
		await flushPromises();
		currentPartition = 'partition-b';
		snapshot.resolve();
		await task;

		expect(provider.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'queryResult' }));
	});

	it('ignores an exact cancel when no matching execution is registered', async () => {
		const provider = createProviderHarness();

		await provider.handleWebviewMessage({
			type: 'cancelQuery', boxId: 'query_missing', executionId: 'missing',
			sectionInstanceId: 'instance-query_missing', targetGeneration: 1,
		} as any);

		expect(provider.postMessage).not.toHaveBeenCalled();
	});

	it('strips leading comments only from the control-command payload sent to Kusto', async () => {
		const provider = createProviderHarness();
		const originalQuery = '  // create helper\r\n\t.create-or-update function F() { print x=1 }\n// trailing note';
		const message = executeMessage('query_1', originalQuery);
		message.cacheEnabled = true;
		message.queryMode = 'take100';
		provider.isControlCommand = vi.fn(() => true);
		provider.appendQueryMode = vi.fn((query: string) => query);
		provider.buildCacheDirective = vi.fn(() => 'set query_results_cache_max_age = time(1h);');
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.resolve(queryResult('ok')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;commented-control',
		});

		await provider.handleWebviewMessage(message);

		expect(provider.buildCacheDirective).not.toHaveBeenCalled();
		expect(provider.kustoClient.executeQueryCancelable).toHaveBeenCalledWith(
			TEST_CONNECTION,
			'Samples',
			'.create-or-update function F() { print x=1 }\n// trailing note',
			'query_1::conn-1',
			expect.objectContaining({ onDispatch: expect.any(Function) }),
		);
		expect(message.query).toBe(originalQuery);
	});

	it('uses real control-command detection to suppress cache and query-mode changes before stripping', async () => {
		const provider = createProviderHarness();
		const originalQuery = '  // create helper\r\n\t.create-or-update function F() { print x=1 }';
		const message = executeMessage('query_1', originalQuery);
		message.cacheEnabled = true;
		message.queryMode = 'take100';
		provider.isControlCommand = vi.fn((query: string) => isControlCommand(query));
		provider.appendQueryMode = vi.fn((query: string, mode?: string) => appendQueryMode(query, mode));
		provider.buildCacheDirective = vi.fn(() => 'set query_results_cache_max_age = time(1h);');
		provider.kustoClient.executeQueryCancelable.mockReturnValueOnce({
			promise: Promise.resolve(queryResult('ok')),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;real-control-detection',
		});

		await provider.handleWebviewMessage(message);

		expect(provider.isControlCommand).toHaveBeenCalledWith(originalQuery);
		expect(provider.buildCacheDirective).not.toHaveBeenCalled();
		expect(provider.kustoClient.executeQueryCancelable).toHaveBeenCalledWith(
			TEST_CONNECTION,
			'Samples',
			'.create-or-update function F() { print x=1 }',
			'query_1::conn-1',
			expect.objectContaining({ onDispatch: expect.any(Function) }),
		);
		expect(message.query).toBe(originalQuery);
	});
});