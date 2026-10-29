import { describe, expect, it, vi } from 'vitest';

import {
	KustoEditorSchemaCoordinator,
	type KustoEditorSchemaRequestPlan,
} from '../../src/webview/core/kusto-editor-schema-coordinator.js';

describe('KustoEditorSchemaCoordinator ownership', () => {
	it('rejects an old section incarnation after the same box ID is recreated', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const oldLease = coordinator.openSection('query_1', 'instance-old')!;
		const oldIdentity = coordinator.setTarget(oldLease, 'connection-a', 'DbA')!;
		coordinator.beginSchemaRequest(oldLease, 'request-old');

		coordinator.closeSection(oldLease);
		const newLease = coordinator.openSection('query_1', 'instance-new')!;
		const newIdentity = coordinator.setTarget(newLease, 'connection-a', 'DbA')!;

		expect(coordinator.isCurrent('query_1', oldIdentity, {
			connectionId: 'connection-a', database: 'DbA',
		}, 'request-old')).toBe(false);
		expect(coordinator.isCurrent('query_1', newIdentity, {
			connectionId: 'connection-a', database: 'DbA',
		})).toBe(true);
	});

	it('marks projection teardown so result attachment ownership can survive recreation', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const events: any[] = [];
		coordinator.subscribeLifecycle(event => events.push(event));
		const lease = coordinator.openSection('query_reload', 'instance-before')!;
		coordinator.setTarget(lease, 'connection-a', 'DbA');

		expect(coordinator.closeSection(lease, { preserveResultAttachment: true })).toBe(true);

		expect(events.at(-1)).toEqual({
			type: 'closed',
			owner: { boxId: 'query_reload', sectionInstanceId: 'instance-before' },
			preserveResultAttachment: true,
		});
	});

	it('rotates target generation and retires the prior request on target change', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const first = coordinator.setTarget(lease, 'connection-a', 'DbA')!;
		const request = coordinator.beginSchemaRequest(lease, 'request-a')!;

		const second = coordinator.setTarget(lease, 'connection-a', 'DbB')!;

		expect(second.targetGeneration).toBeGreaterThan(first.targetGeneration);
		expect(coordinator.isCurrent('query_1', request, {
			connectionId: 'connection-a', database: 'DbA',
		}, request.requestToken)).toBe(false);
		expect(coordinator.getSchemaRequestToken('query_1')).toBeUndefined();
	});

	it('compares stamped physical target identity without dropping its owner fields', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const identity = coordinator.setTarget(lease, 'connection-a', 'DbA', {
			connectionRevision: 7, connectionIdentityKey: 'connection-a|revision-7',
		})!;

		expect(coordinator.isCurrent('query_1', identity, {
			connectionId: 'connection-a', database: 'DbA',
			connectionRevision: 7, connectionIdentityKey: 'connection-a|revision-7',
		})).toBe(true);
		expect(coordinator.isCurrent('query_1', identity, {
			connectionId: 'connection-a', database: 'DbA',
			connectionRevision: 8, connectionIdentityKey: 'connection-a|revision-8',
		})).toBe(false);
	});

	it('does not treat an explicit blank target as the absent target of a registered section', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		coordinator.openSection('query_unbound', 'instance-unbound');
		const identity = coordinator.getIdentity('query_unbound')!;

		expect(coordinator.isCurrent('query_unbound', identity)).toBe(true);
		expect(coordinator.isCurrent('query_unbound', identity, { connectionId: ' ' })).toBe(false);
	});

	it('atomically retires target-scoped state and waiters on target change', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		coordinator.setTarget(lease, 'connection-a', 'DbA');
		const settled: boolean[] = [];
		coordinator.setOwnedState('query_1', 'schema', { tables: ['Old'] });
		coordinator.setOwnedState('query_1', 'schemaMeta', { schemaSignature: 'old' });
		coordinator.setOwnedState('query_1', 'pendingWorkerUpdate', { schemaKey: 'old' });
		coordinator.setOwnedState('query_1', 'workerReady', { status: 'ready' });
		coordinator.setOwnedState('query_1', 'enhancementReady', { status: 'ready' });
		coordinator.setOwnedState('query_1', 'workerApplyRequired', true);
		coordinator.setOwnedState('query_1', 'workerReadyWaiters', [
			{ resolve: (ready: boolean) => settled.push(ready) },
		]);
		coordinator.setOwnedState('query_1', 'preparation', { status: 'ready' });

		coordinator.setTarget(lease, 'connection-a', 'DbB');

		expect(settled).toEqual([false]);
		expect(coordinator.getOwnedStateSnapshot('query_1')).toEqual({
			preparation: { status: 'ready' },
		});
	});

	it.each([
		'invalid token', 'stale identity', 'stale token', 'stale target', 'stale model', 'foreign model',
		'duplicate section', 'snapshot refusal', 'snapshot supersession', 'late capture',
	])('rejects a batch with %s before target, token, waiter, or listener effects', (failureKind) => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const entries = ['query_1', 'query_2', 'query_3'].map(boxId => {
			const lease = coordinator.openSection(boxId, `instance-${boxId}`)!;
			const identity = coordinator.setTarget(lease, 'connection-a', 'PreviousDb')!;
			const modelLease = coordinator.attachModel(lease, `inmemory://model/${boxId}`)!;
			coordinator.beginSchemaRequest(lease, `original-${boxId}`);
			const resolve = vi.fn();
			coordinator.setOwnedState(boxId, 'schema', { tables: [boxId] });
			coordinator.setOwnedState(boxId, 'schemaMeta', { schemaSignature: boxId });
			coordinator.setOwnedState(boxId, 'workerReady', { status: 'ready' });
			coordinator.setOwnedState(boxId, 'workerReadyWaiters', [{ resolve }]);
			return { lease, identity, modelLease, resolve, target: coordinator.getTarget(boxId), state: coordinator.getOwnedStateSnapshot(boxId) };
		});
		const plans: KustoEditorSchemaRequestPlan[] = entries.map(entry => ({
			lease: entry.lease, identity: entry.identity, modelLease: entry.modelLease,
			targetBefore: entry.target, target: { connectionId: 'connection-a', database: 'NextDb' },
			requestToken: `next-${entry.lease.boxId}`, previousRequestToken: `original-${entry.lease.boxId}`,
		}));
		if (failureKind === 'invalid token') plans[1] = { ...plans[1], requestToken: ' ' };
		if (failureKind === 'stale identity') plans[1] = { ...plans[1], identity: { ...plans[1].identity, targetGeneration: 99 } };
		if (failureKind === 'stale token') plans[1] = { ...plans[1], previousRequestToken: 'not-current' };
		if (failureKind === 'stale target') plans[1] = { ...plans[1], targetBefore: { ...entries[1].target! } };
		if (failureKind === 'stale model') coordinator.attachModel(entries[1].lease, 'inmemory://model/replacement');
		if (failureKind === 'foreign model') plans[1] = { ...plans[1], modelLease: entries[2].modelLease };
		if (failureKind === 'duplicate section') plans[1] = plans[0];
		const lifecycle = vi.fn();
		coordinator.subscribeLifecycle(lifecycle);
		const readiness = entries.map(entry => {
			const listener = vi.fn();
			coordinator.subscribeOwnedState(entry.lease.boxId, 'workerReady', listener);
			return listener;
		});
		const getToken = coordinator.getSchemaRequestToken.bind(coordinator);
		const capture = vi.spyOn(coordinator, 'getSchemaRequestToken').mockImplementation(boxId => {
			const token = getToken(boxId);
			if (failureKind === 'late capture' && boxId === 'query_3') coordinator.beginSchemaRequest(entries[1].lease, 'independent');
			return token;
		});
		const admit = vi.fn(() => {
			if (failureKind === 'snapshot supersession') coordinator.beginSchemaRequest(entries[1].lease, 'independent');
			return failureKind !== 'snapshot refusal';
		});

		expect(coordinator.beginSchemaRequests(plans, admit)).toBeUndefined();

		expect(admit).toHaveBeenCalledTimes(failureKind.startsWith('snapshot') ? 1 : 0);
		expect(lifecycle).not.toHaveBeenCalled();
		for (const [index, entry] of entries.entries()) {
			const independentlySuperseded = index === 1 && ['snapshot supersession', 'late capture'].includes(failureKind);
			expect(getToken(entry.lease.boxId)).toBe(independentlySuperseded ? 'independent' : `original-${entry.lease.boxId}`);
			expect(coordinator.getIdentity(entry.lease.boxId)).toEqual(entry.identity);
			expect(coordinator.getTarget(entry.lease.boxId)).toBe(entry.target);
			expect(coordinator.getOwnedStateSnapshot(entry.lease.boxId)).toEqual(entry.state);
			expect(entry.resolve).not.toHaveBeenCalled();
			expect(readiness[index]).not.toHaveBeenCalled();
		}
		capture.mockRestore();
	});

	it('admits normalized frozen identities for mixed targets before committing or notifying', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const physicalOwner = { connectionRevision: 7, connectionIdentityKey: 'owner-7' };
		const entries = ['fresh', 'changed', 'equivalent'].map(kind => {
			const lease = coordinator.openSection(` query_${kind} `, ` instance-${kind} `)!;
			if (kind !== 'fresh') {
				coordinator.setTarget(lease, 'connection-a', kind === 'changed' ? 'PreviousDb' : 'Samples', physicalOwner);
				coordinator.beginSchemaRequest(lease, `original-${kind}`);
			}
			coordinator.setOwnedState(lease.boxId, 'schema', { tables: [kind], sourceName: 'ExactCase' });
			coordinator.setOwnedState(lease.boxId, 'schemaMeta', { schemaSignature: kind });
			coordinator.setOwnedState(lease.boxId, 'workerReady', { status: 'ready' });
			return { lease, identity: coordinator.getIdentity(lease.boxId)!, target: coordinator.getTarget(lease.boxId), state: coordinator.getOwnedStateSnapshot(lease.boxId) };
		});
		const modelLease = coordinator.attachModel(entries[1].lease, 'inmemory://model/changed')!;
		const plans = entries.map((entry, index): KustoEditorSchemaRequestPlan => ({
			lease: entry.lease, identity: entry.identity, modelLease: index === 1 ? modelLease : undefined,
			targetBefore: entry.target, target: { connectionId: ' connection-a ', database: ' sAmPlEs ', ...physicalOwner },
			requestToken: ` request-${index} `, previousRequestToken: coordinator.getSchemaRequestToken(entry.lease.boxId),
		}));
		const notifications: string[][] = [];
		const events: unknown[] = [];
		const observe = () => notifications.push(entries.map(entry => coordinator.getSchemaRequestToken(entry.lease.boxId)!));
		for (const entry of entries) coordinator.subscribeOwnedState(entry.lease.boxId, 'workerReady', observe);
		coordinator.setOwnedState(entries[1].lease.boxId, 'workerReadyWaiters', [{ resolve: observe }]);
		coordinator.subscribeLifecycle(event => { events.push(event); observe(); });
		const admit = vi.fn(candidates => {
			expect(Object.isFrozen(candidates)).toBe(true);
			for (const [index, candidate] of candidates.entries()) {
				expect(Object.isFrozen(candidate)).toBe(true);
				expect(candidate.requestToken).toBe(`request-${index}`);
				expect(coordinator.getIdentity(candidate.boxId)).toEqual(entries[index].identity);
				expect(coordinator.getTarget(candidate.boxId)).toBe(entries[index].target);
				expect(coordinator.getSchemaRequestToken(candidate.boxId)).toBe(plans[index].previousRequestToken);
			}
			return true;
		});

		const requests = coordinator.beginSchemaRequests(plans, admit)!;

		expect(admit).toHaveBeenCalledOnce();
		expect(requests).toEqual(entries.map((entry, index) => ({
			...entry.lease, targetGeneration: entry.identity.targetGeneration + (index === 2 ? 0 : 1), requestToken: `request-${index}`,
		})));
		expect(events).toEqual(requests.map(({ requestToken, ...owner }) => ({ type: 'target', owner, target: coordinator.getTarget(owner.boxId) })));
		expect(notifications).toHaveLength(6);
		for (const tokens of notifications) expect(tokens).toEqual(['request-0', 'request-1', 'request-2']);
		for (const [index, request] of requests.entries()) {
			expect(coordinator.isCurrent(request.boxId, request, plans[index].target, request.requestToken)).toBe(true);
			expect(coordinator.getIdentity(request.boxId)).toEqual({ sectionInstanceId: request.sectionInstanceId, targetGeneration: request.targetGeneration });
		}
		expect(coordinator.getTarget(entries[2].lease.boxId)).toBe(entries[2].target);
		expect(coordinator.getOwnedStateSnapshot(entries[2].lease.boxId)).toEqual(entries[2].state);
		expect(coordinator.getOwnedStateSnapshot(entries[0].lease.boxId)).toEqual({});
		expect(coordinator.getOwnedStateSnapshot(entries[1].lease.boxId)).toEqual({});
	});

	it.each(['waiter', 'readiness', 'lifecycle'])('suppresses stale post-commit notifications after a %s supersedes an owner', (phase) => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const entries = ['query_1', 'query_2', 'query_3'].map(boxId => {
			const lease = coordinator.openSection(boxId, `instance-${boxId}`)!;
			const identity = coordinator.setTarget(lease, 'connection-a', 'PreviousDb')!;
			coordinator.beginSchemaRequest(lease, `original-${boxId}`);
			coordinator.setOwnedState(boxId, 'workerReady', { status: 'ready' });
			return { lease, identity, target: coordinator.getTarget(boxId) };
		});
		const successorWaiter = vi.fn();
		const supersede = vi.fn(() => {
			coordinator.beginSchemaRequest(entries[1].lease, 'independent');
			coordinator.setOwnedState('query_2', 'schema', { tables: ['Independent'] });
			coordinator.setOwnedState('query_2', 'schemaMeta', { schemaSignature: 'independent' });
			coordinator.setOwnedState('query_2', 'workerReady', { status: 'ready', schemaSignature: 'independent' });
			coordinator.setOwnedState('query_2', 'workerReadyWaiters', [{ resolve: successorWaiter }]);
		});
		const readiness = vi.fn();
		coordinator.subscribeOwnedState('query_2', 'workerReady', readiness);
		if (phase === 'waiter') coordinator.setOwnedState('query_1', 'workerReadyWaiters', [{ resolve: supersede }]);
		if (phase === 'readiness') coordinator.subscribeOwnedState('query_1', 'workerReady', supersede);
		if (phase === 'lifecycle') coordinator.subscribeLifecycle(event => { if (event.type === 'target' && event.owner.boxId === 'query_1') supersede(); });
		const lifecycle = vi.fn();
		coordinator.subscribeLifecycle(lifecycle);
		const plans = entries.map((entry): KustoEditorSchemaRequestPlan => ({
			lease: entry.lease, identity: entry.identity, targetBefore: entry.target,
			target: { connectionId: 'connection-a', database: 'NextDb' },
			requestToken: `next-${entry.lease.boxId}`, previousRequestToken: `original-${entry.lease.boxId}`,
		}));

		const requests = coordinator.beginSchemaRequests(plans, () => true)!;

		expect(supersede).toHaveBeenCalledOnce();
		expect(requests).toHaveLength(3);
		expect(coordinator.getSchemaRequestToken('query_1')).toBe('next-query_1');
		expect(coordinator.getSchemaRequestToken('query_3')).toBe('next-query_3');
		expect(coordinator.getSchemaRequestToken('query_2')).toBe('independent');
		expect(coordinator.getOwnedStateSnapshot('query_2')).toEqual({
			schema: { tables: ['Independent'] }, schemaMeta: { schemaSignature: 'independent' },
			workerReady: { status: 'ready', schemaSignature: 'independent' }, workerReadyWaiters: [{ resolve: successorWaiter }],
		});
		expect(successorWaiter).not.toHaveBeenCalled();
		expect(readiness).not.toHaveBeenCalled();
		expect(lifecycle.mock.calls.map(([event]) => event.owner.boxId)).toEqual(['query_1', 'query_3']);
	});

	it.each(['readiness', 'lifecycle'])('stops later same-owner %s listeners after token supersession', (phase) => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const identity = coordinator.setTarget(lease, 'connection-a', 'PreviousDb')!;
		const targetBefore = coordinator.getTarget('query_1');
		coordinator.beginSchemaRequest(lease, 'original');
		coordinator.setOwnedState('query_1', 'workerReady', { status: 'ready' });
		const supersede = vi.fn(() => {
			coordinator.beginSchemaRequest(lease, 'independent');
			coordinator.setOwnedState('query_1', 'workerReady', { status: 'ready', schemaSignature: 'independent' });
		});
		if (phase === 'readiness') coordinator.subscribeOwnedState('query_1', 'workerReady', supersede);
		else coordinator.subscribeLifecycle(supersede);
		const readiness = vi.fn();
		const lifecycle = vi.fn();
		coordinator.subscribeOwnedState('query_1', 'workerReady', readiness);
		coordinator.subscribeLifecycle(lifecycle);

		const requests = coordinator.beginSchemaRequests([{
			lease, identity, targetBefore, target: { connectionId: 'connection-a', database: 'NextDb' },
			requestToken: 'committed', previousRequestToken: 'original',
		}], () => true)!;

		expect(requests[0].requestToken).toBe('committed');
		expect(supersede).toHaveBeenCalledOnce();
		expect(coordinator.getSchemaRequestToken('query_1')).toBe('independent');
		expect(coordinator.getOwnedState('query_1', 'workerReady')).toEqual({ status: 'ready', schemaSignature: 'independent' });
		expect(readiness).toHaveBeenCalledTimes(phase === 'lifecycle' ? 1 : 0);
		expect(lifecycle).not.toHaveBeenCalled();
	});

	it('publishes worker readiness revocation when a physical target owner rotates', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		coordinator.setTarget(lease, 'connection-a', 'DbA', {
			connectionRevision: 1,
			connectionIdentityKey: 'owner-1',
		});
		coordinator.setOwnedState('query_1', 'workerReady', { status: 'ready' });
		const readinessEvents: unknown[] = [];
		coordinator.subscribeOwnedState('query_1', 'workerReady', state => readinessEvents.push(state));

		coordinator.setTarget(lease, 'connection-a', 'DbA', {
			connectionRevision: 2,
			connectionIdentityKey: 'owner-2',
		});

		expect(readinessEvents).toEqual([undefined]);
		expect(coordinator.getOwnedState('query_1', 'workerReady')).toBeUndefined();
	});

	it('publishes worker readiness revocation before closing a mounted lifecycle owner', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		coordinator.setTarget(lease, 'connection-a', 'DbA');
		coordinator.setOwnedState('query_1', 'workerReady', { status: 'ready' });
		const readinessEvents: unknown[] = [];
		coordinator.subscribeOwnedState('query_1', 'workerReady', state => readinessEvents.push(state));

		coordinator.closeSection(lease);

		expect(readinessEvents).toEqual([undefined]);
		expect(coordinator.getOwnedState('query_1', 'workerReady')).toBeUndefined();
	});

	it('rotates identity when the current target is explicitly invalidated', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const before = coordinator.setTarget(lease, 'connection-a', 'DbA')!;
		coordinator.beginSchemaRequest(lease, 'schema-a');

		const after = coordinator.invalidateTarget(lease)!;

		expect(after.targetGeneration).toBeGreaterThan(before.targetGeneration);
		expect(coordinator.getTarget('query_1')).toEqual({ connectionId: 'connection-a', database: 'DbA' });
		expect(coordinator.getSchemaRequestToken('query_1')).toBeUndefined();
	});

	it('returns a frozen sanitized debug snapshot without raw schema contents', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		coordinator.setTarget(lease, 'connection-a', 'DbA');
		coordinator.attachModel(lease, 'inmemory://model/1');
		coordinator.setOwnedState('query_1', 'schema', {
			tables: ['Events'], functions: [{ name: 'f' }], rawSchemaJson: { secret: 'not exposed' },
		});
		coordinator.setOwnedState('query_1', 'preparation', {
			status: 'preparing', stage: 'waiting-worker', generation: 2, revision: 3,
			blockers: ['worker'], usableFallback: true,
		});
		coordinator.setOwnedState('query_1', 'workerReady', {
			status: 'pending', schemaKey: 'sensitive-key', schemaSignature: 'sensitive-signature',
			modelUri: 'inmemory://model/1',
		});

		const snapshot = coordinator.getDebugSnapshot();

		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.sections)).toBe(true);
		expect(snapshot.sections).toEqual([expect.objectContaining({
			boxId: 'query_1', targetGeneration: 1, hasConnection: true, hasDatabase: true,
			catalog: { tables: 1, functions: 1, hasRawSchema: true },
			worker: {
				status: 'pending', hasSchemaKey: true, hasSchemaSignature: true,
				modelMatches: true, preparationMatches: false,
			},
		})]);
		expect(JSON.stringify(snapshot)).not.toContain('not exposed');
		expect(JSON.stringify(snapshot)).not.toContain('sensitive-key');
	});

	it('keeps the generation stable for an equivalent target', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const first = coordinator.setTarget(lease, 'connection-a', 'DbA')!;
		const second = coordinator.setTarget(lease, 'connection-a', 'DbA')!;

		expect(second).toEqual(first);
	});

	it('keeps database and schema request streams independently current', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const connectionIdentity = coordinator.setTarget(lease, 'connection-a')!;
		const databaseRequest = coordinator.beginDatabaseRequest(lease, 'database-a')!;
		const schemaIdentity = coordinator.setTarget(lease, 'connection-a', 'DbA')!;
		const schemaRequest = coordinator.beginSchemaRequest(lease, 'schema-a')!;

		expect(coordinator.isDatabaseRequestCurrent(
			'query_1', connectionIdentity, 'connection-a', databaseRequest.requestToken,
		)).toBe(false);
		expect(coordinator.isSchemaRequestCurrent(
			'query_1', schemaIdentity, { connectionId: 'connection-a', database: 'DbA' }, schemaRequest.requestToken,
		)).toBe(true);
	});

	it('rejects model attachment and disposal from an old same-ID section', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const oldLease = coordinator.openSection('query_1', 'instance-old')!;
		const oldModel = coordinator.attachModel(oldLease, 'inmemory://model/old')!;
		coordinator.closeSection(oldLease);
		const newLease = coordinator.openSection('query_1', 'instance-new')!;
		const newModel = coordinator.attachModel(newLease, 'inmemory://model/new')!;

		expect(coordinator.getModelLease('query_1')).toEqual(newModel);
		expect(coordinator.attachModel(oldLease, 'inmemory://model/late')).toBeUndefined();
		expect(coordinator.detachModel(oldModel)).toBe(false);
		expect(coordinator.isModelLeaseCurrent(newModel)).toBe(true);
		expect(coordinator.detachModel(newModel)).toBe(true);
		expect(coordinator.isModelLeaseCurrent(newModel)).toBe(false);
		expect(coordinator.getModelLease('query_1')).toBeUndefined();
	});

	it('adopts pre-open state and atomically retires owned waiters and late writes', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const settled: boolean[] = [];
		coordinator.setOwnedState('query_1', 'schema', { name: 'prewarmed' });
		coordinator.setOwnedState('query_1', 'workerReadyWaiters', [{ resolve: (ready: boolean) => settled.push(ready) }]);

		const lease = coordinator.openSection('query_1', 'instance-1')!;
		expect(coordinator.getOwnedStateSnapshot('query_1').schema).toEqual({ name: 'prewarmed' });
		expect(coordinator.closeSection(lease)).toBe(true);
		expect(settled).toEqual([false]);
		expect(coordinator.getOwnedStateIds('schema')).toEqual([]);

		coordinator.setOwnedState('query_1', 'schema', { name: 'late' });
		expect(coordinator.getOwnedState('query_1', 'schema')).toBeUndefined();
		coordinator.openSection('query_1', 'instance-2');
		coordinator.setOwnedState('query_1', 'schema', { name: 'current' });
		expect(coordinator.getOwnedState('query_1', 'schema')).toEqual({ name: 'current' });
	});
});