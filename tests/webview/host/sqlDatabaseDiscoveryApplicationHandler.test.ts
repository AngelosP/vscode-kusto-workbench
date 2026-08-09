import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	HostSqlDatabaseDiscoveryApplicationHandler,
	type SqlDatabaseDiscoveryApplicationHandler,
} from '../../../src/host/sqlDatabaseDiscoveryApplicationHandler';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import { SqlDatabaseDiscoveryOwnerError } from '../../../src/host/sqlClient';
import {
	sqlSchemaPrincipalFingerprint,
	sqlSchemaPrincipalFingerprintForPrincipal,
} from '../../../src/host/sqlEditorSchema';
import { SqlEditorLifecycleCoordinator } from '../../../src/host/sql/sqlEditorLifecycleCoordinator';
import { setCanonicalSqlServerAccount } from '../../../src/host/sql/sqlServerAccountMapStore';
import {
	beginSqlDatabaseCacheRequest,
	getOwnedSqlDatabaseCacheEntry,
	writeOwnedSqlDatabaseCacheEntry,
} from '../../../src/host/sqlDatabaseCache';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function lockContentionError(): Error {
	return Object.assign(new Error('owner lock unavailable'), { code: 'ELOCKED' });
}

type DiscoveryHarness = ReturnType<typeof createHarness>;
const activeHarnesses: DiscoveryHarness[] = [];
const tempDirectories: string[] = [];

function createHarness(options: {
	accountId?: string;
	authType?: 'aad' | 'sql-login';
	cacheOverrides?: Partial<{
		beginRequest: typeof beginSqlDatabaseCacheRequest;
		getOwnedEntry: typeof getOwnedSqlDatabaseCacheEntry;
		writeOwnedEntry: typeof writeOwnedSqlDatabaseCacheEntry;
	}>;
	waitForDeliveryRetry?: () => Promise<void>;
	globalStorageUri?: vscode.Uri;
} = {}) {
	const authType = options.authType ?? 'sql-login';
	let accountId = options.accountId;
	let protectedConnection = false;
	let connection: any = {
		id: 'sql-1',
		name: 'SQL',
		dialect: 'mssql',
		serverUrl: 'server.example',
		port: 1433,
		database: 'master',
		authType,
		...(authType === 'sql-login' ? { username: 'user-a' } : {}),
	};
	const cachedDatabases: Record<string, any> = {};
	const globalState = {
		get: vi.fn((key: string) => {
			if (key === 'sql.auth.serverAccountMap') return accountId ? { 'server.example': accountId } : {};
			if (key === 'sql.connectionManager.cachedDatabases') return { ...cachedDatabases };
			return undefined;
		}),
		update: vi.fn(async (key: string, value: unknown) => {
			if (key === 'sql.connectionManager.cachedDatabases') {
				for (const existing of Object.keys(cachedDatabases)) delete cachedDatabases[existing];
				Object.assign(cachedDatabases, value);
			}
		}),
	};
	const context = { globalState, ...(options.globalStorageUri ? { globalStorageUri: options.globalStorageUri } : {}) };
	const getDatabases = vi.fn<(...args: any[]) => Promise<string[]>>();
	const connectionManager = {
		getConnection: vi.fn(() => connection),
		getConnections: vi.fn(() => connection ? [connection] : []),
		assertConnectionCurrent: vi.fn(async (expected: unknown) => {
			if (connection !== expected) throw new Error('SQL connection changed.');
		}),
	};
	const getDatabasesWithIdentity = vi.fn(async (expectedConnection: any) => {
		const expectedProtected = protectedConnection;
		const revocationGeneration = expectedProtected ? 3 : 0;
		const startingPrincipal = sqlSchemaPrincipalFingerprint(context as any, expectedConnection)
			?? (String(expectedConnection.authType || '').trim().toLowerCase() === 'aad' ? 'aad-pending' : undefined);
		try {
			const databases = await getDatabases(expectedConnection);
			await connectionManager.assertConnectionCurrent(expectedConnection);
			if (protectedConnection !== expectedProtected) throw new Error('SQL protection mode changed.');
			const currentPrincipal = sqlSchemaPrincipalFingerprint(context as any, expectedConnection);
			const principalFingerprint = startingPrincipal === 'aad-pending'
				? currentPrincipal
				: startingPrincipal;
			if (!principalFingerprint || currentPrincipal !== principalFingerprint) {
				throw new Error('SQL principal changed while the operation was running.');
			}
			return {
				databases,
				owner: { principalFingerprint, revocationGeneration, expectedProtected },
			};
		} catch (error) {
			const owner = startingPrincipal
				? { principalFingerprint: startingPrincipal, revocationGeneration, expectedProtected }
				: undefined;
			throw new SqlDatabaseDiscoveryOwnerError(error, owner);
		}
	});
	const postMessage = vi.fn(async () => true);
	const output = { error: vi.fn(), warn: vi.fn() };
	const leaveNoTracePolicy = {
		getRevocationGeneration: vi.fn(() => protectedConnection ? 3 : 0),
	};
	const workbench: any = {
		connectionManager,
		client: { getDatabases },
		leaveNoTracePolicy,
		assertSqlConnectionAllowed: vi.fn(async () => {
			if (protectedConnection) throw new Error('SQL connection is protected.');
		}),
		dispatchSqlConnectionAllowed: vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch()),
		dispatchSqlOwnerAllowed: vi.fn(async (expectedConnection: unknown, principal: string, revocation: number, dispatch: () => unknown) => {
			if (connection !== expectedConnection || protectedConnection || revocation !== 0
				|| sqlSchemaPrincipalFingerprint(context as any, connection) !== principal) {
				throw new Error('SQL owner changed before canonical dispatch admission.');
			}
			return await dispatch();
		}),
		dispatchSqlOwnerProtection: vi.fn(async (expectedConnection: unknown, principal: string, revocation: number, expectedProtected: boolean, dispatch: () => unknown) => {
			const currentPrincipal = connection ? sqlSchemaPrincipalFingerprint(context as any, connection) : undefined;
			const pendingAad = principal === 'aad-pending'
				&& String(connection?.authType || '').trim().toLowerCase() === 'aad'
				&& currentPrincipal === undefined;
			if (connection !== expectedConnection || !protectedConnection || !expectedProtected || revocation !== 3
				|| (!pendingAad && currentPrincipal !== principal)) {
				throw new Error('SQL protected owner changed before canonical dispatch admission.');
			}
			return await dispatch();
		}),
		dispatchSqlOwnerSnapshot: vi.fn(async (dispatch: (snapshot: any) => unknown) => await dispatch({
			policy: { connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {} },
			connections: connection ? [connection] : [],
			connectionVersion: 1,
			accountsByServer: accountId ? { 'server.example': accountId } : {},
			principalVersion: 1,
		})),
		dispatchSqlPolicySnapshot: vi.fn(async (dispatch: (policy: any) => unknown) => await dispatch({
			connectionIds: [], version: 1, globallyBlocked: false, revocationGenerations: {},
		})),
		isLeaveNoTraceConnection: vi.fn(() => protectedConnection),
		refreshLeaveNoTracePolicy: vi.fn(async () => []),
		getLeaveNoTraceConnectionIds: vi.fn(() => []),
		getStateVersions: vi.fn(() => ({ policy: 1, principals: 1, connections: 1 })),
	};
	const lifecycle = new SqlEditorLifecycleCoordinator({
		context: context as any,
		sqlWorkbench: workbench,
		queryRuns: new QueryRunCoordinator(),
		output,
		hasWebview: () => true,
		effects: {
			postMessage,
			cancelCopilotWriteQuery: vi.fn(),
			cancelCopilotQueryTarget: vi.fn(),
			invalidateSqlCopilot: vi.fn(),
			rejectPendingComparisonEnsures: vi.fn(),
			invalidatePersistence: vi.fn(),
			refreshConnectionsData: vi.fn(async () => true),
			prefetchSchema: vi.fn(async () => undefined),
		},
	});
	lifecycle.openSection('sql-box', 'instance-sql-box');
	const handler = new HostSqlDatabaseDiscoveryApplicationHandler({
		context: context as any,
		lifecycle,
		workbench,
		connectionManager,
		client: { getDatabasesWithIdentity },
		cache: {
			beginRequest: options.cacheOverrides?.beginRequest ?? beginSqlDatabaseCacheRequest,
			getOwnedEntry: options.cacheOverrides?.getOwnedEntry ?? getOwnedSqlDatabaseCacheEntry,
			writeOwnedEntry: options.cacheOverrides?.writeOwnedEntry ?? writeOwnedSqlDatabaseCacheEntry,
		},
		waitForDeliveryRetry: options.waitForDeliveryRetry,
		postMessage,
		output,
	});
	const harness = {
		handler,
		lifecycle,
		workbench,
		connectionManager,
		getDatabases,
		getDatabasesWithIdentity,
		postMessage,
		output,
		context,
		globalState,
		cachedDatabases,
		getConnection: () => connection,
		setConnection: (value: any) => { connection = value; },
		setAccountId: (value: string | undefined) => { accountId = value; },
		setProtected: (value: boolean) => { protectedConnection = value; },
	};
	activeHarnesses.push(harness);
	return harness;
}

function message(
	type: 'getSqlDatabases' | 'refreshSqlDatabases',
	overrides: Partial<Extract<IncomingWebviewMessage, { type: typeof type }>> = {},
): Extract<IncomingWebviewMessage, { type: typeof type }> {
	return {
		type,
		sqlConnectionId: 'sql-1',
		boxId: 'sql-box',
		sectionInstanceId: 'instance-sql-box',
		targetGeneration: 7,
		...overrides,
	} as Extract<IncomingWebviewMessage, { type: typeof type }>;
}

function handle(
	handler: SqlDatabaseDiscoveryApplicationHandler,
	request: Extract<IncomingWebviewMessage, { type: 'getSqlDatabases' | 'refreshSqlDatabases' }>,
): Promise<void> {
	const result = handler.handleMessage(request);
	if (!result) throw new Error('SQL database discovery message was not claimed.');
	return result;
}

function messagesOfType(harness: DiscoveryHarness, type: string): any[] {
	return harness.postMessage.mock.calls.map(call => call[0]).filter(candidate => candidate.type === type);
}

afterEach(() => {
	for (const harness of activeHarnesses.splice(0)) {
		harness.handler.dispose();
		harness.lifecycle.dispose();
	}
	for (const directory of tempDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

describe('HostSqlDatabaseDiscoveryApplicationHandler', () => {
	it('declines unrelated traffic synchronously and suppresses a rejected target before request admission', async () => {
		const harness = createHarness();
		expect(harness.handler.handleMessage({ type: 'getSqlConnections' })).toBeUndefined();
		const beginRequest = vi.spyOn(harness.lifecycle, 'beginDatabaseRequest');

		await handle(harness.handler, message('getSqlDatabases', { sectionInstanceId: 'stale-instance' }));

		expect(beginRequest).not.toHaveBeenCalled();
		expect(harness.getDatabases).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('adopts the exact target before issuing one lifecycle request and publishes its identity', async () => {
		const harness = createHarness();
		harness.getDatabases.mockResolvedValue(['DbB', 'DbA']);
		const adoptTarget = vi.spyOn(harness.lifecycle, 'adoptTarget');
		const beginRequest = vi.spyOn(harness.lifecycle, 'beginDatabaseRequest');
		const request = message('refreshSqlDatabases');

		await handle(harness.handler, request);

		expect(adoptTarget).toHaveBeenCalledWith(
			'sql-box', 'instance-sql-box', 'sql-1', undefined, 7,
		);
		expect(adoptTarget.mock.invocationCallOrder[0]).toBeLessThan(beginRequest.mock.invocationCallOrder[0]);
		expect(beginRequest).toHaveBeenCalledWith('sql-1', 'sql-box', 'instance-sql-box');
		const loading = messagesOfType(harness, 'sqlDatabasesLoading')[0];
		expect(loading).toMatchObject({
			boxId: 'sql-box',
			sectionInstanceId: 'instance-sql-box',
			sqlConnectionId: 'sql-1',
			targetGeneration: 7,
			requestId: expect.any(String),
		});
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({
				requestId: loading.requestId,
				targetGeneration: 7,
				databases: ['DbA', 'DbB'],
			}),
		]);
	});

	it('does not start cache or STS work when loading delivery is exhausted', async () => {
		const beginRequest = vi.fn<typeof beginSqlDatabaseCacheRequest>();
		const harness = createHarness({
			cacheOverrides: { beginRequest },
		});
		harness.postMessage.mockResolvedValue(false);

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesLoading')).toHaveLength(2);
		expect(beginRequest).not.toHaveBeenCalled();
		expect(harness.getDatabasesWithIdentity).not.toHaveBeenCalled();
		expect(harness.getDatabases).not.toHaveBeenCalled();
		expect(harness.globalState.update).not.toHaveBeenCalled();
		const loading = messagesOfType(harness, 'sqlDatabasesLoading')[0];
		expect(harness.lifecycle.isDatabaseRequestCurrent({
			requestId: loading.requestId,
			boxId: 'sql-box',
			sectionInstanceId: 'instance-sql-box',
			connectionId: 'sql-1',
			targetGeneration: 7,
			sessionEpoch: 0,
		})).toBe(false);
	});

	it('does not start superseded work after a delayed loading delivery settles', async () => {
		const beginRequest = vi.fn<typeof beginSqlDatabaseCacheRequest>(beginSqlDatabaseCacheRequest);
		const harness = createHarness({
			cacheOverrides: { beginRequest },
		});
		const firstLoading = deferred<boolean>();
		let loadingAttempts = 0;
		harness.postMessage.mockImplementation((outbound: any) => {
			if (outbound.type !== 'sqlDatabasesLoading') return Promise.resolve(true);
			loadingAttempts += 1;
			return loadingAttempts === 1 ? firstLoading.promise : Promise.resolve(true);
		});

		const stale = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(loadingAttempts).toBe(1));
		const current = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(loadingAttempts).toBe(2));
		firstLoading.resolve(true);

		await expect(stale).resolves.toBeUndefined();
		await expect(current).resolves.toBeUndefined();
		expect(beginRequest).toHaveBeenCalledOnce();
		expect(harness.getDatabasesWithIdentity).toHaveBeenCalledOnce();
	});

	it('uses an owned cache passively but explicit refresh reacquires and replaces it', async () => {
		const harness = createHarness();
		harness.getDatabases.mockResolvedValueOnce(['CachedB', 'CachedA']);
		await handle(harness.handler, message('refreshSqlDatabases'));

		harness.getDatabases.mockClear();
		harness.postMessage.mockClear();
		await handle(harness.handler, message('getSqlDatabases'));
		expect(harness.getDatabases).not.toHaveBeenCalled();
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ databases: ['CachedA', 'CachedB'] }),
		]);

		harness.getDatabases.mockResolvedValueOnce(['FreshDb']);
		harness.postMessage.mockClear();
		await handle(harness.handler, message('refreshSqlDatabases'));
		expect(harness.getDatabases).toHaveBeenCalledOnce();
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ databases: ['FreshDb'] }),
		]);
	});

	it('publishes loading and a correlated error when the adopted connection is missing', async () => {
		const harness = createHarness();
		harness.setConnection(undefined);

		await handle(harness.handler, message('getSqlDatabases'));

		const loading = messagesOfType(harness, 'sqlDatabasesLoading')[0];
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				requestId: loading.requestId,
				sectionInstanceId: 'instance-sql-box',
				targetGeneration: 7,
				error: 'SQL connection not found.',
			}),
		]);
		expect(harness.getDatabases).not.toHaveBeenCalled();
	});

	it('keeps retrying a missing-connection terminal until the exact request retires', async () => {
		const retries: Array<ReturnType<typeof deferred<void>>> = [];
		const harness = createHarness({
			waitForDeliveryRetry: () => {
				const retry = deferred<void>();
				retries.push(retry);
				return retry.promise;
			},
		});
		harness.setConnection(undefined);
		harness.postMessage.mockImplementation(async (outbound: any) =>
			outbound.type !== 'sqlDatabasesError');
		let settled = false;

		const request = handle(harness.handler, message('getSqlDatabases'));
		void request.finally(() => { settled = true; });
		await vi.waitFor(() => expect(retries).toHaveLength(1));
		expect(settled).toBe(false);
		harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
		retries[0].resolve();

		await expect(request).resolves.toBeUndefined();
		expect(messagesOfType(harness, 'sqlDatabasesError')).toHaveLength(1);
	});

	it('discovers protected databases ephemerally through the protected owner admission', async () => {
		const harness = createHarness();
		harness.setProtected(true);
		harness.getDatabases.mockResolvedValue(['PrivateB', 'PrivateA']);

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledWith(
			harness.getConnection(), expect.any(String), 3, true, expect.any(Function),
		);
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ databases: ['PrivateA', 'PrivateB'] }),
		]);
		expect(harness.cachedDatabases).toEqual({});
		expect(harness.globalState.update).not.toHaveBeenCalledWith(
			'sql.connectionManager.cachedDatabases', expect.anything(),
		);
	});

	it('drops protected data and errors when the producing AAD principal rotates before publication', async () => {
		const harness = createHarness({ accountId: 'account-a', authType: 'aad' });
		harness.setProtected(true);
		harness.getDatabases.mockImplementation(async () => {
			harness.setAccountId('account-b');
			harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
			return ['AccountASecretDb'];
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
		expect(harness.cachedDatabases).toEqual({});
		expect(harness.output.warn).not.toHaveBeenCalled();
	});

	it('reconciles an established Account A ticket when protected discovery returns Account B data', async () => {
		const harness = createHarness({ accountId: 'account-a', authType: 'aad' });
		harness.setProtected(true);
		harness.getDatabasesWithIdentity.mockImplementationOnce(async () => {
			harness.setAccountId('account-b');
			return {
				databases: ['AccountBOnlyDb'],
				owner: {
					principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(
						harness.getConnection(), 'account-b',
					)!,
					revocationGeneration: 3,
					expectedProtected: true,
				},
			};
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
	});

	it('binds protected discovery to canonical Account A despite a stale observer mirror', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-discovery-canonical-owner-'));
		tempDirectories.push(directory);
		const writerValues = new Map<string, unknown>();
		const writerContext = {
			globalStorageUri: vscode.Uri.file(directory),
			globalState: {
				get: vi.fn((key: string) => writerValues.get(key)),
				update: vi.fn(async (key: string, value: unknown) => { writerValues.set(key, value); }),
			},
		} as any;
		await setCanonicalSqlServerAccount(writerContext, 'server.example', 'account-a');
		const harness = createHarness({
			accountId: 'account-a',
			authType: 'aad',
			globalStorageUri: vscode.Uri.file(directory),
		});
		harness.setProtected(true);
		harness.getDatabasesWithIdentity.mockImplementationOnce(async () => {
			await setCanonicalSqlServerAccount(writerContext, 'server.example', 'account-b');
			return {
				databases: ['AccountBOnlyDb'],
				owner: {
					principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(
						harness.getConnection(), 'account-b',
					)!,
					revocationGeneration: 3,
					expectedProtected: true,
				},
			};
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(harness.globalState.get('sql.auth.serverAccountMap')).toEqual({
			'server.example': 'account-a',
		});
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
	});

	it('reconciles an established Account A ticket when protected Account B discovery fails', async () => {
		const harness = createHarness({ accountId: 'account-a', authType: 'aad' });
		harness.setProtected(true);
		harness.getDatabasesWithIdentity.mockImplementationOnce(async () => {
			harness.setAccountId('account-b');
			throw new SqlDatabaseDiscoveryOwnerError(new Error('Account B failed'), {
				principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(
					harness.getConnection(), 'account-b',
				)!,
				revocationGeneration: 3,
				expectedProtected: true,
			});
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
		expect(harness.output.warn.mock.calls.flat().join('\n')).not.toContain('Account B failed');
	});

	it('drops protected data and errors when the same connection ID is repointed before publication', async () => {
		const harness = createHarness();
		harness.setProtected(true);
		harness.getDatabases.mockImplementation(async () => {
			harness.setConnection({ ...harness.getConnection(), serverUrl: 'replacement.example' });
			harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
			return ['OldTargetSecretDb'];
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
		expect(harness.cachedDatabases).toEqual({});
		expect(harness.output.warn).not.toHaveBeenCalled();
	});

	it('admits a protected failure only under its producing principal and logs no backend detail', async () => {
		const harness = createHarness({ accountId: 'account-a', authType: 'aad' });
		harness.setProtected(true);
		harness.getDatabases.mockRejectedValue(new Error('Database SecretLedger object PrivateCustomers failed'));

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledWith(
			harness.getConnection(), expect.any(String), 3, true, expect.any(Function),
		);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({ error: 'Database SecretLedger object PrivateCustomers failed' }),
		]);
		expect(harness.output.warn).toHaveBeenCalledWith('[sql-lnt] Isolated database discovery failed.');
		expect(harness.output.warn.mock.calls.flat().join('\n')).not.toContain('SecretLedger');
		expect(harness.output.warn.mock.calls.flat().join('\n')).not.toContain('PrivateCustomers');
	});

	it('publishes a protected first-AAD cleanup failure under the newly established principal', async () => {
		const harness = createHarness({ authType: 'aad' });
		harness.setProtected(true);
		const cleanupFailure = new Error('protected cleanup failed');
		harness.getDatabasesWithIdentity.mockImplementationOnce(async () => {
			harness.setAccountId('account-a');
			const principalFingerprint = sqlSchemaPrincipalFingerprint(
				harness.context as any,
				harness.getConnection(),
			);
			if (!principalFingerprint) throw new Error('Expected the established SQL principal.');
			throw new SqlDatabaseDiscoveryOwnerError(cleanupFailure, {
				principalFingerprint,
				revocationGeneration: 3,
				expectedProtected: true,
			});
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({ error: 'protected cleanup failed' }),
		]);
		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledWith(
			harness.getConnection(), expect.any(String), 3, true, expect.any(Function),
		);
		expect(harness.output.warn).toHaveBeenCalledWith('[sql-lnt] Isolated database discovery failed.');
	});

	it('publishes a protected ownerless first-AAD loser error under the canonical winner', async () => {
		const harness = createHarness({ authType: 'aad' });
		harness.setProtected(true);
		harness.getDatabasesWithIdentity.mockImplementationOnce(async () => {
			harness.setAccountId('account-a');
			throw new SqlDatabaseDiscoveryOwnerError(new Error('Sign-in cancelled'), undefined);
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({ error: 'Sign-in cancelled' }),
		]);
		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledWith(
			harness.getConnection(), expect.any(String), 3, true, expect.any(Function),
		);
		expect(harness.output.warn).toHaveBeenCalledWith('[sql-lnt] Isolated database discovery failed.');
	});

	it('publishes a fixed terminal when protected canonical principal recovery is blocked', async () => {
		const harness = createHarness({ authType: 'aad' });
		harness.setProtected(true);
		harness.getDatabasesWithIdentity.mockRejectedValueOnce(
			new SqlDatabaseDiscoveryOwnerError(new Error('account state unavailable'), undefined),
		);
		harness.globalState.get.mockImplementation((key: string) => {
			if (key === 'sql.auth.serverAccountMap') throw new Error('account map recovery blocked');
			if (key === 'sql.connectionManager.cachedDatabases') return { ...harness.cachedDatabases };
			return undefined;
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
		expect(harness.output.warn.mock.calls.flat().join('\n')).not.toContain('account map recovery blocked');
	});

	it('adopts first AAD establishment between protected terminal transport attempts', async () => {
		const retry = deferred<void>();
		const harness = createHarness({
			authType: 'aad',
			waitForDeliveryRetry: () => retry.promise,
		});
		harness.setProtected(true);
		harness.getDatabasesWithIdentity.mockRejectedValueOnce(
			new SqlDatabaseDiscoveryOwnerError(new Error('Sign-in cancelled'), undefined),
		);
		let errorAttempts = 0;
		harness.postMessage.mockImplementation(async (outbound: any) => {
			if (outbound.type !== 'sqlDatabasesError') return true;
			errorAttempts += 1;
			return errorAttempts > 1;
		});

		const request = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(errorAttempts).toBe(1));
		harness.setAccountId('account-a');
		retry.resolve();
		await request;

		expect(errorAttempts).toBe(2);
		const fingerprint = sqlSchemaPrincipalFingerprintForPrincipal(
			harness.getConnection(),
			'account-a',
		)!;
		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenLastCalledWith(
			harness.getConnection(), fingerprint, 3, true, expect.any(Function),
		);
	});

	it('adopts first AAD establishment after protected terminal admission rejects', async () => {
		const retry = deferred<void>();
		const harness = createHarness({
			authType: 'aad',
			waitForDeliveryRetry: () => retry.promise,
		});
		harness.setProtected(true);
		harness.getDatabasesWithIdentity.mockRejectedValueOnce(
			new SqlDatabaseDiscoveryOwnerError(new Error('Sign-in cancelled'), undefined),
		);
		const realDispatch = harness.workbench.dispatchSqlOwnerProtection.getMockImplementation()!;
		harness.workbench.dispatchSqlOwnerProtection
			.mockRejectedValueOnce(lockContentionError())
			.mockImplementation(realDispatch);

		const request = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledOnce());
		harness.setAccountId('account-a');
		retry.resolve();
		await request;

		const fingerprint = sqlSchemaPrincipalFingerprintForPrincipal(
			harness.getConnection(),
			'account-a',
		)!;
		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledTimes(2);
		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenLastCalledWith(
			harness.getConnection(), fingerprint, 3, true, expect.any(Function),
		);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({ error: 'Sign-in cancelled' }),
		]);
	});

	it('suppresses protected data retry when AAD rotates after the first delivery attempt', async () => {
		const harness = createHarness({ accountId: 'account-a', authType: 'aad' });
		harness.setProtected(true);
		harness.getDatabases.mockResolvedValue(['AccountASecretDb']);
		let dataAttempts = 0;
		harness.postMessage.mockImplementation(async (outbound: any) => {
			if (outbound.type !== 'sqlDatabasesData') return true;
			dataAttempts += 1;
			if (dataAttempts === 1) {
				harness.setAccountId('account-b');
				harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
				return false;
			}
			return true;
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(dataAttempts).toBe(1);
		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledOnce();
		expect(messagesOfType(harness, 'sqlDatabasesData')).toHaveLength(1);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
	});

	it('suppresses protected error retry when the same connection ID is repointed after the first attempt', async () => {
		const harness = createHarness();
		harness.setProtected(true);
		harness.getDatabases.mockRejectedValue(new Error('OldTargetSecretDb failed'));
		let errorAttempts = 0;
		harness.postMessage.mockImplementation(async (outbound: any) => {
			if (outbound.type !== 'sqlDatabasesError') return true;
			errorAttempts += 1;
			if (errorAttempts === 1) {
				harness.setConnection({ ...harness.getConnection(), serverUrl: 'replacement.example' });
				harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
				return false;
			}
			return true;
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(errorAttempts).toBe(1);
		expect(harness.workbench.dispatchSqlOwnerProtection).toHaveBeenCalledOnce();
		expect(messagesOfType(harness, 'sqlDatabasesError')).toHaveLength(1);
		expect(harness.output.warn).not.toHaveBeenCalled();
	});

	it('does not publish databases when canonical owner admission rejects after discovery', async () => {
		const harness = createHarness();
		harness.getDatabases.mockResolvedValue(['SecretDb']);
		const retry = deferred<void>();
		const realDispatch = harness.workbench.dispatchSqlOwnerAllowed.getMockImplementation()!;
		harness.workbench.dispatchSqlOwnerAllowed
			.mockRejectedValueOnce(new Error('Leave No Trace committed'))
			.mockImplementation(realDispatch);
		(harness.handler as any).waitForDeliveryRetry = () => retry.promise;

		const request = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.workbench.dispatchSqlOwnerAllowed).toHaveBeenCalled());
		harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
		retry.resolve();
		await request;

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
	});

	it('allows first AAD discovery to establish the principal once', async () => {
		const harness = createHarness({ authType: 'aad' });
		harness.getDatabases.mockImplementation(async () => {
			harness.setAccountId('account-a');
			return ['DbA'];
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(harness.cachedDatabases.entries['sql-1']).toEqual(expect.objectContaining({
			version: 1,
			connectionId: 'sql-1',
			databases: ['DbA'],
			principalFingerprint: expect.any(String),
			targetSignature: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
		}));
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ databases: ['DbA'] }),
		]);
	});

	it('lets concurrent pending-AAD sections adopt one first established principal', async () => {
		const harness = createHarness({ authType: 'aad' });
		harness.lifecycle.openSection('sql-box-2', 'instance-sql-box-2');
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? first.promise : second.promise));

		const firstRun = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const secondRun = handle(harness.handler, message('refreshSqlDatabases', {
			boxId: 'sql-box-2',
			sectionInstanceId: 'instance-sql-box-2',
		}));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));

		harness.setAccountId('account-a');
		first.resolve(['SharedDb']);
		second.resolve(['SharedDb']);
		await Promise.all([firstRun, secondRun]);

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual(expect.arrayContaining([
			expect.objectContaining({ boxId: 'sql-box', databases: ['SharedDb'] }),
			expect.objectContaining({ boxId: 'sql-box-2', databases: ['SharedDb'] }),
		]));
		expect(messagesOfType(harness, 'sqlDatabasesData')).toHaveLength(2);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
	});

	it('publishes an ownerless concurrent first-AAD loser error after canonical adoption despite a stale mirror', async () => {
		const harness = createHarness({ authType: 'aad' });
		const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(
			harness.getConnection(),
			'account-a',
		)!;
		harness.connectionManager.assertConnectionCurrent.mockResolvedValue(undefined);
		harness.getDatabasesWithIdentity.mockRejectedValueOnce(
			new SqlDatabaseDiscoveryOwnerError(new Error('Sign-in cancelled'), undefined),
		);
		let currentPrincipalReads = 0;
		const originalGet = harness.globalState.get.getMockImplementation()!;
		harness.globalState.get.mockImplementation((key: string) => {
			if (key === 'sql.auth.serverAccountMap') {
				currentPrincipalReads += 1;
				return currentPrincipalReads === 1
					? undefined
					: { 'server.example': 'account-a' };
			}
			return originalGet(key);
		});
		harness.workbench.dispatchSqlOwnerAllowed.mockImplementation(async (
			connection: unknown,
			principal: string,
			revocation: number,
			dispatch: () => unknown,
		) => {
			expect(principal).toBe(principalFingerprint);
			return await dispatch();
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({ error: 'Sign-in cancelled' }),
		]);
	});

	it('admits only the newest overlapping request for an unchanged target', async () => {
		const harness = createHarness();
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? first.promise : second.promise));

		const firstRun = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const secondRun = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));
		first.resolve(['OldDb']);
		await firstRun;

		expect(harness.cachedDatabases.entries).toEqual({});
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);

		second.resolve(['CurrentDb']);
		await secondRun;
		const loading = messagesOfType(harness, 'sqlDatabasesLoading');
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ requestId: loading[1].requestId, databases: ['CurrentDb'] }),
		]);
		expect(harness.cachedDatabases.entries['sql-1']).toEqual(
			expect.objectContaining({ databases: ['CurrentDb'] }),
		);
	});

	it('publishes independently current same-connection sections when only one cache request wins', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('sql-box-2', 'instance-sql-box-2');
		const first = deferred<string[]>();
		const second = deferred<string[]>();
		let invocation = 0;
		harness.getDatabases.mockImplementation(() => (++invocation === 1 ? first.promise : second.promise));

		const firstRun = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(1));
		const secondRun = handle(harness.handler, message('refreshSqlDatabases', {
			boxId: 'sql-box-2',
			sectionInstanceId: 'instance-sql-box-2',
		}));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledTimes(2));

		first.resolve(['SharedDb']);
		await firstRun;
		second.resolve(['SharedDb']);
		await secondRun;

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual(expect.arrayContaining([
			expect.objectContaining({ boxId: 'sql-box', databases: ['SharedDb'] }),
			expect.objectContaining({ boxId: 'sql-box-2', databases: ['SharedDb'] }),
		]));
		expect(messagesOfType(harness, 'sqlDatabasesData')).toHaveLength(2);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
		expect(harness.output.warn).toHaveBeenCalledWith(
			'[sql-database-cache] Failed to update SQL database cache; publishing current discovery without caching.',
		);
	});

	it('continues with live discovery when the owned cache cannot be read', async () => {
		const cacheFailure = new Error('cache lock unavailable');
		const harness = createHarness({
			cacheOverrides: {
				getOwnedEntry: vi.fn(async () => { throw cacheFailure; }),
			},
		});
		harness.getDatabases.mockResolvedValue(['LiveDb']);

		await handle(harness.handler, message('getSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ databases: ['LiveDb'] }),
		]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
		expect(harness.output.warn).toHaveBeenCalledWith(
			'[sql-database-cache] Failed to read SQL database cache; continuing with live discovery.',
		);
	});

	it.each(['legacy-array', 'principal-mismatch', 'target-mismatch'] as const)(
		'ignores an unowned %s cache and performs guarded discovery',
		async cacheKind => {
			const harness = createHarness();
			if (cacheKind === 'legacy-array') {
				harness.cachedDatabases['sql-1'] = ['StaleDb'];
			} else {
				harness.cachedDatabases.schemaVersion = 1;
				harness.cachedDatabases.version = 1;
				harness.cachedDatabases.entries = {
					'sql-1': {
						version: 1,
						connectionId: 'sql-1',
						targetSignature: cacheKind === 'target-mismatch' ? 'stale-target' : JSON.stringify({
							dialect: 'mssql', serverUrl: 'server.example', port: 1433,
							database: 'master', authType: 'sql-login', username: 'user-a',
						}),
						principalFingerprint: cacheKind === 'principal-mismatch' ? 'stale-principal' : 'unused',
						databases: ['StaleDb'],
						writeId: 'stale-write',
						requestId: 'stale-request',
						requestVersion: 1,
						updatedAt: Date.now(),
					},
				};
				harness.cachedDatabases.latestRequestByConnectionId = {
					'sql-1': { requestId: 'stale-request', version: 1 },
				};
				harness.cachedDatabases.deletedAtVersionByConnectionId = {};
				harness.cachedDatabases.clearedAtVersion = 0;
			}
			harness.getDatabases.mockResolvedValue(['FreshDb']);

			await handle(harness.handler, message('getSqlDatabases'));

			expect(harness.getDatabases).toHaveBeenCalledOnce();
			expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
				expect.objectContaining({ databases: ['FreshDb'] }),
			]);
			expect(harness.cachedDatabases.entries['sql-1']).toEqual(
				expect.objectContaining({ databases: ['FreshDb'] }),
			);
		},
	);

	it.each(['edited', 'deleted', 'principal-rotated', 'generation-changed', 'section-replaced'] as const)(
		'drops metadata when its owner is %s',
		async change => {
			const harness = createHarness();
			const pending = deferred<string[]>();
			harness.getDatabases.mockReturnValue(pending.promise);
			const run = handle(harness.handler, message('refreshSqlDatabases'));
			await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());
			if (change === 'edited') harness.setConnection({ ...harness.getConnection(), database: 'OtherDb' });
			if (change === 'deleted') harness.setConnection(undefined);
			if (change === 'principal-rotated') harness.setConnection({ ...harness.getConnection(), username: 'user-b' });
			if (change === 'generation-changed') {
				harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
			}
			if (change === 'section-replaced') harness.lifecycle.openSection('sql-box', 'replacement-instance');
			pending.resolve(['StaleDb']);
			await run;

			expect(harness.cachedDatabases.entries).toEqual({});
			expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
			if (change === 'edited' || change === 'deleted' || change === 'principal-rotated') {
				expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
					expect.objectContaining({
						error: 'SQL database request ownership changed. Refresh and try again.',
					}),
				]);
			} else {
				expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
			}
		},
	);

	it('falls back to the owned cache and warns when explicit refresh fails', async () => {
		const harness = createHarness();
		const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
		harness.getDatabases.mockResolvedValueOnce(['CachedDb']);
		await handle(harness.handler, message('refreshSqlDatabases'));

		harness.postMessage.mockClear();
		harness.getDatabases.mockRejectedValueOnce(new Error('backend unavailable'));
		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ databases: ['CachedDb'] }),
		]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
		expect(showWarningMessage).toHaveBeenCalledWith(
			'Failed to refresh SQL database list. Using cached list.',
		);
		expect(harness.output.error).toHaveBeenCalledWith(expect.stringContaining('backend unavailable'));
	});

	it('never publishes an Account A cache after Account B discovery failure', async () => {
		const harness = createHarness({ accountId: 'account-a', authType: 'aad' });
		harness.getDatabases.mockResolvedValueOnce(['AccountADb']);
		await handle(harness.handler, message('refreshSqlDatabases'));
		harness.postMessage.mockClear();

		harness.getDatabasesWithIdentity.mockImplementationOnce(async () => {
			harness.setAccountId('account-b');
			const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(
				harness.getConnection(),
				'account-b',
			)!;
			throw new SqlDatabaseDiscoveryOwnerError(new Error('Account B discovery failed'), {
				principalFingerprint,
				revocationGeneration: 0,
				expectedProtected: false,
			});
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
	});

	it('publishes an exact terminal and actionable notification when no cache can recover discovery', async () => {
		const harness = createHarness();
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
		harness.getDatabases.mockRejectedValue(new Error('backend unavailable'));

		await handle(harness.handler, message('refreshSqlDatabases'));

		const loading = messagesOfType(harness, 'sqlDatabasesLoading')[0];
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				requestId: loading.requestId,
				error: 'backend unavailable',
			}),
		]);
		expect(showErrorMessage).toHaveBeenCalledWith(
			'Failed to load SQL database list: backend unavailable',
		);
		expect(harness.output.error).toHaveBeenCalledWith(expect.stringContaining('backend unavailable'));
	});

	it('logs no ordinary backend detail when final logging owner admission fails', async () => {
		const harness = createHarness();
		harness.getDatabases.mockRejectedValue(
			new Error('Database SecretLedger object PrivateCustomers failed'),
		);
		let ownerAdmissions = 0;
		const realDispatch = harness.workbench.dispatchSqlOwnerAllowed.getMockImplementation()!;
		harness.workbench.dispatchSqlOwnerAllowed.mockImplementation(async (...args: any[]) => {
			ownerAdmissions += 1;
			if (ownerAdmissions === 1) {
				harness.setConnection({ ...harness.getConnection(), username: 'user-b' });
			}
			return await realDispatch(...args);
		});

		await handle(harness.handler, message('refreshSqlDatabases'));

		const durableLog = [
			...harness.output.error.mock.calls,
			...harness.output.warn.mock.calls,
		].flat().join('\n');
		expect(durableLog).toContain('[sql-database] SQL database discovery failed after its owner changed.');
		expect(durableLog).not.toContain('SecretLedger');
		expect(durableLog).not.toContain('PrivateCustomers');
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
	});

	it('reconciles a Leave No Trace transition with a fixed terminal when the ticket remains current', async () => {
		const harness = createHarness();
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);
		const request = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());

		harness.setProtected(true);
		pending.resolve(['MustNotPublish']);
		await request;

		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
	});

	it('contains logger and notification failures while preserving the discovery terminal', async () => {
		const harness = createHarness();
		harness.getDatabases.mockRejectedValue(new Error('backend unavailable'));
		harness.output.error.mockImplementation(() => { throw new Error('logger failed'); });
		vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(() => {
			throw new Error('notification failed');
		});

		await expect(handle(harness.handler, message('refreshSqlDatabases'))).resolves.toBeUndefined();
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({ error: 'backend unavailable' }),
		]);
	});

	it('settles accepted work across idempotent disposal and suppresses later discovery', async () => {
		const harness = createHarness();
		const pending = deferred<string[]>();
		harness.getDatabases.mockReturnValue(pending.promise);
		const request = handle(harness.handler, message('refreshSqlDatabases'));
		await vi.waitFor(() => expect(harness.getDatabases).toHaveBeenCalledOnce());

		harness.handler.dispose();
		harness.handler.dispose();
		pending.resolve(['LateDb']);
		await expect(request).resolves.toBeUndefined();
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([]);
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([]);
		expect(harness.cachedDatabases.entries).toEqual({});

		const adoptTarget = vi.spyOn(harness.lifecycle, 'adoptTarget');
		await expect(handle(harness.handler, message('getSqlDatabases'))).resolves.toBeUndefined();
		expect(adoptTarget).not.toHaveBeenCalled();
		expect(harness.getDatabases).toHaveBeenCalledOnce();
	});

	it('awaits and retries a rejected data delivery while the exact request remains current', async () => {
		const harness = createHarness();
		const failure = new Error('transport failed');
		harness.getDatabases.mockResolvedValue(['DbA']);
		let dataAttempts = 0;
		harness.postMessage.mockImplementation(async (outbound: any) => {
			if (outbound.type !== 'sqlDatabasesData') return true;
			dataAttempts += 1;
			if (dataAttempts === 1) throw failure;
			return true;
		});

		await expect(handle(harness.handler, message('refreshSqlDatabases'))).resolves.toBeUndefined();

		expect(dataAttempts).toBe(2);
		expect(messagesOfType(harness, 'sqlDatabasesData')).toHaveLength(2);
	});

	it('retries transient data owner-admission rejection to successful delivery', async () => {
		const retry = deferred<void>();
		const harness = createHarness({ waitForDeliveryRetry: () => retry.promise });
		harness.getDatabases.mockResolvedValue(['DbA']);
		const realDispatch = harness.workbench.dispatchSqlOwnerAllowed.getMockImplementation()!;
		harness.workbench.dispatchSqlOwnerAllowed
			.mockRejectedValueOnce(lockContentionError())
			.mockImplementation(realDispatch);
		let settled = false;

		const request = handle(harness.handler, message('refreshSqlDatabases'));
		void request.finally(() => { settled = true; });
		await vi.waitFor(() => expect(harness.workbench.dispatchSqlOwnerAllowed).toHaveBeenCalledOnce());
		expect(settled).toBe(false);
		retry.resolve();

		await expect(request).resolves.toBeUndefined();
		expect(harness.workbench.dispatchSqlOwnerAllowed).toHaveBeenCalledTimes(2);
		expect(messagesOfType(harness, 'sqlDatabasesData')).toEqual([
			expect.objectContaining({ databases: ['DbA'] }),
		]);
	});

	it('awaits and retries a delayed false data delivery', async () => {
		const harness = createHarness();
		harness.getDatabases.mockResolvedValue(['DbA']);
		const firstDelivery = deferred<boolean>();
		let dataAttempts = 0;
		harness.postMessage.mockImplementation((outbound: any) => {
			if (outbound.type !== 'sqlDatabasesData') return Promise.resolve(true);
			dataAttempts += 1;
			return dataAttempts === 1 ? firstDelivery.promise : Promise.resolve(true);
		});

		let settled = false;
		const request = handle(harness.handler, message('refreshSqlDatabases'));
		void request.finally(() => { settled = true; });
		await vi.waitFor(() => expect(dataAttempts).toBe(1));
		expect(settled).toBe(false);
		firstDelivery.resolve(false);

		await expect(request).resolves.toBeUndefined();
		expect(dataAttempts).toBe(2);
	});

	it('keeps retrying exhausted data delivery until the exact request retires', async () => {
		const retries: Array<ReturnType<typeof deferred<void>>> = [];
		const harness = createHarness({
			waitForDeliveryRetry: () => {
				const retry = deferred<void>();
				retries.push(retry);
				return retry.promise;
			},
		});
		harness.getDatabases.mockResolvedValue(['DbA']);
		harness.postMessage.mockImplementation(async (outbound: any) =>
			outbound.type !== 'sqlDatabasesData');

		let settled = false;
		const request = handle(harness.handler, message('refreshSqlDatabases'));
		void request.finally(() => { settled = true; });
		await vi.waitFor(() => expect(retries).toHaveLength(1));
		expect(settled).toBe(false);
		retries[0].resolve();
		await vi.waitFor(() => expect(retries).toHaveLength(2));
		expect(messagesOfType(harness, 'sqlDatabasesData')).toHaveLength(2);
		harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
		retries[1].resolve();

		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('keeps retrying exhausted error delivery until the exact request retires', async () => {
		const retries: Array<ReturnType<typeof deferred<void>>> = [];
		const harness = createHarness({
			waitForDeliveryRetry: () => {
				const retry = deferred<void>();
				retries.push(retry);
				return retry.promise;
			},
		});
		harness.getDatabases.mockRejectedValue(new Error('backend unavailable'));
		harness.postMessage.mockImplementation(async (outbound: any) =>
			outbound.type !== 'sqlDatabasesError');

		let settled = false;
		const request = handle(harness.handler, message('refreshSqlDatabases'));
		void request.finally(() => { settled = true; });
		await vi.waitFor(() => expect(retries).toHaveLength(1));
		expect(settled).toBe(false);
		retries[0].resolve();
		await vi.waitFor(() => expect(retries).toHaveLength(2));
		expect(messagesOfType(harness, 'sqlDatabasesError')).toHaveLength(2);
		harness.lifecycle.adoptTarget('sql-box', 'instance-sql-box', 'sql-1', undefined, 8);
		retries[1].resolve();

		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it('reconciles permanent error owner-admission rejection immediately', async () => {
		const harness = createHarness();
		harness.getDatabases.mockRejectedValue(new Error('backend unavailable'));
		harness.workbench.dispatchSqlOwnerAllowed.mockRejectedValue(new Error('owner lock unavailable'));

		await expect(handle(harness.handler, message('refreshSqlDatabases'))).resolves.toBeUndefined();
		expect(messagesOfType(harness, 'sqlDatabasesError')).toEqual([
			expect.objectContaining({
				error: 'SQL database request ownership changed. Refresh and try again.',
			}),
		]);
	});
});