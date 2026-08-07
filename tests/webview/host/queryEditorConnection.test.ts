import { afterEach, describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	ensureHttpsUrl,
	getDefaultConnectionName,
	getClusterShortName,
	getClusterShortNameKey,
	getClusterCacheKey,
	normalizeFavoriteClusterUrl,
	ConnectionService
} from '../../../src/host/queryEditorConnection';
import { STORAGE_KEYS } from '../../../src/host/queryEditorTypes';
import { databaseListTraceRef } from '../../../src/host/databaseListTrace';
import { KustoConnectionCache } from '../../../src/host/kustoConnectionCache';

afterEach(() => {
	vi.restoreAllMocks();
	(ConnectionService as any).liveServices?.clear?.();
	(ConnectionService as any).zeroResultRecoveryByCluster?.clear?.();
	(ConnectionService as any).databaseCacheSettlementByCluster?.clear?.();
});

describe('ensureHttpsUrl', () => {
	it('empty string → empty string', () => {
		expect(ensureHttpsUrl('')).toBe('');
	});

	it('bare hostname → https:// prepended', () => {
		expect(ensureHttpsUrl('mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('http:// prefix is kept', () => {
		expect(ensureHttpsUrl('http://mycluster.kusto.windows.net')).toBe('http://mycluster.kusto.windows.net');
	});

	it('https:// prefix is kept unchanged', () => {
		expect(ensureHttpsUrl('https://mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('whitespace is trimmed before adding scheme', () => {
		expect(ensureHttpsUrl('  mycluster  ')).toBe('https://mycluster');
	});

	it('preserves original casing when scheme is present', () => {
		expect(ensureHttpsUrl('HTTPS://MyCluster')).toBe('HTTPS://MyCluster');
	});

	it('leading slashes are stripped before prepending scheme', () => {
		expect(ensureHttpsUrl('///mycluster')).toBe('https://mycluster');
	});
});

describe('getDefaultConnectionName', () => {
	it('returns hostname for standard cluster URL', () => {
		expect(getDefaultConnectionName('https://mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('empty string → fallback "Kusto Cluster"', () => {
		expect(getDefaultConnectionName('')).toBe('Kusto Cluster');
	});

	it('bare hostname → adds https:// then extracts hostname', () => {
		expect(getDefaultConnectionName('mycluster.kusto.windows.net')).toBe('mycluster.kusto.windows.net');
	});

	it('URL with path → returns only hostname', () => {
		expect(getDefaultConnectionName('https://mycluster.kusto.windows.net/some/path')).toBe('mycluster.kusto.windows.net');
	});
});

describe('getClusterShortName', () => {
	it('standard cluster URL → first hostname part', () => {
		expect(getClusterShortName('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('multi-part hostname → first part only', () => {
		expect(getClusterShortName('https://mycluster.eastus2.kusto.windows.net')).toBe('mycluster');
	});

	it('bare hostname → first part', () => {
		expect(getClusterShortName('mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('single-word (no dots) → returned as-is', () => {
		expect(getClusterShortName('mycluster')).toBe('mycluster');
	});
});

describe('getClusterShortNameKey', () => {
	it('lowercases the short name', () => {
		expect(getClusterShortNameKey('https://MyCluster.kusto.windows.net')).toBe('mycluster');
	});

	it('already lowercase → unchanged', () => {
		expect(getClusterShortNameKey('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('empty input → empty string', () => {
		expect(getClusterShortNameKey('')).toBe('');
	});

	it('bare hostname with mixed case → lowercased first part', () => {
		expect(getClusterShortNameKey('MyCluster.kusto.windows.net')).toBe('mycluster');
	});
});

describe('getClusterCacheKey', () => {
	it('standard URL → lowercase hostname', () => {
		expect(getClusterCacheKey('https://mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('mixed case + trailing slash → normalized', () => {
		expect(getClusterCacheKey('HTTPS://MyCluster.KUSTO.Windows.NET/')).toBe('mycluster');
	});

	it('no scheme → adds https:// first, then normalizes', () => {
		expect(getClusterCacheKey('mycluster.kusto.windows.net')).toBe('mycluster');
	});

	it('regional short and full public ADX host produce the same key', () => {
		expect(getClusterCacheKey('aoaiagents1.westus')).toBe('aoaiagents1.westus');
		expect(getClusterCacheKey('https://aoaiagents1.westus.kusto.windows.net')).toBe('aoaiagents1.westus');
	});

	it('empty input → empty string', () => {
		expect(getClusterCacheKey('')).toBe('');
	});

	it('whitespace → trimmed to empty', () => {
		expect(getClusterCacheKey('   ')).toBe('');
	});
});

describe('normalizeFavoriteClusterUrl', () => {
	it('bare hostname → https:// prepended', () => {
		expect(normalizeFavoriteClusterUrl('mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('trailing slash is removed', () => {
		expect(normalizeFavoriteClusterUrl('https://mycluster.kusto.windows.net/')).toBe('https://mycluster.kusto.windows.net');
	});

	it('whitespace is trimmed', () => {
		expect(normalizeFavoriteClusterUrl('  https://mycluster  ')).toBe('https://mycluster');
	});

	it('empty input → empty string', () => {
		expect(normalizeFavoriteClusterUrl('')).toBe('');
	});

	it('multiple trailing slashes are removed', () => {
		expect(normalizeFavoriteClusterUrl('https://mycluster///')).toBe('https://mycluster');
	});
});

// ── ConnectionService ─────────────────────────────────────────────────────────

function makeMockHost(overrides: Partial<Record<string, any>> = {}) {
	const globalState = overrides.globalState ?? new Map<string, any>();
	const getDatabases = overrides.getDatabases ?? (async () => []);
	return {
		connectionManager: {
			getConnections: overrides.getConnections ?? (() => overrides.connections ?? []),
			getConnectionIncarnation: overrides.getConnectionIncarnation ?? (() => 0),
			normalizeClusterUrl: (url: string) => String(url || '').toLowerCase(),
			getLeaveNoTraceClusters: overrides.getLeaveNoTraceClusters ?? (() => []),
			isLeaveNoTraceRecoveryBlocked: overrides.isLeaveNoTraceRecoveryBlocked ?? (() => false),
			refreshLeaveNoTracePolicy: overrides.refreshLeaveNoTracePolicy ?? (async () => undefined),
			runWithLeaveNoTraceSnapshotLock: overrides.runWithLeaveNoTraceSnapshotLock ?? (async (run: (snapshot: any) => unknown) => await run({
				clusterKeys: [], globallyBlocked: false, version: 1,
			})),
		},
		context: {
			globalState: {
				get: <T>(key: string, fallback?: T) => globalState.has(key) ? globalState.get(key) : fallback,
				update: async (key: string, value: any) => { globalState.set(key, value); },
			},
		},
		kustoClient: {
			getDatabases,
			getDatabasesWithIdentity: overrides.getDatabasesWithIdentity ?? (async (...args: any[]) => ({
				databases: await getDatabases(...args),
				accountPartition: 'test-partition',
				fromCache: false,
			})),
			getAccountPartition: overrides.getAccountPartition ?? (() => 'test-partition'),
			withTransientAuthPreference: overrides.withTransientAuthPreference ?? (async (_connection: unknown, _preference: unknown, operation: () => Promise<unknown>) => operation()),
			isAuthenticationError: overrides.isAuthenticationError ?? (() => false),
			reauthenticate: overrides.reauthenticate ?? (async () => undefined),
		},
		output: overrides.output ?? { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {}, show: () => {} },
		postMessage: overrides.postMessage ?? (() => {}),
		formatQueryExecutionErrorForUser: () => 'error',
		normalizeClusterUrlKey: (url: string) => url.toLowerCase(),
		getCachedSchemaFromDisk: overrides.getCachedSchemaFromDisk ?? (async () => undefined),
		_globalState: globalState,
	};
}

describe('ConnectionService — shared privacy snapshot readiness', () => {
	it('waits for canonical Leave No Trace initialization before publishing connections', async () => {
		const policyReady = deferred<void>();
		const postMessage = vi.fn();
		const host = makeMockHost({
			connections: [{ id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' }],
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => {
				await policyReady.promise;
				return await run({ clusterKeys: ['cluster'], globallyBlocked: false, version: 2 });
			}),
			postMessage,
		});
		const service = new ConnectionService(host as any);
		(service as any).authPreferences = { getAccounts: vi.fn(async () => []) };
		const publish = service.sendConnectionsData({
			caretDocsEnabled: true,
			caretDocsEnabledUserSet: false,
			autoTriggerAutocompleteEnabled: true,
			autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: true,
			copilotInlineCompletionsEnabledUserSet: false,
			editingPreferencesRevision: 1,
			copilotChatFirstTimeDismissed: false,
			connectionsRevision: 1,
		});

		await Promise.resolve();
		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'connectionsData' }));

		policyReady.resolve();
		await publish;
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'connectionsData', leaveNoTraceClusters: ['cluster'], leaveNoTraceGloballyBlocked: false,
		}));
		service.dispose();
	});

	it('holds canonical policy admission through connectionsData delivery', async () => {
		const delivery = deferred<boolean>();
		let lockHeld = false;
		let deliveryInsideLock = false;
		const postMessage = vi.fn((message: any) => {
			if (message?.type === 'connectionsData') {
				deliveryInsideLock = lockHeld;
				return delivery.promise;
			}
			return true;
		});
		const host = makeMockHost({
			connections: [{ id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' }],
			runWithLeaveNoTraceSnapshotLock: vi.fn(async (run: (snapshot: any) => unknown) => {
				lockHeld = true;
				try { return await run({ clusterKeys: [], globallyBlocked: false, version: 1 }); }
				finally { lockHeld = false; }
			}),
			postMessage,
		});
		(host as any).postKustoPublication = vi.fn(async (message: unknown) => await Promise.resolve(postMessage(message)) !== false);
		const service = new ConnectionService(host as any);
		(service as any).authPreferences = { getAccounts: vi.fn(async () => []) };

		const publish = service.sendConnectionsData({
			caretDocsEnabled: true, caretDocsEnabledUserSet: false,
			autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
			editingPreferencesRevision: 1, copilotChatFirstTimeDismissed: false, connectionsRevision: 3,
			policyRequestId: 'policy-request-3',
		});
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'connectionsData' })));
		expect(deliveryInsideLock).toBe(true);
		expect(lockHeld).toBe(true);
		delivery.resolve(true);
		await publish;
		expect(lockHeld).toBe(false);
		expect((host as any).postKustoPublication).toHaveBeenCalledOnce();
		service.dispose();
	});

	it('retries a rejected correlated policy snapshot with the same request ID and fresh admission', async () => {
		let snapshotVersion = 0;
		const runWithLeaveNoTraceSnapshotLock = vi.fn(async (run: (snapshot: any) => unknown) => await run({
			clusterKeys: snapshotVersion++ === 0 ? ['first-policy'] : ['second-policy'],
			globallyBlocked: false,
			version: snapshotVersion,
		}));
		const postKustoPublication = vi.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const host = makeMockHost({
			connections: [{ id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' }],
			runWithLeaveNoTraceSnapshotLock,
		});
		(host as any).postKustoPublication = postKustoPublication;
		const service = new ConnectionService(host as any);
		(service as any).authPreferences = { getAccounts: vi.fn(async () => []) };

		await service.sendConnectionsData({
			caretDocsEnabled: true, caretDocsEnabledUserSet: false,
			autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
			editingPreferencesRevision: 1, copilotChatFirstTimeDismissed: false, connectionsRevision: 4,
			policyRequestId: 'policy-request-retry',
		});

		expect(runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledTimes(2);
		expect(postKustoPublication).toHaveBeenCalledTimes(2);
		expect(postKustoPublication.mock.calls.map(call => call[0])).toEqual([
			expect.objectContaining({ policyRequestId: 'policy-request-retry', leaveNoTraceClusters: ['first-policy'] }),
			expect.objectContaining({ policyRequestId: 'policy-request-retry', leaveNoTraceClusters: ['second-policy'] }),
		]);
		service.dispose();
	});

	it('captures connection identity and account partition only after asynchronous snapshot refresh', async () => {
		const accountsReady = deferred<void>();
		let current = { id: 'c1', name: 'Old', clusterUrl: 'https://old.kusto.windows.net', authorityId: 'common' };
		const postMessage = vi.fn();
		const host = makeMockHost({
			getConnections: () => [current],
			getAccountPartition: (connection: any) => connection.clusterUrl.includes('new') ? 'partition-new' : 'partition-old',
			postMessage,
		});
		const service = new ConnectionService(host as any);
		(service as any).authPreferences = { getAccounts: vi.fn(async () => { await accountsReady.promise; return []; }) };

		const publish = service.sendConnectionsData({
			caretDocsEnabled: true, caretDocsEnabledUserSet: false,
			autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
			editingPreferencesRevision: 1, copilotChatFirstTimeDismissed: false, connectionsRevision: 2,
		});
		await Promise.resolve();
		current = { ...current, name: 'New', clusterUrl: 'https://new.kusto.windows.net', authorityId: 'organizations' };
		accountsReady.resolve();
		await publish;

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'connectionsData',
			connections: [expect.objectContaining({
				...current, accountPartition: 'partition-new', connectionRevision: 0,
				connectionIdentityKey: 'new|organizations',
			})],
		}));
		expect(JSON.stringify(postMessage.mock.calls)).not.toContain('https://old.kusto.windows.net');
		service.dispose();
	});
});

function wrappedDatabaseCancellation(): Error {
	const cancellation = Object.assign(new Error('Sign-in cancelled'), {
		name: 'QueryCancelledError',
		isCancelled: true,
	});
	return new Error('Failed to fetch databases: Sign-in cancelled', { cause: cancellation });
}

async function seedPrincipalDatabases(host: ReturnType<typeof makeMockHost>, databases: string[] = ['CachedDb']): Promise<void> {
	await new KustoConnectionCache(host.context as any).setDatabases('c1', 'test-partition', databases);
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('ConnectionService — saveLastSelection & getters', () => {
	it('saves and retrieves lastConnectionId', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.saveLastSelection('conn-123', 'mydb');
		expect(svc.getLastConnectionId()).toBe('conn-123');
		expect(svc.getLastDatabase()).toBe('mydb');
	});

	it('getLastConnectionId returns undefined before any selection', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getLastConnectionId()).toBeUndefined();
	});

	it('getLastDatabase returns undefined before any selection', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getLastDatabase()).toBeUndefined();
	});

	it('persists to globalState', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.saveLastSelection('conn-456', 'db2');
		expect(host._globalState.get(STORAGE_KEYS.lastConnectionId)).toBe('conn-456');
		expect(host._globalState.get(STORAGE_KEYS.lastDatabase)).toBe('db2');
	});
});

describe('ConnectionService — findConnection', () => {
	it('finds connection by id', () => {
		const conn = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const host = makeMockHost({ connections: [conn] });
		const svc = new ConnectionService(host as any);
		expect(svc.findConnection('c1')).toBe(conn);
	});

	it('returns undefined for unknown id', () => {
		const host = makeMockHost({ connections: [] });
		const svc = new ConnectionService(host as any);
		expect(svc.findConnection('nonexistent')).toBeUndefined();
	});
});

describe('ConnectionService — database request identity', () => {
	it('allows an explicit refresh to acquire a missing account interactively', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const postMessage = vi.fn();
		const getDatabases = vi.fn(async (_connection: unknown, _refresh: boolean, options?: { allowInteractive?: boolean }) => {
			if (!options?.allowInteractive) {
				throw wrappedDatabaseCancellation();
			}
			return ['Db1'];
		});
		const host = makeMockHost({ connections: [connection], getDatabases, postMessage });
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'databases_refresh',
		});

		expect(getDatabases).toHaveBeenCalledWith(connection, true, expect.objectContaining({
			allowInteractive: true,
			source: 'query-editor',
			traceId: expect.any(String),
		}));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['Db1'],
			requestToken: 'databases_refresh',
			authoritative: true,
			fallback: false,
		}));
	});

	it('keeps required-database discovery silent and falls back without reauthenticating', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const authError = Object.assign(new Error('Forbidden'), { statusCode: 403 });
		const getDatabases = vi.fn(async () => { throw authError; });
		const reauthenticate = vi.fn(async () => undefined);
		const postMessage = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorNotification = vi.spyOn(vscode.window, 'showErrorMessage');
		const information = vi.spyOn(vscode.window, 'showInformationMessage');
		const host = makeMockHost({
			connections: [connection],
			globalState,
			getDatabases,
			reauthenticate,
			postMessage,
			isAuthenticationError: (error: unknown) => error === authError,
		});
		await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'passive',
			requestToken: 'databases_required',
			requiredDatabase: 'SavedDb',
		});

		expect(getDatabases).toHaveBeenCalledWith(connection, true, expect.objectContaining({ allowInteractive: false }));
		expect(reauthenticate).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
		expect(errorNotification).not.toHaveBeenCalled();
		expect(information).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['CachedDb'],
			requestToken: 'databases_required',
			authoritative: false,
			fallback: true,
		}));
	});

	it.each([
		{ label: 'authentication failure without cache', isAuthError: true, cached: false },
		{ label: 'network failure with cache', isAuthError: false, cached: true },
		{ label: 'network failure without cache', isAuthError: false, cached: false },
	])('keeps passive $label notification-free', async ({ isAuthError, cached }) => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const failure = Object.assign(new Error(isAuthError ? 'Forbidden' : 'Network unavailable'), isAuthError ? { statusCode: 403 } : {});
		const postMessage = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorNotification = vi.spyOn(vscode.window, 'showErrorMessage');
		const information = vi.spyOn(vscode.window, 'showInformationMessage');
		const host = makeMockHost({
			connections: [connection],
			globalState,
			getDatabases: vi.fn(async () => { throw failure; }),
			postMessage,
			isAuthenticationError: () => isAuthError,
		});
		if (cached) await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'passive',
			requestToken: `passive_${isAuthError}_${cached}`,
			...(cached ? { requiredDatabase: 'MissingDb' } : {}),
		});

		expect(warning).not.toHaveBeenCalled();
		expect(errorNotification).not.toHaveBeenCalled();
		expect(information).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining(cached ? {
			type: 'databasesData',
			databases: ['CachedDb'],
			fallback: true,
		} : {
			type: 'databasesError',
		}));
	});

	it('settles a passive no-cache authentication cancellation without notifications', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const postMessage = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorNotification = vi.spyOn(vscode.window, 'showErrorMessage');
		const host = makeMockHost({
			connections: [connection],
			getDatabases: vi.fn(async () => { throw wrappedDatabaseCancellation(); }),
			postMessage,
		});
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'passive',
			requestToken: 'passive_cancelled',
		});

		expect(warning).not.toHaveBeenCalled();
		expect(errorNotification).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesError',
			requestToken: 'passive_cancelled',
			error: 'Database load cancelled.',
		}));
	});

	it('treats a cancelled interactive refresh as terminal without another prompt', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const getDatabases = vi.fn(async () => { throw wrappedDatabaseCancellation(); });
		const reauthenticate = vi.fn(async () => undefined);
		const postMessage = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorNotification = vi.spyOn(vscode.window, 'showErrorMessage');
		const information = vi.spyOn(vscode.window, 'showInformationMessage');
		const host = makeMockHost({ connections: [connection], getDatabases, reauthenticate, postMessage });
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'databases_cancelled',
		});

		expect(reauthenticate).not.toHaveBeenCalled();
		expect(warning).not.toHaveBeenCalled();
		expect(errorNotification).not.toHaveBeenCalled();
		expect(information).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'databasesError',
			boxId: 'query_1',
			connectionId: 'c1',
			requestToken: 'databases_cancelled',
			error: 'Database refresh cancelled.',
		});
	});

	it('uses cached databases silently when an interactive refresh is cancelled', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const getDatabases = vi.fn(async () => { throw wrappedDatabaseCancellation(); });
		const postMessage = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage');
		const errorNotification = vi.spyOn(vscode.window, 'showErrorMessage');
		const host = makeMockHost({ connections: [connection], globalState, getDatabases, postMessage });
		await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'databases_cancelled_cached',
		});

		expect(warning).not.toHaveBeenCalled();
		expect(errorNotification).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['CachedDb'],
			requestToken: 'databases_cancelled_cached',
			authoritative: false,
			fallback: true,
		}));
	});

	it('does not classify a transport AbortError as user cancellation', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const transportAbort = Object.assign(new Error('Request aborted after transport timeout'), { name: 'AbortError' });
		const postMessage = vi.fn();
		const errorNotification = vi.spyOn(vscode.window, 'showErrorMessage');
		const host = makeMockHost({
			connections: [connection],
			getDatabases: vi.fn(async () => { throw transportAbort; }),
			postMessage,
		});
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'transport_abort',
		});

		expect(errorNotification).toHaveBeenCalledWith('Failed to refresh database list.', 'More Info');
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesError',
			requestToken: 'transport_abort',
			error: expect.stringContaining('Failed to refresh database list.'),
		}));
	});

	it.each([401, 403])('does not duplicate client-owned interactive recovery after status %s', async (statusCode) => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const authError = Object.assign(new Error('Authentication failed'), { statusCode });
		const getDatabases = vi.fn(async () => { throw authError; });
		const reauthenticate = vi.fn(async () => undefined);
		const postMessage = vi.fn();
		const accountChoice = vi.spyOn(vscode.window, 'showWarningMessage');
		const host = makeMockHost({
			connections: [connection],
			getDatabases,
			reauthenticate,
			postMessage,
			isAuthenticationError: (error: unknown) => error === authError,
		});
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: `databases_auth_${statusCode}`,
		});

		expect(getDatabases).toHaveBeenCalledTimes(1);
		expect(reauthenticate).not.toHaveBeenCalled();
		expect(accountChoice).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesError',
			requestToken: `databases_auth_${statusCode}`,
		}));
	});

	it('keeps a dismissed zero-result account choice as an authoritative empty result', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const getDatabases = vi.fn(async () => []);
		const reauthenticate = vi.fn(async () => undefined);
		const postMessage = vi.fn();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
		const host = makeMockHost({ connections: [connection], getDatabases, reauthenticate, postMessage });
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'databases_empty',
		});

		expect(reauthenticate).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: [],
			requestToken: 'databases_empty',
			authoritative: true,
			fallback: false,
		}));
	});

	it('keeps cached databases when a zero-result account choice is dismissed', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const postMessage = vi.fn();
		const accountChoice = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
		const host = makeMockHost({
			connections: [connection],
			globalState,
			getDatabases: vi.fn(async () => []),
			postMessage,
		});
		await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'cached_empty_dismissed',
		});

		expect(accountChoice).toHaveBeenCalledWith(
			'No databases are visible with the available accounts. Check the connection Authority / Tenant ID or choose an explicit account.',
			'Edit Connections'
		);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['CachedDb'],
			authoritative: false,
			fallback: true,
		}));
	});

	it('does not start a second account-switch loop after a zero result', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const getDatabases = vi.fn().mockResolvedValue([]);
		const reauthenticate = vi.fn(async () => undefined);
		const postMessage = vi.fn();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Edit Connections' as any);
		const host = makeMockHost({ connections: [connection], getDatabases, reauthenticate, postMessage });
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'databases_zero_fail_closed',
		});

		expect(reauthenticate).not.toHaveBeenCalled();
		expect(getDatabases).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: [],
			accountPartition: 'test-partition',
			authoritative: true,
			fallback: false,
		}));
	});

	it('keeps cached databases and does not switch accounts after a zero result', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const getDatabases = vi.fn().mockResolvedValue([]);
		const reauthenticate = vi.fn(async () => undefined);
		const postMessage = vi.fn();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
		const host = makeMockHost({ connections: [connection], globalState, getDatabases, reauthenticate, postMessage });
		await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'cached_empty_switched',
		});

		expect(reauthenticate).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['CachedDb'],
			authoritative: false,
			fallback: true,
		}));
		expect(svc.getCachedDatabases().c1).toEqual(['CachedDb']);
	});

	it('retains cached databases when the post-choice fetch fails', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const getDatabases = vi.fn()
			.mockResolvedValueOnce([])
			.mockRejectedValueOnce(new Error('Network unavailable'));
		const postMessage = vi.fn();
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce('Try another account' as any);
		const host = makeMockHost({
			connections: [connection],
			globalState,
			getDatabases,
			reauthenticate: vi.fn(async () => undefined),
			postMessage,
		});
		await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'cached_empty_fetch_failed',
		});

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['CachedDb'],
			authoritative: false,
			fallback: true,
		}));
		expect(svc.getCachedDatabases().c1).toEqual(['CachedDb']);
	});

	it('does not call legacy reauthentication after a zero result', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const getDatabases = vi.fn(async () => []);
		const reauthenticate = vi.fn(async () => { throw wrappedDatabaseCancellation(); });
		const postMessage = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);
		const errorNotification = vi.spyOn(vscode.window, 'showErrorMessage');
		const host = makeMockHost({ connections: [connection], getDatabases, reauthenticate, postMessage });
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'databases_choice_cancelled',
		});

		expect(warning).toHaveBeenCalledTimes(1);
		expect(reauthenticate).not.toHaveBeenCalled();
		expect(errorNotification).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			requestToken: 'databases_choice_cancelled',
			databases: [],
		}));
	});

	it('shares one zero-result account choice across concurrent same-cluster refreshes', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const choice = deferred<string | undefined>();
		const accountChoice = vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(choice.promise as any);
		const postMessage = vi.fn();
		const host = makeMockHost({
			connections: [connection],
			getDatabases: vi.fn(async () => []),
			postMessage,
		});
		const svc = new ConnectionService(host as any);

		const first = svc.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'concurrent_1',
		});
		const second = svc.sendDatabases('c1', 'query_2', {
			mode: 'interactive-refresh',
			requestToken: 'concurrent_2',
		});
		await vi.waitFor(() => expect(accountChoice).toHaveBeenCalledTimes(1));
		choice.resolve(undefined);
		await Promise.all([first, second]);

		const terminalMessages = postMessage.mock.calls
			.map(([message]) => message)
			.filter(message => message?.type === 'databasesData');
		expect(terminalMessages).toHaveLength(2);
		expect(terminalMessages.map(message => message.requestToken).sort()).toEqual(['concurrent_1', 'concurrent_2']);
	});

	it('does not share a post-auth database result across separate providers', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const choice = deferred<string | undefined>();
		const accountChoice = vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(choice.promise as any);
		const firstGetDatabases = vi.fn().mockResolvedValue([]);
		const secondGetDatabases = vi.fn().mockResolvedValue([]);
		const firstPostMessage = vi.fn();
		const secondPostMessage = vi.fn();
		const firstService = new ConnectionService(makeMockHost({
			connections: [connection],
			globalState,
			getDatabases: firstGetDatabases,
			reauthenticate: vi.fn(async () => undefined),
			postMessage: firstPostMessage,
		}) as any);
		const secondService = new ConnectionService(makeMockHost({
			connections: [connection],
			globalState,
			getDatabases: secondGetDatabases,
			reauthenticate: vi.fn(async () => undefined),
			postMessage: secondPostMessage,
		}) as any);

		const first = firstService.sendDatabases('c1', 'query_1', {
			mode: 'interactive-refresh',
			requestToken: 'provider_1',
		});
		await Promise.resolve();
		const second = secondService.sendDatabases('c1', 'query_2', {
			mode: 'interactive-refresh',
			requestToken: 'provider_2',
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(accountChoice).toHaveBeenCalledTimes(1);
		choice.resolve(undefined);
		await Promise.all([first, second]);

		expect(firstGetDatabases).toHaveBeenCalledTimes(1);
		expect(secondGetDatabases).toHaveBeenCalledTimes(1);
		for (const postMessage of [firstPostMessage, secondPostMessage]) {
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
				type: 'databasesData',
				databases: [],
				authoritative: true,
				fallback: false,
			}));
		}
		expect(globalState.get(STORAGE_KEYS.cachedDatabases)).toBeUndefined();
	});

	it('cleans up rejected shared recovery before the next refresh', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const accountChoice = vi.spyOn(vscode.window, 'showWarningMessage')
			.mockResolvedValueOnce('Try another account' as any)
			.mockResolvedValueOnce(undefined as any);
		const rejectedReauthentication = vi.fn(async () => { throw new Error('Reauthentication failed'); });
		const firstPostMessage = vi.fn();
		const secondPostMessage = vi.fn();
		const firstService = new ConnectionService(makeMockHost({
			connections: [connection],
			globalState,
			getDatabases: vi.fn(async () => []),
			reauthenticate: rejectedReauthentication,
			postMessage: firstPostMessage,
		}) as any);
		const secondService = new ConnectionService(makeMockHost({
			connections: [connection],
			globalState,
			getDatabases: vi.fn(async () => []),
			reauthenticate: vi.fn(async () => undefined),
			postMessage: secondPostMessage,
		}) as any);

		await Promise.all([
			firstService.sendDatabases('c1', 'query_1', { mode: 'interactive-refresh', requestToken: 'rejected_1' }),
			secondService.sendDatabases('c1', 'query_2', { mode: 'interactive-refresh', requestToken: 'rejected_2' }),
		]);
		expect(accountChoice).toHaveBeenCalledTimes(1);
		expect((ConnectionService as any).zeroResultRecoveryByCluster.size).toBe(0);

		const thirdPostMessage = vi.fn();
		const thirdService = new ConnectionService(makeMockHost({
			connections: [connection],
			globalState,
			getDatabases: vi.fn(async () => []),
			postMessage: thirdPostMessage,
		}) as any);
		await thirdService.sendDatabases('c1', 'query_3', {
			mode: 'interactive-refresh',
			requestToken: 'after_rejection',
		});

		expect(accountChoice).toHaveBeenCalledTimes(2);
		expect(thirdPostMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			requestToken: 'after_rejection',
		}));
	});

	it('echoes the request token on database responses', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const postMessage = vi.fn();
		const trace = vi.fn();
		const getDatabases = vi.fn(async () => ['Db1']);
		const host = makeMockHost({
			connections: [connection],
			getDatabases,
			postMessage,
			output: { trace, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() },
		});
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'passive', requestToken: 'databases_1',
			sectionInstanceId: 'instance-1', targetGeneration: 3,
		});

		expect(postMessage).toHaveBeenCalledWith({
			type: 'databasesData',
			databases: ['Db1'],
			boxId: 'query_1',
			connectionId: 'c1',
			accountPartition: 'test-partition',
			requestToken: 'databases_1',
			sectionInstanceId: 'instance-1',
			targetGeneration: 3,
			authoritative: true,
			fallback: false,
		});
		const getDatabasesOptions = getDatabases.mock.calls[0][2];
		const traceText = trace.mock.calls.map(([message]) => String(message)).join('\n');
		expect(getDatabasesOptions).toEqual(expect.objectContaining({
			allowInteractive: false,
			source: 'query-editor',
			traceId: expect.any(String),
		}));
		expect(traceText).toContain(`service.start connectionIdRef=${databaseListTraceRef('c1')} boxIdRef=${databaseListTraceRef('query_1')} requestTokenRef=${databaseListTraceRef('databases_1')} clusterKeyRef=${databaseListTraceRef('test')}`);
		expect(traceText).toContain('service.live-fetch.start reason=initial');
		expect(traceText).toContain(`service.webview.post connectionIdRef=${databaseListTraceRef('c1')} provenance=live databaseCount=1`);
		expect(traceText).toContain(`[database-list:${getDatabasesOptions.traceId}]`);
	});

	it('bypasses stale cache when it omits an explicitly required database', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const getDatabases = vi.fn(async () => ['CachedDb', 'SavedDb']);
		const postMessage = vi.fn();
		const host = makeMockHost({ connections: [connection], globalState, getDatabases, postMessage });
		await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', {
			mode: 'passive',
			requestToken: 'databases_saved',
			requiredDatabase: 'SavedDb',
		});

		expect(getDatabases).toHaveBeenCalledWith(connection, true, expect.objectContaining({
			allowInteractive: false,
			source: 'query-editor',
			traceId: expect.any(String),
		}));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['CachedDb', 'SavedDb'],
			requestToken: 'databases_saved',
			authoritative: true,
			fallback: false,
		}));
	});

	it('traces a persisted cache hit without calling the Kusto client', async () => {
		const connection = { id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' };
		const globalState = new Map<string, any>();
		const getDatabases = vi.fn(async () => ['LiveDb']);
		const postMessage = vi.fn();
		const trace = vi.fn();
		const host = makeMockHost({
			connections: [connection],
			globalState,
			getDatabases,
			postMessage,
			output: { trace, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() },
		});
		await seedPrincipalDatabases(host);
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', { mode: 'passive', requestToken: 'databases_cached' });

		expect(getDatabases).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesData',
			databases: ['CachedDb'],
			authoritative: false,
			fallback: false,
		}));
		const traceText = trace.mock.calls.map(([message]) => String(message)).join('\n');
		expect(traceText).toContain('service.persisted-cache.hit databaseCount=1');
		expect(traceText).toContain(`service.webview.post connectionIdRef=${databaseListTraceRef('c1')} provenance=cache databaseCount=1`);
	});

	it('keeps concurrent database requests on distinct correlated traces', async () => {
		const connections = [
			{ id: 'c1', name: 'One', clusterUrl: 'https://one.kusto.windows.net' },
			{ id: 'c2', name: 'Two', clusterUrl: 'https://two.kusto.windows.net' },
		];
		const pending = new Map<string, { resolve: (databases: string[]) => void }>();
		const getDatabases = vi.fn((connection: { id: string }) => new Promise<string[]>((resolve) => {
			pending.set(connection.id, { resolve });
		}));
		const postMessage = vi.fn();
		const trace = vi.fn();
		const host = makeMockHost({
			connections,
			getDatabases,
			postMessage,
			output: { trace, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() },
		});
		const svc = new ConnectionService(host as any);

		const first = svc.sendDatabases('c1', 'box-1', { mode: 'interactive-refresh', requestToken: 'request-1' });
		const second = svc.sendDatabases('c2', 'box-2', { mode: 'interactive-refresh', requestToken: 'request-2' });
		await Promise.resolve();
		pending.get('c2')?.resolve(['DbTwo']);
		await second;
		pending.get('c1')?.resolve(['DbOne']);
		await first;

		const firstTraceId = getDatabases.mock.calls[0][2].traceId;
		const secondTraceId = getDatabases.mock.calls[1][2].traceId;
		expect(firstTraceId).not.toBe(secondTraceId);
		const traceText = trace.mock.calls.map(([message]) => String(message)).join('\n');
		expect(traceText).toContain(`[database-list:${firstTraceId}] service.start connectionIdRef=${databaseListTraceRef('c1')} boxIdRef=${databaseListTraceRef('box-1')} requestTokenRef=${databaseListTraceRef('request-1')}`);
		expect(traceText).toContain(`[database-list:${secondTraceId}] service.start connectionIdRef=${databaseListTraceRef('c2')} boxIdRef=${databaseListTraceRef('box-2')} requestTokenRef=${databaseListTraceRef('request-2')}`);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c1', requestToken: 'request-1', databases: ['DbOne'] }));
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c2', requestToken: 'request-2', databases: ['DbTwo'] }));
	});

	it('does not publish a database response after the connection target changes', async () => {
		const connections = [{ id: 'c1', name: 'One', clusterUrl: 'https://one.kusto.windows.net' }];
		let resolve!: (databases: string[]) => void;
		const getDatabases = vi.fn(() => new Promise<string[]>(resolvePromise => { resolve = resolvePromise; }));
		const postMessage = vi.fn();
		const host = makeMockHost({ connections, getDatabases, postMessage });
		const svc = new ConnectionService(host as any);

		const request = svc.sendDatabases('c1', 'query_1', { mode: 'passive', requestToken: 'request-1' });
		await vi.waitFor(() => expect(getDatabases).toHaveBeenCalledOnce());
		connections[0] = { ...connections[0], clusterUrl: 'https://two.kusto.windows.net' };
		resolve(['DbOne']);
		await request;

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'databasesData' }));
	});

	it('does not publish a database error after the connection target changes', async () => {
		const connections = [{ id: 'c1', name: 'One', clusterUrl: 'https://one.kusto.windows.net' }];
		let reject!: (error: Error) => void;
		const getDatabases = vi.fn(() => new Promise<string[]>((_resolve, rejectPromise) => { reject = rejectPromise; }));
		const postMessage = vi.fn();
		const host = makeMockHost({ connections, getDatabases, postMessage });
		const svc = new ConnectionService(host as any);

		const request = svc.sendDatabases('c1', 'query_1', { mode: 'passive', requestToken: 'request-1' });
		await vi.waitFor(() => expect(getDatabases).toHaveBeenCalledOnce());
		connections[0] = { ...connections[0], clusterUrl: 'https://two.kusto.windows.net' };
		reject(new Error('old endpoint failed'));
		await request;

		expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'databasesError' }));
	});

	it('terminates a tokened request when the connection no longer exists', async () => {
		const postMessage = vi.fn();
		const host = makeMockHost({ connections: [], postMessage });
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('missing', 'query_1', { mode: 'passive', requestToken: 'databases_missing' });

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesError',
			boxId: 'query_1',
			connectionId: 'missing',
			requestToken: 'databases_missing',
		}));
	});

	it('terminates database discovery for a malformed historical authority', async () => {
		const postMessage = vi.fn();
		const getDatabases = vi.fn(async () => ['ShouldNotLoad']);
		const malformed = { id: 'c1', name: 'Legacy', clusterUrl: 'https://cluster.kusto.windows.net', authorityId: 'not a tenant' };
		const host = makeMockHost({ connections: [malformed], postMessage, getDatabases });
		const svc = new ConnectionService(host as any);

		await svc.sendDatabases('c1', 'query_1', { mode: 'passive', requestToken: 'request-1' });

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'databasesError', boxId: 'query_1', requestToken: 'request-1',
			error: expect.stringContaining('invalid Tenant / Authority ID'),
		}));
		expect(getDatabases).not.toHaveBeenCalled();
	});
});

describe('ConnectionService — getFavorites', () => {
	it('returns empty array when no favorites stored', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getFavorites()).toEqual([]);
	});

	it('returns valid favorites from storage', async () => {
		const host = makeMockHost({ connections: [{ id: 'c1', name: 'Test', clusterUrl: 'https://test' }] });
		const favs = [{ name: 'My Fav', connectionId: 'c1', clusterUrl: 'https://test', database: 'db1' }];
		await host.context.globalState.update(STORAGE_KEYS.favorites, favs);
		const svc = new ConnectionService(host as any);
		const result = svc.getFavorites();
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(favs[0]);
	});

	it('skips invalid favorites (missing fields)', async () => {
		const host = makeMockHost({ connections: [{ id: 'c1', name: 'Test', clusterUrl: 'https://test' }] });
		const favs = [
			{ name: 'Good', connectionId: 'c1', clusterUrl: 'https://test', database: 'db1' },
			{ name: '', connectionId: 'c1', clusterUrl: 'https://test', database: 'db1' }, // empty name
			{ connectionId: 'c1', clusterUrl: 'https://test', database: 'db1' }, // missing name
			null,
			42,
		];
		await host.context.globalState.update(STORAGE_KEYS.favorites, favs);
		const svc = new ConnectionService(host as any);
		const result = svc.getFavorites();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Good');
	});
});

describe('ConnectionService — promptAddFavorite', () => {
	const openFileClasses = [
		{ id: 'kqlx', label: '.kqlx', supportsManySections: true },
		{ id: 'plain-kql', label: 'plain .kql', supportsManySections: false },
		{ id: 'plain-csl', label: 'plain .csl', supportsManySections: false },
		{ id: 'kql-sidecar', label: '.kql + .kql.json', supportsManySections: true },
		{ id: 'csl-sidecar', label: '.csl + .csl.json', supportsManySections: true },
	];
	const oneSectionProviderPermutations = openFileClasses.flatMap(source =>
		openFileClasses.map(target => ({
			shape: 'one-section open files',
			source,
			target,
			sourceSections: 1,
			targetSections: 1,
		}))
	);
	const manySectionProviderPermutations = openFileClasses
		.filter(fileClass => fileClass.supportsManySections)
		.flatMap(source => openFileClasses
			.filter(fileClass => fileClass.supportsManySections)
			.map(target => ({
				shape: 'many-section open files',
				source,
				target,
				sourceSections: 3,
				targetSections: 3,
			}))
		);
	const providerSyncPermutations = [...oneSectionProviderPermutations, ...manySectionProviderPermutations];

	it('stores the favorite and notifies the originating provider', async () => {
		const postMessage = vi.fn();
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Friendly Favorite' as any);
		const host = makeMockHost({
			postMessage,
			connections: [{ id: 'c1', name: 'Cluster One', clusterUrl: 'https://cluster-one.kusto.windows.net' }],
		});
		const svc = new ConnectionService(host as any);

		await svc.promptAddFavorite({
			type: 'requestAddFavorite',
			connectionId: 'c1',
			clusterUrl: 'cluster-one.kusto.windows.net/',
			database: 'Samples',
			boxId: 'query_origin',
		});

		expect(host._globalState.get(STORAGE_KEYS.favorites)).toEqual([
			{ name: 'Friendly Favorite', connectionId: 'c1', clusterUrl: 'https://cluster-one.kusto.windows.net', database: 'Samples', accountPartition: 'test-partition' },
		]);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'favoritesData',
			boxId: 'query_origin',
			favorites: [
				{ name: 'Friendly Favorite', connectionId: 'c1', clusterUrl: 'https://cluster-one.kusto.windows.net', database: 'Samples' },
			],
		});
	});

	it('does not assign an A favorite to B when identity changes while the prompt is open', async () => {
		const connection = { id: 'c1', name: 'Cluster One', clusterUrl: 'https://cluster-one.kusto.windows.net' };
		let partition = 'partition-a';
		const picked = deferred<string | undefined>();
		vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(picked.promise as any);
		const host = makeMockHost({
			connections: [connection],
			getAccountPartition: () => partition,
		});
		const svc = new ConnectionService(host as any);

		const prompt = svc.promptAddFavorite({
			type: 'requestAddFavorite', connectionId: 'c1', clusterUrl: connection.clusterUrl, database: 'SecretA', boxId: 'query_1',
		});
		await Promise.resolve();
		partition = 'partition-b';
		picked.resolve('A favorite');
		await prompt;

		expect(host._globalState.get(STORAGE_KEYS.favorites)).toBeUndefined();
	});

	it.each(providerSyncPermutations)(
		'notifies already-open $target.label target when $source.label source changes favorites ($shape, source sections=$sourceSections, target sections=$targetSections)',
		async ({ source, target, shape, sourceSections, targetSections }) => {
		const sharedGlobalState = new Map<string, any>();
		const originatingPostMessage = vi.fn();
		const otherOpenProviderPostMessage = vi.fn();
		const key = `${shape}-${source.id}-to-${target.id}-${sourceSections}-${targetSections}`;
		const favoriteName = `Cross File Favorite ${key}`;
		const clusterUrl = `cross-file-${source.id}-to-${target.id}-${sourceSections}-${targetSections}.kusto.windows.net`;
		const connectionId = `connection-${key}`;
		const database = `CrossDb${sourceSections}${targetSections}`;
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(favoriteName as any);
		const connections = [{ id: connectionId, name: key, clusterUrl: `https://${clusterUrl}` }];
		const originatingHost = makeMockHost({ postMessage: originatingPostMessage, globalState: sharedGlobalState, connections });
		const otherOpenProviderHost = makeMockHost({ postMessage: otherOpenProviderPostMessage, globalState: sharedGlobalState, connections });
		const originatingService = new ConnectionService(originatingHost as any);
		const otherOpenService = new ConnectionService(otherOpenProviderHost as any);

		await originatingService.promptAddFavorite({
			type: 'requestAddFavorite',
			connectionId,
			clusterUrl,
			database,
			boxId: 'query_origin',
		});
		const favorite = { name: favoriteName, connectionId, clusterUrl: `https://${clusterUrl}`, database };

		expect(otherOpenService.getFavorites()).toEqual([favorite]);
		expect(originatingPostMessage).toHaveBeenCalledWith({
			type: 'favoritesData',
			boxId: 'query_origin',
			favorites: [favorite],
		});
		expect(otherOpenProviderPostMessage).toHaveBeenCalledWith({
			type: 'favoritesData',
			favorites: [favorite],
		});
	});
});

describe('ConnectionService — getCachedDatabases', () => {
	it('returns empty object when nothing cached', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		expect(svc.getCachedDatabases()).toEqual({});
	});

	it('uses raw legacy cached databases only before a principal is resolved', async () => {
		const host = makeMockHost({
			connections: [{ id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' }],
			getAccountPartition: () => undefined,
		});
		await host.context.globalState.update(STORAGE_KEYS.cachedDatabases, {
			test: ['db1', 'db2'],
		});
		const svc = new ConnectionService(host as any);
		const result = svc.getCachedDatabases();
		expect(result.c1).toEqual(['db1', 'db2']);
	});

	it('does not expose raw legacy cached databases to a resolved principal', async () => {
		const host = makeMockHost({ connections: [{ id: 'c1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' }] });
		await host.context.globalState.update(STORAGE_KEYS.cachedDatabases, { test: ['SecretA'] });
		const svc = new ConnectionService(host as any);

		expect(svc.getCachedDatabases()).toEqual({});
	});
});

describe('ConnectionService — plain-file schema inference', () => {
	it('uses each connection account partition when connections share a cluster', async () => {
		const clusterUrl = 'https://shared.kusto.windows.net';
		const connections = [
			{ id: 'account-one', name: 'Account one', clusterUrl, authorityId: 'tenant-one.onmicrosoft.com' },
			{ id: 'account-two', name: 'Account two', clusterUrl, authorityId: 'tenant-two.onmicrosoft.com' },
		];
		const host = makeMockHost({
			connections,
			getAccountPartition: (connection: { id: string }) => `${connection.id}-partition`,
			getCachedSchemaFromDisk: async (key: string) => {
				if (key.includes('account-one') && key.endsWith('|dbone')) {
					return { schema: { tables: ['AccountOneTable'], functions: [] } };
				}
				if (key.includes('account-two') && key.endsWith('|dbtwo')) {
					return { schema: { tables: ['AccountTwoTable'], functions: [] } };
				}
				return undefined;
			},
		});
		const cache = new KustoConnectionCache(host.context as any);
		await cache.setDatabases('account-one', 'account-one-partition', ['DbOne']);
		await cache.setDatabases('account-two', 'account-two-partition', ['DbTwo']);

		const service = new ConnectionService(host as any);
		await expect(service.inferClusterDatabaseForKqlQuery('AccountTwoTable | take 1')).resolves.toEqual({
			clusterUrl,
			database: 'DbTwo',
			authorityId: 'tenant-two.onmicrosoft.com',
			connectionIdHint: 'account-two',
		});
	});

	it('stays unresolved when equal top schema matches belong to different authority connections', async () => {
		const clusterUrl = 'https://shared.kusto.windows.net';
		const connections = [
			{ id: 'home', name: 'Home', clusterUrl, authorityId: 'home.onmicrosoft.com' },
			{ id: 'guest', name: 'Guest', clusterUrl, authorityId: 'resource.onmicrosoft.com' },
		];
		const host = makeMockHost({
			connections,
			getAccountPartition: (connection: { id: string }) => `${connection.id}-partition`,
			getCachedSchemaFromDisk: async () => ({ schema: { tables: ['SharedTable'], functions: [] } }),
		});
		const cache = new KustoConnectionCache(host.context as any);
		await cache.setDatabases('home', 'home-partition', ['SharedDb']);
		await cache.setDatabases('guest', 'guest-partition', ['SharedDb']);

		const service = new ConnectionService(host as any);
		await expect(service.inferClusterDatabaseForKqlQuery('SharedTable | take 1')).resolves.toBeUndefined();
	});

	it('uses a connection-owned favorite to disambiguate equal authority matches', async () => {
		const clusterUrl = 'https://shared.kusto.windows.net';
		const connections = [
			{ id: 'home', name: 'Home', clusterUrl, authorityId: 'home.onmicrosoft.com' },
			{ id: 'guest', name: 'Guest', clusterUrl, authorityId: 'resource.onmicrosoft.com' },
		];
		const host = makeMockHost({
			connections,
			getAccountPartition: (connection: { id: string }) => `${connection.id}-partition`,
			getCachedSchemaFromDisk: async () => ({ schema: { tables: ['SharedTable'], functions: [] } }),
		});
		await host.context.globalState.update(STORAGE_KEYS.favorites, [
			{ name: 'Guest favorite', connectionId: 'guest', clusterUrl, database: 'SharedDb' },
		]);
		const cache = new KustoConnectionCache(host.context as any);
		await cache.setDatabases('home', 'home-partition', ['SharedDb']);
		await cache.setDatabases('guest', 'guest-partition', ['SharedDb']);

		const service = new ConnectionService(host as any);
		await expect(service.inferClusterDatabaseForKqlQuery('SharedTable | take 1')).resolves.toEqual({
			clusterUrl,
			database: 'SharedDb',
			authorityId: 'resource.onmicrosoft.com',
			connectionIdHint: 'guest',
		});
	});
});

describe('ConnectionService — removeFavorite', () => {
	it('removes matching favorite', async () => {
		const postMessage = () => {};
		const host = makeMockHost({
			postMessage,
			connections: [
				{ id: 'keep', name: 'Keep', clusterUrl: 'https://keep' },
				{ id: 'remove', name: 'Remove', clusterUrl: 'https://remove' },
			],
		});
		const favs = [
			{ name: 'Keep', connectionId: 'keep', clusterUrl: 'https://keep', database: 'db' },
			{ name: 'Remove', connectionId: 'remove', clusterUrl: 'https://remove', database: 'db' },
		];
		await host.context.globalState.update(STORAGE_KEYS.favorites, favs);
		const svc = new ConnectionService(host as any);
		await svc.removeFavorite('remove', 'db');
		const result = svc.getFavorites();
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('Keep');
	});

	it('does nothing when connection ID is empty', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.removeFavorite('', 'db'); // should not throw
	});

	it('does nothing when database is empty', async () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		await svc.removeFavorite('c1', ''); // should not throw
	});
});

// ── migrateCachedDatabasesToClusterKeys ───────────────────────────────────────
// Critical for preventing database cache loss during migration from connection-id
// based keys to cluster-url based keys.

describe('ConnectionService — migrateCachedDatabasesToClusterKeys', () => {
	it('converts connection-id keys to cluster URL keys', () => {
		const connections = [
			{ id: 'conn-1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' },
		];
		const host = makeMockHost({ connections });
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({
			'conn-1': ['db1', 'db2'],
		});
		expect(result.test).toEqual(['db1', 'db2']);
	});

	it('canonicalizes entries already keyed by cluster URL', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({
			'test.kusto.windows.net': ['db1'],
		});
		expect(result.test).toEqual(['db1']);
	});

	it('merges databases when id key and cluster key map to same cluster', () => {
		const connections = [
			{ id: 'conn-1', name: 'Test', clusterUrl: 'https://test.kusto.windows.net' },
		];
		const host = makeMockHost({ connections });
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({
			'conn-1': ['db1'],
			'test.kusto.windows.net': ['db2'],
		});
		// Should merge and deduplicate
		expect(result.test).toContain('db1');
		expect(result.test).toContain('db2');
	});

	it('merges regional short and full host cache keys', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({
			'aoaiagents1.westus': ['prod'],
			'aoaiagents1.westus.kusto.windows.net': ['Prod2'],
		});
		expect(result['aoaiagents1.westus']).toEqual(['prod', 'Prod2']);
	});

	it('deduplicates database names (case-insensitive)', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({
			'test.kusto.windows.net': ['MyDB', 'mydb', 'MYDB'],
		});
		expect(result.test).toHaveLength(1);
	});

	it('skips empty keys', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({
			'': ['db1'],
			'test.kusto.windows.net': ['db2'],
		});
		expect(result['']).toBeUndefined();
		expect(result.test).toEqual(['db2']);
	});

	it('handles empty input', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({});
		expect(Object.keys(result)).toHaveLength(0);
	});

	it('handles null input', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys(null as any);
		expect(Object.keys(result)).toHaveLength(0);
	});

	it('filters out empty database names', () => {
		const host = makeMockHost();
		const svc = new ConnectionService(host as any);
		const result = svc.migrateCachedDatabasesToClusterKeys({
			'test.kusto.windows.net': ['db1', '', '  ', 'db2'],
		});
		expect(result.test).toEqual(['db1', 'db2']);
	});
});
