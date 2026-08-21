import { describe, expect, it } from 'vitest';

import { KustoResultPersistenceOwner } from '../../../src/host/kustoResultPersistenceOwner.js';
import { createKustoResultBatch } from '../../../src/shared/kustoResultBatch.js';

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
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 5,
			connectionIdentityKey: 'https://cluster|other-authority',
		});

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

	it('preserves markerless legacy attachments as inert canonical source data', () => {
		const owner = new KustoResultPersistenceOwner('file:///legacy.kqlx');
		const legacy = {
			sections: [{
				id: 'query_legacy', type: 'query', query: 'print Value=1',
				resultJson: JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} }),
			}],
		};
		owner.admitCanonicalSource('fingerprint-a', legacy);

		const overlaid = owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query', query: 'print Value=2' }],
		});

		expect((overlaid.sections?.[0] as Record<string, unknown>).resultJson)
			.toBe(legacy.sections[0].resultJson);
	});

	it('preserves adopted legacy attachments without minting an artifact descriptor', () => {
		const owner = new KustoResultPersistenceOwner('file:///adopted-legacy.kqlx');
		const resultJson = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		owner.admitCanonicalSource('fingerprint-a', {
			sections: [{
				id: 'query_legacy', type: 'query', resultJson,
				kustoAccountPartition: 'partition-a', kustoLeaveNoTraceRevision: 0,
			}],
		});

		const overlaid = owner.overlaySnapshot({
			sections: [{ id: 'query_legacy', type: 'query', query: 'print Value=2' }],
		});
		const section = overlaid.sections?.[0] as Record<string, unknown>;
		expect(section.resultJson).toBe(resultJson);
		expect(section.kustoAccountPartition).toBe('partition-a');
		expect(section.kustoLeaveNoTraceRevision).toBe(0);
		expect(section.resultArtifact).toBeUndefined();
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