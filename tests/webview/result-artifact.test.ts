import { describe, expect, it } from 'vitest';
import {
	createDerivedResultArtifactPublication,
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
		expect(publicationFromPersistedResultArtifact({
			...base,
			producer: { boxId: 'query_1', executionId: 'execution-1' },
			policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 4 },
		}, 'query_1', {
			accountPartition: 'partition-a', leaveNoTraceRevision: 4, exposeToActiveContent: true,
		})).toBeUndefined();
		expect(publicationFromPersistedResultArtifact({
			...base,
			producer: { boxId: 'query_1', executionId: 'execution-1' },
			policy: {
				accountPartition: 'partition-a', leaveNoTraceRevision: 4,
				exposeToActiveContent: true,
			},
		}, 'query_1', {
			accountPartition: 'partition-a', leaveNoTraceRevision: 4,
			exposeToActiveContent: true, sendToModel: true,
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

	it('finds a pinned source revision by producer execution after current advances', () => {
		const store = new ResultArtifactStore();
		const sourceA = store.publish('query_source', { columns: [], rows: [['a']], metadata: {} }, {
			producer: { engine: 'kusto', boxId: 'query_source', executionId: 'source-a' },
		})!;
		store.bind('comparison:query_cmp:source', 'query_source', sourceA.artifactId);
		store.publish('query_source', { columns: [], rows: [['b']], metadata: {} }, {
			producer: { engine: 'kusto', boxId: 'query_source', executionId: 'source-b' },
		});

		expect(store.getByProducerExecution('query_source', 'source-a')).toBe(sourceA);
		expect(store.getByProducerExecution('query_source', 'missing')).toBeUndefined();
	});

	it('publishes truthful lineage and source policies for differently owned inputs', () => {
		const store = new ResultArtifactStore();
		const left = store.publish('query_left', { columns: [], rows: [[1]], metadata: {} }, {
			policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 4 },
		})!;
		const right = store.publish('query_right', { columns: [], rows: [[2]], metadata: {} }, {
			policy: { accountPartition: 'partition-b', leaveNoTraceRevision: 7 },
		})!;

		const publication = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_1', producer: 'join' },
			[
				{ artifact: left, role: 'primary' },
				{ artifact: right, role: 'join-right' },
			],
		);

		expect(publication).toEqual({
			producer: { engine: 'transformation', boxId: 'transformation_1', producer: 'join' },
			lineage: [
				{ sourceArtifactId: left.artifactId, role: 'primary' },
				{ sourceArtifactId: right.artifactId, role: 'join-right' },
			],
			policy: {
				sourcePolicies: [
					{ sourceArtifactId: left.artifactId, accountPartition: 'partition-a', leaveNoTraceRevision: 4 },
					{ sourceArtifactId: right.artifactId, accountPartition: 'partition-b', leaveNoTraceRevision: 7 },
				],
			},
		});
	});

	it('keeps direct derived lineage while flattening policy ancestry to leaf artifacts', () => {
		const store = new ResultArtifactStore();
		const source = store.publish('query_source', { columns: [], rows: [[1]], metadata: {} }, {
			policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 4 },
		})!;
		const firstDerived = store.publish(
			'transformation_1',
			{ columns: [], rows: [[1]], metadata: {} },
			createDerivedResultArtifactPublication(
				{ engine: 'transformation', boxId: 'transformation_1', producer: 'derive' },
				[{ artifact: source, role: 'primary' }],
			),
		)!;

		const publication = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_2', producer: 'summarize' },
			[{ artifact: firstDerived, role: 'primary' }],
		);

		expect(publication.lineage).toEqual([
			{ sourceArtifactId: firstDerived.artifactId, role: 'primary' },
		]);
		expect(publication.policy).toEqual({
			accountPartition: 'partition-a',
			leaveNoTraceRevision: 4,
			sourcePolicies: [{
				sourceArtifactId: source.artifactId,
				accountPartition: 'partition-a',
				leaveNoTraceRevision: 4,
			}],
		});
	});

	it('allows derived active-content exposure only when every leaf source allows it', () => {
		const store = new ResultArtifactStore();
		const allowed = store.publish('query_allowed', { columns: [], rows: [[1]], metadata: {} }, {
			policy: { accountPartition: 'partition-a', exposeToActiveContent: true },
		})!;
		const differentlyOwnedAllowed = store.publish('query_allowed_other', { columns: [], rows: [[3]], metadata: {} }, {
			policy: { accountPartition: 'partition-b', exposeToActiveContent: true },
		})!;
		const denied = store.publish('query_denied', { columns: [], rows: [[2]], metadata: {} }, {
			policy: { exposeToActiveContent: false },
		})!;

		const allowedPublication = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_allowed' },
			[{ artifact: allowed, role: 'primary' }],
		);
		const mixedPublication = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_mixed' },
			[{ artifact: allowed, role: 'primary' }, { artifact: denied, role: 'join-right' }],
		);
		const differentlyOwnedAllowedPublication = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_allowed_join' },
			[{ artifact: allowed, role: 'primary' }, { artifact: differentlyOwnedAllowed, role: 'join-right' }],
		);

		expect(allowedPublication.policy?.exposeToActiveContent).toBe(true);
		expect(differentlyOwnedAllowedPublication.policy?.accountPartition).toBeUndefined();
		expect(differentlyOwnedAllowedPublication.policy?.exposeToActiveContent).toBe(true);
		expect(mixedPublication.policy?.exposeToActiveContent).toBeUndefined();
	});

	it('allows derived model use only when every leaf source allows it', () => {
		const store = new ResultArtifactStore();
		const allowedA = store.publish('query_model_a', { columns: [], rows: [[1]], metadata: {} }, {
			policy: { accountPartition: 'partition-a', sendToModel: true },
		})!;
		const allowedB = store.publish('query_model_b', { columns: [], rows: [[2]], metadata: {} }, {
			policy: { accountPartition: 'partition-b', sendToModel: true },
		})!;
		const denied = store.publish('query_model_denied', { columns: [], rows: [[3]], metadata: {} }, {
			policy: { sendToModel: false },
		})!;

		const allowed = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_model_allowed' },
			[{ artifact: allowedA }, { artifact: allowedB }],
		);
		const mixed = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_model_mixed' },
			[{ artifact: allowedA }, { artifact: denied }],
		);

		expect(allowed.policy?.accountPartition).toBeUndefined();
		expect(allowed.policy?.sendToModel).toBe(true);
		expect(mixed.policy?.sendToModel).toBeUndefined();
	});

	it('denies derived model use when any direct or nested leaf omits permission', () => {
		const store = new ResultArtifactStore();
		const allowed = store.publish('query_model_allowed', { columns: [], rows: [[1]], metadata: {} }, {
			policy: { sendToModel: true },
		})!;
		const missing = store.publish('query_model_missing', { columns: [], rows: [[2]], metadata: {} })!;
		const mixed = store.publish(
			'transformation_model_mixed',
			{ columns: [], rows: [[3]], metadata: {} },
			createDerivedResultArtifactPublication(
				{ engine: 'transformation', boxId: 'transformation_model_mixed' },
				[{ artifact: allowed }, { artifact: missing }],
			),
		)!;
		const nested = createDerivedResultArtifactPublication(
			{ engine: 'transformation', boxId: 'transformation_model_nested' },
			[{ artifact: mixed }],
		);

		expect(mixed.policy?.sourcePolicies).toEqual([
			{ sourceArtifactId: allowed.artifactId, sendToModel: true },
			{ sourceArtifactId: missing.artifactId },
		]);
		expect(mixed.policy?.sendToModel).toBeUndefined();
		expect(nested.policy?.sourcePolicies).toEqual(mixed.policy?.sourcePolicies);
		expect(nested.policy?.sendToModel).toBeUndefined();
	});

	it('requires local admission and consistent leaf ancestry for persisted capabilities', () => {
		const base = {
			version: 1, artifactId: 'result:query_derived:7', sourceBoxId: 'query_derived',
			revision: 7, createdAt: 123,
		};
		const direct = {
			...base,
			policy: { sendToModel: true },
		};
		const missingAncestry = {
			...base,
			lineage: [{ sourceArtifactId: 'result:query_source:2' }],
			policy: { sendToModel: true },
		};
		const deniedAncestry = {
			...base,
			lineage: [{ sourceArtifactId: 'result:query_source:2' }],
			policy: {
				sendToModel: true,
				sourcePolicies: [{ sourceArtifactId: 'result:query_source:2', sendToModel: false }],
			},
		};

		expect(publicationFromPersistedResultArtifact(direct, 'query_derived')).toBeUndefined();
		expect(publicationFromPersistedResultArtifact(
			direct, 'query_derived', { sendToModel: true },
		)).toBeDefined();
		expect(publicationFromPersistedResultArtifact(
			missingAncestry, 'query_derived', { sendToModel: true },
		)).toBeUndefined();
		expect(publicationFromPersistedResultArtifact(
			deniedAncestry, 'query_derived', { sendToModel: true },
		)).toBeUndefined();
	});

	it('accepts persisted derived ancestry only when it matches locally reconstructed sources', () => {
		const store = new ResultArtifactStore();
		const source = store.publish('query_source', { columns: [], rows: [[1]], metadata: {} }, {
			policy: { accountPartition: 'partition-a', exposeToActiveContent: true, sendToModel: true },
		})!;
		const trusted = createDerivedResultArtifactPublication(
			{ engine: 'kusto', boxId: 'query_comparison', producer: 'comparison' },
			[{ artifact: source, role: 'comparison-source' }],
		);
		const descriptor = {
			version: 1, artifactId: 'result:query_comparison:4', sourceBoxId: 'query_comparison',
			revision: 4, createdAt: 123,
			policy: trusted.policy,
			lineage: trusted.lineage,
		};
		const expectedAdmission = {
			exposeToActiveContent: true,
			sendToModel: true,
			derivedLineage: trusted.lineage,
			derivedSourcePolicies: trusted.policy?.sourcePolicies,
		};

		expect(publicationFromPersistedResultArtifact(
			descriptor, 'query_comparison', expectedAdmission,
		)).toMatchObject({ lineage: trusted.lineage, policy: trusted.policy });
		expect(publicationFromPersistedResultArtifact({
			...descriptor,
			lineage: [{ sourceArtifactId: 'result:unrelated:1', role: 'comparison-source' }],
		}, 'query_comparison', expectedAdmission)).toBeUndefined();
		expect(publicationFromPersistedResultArtifact({
			...descriptor,
			policy: {
				...descriptor.policy,
				sourcePolicies: [{ sourceArtifactId: 'result:unrelated:1', sendToModel: true }],
			},
		}, 'query_comparison', expectedAdmission)).toBeUndefined();
		expect(publicationFromPersistedResultArtifact({
			...descriptor, lineage: undefined, policy: { sendToModel: true },
		}, 'query_comparison', expectedAdmission)).toBeUndefined();
	});
});
