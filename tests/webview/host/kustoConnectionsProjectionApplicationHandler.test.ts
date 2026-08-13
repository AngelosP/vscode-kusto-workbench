import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/editingPreferences', () => ({
	getEditingPreferencesData: vi.fn(),
}));

import { getKustoConnectionIdentityKey } from '../../../src/shared/kustoAuth';
import { parseKustoConnectionsProjectionHostMessage } from '../../../src/shared/kustoConnectionsProjectionProtocol';
import type { KustoConnection } from '../../../src/host/connectionManager';
import type { KustoLeaveNoTracePolicySnapshot } from '../../../src/host/kustoLeaveNoTracePolicyStore';
import { getEditingPreferencesData } from '../../../src/host/editingPreferences';
import {
	HostKustoConnectionsProjectionApplicationHandler,
	setTestIsolateKustoConnections,
	type KustoConnectionsProjectionApplicationHandlerOptions,
} from '../../../src/host/kustoConnectionsProjectionApplicationHandler';
import { STORAGE_KEYS } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function connection(overrides: Partial<KustoConnection> = {}): KustoConnection {
	return {
		id: 'kusto-1',
		name: 'Kusto One',
		clusterUrl: 'https://cluster.kusto.windows.net',
		database: 'DatabaseOne',
		authorityId: 'tenant.example',
		...overrides,
	};
}

function policy(overrides: Partial<KustoLeaveNoTracePolicySnapshot> = {}): KustoLeaveNoTracePolicySnapshot {
	return {
		clusterKeys: [],
		globallyBlocked: false,
		version: 7,
		revocationGenerations: {},
		...overrides,
	};
}

function createHarness(overrides: Partial<KustoConnectionsProjectionApplicationHandlerOptions> & {
	policy?: KustoLeaveNoTracePolicySnapshot;
} = {}) {
	const currentConnection = connection();
	const applicationStateGet = vi.fn((key: string) =>
		key === STORAGE_KEYS.copilotChatFirstTimeDismissed ? true : undefined);
	const getConnections = vi.fn(() => [currentConnection]);
	const getConnectionIncarnation = vi.fn(() => 12);
	const normalizeClusterUrl = vi.fn((clusterUrl: string) =>
		String(clusterUrl || '').replace(/^https?:\/\//i, '').split('.')[0].toLowerCase());
	const getAccounts = vi.fn(async () => [{ id: 'account-a', label: 'Account A', lastUsedAt: 1 }]);
	const getPreferredAccountId = vi.fn(() => 'account-a');
	const getAccountPartition = vi.fn(() => 'fallback-partition');
	const getClientAccountPartition = vi.fn(() => 'client-partition');
	const getLastSelection = vi.fn(() => ({
		lastConnectionId: currentConnection.id,
		lastDatabase: 'DatabaseTwo',
	}));
	const getCachedDatabases = vi.fn(() => ({ [currentConnection.id]: ['DatabaseOne', 'DatabaseTwo'] }));
	const favorite = {
		name: 'Favorite One',
		connectionId: currentConnection.id,
		clusterUrl: currentConnection.clusterUrl,
		database: 'DatabaseOne',
	};
	const getFavorites = vi.fn(() => [favorite]);
	const postMessage = vi.fn(async () => true);
	const postKustoPublication = vi.fn(async () => true);
	let currentPolicy = overrides.policy ?? policy();
	let lockHeld = false;
	const runWithLeaveNoTraceSnapshotLock = vi.fn(async <T>(
		run: (snapshot: KustoLeaveNoTracePolicySnapshot) => Promise<T>,
	): Promise<T> => {
		lockHeld = true;
		try {
			return await run(currentPolicy);
		} finally {
			lockHeld = false;
		}
	});
	const options: KustoConnectionsProjectionApplicationHandlerOptions = {
		context: {
			globalState: {
				get: applicationStateGet,
			} as KustoConnectionsProjectionApplicationHandlerOptions['context']['globalState'],
		},
		connectionManager: {
			getConnections,
			getConnectionIncarnation,
			normalizeClusterUrl,
			runWithLeaveNoTraceSnapshotLock,
		},
		authPreferences: {
			getAccounts,
			getPreferredAccountId,
			getAccountPartition,
		},
		kustoClient: { getAccountPartition: getClientAccountPartition },
		getLastSelection,
		getCachedDatabases,
		getFavorites,
		postMessage,
		postKustoPublication,
		...overrides,
	};
	delete (options as KustoConnectionsProjectionApplicationHandlerOptions & { policy?: unknown }).policy;
	return {
		handler: new HostKustoConnectionsProjectionApplicationHandler(options),
		options,
		currentConnection,
		favorite,
		applicationStateGet,
		getConnections,
		getConnectionIncarnation,
		normalizeClusterUrl,
		getAccounts,
		getPreferredAccountId,
		getAccountPartition,
		getClientAccountPartition,
		getLastSelection,
		getCachedDatabases,
		getFavorites,
		postMessage,
		postKustoPublication,
		runWithLeaveNoTraceSnapshotLock,
		isLockHeld: () => lockHeld,
		setPolicy: (value: KustoLeaveNoTracePolicySnapshot) => { currentPolicy = value; },
	};
}

describe('HostKustoConnectionsProjectionApplicationHandler', () => {
	beforeEach(() => {
		vi.mocked(getEditingPreferencesData).mockReturnValue({
			type: 'editingPreferencesData',
			revision: 31,
			caretDocsEnabled: false,
			caretDocsEnabledUserSet: true,
			autoTriggerAutocompleteEnabled: true,
			autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: false,
			copilotInlineCompletionsEnabledUserSet: true,
		});
		setTestIsolateKustoConnections(false);
	});

	afterEach(() => {
		setTestIsolateKustoConnections(false);
		vi.clearAllMocks();
	});

	it('publishes fresh-profile selections as null through JSON transport', async () => {
		let transported: unknown;
		const harness = createHarness({
			getLastSelection: vi.fn(() => ({
				lastConnectionId: undefined,
				lastDatabase: undefined,
			})),
			postKustoPublication: vi.fn(async message => {
				transported = JSON.parse(JSON.stringify(message));
				return true;
			}),
		});

		await harness.handler.refresh();

		expect(transported).toMatchObject({
			type: 'connectionsData',
			lastConnectionId: null,
			lastDatabase: null,
		});
		expect(parseKustoConnectionsProjectionHostMessage(transported)).toMatchObject({ ok: true });
	});

	it('publishes the complete physical projection and holds policy admission through application acknowledgement', async () => {
		const applied = deferred<boolean>();
		const harness = createHarness({
			policy: policy({
				clusterKeys: ['cluster'],
				revocationGenerations: { cluster: 9 },
			}),
			postKustoPublication: vi.fn(() => applied.promise),
		});
		let settled = false;

		const refresh = harness.handler.refresh(' policy-request-exact ');
		void refresh.finally(() => { settled = true; });
		await vi.waitFor(() => expect(harness.options.postKustoPublication).toHaveBeenCalledOnce());

		expect(harness.isLockHeld()).toBe(true);
		expect(settled).toBe(false);
		expect(getEditingPreferencesData).toHaveBeenCalledWith(harness.options.context);
		expect(harness.applicationStateGet).toHaveBeenCalledWith(STORAGE_KEYS.copilotChatFirstTimeDismissed);
		expect(harness.options.postKustoPublication).toHaveBeenCalledWith({
			type: 'connectionsData',
			connections: [{
				...harness.currentConnection,
				accountPartition: 'client-partition',
				connectionRevision: 12,
				connectionIdentityKey: getKustoConnectionIdentityKey(
					harness.currentConnection.clusterUrl,
					harness.currentConnection.authorityId,
				),
			}],
			accounts: [{ id: 'account-a', label: 'Account A', lastUsedAt: 1 }],
			lastConnectionId: harness.currentConnection.id,
			lastDatabase: 'DatabaseTwo',
			cachedDatabases: { [harness.currentConnection.id]: ['DatabaseOne', 'DatabaseTwo'] },
			favorites: [harness.favorite],
			caretDocsEnabled: false,
			caretDocsEnabledUserSet: true,
			autoTriggerAutocompleteEnabled: true,
			autoTriggerAutocompleteEnabledUserSet: false,
			copilotInlineCompletionsEnabled: false,
			copilotInlineCompletionsEnabledUserSet: true,
			editingPreferencesRevision: 31,
			connectionsRevision: 1,
			copilotChatFirstTimeDismissed: true,
			policyRequestId: ' policy-request-exact ',
			leaveNoTraceClusters: ['cluster'],
			leaveNoTraceGloballyBlocked: false,
			leaveNoTraceRevisions: { cluster: 9 },
			devNotesEnabled: true,
		});
		expect(harness.getAccounts).toHaveBeenCalledOnce();
		expect(harness.getConnections).toHaveBeenCalledOnce();
		expect(harness.getConnectionIncarnation).toHaveBeenCalledWith(harness.currentConnection.id);
		expect(harness.getLastSelection).toHaveBeenCalledOnce();
		expect(harness.getCachedDatabases).toHaveBeenCalledOnce();
		expect(harness.getFavorites).toHaveBeenCalledOnce();
		expect(harness.postMessage).not.toHaveBeenCalled();

		applied.resolve(true);
		await expect(refresh).resolves.toBeUndefined();
		expect(harness.isLockHeld()).toBe(false);
		expect(settled).toBe(true);
	});

	it('retries a correlated rejection with fresh accounts, connection state, and policy admission', async () => {
		const firstConnection = connection({ name: 'First' });
		const secondConnection = connection({ name: 'Second', clusterUrl: 'https://second.kusto.windows.net' });
		let connectionAttempt = 0;
		let policyAttempt = 0;
		const getConnections = vi.fn(() => connectionAttempt++ === 0 ? [firstConnection] : [secondConnection]);
		const runWithLeaveNoTraceSnapshotLock = vi.fn(async <T>(
			run: (snapshot: KustoLeaveNoTracePolicySnapshot) => Promise<T>,
		): Promise<T> => {
			const snapshot = policyAttempt++ === 0
				? policy({ clusterKeys: ['first-policy'] })
				: policy({ clusterKeys: ['second-policy'] });
			return await run(snapshot);
		});
		const postKustoPublication = vi.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const harness = createHarness({
			connectionManager: {
				getConnections,
				getConnectionIncarnation: vi.fn(() => 2),
				normalizeClusterUrl: vi.fn((value: string) => value),
				runWithLeaveNoTraceSnapshotLock,
			},
			postKustoPublication,
		});
		harness.getAccounts
			.mockResolvedValueOnce([{ id: 'account-a', label: 'Account A', lastUsedAt: 2 }])
			.mockResolvedValueOnce([{ id: 'account-b', label: 'Account B', lastUsedAt: 3 }]);

		await expect(harness.handler.refresh('policy-request-retry')).resolves.toBeUndefined();

		expect(runWithLeaveNoTraceSnapshotLock).toHaveBeenCalledTimes(2);
		expect(harness.getAccounts).toHaveBeenCalledTimes(2);
		expect(postKustoPublication.mock.calls.map(call => call[0])).toEqual([
			expect.objectContaining({
				connections: [expect.objectContaining({ name: 'First' })],
				accounts: [{ id: 'account-a', label: 'Account A', lastUsedAt: 2 }],
				connectionsRevision: 1,
				policyRequestId: 'policy-request-retry',
				leaveNoTraceClusters: ['first-policy'],
			}),
			expect.objectContaining({
				connections: [expect.objectContaining({ name: 'Second' })],
				accounts: [{ id: 'account-b', label: 'Account B', lastUsedAt: 3 }],
				connectionsRevision: 1,
				policyRequestId: 'policy-request-retry',
				leaveNoTraceClusters: ['second-policy'],
			}),
		]);
		expect(getEditingPreferencesData).toHaveBeenCalledOnce();
	});

	it('captures physical connection identity only after asynchronous account enumeration settles', async () => {
		const accountsReady = deferred<void>();
		let current = connection({
			name: 'Old',
			clusterUrl: 'https://old.kusto.windows.net',
			authorityId: 'common',
		});
		const getConnections = vi.fn(() => [current]);
		const getAccountPartition = vi.fn((candidate: KustoConnection) =>
			candidate.clusterUrl.includes('new') ? 'partition-new' : 'partition-old');
		const harness = createHarness({
			connectionManager: {
				getConnections,
				getConnectionIncarnation: vi.fn(() => 4),
				normalizeClusterUrl: vi.fn((value: string) => value),
				runWithLeaveNoTraceSnapshotLock: vi.fn(async <T>(
					run: (snapshot: KustoLeaveNoTracePolicySnapshot) => Promise<T>,
				): Promise<T> => await run(policy())),
			},
			authPreferences: {
				getAccounts: vi.fn(async () => {
					await accountsReady.promise;
					return [];
				}),
				getPreferredAccountId: vi.fn(() => undefined),
				getAccountPartition: vi.fn(() => ''),
			},
			kustoClient: { getAccountPartition },
		});

		const refresh = harness.handler.refresh();
		await Promise.resolve();
		current = connection({
			name: 'New',
			clusterUrl: 'https://new.kusto.windows.net',
			authorityId: 'organizations',
		});
		accountsReady.resolve();
		await refresh;

		expect(harness.postKustoPublication).toHaveBeenCalledWith(expect.objectContaining({
			connections: [expect.objectContaining({
				...current,
				accountPartition: 'partition-new',
				connectionRevision: 4,
				connectionIdentityKey: 'new|organizations',
			})],
		}));
		expect(JSON.stringify(harness.postKustoPublication.mock.calls))
			.not.toContain('https://old.kusto.windows.net');
	});

	it('serializes overlapping revisions and continues the tail after exact failure', async () => {
		const firstDelivery = deferred<boolean>();
		const failure = new Error('projection delivery failed');
		const harness = createHarness();
		harness.postKustoPublication
			.mockImplementationOnce(() => firstDelivery.promise)
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(true);

		const first = harness.handler.refresh();
		await vi.waitFor(() => expect(harness.postKustoPublication).toHaveBeenCalledTimes(1));
		const second = harness.handler.refresh();
		const third = harness.handler.refresh();
		await Promise.resolve();
		expect(harness.getAccounts).toHaveBeenCalledOnce();

		firstDelivery.resolve(true);
		await expect(first).resolves.toBeUndefined();
		await expect(second).rejects.toBe(failure);
		await expect(third).resolves.toBeUndefined();
		expect(harness.postKustoPublication.mock.calls.map(call => call[0].connectionsRevision))
			.toEqual([1, 2, 3]);
	});

	it('uses the authentication preference fallback when the client has no partition resolver', async () => {
		const harness = createHarness({ kustoClient: {} });

		await harness.handler.refresh();

		expect(harness.getPreferredAccountId).toHaveBeenCalledWith(harness.currentConnection.id);
		expect(harness.getAccountPartition).toHaveBeenCalledWith(
			harness.currentConnection.authorityId,
			'account-a',
		);
		expect(harness.postKustoPublication.mock.calls[0][0].connections[0].accountPartition)
			.toBe('fallback-partition');
	});

	it('publishes globally blocked clusters while preserving projection metadata', async () => {
		const second = connection({
			id: 'kusto-2',
			clusterUrl: 'https://second.kusto.windows.net',
		});
		const harness = createHarness({
			policy: policy({
				globallyBlocked: true,
				revocationGenerations: { cluster: 4, second: 5 },
			}),
			connectionManager: {
				getConnections: vi.fn(() => [connection(), second]),
				getConnectionIncarnation: vi.fn(() => 3),
				normalizeClusterUrl: vi.fn((value: string) => value.includes('second') ? 'second' : 'cluster'),
				runWithLeaveNoTraceSnapshotLock: vi.fn(async <T>(
					run: (snapshot: KustoLeaveNoTracePolicySnapshot) => Promise<T>,
				): Promise<T> => await run(policy({
					globallyBlocked: true,
					revocationGenerations: { cluster: 4, second: 5 },
				}))),
			},
		});

		await harness.handler.refresh();

		expect(harness.postKustoPublication).toHaveBeenCalledWith(expect.objectContaining({
			leaveNoTraceClusters: ['cluster', 'second'],
			leaveNoTraceGloballyBlocked: true,
			leaveNoTraceRevisions: { cluster: 4, second: 5 },
			cachedDatabases: expect.any(Object),
			favorites: expect.any(Array),
		}));
	});

	it('keeps development isolation transport-only and does not await transport settlement', async () => {
		const transport = deferred<boolean>();
		const harness = createHarness({ postMessage: vi.fn(() => transport.promise) });
		setTestIsolateKustoConnections(true);

		await expect(harness.handler.refresh('isolated-policy')).resolves.toBeUndefined();

		expect(harness.options.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'connectionsData',
			connections: [],
			connectionsRevision: 1,
			policyRequestId: 'isolated-policy',
			leaveNoTraceClusters: [],
			leaveNoTraceGloballyBlocked: false,
		}));
		expect(harness.getAccounts).not.toHaveBeenCalled();
		expect(harness.runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(harness.postKustoPublication).not.toHaveBeenCalled();
		transport.resolve(true);
	});

	it('rejects malformed captured state before generic publication staging', async () => {
		const harness = createHarness({
			getCachedDatabases: vi.fn(() => ({
				'kusto-1': ['DatabaseOne', 42 as unknown as string],
			})),
		});

		await expect(harness.handler.refresh()).rejects.toThrow(
			'Invalid Kusto connections projection',
		);

		expect(harness.postKustoPublication).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('suppresses admitted and later work when disposed before policy admission', async () => {
		const accounts = deferred<Array<{ id: string; label: string; lastUsedAt: number }>>();
		const harness = createHarness({
			authPreferences: {
				getAccounts: vi.fn(() => accounts.promise),
				getPreferredAccountId: vi.fn(() => undefined),
				getAccountPartition: vi.fn(() => ''),
			},
		});
		const first = harness.handler.refresh();
		const queued = harness.handler.refresh();
		await vi.waitFor(() => expect(harness.options.authPreferences.getAccounts).toHaveBeenCalledOnce());

		harness.handler.dispose();
		harness.handler.dispose();
		accounts.resolve([]);

		await expect(first).resolves.toBeUndefined();
		await expect(queued).resolves.toBeUndefined();
		await expect(harness.handler.refresh()).resolves.toBeUndefined();
		expect(harness.runWithLeaveNoTraceSnapshotLock).not.toHaveBeenCalled();
		expect(harness.getConnections).not.toHaveBeenCalled();
		expect(harness.getLastSelection).not.toHaveBeenCalled();
		expect(harness.getCachedDatabases).not.toHaveBeenCalled();
		expect(harness.getFavorites).not.toHaveBeenCalled();
		expect(harness.postKustoPublication).not.toHaveBeenCalled();
	});
});