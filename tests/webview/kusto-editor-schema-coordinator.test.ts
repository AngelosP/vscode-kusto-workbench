import { describe, expect, it } from 'vitest';

import { KustoEditorSchemaCoordinator } from '../../src/webview/core/kusto-editor-schema-coordinator.js';

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
			worker: { status: 'pending', hasSchemaKey: true, hasSchemaSignature: true, modelMatches: true },
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