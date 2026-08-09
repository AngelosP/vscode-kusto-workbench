import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import type { SqlConnection } from '../../../src/host/sqlConnectionManager';
import {
	SqlEditorLifecycleCoordinator,
	type SqlEditorLanguageService,
	type SqlEditorLifecycleEffects,
} from '../../../src/host/sql/sqlEditorLifecycleCoordinator';
import type { StsDiagnosticsEvent, StsExpectedOwner } from '../../../src/host/sql/stsLanguageService';
import type { StsProcessManager } from '../../../src/host/sql/stsProcessManager';
import type { SqlWorkbenchService } from '../../../src/host/sql/sqlWorkbenchService';
import type { WorkbenchLogger } from '../../../src/host/workbenchLogger';
import { sqlConnectionTargetSignature } from '../../../src/shared/sqlConnectionIdentity';

const SQL_A: SqlConnection = {
	id: 'sql-a',
	name: 'SQL A',
	dialect: 'mssql',
	serverUrl: 'a.example',
	authType: 'sql-login',
	username: 'alice',
};

const SQL_B: SqlConnection = {
	id: 'sql-b',
	name: 'SQL B',
	dialect: 'mssql',
	serverUrl: 'b.example',
	authType: 'sql-login',
	username: 'bob',
};

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class FakeEvent<T> {
	private readonly listeners = new Set<(event: T) => unknown>();

	readonly event = (listener: (event: T) => unknown): vscode.Disposable => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	fire(event: T): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	get listenerCount(): number {
		return this.listeners.size;
	}
}

type FakeDocument = Readonly<{
	uri: string;
	text: string;
	connection: SqlConnection;
	owner?: StsExpectedOwner;
}>;

type OpenDetails = Readonly<{
	boxId: string;
	uri: string;
	text: string;
	connection: SqlConnection;
	owner?: StsExpectedOwner;
}>;

type ConnectDetails = Readonly<{
	boxId: string;
	connection: SqlConnection;
	database: string;
	owner?: StsExpectedOwner;
}>;

function ownersEqual(left: StsExpectedOwner | undefined, right: StsExpectedOwner | undefined): boolean {
	return !!left && !!right
		&& left.sectionInstanceId === right.sectionInstanceId
		&& left.connectionId === right.connectionId
		&& left.database === right.database
		&& left.targetSignature === right.targetSignature
		&& left.principalFingerprint === right.principalFingerprint
		&& left.revocationGeneration === right.revocationGeneration
		&& left.generation === right.generation;
}

class FakeLanguageService {
	readonly documents = new Map<string, FakeDocument>();
	readonly issuedUris: string[] = [];
	openHook?: (details: OpenDetails) => Promise<void>;
	connectHook?: (details: ConnectDetails) => Promise<void>;
	changeHook?: (boxId: string, text: string, sectionInstanceId?: string) => Promise<void>;
	closeOwnerProbe?: (boxId: string, owner: StsExpectedOwner) => void;
	private nextUri = 0;

	readonly onDiagnostics = vi.fn((_handler: (event: StsDiagnosticsEvent) => void) => undefined);
	readonly getCompletions = vi.fn(async () => ({ items: [] }));
	readonly getHover = vi.fn(async () => null);
	readonly getSignatureHelp = vi.fn(async () => null);
	readonly openDocument = vi.fn(async (
		boxId: string,
		text: string,
		connection: SqlConnection,
		owner?: StsExpectedOwner,
	): Promise<string> => {
		const uri = `file:///sql-test/${boxId}/${++this.nextUri}.sql`;
		this.issuedUris.push(uri);
		this.documents.set(boxId, { uri, text, connection, owner });
		await this.openHook?.({ boxId, uri, text, connection, owner });
		return uri;
	});
	readonly changeDocument = vi.fn(async (boxId: string, text: string, sectionInstanceId?: string): Promise<void> => {
		await this.changeHook?.(boxId, text, sectionInstanceId);
		const current = this.documents.get(boxId);
		if (current) this.documents.set(boxId, { ...current, text });
	});
	readonly closeDocumentForOwner = vi.fn((boxId: string, owner: StsExpectedOwner): boolean => {
		this.closeOwnerProbe?.(boxId, owner);
		const current = this.documents.get(boxId);
		if (!current || !ownersEqual(current.owner, owner)) return false;
		this.documents.delete(boxId);
		return true;
	});
	readonly closeDocumentUriForOwner = vi.fn((boxId: string, uri: string, owner: StsExpectedOwner): boolean => {
		const current = this.documents.get(boxId);
		if (!current || current.uri !== uri || !ownersEqual(current.owner, owner)) return false;
		this.documents.delete(boxId);
		return true;
	});
	readonly connectDocument = vi.fn(async (
		boxId: string,
		connection: SqlConnection,
		database: string,
		owner?: StsExpectedOwner,
	): Promise<void> => {
		await this.connectHook?.({ boxId, connection, database, owner });
	});
	readonly dispose = vi.fn(() => this.documents.clear());
}

type LifecycleMessage = Record<string, unknown>;
type LeaveNoTraceChange = Readonly<{
	connectionIds: string[];
	invalidatedConnectionIds: string[];
	disabledConnectionIds: string[];
}>;

type Harness = ReturnType<typeof createHarness>;

function createHarness(options: {
	connections?: readonly SqlConnection[];
	services?: readonly FakeLanguageService[];
	serviceFactory?: (processManager: StsProcessManager) => FakeLanguageService;
} = {}) {
	let connections = [...(options.connections ?? [SQL_A, SQL_B])];
	const messages: LifecycleMessage[] = [];
	const order: string[] = [];
	let messageObserver: ((message: LifecycleMessage) => void) | undefined;
	const connectionEvents = new FakeEvent<readonly SqlConnection[]>();
	const runtimeEvents = new FakeEvent<{ current?: StsProcessManager }>();
	const leaveNoTraceEvents = new FakeEvent<LeaveNoTraceChange>();
	const principalEvents = new FakeEvent<{
		connectionIds: string[];
		establishedConnectionIds: string[];
	}>();
	const protectedConnectionIds = new Set<string>();
	const revocationGenerations = new Map<string, number>();
	const accountsByServer: Record<string, string> = {
		'a.example': 'account-a',
		'b.example': 'account-b',
	};
	const processManager = {} as StsProcessManager;
	const services = [...(options.services ?? [new FakeLanguageService()])];
	let serviceIndex = 0;

	const context = {
		globalState: {
			get: <T>(key: string, fallback?: T): T | undefined => key === 'sql.auth.serverAccountMap'
				? accountsByServer as T
				: fallback,
			update: vi.fn(async () => undefined),
		},
	} as unknown as vscode.ExtensionContext;

	const connectionManager = {
		getConnection: vi.fn((connectionId: string) => connections.find(connection => connection.id === connectionId)),
		getConnections: vi.fn(() => connections),
		assertConnectionCurrent: vi.fn(async (captured: SqlConnection) => {
			const current = connections.find(connection => connection.id === captured.id);
			if (!current || sqlConnectionTargetSignature(current) !== sqlConnectionTargetSignature(captured)) {
				throw new Error('SQL connection changed.');
			}
		}),
		onDidChangeConnections: connectionEvents.event,
	};
	const leaveNoTracePolicy = {
		getRevocationGeneration: vi.fn((connectionId: string) => revocationGenerations.get(connectionId) ?? 0),
		assertProtectionMode: vi.fn(async (connectionId: string, expectedProtected: boolean, generation: number) => {
			if (protectedConnectionIds.has(connectionId) !== expectedProtected
				|| (revocationGenerations.get(connectionId) ?? 0) !== generation) {
				throw new Error('SQL protection mode changed.');
			}
		}),
	};
	const assertSqlConnectionAllowed = vi.fn(async (connectionId: string) => {
		if (protectedConnectionIds.has(connectionId)) throw new Error('Leave No Trace enabled.');
	});
	const dispatchSqlOwnerAllowed = vi.fn(async (
		_connection: SqlConnection,
		_principal: string,
		_revocation: number,
		dispatch: () => unknown,
	) => await dispatch());
	const dispatchSqlOwnerProtection = vi.fn(async (
		connection: SqlConnection,
		_principal: string,
		_revocation: number,
		expectedProtected: boolean,
		dispatch: () => unknown,
	) => {
		if (protectedConnectionIds.has(connection.id) !== expectedProtected) {
			throw new Error('SQL protection mode changed.');
		}
		return await dispatch();
	});
	const runtime = {
		getProcessManager: vi.fn(async () => processManager),
		onDidChangeProcessManager: runtimeEvents.event,
	};
	const sqlWorkbench = {
		connectionManager,
		runtime,
		leaveNoTracePolicy,
		serverAccountMap: {
			refresh: vi.fn(async () => undefined),
			getAccountsByServer: vi.fn(() => accountsByServer),
		},
		ready: vi.fn(async () => undefined),
		isLeaveNoTraceConnection: vi.fn((connectionId: string) => protectedConnectionIds.has(connectionId)),
		assertSqlConnectionAllowed,
		dispatchSqlConnectionAllowed: vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerAllowed,
		dispatchSqlOwnerProtection,
		dispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: unknown) => unknown) => await dispatch({
			policy: { connectionIds: [...protectedConnectionIds], revocationGenerations: Object.fromEntries(revocationGenerations) },
			connections,
			accountsByServer,
		})),
		runWithSqlOwnerSnapshotLock: vi.fn(async (dispatch: (snapshot: unknown) => unknown) => await dispatch({
			policy: { connectionIds: [...protectedConnectionIds], revocationGenerations: Object.fromEntries(revocationGenerations) },
			connections,
			accountsByServer,
		})),
		onDidChangeLeaveNoTrace: leaveNoTraceEvents.event,
		onDidChangeSqlPrincipals: principalEvents.event,
	} as unknown as SqlWorkbenchService;

	const effects = {
		postMessage: vi.fn((message: unknown) => {
			const record = message && typeof message === 'object'
				? message as LifecycleMessage
				: { value: message };
			messages.push(record);
			order.push(`message:${String(record.type || '')}`);
			messageObserver?.(record);
			return true;
		}),
		cancelCopilotWriteQuery: vi.fn((boxId: string) => order.push(`cancelCopilotWriteQuery:${boxId}`)),
		cancelCopilotQueryTarget: vi.fn((sourceBoxId: string, targetBoxId: string) => {
			order.push(`cancelCopilotQueryTarget:${sourceBoxId}:${targetBoxId}`);
		}),
		invalidateSqlCopilot: vi.fn(() => order.push('invalidateSqlCopilot')),
		rejectPendingComparisonEnsures: vi.fn((sourceBoxId: string) => order.push(`rejectPendingComparisonEnsures:${sourceBoxId}`)),
		invalidatePersistence: vi.fn(() => order.push('invalidatePersistence')),
		refreshConnectionsData: vi.fn(async () => {
			order.push('refreshConnectionsData');
			return true;
		}),
		prefetchSchema: vi.fn(async (connectionId: string, database: string, boxId: string) => {
			order.push(`prefetchSchema:${connectionId}:${database}:${boxId}`);
		}),
	};
	const output = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	const queryRuns = new QueryRunCoordinator();
	const createLanguageService = vi.fn((manager: StsProcessManager) => {
		const service = options.serviceFactory?.(manager)
			?? services[Math.min(serviceIndex, services.length - 1)];
		serviceIndex += 1;
		return service as unknown as SqlEditorLanguageService;
	});
	const coordinator = new SqlEditorLifecycleCoordinator({
		context,
		sqlWorkbench,
		queryRuns,
		output: output as unknown as WorkbenchLogger,
		effects: effects as unknown as SqlEditorLifecycleEffects,
		hasWebview: () => true,
		createLanguageService,
		createRequestId: () => 'database-request',
	});
	coordinator.startSession();

	return {
		coordinator,
		context,
		connectionManager,
		assertSqlConnectionAllowed,
		dispatchSqlOwnerAllowed,
		dispatchSqlOwnerProtection,
		sqlWorkbench,
		runtime,
		effects,
		output,
		messages,
		order,
		queryRuns,
		service: services[0],
		services,
		createLanguageService,
		protectedConnectionIds,
		revocationGenerations,
		connectionEvents,
		runtimeEvents,
		leaveNoTraceEvents,
		principalEvents,
		setMessageObserver(observer: ((message: LifecycleMessage) => void) | undefined) {
			messageObserver = observer;
		},
		setConnections(next: readonly SqlConnection[]) {
			connections = [...next];
			connectionEvents.fire(connections);
		},
		emitPrincipals(connectionIds: string[], establishedConnectionIds: string[] = []) {
			principalEvents.fire({ connectionIds, establishedConnectionIds });
		},
		emitLeaveNoTrace(change: LeaveNoTraceChange) {
			leaveNoTraceEvents.fire(change);
		},
	};
}

async function connectReady(
	harness: Harness,
	options: {
		boxId?: string;
		sectionInstanceId?: string;
		connectionId?: string;
		database?: string;
		generation?: number;
		text?: string;
	} = {},
): Promise<string> {
	const boxId = options.boxId ?? 'sql_1';
	const sectionInstanceId = options.sectionInstanceId ?? 'instance-1';
	harness.coordinator.openSection(boxId, sectionInstanceId);
	harness.coordinator.didOpen(boxId, sectionInstanceId, options.text ?? 'SELECT 1');
	await harness.coordinator.connect(
		boxId,
		sectionInstanceId,
		options.connectionId ?? SQL_A.id,
		options.database ?? 'DbA',
		options.generation ?? 1,
	);
	const token = harness.coordinator.getOwnerToken(boxId);
	if (!token) throw new Error(`Expected ${boxId} to have an issued owner token.`);
	return token;
}

function startExecution(harness: Harness, boxId: string, executionId: string, cancel: () => void): void {
	const admission = harness.coordinator.executionBroker.reserve(boxId, executionId);
	harness.coordinator.executionBroker.start(admission, () => ({ cancel }));
}

function clearMessages(harness: Harness): void {
	harness.messages.splice(0);
	harness.order.splice(0);
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe('SqlEditorLifecycleCoordinator', () => {
	it('preserves a retired generation tombstone across a same-instance reopen', () => {
		const harness = createHarness();
		const { coordinator } = harness;
		coordinator.openSection('sql_1', 'instance-1');
		expect(coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 1)).toBe(true);

		expect(coordinator.retireTarget('sql_1', 'instance-1', 2)).toBe(true);
		coordinator.openSection('sql_1', 'instance-1');

		expect(coordinator.getGeneration('sql_1')).toBe(2);
		expect(coordinator.getTarget('sql_1')).toBeUndefined();
		expect(coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 1)).toBe(false);
	});

	it('resets the tombstone for a genuinely new section incarnation', () => {
		const harness = createHarness();
		const { coordinator } = harness;
		coordinator.openSection('sql_1', 'instance-1');
		expect(coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 1)).toBe(true);

		coordinator.didClose('sql_1', 'instance-1');
		expect(coordinator.getGeneration('sql_1')).toBe(2);
		coordinator.openSection('sql_1', 'instance-2');

		expect(coordinator.getGeneration('sql_1')).toBe(0);
		expect(coordinator.adoptTarget('sql_1', 'instance-2', SQL_A.id, 'DbA', 1)).toBe(true);
		expect(coordinator.getTarget('sql_1')).toMatchObject({ connectionId: SQL_A.id, generation: 1 });
	});

	it('retires source and derived work when a live section incarnation is replaced', async () => {
		const harness = createHarness();
		const sourceCancel = vi.fn();
		const comparisonCancel = vi.fn();
		await connectReady(harness);
		harness.coordinator.setComparisonOwner('comparison-1', {
			sourceBoxId: 'sql_1',
			connectionId: SQL_A.id,
			copilotSequence: 7,
		});
		startExecution(harness, 'sql_1', 'source-execution', sourceCancel);
		startExecution(harness, 'comparison-1', 'comparison-execution', comparisonCancel);

		harness.coordinator.openSection('sql_1', 'instance-2');

		expect(sourceCancel).toHaveBeenCalledOnce();
		expect(comparisonCancel).toHaveBeenCalledOnce();
		expect(harness.effects.rejectPendingComparisonEnsures).toHaveBeenCalledWith('sql_1');
		expect(harness.effects.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1');
		expect(harness.effects.cancelCopilotWriteQuery).toHaveBeenCalledWith('comparison-1');
		expect(harness.effects.cancelCopilotQueryTarget).toHaveBeenCalledWith('sql_1', 'comparison-1', 7);
		expect(harness.coordinator.getComparisonOwner('comparison-1')).toBeUndefined();
		expect(harness.coordinator.listComparisonBoxIds()).toEqual([]);
		expect(harness.coordinator.getTarget('sql_1')).toBeUndefined();
		expect(harness.coordinator.getGeneration('sql_1')).toBe(0);
	});

	it('exact-closes the old STS owner before committing a replacement target', async () => {
		const harness = createHarness();
		const oldToken = await connectReady(harness);
		const oldOwner = harness.coordinator.getResultOwner('sql_1');
		let closeObservation: {
			owner: StsExpectedOwner;
			target: ReturnType<SqlEditorLifecycleCoordinator['getTarget']>;
			token: string | undefined;
		} | undefined;
		harness.service.closeOwnerProbe = (_boxId, owner) => {
			closeObservation = {
				owner,
				target: harness.coordinator.getTarget('sql_1'),
				token: harness.coordinator.getOwnerToken('sql_1'),
			};
		};

		await harness.coordinator.connect('sql_1', 'instance-1', SQL_B.id, 'DbB', 2);

		expect(closeObservation).toEqual({
			owner: { ...oldOwner, sectionInstanceId: 'instance-1' },
			target: { boxId: 'sql_1', connectionId: SQL_A.id, database: 'DbA', generation: 1 },
			token: oldToken,
		});
		expect(harness.coordinator.getTarget('sql_1')).toEqual({
			boxId: 'sql_1', connectionId: SQL_B.id, database: 'DbB', generation: 2,
		});
		expect(harness.service.documents.get('sql_1')?.owner).toMatchObject({ connectionId: SQL_B.id, generation: 2 });
	});

	it('section close prunes only its comparisons and keeps didClose cancellation semantics distinct', () => {
		const harness = createHarness();
		const { coordinator } = harness;
		coordinator.openSection('sql_1', 'instance-1');
		coordinator.openSection('sql_2', 'instance-2');
		expect(coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 1)).toBe(true);
		expect(coordinator.adoptTarget('sql_2', 'instance-2', SQL_B.id, 'DbB', 1)).toBe(true);
		coordinator.setComparisonOwner('comparison-a', {
			sourceBoxId: 'sql_1', connectionId: SQL_A.id, copilotSequence: 10,
		});
		coordinator.setComparisonOwner('comparison-b', {
			sourceBoxId: 'sql_2', connectionId: SQL_B.id, copilotSequence: 20,
		});

		coordinator.didClose('sql_1', 'instance-1');

		expect(coordinator.getComparisonOwner('comparison-a')).toBeUndefined();
		expect(coordinator.getComparisonOwner('comparison-b')).toEqual({
			sourceBoxId: 'sql_2', connectionId: SQL_B.id, copilotSequence: 20,
		});
		expect(coordinator.listComparisonBoxIds()).toEqual(['comparison-b']);
		expect(harness.effects.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_1');
		expect(harness.effects.cancelCopilotWriteQuery).toHaveBeenCalledWith('comparison-a');
		expect(harness.effects.cancelCopilotWriteQuery).not.toHaveBeenCalledWith('comparison-b');
		expect(harness.effects.rejectPendingComparisonEnsures).not.toHaveBeenCalled();
		expect(harness.effects.cancelCopilotQueryTarget).not.toHaveBeenCalled();
	});

	it('closing a SQL comparison removes its own owner without retiring the source', () => {
		const harness = createHarness();
		const { coordinator } = harness;
		coordinator.openSection('sql_source', 'instance-source');
		coordinator.openSection('sql_comparison', 'instance-comparison');
		expect(coordinator.adoptTarget('sql_source', 'instance-source', SQL_A.id, 'DbA', 1)).toBe(true);
		expect(coordinator.adoptTarget('sql_comparison', 'instance-comparison', SQL_A.id, 'DbA', 1)).toBe(true);
		coordinator.setComparisonOwner('sql_comparison', {
			sourceBoxId: 'sql_source', connectionId: SQL_A.id, copilotSequence: 10,
		});

		coordinator.didClose('sql_comparison', 'instance-comparison');

		expect(coordinator.getComparisonOwner('sql_comparison')).toBeUndefined();
		expect(coordinator.getTarget('sql_source')).toEqual({
			boxId: 'sql_source', connectionId: SQL_A.id, database: 'DbA', generation: 1,
		});
		expect(harness.effects.cancelCopilotWriteQuery).toHaveBeenCalledWith('sql_comparison');
		expect(harness.effects.cancelCopilotWriteQuery).not.toHaveBeenCalledWith('sql_source');
	});

	it.each(['retarget', 'retire'] as const)('revokes a SQL comparison owner when its direct target is %s', action => {
		const harness = createHarness();
		const { coordinator } = harness;
		coordinator.openSection('sql_source', 'instance-source');
		coordinator.openSection('sql_comparison', 'instance-comparison');
		expect(coordinator.adoptTarget('sql_source', 'instance-source', SQL_A.id, 'DbA', 1)).toBe(true);
		expect(coordinator.adoptTarget('sql_comparison', 'instance-comparison', SQL_A.id, 'DbA', 1)).toBe(true);
		coordinator.setComparisonOwner('sql_comparison', {
			sourceBoxId: 'sql_source', connectionId: SQL_A.id, copilotSequence: 10,
		});

		if (action === 'retarget') {
			expect(coordinator.adoptTarget('sql_comparison', 'instance-comparison', SQL_B.id, 'DbB', 2)).toBe(true);
		} else {
			expect(coordinator.retireTarget('sql_comparison', 'instance-comparison', 2)).toBe(true);
		}

		expect(coordinator.getComparisonOwner('sql_comparison')).toBeUndefined();
		expect(coordinator.getTarget('sql_source')).toEqual({
			boxId: 'sql_source', connectionId: SQL_A.id, database: 'DbA', generation: 1,
		});
	});

	it('does not let a stale connect close a newer incarnation document', async () => {
		const harness = createHarness();
		const firstOpenStarted = deferred();
		const releaseFirstOpen = deferred();
		harness.service.openHook = async details => {
			if (details.owner?.connectionId !== SQL_A.id) return;
			firstOpenStarted.resolve(undefined);
			await releaseFirstOpen.promise;
		};
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT old');

		const staleConnect = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await firstOpenStarted.promise;
		harness.coordinator.didClose('sql_1', 'instance-1');
		harness.coordinator.openSection('sql_1', 'instance-2');
		harness.coordinator.didOpen('sql_1', 'instance-2', 'SELECT new');
		await harness.coordinator.connect('sql_1', 'instance-2', SQL_B.id, 'DbB', 1);
		const replacementUri = harness.service.documents.get('sql_1')?.uri;

		releaseFirstOpen.resolve(undefined);
		await staleConnect;

		expect(harness.coordinator.getTarget('sql_1')).toEqual({
			boxId: 'sql_1', connectionId: SQL_B.id, database: 'DbB', generation: 1,
		});
		expect(harness.coordinator.getOwnerToken('sql_1')).toEqual(expect.any(String));
		expect(harness.service.documents.get('sql_1')).toMatchObject({
			uri: replacementUri,
			owner: { connectionId: SQL_B.id, sectionInstanceId: 'instance-2' },
		});
		expect(harness.service.closeDocumentUriForOwner).not.toHaveBeenCalled();
		expect(harness.service.closeDocumentForOwner).not.toHaveBeenCalled();
	});

	it('does not let an older same-owner connect close the newer replacement document', async () => {
		const harness = createHarness();
		const firstOpenStarted = deferred();
		const releaseFirstOpen = deferred();
		let openCount = 0;
		harness.service.openHook = async () => {
			openCount += 1;
			if (openCount !== 1) return;
			firstOpenStarted.resolve(undefined);
			await releaseFirstOpen.promise;
		};
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT shared');

		const older = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await firstOpenStarted.promise;
		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		const replacementUri = harness.service.issuedUris[1];

		releaseFirstOpen.resolve(undefined);
		await older;

		expect(harness.service.openDocument).toHaveBeenCalledTimes(2);
		expect(harness.service.connectDocument).toHaveBeenCalledOnce();
		expect(harness.service.documents.get('sql_1')?.uri).toBe(replacementUri);
		expect(harness.service.closeDocumentUriForOwner).not.toHaveBeenCalled();
		expect(harness.service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(harness.messages.filter(message => message.type === 'stsConnectionState' && message.state === 'ready'))
			.toHaveLength(1);
	});

	it('settles duplicate same-owner connects on the newest host sequence without stale close', async () => {
		const harness = createHarness();
		const sharedConnect = deferred();
		harness.service.connectHook = async () => await sharedConnect.promise;
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT shared');

		const first = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(harness.service.connectDocument).toHaveBeenCalledOnce());
		const second = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(harness.service.connectDocument).toHaveBeenCalledTimes(2));
		sharedConnect.resolve(undefined);
		await Promise.all([first, second]);

		expect(harness.service.openDocument).toHaveBeenCalledOnce();
		expect(harness.service.closeDocumentUriForOwner).not.toHaveBeenCalled();
		expect(harness.service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(harness.service.documents.has('sql_1')).toBe(true);
		expect(harness.messages.filter(message => message.type === 'stsConnectionState' && message.state === 'ready'))
			.toHaveLength(1);
	});

	it('does not leave a normal token from a stale connect after a newer same-target connect fails', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		const oldIssuance = deferred<void>();
		harness.dispatchSqlOwnerAllowed.mockImplementationOnce(async (
			_connection: SqlConnection,
			_principal: string,
			_revocation: number,
			dispatch: () => unknown,
		) => {
			await oldIssuance.promise;
			return await dispatch();
		});
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT 1');
		const first = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(harness.dispatchSqlOwnerAllowed).toHaveBeenCalledOnce());
		harness.assertSqlConnectionAllowed.mockRejectedValueOnce(new Error('newer connect failed'));
		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		oldIssuance.resolve();
		await first;

		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', error: 'newer connect failed',
		}));
	});

	it('exact-closes an in-flight open when the section closes and never connects it', async () => {
		const harness = createHarness();
		const openStarted = deferred();
		const releaseOpen = deferred();
		harness.service.openHook = async () => {
			openStarted.resolve(undefined);
			await releaseOpen.promise;
		};
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT closing');

		const connecting = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await openStarted.promise;
		const owner = harness.coordinator.getResultOwner('sql_1');
		harness.coordinator.didClose('sql_1', 'instance-1');
		releaseOpen.resolve(undefined);
		await connecting;

		expect(harness.service.closeDocumentUriForOwner).toHaveBeenCalledWith(
			'sql_1',
			harness.service.issuedUris[0],
			{ ...owner, sectionInstanceId: 'instance-1' },
		);
		expect(harness.service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(harness.service.connectDocument).not.toHaveBeenCalled();
		expect(harness.service.documents.has('sql_1')).toBe(false);
		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'ready', boxId: 'sql_1',
		}));
	});

	it('retries language-service initialization in the same session after a canceled first attempt', async () => {
		const harness = createHarness();
		harness.runtime.getProcessManager.mockRejectedValueOnce(new Error('Canceled'));
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT retry');

		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);

		expect(harness.createLanguageService).not.toHaveBeenCalled();
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', error: 'SQL Tools Service unavailable',
		}));
		clearMessages(harness);

		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);

		expect(harness.runtime.getProcessManager).toHaveBeenCalledTimes(2);
		expect(harness.createLanguageService).toHaveBeenCalledOnce();
		expect(harness.service.openDocument).toHaveBeenCalledOnce();
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'ready', connectionId: SQL_A.id,
		}));
	});

	it('does not replay documents when runtime publication completes a successful initializer', async () => {
		const harness = createHarness();
		const managerInitialization = deferred<StsProcessManager>();
		harness.runtime.getProcessManager.mockReturnValueOnce(managerInitialization.promise);
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT initialize');

		const connecting = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(harness.runtime.getProcessManager).toHaveBeenCalledOnce());
		const publishing = harness.coordinator.handleRuntimeManagerChange(true);
		managerInitialization.resolve({} as StsProcessManager);
		await Promise.all([connecting, publishing]);

		expect(harness.createLanguageService).toHaveBeenCalledOnce();
		expect(harness.service.openDocument).toHaveBeenCalledOnce();
		expect(harness.service.connectDocument).toHaveBeenCalledOnce();
		expect(harness.messages.filter(message => message.type === 'stsConnectionState' && message.state === 'ready'))
			.toHaveLength(1);
	});

	it('replays other sections exactly once when manager publication overlaps an initializer-owned reconnect', async () => {
		const originalService = new FakeLanguageService();
		const replacementService = new FakeLanguageService();
		const harness = createHarness({ services: [originalService, replacementService] });
		await connectReady(harness, {
			boxId: 'sql_a', sectionInstanceId: 'instance-a', database: 'DbA', text: 'SELECT A',
		});
		await connectReady(harness, {
			boxId: 'sql_b', sectionInstanceId: 'instance-b', database: 'DbB', text: 'SELECT B',
		});
		await harness.coordinator.handleRuntimeManagerChange(false);
		expect(originalService.dispose).toHaveBeenCalledOnce();
		clearMessages(harness);
		const managerInitialization = deferred<StsProcessManager>();
		harness.runtime.getProcessManager.mockReturnValueOnce(managerInitialization.promise);

		const reconnectingA = harness.coordinator.connect('sql_a', 'instance-a', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(harness.runtime.getProcessManager).toHaveBeenCalledTimes(2));
		const publishingManager = harness.coordinator.handleRuntimeManagerChange(true);
		managerInitialization.resolve({} as StsProcessManager);
		await Promise.all([reconnectingA, publishingManager]);

		expect(harness.createLanguageService).toHaveBeenCalledTimes(2);
		expect(replacementService.openDocument).toHaveBeenCalledTimes(2);
		expect(replacementService.connectDocument).toHaveBeenCalledTimes(2);
		expect(replacementService.openDocument.mock.calls.map(call => call[0]).sort()).toEqual(['sql_a', 'sql_b']);
		expect(replacementService.connectDocument.mock.calls.map(call => call[0]).sort()).toEqual(['sql_a', 'sql_b']);
		const readyMessages = harness.messages.filter(message =>
			message.type === 'stsConnectionState' && message.state === 'ready');
		expect(readyMessages).toHaveLength(2);
		expect(readyMessages).toEqual(expect.arrayContaining([
			expect.objectContaining({
				boxId: 'sql_a', sectionInstanceId: 'instance-a', database: 'DbA', targetGeneration: 1,
			}),
			expect.objectContaining({
				boxId: 'sql_b', sectionInstanceId: 'instance-b', database: 'DbB', targetGeneration: 1,
			}),
		]));

		await Promise.all([
			harness.coordinator.handleLanguageRequest('hover-a', 'textDocument/hover', {
				boxId: 'sql_a', sectionInstanceId: 'instance-a', line: 1, column: 1,
				ownerToken: harness.coordinator.getOwnerToken('sql_a'), targetGeneration: 1,
			}),
			harness.coordinator.handleLanguageRequest('completion-b', 'textDocument/completion', {
				boxId: 'sql_b', sectionInstanceId: 'instance-b', line: 1, column: 1,
				ownerToken: harness.coordinator.getOwnerToken('sql_b'), targetGeneration: 1,
			}),
		]);
		expect(replacementService.getHover).toHaveBeenCalledOnce();
		expect(replacementService.getCompletions).toHaveBeenCalledOnce();
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsResponse', requestId: 'hover-a', boxId: 'sql_a', sectionInstanceId: 'instance-a',
		}));
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsResponse', requestId: 'completion-b', boxId: 'sql_b', sectionInstanceId: 'instance-b',
		}));
	});

	it('settles an in-flight language request with null when runtime replacement changes the language epoch', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		const ownerToken = await connectReady(harness);
		const hover = deferred<unknown>();
		harness.service.getHover.mockReturnValueOnce(hover.promise);
		clearMessages(harness);

		const request = harness.coordinator.handleLanguageRequest('hover-runtime-loss', 'textDocument/hover', {
			boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
			ownerToken, targetGeneration: 1,
		});
		await vi.waitFor(() => expect(harness.service.getHover).toHaveBeenCalledOnce());
		await harness.coordinator.handleRuntimeManagerChange(false);
		await vi.waitFor(() => expect(harness.messages).toEqual([{
			type: 'stsResponse', boxId: 'sql_1', sectionInstanceId: 'instance-1',
			requestId: 'hover-runtime-loss', result: null, ownerToken, targetGeneration: 1,
		}]));
		hover.resolve({ contents: 'stale hover' });
		await request;

		expect(harness.messages).toEqual([{
			type: 'stsResponse', boxId: 'sql_1', sectionInstanceId: 'instance-1',
			requestId: 'hover-runtime-loss', result: null, ownerToken, targetGeneration: 1,
		}]);
	});

	it('settles and retires an in-flight request before a same-box replacement opens', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		const ownerToken = await connectReady(harness);
		const hover = deferred<unknown>();
		harness.service.getHover.mockReturnValueOnce(hover.promise);
		clearMessages(harness);
		const request = harness.coordinator.handleLanguageRequest('hover-old-instance', 'textDocument/hover', {
			boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
			ownerToken, targetGeneration: 1,
		});
		await vi.waitFor(() => expect(harness.service.getHover).toHaveBeenCalledOnce());

		harness.coordinator.didClose('sql_1', 'instance-1');
		await vi.waitFor(() => expect(harness.messages).toEqual([{
			type: 'stsResponse', boxId: 'sql_1', sectionInstanceId: 'instance-1',
			requestId: 'hover-old-instance', result: null, ownerToken, targetGeneration: 1,
		}]));
		harness.coordinator.openSection('sql_1', 'instance-2');
		hover.resolve({ contents: 'stale hover' });
		await request;

		expect(harness.messages).toHaveLength(1);
	});

	it.each(['connection', 'principal', 'leave-no-trace'] as const)(
		'settles an in-flight request immediately when %s invalidates its owner',
		async changeKind => {
			const harness = createHarness({ connections: [SQL_A] });
			const ownerToken = await connectReady(harness);
			const hover = deferred<unknown>();
			harness.service.getHover.mockReturnValueOnce(hover.promise);
			clearMessages(harness);
			const request = harness.coordinator.handleLanguageRequest(`hover-${changeKind}`, 'textDocument/hover', {
				boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
				ownerToken, targetGeneration: 1,
			});
			await vi.waitFor(() => expect(harness.service.getHover).toHaveBeenCalledOnce());

			if (changeKind === 'connection') {
				harness.setConnections([{ ...SQL_A, serverUrl: 'changed.example' }]);
			} else if (changeKind === 'principal') {
				harness.emitPrincipals([SQL_A.id]);
			} else {
				harness.protectedConnectionIds.add(SQL_A.id);
				harness.revocationGenerations.set(SQL_A.id, 1);
				harness.emitLeaveNoTrace({
					connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
				});
			}
			await vi.waitFor(() => expect(harness.messages).toContainEqual({
				type: 'stsResponse', boxId: 'sql_1', sectionInstanceId: 'instance-1',
				requestId: `hover-${changeKind}`, result: null, ownerToken, targetGeneration: 1,
			}));
			hover.resolve({ contents: 'stale hover' });
			await request;

			expect(harness.messages.filter(message => message.type === 'stsResponse')).toHaveLength(1);
			if (changeKind === 'leave-no-trace') {
				const responseIndex = harness.messages.findIndex(message => message.type === 'stsResponse');
				const policyIndex = harness.messages.findIndex(message => message.type === 'sqlLeaveNoTraceData');
				expect(responseIndex).toBeGreaterThanOrEqual(0);
				expect(policyIndex).toBeGreaterThan(responseIndex);
			}
		},
	);

	it('ignores an initializer that resolves after disposal and a fresh same-identity session', async () => {
		const oldManager = { id: 'old-manager' } as unknown as StsProcessManager;
		const newManager = { id: 'new-manager' } as unknown as StsProcessManager;
		const oldService = new FakeLanguageService();
		const newService = new FakeLanguageService();
		const harness = createHarness({
			services: [oldService, newService],
			serviceFactory: manager => {
				if (manager === oldManager) return oldService;
				if (manager === newManager) return newService;
				throw new Error('Unexpected process manager.');
			},
		});
		const oldManagerInitialization = deferred<StsProcessManager>();
		harness.runtime.getProcessManager.mockReset()
			.mockReturnValueOnce(oldManagerInitialization.promise)
			.mockResolvedValue(newManager);
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT old session');
		const staleConnect = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(harness.runtime.getProcessManager).toHaveBeenCalledOnce());

		harness.coordinator.dispose();
		harness.coordinator.startSession();
		clearMessages(harness);
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT fresh session');
		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		const messagesBeforeStaleResolution = [...harness.messages];

		oldManagerInitialization.resolve(oldManager);
		await staleConnect;

		expect(harness.createLanguageService).toHaveBeenCalledOnce();
		expect(harness.createLanguageService).toHaveBeenCalledWith(newManager);
		expect(oldService.onDiagnostics).not.toHaveBeenCalled();
		expect(oldService.openDocument).not.toHaveBeenCalled();
		expect(oldService.connectDocument).not.toHaveBeenCalled();
		expect(oldService.dispose).not.toHaveBeenCalled();
		expect(newService.openDocument).toHaveBeenCalledOnce();
		expect(newService.openDocument).toHaveBeenCalledWith(
			'sql_1', 'SELECT fresh session', SQL_A, expect.objectContaining({ sectionInstanceId: 'instance-1' }),
		);
		expect(newService.connectDocument).toHaveBeenCalledOnce();
		expect(harness.messages).toEqual(messagesBeforeStaleResolution);
		expect(harness.messages.filter(message => message.type === 'stsConnectionState' && message.state === 'ready'))
			.toHaveLength(1);
		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error',
		}));
		expect(harness.coordinator.getTarget('sql_1')).toEqual({
			boxId: 'sql_1', connectionId: SQL_A.id, database: 'DbA', generation: 1,
		});

		await harness.coordinator.handleLanguageRequest('fresh-hover', 'textDocument/hover', {
			boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
			ownerToken: harness.coordinator.getOwnerToken('sql_1'), targetGeneration: 1,
		});
		expect(newService.getHover).toHaveBeenCalledOnce();
		expect(oldService.getHover).not.toHaveBeenCalled();
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsResponse', requestId: 'fresh-hover', sectionInstanceId: 'instance-1', targetGeneration: 1,
		}));
	});

	it('runtime replay reports the exact incarnation and generation and closes its candidate', async () => {
		const service = new FakeLanguageService();
		service.connectHook = async () => { throw new Error('replay connect failed'); };
		const harness = createHarness({ services: [service] });
		harness.coordinator.openSection('sql_1', 'instance-replay');
		harness.coordinator.didOpen('sql_1', 'instance-replay', 'SELECT replay');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-replay', SQL_A.id, 'DbA', 4)).toBe(true);
		const owner = harness.coordinator.getResultOwner('sql_1');

		await harness.coordinator.handleRuntimeManagerChange(true);

		expect(service.closeDocumentUriForOwner).toHaveBeenCalledWith(
			'sql_1',
			service.issuedUris[0],
			{ ...owner, sectionInstanceId: 'instance-replay' },
		);
		expect(service.documents.has('sql_1')).toBe(false);
		expect(harness.messages).toContainEqual({
			type: 'stsConnectionState',
			boxId: 'sql_1',
			sectionInstanceId: 'instance-replay',
			state: 'error',
			error: 'replay connect failed',
			targetGeneration: 4,
		});
	});

	it('does not close a current document when replay openDocument rejects before returning a candidate', async () => {
		const service = new FakeLanguageService();
		const harness = createHarness({ services: [service] });
		harness.coordinator.openSection('sql_1', 'instance-replay');
		harness.coordinator.didOpen('sql_1', 'instance-replay', 'SELECT replay');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-replay', SQL_A.id, 'DbA', 4)).toBe(true);
		const owner = harness.coordinator.getResultOwner('sql_1');
		service.documents.set('sql_1', {
			uri: 'file:///sql-test/sql_1/current.sql',
			text: 'SELECT current',
			connection: SQL_A,
			owner: { ...owner, sectionInstanceId: 'instance-replay' },
		});
		service.openDocument.mockRejectedValueOnce(new Error('post-didOpen failure'));

		await harness.coordinator.handleRuntimeManagerChange(true);

		expect(service.closeDocumentUriForOwner).not.toHaveBeenCalled();
		expect(service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(service.connectDocument).not.toHaveBeenCalled();
		expect(service.documents.get('sql_1')?.uri).toBe('file:///sql-test/sql_1/current.sql');
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', error: 'post-didOpen failure', targetGeneration: 4,
		}));
	});

	it('falls back from exact replay candidate close to exact owner close after connect failure', async () => {
		const service = new FakeLanguageService();
		service.connectHook = async () => { throw new Error('submitted connect failed'); };
		service.closeDocumentUriForOwner.mockReturnValueOnce(false);
		const harness = createHarness({ services: [service] });
		harness.coordinator.openSection('sql_1', 'instance-replay');
		harness.coordinator.didOpen('sql_1', 'instance-replay', 'SELECT replay');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-replay', SQL_A.id, 'DbA', 4)).toBe(true);
		const owner = harness.coordinator.getResultOwner('sql_1');

		await harness.coordinator.handleRuntimeManagerChange(true);

		expect(service.closeDocumentUriForOwner).toHaveBeenCalledWith(
			'sql_1',
			service.issuedUris[0],
			{ ...owner, sectionInstanceId: 'instance-replay' },
		);
		expect(service.closeDocumentForOwner).toHaveBeenCalledWith(
			'sql_1',
			{ ...owner, sectionInstanceId: 'instance-replay' },
		);
		expect(service.documents.has('sql_1')).toBe(false);
	});

	it('closes the old owner before a failed replacement can serve language data', async () => {
		const harness = createHarness();
		const oldToken = await connectReady(harness);
		const oldOwner = harness.coordinator.getResultOwner('sql_1');
		harness.service.openDocument.mockClear();
		harness.service.connectDocument.mockClear();
		harness.service.closeDocumentForOwner.mockClear();
		harness.assertSqlConnectionAllowed.mockClear();
		harness.assertSqlConnectionAllowed.mockImplementation(async connectionId => {
			if (connectionId === SQL_B.id) throw new Error('B policy rejected');
		});

		await harness.coordinator.connect('sql_1', 'instance-1', SQL_B.id, 'DbB', 2);

		expect(harness.service.closeDocumentForOwner).toHaveBeenCalledWith(
			'sql_1',
			{ ...oldOwner, sectionInstanceId: 'instance-1' },
		);
		expect(harness.service.closeDocumentForOwner.mock.invocationCallOrder[0])
			.toBeLessThan(harness.assertSqlConnectionAllowed.mock.invocationCallOrder[0]);
		expect(harness.service.openDocument).not.toHaveBeenCalled();
		expect(harness.service.connectDocument).not.toHaveBeenCalled();

		await Promise.all([
			harness.coordinator.handleLanguageRequest('hover-b', 'textDocument/hover', {
				boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
				ownerToken: oldToken, targetGeneration: 2,
			}),
			harness.coordinator.handleLanguageRequest('completion-b', 'textDocument/completion', {
				boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
				ownerToken: oldToken, targetGeneration: 2,
			}),
		]);

		expect(harness.service.getHover).not.toHaveBeenCalled();
		expect(harness.service.getCompletions).not.toHaveBeenCalled();
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsResponse', requestId: 'hover-b', result: null,
		}));
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsResponse', requestId: 'completion-b', result: null,
		}));
	});

	it('suppresses language request error details when final canonical admission rejects', async () => {
		const harness = createHarness();
		const ownerToken = await connectReady(harness);
		clearMessages(harness);
		harness.output.error.mockClear();
		harness.output.warn.mockClear();
		harness.service.getHover.mockRejectedValueOnce(new Error('SECRET_HOST_STS_ERROR'));
		harness.dispatchSqlOwnerAllowed.mockRejectedValueOnce(new Error('owner invalid'));

		await harness.coordinator.handleLanguageRequest('request-1', 'textDocument/hover', {
			boxId: 'sql_1', sectionInstanceId: 'instance-1', line: 1, column: 1,
			ownerToken, targetGeneration: 1,
		});

		expect(JSON.stringify(harness.output.error.mock.calls)).not.toContain('SECRET_HOST_STS_ERROR');
		expect(harness.output.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
		expect(JSON.stringify(harness.messages)).not.toContain('SECRET_HOST_STS_ERROR');
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsResponse', requestId: 'request-1', result: null,
		}));
	});

	it('exact-closes the candidate and withholds ready when the full owner drifts after connect', async () => {
		const harness = createHarness();
		let connectedOwner: StsExpectedOwner | undefined;
		harness.service.connectHook = async details => {
			connectedOwner = details.owner;
			harness.revocationGenerations.set(SQL_A.id, 1);
		};
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT drift');

		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);

		expect(harness.service.closeDocumentUriForOwner).toHaveBeenCalledWith(
			'sql_1',
			harness.service.issuedUris[0],
			connectedOwner,
		);
		expect(harness.service.closeDocumentForOwner).not.toHaveBeenCalled();
		expect(harness.service.documents.has('sql_1')).toBe(false);
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'ready', boxId: 'sql_1',
		}));
	});

	it('revokes an invisible normal owner and publishes a recoverable error when ready delivery stays false', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		let readyAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'stsConnectionState' && record.state === 'ready') {
				readyAttempts += 1;
				return false;
			}
			return true;
		});
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT 1');

		const connecting = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.advanceTimersByTimeAsync(100);
		await connecting;

		expect(readyAttempts).toBe(2);
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.service.closeDocumentUriForOwner).toHaveBeenCalledOnce();
		expect(harness.service.documents.has('sql_1')).toBe(false);
		harness.setConnections([]);
		await flushMicrotasks();
		expect(harness.service.documents.has('sql_1')).toBe(false);
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error',
			error: 'SQL connection state could not be delivered. Reconnect and retry.',
			targetGeneration: 1,
		}));
	});

	it('retries a normal STS error once when the first delivery resolves false', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		let errorAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'stsConnectionState' && record.state === 'error') {
				errorAttempts += 1;
				return errorAttempts > 1;
			}
			return true;
		});
		harness.assertSqlConnectionAllowed.mockRejectedValueOnce(new Error('connection rejected'));
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT 1');

		const connecting = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.advanceTimersByTimeAsync(100);
		await connecting;

		expect(errorAttempts).toBe(2);
		expect(harness.messages.filter(message =>
			message.type === 'stsConnectionState' && message.state === 'error')).toHaveLength(2);
	});

	it('revokes an unacknowledged normal token when a newer same-target connect supersedes its retry', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		let readyAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'stsConnectionState' && record.state === 'ready') {
				readyAttempts += 1;
				return false;
			}
			return true;
		});
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT 1');
		const first = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(readyAttempts).toBe(1));
		harness.assertSqlConnectionAllowed.mockRejectedValueOnce(new Error('newer connect failed'));
		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.advanceTimersByTimeAsync(100);
		await first;

		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(readyAttempts).toBe(1);
		expect(harness.messages.at(-1)).toEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', error: 'newer connect failed',
		}));
	});

	it('closes the document when a newer same-target connect reuses an unacknowledged token and delivery fails', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		let readyAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'stsConnectionState' && record.state === 'ready') {
				readyAttempts += 1;
				return false;
			}
			return true;
		});
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT 1');
		const first = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(readyAttempts).toBe(1));
		const second = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(readyAttempts).toBe(2));
		await vi.advanceTimersByTimeAsync(100);
		await Promise.all([first, second]);

		expect(readyAttempts).toBe(3);
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.service.documents.has('sql_1')).toBe(false);
		expect(harness.service.closeDocumentForOwner).toHaveBeenCalled();
	});

	it('closes an unacknowledged claimed document before a newer connect fails early', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		let readyAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'stsConnectionState' && record.state === 'ready') {
				readyAttempts += 1;
				return false;
			}
			return true;
		});
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT 1');
		const first = harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.waitFor(() => expect(readyAttempts).toBe(1));
		harness.assertSqlConnectionAllowed.mockRejectedValueOnce(new Error('newer connect failed'));
		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		await vi.advanceTimersByTimeAsync(100);
		await first;

		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.service.documents.has('sql_1')).toBe(false);
		harness.setConnections([]);
		await flushMicrotasks();
		expect(harness.service.documents.has('sql_1')).toBe(false);
	});

	it('drops a delayed didChange after section incarnation replacement', async () => {
		const harness = createHarness();
		await connectReady(harness);
		harness.service.changeDocument.mockClear();
		harness.assertSqlConnectionAllowed.mockClear();
		const policyAdmission = deferred();
		harness.assertSqlConnectionAllowed.mockImplementationOnce(() => policyAdmission.promise);

		const changing = harness.coordinator.didChange('sql_1', 'instance-1', 'SELECT old');
		await vi.waitFor(() => expect(harness.assertSqlConnectionAllowed).toHaveBeenCalledOnce());
		harness.coordinator.openSection('sql_1', 'instance-2');
		policyAdmission.resolve(undefined);
		await changing;

		expect(harness.service.changeDocument).not.toHaveBeenCalled();
	});

	it('applies only the latest same-instance didChange when the first admission is delayed', async () => {
		const harness = createHarness();
		await connectReady(harness);
		harness.service.changeDocument.mockClear();
		harness.assertSqlConnectionAllowed.mockClear();
		const firstAdmission = deferred();
		harness.assertSqlConnectionAllowed
			.mockImplementationOnce(() => firstAdmission.promise)
			.mockResolvedValue(undefined);

		const first = harness.coordinator.didChange('sql_1', 'instance-1', 'SELECT old');
		await vi.waitFor(() => expect(harness.assertSqlConnectionAllowed).toHaveBeenCalledOnce());
		const second = harness.coordinator.didChange('sql_1', 'instance-1', 'SELECT newest');
		firstAdmission.resolve(undefined);
		await Promise.all([first, second]);

		expect(harness.service.changeDocument).toHaveBeenCalledOnce();
		expect(harness.service.changeDocument).toHaveBeenCalledWith('sql_1', 'SELECT newest', 'instance-1');
	});

	it('retires a deleted connection target and posts its replacement generation', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);

		harness.setConnections([]);
		await vi.waitFor(() => expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'sqlConnectionOwnerChanged',
			boxId: 'sql_1',
			sectionInstanceId: 'instance-1',
			connectionId: SQL_A.id,
			targetGeneration: 2,
			retired: true,
		})));

		expect(harness.coordinator.getTarget('sql_1')).toBeUndefined();
		expect(harness.coordinator.getGeneration('sql_1')).toBe(2);
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.effects.invalidatePersistence).toHaveBeenCalledOnce();
		expect(harness.effects.invalidateSqlCopilot).toHaveBeenCalledWith([SQL_A.id], []);
	});

	it('only refreshes the snapshot for metadata changes to an equivalent endpoint', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.coordinator.openSection('sql_1', 'instance-1');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 1)).toBe(true);
		const metadataUpdate: SqlConnection = { ...SQL_A, name: 'Renamed SQL A', port: 1433 };

		harness.setConnections([metadataUpdate]);
		await vi.waitFor(() => expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce());

		expect(harness.coordinator.getTarget('sql_1')).toEqual({
			boxId: 'sql_1', connectionId: SQL_A.id, database: 'DbA', generation: 1,
		});
		expect(harness.effects.invalidateSqlCopilot).not.toHaveBeenCalled();
		expect(harness.effects.invalidatePersistence).not.toHaveBeenCalled();
		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'sqlConnectionOwnerChanged' }));
	});

	it('publishes principal rotation and refreshes connections before schema prefetch', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		harness.effects.refreshConnectionsData.mockClear();
		harness.effects.prefetchSchema.mockClear();

		harness.emitPrincipals([SQL_A.id]);
		await vi.waitFor(() => expect(harness.effects.prefetchSchema).toHaveBeenCalledWith(SQL_A.id, 'DbA', 'sql_1', false));

		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'sqlConnectionOwnerChanged',
			boxId: 'sql_1',
			sectionInstanceId: 'instance-1',
			connectionId: SQL_A.id,
			targetGeneration: 2,
		}));
		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'sqlConnectionOwnerChanged', retired: true,
		}));
		expect(harness.coordinator.getGeneration('sql_1')).toBe(2);
		expect(harness.effects.refreshConnectionsData.mock.invocationCallOrder[0])
			.toBeLessThan(harness.effects.prefetchSchema.mock.invocationCallOrder[0]);
	});

	it('preserves target generation and database request ownership for first AAD establishment', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.coordinator.openSection('sql_1', 'instance-1');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, undefined, 1)).toBe(true);
		const ticket = harness.coordinator.beginDatabaseRequest(SQL_A.id, 'sql_1', 'instance-1');
		expect(ticket).toBeDefined();
		harness.effects.refreshConnectionsData.mockClear();

		harness.emitPrincipals([SQL_A.id], [SQL_A.id]);
		await vi.waitFor(() => expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce());

		expect(harness.coordinator.getGeneration('sql_1')).toBe(1);
		expect(harness.coordinator.isDatabaseRequestCurrent(ticket!)).toBe(true);
		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'sqlConnectionOwnerChanged',
		}));
		expect(harness.effects.invalidatePersistence).not.toHaveBeenCalled();
		expect(harness.effects.invalidateSqlCopilot).not.toHaveBeenCalled();
	});

	it('completes only the exact current database request ticket', () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.coordinator.openSection('sql_1', 'instance-1');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, undefined, 1)).toBe(true);
		const first = harness.coordinator.beginDatabaseRequest(SQL_A.id, 'sql_1', 'instance-1')!;
		const second = harness.coordinator.beginDatabaseRequest(SQL_A.id, 'sql_1', 'instance-1')!;

		expect(harness.coordinator.completeDatabaseRequest(first)).toBe(false);
		expect(harness.coordinator.isDatabaseRequestCurrent(second)).toBe(true);
		expect(harness.coordinator.completeDatabaseRequest(second)).toBe(true);
		expect(harness.coordinator.isDatabaseRequestCurrent(second)).toBe(false);
	});

	it.each(['connection', 'principal'] as const)(
		'does not invalidate a newer target while the first %s owner publication is pending',
		async changeKind => {
			const harness = createHarness({ connections: [SQL_A, SQL_B] });
			for (const [boxId, instanceId] of [['sql_1', 'instance-1'], ['sql_2', 'instance-2']] as const) {
				harness.coordinator.openSection(boxId, instanceId);
				expect(harness.coordinator.adoptTarget(boxId, instanceId, SQL_A.id, 'DbA', 1)).toBe(true);
			}
			const firstPublication = deferred<boolean>();
			let ownerChangeCount = 0;
			harness.effects.postMessage.mockImplementation((message: unknown) => {
				const record = message as LifecycleMessage;
				harness.messages.push(record);
				harness.order.push(`message:${String(record.type || '')}`);
				if (record.type === 'sqlConnectionOwnerChanged' && ++ownerChangeCount === 1) {
					return firstPublication.promise;
				}
				return true;
			});

			if (changeKind === 'connection') {
				harness.setConnections([{ ...SQL_A, serverUrl: 'a-edited.example' }, SQL_B]);
			} else {
				harness.emitPrincipals([SQL_A.id]);
			}
			await vi.waitFor(() => expect(ownerChangeCount).toBe(1));
			expect(harness.coordinator.adoptTarget('sql_2', 'instance-2', SQL_B.id, 'DbB', 3)).toBe(true);
			firstPublication.resolve(true);
			await vi.waitFor(() => expect(harness.effects.refreshConnectionsData).toHaveBeenCalled());

			expect(harness.coordinator.getTarget('sql_2')).toEqual({
				boxId: 'sql_2', connectionId: SQL_B.id, database: 'DbB', generation: 3,
			});
			expect(harness.messages.filter(message =>
				message.type === 'sqlConnectionOwnerChanged' && message.boxId === 'sql_2')).toHaveLength(0);
		},
	);

	it('retries a failed principal owner-change delivery and withholds schema prefetch', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		harness.effects.refreshConnectionsData.mockClear();
		harness.effects.prefetchSchema.mockClear();
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				return false;
			}
			return true;
		});

		harness.emitPrincipals([SQL_A.id]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		await flushMicrotasks();

		expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce();
		expect(harness.effects.prefetchSchema).not.toHaveBeenCalled();
		expect(harness.output.warn).toHaveBeenCalledWith('[sql] Owner change publication failed.');
		expect(harness.output.warn).toHaveBeenCalledWith('[sql] Owner change retry failed.');
		expect(vi.getTimerCount()).toBe(1);
	});

	it('replays an exact owner change until transport acknowledges it', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				return ownerChangeAttempts >= 3;
			}
			return true;
		});

		harness.emitPrincipals([SQL_A.id]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		await vi.advanceTimersByTimeAsync(250);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(3));
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(3);
		expect(harness.effects.refreshConnectionsData).toHaveBeenCalled();
		expect(harness.effects.prefetchSchema).toHaveBeenCalledWith(SQL_A.id, 'DbA', 'sql_1', false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('refreshes the connection snapshot after a retired-owner replay is acknowledged', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		let snapshotCallsAtAcknowledgement = -1;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				if (ownerChangeAttempts === 3) {
					snapshotCallsAtAcknowledgement = harness.effects.refreshConnectionsData.mock.calls.length;
				}
				return ownerChangeAttempts >= 3;
			}
			return true;
		});
		harness.effects.refreshConnectionsData.mockResolvedValue(true);

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(250);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(3));
		await flushMicrotasks();

		expect(harness.coordinator.getTarget('sql_1')).toBeUndefined();
		expect(snapshotCallsAtAcknowledgement).toBe(1);
		expect(harness.effects.refreshConnectionsData).toHaveBeenCalledTimes(2);
		expect(harness.effects.prefetchSchema).not.toHaveBeenCalled();
	});

	it.each([
		['initial publication', 1, 0],
		['100ms retry', 2, 100],
		['250ms replay', 3, 350],
	] as const)('does not acknowledge a stale successful %s', async (_label, deferredAttempt, elapsedMs) => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		const staleDelivery = deferred<boolean>();
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type !== 'sqlConnectionOwnerChanged') return true;
			ownerChangeAttempts += 1;
			if (ownerChangeAttempts === deferredAttempt) return staleDelivery.promise;
			return ownerChangeAttempts > deferredAttempt;
		});

		harness.setConnections([]);
		if (elapsedMs > 0) await vi.advanceTimersByTimeAsync(elapsedMs);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(deferredAttempt));
		harness.setConnections([SQL_A]);
		staleDelivery.resolve(true);
		await flushMicrotasks();

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(deferredAttempt + 1));
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(deferredAttempt + 1);
	});

	it('cancels retired replay when the same connection ID reappears', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				return false;
			}
			return true;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		harness.setConnections([{ ...SQL_A, serverUrl: 'restored.example' }]);
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(2);
	});

	it('reissues a pending retirement after transient exact same-ID reappearance', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		let acknowledgedRetirements = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				const delivered = ownerChangeAttempts === 3;
				if (delivered) acknowledgedRetirements += 1;
				return delivered;
			}
			return true;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		harness.setConnections([SQL_A]);
		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(3));
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(3);
		expect(acknowledgedRetirements).toBe(1);
		expect(harness.coordinator.getTarget('sql_1')).toBeUndefined();

		harness.setConnections([SQL_A]);
		harness.setConnections([]);
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(3);
	});

	it('replaces a retired publication when the same ID cycles during the initial retry gap', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		let acknowledgedRetirements = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				const delivered = ownerChangeAttempts === 2;
				if (delivered) acknowledgedRetirements += 1;
				return delivered;
			}
			return true;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		harness.setConnections([SQL_A]);
		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		await vi.advanceTimersByTimeAsync(600);

		expect(ownerChangeAttempts).toBe(2);
		expect(acknowledgedRetirements).toBe(1);
	});

	it('replaces an active retired replay when the same ID disappears again', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		const activeReplay = deferred<boolean>();
		let ownerChangeAttempts = 0;
		let acknowledgedRetirements = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				if (ownerChangeAttempts === 3) return activeReplay.promise;
				const delivered = ownerChangeAttempts === 4;
				if (delivered) acknowledgedRetirements += 1;
				return delivered;
			}
			return true;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		await vi.advanceTimersByTimeAsync(250);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(3));
		harness.setConnections([SQL_A]);
		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(4));
		activeReplay.resolve(false);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(600);

		expect(ownerChangeAttempts).toBe(4);
		expect(acknowledgedRetirements).toBe(1);
	});

	it('does not let a stale successful replay acknowledge a newer pending retirement', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		const staleReplay = deferred<boolean>();
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type !== 'sqlConnectionOwnerChanged') return true;
			ownerChangeAttempts += 1;
			if (ownerChangeAttempts === 3) return staleReplay.promise;
			return ownerChangeAttempts === 6;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		await vi.advanceTimersByTimeAsync(250);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(3));

		harness.setConnections([SQL_A]);
		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(4));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(5));
		staleReplay.resolve(true);
		await flushMicrotasks();

		harness.setConnections([SQL_A]);
		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(6));
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(6);
	});

	it('restamps and republishes an absent pending retirement after a policy change', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type !== 'sqlConnectionOwnerChanged') return true;
			ownerChangeAttempts += 1;
			return ownerChangeAttempts === 3;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(3));
		await vi.advanceTimersByTimeAsync(500);

		harness.protectedConnectionIds.delete(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 2);
		harness.emitLeaveNoTrace({
			connectionIds: [], invalidatedConnectionIds: [], disabledConnectionIds: [SQL_A.id],
		});
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(3);
	});

	it('withholds a policy-restamped retirement while its connection is present', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type !== 'sqlConnectionOwnerChanged') return true;
			ownerChangeAttempts += 1;
			return ownerChangeAttempts === 2;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		harness.setConnections([SQL_A]);
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.advanceTimersByTimeAsync(500);
		expect(ownerChangeAttempts).toBe(1);

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		expect(ownerChangeAttempts).toBe(2);
	});

	it.each([
		['explicit retirement', (harness: Harness) => {
			expect(harness.coordinator.retireTarget('sql_1', 'instance-1', 2)).toBe(true);
		}],
		['section close', (harness: Harness) => {
			harness.coordinator.didClose('sql_1', 'instance-1');
		}],
		['section reincarnation', (harness: Harness) => {
			harness.coordinator.openSection('sql_1', 'instance-2');
		}],
	] as const)('clears a pending retirement on %s', async (_label, supersede) => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				return false;
			}
			return true;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		supersede(harness);
		harness.setConnections([SQL_A]);
		harness.setConnections([]);
		await vi.advanceTimersByTimeAsync(600);

		expect(ownerChangeAttempts).toBe(1);
	});

	it('cancels a scheduled replay on accepted same-generation explicit retirement', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				return false;
			}
			return true;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(2));
		expect(vi.getTimerCount()).toBe(1);

		expect(harness.coordinator.retireTarget('sql_1', 'instance-1', 2)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(2);
	});

	it('clears a pending retirement when a new target is adopted', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		const publishedGenerations: number[] = [];
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type !== 'sqlConnectionOwnerChanged') return true;
			const generation = Number(record.targetGeneration);
			publishedGenerations.push(generation);
			return generation === 4;
		});

		harness.setConnections([]);
		await vi.waitFor(() => expect(publishedGenerations).toEqual([2]));
		harness.setConnections([SQL_A]);
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 3)).toBe(true);
		harness.setConnections([]);
		await vi.waitFor(() => expect(publishedGenerations).toEqual([2, 4]));
		await vi.advanceTimersByTimeAsync(500);

		expect(publishedGenerations).toEqual([2, 4]);
	});

	it('does not let a stale retry replace a newer connection publication replay', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		const staleRetry = deferred<boolean>();
		const attemptsByGeneration = new Map<number, number>();
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type !== 'sqlConnectionOwnerChanged') return true;
			const generation = Number(record.targetGeneration);
			const attempt = (attemptsByGeneration.get(generation) ?? 0) + 1;
			attemptsByGeneration.set(generation, attempt);
			if (generation === 2 && attempt === 2) return staleRetry.promise;
			return generation === 3 && attempt === 3;
		});

		harness.setConnections([{ ...SQL_A, serverUrl: 'first-edit.example' }]);
		await vi.waitFor(() => expect(attemptsByGeneration.get(2)).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(attemptsByGeneration.get(2)).toBe(2));

		harness.setConnections([{ ...SQL_A, serverUrl: 'second-edit.example' }]);
		await vi.waitFor(() => expect(attemptsByGeneration.get(3)).toBe(1));
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(attemptsByGeneration.get(3)).toBe(2));

		staleRetry.resolve(false);
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(250);

		expect(attemptsByGeneration.get(2)).toBe(2);
		expect(attemptsByGeneration.get(3)).toBe(3);
	});

	it('cancels delayed owner replay when Leave No Trace changes the owner mode', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		let ownerChangeAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlConnectionOwnerChanged') {
				ownerChangeAttempts += 1;
				return false;
			}
			return true;
		});
		harness.emitPrincipals([SQL_A.id]);
		await vi.waitFor(() => expect(ownerChangeAttempts).toBe(1));
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'sqlExecutionOwnerState', boxId: 'sql_1', targetGeneration: 2,
		})));
		const protectedToken = harness.coordinator.getOwnerToken('sql_1');
		await vi.advanceTimersByTimeAsync(500);

		expect(ownerChangeAttempts).toBe(1);
		expect(harness.coordinator.getOwnerToken('sql_1')).toBe(protectedToken);
	});

	it('contains subscription refresh rejections and deduplicates one bounded retry', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		const secretError = 'C:\\secret\\snapshot.json account-A';
		const unhandledRejections: unknown[] = [];
		const recordUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
		process.on('unhandledRejection', recordUnhandledRejection);
		try {
			harness.effects.refreshConnectionsData.mockRejectedValue(new Error(secretError));

			harness.setConnections([{ ...SQL_A, name: 'Metadata only', port: 1433 }]);
			harness.emitPrincipals([SQL_A.id]);
			harness.emitLeaveNoTrace({
				connectionIds: [], invalidatedConnectionIds: [], disabledConnectionIds: [],
			});
			await flushMicrotasks();

			expect(harness.effects.refreshConnectionsData).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(1);
			expect(harness.output.warn).toHaveBeenCalledWith(
				'[sql] Connection snapshot refresh failed; scheduling one retry.',
			);
			const loggedText = JSON.stringify([
				...harness.output.info.mock.calls,
				...harness.output.warn.mock.calls,
				...harness.output.error.mock.calls,
			]);
			expect(loggedText).not.toContain('snapshot.json');
			expect(loggedText).not.toContain('account-A');

			await vi.advanceTimersByTimeAsync(249);
			expect(harness.effects.refreshConnectionsData).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(1);
			await flushMicrotasks();

			expect(harness.effects.refreshConnectionsData).toHaveBeenCalledTimes(4);
			expect(harness.output.warn.mock.calls.filter(call =>
				call[0] === '[sql] Connection snapshot retry failed.')).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', recordUnhandledRejection);
		}
	});

	it('cancels a pending snapshot retry when a new session starts', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		harness.effects.refreshConnectionsData.mockRejectedValue(
			new Error('C:\\secret\\old-session.json account-A'),
		);

		harness.setConnections([{ ...SQL_A, name: 'Old session metadata', port: 1433 }]);
		await flushMicrotasks();
		expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		expect(JSON.stringify(harness.output.warn.mock.calls)).not.toContain('old-session.json');
		expect(JSON.stringify(harness.output.warn.mock.calls)).not.toContain('account-A');

		harness.coordinator.dispose();
		harness.coordinator.startSession();
		harness.effects.refreshConnectionsData.mockClear().mockResolvedValue(true);
		harness.output.warn.mockClear();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(250);

		expect(harness.effects.refreshConnectionsData).not.toHaveBeenCalled();
		expect(harness.output.warn).not.toHaveBeenCalledWith('[sql] Connection snapshot retry failed.');
		harness.setConnections([{ ...SQL_A, name: 'Fresh session metadata', port: 1433 }]);
		await flushMicrotasks();
		expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce();
	});

	it('schedules one bounded retry when a connection snapshot resolves false', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		harness.effects.refreshConnectionsData.mockResolvedValue(false);

		harness.setConnections([{ ...SQL_A, name: 'Metadata only', port: 1433 }]);
		await flushMicrotasks();

		expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce();
		expect(harness.output.warn).toHaveBeenCalledWith(
			'[sql] Connection snapshot refresh failed; scheduling one retry.',
		);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(250);
		await flushMicrotasks();

		expect(harness.effects.refreshConnectionsData).toHaveBeenCalledTimes(2);
		expect(harness.output.warn).toHaveBeenCalledWith('[sql] Connection snapshot retry failed.');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cancels before LNT publication, revokes the old token, and publishes execution-only ownership', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		const oldToken = await connectReady(harness);
		const cancel = vi.fn();
		startExecution(harness, 'sql_1', 'execution-lnt', cancel);
		clearMessages(harness);
		let tokenAtPolicyPublication: string | undefined = 'not-observed';
		harness.setMessageObserver(message => {
			if (message.type === 'sqlLeaveNoTraceData') {
				tokenAtPolicyPublication = harness.coordinator.getOwnerToken('sql_1');
			}
		});
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);

		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id],
			invalidatedConnectionIds: [SQL_A.id],
			disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'sqlExecutionOwnerState', boxId: 'sql_1', sectionInstanceId: 'instance-1', targetGeneration: 1,
		})));

		expect(cancel).toHaveBeenCalledOnce();
		expect(tokenAtPolicyPublication).toBeUndefined();
		expect(harness.coordinator.getOwnerToken('sql_1')).toEqual(expect.any(String));
		expect(harness.coordinator.getOwnerToken('sql_1')).not.toBe(oldToken);
		const cancellationIndex = harness.messages.findIndex(message => message.type === 'queryCancelled');
		const policyIndex = harness.messages.findIndex(message => message.type === 'sqlLeaveNoTraceData');
		expect(cancellationIndex).toBeGreaterThanOrEqual(0);
		expect(policyIndex).toBeGreaterThan(cancellationIndex);
		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'ready', boxId: 'sql_1',
		}));
		expect(harness.sqlWorkbench.dispatchSqlOwnerProtection).toHaveBeenCalledWith(
			expect.objectContaining({ id: SQL_A.id }),
			expect.any(String),
			1,
			true,
			expect.any(Function),
		);
	});

	it('withholds protected ownership until a policy-bearing delivery succeeds', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		harness.effects.refreshConnectionsData.mockResolvedValue(false);
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			return record.type !== 'sqlLeaveNoTraceData';
		});
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);

		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', targetGeneration: 1,
		})));

		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'sqlExecutionOwnerState' }));
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
	});

	it('does not report protected execution preparation before a database is selected', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.coordinator.openSection('sql_1', 'instance-discovery');
		expect(harness.coordinator.adoptTarget(
			'sql_1', 'instance-discovery', SQL_A.id, undefined, 1,
		)).toBe(true);
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);

		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await flushMicrotasks();

		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'sqlExecutionOwnerState' }));
		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error',
		}));
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		await harness.coordinator.connect('sql_1', 'instance-discovery', SQL_A.id, 'DbA', 1);
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'sqlExecutionOwnerState', boxId: 'sql_1', targetGeneration: 1,
		}));
	});

	it('holds database-backed protected connect behind a connection-only policy barrier', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.coordinator.openSection('sql_1', 'instance-discovery');
		expect(harness.coordinator.adoptTarget(
			'sql_1', 'instance-discovery', SQL_A.id, undefined, 1,
		)).toBe(true);
		const snapshot = deferred<boolean>();
		harness.effects.refreshConnectionsData.mockReturnValueOnce(snapshot.promise);
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			return record.type !== 'sqlLeaveNoTraceData';
		});
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce());

		const connecting = harness.coordinator.connect(
			'sql_1', 'instance-discovery', SQL_A.id, 'DbA', 1,
		);
		await flushMicrotasks();
		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'sqlExecutionOwnerState' }));
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		snapshot.resolve(true);
		await connecting;

		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'sqlExecutionOwnerState', boxId: 'sql_1', targetGeneration: 1,
		}));
	});

	it('suppresses a failed-policy recovery error after the section switches target', async () => {
		const harness = createHarness({ connections: [SQL_A, SQL_B] });
		await connectReady(harness);
		clearMessages(harness);
		const snapshot = deferred<boolean>();
		harness.effects.refreshConnectionsData.mockReturnValueOnce(snapshot.promise);
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			return record.type !== 'sqlLeaveNoTraceData';
		});
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(harness.effects.refreshConnectionsData).toHaveBeenCalledOnce());
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-1', SQL_B.id, 'DbB', 3)).toBe(true);
		snapshot.resolve(false);
		await flushMicrotasks();

		expect(harness.messages).not.toContainEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', targetGeneration: 3,
		}));
		expect(harness.coordinator.getTarget('sql_1')).toEqual({
			boxId: 'sql_1', connectionId: SQL_B.id, database: 'DbB', generation: 3,
		});
	});

	it('retries the ticketed policy-failure recovery error once', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		await connectReady(harness);
		clearMessages(harness);
		harness.effects.refreshConnectionsData.mockResolvedValue(false);
		let errorAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlLeaveNoTraceData') return false;
			if (record.type === 'stsConnectionState' && record.state === 'error') {
				errorAttempts += 1;
				return errorAttempts > 1;
			}
			return true;
		});
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);

		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.advanceTimersByTimeAsync(100);
		await vi.waitFor(() => expect(errorAttempts).toBe(2));

		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'sqlExecutionOwnerState' }));
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
	});

	it('keeps protected-owner failures private and allows a later connect retry', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		const secretError = 'C:\\secret\\policy.lock account-A';
		const fixedWarning = '[sql-lnt] Failed to prepare isolated SQL execution.';
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.dispatchSqlOwnerProtection.mockRejectedValueOnce(new Error(secretError));
		harness.coordinator.openSection('sql_1', 'instance-protected');
		harness.coordinator.didOpen('sql_1', 'instance-protected', 'SELECT protected');

		await harness.coordinator.connect('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7);

		expect(JSON.stringify([
			...harness.output.info.mock.calls,
			...harness.output.warn.mock.calls,
			...harness.output.error.mock.calls,
		])).not.toContain('policy.lock');
		expect(JSON.stringify([
			...harness.output.info.mock.calls,
			...harness.output.warn.mock.calls,
			...harness.output.error.mock.calls,
		])).not.toContain('account-A');
		expect(harness.output.warn.mock.calls.filter(call => call[0] === fixedWarning)).toHaveLength(1);
		expect(harness.messages.filter(message => message.type === 'stsConnectionState')).toEqual([{
			type: 'stsConnectionState',
			boxId: 'sql_1',
			sectionInstanceId: 'instance-protected',
			state: 'error',
			error: 'Unable to prepare isolated SQL execution. Reconnect and retry.',
			targetGeneration: 7,
		}]);
		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'sqlExecutionOwnerState' }));
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();

		harness.dispatchSqlOwnerProtection.mockImplementation(async (
			connection: SqlConnection,
			_principal: string,
			_revocation: number,
			expectedProtected: boolean,
			dispatch: () => unknown,
		) => {
			if (harness.protectedConnectionIds.has(connection.id) !== expectedProtected) {
				throw new Error('SQL protection mode changed.');
			}
			return await dispatch();
		});
		await harness.coordinator.connect('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7);

		expect(harness.messages.filter(message => message.type === 'sqlExecutionOwnerState')).toEqual([
			expect.objectContaining({
				type: 'sqlExecutionOwnerState', boxId: 'sql_1', sectionInstanceId: 'instance-protected',
				targetGeneration: 7, ownerToken: expect.any(String),
			}),
		]);
		expect(harness.coordinator.getOwnerToken('sql_1')).toEqual(expect.any(String));
		expect(harness.output.warn.mock.calls.filter(call => call[0] === fixedWarning)).toHaveLength(1);
	});

	it('suppresses an older protected publication after disable and re-enable succeeds', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.coordinator.openSection('sql_1', 'instance-protected');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7)).toBe(true);
		const oldPublication = deferred<void>();
		harness.dispatchSqlOwnerProtection
			.mockImplementationOnce(async () => {
				await oldPublication.promise;
				throw new Error('stale protected publication');
			})
			.mockImplementation(async (
				_connection: SqlConnection,
				_principal: string,
				_revocation: number,
				_expectedProtected: boolean,
				dispatch: () => unknown,
			) => await dispatch());
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(harness.dispatchSqlOwnerProtection).toHaveBeenCalledOnce());

		harness.protectedConnectionIds.delete(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 2);
		harness.emitLeaveNoTrace({
			connectionIds: [], invalidatedConnectionIds: [], disabledConnectionIds: [SQL_A.id],
		});
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 3);
		harness.emitLeaveNoTrace({
			connectionIds: [SQL_A.id], invalidatedConnectionIds: [SQL_A.id], disabledConnectionIds: [],
		});
		await vi.waitFor(() => expect(harness.messages.filter(message =>
			message.type === 'sqlExecutionOwnerState')).toHaveLength(1));
		const currentToken = harness.coordinator.getOwnerToken('sql_1');
		expect(currentToken).toEqual(expect.any(String));

		oldPublication.resolve();
		await flushMicrotasks();

		expect(harness.coordinator.getOwnerToken('sql_1')).toBe(currentToken);
		expect(harness.messages.filter(message => message.type === 'stsConnectionState')).toEqual([]);
		expect(JSON.stringify(harness.output.warn.mock.calls)).not.toContain('stale protected publication');
	});

	it.each(['same-target-adopt', 'stale-retire'] as const)(
		'keeps protected publication current across a %s message',
		async messageKind => {
			const harness = createHarness({ connections: [SQL_A] });
			harness.protectedConnectionIds.add(SQL_A.id);
			harness.revocationGenerations.set(SQL_A.id, 1);
			harness.coordinator.openSection('sql_1', 'instance-protected');
			expect(harness.coordinator.adoptTarget('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7)).toBe(true);
			const issuance = deferred<void>();
			harness.dispatchSqlOwnerProtection.mockImplementationOnce(async (
				_connection: SqlConnection,
				_principal: string,
				_revocation: number,
				_expectedProtected: boolean,
				dispatch: () => unknown,
			) => {
				await issuance.promise;
				return await dispatch();
			});
			const publishing = harness.coordinator.connect(
				'sql_1', 'instance-protected', SQL_A.id, 'DbA', 7,
			);
			await vi.waitFor(() => expect(harness.dispatchSqlOwnerProtection).toHaveBeenCalledOnce());

			if (messageKind === 'same-target-adopt') {
				expect(harness.coordinator.adoptTarget(
					'sql_1', 'instance-protected', SQL_A.id, 'DbA', 7,
				)).toBe(true);
			} else {
				expect(harness.coordinator.retireTarget('sql_1', 'instance-protected', 6)).toBe(false);
			}
			issuance.resolve();
			await publishing;

			expect(harness.messages.filter(message => message.type === 'sqlExecutionOwnerState')).toHaveLength(1);
			expect(harness.coordinator.getOwnerToken('sql_1')).toEqual(expect.any(String));
			expect(harness.messages).not.toContainEqual(expect.objectContaining({
				type: 'stsConnectionState', state: 'error',
			}));
		},
	);

	it('recovers when execution-owner delivery resolves false', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			return record.type !== 'sqlExecutionOwnerState';
		});
		harness.coordinator.openSection('sql_1', 'instance-protected');
		harness.coordinator.didOpen('sql_1', 'instance-protected', 'SELECT protected');

		await harness.coordinator.connect('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7);

		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.messages).toContainEqual(expect.objectContaining({
			type: 'sqlExecutionOwnerState', targetGeneration: 7,
		}));
		expect(harness.messages).toContainEqual({
			type: 'stsConnectionState', boxId: 'sql_1', sectionInstanceId: 'instance-protected',
			state: 'error', error: 'Unable to prepare isolated SQL execution. Reconnect and retry.',
			targetGeneration: 7,
		});
		expect(harness.output.warn).toHaveBeenCalledWith('[sql-lnt] Failed to prepare isolated SQL execution.');
	});

	it('retries protected owner and fallback error delivery under the same ticket', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		let ownerAttempts = 0;
		let errorAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlExecutionOwnerState') {
				ownerAttempts += 1;
				return false;
			}
			if (record.type === 'stsConnectionState' && record.state === 'error') {
				errorAttempts += 1;
				return errorAttempts > 1;
			}
			return true;
		});
		harness.coordinator.openSection('sql_1', 'instance-protected');
		harness.coordinator.didOpen('sql_1', 'instance-protected', 'SELECT protected');

		const connecting = harness.coordinator.connect('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7);
		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);
		await connecting;

		expect(ownerAttempts).toBe(2);
		expect(errorAttempts).toBe(2);
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.messages.at(-1)).toEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', targetGeneration: 7,
		}));
	});

	it('revokes an unacknowledged protected token when a newer same-target connect supersedes its retry', async () => {
		vi.useFakeTimers();
		const harness = createHarness({ connections: [SQL_A] });
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		let ownerAttempts = 0;
		harness.effects.postMessage.mockImplementation((message: unknown) => {
			const record = message as LifecycleMessage;
			harness.messages.push(record);
			harness.order.push(`message:${String(record.type || '')}`);
			if (record.type === 'sqlExecutionOwnerState') {
				ownerAttempts += 1;
				return false;
			}
			return true;
		});
		harness.coordinator.openSection('sql_1', 'instance-protected');
		harness.coordinator.didOpen('sql_1', 'instance-protected', 'SELECT protected');
		const first = harness.coordinator.connect('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7);
		await vi.waitFor(() => expect(ownerAttempts).toBe(1));
		harness.dispatchSqlOwnerProtection.mockRejectedValueOnce(new Error('newer protected connect failed'));
		await harness.coordinator.connect('sql_1', 'instance-protected', SQL_A.id, 'DbA', 7);
		await vi.advanceTimersByTimeAsync(100);
		await first;

		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(ownerAttempts).toBe(1);
		expect(harness.messages.at(-1)).toEqual(expect.objectContaining({
			type: 'stsConnectionState', state: 'error', targetGeneration: 7,
		}));
	});

	it('revokes a protected execution owner when Leave No Trace is disabled', async () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.protectedConnectionIds.add(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 1);
		harness.coordinator.openSection('sql_1', 'instance-1');
		harness.coordinator.didOpen('sql_1', 'instance-1', 'SELECT protected');
		await harness.coordinator.connect('sql_1', 'instance-1', SQL_A.id, 'DbA', 1);
		expect(harness.coordinator.getOwnerToken('sql_1')).toEqual(expect.any(String));
		clearMessages(harness);
		harness.protectedConnectionIds.delete(SQL_A.id);
		harness.revocationGenerations.set(SQL_A.id, 2);

		harness.emitLeaveNoTrace({
			connectionIds: [],
			invalidatedConnectionIds: [],
			disabledConnectionIds: [SQL_A.id],
		});

		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.messages).toContainEqual({ type: 'sqlLeaveNoTraceData', connectionIds: [] });
		expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'sqlExecutionOwnerState' }));
	});

	it('invalidates database request tickets across same-identity session epochs', () => {
		const harness = createHarness({ connections: [SQL_A] });
		harness.coordinator.openSection('sql_1', 'instance-1');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 1)).toBe(true);
		const oldTicket = harness.coordinator.beginDatabaseRequest(SQL_A.id, 'sql_1', 'instance-1');
		if (!oldTicket) throw new Error('Expected an old-session database request ticket.');
		expect(harness.coordinator.isDatabaseRequestCurrent(oldTicket, 'DbA')).toBe(true);

		harness.coordinator.dispose();
		harness.coordinator.startSession();
		harness.coordinator.openSection('sql_1', 'instance-1');
		expect(harness.coordinator.adoptTarget('sql_1', 'instance-1', SQL_A.id, 'DbA', 1)).toBe(true);
		const newTicket = harness.coordinator.beginDatabaseRequest(SQL_A.id, 'sql_1', 'instance-1');
		if (!newTicket) throw new Error('Expected a new-session database request ticket.');

		expect(newTicket.requestId).not.toBe(oldTicket.requestId);
		expect(newTicket.sessionEpoch).not.toBe(oldTicket.sessionEpoch);
		expect(harness.coordinator.isDatabaseRequestCurrent(oldTicket, 'DbA')).toBe(false);
		expect(harness.coordinator.isDatabaseSectionOwnerCurrent(oldTicket)).toBe(false);
		expect(harness.coordinator.isDatabaseRequestCurrent(newTicket, 'DbA')).toBe(true);
		expect(harness.coordinator.isDatabaseSectionOwnerCurrent(newTicket)).toBe(true);
	});

	it('dispose cancels before clearing, is idempotent, and can start a fresh session', async () => {
		const harness = createHarness();
		await connectReady(harness);
		harness.coordinator.setComparisonOwner('comparison-1', {
			sourceBoxId: 'sql_1', connectionId: SQL_A.id,
		});
		const observations: Array<{
			kind: string;
			target: ReturnType<SqlEditorLifecycleCoordinator['getTarget']>;
			comparison: ReturnType<SqlEditorLifecycleCoordinator['getComparisonOwner']>;
			token: string | undefined;
		}> = [];
		const sourceCancel = vi.fn(() => observations.push({
			kind: 'source',
			target: harness.coordinator.getTarget('sql_1'),
			comparison: harness.coordinator.getComparisonOwner('comparison-1'),
			token: harness.coordinator.getOwnerToken('sql_1'),
		}));
		const comparisonCancel = vi.fn(() => observations.push({
			kind: 'comparison',
			target: harness.coordinator.getTarget('sql_1'),
			comparison: harness.coordinator.getComparisonOwner('comparison-1'),
			token: harness.coordinator.getOwnerToken('comparison-1'),
		}));
		startExecution(harness, 'sql_1', 'source-dispose', sourceCancel);
		startExecution(harness, 'comparison-1', 'comparison-dispose', comparisonCancel);

		harness.coordinator.dispose();
		harness.coordinator.dispose();

		expect(sourceCancel).toHaveBeenCalledOnce();
		expect(comparisonCancel).toHaveBeenCalledOnce();
		expect(observations).toHaveLength(2);
		expect(observations.every(observation => observation.target?.connectionId === SQL_A.id)).toBe(true);
		expect(observations.every(observation => observation.comparison?.sourceBoxId === 'sql_1')).toBe(true);
		expect(observations.every(observation => !!observation.token)).toBe(true);
		expect(harness.coordinator.getTarget('sql_1')).toBeUndefined();
		expect(harness.coordinator.getComparisonOwner('comparison-1')).toBeUndefined();
		expect(harness.coordinator.getOwnerToken('sql_1')).toBeUndefined();
		expect(harness.service.dispose).toHaveBeenCalledOnce();
		expect(harness.connectionEvents.listenerCount).toBe(0);
		expect(harness.runtimeEvents.listenerCount).toBe(0);
		expect(harness.leaveNoTraceEvents.listenerCount).toBe(0);
		expect(harness.principalEvents.listenerCount).toBe(0);

		harness.coordinator.startSession();
		expect(harness.connectionEvents.listenerCount).toBe(1);
		expect(harness.runtimeEvents.listenerCount).toBe(1);
		expect(harness.leaveNoTraceEvents.listenerCount).toBe(1);
		expect(harness.principalEvents.listenerCount).toBe(1);
		harness.coordinator.openSection('sql_fresh', 'instance-fresh');
		expect(harness.coordinator.adoptTarget('sql_fresh', 'instance-fresh', SQL_B.id, 'DbB', 1)).toBe(true);
		expect(harness.coordinator.getTarget('sql_fresh')).toMatchObject({ connectionId: SQL_B.id, generation: 1 });
	});
});
