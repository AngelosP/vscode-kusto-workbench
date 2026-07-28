import { describe, expect, it } from 'vitest';
import {
	publicationFromPersistedResultArtifact,
	ResultArtifactStore,
	toPersistedResultArtifact,
} from '../../src/shared/resultArtifact.js';

describe('ResultArtifactStore', () => {
	it('restores persisted identity and advances the next source revision', () => {
		const firstStore = new ResultArtifactStore();
		const original = firstStore.publish('query_1', {
			columns: [{ name: 'Value' }], rows: [[1]], metadata: {},
		}, {
			producer: { engine: 'kusto', boxId: 'query_1', executionId: 'execution-1' },
			policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 4 },
		})!;
		const descriptor = toPersistedResultArtifact(original)!;

		const restoredStore = new ResultArtifactStore();
		const restored = restoredStore.publish(
			'query_1',
			{ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} },
			publicationFromPersistedResultArtifact(descriptor, 'query_1'),
		)!;
		const rerun = restoredStore.publish('query_1', {
			columns: [{ name: 'Value' }], rows: [[2]], metadata: {},
		})!;

		expect(restored).toMatchObject({
			artifactId: original.artifactId,
			revision: original.revision,
			createdAt: original.createdAt,
			restored: true,
			producer: expect.objectContaining({ executionId: 'execution-1' }),
			policy: expect.objectContaining({ accountPartition: 'partition-a', leaveNoTraceRevision: 4 }),
		});
		expect(rerun.revision).toBe(restored.revision + 1);
		expect(rerun.artifactId).not.toBe(restored.artifactId);
	});

	it('rejects a persisted descriptor for another source section', () => {
		const descriptor = {
			version: 1, artifactId: 'result:query_1:7', sourceBoxId: 'query_1',
			revision: 7, createdAt: 123,
		};

		expect(publicationFromPersistedResultArtifact(descriptor, 'query_2')).toBeUndefined();
	});

	it('rejects persisted producer or policy claims that disagree with admitted ownership', () => {
		const base = {
			version: 1, artifactId: 'result:query_1:7', sourceBoxId: 'query_1',
			revision: 7, createdAt: 123,
		};

		expect(publicationFromPersistedResultArtifact({
			...base,
			producer: { boxId: 'query_other', executionId: 'forged' },
		}, 'query_1')).toBeUndefined();
		expect(publicationFromPersistedResultArtifact({
			...base,
			producer: { boxId: 'query_1', executionId: 'execution-1' },
			policy: { accountPartition: 'partition-b', leaveNoTraceRevision: 4 },
		}, 'query_1', {
			accountPartition: 'partition-a', leaveNoTraceRevision: 4,
		})).toBeUndefined();
	});

	it('restores the saved identity after the same runtime previously advanced farther', () => {
		const store = new ResultArtifactStore();
		store.publish('query_1', { columns: [], rows: [[1]], metadata: {} });
		store.publish('query_1', { columns: [], rows: [[2]], metadata: {} });
		store.clearCurrent('query_1');
		const descriptor = {
			version: 1 as const,
			artifactId: 'result:query_1:1',
			sourceBoxId: 'query_1',
			revision: 1,
			createdAt: 10,
		};

		const restored = store.publish(
			'query_1',
			{ columns: [], rows: [['restored']], metadata: {} },
			publicationFromPersistedResultArtifact(descriptor, 'query_1'),
		)!;
		const next = store.publish('query_1', { columns: [], rows: [['next']], metadata: {} })!;

		expect(restored).toMatchObject({ artifactId: descriptor.artifactId, revision: 1, restored: true });
		expect(next.revision).toBe(3);
	});

	it('retains old revisions only while a consumer is bound', () => {
		const store = new ResultArtifactStore();
		const first = store.publish('query_1', { columns: [], rows: [[1]], metadata: {} })!;
		store.bind('chart_1', 'query_1');
		const second = store.publish('query_1', { columns: [], rows: [[2]], metadata: {} })!;

		expect(store.get(first.artifactId)).toBe(first);
		expect(store.get(second.artifactId)).toBe(second);
		store.bind('chart_1', 'query_1');
		expect(store.get(first.artifactId)).toBeUndefined();
		expect(store.get(second.artifactId)).toBe(second);
	});
});
