import { describe, expect, it } from 'vitest';

import { KustoResultPersistenceOwner } from '../../../src/host/kustoResultPersistenceOwner.js';
import { createKustoResultBatch } from '../../../src/shared/kustoResultBatch.js';
import { getKustoConnectionIdentityKey } from '../../../src/shared/kustoAuth.js';
import { UNVERIFIED_LEGACY_RESULT_PRODUCER } from '../../../src/shared/resultArtifact.js';

function batch() {
	const created = createKustoResultBatch([
		{ columns: ['First'], rows: [[1]], metadata: { cluster: 'https://cluster', database: 'Db' } },
		{ columns: ['Second'], rows: [[2]], metadata: { cluster: 'https://cluster', database: 'Db' } },
	]);
	if (!created.ok) throw new Error(created.error);
	return created.value;
}

function terminal(executionId = 'execution-1') {
	return {
		type: 'queryResult' as const,
		engine: 'kusto' as const,
		boxId: 'query_1',
		sectionInstanceId: 'section-instance-1',
		targetGeneration: 1,
		executionId,
		connectionId: 'connection-1',
		database: 'Db',
		producer: 'manual' as const,
		query: 'print First=1; print Second=2',
		reservationSequence: 1,
		dispatch: {
			dispatchAttempt: 1,
			connectionRevision: 4,
			leaveNoTraceRevision: 2,
			connectionIdentityKey: 'https://cluster|',
			clusterEndpoint: 'https://cluster',
			accountPartition: 'partition-a',
			authSessionGeneration: 3,
			clientActivityId: 'activity-1',
		},
		result: batch(),
	};
}

function createOwner() {
	const owner = new KustoResultPersistenceOwner('file:///workbook.kqlx', {
		now: () => 123,
	});
	const session = owner.openPanel('panel-1');
	session.openSection('query_1', 'section-instance-1');
	session.adoptTarget({
		boxId: 'query_1', sectionInstanceId: 'section-instance-1', targetGeneration: 1,
		connectionId: 'connection-1', database: 'Db',
	});
	return { owner, session };
}

describe('KustoResultPersistenceOwner', () => {
	it('leaves persisted fields untouched before any canonical source is admitted', () => {
		const owner = new KustoResultPersistenceOwner('file:///opening.kqlx');
		const state = {
			sections: [{
				id: 'query_1', type: 'query', query: 'print Value=1', resultJson: '{"rows":[[1]]}',
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			}],
		};

		expect(owner.overlaySnapshot(state)).toBe(state);
	});

	it('does not let pre-source target adoption create row-free authority', () => {
		const first = createOwner();
		first.session.beginExecution(terminal());
		first.session.stagePublication('publication-1', terminal());
		first.session.commitPublication('publication-1');
		const persisted = first.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});

		const owner = new KustoResultPersistenceOwner('file:///opening-target.kqlx');
		const session = owner.openPanel('opening-panel');
		session.openSection('query_1', 'opening-instance');
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'opening-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 4,
			connectionIdentityKey: 'https://cluster|',
		});

		expect(owner.overlaySnapshot(persisted)).toBe(persisted);
		owner.admitCanonicalSource('opening-source', persisted);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).toHaveProperty('resultJson');
	});

	it('commits a prepared persisted source after matching initial target adoption', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const owner = new KustoResultPersistenceOwner('file:///prepared-opening-target.kqlx');
		const admission = owner.prepareCanonicalSource('opening-source', persisted, '1');
		const session = owner.openPanel('opening-panel');
		session.openSection('query_1', 'opening-instance');

		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'opening-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 4,
			connectionIdentityKey: 'https://cluster|',
		})).toBe(true);
		expect(admission?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('execution-1');
	});

	it('rejects a prepared persisted source after mismatched initial target adoption', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const owner = new KustoResultPersistenceOwner('file:///prepared-opening-mismatch.kqlx');
		const admission = owner.prepareCanonicalSource('opening-source', persisted, '1');
		const session = owner.openPanel('opening-panel');
		session.openSection('query_1', 'opening-instance');

		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'opening-instance', targetGeneration: 1,
			connectionId: 'other-connection', database: 'OtherDb', connectionRevision: 4,
			connectionIdentityKey: 'https://other-cluster|',
		})).toBe(true);
		expect(admission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource('opening-source', persisted, '1');
		expect(retry?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(retry?.commit()).toBe(true);
	});

	it('ignores a closing panel target when admitting a surviving panel source', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const owner = new KustoResultPersistenceOwner('file:///two-panel-opening.kqlx');
		const closing = owner.openPanel('closing-panel');
		closing.openSection('query_1', 'closing-instance');
		closing.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'closing-instance', targetGeneration: 1,
			connectionId: 'other-connection', database: 'OtherDb', connectionRevision: 9,
			connectionIdentityKey: 'https://other-cluster|',
		});
		const surviving = owner.openPanel('surviving-panel');
		surviving.openSection('query_1', 'surviving-instance');
		const admission = owner.prepareCanonicalSource(
			'opening-source', persisted, '1', surviving.panelId,
		);
		surviving.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'surviving-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 4,
			connectionIdentityKey: 'https://cluster|',
		});

		expect(admission?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('execution-1');
	});

	it('keeps overlapping prepared sources isolated by their own target', () => {
		const matchingSource = createOwner();
		matchingSource.session.beginExecution(terminal('matching-execution'));
		matchingSource.session.stagePublication('matching-publication', terminal('matching-execution'));
		matchingSource.session.commitPublication('matching-publication');
		const matchingState = matchingSource.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const mismatchedOwner = new KustoResultPersistenceOwner('file:///mismatched-source.kqlx');
		const mismatchedSession = mismatchedOwner.openPanel('mismatched-source-panel');
		mismatchedSession.openSection('query_1', 'section-instance-1');
		mismatchedSession.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-1', targetGeneration: 1,
			connectionId: 'other-connection', database: 'OtherDb',
		});
		const mismatchedTerminal = {
			...terminal('mismatched-execution'), connectionId: 'other-connection', database: 'OtherDb',
			dispatch: {
				...terminal().dispatch, clusterEndpoint: 'https://other-cluster',
				connectionIdentityKey: 'https://other-cluster|',
			},
		};
		mismatchedSession.beginExecution(mismatchedTerminal);
		mismatchedSession.stagePublication('mismatched-publication', mismatchedTerminal);
		mismatchedSession.commitPublication('mismatched-publication');
		const mismatchedState = mismatchedOwner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=2' }],
		});
		const owner = new KustoResultPersistenceOwner('file:///overlapping-opening.kqlx');
		const matchingAdmission = owner.prepareCanonicalSource('matching-source', matchingState, '1');
		const mismatchedAdmission = owner.prepareCanonicalSource('mismatched-source', mismatchedState, '2');
		const session = owner.openPanel('opening-panel');
		session.openSection('query_1', 'opening-instance');
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'opening-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 4,
			connectionIdentityKey: 'https://cluster|',
		});

		expect(mismatchedAdmission?.commit()).toBe(false);
		expect(matchingAdmission?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('matching-execution');
		mismatchedAdmission?.abandonRetry();
	});

	it('treats an admitted source with no Kusto sections as authoritative', () => {
		const owner = new KustoResultPersistenceOwner('file:///empty-source.kqlx');
		owner.admitCanonicalSource('empty-source', { sections: [] });
		const overlaid = owner.overlaySnapshot({
			sections: [{
				id: 'query_1', type: 'query', resultJson: '{"rows":[[1]]}',
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			}],
		});

		expect(overlaid.sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('previews a canonical source without mutating authority until commit', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());
		session.stagePublication('publication-1', terminal());
		session.commitPublication('publication-1');
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		};

		const admission = owner.prepareCanonicalSource('changed-source', rowFreeState, '2');

		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
		expect(admission?.commit()).toBe(false);
		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('rejects a row-free candidate after a newer host result commits', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		session.stagePublication('publication-1', terminal('execution-1'));
		session.commitPublication('publication-1');
		const admission = owner.prepareCanonicalSource('row-free-candidate', {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		}, '2');
		const newer = { ...terminal('execution-2'), reservationSequence: 2 };
		session.beginExecution(newer);
		session.stagePublication('publication-2', newer);
		session.commitPublication('publication-2');

		expect(admission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource('row-free-candidate', {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		}, '2');
		expect(retry?.projectedState.sections?.[0]).toHaveProperty('resultJson');
		expect(retry?.commit()).toBe(true);
		const section = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		}).sections?.[0] as Record<string, any>;
		expect(section.resultArtifact.revision).toBe(2);
		expect(section.resultArtifact.producer.executionId).toBe('execution-2');
	});

	it('retains retry lineage when an overlapping same-source candidate is discarded', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		session.stagePublication('publication-1', terminal('execution-1'));
		session.commitPublication('publication-1');
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		};
		const rejected = owner.prepareCanonicalSource('shared-candidate', rowFreeState, '2')!;
		const conflicted = owner.prepareCanonicalSource('shared-candidate', rowFreeState, '2')!;
		rejected.discard();
		const newer = { ...terminal('execution-2'), reservationSequence: 2 };
		session.beginExecution(newer);
		session.stagePublication('publication-2', newer);
		session.commitPublication('publication-2');

		expect(conflicted.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource('shared-candidate', rowFreeState, '2')!;
		expect(retry.projectedState.sections?.[0]).toHaveProperty('resultJson');
		expect(retry.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('execution-2');
	});

	it('retains retry lineage when the first rebased retry is discarded', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		session.stagePublication('publication-1', terminal('execution-1'));
		session.commitPublication('publication-1');
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		};
		const rejected = owner.prepareCanonicalSource('discarded-retry-candidate', rowFreeState, '2')!;
		const newer = { ...terminal('execution-2'), reservationSequence: 2 };
		session.beginExecution(newer);
		session.stagePublication('publication-2', newer);
		session.commitPublication('publication-2');
		expect(rejected.commit()).toBe(false);

		const discardedRetry = owner.prepareCanonicalSource('discarded-retry-candidate', rowFreeState, '2')!;
		expect(discardedRetry.projectedState.sections?.[0]).toHaveProperty('resultJson');
		discardedRetry.discard();
		const finalRetry = owner.prepareCanonicalSource('discarded-retry-candidate', rowFreeState, '2')!;
		expect(finalRetry.projectedState.sections?.[0]).toHaveProperty('resultJson');
		expect(finalRetry.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('execution-2');
	});

	it('releases retry lineage when a conflicted admission is explicitly abandoned', () => {
		const { owner, session } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		};
		const admission = owner.prepareCanonicalSource('abandoned-candidate', rowFreeState, '2')!;
		const newer = { ...terminal('execution-2'), reservationSequence: 2 };
		session.beginExecution(newer);
		session.stagePublication('publication-2', newer);
		session.commitPublication('publication-2');

		expect(admission.commit()).toBe(false);
		admission.abandonRetry();

		expect((owner as any).preparedSourceOwnerRevisionByIdentity.size).toBe(0);
	});

	it('releases retained retry lineage when its panel closes', () => {
		const { owner, session } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		};
		const admission = owner.prepareCanonicalSource(
			'closing-panel-candidate', rowFreeState, '2', session.panelId,
		)!;
		const newer = { ...terminal('execution-2'), reservationSequence: 2 };
		session.beginExecution(newer);
		session.stagePublication('publication-2', newer);
		session.commitPublication('publication-2');

		expect(admission.commit()).toBe(false);
		expect((owner as any).preparedSourceOwnerRevisionByIdentity.size).toBe(1);
		session.dispose();
		expect((owner as any).preparedSourceOwnerRevisionByIdentity.size).toBe(0);
	});

	it('retires overlapping panel retry claims independently', () => {
		const owner = new KustoResultPersistenceOwner('file:///multi-panel-retry.kqlx');
		const firstPanel = owner.openPanel('first-panel');
		const secondPanel = owner.openPanel('second-panel');
		for (const [session, instance] of [[firstPanel, 'first-instance'], [secondPanel, 'second-instance']] as const) {
			session.openSection('query_1', instance);
			session.adoptTarget({
				boxId: 'query_1', sectionInstanceId: instance, targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
		}
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		};
		const firstAdmission = owner.prepareCanonicalSource(
			'shared-panel-candidate', rowFreeState, '2', firstPanel.panelId,
		)!;
		const secondAdmission = owner.prepareCanonicalSource(
			'shared-panel-candidate', rowFreeState, '2', secondPanel.panelId,
		)!;
		const newer = { ...terminal('execution-2'), reservationSequence: 2 };
		firstPanel.beginExecution({ ...newer, sectionInstanceId: 'first-instance' });
		firstPanel.stagePublication('publication-2', { ...newer, sectionInstanceId: 'first-instance' });
		firstPanel.commitPublication('publication-2');

		expect(firstAdmission.commit()).toBe(false);
		expect(secondAdmission.commit()).toBe(false);
		const observation = [...(owner as any).preparedSourceOwnerRevisionByIdentity.values()][0];
		expect(observation.retryClaims.size).toBe(2);
		const firstRetry = owner.prepareCanonicalSource(
			'shared-panel-candidate', rowFreeState, '2', firstPanel.panelId,
		)!;
		expect(firstRetry.projectedState.sections?.[0]).toHaveProperty('resultJson');
		expect(firstRetry.commit()).toBe(true);
		expect(observation.retryClaims.size).toBe(1);
		secondAdmission.abandonRetry();
		expect((owner as any).preparedSourceOwnerRevisionByIdentity.size).toBe(0);
	});

	it('retires only the observing panel retry claim when its source changes', () => {
		const owner = new KustoResultPersistenceOwner('file:///panel-source-change.kqlx');
		const firstPanel = owner.openPanel('first-panel');
		const secondPanel = owner.openPanel('second-panel');
		for (const [session, instance] of [[firstPanel, 'first-instance'], [secondPanel, 'second-instance']] as const) {
			session.openSection('query_1', instance);
			session.adoptTarget({
				boxId: 'query_1', sectionInstanceId: instance, targetGeneration: 1,
				connectionId: 'connection-1', database: 'Db',
			});
		}
		const sourceA = { sections: [{ id: 'query_1', type: 'query', query: 'print A=1' }] };
		const firstA = owner.prepareCanonicalSource('source-a', sourceA, '1', firstPanel.panelId)!;
		const secondA = owner.prepareCanonicalSource('source-a', sourceA, '1', secondPanel.panelId)!;
		const newer = { ...terminal('execution-2'), reservationSequence: 2, sectionInstanceId: 'first-instance' };
		firstPanel.beginExecution(newer);
		firstPanel.stagePublication('publication-2', newer);
		firstPanel.commitPublication('publication-2');
		expect(firstA.commit()).toBe(false);
		expect(secondA.commit()).toBe(false);
		const sourceAObservation = [...(owner as any).preparedSourceOwnerRevisionByIdentity.values()][0];
		expect(sourceAObservation.retryClaims.size).toBe(2);

		const sourceB = owner.prepareCanonicalSource(
			'source-b', { sections: [{ id: 'query_1', type: 'query', query: 'print B=1' }] },
			'2', firstPanel.panelId,
		)!;
		expect(sourceAObservation.retryClaims.size).toBe(1);
		sourceB.discard();
		secondA.abandonRetry();
		expect((owner as any).preparedSourceOwnerRevisionByIdentity.size).toBe(0);
	});

	it('rejects a result-bearing candidate after target revocation', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const owner = new KustoResultPersistenceOwner('file:///revoked-candidate.kqlx');
		owner.admitCanonicalSource('row-free-baseline', {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}, '1');
		const admission = owner.prepareCanonicalSource('result-candidate', persisted, '2');
		const session = owner.openPanel('revoked-panel');
		session.openSection('query_1', 'revoked-instance');
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'revoked-instance', targetGeneration: 1,
			connectionId: 'other-connection', database: 'OtherDb',
		});

		expect(admission?.projectedState.sections?.[0]).toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource('result-candidate', persisted, '2');
		expect(retry?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(retry?.commit()).toBe(true);
		expect(owner.overlaySnapshot(persisted).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('rejects a cold result-bearing admission after the Kusto policy snapshot changes', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const owner = new KustoResultPersistenceOwner('file:///policy-race.kqlx');
		owner.revokePolicyIncompatibleAttachments({
			version: 1, clusterKeys: [], globallyBlocked: false,
			revocationGenerations: { cluster: 2 },
		});
		const admission = owner.prepareCanonicalSource('policy-source', persisted, '1')!;

		owner.revokePolicyIncompatibleAttachments({
			version: 2, clusterKeys: ['https://cluster'], globallyBlocked: true,
			revocationGenerations: { cluster: 3 },
		});

		expect(admission.commit()).toBe(false);
		admission.abandonRetry();
		expect(owner.hasCommittedAttachments()).toBe(false);
	});

	it('rejects a cold admission after authoritative sanitation removes its result', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const rowFree = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		const owner = new KustoResultPersistenceOwner('file:///sanitation-race.kqlx');
		const admission = owner.prepareCanonicalSource('sanitation-source', persisted, '1')!;

		owner.revokeSanitizedAttachments(persisted, rowFree);

		expect(admission.commit()).toBe(false);
		admission.abandonRetry();
		expect(owner.hasCommittedAttachments()).toBe(false);
	});

	it('rejects a cold admission after connection revocation with no committed attachment', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const owner = new KustoResultPersistenceOwner('file:///connection-race.kqlx');
		const admission = owner.prepareCanonicalSource('connection-source', persisted, '1')!;

		owner.revokeConnections(new Set(['connection-1']));

		expect(admission.commit()).toBe(false);
		admission.abandonRetry();
		expect(owner.hasCommittedAttachments()).toBe(false);
	});

	it('commits the detached candidate even if caller-owned preview values mutate', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const expectedResultJson = String((persisted.sections?.[0] as Record<string, unknown>).resultJson);
		const owner = new KustoResultPersistenceOwner('file:///detached-candidate.kqlx');
		const admission = owner.prepareCanonicalSource('detached-source', persisted, '1')!;
		(persisted.sections?.[0] as Record<string, unknown>).resultJson = 'mutated-input';
		(admission.projectedState.sections?.[0] as Record<string, unknown>).resultJson = 'mutated-preview';

		expect(admission.commit()).toBe(true);
		expect((owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0] as Record<string, unknown>).resultJson).toBe(expectedResultJson);
	});

	it('rejects malformed canonical state without establishing authority', () => {
		const owner = new KustoResultPersistenceOwner('file:///malformed-source.kqlx');
		const malformed = {};

		expect(owner.prepareCanonicalSource('malformed', malformed, '1')).toBeUndefined();
		owner.admitCanonicalSource('malformed', malformed, '1');
		expect(owner.hasCanonicalResultState()).toBe(false);
	});

	it('commits an applied publication and overlays the complete authoritative attachment', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());

		const staged = session.stagePublication('publication-1', terminal());
		expect(staged?.resultArtifactAssignment).toMatchObject({
			version: 1, artifactId: 'result:query_1:1', sourceBoxId: 'query_1', revision: 1,
			producer: { executionId: 'execution-1', connectionId: 'connection-1' },
			policy: {
				accountPartition: 'partition-a', leaveNoTraceRevision: 2,
				exposeToActiveContent: true, sendToModel: true,
				shareToClipboard: true, exportToCsv: true,
			},
		});
		expect(session.commitPublication('publication-1')).toBe(true);

		const overlaid = owner.overlaySnapshot({
			sections: [{
				id: 'query_1', type: 'query', query: 'print First=1',
				resultJson: 'forged', kustoAccountPartition: 'forged', selectedResultIndex: 99,
			}],
		});
		const section = overlaid.sections?.[0] as Record<string, unknown>;
		expect(JSON.parse(String(section.resultJson))).toMatchObject({
			columns: ['First'], rows: [[1]],
			additionalResults: { version: 1, sets: [{ resultIndex: 1, columns: ['Second'], rows: [[2]] }] },
		});
		expect(section).toMatchObject({
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 2,
			resultArtifact: expect.objectContaining({ artifactId: 'result:query_1:1' }),
		});
		expect(section.selectedResultIndex).toBeUndefined();
	});

	it('persists the trusted execution target for a runtime-only favorite selection', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());
		session.stagePublication('publication-1', terminal());
		session.commitPublication('publication-1');

		const section = owner.overlaySnapshot({
			sections: [{
				id: 'query_1', type: 'query', query: 'print First=1',
				favoritesMode: true, runMode: 'runAll', authorityId: 'stale-authority',
			}],
		}).sections?.[0] as Record<string, unknown>;

		expect(section).toMatchObject({
			clusterUrl: 'https://cluster',
			connectionIdHint: 'connection-1',
			database: 'Db',
			favoritesMode: true,
			runMode: 'runAll',
			resultJson: expect.any(String),
		});
		expect(section).not.toHaveProperty('authorityId');
	});

	it('preserves a restored attachment when the first adopted target matches exactly', () => {
		const first = createOwner();
		first.session.beginExecution(terminal());
		first.session.stagePublication('publication-1', terminal());
		first.session.commitPublication('publication-1');
		const persisted = first.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});

		const owner = new KustoResultPersistenceOwner('file:///reopened.kqlx');
		owner.admitCanonicalSource('reopened-source', persisted);
		const session = owner.openPanel('reopened-panel');
		session.openSection('query_1', 'reopened-instance');

		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		})).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).toHaveProperty('resultJson');

		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 4,
			connectionIdentityKey: 'https://cluster|',
		})).toBe(true);
		const summary = owner.getCommittedSummary('query_1');
		expect(summary).toBeTruthy();
		expect(session.selectResult({
			requestId: 'reopened-selection', boxId: 'query_1',
			sectionInstanceId: 'reopened-instance', targetGeneration: 2,
			primaryArtifactId: summary!.primaryArtifactId, resultIndex: 1,
		})).toEqual({ accepted: true, resultIndex: 1 });
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).toMatchObject({ selectedResultIndex: 1, resultJson: expect.any(String) });
	});

	it('does not let a stale panel retarget or execution clear the owner panel attachment', () => {
		const { owner, session: ownerPanel } = createOwner();
		ownerPanel.beginExecution(terminal());
		ownerPanel.stagePublication('publication-1', terminal());
		ownerPanel.commitPublication('publication-1');
		const stalePanel = owner.openPanel('stale-panel');
		stalePanel.openSection('query_1', 'stale-instance');
		ownerPanel.dispose();

		expect(stalePanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'stale-instance', targetGeneration: 1,
			connectionId: 'other-connection', database: 'OtherDb',
		})).toBe(true);
		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('execution-1');
		expect(stalePanel.beginExecution({
			...terminal('stale-execution'), sectionInstanceId: 'stale-instance',
			connectionId: 'other-connection', database: 'OtherDb', reservationSequence: 2,
		})).toBe(false);
		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('execution-1');
	});

	it('keeps committed rows scoped to each panel target after retarget', () => {
		const { owner, session: firstPanel } = createOwner();
		expect(firstPanel.beginExecution(terminal())).toBe(true);
		expect(firstPanel.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(firstPanel.commitPublication('publication-1')).toBe(true);
		const secondPanel = owner.openPanel('panel-2');
		expect(secondPanel.openSection('query_1', 'section-instance-2')).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 1,
			connectionId: 'connection-2', database: 'OtherDb',
			connectionIdentityKey: 'https://other-cluster|',
		})).toBe(true);
		const targetBState = { sections: [{
			id: 'query_1', type: 'query', clusterUrl: 'https://other-cluster',
			connectionIdHint: 'connection-2', database: 'OtherDb',
		}] };

		const secondOverlay = owner.overlaySnapshot(targetBState, 'panel-2').sections?.[0] as Record<string, unknown>;

		expect(secondOverlay).not.toHaveProperty('resultJson');
		expect(secondOverlay.clusterUrl).toBe('https://other-cluster');
		expect(secondOverlay.connectionIdHint).toBe('connection-2');
		expect(secondOverlay.database).toBe('OtherDb');
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}, 'panel-1').sections?.[0]).toHaveProperty('resultJson');
		expect(owner.getCommittedSummary('query_1')).toBeTruthy();
	});

	it('revokes a restored attachment when physical target enrichment mismatches', () => {
		const first = createOwner();
		first.session.beginExecution(terminal());
		first.session.stagePublication('publication-1', terminal());
		first.session.commitPublication('publication-1');
		const persisted = first.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});

		const owner = new KustoResultPersistenceOwner('file:///reopened-mismatch.kqlx');
		owner.admitCanonicalSource('reopened-source', persisted);
		const session = owner.openPanel('reopened-panel');
		session.openSection('query_1', 'reopened-instance');
		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		})).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).toHaveProperty('resultJson');

		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 5,
			connectionIdentityKey: 'https://cluster|other-authority',
		})).toBe(true);

		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it.each([
		['equal', 1],
		['higher', 2],
	] as const)('does not let an %s-revision stale attachment overwrite an external retarget', (_kind, revision) => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());
		session.stagePublication('publication-1', terminal());
		session.commitPublication('publication-1');
		const persisted = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const section = persisted.sections?.[0] as Record<string, unknown>;

		owner.admitCanonicalSource(`external-retarget-${revision}`, {
			sections: [{
				...section,
				database: 'OtherDb',
				resultArtifact: { ...(section.resultArtifact as Record<string, unknown>), revision },
			}],
		});
		const overlaid = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1', database: 'OtherDb' }],
		}).sections?.[0] as Record<string, unknown>;

		expect(overlaid.database).toBe('OtherDb');
		expect(overlaid).not.toHaveProperty('resultJson');
	});

	it('rejects an incoherent initial modern attachment without overwriting its authored target', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const section = persisted.sections?.[0] as Record<string, unknown>;
		const owner = new KustoResultPersistenceOwner('file:///incoherent.kqlx');

		owner.admitCanonicalSource('incoherent-source', {
			sections: [{ ...section, database: 'OtherDb' }],
		});
		const overlaid = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1', database: 'OtherDb' }],
		}).sections?.[0] as Record<string, unknown>;

		expect(overlaid.database).toBe('OtherDb');
		expect(overlaid).not.toHaveProperty('resultJson');
		expect(overlaid).not.toHaveProperty('resultArtifact');
	});

	it('rejects a modern attachment forged with the runtime-only legacy producer', () => {
		const source = createOwner();
		source.session.beginExecution(terminal());
		source.session.stagePublication('publication-1', terminal());
		source.session.commitPublication('publication-1');
		const persisted = source.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		const section = persisted.sections?.[0] as Record<string, unknown>;
		const resultArtifact = section.resultArtifact as Record<string, unknown>;
		const owner = new KustoResultPersistenceOwner('file:///forged-runtime-producer.kqlx');

		owner.admitCanonicalSource('forged-runtime-producer', {
			sections: [{
				...section,
				resultArtifact: {
					...resultArtifact,
					producer: {
						...(resultArtifact.producer as Record<string, unknown>),
						producer: UNVERIFIED_LEGACY_RESULT_PRODUCER,
					},
				},
			}],
		});

		expect(owner.getCommittedSummary('query_1')).toBeUndefined();
		const overlaid = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0] as Record<string, unknown>;
		expect(overlaid).not.toHaveProperty('resultJson');
		expect(overlaid).not.toHaveProperty('resultArtifact');
	});

	it('does not deduplicate an exact-byte external revert after a host commit', () => {
		const owner = new KustoResultPersistenceOwner('file:///exact-revert.kqlx');
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('same-source-bytes', rowFreeState, 'source-revision-1');
		owner.markOwnedSourceFingerprint('same-source-bytes');
		const session = owner.openPanel('panel-1');
		session.openSection('query_1', 'section-instance-1');
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(session.commitPublication('publication-1')).toBe(true);
		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).toHaveProperty('resultJson');

		owner.admitCanonicalSource('same-source-bytes', rowFreeState, 'source-revision-2');

		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('ignores a routine same-authority projection after a host commit', () => {
		const owner = new KustoResultPersistenceOwner('file:///routine-request.kqlx');
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('same-source-bytes', rowFreeState, 'source-authority-1');
		const session = owner.openPanel('panel-1');
		session.openSection('query_1', 'section-instance-1');
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(session.commitPublication('publication-1')).toBe(true);

		owner.admitCanonicalSource('same-source-bytes', rowFreeState, 'source-authority-1');

		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).toHaveProperty('resultJson');
	});

	it('does not restore an exact attachment removed by fresh sanitation from the same source', () => {
		const { owner, session } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('same-source-bytes', rowFreeState, 'source-authority-1');
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(session.commitPublication('publication-1')).toBe(true);
		const beforeSanitation = owner.overlaySnapshot(rowFreeState);

		owner.revokeSanitizedAttachments(beforeSanitation, rowFreeState);
		const admission = owner.prepareCanonicalSource(
			'same-source-bytes', rowFreeState, 'source-authority-1',
		);

		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('does not let an older sanitation callback revoke a newer attachment', () => {
		const { owner, session } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('source-1', rowFreeState);
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(session.commitPublication('publication-1')).toBe(true);
		const olderAttachment = owner.overlaySnapshot(rowFreeState);
		const newerTerminal = terminal('execution-2');
		expect(session.beginExecution(newerTerminal)).toBe(true);
		expect(session.stagePublication('publication-2', newerTerminal)).toBeTruthy();
		expect(session.commitPublication('publication-2')).toBe(true);

		owner.revokeSanitizedAttachments(olderAttachment, rowFreeState);

		expect(owner.getCommittedSummary('query_1')?.executionId).toBe('execution-2');
		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).toHaveProperty('resultJson');
	});

	it('revokes a row-free runtime attachment from an incompatible policy snapshot', () => {
		const { owner, session } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(session.commitPublication('publication-1')).toBe(true);
		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).toHaveProperty('resultJson');

		owner.revokePolicyIncompatibleAttachments({
			clusterKeys: ['https://cluster'], globallyBlocked: false,
			revocationGenerations: { cluster: 3 },
		});

		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('aborts a staged publication when the policy snapshot blocks its cluster', () => {
		const { owner, session } = createOwner();
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();

		owner.revokePolicyIncompatibleAttachments({
			clusterKeys: ['https://cluster'], globallyBlocked: false,
			revocationGenerations: { cluster: 2 },
		});

		expect(session.commitPublication('publication-1')).toBe(false);
	});

	it('revokes an exact inert restored attachment removed by sanitation', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy.kqlx');
		const persisted = {
			sections: [{
				id: 'query_1', type: 'query', query: 'print Value=1',
				resultJson: '{"rows":[[1]]}',
			}],
		};
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Value=1' }],
		};
		owner.admitCanonicalSource('legacy-source', persisted);

		owner.revokeSanitizedAttachments(owner.overlaySnapshot(rowFreeState), rowFreeState);

		expect(owner.overlaySnapshot(rowFreeState).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('admits different compatibility bytes that collide on a panel-local source revision', () => {
		const owner = new KustoResultPersistenceOwner('file:///shared-compat.kql');
		const initialState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('panel-a-bytes', initialState, '1');
		const session = owner.openPanel('panel-a');
		session.openSection('query_1', 'section-instance-1');
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(session.commitPublication('publication-1')).toBe(true);
		expect(owner.overlaySnapshot(initialState).sections?.[0]).toHaveProperty('resultJson');

		const changedState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print Changed=1' }],
		};
		owner.admitCanonicalSource('panel-b-different-bytes', changedState, '1');

		expect(owner.overlaySnapshot(changedState).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('does not commit a staged publication until applied acceptance', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();

		expect(owner.overlaySnapshot({ sections: [{ id: 'query_1', type: 'query' }] }).sections?.[0])
			.not.toHaveProperty('resultJson');
		session.abortPublication('publication-1');
		expect(session.commitPublication('publication-1')).toBe(false);
	});

	it('clears the durable attachment at the accepted rerun boundary', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		session.stagePublication('publication-1', terminal('execution-1'));
		session.commitPublication('publication-1');

		session.beginExecution({ ...terminal('execution-2'), reservationSequence: 2 });

		expect(owner.overlaySnapshot({ sections: [{ id: 'query_1', type: 'query' }] }).sections?.[0])
			.not.toHaveProperty('resultJson');
	});

	it('does not let a stale canonical attachment overwrite a newer host commit', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		session.stagePublication('publication-1', terminal('execution-1'));
		session.commitPublication('publication-1');
		const staleCanonical = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});

		const second = { ...terminal('execution-2'), reservationSequence: 2 };
		session.beginExecution(second);
		session.stagePublication('publication-2', second);
		session.commitPublication('publication-2');
		owner.admitCanonicalSource('late-stale-source', staleCanonical);

		const section = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query' }],
		}).sections?.[0] as Record<string, any>;
		expect(section.resultArtifact.revision).toBe(2);
		expect(section.resultArtifact.producer.executionId).toBe('execution-2');
	});

	it('does not resurrect a committed attachment after external result deletion', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		session.stagePublication('publication-1', terminal('execution-1'));
		session.commitPublication('publication-1');

		owner.admitCanonicalSource('external-row-free-source', {
			sections: [{ id: 'query_1', type: 'query', query: 'print Value=1' }],
		});

		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('treats malformed modern result JSON as absent without throwing', () => {
		const owner = new KustoResultPersistenceOwner('file:///malformed.kqlx');
		expect(() => owner.admitCanonicalSource('malformed-source', {
			sections: [{
				id: 'query_1', type: 'query', resultJson: '{',
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 1,
				resultArtifact: {
					version: 1, artifactId: 'result:query_1:1', sourceBoxId: 'query_1',
					revision: 1, createdAt: 1,
				},
			}],
		})).not.toThrow();
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('rejects stale publications and selection requests after a new execution or target', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		const first = session.stagePublication('publication-1', terminal('execution-1'))!;
		session.beginExecution({ ...terminal('execution-2'), reservationSequence: 2 });

		expect(session.commitPublication('publication-1')).toBe(false);
		expect(session.selectResult({
			requestId: 'select-1', boxId: 'query_1', sectionInstanceId: 'section-instance-1',
			targetGeneration: 1, primaryArtifactId: first.resultArtifactAssignment.artifactId,
			resultIndex: 1,
		})).toEqual({ accepted: false });

		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-1', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Other',
		});
		expect(owner.overlaySnapshot({ sections: [{ id: 'query_1', type: 'query' }] }).sections?.[0])
			.not.toHaveProperty('resultJson');
	});

	it('persists an accepted selected result index without minting a new artifact', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());
		const staged = session.stagePublication('publication-1', terminal())!;
		session.commitPublication('publication-1');

		expect(session.selectResult({
			requestId: 'select-1', boxId: 'query_1', sectionInstanceId: 'section-instance-1',
			targetGeneration: 1, primaryArtifactId: staged.resultArtifactAssignment.artifactId,
			resultIndex: 1,
		})).toEqual({ accepted: true, resultIndex: 1 });
		const section = owner.overlaySnapshot({ sections: [{ id: 'query_1', type: 'query' }] }).sections?.[0] as Record<string, unknown>;
		expect(section.selectedResultIndex).toBe(1);
		expect((section.resultArtifact as Record<string, unknown>).artifactId).toBe('result:query_1:1');
	});

	it('preserves a committed selection when the same panel recreates a section for projection reload', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());
		const staged = session.stagePublication('publication-1', terminal())!;
		session.commitPublication('publication-1');
		expect(session.selectResult({
			requestId: 'select-third', boxId: 'query_1', sectionInstanceId: 'section-instance-1',
			targetGeneration: 1, primaryArtifactId: staged.resultArtifactAssignment.artifactId,
			resultIndex: 1,
		})).toEqual({ accepted: true, resultIndex: 1 });

		expect(session.closeSection('query_1', 'section-instance-1', true)).toBe(true);
		expect(session.openSection('query_1', 'section-instance-2')).toBe(true);
		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		})).toBe(true);
		const summary = owner.getCommittedSummary('query_1');
		expect(summary?.selectedResultIndex).toBe(1);
		expect(session.selectResult({
			requestId: 'select-second-after-reopen', boxId: 'query_1',
			sectionInstanceId: 'section-instance-2', targetGeneration: 1,
			primaryArtifactId: summary!.primaryArtifactId, resultIndex: 0,
		})).toEqual({ accepted: true, resultIndex: 0 });
		const canonical = owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		owner.admitCanonicalSource('same-source-retry', canonical, 'same-source-revision');
		owner.admitCanonicalSource('same-source-retry', canonical, 'same-source-revision');
		expect(owner.getCommittedSummary('query_1')).toBeTruthy();
	});

	it('revokes a closed attachment on explicit section removal', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal());
		session.stagePublication('publication-1', terminal());
		session.commitPublication('publication-1');
		expect(session.closeSection('query_1', 'section-instance-1')).toBe(true);

		expect(owner.getCommittedSummary('query_1')).toBeUndefined();
	});

	it('rejects a reused selection request ID with different fields', () => {
		const { session } = createOwner();
		session.beginExecution(terminal());
		const staged = session.stagePublication('publication-1', terminal())!;
		session.commitPublication('publication-1');
		const request = {
			requestId: 'select-replay', boxId: 'query_1', sectionInstanceId: 'section-instance-1',
			targetGeneration: 1, primaryArtifactId: staged.resultArtifactAssignment.artifactId,
			resultIndex: 1,
		};

		expect(session.selectResult(request)).toEqual({ accepted: true, resultIndex: 1 });
		expect(session.selectResult({ ...request, resultIndex: 0 })).toEqual({ accepted: false });
	});

	it('indexes restored assignments for later comparison lineage', () => {
		const first = createOwner();
		first.session.beginExecution(terminal());
		first.session.stagePublication('publication-1', terminal());
		first.session.commitPublication('publication-1');
		const canonical = first.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});

		const owner = new KustoResultPersistenceOwner('file:///restored.kqlx', { now: () => 456 });
		owner.admitCanonicalSource('restored-source', canonical);
		const session = owner.openPanel('comparison-panel');
		session.openSection('query_cmp', 'comparison-instance');
		session.adoptTarget({
			boxId: 'query_cmp', sectionInstanceId: 'comparison-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		});
		const comparison = {
			...terminal('comparison-execution'), boxId: 'query_cmp', sectionInstanceId: 'comparison-instance',
			producer: 'comparison' as const,
			comparisonRun: {
				sourceBoxId: 'query_1', sourceExecutionId: 'execution-1', comparisonBoxId: 'query_cmp',
			},
		};
		expect(session.beginExecution(comparison)).toBe(true);
		expect(session.stagePublication('comparison-publication', comparison)?.resultArtifactAssignment.lineage)
			.toEqual([{ sourceArtifactId: 'result:query_1:1', role: 'comparison-source' }]);
	});

	it('bounds assignment history and selection response replay state', () => {
		const { owner, session } = createOwner();
		let latestArtifactId = '';
		for (let index = 1; index <= 300; index++) {
			const current = { ...terminal(`execution-${index}`), reservationSequence: index };
			expect(session.beginExecution(current)).toBe(true);
			latestArtifactId = session.stagePublication(`publication-${index}`, current)!
				.resultArtifactAssignment.artifactId;
			expect(session.commitPublication(`publication-${index}`)).toBe(true);
		}
		for (let index = 1; index <= 300; index++) {
			expect(session.selectResult({
				requestId: `selection-${index}`, boxId: 'query_1',
				sectionInstanceId: 'section-instance-1', targetGeneration: 1,
				primaryArtifactId: latestArtifactId, resultIndex: 1,
			})).toEqual({ accepted: true, resultIndex: 1 });
		}

		expect((owner as any).assignmentByExecution.size).toBeLessThanOrEqual(256);
		expect((session as any).selectionResponses.size).toBeLessThanOrEqual(256);
	});

	it('preserves markerless legacy payloads without retaining a privileged descriptor', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy.kqlx');
		owner.openPanel('panel-legacy');
		const legacy = {
			sections: [{
				id: 'query_legacy', type: 'query', query: 'print Value=1',
				resultJson: JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} }),
				resultArtifact: {
					version: 1, artifactId: 'result:query_legacy:7', sourceBoxId: 'query_legacy',
					revision: 7, createdAt: 1,
					policy: { exposeToActiveContent: true, exportToCsv: true },
				},
			}],
		};
		const sanitized = {
			sections: [{
				id: 'query_legacy', type: 'query', query: 'print Value=1',
				resultJson: legacy.sections[0].resultJson,
			}],
		};
		owner.revokeSanitizedAttachments(legacy, sanitized);
		owner.revokePolicyIncompatibleAttachments({
			clusterKeys: [], globallyBlocked: false, version: 1, revocationGenerations: {},
		});
		const admission = owner.prepareCanonicalSource(
			'fingerprint-a', sanitized, 'source-revision-a', 'panel-legacy',
		);
		expect(admission).toBeDefined();

		const overlaid = admission!.projectedState;

		expect((overlaid.sections?.[0] as Record<string, unknown>).resultJson)
			.toBe(legacy.sections[0].resultJson);
		expect(overlaid.sections?.[0]).not.toHaveProperty('resultArtifact');
	});

	it('preserves markerless payloads when an owned row-free write starts before initial admission commits', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-race.kqlx');
		owner.openPanel('panel-legacy-race');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const admission = owner.prepareCanonicalSource(
			'initial-fingerprint',
			{ sections: [{ id: 'query_legacy', type: 'query', resultJson }] },
			'initial-source-revision',
			'panel-legacy-race',
		);
		expect(admission).toBeDefined();
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query' }],
		}, 'panel-legacy-race').sections?.[0]).toHaveProperty('resultJson', resultJson);
		owner.markOwnedSourceFingerprint('owned-row-free-fingerprint');

		expect(admission!.commit()).toBe(true);
		owner.admitCanonicalSource(
			'owned-row-free-fingerprint',
			{ sections: [{ id: 'query_legacy', type: 'query' }] },
		);

		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query' }],
		}).sections?.[0]).toHaveProperty('resultJson', resultJson);
	});

	it('admits an owned markerless source after the initial admission is superseded', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-owned-retry.kqlx');
		owner.openPanel('panel-legacy-owned-retry');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const source = { sections: [{ id: 'query_legacy', type: 'query', resultJson }] };
		const initial = owner.prepareCanonicalSource(
			'initial-markerless-fingerprint', source, 'initial-source-revision',
			'panel-legacy-owned-retry',
		);
		initial?.discard();
		owner.markOwnedSourceFingerprint('owned-markerless-fingerprint');

		const retry = owner.prepareCanonicalSource(
			'owned-markerless-fingerprint', source, 'owned-source-revision',
			'panel-legacy-owned-retry',
		);

		expect(retry?.projectedState.sections?.[0]).toHaveProperty('resultJson', resultJson);
		expect(retry?.commit()).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query' }],
		}).sections?.[0]).toHaveProperty('resultJson', resultJson);
	});

	it('rebases covered queries while admitting uncovered owned markerless state', () => {
		const { owner, session } = createOwner();
		expect(session.beginExecution(terminal())).toBe(true);
		expect(session.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(session.commitPublication('publication-1')).toBe(true);
		const existingResultJson = (owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0] as Record<string, unknown>).resultJson;
		const newResultJson = JSON.stringify({ columns: ['New'], rows: [[2]], metadata: {} });
		const sqlComparisonResultJson = JSON.stringify({ columns: ['Sql'], rows: [[3]], metadata: {} });
		const source = { sections: [
			{ id: 'query_1', type: 'query', query: 'print First=1' },
			{ id: 'query_new', type: 'query', query: 'print New=2', resultJson: newResultJson },
			{ id: 'sql_1', type: 'sql', query: 'select 3' },
			{
				id: 'query_sql_comparison', type: 'query', comparisonSourceBoxId: 'sql_1',
				resultJson: sqlComparisonResultJson,
			},
		] };
		owner.markOwnedSourceFingerprint('owned-expanded-fingerprint');

		const admission = owner.prepareCanonicalSource(
			'owned-expanded-fingerprint', source, 'owned-expanded-source', 'panel-1',
		);

		expect(admission?.projectedState.sections?.[0]).toHaveProperty('resultJson', existingResultJson);
		expect(admission?.projectedState.sections?.[1]).toHaveProperty('resultJson', newResultJson);
		expect(admission?.projectedState.sections?.[3]).toHaveProperty('resultJson', sqlComparisonResultJson);
		expect(admission?.commit()).toBe(true);
		expect(owner.hasMarkerlessInertState('query_sql_comparison')).toBe(false);
		const overlaid = owner.overlaySnapshot({
			sections: [
				{ id: 'query_1', type: 'query' },
				{ id: 'query_new', type: 'query' },
				{ id: 'sql_1', type: 'sql' },
				{
					id: 'query_sql_comparison', type: 'query', comparisonSourceBoxId: 'sql_1',
					resultJson: sqlComparisonResultJson,
				},
			],
		});
		expect(overlaid.sections?.[0]).toHaveProperty('resultJson', existingResultJson);
		expect(overlaid.sections?.[1]).toHaveProperty('resultJson', newResultJson);
		expect(overlaid.sections?.[3]).toHaveProperty('resultJson', sqlComparisonResultJson);
		const rowFreeComparison = owner.overlaySnapshot({
			sections: [
				{ id: 'sql_1', type: 'sql' },
				{ id: 'query_sql_comparison', type: 'query', comparisonSourceBoxId: 'sql_1' },
			],
		});
		expect(rowFreeComparison.sections?.[1]).not.toHaveProperty('resultJson');
	});

	it('retires canonical queries omitted by a fully covered owned source', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-owned-contraction.kqlx');
		const firstResultJson = JSON.stringify({ columns: ['First'], rows: [[1]], metadata: {} });
		const secondResultJson = JSON.stringify({ columns: ['Second'], rows: [[2]], metadata: {} });
		owner.admitCanonicalSource('initial-two-query-source', {
			sections: [
				{ id: 'query_first', type: 'query', resultJson: firstResultJson },
				{ id: 'query_second', type: 'query', resultJson: secondResultJson },
			],
		});
		owner.markOwnedSourceFingerprint('owned-contracted-fingerprint');

		const admission = owner.prepareCanonicalSource(
			'owned-contracted-fingerprint',
			{ sections: [{ id: 'query_first', type: 'query' }] },
			'owned-contracted-source',
		);

		expect(admission?.projectedState.sections?.[0]).toHaveProperty('resultJson', firstResultJson);
		expect(admission?.commit()).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_second', type: 'query' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('retires omitted queries from an exact-pair source', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-exact-contraction.kqlx');
		const firstResultJson = JSON.stringify({ columns: ['First'], rows: [[1]], metadata: {} });
		const secondResultJson = JSON.stringify({ columns: ['Second'], rows: [[2]], metadata: {} });
		owner.admitCanonicalSource('same-fingerprint', {
			sections: [
				{ id: 'query_first', type: 'query', resultJson: firstResultJson },
				{ id: 'query_second', type: 'query', resultJson: secondResultJson },
			],
		}, 'same-source-revision');

		const admission = owner.prepareCanonicalSource(
			'same-fingerprint',
			{ sections: [{ id: 'query_first', type: 'query' }] },
			'same-source-revision',
		);

		expect(admission?.projectedState.sections?.[0]).toHaveProperty('resultJson', firstResultJson);
		expect(admission?.commit()).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_second', type: 'query' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('admits uncovered queries from an exact-pair source', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-exact-expansion.kqlx');
		const firstResultJson = JSON.stringify({ columns: ['First'], rows: [[1]], metadata: {} });
		const secondResultJson = JSON.stringify({ columns: ['Second'], rows: [[2]], metadata: {} });
		owner.admitCanonicalSource('same-fingerprint', {
			sections: [{ id: 'query_first', type: 'query', resultJson: firstResultJson }],
		}, 'same-source-revision');

		const admission = owner.prepareCanonicalSource(
			'same-fingerprint',
			{ sections: [
				{ id: 'query_first', type: 'query' },
				{ id: 'query_second', type: 'query', resultJson: secondResultJson },
			] },
			'same-source-revision',
		);

		expect(admission?.projectedState.sections?.[0]).toHaveProperty('resultJson', firstResultJson);
		expect(admission?.projectedState.sections?.[1]).toHaveProperty('resultJson', secondResultJson);
		expect(admission?.commit()).toBe(true);
		expect(owner.hasMarkerlessInertState('query_second')).toBe(true);
	});

	it('retires canonical queries when an owned source has no Kusto sections', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-owned-empty.kqlx');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('initial-kusto-source', {
			sections: [{ id: 'query_legacy', type: 'query', resultJson }],
		});
		owner.markOwnedSourceFingerprint('owned-sql-only-fingerprint');

		const admission = owner.prepareCanonicalSource(
			'owned-sql-only-fingerprint',
			{ sections: [{ id: 'sql_1', type: 'sql', query: 'select 1' }] },
			'owned-sql-only-source',
		);

		expect(admission?.commit()).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('clears committed selection when an owned source drops its final Kusto query', () => {
		const { owner, session } = createOwner();
		owner.admitCanonicalSource('initial-row-free-source', {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});
		expect(session.beginExecution(terminal())).toBe(true);
		const staged = session.stagePublication('publication-1', terminal())!;
		expect(session.commitPublication('publication-1')).toBe(true);
		expect(session.selectResult({
			requestId: 'select-second', boxId: 'query_1', sectionInstanceId: 'section-instance-1',
			targetGeneration: 1, primaryArtifactId: staged.resultArtifactAssignment.artifactId,
			resultIndex: 1,
		})).toEqual({ accepted: true, resultIndex: 1 });
		owner.markOwnedSourceFingerprint('owned-drop-final-fingerprint');

		const admission = owner.prepareCanonicalSource(
			'owned-drop-final-fingerprint',
			{ sections: [{ id: 'sql_1', type: 'sql', query: 'select 1' }] },
			'owned-drop-final-source',
			'panel-1',
		);

		expect(admission?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')).toBeUndefined();
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
		const rerun = terminal('execution-2');
		expect(session.beginExecution(rerun)).toBe(true);
		expect(session.stagePublication('publication-2', rerun)).toBeTruthy();
		expect(session.commitPublication('publication-2')).toBe(true);
		expect(owner.getCommittedSummary('query_1')?.selectedResultIndex).toBe(0);
	});

	it('hands a fully covered owned source to the admitting panel', () => {
		const { owner, session: firstPanel } = createOwner();
		expect(firstPanel.beginExecution(terminal())).toBe(true);
		expect(firstPanel.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(firstPanel.commitPublication('publication-1')).toBe(true);
		const secondPanel = owner.openPanel('panel-2');
		expect(secondPanel.openSection('query_1', 'section-instance-1')).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-1', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db',
		})).toBe(true);
		owner.markOwnedSourceFingerprint('panel-2-owned-fingerprint');

		const admission = owner.prepareCanonicalSource(
			'panel-2-owned-fingerprint',
			{ sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }] },
			'panel-2-owned-source',
			'panel-2',
		);

		expect(admission?.commit()).toBe(true);
		owner.closePanel('panel-1');
		expect(secondPanel.beginExecution(terminal('execution-2'))).toBe(true);
	});

	it('does not restore an exact-pair attachment rejected by the admitting panel target', () => {
		const { owner, session: firstPanel } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('same-source-fingerprint', rowFreeState, 'same-source-revision');
		expect(firstPanel.beginExecution(terminal())).toBe(true);
		expect(firstPanel.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(firstPanel.commitPublication('publication-1')).toBe(true);
		const secondPanel = owner.openPanel('panel-2');
		expect(secondPanel.openSection('query_1', 'section-instance-2')).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 1,
			connectionId: 'connection-2', database: 'OtherDb',
		})).toBe(true);

		const admission = owner.prepareCanonicalSource(
			'same-source-fingerprint', rowFreeState, 'same-source-revision', 'panel-2',
		);

		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')).toBeUndefined();
		const overlaid = owner.overlaySnapshot({
			sections: [{
				id: 'query_1', type: 'query', connectionIdHint: 'connection-2', database: 'OtherDb',
			}],
		}, 'panel-2').sections?.[0] as Record<string, unknown>;
		expect(overlaid).not.toHaveProperty('resultJson');
		expect(overlaid.connectionIdHint).toBe('connection-2');
		expect(overlaid.database).toBe('OtherDb');
	});

	it('does not restore an owned attachment rejected by the admitting panel target', () => {
		const { owner, session: firstPanel } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('initial-source-fingerprint', rowFreeState, 'initial-source-revision');
		expect(firstPanel.beginExecution(terminal())).toBe(true);
		expect(firstPanel.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(firstPanel.commitPublication('publication-1')).toBe(true);
		const secondPanel = owner.openPanel('panel-2');
		expect(secondPanel.openSection('query_1', 'section-instance-2')).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 1,
			connectionId: 'connection-2', database: 'OtherDb',
		})).toBe(true);
		owner.markOwnedSourceFingerprint('owned-mismatched-fingerprint');

		const admission = owner.prepareCanonicalSource(
			'owned-mismatched-fingerprint', rowFreeState, 'owned-mismatched-source', 'panel-2',
		);

		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')).toBeUndefined();
		const overlaid = owner.overlaySnapshot({
			sections: [{
				id: 'query_1', type: 'query', connectionIdHint: 'connection-2', database: 'OtherDb',
			}],
		}, 'panel-2').sections?.[0] as Record<string, unknown>;
		expect(overlaid).not.toHaveProperty('resultJson');
		expect(overlaid.connectionIdHint).toBe('connection-2');
		expect(overlaid.database).toBe('OtherDb');
	});

	it('retries an exact-pair admission when a rejected target becomes compatible', () => {
		const { owner, session: firstPanel } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('same-source-fingerprint', rowFreeState, 'same-source-revision');
		expect(firstPanel.beginExecution(terminal())).toBe(true);
		expect(firstPanel.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(firstPanel.commitPublication('publication-1')).toBe(true);
		const secondPanel = owner.openPanel('panel-2');
		expect(secondPanel.openSection('query_1', 'section-instance-2')).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 1,
			connectionId: 'connection-2', database: 'OtherDb',
		})).toBe(true);
		const firstAdmission = owner.prepareCanonicalSource(
			'same-source-fingerprint', rowFreeState, 'same-source-revision', 'panel-2',
		);
		expect(firstAdmission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Db',
		})).toBe(true);

		expect(firstAdmission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource(
			'same-source-fingerprint', rowFreeState, 'same-source-revision', 'panel-2',
		);
		expect(retry?.projectedState.sections?.[0]).toHaveProperty('resultJson');
		expect(retry?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')).toBeTruthy();
	});

	it('retries an owned admission when a rejected target becomes compatible', () => {
		const { owner, session: firstPanel } = createOwner();
		const rowFreeState = {
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		};
		owner.admitCanonicalSource('initial-source-fingerprint', rowFreeState, 'initial-source-revision');
		expect(firstPanel.beginExecution(terminal())).toBe(true);
		expect(firstPanel.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(firstPanel.commitPublication('publication-1')).toBe(true);
		const secondPanel = owner.openPanel('panel-2');
		expect(secondPanel.openSection('query_1', 'section-instance-2')).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 1,
			connectionId: 'connection-2', database: 'OtherDb',
		})).toBe(true);
		owner.markOwnedSourceFingerprint('owned-target-reversal-fingerprint');
		const firstAdmission = owner.prepareCanonicalSource(
			'owned-target-reversal-fingerprint', rowFreeState,
			'owned-target-reversal-source', 'panel-2',
		);
		expect(firstAdmission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-instance-2', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Db',
		})).toBe(true);

		expect(firstAdmission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource(
			'owned-target-reversal-fingerprint', rowFreeState,
			'owned-target-reversal-source', 'panel-2',
		);
		expect(retry?.projectedState.sections?.[0]).toHaveProperty('resultJson');
		expect(retry?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')).toBeTruthy();
	});

	it('rejects a descriptorless migrated result after mismatched initial target adoption', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-initial-mismatch.kqlx');
		const panel = owner.openPanel('panel-descriptorless');
		expect(panel.openSection('query_legacy', 'section-descriptorless')).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const source = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		}] };
		const firstAdmission = owner.prepareCanonicalSource(
			'descriptorless-source', source, 'descriptorless-revision', 'panel-descriptorless',
		);
		expect(firstAdmission?.projectedState.sections?.[0]).toHaveProperty('resultJson', resultJson);
		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-descriptorless', targetGeneration: 1,
			connectionId: 'connection-b', database: 'DbB',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);

		expect(firstAdmission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource(
			'descriptorless-source', source, 'descriptorless-revision', 'panel-descriptorless',
		);
		expect(retry?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(retry?.commit()).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{
				id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-b.kusto.windows.net',
				authorityId: 'tenant-b.example.com', connectionIdHint: 'connection-b', database: 'DbB',
			}],
		}, 'panel-descriptorless').sections?.[0]).not.toHaveProperty('resultJson');
	});

	it.each([
		['connection hint', {
			connectionId: 'connection-b',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		}],
		['authority', {
			connectionId: 'connection-a',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-b.example.com',
			),
		}],
	] as const)('rejects a descriptorless migrated result with a mismatched %s', (_label, mismatch) => {
		const owner = new KustoResultPersistenceOwner(`file:///descriptorless-${_label}.kqlx`);
		const panel = owner.openPanel('panel-descriptorless');
		expect(panel.openSection('query_legacy', 'section-descriptorless')).toBe(true);
		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-descriptorless', targetGeneration: 1,
			database: 'DbA', ...mismatch,
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const source = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] };

		const admission = owner.prepareCanonicalSource(
			'descriptorless-source', source, 'descriptorless-revision', 'panel-descriptorless',
		);

		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
	});

	it('retries a descriptorless migrated result when a rejected target becomes compatible', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-rejected-compatible.kqlx');
		const firstPanel = owner.openPanel('panel-a');
		const secondPanel = owner.openPanel('panel-b');
		expect(firstPanel.openSection('query_legacy', 'section-a')).toBe(true);
		expect(secondPanel.openSection('query_legacy', 'section-b')).toBe(true);
		expect(firstPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-a', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 1,
			connectionId: 'connection-b', database: 'DbB',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const source = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		}] };
		owner.admitCanonicalSource('descriptorless-source', source, 'descriptorless-revision');
		const firstAdmission = owner.prepareCanonicalSource(
			'descriptorless-source', source, 'descriptorless-revision', 'panel-b',
		);
		expect(firstAdmission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 2,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);

		expect(firstAdmission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource(
			'descriptorless-source', source, 'descriptorless-revision', 'panel-b',
		);
		expect(retry?.projectedState.sections?.[0]).toHaveProperty('resultJson', resultJson);
		expect(retry?.commit()).toBe(true);
	});

	it('retries a descriptorless migrated result when an allowed target becomes incompatible', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-allowed-rejected.kqlx');
		const firstPanel = owner.openPanel('panel-a');
		const secondPanel = owner.openPanel('panel-b');
		expect(firstPanel.openSection('query_legacy', 'section-a')).toBe(true);
		expect(secondPanel.openSection('query_legacy', 'section-b')).toBe(true);
		expect(firstPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-a', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const source = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		}] };
		owner.admitCanonicalSource('descriptorless-source', source, 'descriptorless-revision');
		const firstAdmission = owner.prepareCanonicalSource(
			'descriptorless-source', source, 'descriptorless-revision', 'panel-b',
		);
		expect(firstAdmission?.projectedState.sections?.[0]).toHaveProperty('resultJson', resultJson);
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 2,
			connectionId: 'connection-b', database: 'DbB',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);

		expect(firstAdmission?.commit()).toBe(false);
		const retry = owner.prepareCanonicalSource(
			'descriptorless-source', source, 'descriptorless-revision', 'panel-b',
		);
		expect(retry?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(retry?.commit()).toBe(true);
	});

	it('keeps descriptorless migrated rows scoped to each panel target after commit', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-multi-panel.kqlx');
		const firstPanel = owner.openPanel('panel-a');
		const secondPanel = owner.openPanel('panel-b');
		expect(firstPanel.openSection('query_legacy', 'section-a')).toBe(true);
		expect(secondPanel.openSection('query_legacy', 'section-b')).toBe(true);
		const targetA = {
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		};
		expect(firstPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-a', targetGeneration: 1, ...targetA,
		})).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 1, ...targetA,
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('descriptorless-source', { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-revision');
		const rowFreeTargetA = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
		}] };
		expect(owner.overlaySnapshot(rowFreeTargetA, 'panel-a').sections?.[0])
			.toHaveProperty('resultJson', resultJson);
		expect(owner.overlaySnapshot(rowFreeTargetA, 'panel-b').sections?.[0])
			.toHaveProperty('resultJson', resultJson);

		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 2,
			connectionId: 'connection-b', database: 'DbB',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);
		const rowFreeTargetB = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-b.kusto.windows.net',
			authorityId: 'tenant-b.example.com', connectionIdHint: 'connection-b', database: 'DbB',
		}] };

		const secondOverlay = owner.overlaySnapshot(rowFreeTargetB, 'panel-b').sections?.[0] as Record<string, unknown>;
		expect(secondOverlay).not.toHaveProperty('resultJson');
		expect(secondOverlay.clusterUrl).toBe('https://cluster-b.kusto.windows.net');
		expect(secondOverlay.connectionIdHint).toBe('connection-b');
		expect(secondOverlay.database).toBe('DbB');
		expect(owner.overlaySnapshot(rowFreeTargetA, 'panel-a').sections?.[0])
			.toHaveProperty('resultJson', resultJson);
	});

	it('keeps an owned row-free candidate hidden from a mismatched panel target', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-owned-row-free.kqlx');
		const firstPanel = owner.openPanel('panel-a');
		const secondPanel = owner.openPanel('panel-b');
		expect(firstPanel.openSection('query_legacy', 'section-a')).toBe(true);
		expect(secondPanel.openSection('query_legacy', 'section-b')).toBe(true);
		expect(firstPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-a', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 1,
			connectionId: 'connection-b', database: 'DbB',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('descriptorless-source', { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-revision');
		owner.markOwnedSourceFingerprint('owned-row-free-fingerprint');
		const rowFreeTargetA = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
		}] };

		const admission = owner.prepareCanonicalSource(
			'owned-row-free-fingerprint', rowFreeTargetA, 'owned-row-free-source', 'panel-b',
		);

		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
		expect(owner.overlaySnapshot(rowFreeTargetA, 'panel-b').sections?.[0])
			.not.toHaveProperty('resultJson');
		expect(owner.overlaySnapshot(rowFreeTargetA, 'panel-a').sections?.[0])
			.toHaveProperty('resultJson', resultJson);
	});

	it.each([
		['policy generation', (owner: KustoResultPersistenceOwner) => owner.revokePolicyIncompatibleAttachments({
			clusterKeys: [], globallyBlocked: false,
			revocationGenerations: { 'cluster-a': 1 },
		})],
		['connection invalidation', (owner: KustoResultPersistenceOwner) => owner.revokeConnections(
			new Set(['connection-a']),
		)],
	] as const)('revokes target-bound descriptorless rows after a row-free panel save on %s', (_label, revoke) => {
		const owner = new KustoResultPersistenceOwner(`file:///descriptorless-${_label}.kqlx`);
		const firstPanel = owner.openPanel('panel-a');
		const secondPanel = owner.openPanel('panel-b');
		for (const [panel, sectionInstanceId] of [
			[firstPanel, 'section-a'], [secondPanel, 'section-b'],
		] as const) {
			expect(panel.openSection('query_legacy', sectionInstanceId)).toBe(true);
			expect(panel.adoptTarget({
				boxId: 'query_legacy', sectionInstanceId, targetGeneration: 1,
				connectionId: 'connection-a', database: 'DbA',
				connectionIdentityKey: getKustoConnectionIdentityKey(
					'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
				),
			})).toBe(true);
		}
		const descriptorlessResultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const markerlessResultJson = JSON.stringify({ columns: ['Local'], rows: [[2]], metadata: {} });
		owner.admitCanonicalSource('descriptorless-source', { sections: [
			{
				id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
				authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
				resultJson: descriptorlessResultJson,
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			},
			{ id: 'query_markerless', type: 'query', resultJson: markerlessResultJson },
		] }, 'descriptorless-revision');
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-b', targetGeneration: 2,
			connectionId: 'connection-b', database: 'DbB',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);
		owner.markOwnedSourceFingerprint('owned-row-free-fingerprint');
		const rowFreeState = { sections: [
			{
				id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
				authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			},
			{ id: 'query_markerless', type: 'query', resultJson: markerlessResultJson },
		] };
		const admission = owner.prepareCanonicalSource(
			'owned-row-free-fingerprint', rowFreeState, 'owned-row-free-source', 'panel-b',
		);
		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
		expect(owner.overlaySnapshot(rowFreeState, 'panel-a').sections?.[0])
			.toHaveProperty('resultJson', descriptorlessResultJson);

		revoke(owner);

		const afterRevocation = owner.overlaySnapshot(rowFreeState, 'panel-a');
		expect(afterRevocation.sections?.[0]).not.toHaveProperty('resultJson');
		expect(afterRevocation.sections?.[1]).toHaveProperty('resultJson', markerlessResultJson);
	});

	it('retains descriptorless comparison rows at generation zero using the Kusto source target', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-comparison-policy.kqlx');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const rowFree = { sections: [
			{
				id: 'query_source', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
				authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			},
			{ id: 'query_comparison', type: 'query', comparisonSourceBoxId: 'query_source' },
		] };
		owner.admitCanonicalSource('descriptorless-comparison', { sections: [
			rowFree.sections[0],
			{
				...rowFree.sections[1], resultJson,
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			},
		] }, 'descriptorless-comparison-revision');
		expect(owner.overlaySnapshot(rowFree).sections?.[1]).toHaveProperty('resultJson', resultJson);

		owner.revokePolicyIncompatibleAttachments({
			clusterKeys: [], globallyBlocked: false,
			revocationGenerations: { 'cluster-a': 0 },
		});

		expect(owner.overlaySnapshot(rowFree).sections?.[1]).toHaveProperty('resultJson', resultJson);
	});

	it('revokes a hintless descriptorless result through its unique runtime connection', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-hintless.kqlx');
		const panel = owner.openPanel('panel-hintless');
		expect(panel.openSection('query_legacy', 'section-hintless')).toBe(true);
		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-hintless', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const rowFree = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', database: 'DbA',
		}] };
		owner.admitCanonicalSource('descriptorless-hintless', { sections: [{
			...rowFree.sections[0], resultJson,
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-hintless-revision');
		expect(owner.overlaySnapshot(rowFree, 'panel-hintless').sections?.[0])
			.toHaveProperty('resultJson', resultJson);

		owner.revokeConnections(new Set(['connection-a']));

		expect(owner.overlaySnapshot(rowFree, 'panel-hintless').sections?.[0])
			.not.toHaveProperty('resultJson');
	});

	it('preserves an authority-less descriptorless result through unique tenant enrichment', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-tenant-unique.kqlx');
		const panel = owner.openPanel('panel-tenant');
		expect(panel.openSection('query_legacy', 'section-tenant')).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const rowFree = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			database: 'DbA',
		}] };
		owner.admitCanonicalSource('descriptorless-tenant-unique', { sections: [{
			...rowFree.sections[0], resultJson,
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-tenant-unique-revision');

		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-tenant', targetGeneration: 1,
			connectionId: 'connection-tenant', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);

		expect(owner.overlaySnapshot(rowFree, 'panel-tenant').sections?.[0])
			.toHaveProperty('resultJson', resultJson);
	});

	it('keeps an authority-less descriptorless result hidden across ambiguous tenant aliases', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-tenant-ambiguous.kqlx');
		const first = owner.openPanel('panel-tenant-a');
		const second = owner.openPanel('panel-tenant-b');
		for (const [panel, sectionInstanceId, connectionId, authorityId] of [
			[first, 'section-tenant-a', 'connection-tenant-a', 'tenant-a.example.com'],
			[second, 'section-tenant-b', 'connection-tenant-b', 'tenant-b.example.com'],
		] as const) {
			expect(panel.openSection('query_legacy', sectionInstanceId)).toBe(true);
			expect(panel.adoptTarget({
				boxId: 'query_legacy', sectionInstanceId, targetGeneration: 1,
				connectionId, database: 'DbA',
				connectionIdentityKey: getKustoConnectionIdentityKey(
					'https://cluster-a.kusto.windows.net', authorityId,
				),
			})).toBe(true);
		}
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const rowFree = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			database: 'DbA',
		}] };
		owner.admitCanonicalSource('descriptorless-tenant-ambiguous', { sections: [{
			...rowFree.sections[0], resultJson,
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-tenant-ambiguous-revision');

		expect(owner.overlaySnapshot(rowFree, 'panel-tenant-a').sections?.[0])
			.not.toHaveProperty('resultJson');
		expect(owner.overlaySnapshot(rowFree, 'panel-tenant-b').sections?.[0])
			.not.toHaveProperty('resultJson');
	});

	it('revokes inert descriptorless state before closing its sole section target', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-close-reopen.kqlx');
		const panel = owner.openPanel('panel-close-reopen');
		expect(panel.openSection('query_legacy', 'section-first')).toBe(true);
		const target = {
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		};
		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-first', targetGeneration: 1, ...target,
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const rowFree = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
		}] };
		owner.admitCanonicalSource('descriptorless-close-source', { sections: [{
			...rowFree.sections[0], resultJson,
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-close-revision');
		expect(owner.overlaySnapshot(rowFree, 'panel-close-reopen').sections?.[0])
			.toHaveProperty('resultJson', resultJson);

		expect(panel.closeSection('query_legacy', 'section-first')).toBe(true);
		expect(panel.openSection('query_legacy', 'section-second')).toBe(true);
		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-second', targetGeneration: 1, ...target,
		})).toBe(true);

		expect(owner.overlaySnapshot(rowFree, 'panel-close-reopen').sections?.[0])
			.not.toHaveProperty('resultJson');
	});

	it('revokes previously enriched hintless state when a second alias arrives later', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-late-alias.kqlx');
		const first = owner.openPanel('panel-late-alias-a');
		expect(first.openSection('query_legacy', 'section-late-alias-a')).toBe(true);
		expect(first.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-late-alias-a', targetGeneration: 1,
			connectionId: 'connection-tenant-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const rowFree = { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net', database: 'DbA',
		}] };
		owner.admitCanonicalSource('descriptorless-late-alias', { sections: [{
			...rowFree.sections[0], resultJson,
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-late-alias-revision');
		expect(owner.overlaySnapshot(rowFree, 'panel-late-alias-a').sections?.[0])
			.toHaveProperty('resultJson', resultJson);

		const second = owner.openPanel('panel-late-alias-b');
		expect(second.openSection('query_legacy', 'section-late-alias-b')).toBe(true);
		expect(second.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-late-alias-b', targetGeneration: 1,
			connectionId: 'connection-tenant-b', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);

		expect(owner.overlaySnapshot(rowFree, 'panel-late-alias-a').sections?.[0])
			.not.toHaveProperty('resultJson');
		expect(owner.overlaySnapshot(rowFree, 'panel-late-alias-b').sections?.[0])
			.not.toHaveProperty('resultJson');
	});

	it('preserves matching descriptorless state while reconciling a rejected committed attachment', () => {
		const { owner, session: firstPanel } = createOwner();
		expect(firstPanel.openSection('query_legacy', 'section-legacy-a')).toBe(true);
		expect(firstPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-legacy-a', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);
		const descriptorlessResultJson = JSON.stringify({
			columns: ['Legacy'], rows: [[2]], metadata: {},
		});
		owner.admitCanonicalSource('mixed-initial-source', { sections: [
			{ id: 'query_1', type: 'query', query: 'print First=1' },
			{
				id: 'query_legacy', type: 'query',
				clusterUrl: 'https://cluster-a.kusto.windows.net',
				authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a',
				database: 'DbA', resultJson: descriptorlessResultJson,
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			},
		] }, 'mixed-initial-revision');
		expect(firstPanel.beginExecution(terminal())).toBe(true);
		expect(firstPanel.stagePublication('publication-1', terminal())).toBeTruthy();
		expect(firstPanel.commitPublication('publication-1')).toBe(true);
		expect(owner.getCommittedSummary('query_1')).toBeTruthy();
		expect(owner.hasMarkerlessInertState('query_legacy')).toBe(false);
		const secondPanel = owner.openPanel('panel-b');
		expect(secondPanel.openSection('query_1', 'section-b')).toBe(true);
		expect(secondPanel.openSection('query_legacy', 'section-legacy-b')).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'section-b', targetGeneration: 1,
			connectionId: 'connection-b', database: 'OtherDb',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);
		expect(secondPanel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-legacy-b', targetGeneration: 1,
			connectionId: 'connection-b', database: 'OtherDb',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);
		owner.markOwnedSourceFingerprint('mixed-owned-row-free');
		const rowFreeState = { sections: [
			{ id: 'query_1', type: 'query', query: 'print First=1' },
			{
				id: 'query_legacy', type: 'query',
				clusterUrl: 'https://cluster-a.kusto.windows.net',
				authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a',
				database: 'DbA',
			},
		] };

		const admission = owner.prepareCanonicalSource(
			'mixed-owned-row-free', rowFreeState, 'mixed-owned-revision', 'panel-b',
		);

		expect(admission?.projectedState.sections?.[0]).not.toHaveProperty('resultJson');
		expect(admission?.projectedState.sections?.[1]).not.toHaveProperty('resultJson');
		expect(admission?.commit()).toBe(true);
		expect(owner.getCommittedSummary('query_1')).toBeUndefined();
		expect(owner.overlaySnapshot(rowFreeState, 'panel-b').sections?.[1])
			.not.toHaveProperty('resultJson');
		expect(owner.overlaySnapshot(rowFreeState, 'panel-1').sections?.[1])
			.toHaveProperty('resultJson', descriptorlessResultJson);
	});

	it('preserves descriptorless migrated rows on matching sole-panel initial adoption', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-initial-adoption.kqlx');
		const panel = owner.openPanel('panel-descriptorless');
		expect(panel.openSection('query_legacy', 'section-descriptorless')).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('descriptorless-source', { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-revision');

		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-descriptorless', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);

		expect(owner.overlaySnapshot({ sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
		}] }, 'panel-descriptorless').sections?.[0]).toHaveProperty('resultJson', resultJson);
	});

	it('preserves descriptorless migrated rows on matching physical enrichment', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-enrichment.kqlx');
		const panel = owner.openPanel('panel-descriptorless');
		expect(panel.openSection('query_legacy', 'section-descriptorless')).toBe(true);
		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-descriptorless', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('descriptorless-source', { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-revision');

		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-descriptorless', targetGeneration: 2,
			connectionId: 'connection-a', database: 'DbA', connectionRevision: 4,
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-a.kusto.windows.net', 'tenant-a.example.com',
			),
		})).toBe(true);

		expect(owner.overlaySnapshot({ sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
		}] }, 'panel-descriptorless').sections?.[0]).toHaveProperty('resultJson', resultJson);
	});

	it('revokes descriptorless migrated rows on mismatching physical enrichment', () => {
		const owner = new KustoResultPersistenceOwner('file:///descriptorless-mismatched-enrichment.kqlx');
		const panel = owner.openPanel('panel-descriptorless');
		expect(panel.openSection('query_legacy', 'section-descriptorless')).toBe(true);
		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-descriptorless', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
		})).toBe(true);
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('descriptorless-source', { sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-a.kusto.windows.net',
			authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			resultJson, kustoAccountPartition: 'partition-a',
			kustoLeaveNoTraceRevision: 0,
		}] }, 'descriptorless-revision');

		expect(panel.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-descriptorless', targetGeneration: 2,
			connectionId: 'connection-a', database: 'DbA', connectionRevision: 4,
			connectionIdentityKey: getKustoConnectionIdentityKey(
				'https://cluster-b.kusto.windows.net', 'tenant-b.example.com',
			),
		})).toBe(true);

		expect(owner.overlaySnapshot({ sections: [{
			id: 'query_legacy', type: 'query', clusterUrl: 'https://cluster-b.kusto.windows.net',
			authorityId: 'tenant-b.example.com', connectionIdHint: 'connection-a', database: 'DbA',
		}] }, 'panel-descriptorless').sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('retains markerless inert payloads across initial and changed section targets', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-targets.kqlx');
		const session = owner.openPanel('panel-legacy-targets');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('markerless-target-source', {
			sections: [{ id: 'query_legacy', type: 'query', resultJson }],
		});
		expect(session.openSection('query_legacy', 'section-legacy')).toBe(true);

		expect(session.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-legacy', targetGeneration: 1,
			connectionId: 'connection-a', database: 'DbA',
		})).toBe(true);
		expect(session.adoptTarget({
			boxId: 'query_legacy', sectionInstanceId: 'section-legacy', targetGeneration: 2,
			connectionId: 'connection-b', database: 'DbB',
		})).toBe(true);

		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query' }],
		}).sections?.[0]).toHaveProperty('resultJson', resultJson);
	});

	it('restores a current markerless source on retry after a row-free admission conflict', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy-retry.kqlx');
		owner.openPanel('panel-legacy-retry');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		const source = { sections: [{ id: 'query_legacy', type: 'query', resultJson }] };
		const first = owner.prepareCanonicalSource(
			'markerless-fingerprint', source, 'markerless-source-revision', 'panel-legacy-retry',
		);
		expect(first).toBeDefined();
		owner.admitCanonicalSource(
			'row-free-fingerprint',
			{ sections: [{ id: 'query_legacy', type: 'query' }] },
			'row-free-source-revision',
		);
		expect(owner.overlaySnapshot(source).sections?.[0]).toHaveProperty('resultJson', resultJson);
		expect(first!.commit()).toBe(false);
		owner.markOwnedSourceFingerprint('markerless-fingerprint');

		const retry = owner.prepareCanonicalSource(
			'markerless-fingerprint', source, 'markerless-source-revision', 'panel-legacy-retry',
		);

		expect(retry?.projectedState.sections?.[0]).toHaveProperty('resultJson', resultJson);
	});

	it('preserves adopted legacy attachments without minting an artifact descriptor', () => {
		const owner = new KustoResultPersistenceOwner('file:///adopted-legacy.kqlx');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('fingerprint-a', {
			sections: [{
				id: 'query_legacy', type: 'query',
				clusterUrl: 'https://cluster-a.kusto.windows.net',
				authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
				resultJson,
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			}],
		});

		const overlaid = owner.overlaySnapshot({
			sections: [{
				id: 'query_legacy', type: 'query', query: 'print Value=2',
				clusterUrl: 'https://cluster-a.kusto.windows.net',
				authorityId: 'tenant-a.example.com', connectionIdHint: 'connection-a', database: 'DbA',
			}],
		});
		const section = overlaid.sections?.[0] as Record<string, unknown>;
		expect(section.resultJson).toBe(resultJson);
		expect(section.kustoAccountPartition).toBe('partition-a');
		expect(section.kustoLeaveNoTraceRevision).toBe(0);
		expect(section.resultArtifact).toBeUndefined();
	});

	it('rejects marker-bearing descriptorless rows without an effective target', () => {
		const owner = new KustoResultPersistenceOwner('file:///targetless-adopted-legacy.kqlx');
		owner.admitCanonicalSource('targetless-adopted-source', { sections: [{
			id: 'query_legacy', type: 'query',
			resultJson: JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} }),
			kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
		}] });

		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
	});

	it('does not retire an attachment for a host-owned row-free source observation', () => {
		const owner = new KustoResultPersistenceOwner('file:///owned-save.kqlx');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('source-with-result', {
			sections: [{ id: 'query_1', type: 'query', resultJson }],
		});
		owner.markOwnedSourceFingerprint('host-row-free');
		owner.admitCanonicalSource('host-row-free', {
			sections: [{ id: 'query_1', type: 'query' }],
		});

		const hostOverlaid = owner.overlaySnapshot({ sections: [{ id: 'query_1', type: 'query' }] });
		expect((hostOverlaid.sections?.[0] as Record<string, unknown>).resultJson).toBe(resultJson);

		owner.admitCanonicalSource('external-row-free', {
			sections: [{ id: 'query_1', type: 'query' }],
		});
		const externalOverlaid = owner.overlaySnapshot({ sections: [{ id: 'query_1', type: 'query' }] });
		expect((externalOverlaid.sections?.[0] as Record<string, unknown>).resultJson).toBeUndefined();
	});

	it('does not claim SQL-derived query comparison attachments', () => {
		const owner = new KustoResultPersistenceOwner('file:///mixed.kqlx');
		const state = {
			sections: [
				{ id: 'sql_1', type: 'sql' },
				{
					id: 'query_sql_comparison', type: 'query', comparisonSourceBoxId: 'sql_1',
					resultJson: 'sql-owned', resultArtifact: { version: 1 },
				},
			],
		};
		owner.admitCanonicalSource('fingerprint-a', state);

		const overlaid = owner.overlaySnapshot(state);

		expect(overlaid.sections?.[1]).toEqual(state.sections[1]);
	});

	it('revokes committed and staged attachments for connection invalidation', () => {
		const { owner, session } = createOwner();
		session.beginExecution(terminal('execution-1'));
		session.stagePublication('publication-1', terminal('execution-1'));
		session.commitPublication('publication-1');
		session.beginExecution({ ...terminal('execution-2'), reservationSequence: 2 });
		session.stagePublication('publication-2', { ...terminal('execution-2'), reservationSequence: 2 });

		session.revokeConnections(['connection-1']);

		expect(session.commitPublication('publication-2')).toBe(false);
		expect(owner.overlaySnapshot({ sections: [{ id: 'query_1', type: 'query' }] }).sections?.[0])
			.not.toHaveProperty('resultJson');
	});
});