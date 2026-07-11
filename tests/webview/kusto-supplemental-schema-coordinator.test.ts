import { describe, expect, it, vi } from 'vitest';
import {
	KustoSupplementalSchemaCoordinator,
	supplementalStateIdentity,
} from '../../src/webview/shared/kusto-supplemental-schema-coordinator.js';

const remote = { schemaKey: 'remote|telemetry', clusterName: 'remote', database: 'Telemetry' };
const other = { schemaKey: 'other|logs', clusterName: 'other', database: 'Logs' };

describe('KustoSupplementalSchemaCoordinator', () => {
	it('keeps the same reference generation across unrelated query edits', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const first = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, primarySchemaKey: 'current|db', references: [remote], now: 10 });
		const second = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 2, primarySchemaKey: 'current|db', references: [remote], now: 20 });

		expect(first.added).toHaveLength(1);
		expect(second.added).toHaveLength(0);
		expect(second.retained[0].referenceGeneration).toBe(first.added[0].referenceGeneration);
		expect(second.retained[0].modelVersion).toBe(2);
	});

	it('rejects late transitions after a reference is removed and re-added', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const oldState = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 2, references: [], now: 20 });
		const newState = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 3, references: [remote], now: 30 }).added[0];

		expect(coordinator.markFetching(supplementalStateIdentity(oldState), { requestToken: 'old', requestSource: 'background', deadlineAt: 100, now: 40 })).toBeUndefined();
		expect(newState.referenceGeneration).toBeGreaterThan(oldState.referenceGeneration);
		expect(coordinator.getState('model://1', remote.schemaKey)?.status).toBe('scheduled');
	});

	it('separates fetched schema from per-model primary readiness and application', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, primarySchemaKey: 'current|db', references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'fetch-1', requestSource: 'background', deadlineAt: 100, now: 20 });

		expect(coordinator.markFetchedByRequest('fetch-1', 30)[0].status).toBe('waiting-primary');
		expect(coordinator.getApplyCandidates(remote.schemaKey)).toEqual([]);

		coordinator.setPrimaryReady('model://1', true, 40);
		const candidate = coordinator.getApplyCandidates(remote.schemaKey)[0];
		expect(candidate.status).toBe('fetched');
		expect(coordinator.markApplying(supplementalStateIdentity(candidate), 120, 50)?.status).toBe('applying');
		expect(coordinator.markLoaded(supplementalStateIdentity(candidate), 60)?.status).toBe('loaded');
	});

	it('traces lifecycle changes without repeating unchanged states', () => {
		const trace = vi.fn();
		const coordinator = new KustoSupplementalSchemaCoordinator(trace);
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'fetch-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('fetch-1', 30);
		trace.mockClear();

		coordinator.setPrimaryReady('model://1', false, 40);
		coordinator.markApplying(supplementalStateIdentity(state), 120, 50);
		coordinator.invalidateModelApplications('model://1', 60);
		expect(trace).not.toHaveBeenCalled();

		coordinator.setPrimaryReady('model://1', true, 70);
		expect(trace).toHaveBeenCalledTimes(1);
		expect(trace.mock.calls[0][0]).toMatchObject({
			event: 'state-transition',
			previousStatus: 'waiting-primary',
			status: 'fetched',
		});
	});

	it('allows autocomplete to retry after a background failure', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'background-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markRequestFailed('background-1', 'auth-required', 30);

		expect(coordinator.shouldSuppressDiagnostic('model://1', remote.schemaKey, 30)).toBe(false);
		const retry = coordinator.escalateToAutocomplete(supplementalStateIdentity(state), 40)!;
		expect(retry).toMatchObject({ status: 'scheduled', requestSource: 'autocomplete', failureKind: undefined });
		expect(coordinator.shouldSuppressDiagnostic('model://1', remote.schemaKey, 40)).toBe(true);
	});

	it('allows autocomplete to supersede a still-pending silent background fetch', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'background-1', requestSource: 'background', deadlineAt: 100, now: 20 });

		const escalated = coordinator.escalateToAutocomplete(supplementalStateIdentity(state), 30)!;
		expect(escalated).toMatchObject({ status: 'scheduled', requestSource: 'autocomplete', requestToken: undefined });
	});

	it('preserves a loaded stale fallback when an autocomplete refresh fails', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'stale-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('stale-1', 30);
		coordinator.setPrimaryReady('model://1', true, 31);
		const candidate = coordinator.getApplyCandidates(remote.schemaKey)[0];
		coordinator.markApplying(supplementalStateIdentity(candidate), 100, 32);
		coordinator.markLoaded(supplementalStateIdentity(candidate), 33);

		const refresh = coordinator.refreshWithAutocomplete(supplementalStateIdentity(candidate), 40)!;
		expect(refresh).toMatchObject({ status: 'scheduled', requestSource: 'autocomplete', fetchedAvailable: true });
		coordinator.markFetching(supplementalStateIdentity(refresh), {
			requestToken: 'refresh-1',
			requestSource: 'autocomplete',
			deadlineAt: 200,
			preserveFetchedAvailable: true,
			now: 41,
		});

		expect(coordinator.markRequestFailed('refresh-1', 'auth-required', 50)[0]).toMatchObject({
			status: 'loaded',
			fetchedAvailable: true,
			failureKind: undefined,
		});
		expect(coordinator.shouldSuppressDiagnostic('model://1', remote.schemaKey, 50)).toBe(true);
	});

	it('preserves a loaded stale fallback when an autocomplete refresh times out', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'stale-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('stale-1', 30);
		coordinator.setPrimaryReady('model://1', true, 31);
		const candidate = coordinator.getApplyCandidates(remote.schemaKey)[0];
		coordinator.markApplying(supplementalStateIdentity(candidate), 100, 32);
		coordinator.markLoaded(supplementalStateIdentity(candidate), 33);
		const refresh = coordinator.refreshWithAutocomplete(supplementalStateIdentity(candidate), 40)!;
		coordinator.markFetching(supplementalStateIdentity(refresh), {
			requestToken: 'refresh-timeout',
			requestSource: 'autocomplete',
			deadlineAt: 50,
			preserveFetchedAvailable: true,
			now: 41,
		});

		expect(coordinator.expire(50)[0]).toMatchObject({ status: 'loaded', fetchedAvailable: true, failureKind: undefined });
		expect(coordinator.getNextDeadlineAt()).toBeUndefined();
	});

	it('preserves stale fallbacks for every same-key subscriber joining an autocomplete refresh', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const first = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		const second = coordinator.syncReferences({ boxId: 'query_2', modelUri: 'model://2', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.bindSchemaRequest(remote.schemaKey, { requestToken: 'stale-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('stale-1', 30);
		coordinator.setPrimaryReady('model://1', true, 31);
		coordinator.setPrimaryReady('model://2', true, 31);
		for (const candidate of coordinator.getApplyCandidates(remote.schemaKey)) {
			coordinator.markApplying(supplementalStateIdentity(candidate), 100, 32);
			coordinator.markLoaded(supplementalStateIdentity(candidate), 33);
		}
		coordinator.refreshWithAutocomplete(supplementalStateIdentity(first), 40);
		coordinator.refreshWithAutocomplete(supplementalStateIdentity(second), 40);
		coordinator.bindSchemaRequest(remote.schemaKey, {
			requestToken: 'refresh-shared',
			requestSource: 'autocomplete',
			deadlineAt: 200,
			preserveFetchedAvailable: true,
			now: 41,
		});

		expect(coordinator.markRequestFailed('refresh-shared', 'auth-required', 50)).toHaveLength(2);
		expect(coordinator.getStatesForSchemaKey(remote.schemaKey).every(state => state.status === 'loaded' && state.fetchedAvailable)).toBe(true);
	});

	it.each(['fetched', 'waiting-primary', 'applying', 'loaded'] as const)('can refresh a stale fallback from %s state', (status) => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'stale-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('stale-1', 30);
		if (status !== 'waiting-primary') coordinator.setPrimaryReady('model://1', true, 31);
		if (status === 'applying' || status === 'loaded') {
			const candidate = coordinator.getApplyCandidates(remote.schemaKey)[0];
			coordinator.markApplying(supplementalStateIdentity(candidate), 100, 32);
			if (status === 'loaded') coordinator.markLoaded(supplementalStateIdentity(candidate), 33);
		}

		const current = coordinator.getState('model://1', remote.schemaKey)!;
		expect(current.status).toBe(status);
		expect(coordinator.refreshWithAutocomplete(supplementalStateIdentity(current), 40)).toMatchObject({
			status: 'scheduled',
			requestSource: 'autocomplete',
			fetchedAvailable: true,
		});
	});

	it('rebinds every same-key subscriber when autocomplete replaces a background token', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const first = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		const second = coordinator.syncReferences({ boxId: 'query_2', modelUri: 'model://2', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.bindSchemaRequest(remote.schemaKey, {
			requestToken: 'background-1',
			requestSource: 'background',
			deadlineAt: 100,
			now: 20,
		});
		coordinator.escalateToAutocomplete(supplementalStateIdentity(first), 30);

		const rebound = coordinator.bindSchemaRequest(remote.schemaKey, {
			requestToken: 'autocomplete-1',
			requestSource: 'autocomplete',
			deadlineAt: 200,
			includeFetching: true,
			now: 40,
		});

		expect(rebound).toHaveLength(2);
		expect(coordinator.getState('model://1', remote.schemaKey)).toMatchObject({ status: 'fetching', requestToken: 'autocomplete-1', requestSource: 'autocomplete' });
		expect(coordinator.getState('model://2', remote.schemaKey)).toMatchObject({ status: 'fetching', requestToken: 'autocomplete-1', requestSource: 'autocomplete' });
		expect(coordinator.markFetchedByRequest('background-1', 50)).toEqual([]);
		expect(coordinator.markFetchedByRequest('autocomplete-1', 50)).toHaveLength(2);
	});

	it('transitions loaded models back to fetched when fresher schema arrives', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const state = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(state), { requestToken: 'fetch-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('fetch-1', 30);
		coordinator.setPrimaryReady('model://1', true, 31);
		const candidate = coordinator.getApplyCandidates(remote.schemaKey)[0];
		coordinator.markApplying(supplementalStateIdentity(candidate), 100, 32);
		coordinator.markLoaded(supplementalStateIdentity(candidate), 33);

		expect(coordinator.markSchemaRefreshed(remote.schemaKey, 'fetch-1', 40)[0].status).toBe('fetched');
	});

	it('rearms exact-token failed and applying subscribers for a fresh schema revision', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const first = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		const second = coordinator.syncReferences({ boxId: 'query_2', modelUri: 'model://2', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.bindSchemaRequest(remote.schemaKey, { requestToken: 'refresh-1', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('refresh-1', 30);
		coordinator.setPrimaryReady('model://1', true, 31);
		coordinator.setPrimaryReady('model://2', true, 31);
		coordinator.markApplying(supplementalStateIdentity(first), 90, 40);
		coordinator.markFailed(supplementalStateIdentity(second), 'apply-failed', 40);

		const refreshed = coordinator.markSchemaRefreshed(remote.schemaKey, 'refresh-1', 50);

		expect(refreshed).toHaveLength(2);
		expect(coordinator.getState('model://1', remote.schemaKey)).toMatchObject({ status: 'fetched', fetchedAvailable: true, deadlineAt: undefined, failureKind: undefined });
		expect(coordinator.getState('model://2', remote.schemaKey)).toMatchObject({ status: 'fetched', fetchedAvailable: true, deadlineAt: undefined, failureKind: undefined });
	});

	it('actively expires fetch and apply deadlines', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const fetchState = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(fetchState), { requestToken: 'fetch-1', requestSource: 'background', deadlineAt: 50, now: 20 });
		expect(coordinator.expire(49)).toEqual([]);
		expect(coordinator.expire(50)[0]).toMatchObject({ status: 'failed', failureKind: 'fetch-timeout' });

		const applyState = coordinator.syncReferences({ boxId: 'query_2', modelUri: 'model://2', modelVersion: 1, references: [other], now: 60 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(applyState), { requestToken: 'fetch-2', requestSource: 'background', deadlineAt: 80, now: 61 });
		coordinator.markFetchedByRequest('fetch-2', 62);
		coordinator.setPrimaryReady('model://2', true, 63);
		const candidate = coordinator.getApplyCandidates(other.schemaKey)[0];
		coordinator.markApplying(supplementalStateIdentity(candidate), 90, 64);
		expect(coordinator.expire(90)[0]).toMatchObject({ status: 'failed', failureKind: 'apply-timeout' });
	});

	it('invalidates only the affected model after primary replacement', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const first = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		const second = coordinator.syncReferences({ boxId: 'query_2', modelUri: 'model://2', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(first), { requestToken: 'shared', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetching(supplementalStateIdentity(second), { requestToken: 'shared', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('shared', 30);
		coordinator.setPrimaryReady('model://1', true, 31);
		coordinator.setPrimaryReady('model://2', true, 31);
		for (const candidate of coordinator.getApplyCandidates(remote.schemaKey)) {
			coordinator.markApplying(supplementalStateIdentity(candidate), 100, 32);
			coordinator.markLoaded(supplementalStateIdentity(candidate), 33);
		}

		coordinator.invalidateModelApplications('model://1', 40);
		expect(coordinator.getState('model://1', remote.schemaKey)).toMatchObject({ status: 'waiting-primary', deadlineAt: undefined });
		expect(coordinator.expire(101)).toEqual([]);
		expect(coordinator.getApplyCandidates(remote.schemaKey).map(state => state.modelUri)).toContain('model://1');
		expect(coordinator.getState('model://2', remote.schemaKey)?.status).toBe('loaded');
	});

	it('lets a late subscriber inherit the stale broker token and receive its fresh revision', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const first = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(first), { requestToken: 'stale-refresh', requestSource: 'background', deadlineAt: 100, now: 20 });
		coordinator.markFetchedByRequest('stale-refresh', 30);
		const second = coordinator.syncReferences({ boxId: 'query_2', modelUri: 'model://2', modelVersion: 1, references: [remote], now: 40 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(second), { requestToken: 'stale-refresh', requestSource: 'background', deadlineAt: 100, now: 41 });
		coordinator.markFetchedByRequest('stale-refresh', 42);

		const refreshed = coordinator.markSchemaRefreshed(remote.schemaKey, 'stale-refresh', 50);

		expect(refreshed).toHaveLength(2);
		expect(coordinator.getState('model://1', remote.schemaKey)).toMatchObject({ fetchedAvailable: true, failureKind: undefined, deadlineAt: undefined });
		expect(coordinator.getState('model://2', remote.schemaKey)).toMatchObject({ fetchedAvailable: true, failureKind: undefined, deadlineAt: undefined });
	});

	it('reports request ownership, nearest deadlines, and worker-wide invalidation', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const first = coordinator.syncReferences({ boxId: 'query_1', modelUri: 'model://1', modelVersion: 1, references: [remote], now: 10 }).added[0];
		const second = coordinator.syncReferences({ boxId: 'query_2', modelUri: 'model://2', modelVersion: 1, references: [remote], now: 10 }).added[0];
		coordinator.markFetching(supplementalStateIdentity(first), { requestToken: 'shared', requestSource: 'background', deadlineAt: 80, now: 20 });
		coordinator.markFetching(supplementalStateIdentity(second), { requestToken: 'shared', requestSource: 'background', deadlineAt: 70, now: 20 });

		expect(coordinator.getStatesForRequest('shared')).toHaveLength(2);
		expect(coordinator.getNextDeadlineAt()).toBe(70);
		coordinator.markFetchedByRequest('shared', 30);
		coordinator.setPrimaryReady('model://1', true, 31);
		coordinator.setPrimaryReady('model://2', true, 31);
		for (const candidate of coordinator.getApplyCandidates(remote.schemaKey)) {
			coordinator.markApplying(supplementalStateIdentity(candidate), 100, 32);
			coordinator.markLoaded(supplementalStateIdentity(candidate), 33);
		}
		expect(coordinator.invalidateAllApplications(40)).toHaveLength(2);
		expect(coordinator.getAllStates().every(state => state.status === 'waiting-primary')).toBe(true);
	});

	it('disposes all subscriptions for a model and emits sanitized trace identifiers', () => {
		const trace = vi.fn();
		const coordinator = new KustoSupplementalSchemaCoordinator(trace);
		coordinator.syncReferences({ boxId: 'query_1', modelUri: 'file:///sensitive/path/query.kql', modelVersion: 1, references: [remote], now: 10 });

		expect(coordinator.disposeModel('file:///sensitive/path/query.kql')).toHaveLength(1);
		expect(coordinator.getState('file:///sensitive/path/query.kql', remote.schemaKey)).toBeUndefined();
		const traceText = JSON.stringify(trace.mock.calls);
		expect(traceText).not.toContain('sensitive');
		expect(traceText).not.toContain('remote|telemetry');
	});
});
