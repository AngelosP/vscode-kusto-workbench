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

	it('preserves a restored attachment through partial startup target adoption', () => {
		const first = createOwner();
		first.session.beginExecution(terminal());
		first.session.stagePublication('publication-1', terminal());
		first.session.commitPublication('publication-1');
		const persisted = first.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});

		const owner = new KustoResultPersistenceOwner('file:///reopened-partial-target.kqlx');
		owner.admitCanonicalSource('reopened-source', persisted);
		const session = owner.openPanel('reopened-panel');
		session.openSection('query_1', 'reopened-instance');

		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 1,
			connectionId: 'connection-1', database: '',
		})).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).toHaveProperty('resultJson');

		expect(session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 2,
			connectionId: 'connection-1', database: 'Db', connectionRevision: 4,
			connectionIdentityKey: 'https://cluster|',
		})).toBe(true);
		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).toHaveProperty('resultJson');
	});

	it('revokes a restored attachment when a partial startup target already conflicts', () => {
		const first = createOwner();
		first.session.beginExecution(terminal());
		first.session.stagePublication('publication-1', terminal());
		first.session.commitPublication('publication-1');
		const persisted = first.owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		});

		const owner = new KustoResultPersistenceOwner('file:///reopened-partial-mismatch.kqlx');
		owner.admitCanonicalSource('reopened-source', persisted);
		const session = owner.openPanel('reopened-panel');
		session.openSection('query_1', 'reopened-instance');
		session.adoptTarget({
			boxId: 'query_1', sectionInstanceId: 'reopened-instance', targetGeneration: 1,
			connectionId: 'other-connection', database: '',
		});

		expect(owner.overlaySnapshot({
			sections: [{ id: 'query_1', type: 'query', query: 'print First=1' }],
		}).sections?.[0]).not.toHaveProperty('resultJson');
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