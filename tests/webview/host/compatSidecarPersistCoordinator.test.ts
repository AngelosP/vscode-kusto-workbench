import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
	CompatSidecarPersistCoordinator,
	type CompatSidecarPersistMessage,
} from '../../../src/host/compatSidecarPersistCoordinator';
import type { CompatSidecarProjectionCoordinatorContract } from '../../../src/host/compatSidecarProjectionCoordinator';
import { CompatSidecarSession } from '../../../src/host/compatSidecarSession';
import type { KqlxFileV1, KqlxStateV1 } from '../../../src/host/kqlxFormat';
import type {
	CompatibilityPersistencePersistSnapshot,
	CompatibilityPersistenceState,
	CompatibilityPersistenceUnavailableFinalPersist,
} from '../../../src/shared/compatibilityPersistenceProtocol';

type AckMode = 'resolve' | 'false' | 'reject' | 'pending' | 'throw';

type HarnessBehavior = {
	loadError?: string;
	admitPersist: boolean;
	validationFailureAt?: number;
	sanitizeError?: Error;
	materializeError?: Error;
	draftAvailable: boolean;
	materializedAvailable: boolean;
	applyResult: boolean;
	applyMutatesSource: boolean;
	retireDuringApply: boolean;
	rollbackResult: boolean;
	rollbackRestoresSource: boolean;
	live: boolean;
	ackMode: AckMode;
};

type Harness = ReturnType<typeof createHarness>;

const envelope = {
	protocolVersion: 1 as const,
	channel: 'compatibility-persistence' as const,
	viewSessionId: 'persist-coordinator-test',
};

function persistenceState(text = 'NEXT'): CompatibilityPersistenceState {
	return {
		sections: [{ id: 'compat_primary_query', type: 'query', query: text }],
	};
}

function snapshot(
	text = 'NEXT',
	overrides: Partial<CompatibilityPersistencePersistSnapshot> = {},
): CompatibilityPersistencePersistSnapshot {
	return {
		...envelope,
		type: 'persistDocument',
		state: persistenceState(text),
		sourceGeneration: 1,
		editRevision: 1,
		snapshotId: 'snapshot-1',
		...overrides,
	};
}

function unavailableFinal(
	flushRequestId: string,
): CompatibilityPersistenceUnavailableFinalPersist {
	return {
		...envelope,
		type: 'persistDocument',
		state: { sections: [] },
		sourceGeneration: 1,
		flushRequestId,
		flushUnavailableReason: 'restore-in-progress',
	};
}

function fileFor(state: KqlxStateV1): KqlxFileV1 {
	return { kind: 'kqlx', version: 1, state };
}

function createHarness(options: Partial<HarnessBehavior & { sourceText: string }> = {}) {
	const calls: string[] = [];
	const acknowledgements: Array<Readonly<{ snapshotId: string; editRevision: number }>> = [];
	const behavior: HarnessBehavior = {
		admitPersist: true,
		draftAvailable: true,
		materializedAvailable: true,
		applyResult: true,
		applyMutatesSource: true,
		retireDuringApply: false,
		rollbackResult: true,
		rollbackRestoresSource: true,
		live: true,
		ackMode: 'resolve',
		...options,
	};
	let sourceText = options.sourceText ?? 'CURRENT';
	let validationCalls = 0;
	let knownState: KqlxStateV1 | undefined;
	let materializedSidecar: KqlxFileV1 | undefined;
	const session = new CompatSidecarSession(true, 'KQL');
	const adoptRevision = session.adoptRevision.bind(session);
	const setStateRevision = session.setStateRevision.bind(session);
	const setMaterializedDirty = session.setMaterializedDirty.bind(session);
	const adoptRevisionSpy = vi.spyOn(session, 'adoptRevision').mockImplementation((revision, mode) => {
		calls.push(`adopt:${revision}:${mode ?? 'max'}`);
		return adoptRevision(revision, mode);
	});
	const setStateRevisionSpy = vi.spyOn(session, 'setStateRevision').mockImplementation(revision => {
		calls.push(`state-revision:${revision}`);
		setStateRevision(revision);
	});
	const setMaterializedDirtySpy = vi.spyOn(session, 'setMaterializedDirty').mockImplementation((dirty, base) => {
		calls.push(`materialized-dirty:${dirty}:${base ?? ''}`);
		setMaterializedDirty(dirty, base);
	});
	const completeFinalPersistSpy = vi.spyOn(session, 'completeFinalPersist');
	const markBeforeUnloadSpy = vi.spyOn(session, 'markBeforeUnload');

	const projection: CompatSidecarProjectionCoordinatorContract = {
		get isInitialized() { return true; },
		get activeSourceGeneration() { return 1; },
		get sourceRollbackFailed() { return false; },
		project: async () => true,
		requestDocument: async () => true,
		requestSourceReload: async () => true,
		ensureInitialProjection: async () => true,
		completeReload: () => true,
		admitPersist: admission => {
			calls.push(`admit:${String(admission.sourceGeneration)}:${String(admission.editRevision)}`);
			return behavior.admitPersist;
		},
		captureSourceReloadEpoch: () => {
			calls.push('capture-reload-epoch');
			return 7;
		},
		rollbackSupersededSourceEdit: async (epoch, candidate, restore) => {
			calls.push(`rollback:${epoch}:${candidate}`);
			if (behavior.rollbackRestoresSource) await restore('AUTHORITATIVE');
			return behavior.rollbackResult;
		},
	};

	const coordinator = new CompatSidecarPersistCoordinator({
		session,
		projection,
		languageLabel: 'KQL',
		getLoadError: () => behavior.loadError,
		allowMissingSourceGeneration: false,
		allowTestOnlyNoop: true,
		isLive: () => behavior.live,
		postMessage: message => {
			calls.push(`ack:${message.snapshotId}:${message.editRevision}`);
			acknowledgements.push(message);
			switch (behavior.ackMode) {
				case 'false': return false;
				case 'reject': return Promise.reject(new Error('ack rejected'));
				case 'pending': return new Promise<boolean>(() => undefined);
				case 'throw': throw new Error('ack threw');
				default: return Promise.resolve(true);
			}
		},
		warnUnavailable: () => { calls.push('warn-unavailable'); },
		adapter: {
			captureState: state => {
				calls.push('capture-state');
				return state as unknown as KqlxStateV1;
			},
			validateState: (_state, allowPendingUpgrade) => {
				validationCalls++;
				calls.push(`validate:${allowPendingUpgrade}`);
				if (behavior.validationFailureAt === validationCalls) {
					throw new Error(`validation ${validationCalls} failed`);
				}
			},
			sanitizeState: async state => {
				calls.push('sanitize');
				if (behavior.sanitizeError) throw behavior.sanitizeError;
				return state;
			},
			prepareMaterializedDraft: state => {
				calls.push('prepare-materialized-draft');
				return behavior.draftAvailable ? fileFor(state) : undefined;
			},
			materializeState: async state => {
				calls.push('materialize');
				if (behavior.materializeError) throw behavior.materializeError;
				return behavior.materializedAvailable ? fileFor(state) : undefined;
			},
			serializeMaterialized: file => JSON.stringify(file),
			getLastWrittenMaterializedText: () => 'BASELINE',
			getPrimaryText: state => String((state.sections[0] as { query?: unknown } | undefined)?.query ?? ''),
			readSourceText: () => sourceText,
			applySourceText: async text => {
				calls.push(`apply-source:${text}`);
				if (behavior.applyResult && behavior.applyMutatesSource) sourceText = text;
				if (behavior.retireDuringApply) session.retirePersists();
				return behavior.applyResult;
			},
			requestSourceReload: () => { calls.push('request-source-reload'); },
			setKnownState: state => {
				calls.push('set-known-state');
				knownState = state;
			},
			setMaterializedSidecar: file => {
				calls.push('set-materialized-sidecar');
				materializedSidecar = file;
			},
			publishChanges: () => { calls.push('publish-changes'); },
			notifyPreparationFailure: error => {
				calls.push(`notify:${error instanceof Error ? error.message : String(error)}`);
			},
		},
	});

	return {
		coordinator,
		session,
		projection,
		behavior,
		calls,
		acknowledgements,
		adoptRevisionSpy,
		setStateRevisionSpy,
		setMaterializedDirtySpy,
		completeFinalPersistSpy,
		markBeforeUnloadSpy,
		getSourceText: () => sourceText,
		getKnownState: () => knownState,
		getMaterializedSidecar: () => materializedSidecar,
		getValidationCalls: () => validationCalls,
	};
}

async function createPendingFinal(harness: Harness) {
	let requestId = '';
	const result = harness.session.requestFinalPersist(message => {
		requestId = String((message as { requestId?: unknown }).requestId ?? '');
		return true;
	}, 'save', 10_000);
	for (let index = 0; index < 5 && !requestId; index++) await Promise.resolve();
	expect(requestId).not.toBe('');
	return { requestId, result };
}

async function observeRejection(result: Promise<void>): Promise<Error> {
	return result.then(
		() => new Error('Expected the final persist request to reject.'),
		error => error instanceof Error ? error : new Error(String(error)),
	);
}

describe('CompatSidecarPersistCoordinator', () => {
	it('ignores unknown and already-settled final requests before every application effect', async () => {
		const harness = createHarness();
		const unknown = await harness.coordinator.persist(snapshot('NEXT', { flushRequestId: 'unknown-final' }));
		expect(unknown.terminal).toBe('ignored-final');
		expect(harness.calls).toEqual([]);

		const pending = await createPendingFinal(harness);
		expect(harness.session.completeFinalPersist(pending.requestId)).toBe(true);
		await pending.result;
		harness.calls.length = 0;
		harness.completeFinalPersistSpy.mockClear();
		const expired = await harness.coordinator.persist(snapshot('NEXT', { flushRequestId: pending.requestId }));
		expect(expired.terminal).toBe('ignored-final');
		expect(harness.calls).toEqual([]);
		expect(harness.completeFinalPersistSpy).not.toHaveBeenCalled();
	});

	it('settles load failure and unavailable finals without validation or application', async () => {
		const failed = createHarness({ loadError: 'sidecar load failed' });
		const failedFinal = await createPendingFinal(failed);
		const failedObserved = observeRejection(failedFinal.result);
		const loadResult = await failed.coordinator.persist(snapshot('NEXT', {
			flushRequestId: failedFinal.requestId,
		}));
		expect(loadResult.terminal).toBe('load-error');
		expect((await failedObserved).message).toBe('sidecar load failed');
		expect(failed.calls).toEqual([]);
		expect(failed.completeFinalPersistSpy).toHaveBeenCalledTimes(1);

		const unavailable = createHarness();
		const unavailableRequest = await createPendingFinal(unavailable);
		const unavailableResult = await unavailable.coordinator.persist(unavailableFinal(unavailableRequest.requestId));
		expect(unavailableResult.terminal).toBe('unavailable');
		await expect(unavailableRequest.result).resolves.toBeUndefined();
		expect(unavailable.calls).toEqual(['warn-unavailable']);
		expect(unavailable.completeFinalPersistSpy).toHaveBeenCalledTimes(1);
	});

	it('rejects initial validation and stale generation before queue admission', async () => {
		const invalid = createHarness({ validationFailureAt: 1 });
		const invalidFinal = await createPendingFinal(invalid);
		const invalidObserved = observeRejection(invalidFinal.result);
		const invalidResult = await invalid.coordinator.persist(snapshot('NEXT', {
			flushRequestId: invalidFinal.requestId,
		}));
		expect(invalidResult.terminal).toBe('invalid');
		expect((await invalidObserved).message).toBe('validation 1 failed');
		expect(invalid.calls).toEqual(['capture-state', 'validate:false']);

		const oldGeneration = createHarness({ admitPersist: false });
		const generationFinal = await createPendingFinal(oldGeneration);
		const generationObserved = observeRejection(generationFinal.result);
		const generationResult = await oldGeneration.coordinator.persist(snapshot('NEXT', {
			flushRequestId: generationFinal.requestId,
		}));
		expect(generationResult.terminal).toBe('generation-rejected');
		expect((await generationObserved).message).toContain('older source projection');
		expect(oldGeneration.calls).toEqual([
			'capture-state',
			'validate:false',
			'admit:1:1',
		]);
	});

	it('owns test-only noop, closing, and stale terminal decisions', async () => {
		const noop = createHarness();
		const noopFinal = await createPendingFinal(noop);
		const noopResult = await noop.coordinator.persist(snapshot('UNCHANGED', {
			editRevision: 4,
			testOnlyNoop: true,
			reason: 'beforeunload',
			flushRequestId: noopFinal.requestId,
		}));
		expect(noopResult.terminal).toBe('noop');
		await expect(noopFinal.result).resolves.toBeUndefined();
		expect(noop.session.currentEditRevision).toBe(4);
		expect(noop.acknowledgements).toEqual([{
			type: 'persistDocumentAck', snapshotId: 'snapshot-1', editRevision: 4,
		}]);
		expect(noop.markBeforeUnloadSpy).toHaveBeenCalledWith('beforeunload');

		const closing = createHarness();
		const closingFinal = await createPendingFinal(closing);
		const closingObserved = observeRejection(closingFinal.result);
		closing.session.beginClose();
		const closingResult = await closing.coordinator.persist(snapshot('NEXT', {
			flushRequestId: closingFinal.requestId,
		}));
		expect(closingResult.terminal).toBe('closing');
		expect((await closingObserved).message).toContain('closed before its final snapshot');
		expect(closing.acknowledgements).toEqual([]);

		const stale = createHarness();
		stale.session.adoptRevision(5);
		stale.adoptRevisionSpy.mockClear();
		const staleFinal = await createPendingFinal(stale);
		const staleObserved = observeRejection(staleFinal.result);
		const staleResult = await stale.coordinator.persist(snapshot('NEXT', {
			editRevision: 4,
			reason: 'beforeunload',
			flushRequestId: staleFinal.requestId,
		}));
		expect(staleResult.terminal).toBe('stale');
		expect((await staleObserved).message).toContain('snapshot was stale');
		expect(stale.markBeforeUnloadSpy).toHaveBeenCalledWith('beforeunload');
		expect(stale.adoptRevisionSpy).not.toHaveBeenCalled();
	});

	it('revalidates after an upgrade barrier and rejects a failed upgrade snapshot', async () => {
		const harness = createHarness({ validationFailureAt: 2 });
		const upgrade = await harness.session.beginUpgrade(1);
		expect(upgrade).toBeDefined();
		const persist = harness.coordinator.persist(snapshot('NEXT', { editRevision: 2 }));
		for (let index = 0; index < 5 && harness.getValidationCalls() < 1; index++) await Promise.resolve();
		expect(harness.calls).toContain('validate:true');
		expect(harness.calls).not.toContain('sanitize');
		upgrade!.finish();
		const result = await persist;
		expect(result.terminal).toBe('invalid');
		expect(result.error?.message).toBe('validation 2 failed');
		expect(harness.calls).toContain('validate:false');
		expect(harness.calls).not.toContain('sanitize');
		expect(harness.acknowledgements).toEqual([]);
	});

	it('separates sanitation failure from materialization failure and retains only a source-matching draft', async () => {
		const sanitation = createHarness({ sanitizeError: new Error('sanitize failed') });
		const sanitationResult = await sanitation.coordinator.persist(snapshot('CURRENT'));
		expect(sanitationResult.terminal).toBe('prepare-failed');
		expect(sanitationResult.error?.message).toContain('Failed to prepare KQL companion metadata');
		expect(sanitation.calls).toContain('notify:sanitize failed');
		expect(sanitation.calls).not.toContain('materialize');

		const retained = createHarness({
			sourceText: 'CURRENT',
			materializeError: new Error('materialize failed'),
		});
		const retainedResult = await retained.coordinator.persist(snapshot('CURRENT'));
		expect(retainedResult.terminal).toBe('materialize-failed');
		expect(retained.session.isDirty).toBe(true);
		expect(retained.session.currentStateEditRevision).toBe(1);
		expect(retained.getKnownState()).toBeDefined();
		expect(retained.calls).toContain('publish-changes');

		const rejected = createHarness({
			sourceText: 'OTHER',
			materializeError: new Error('materialize failed'),
		});
		const rejectedResult = await rejected.coordinator.persist(snapshot('CURRENT'));
		expect(rejectedResult.terminal).toBe('materialize-failed');
		expect(rejected.session.isDirty).toBe(false);
		expect(rejected.getKnownState()).toBeUndefined();
		expect(rejected.calls).not.toContain('publish-changes');
	});

	it('rejects source edits and detects source drift before state commit', async () => {
		const rejected = createHarness({ sourceText: 'OLD', applyResult: false });
		const rejectedResult = await rejected.coordinator.persist(snapshot('NEW'));
		expect(rejectedResult.terminal).toBe('source-rejected');
		expect(rejected.getKnownState()).toBeUndefined();
		expect(rejected.acknowledgements).toEqual([]);

		const drifted = createHarness({
			sourceText: 'OLD',
			applyMutatesSource: false,
		});
		const driftedResult = await drifted.coordinator.persist(snapshot('NEW'));
		expect(driftedResult.terminal).toBe('source-drift');
		expect(drifted.calls).toContain('request-source-reload');
		expect(drifted.getKnownState()).toBeUndefined();
		expect(drifted.acknowledgements).toEqual([]);
	});

	it.each([
		{ rollbackResult: true, rollbackRestoresSource: true, terminal: 'superseded', expectedSource: 'AUTHORITATIVE' },
		{ rollbackResult: false, rollbackRestoresSource: false, terminal: 'rollback-failed', expectedSource: 'NEW' },
	] as const)('routes source supersession through projection rollback: $terminal', async testCase => {
		const harness = createHarness({
			sourceText: 'OLD',
			retireDuringApply: true,
			rollbackResult: testCase.rollbackResult,
			rollbackRestoresSource: testCase.rollbackRestoresSource,
		});
		const result = await harness.coordinator.persist(snapshot('NEW'));
		expect(result.terminal).toBe(testCase.terminal);
		expect(harness.calls).toContain('rollback:7:NEW');
		expect(harness.getSourceText()).toBe(testCase.expectedSource);
		expect(harness.getKnownState()).toBeUndefined();
		expect(harness.acknowledgements).toEqual([]);
	});

	it('preserves shared CRLF equality and non-empty blank-file protection', async () => {
		const eol = createHarness({ sourceText: 'line 1\r\nline 2' });
		const eolResult = await eol.coordinator.persist(snapshot('line 1\nline 2'));
		expect(eolResult.terminal).toBe('applied');
		expect(eol.calls.some(call => call.startsWith('apply-source:'))).toBe(false);

		const blank = createHarness({ sourceText: 'KEEP ME' });
		const blankResult = await blank.coordinator.persist(snapshot('   '));
		expect(blankResult.terminal).toBe('applied');
		expect(blank.getSourceText()).toBe('KEEP ME');
		expect(blank.calls.some(call => call.startsWith('apply-source:'))).toBe(false);
		expect(blank.getKnownState()).toBeDefined();
	});

	it.each(['false', 'reject', 'pending', 'throw'] as const)(
		'settles an admitted final without waiting for an acknowledgement that is %s',
		async ackMode => {
			const harness = createHarness({ sourceText: 'UNCHANGED', ackMode });
			const pending = await createPendingFinal(harness);
			let finalSettlements = 0;
			void pending.result.then(
				() => { finalSettlements++; },
				() => { finalSettlements++; },
			);
			const result = await harness.coordinator.persist(snapshot('UNCHANGED', {
				flushRequestId: pending.requestId,
			}));
			expect(result.terminal).toBe('applied');
			await expect(pending.result).resolves.toBeUndefined();
			await Promise.resolve();
			expect(harness.acknowledgements).toHaveLength(1);
			expect(finalSettlements).toBe(1);
			expect(harness.completeFinalPersistSpy).toHaveBeenCalledTimes(1);
		},
	);

	it('settles a retained post-disposal final without attempting a dead-panel acknowledgement', async () => {
		const harness = createHarness({ sourceText: 'UNCHANGED', live: false });
		const pending = await createPendingFinal(harness);
		const result = await harness.coordinator.persist(snapshot('UNCHANGED', {
			flushRequestId: pending.requestId,
		}));
		expect(result.terminal).toBe('applied');
		await expect(pending.result).resolves.toBeUndefined();
		expect(harness.acknowledgements).toEqual([]);
		expect(harness.completeFinalPersistSpy).toHaveBeenCalledTimes(1);
	});

	it('commits source, state, materialization, diff, acknowledgement, and final settlement in order', async () => {
		const harness = createHarness({ sourceText: 'OLD' });
		const pending = await createPendingFinal(harness);
		const result = await harness.coordinator.persist(snapshot('NEW', {
			flushRequestId: pending.requestId,
			reason: 'save',
		}));
		expect(result.terminal).toBe('applied');
		await expect(pending.result).resolves.toBeUndefined();
		expect(harness.getSourceText()).toBe('NEW');
		expect(harness.getKnownState()).toBeDefined();
		expect(harness.getMaterializedSidecar()).toBeDefined();
		expect(harness.session.currentEditRevision).toBe(1);
		expect(harness.session.currentStateEditRevision).toBe(1);
		expect(harness.session.isDirty).toBe(true);
		expect(harness.acknowledgements).toEqual([{
			type: 'persistDocumentAck', snapshotId: 'snapshot-1', editRevision: 1,
		}]);
		expect(harness.completeFinalPersistSpy).toHaveBeenCalledTimes(1);
		expect(harness.calls.indexOf('apply-source:NEW')).toBeLessThan(harness.calls.indexOf('set-known-state'));
		expect(harness.calls.indexOf('set-known-state')).toBeLessThan(harness.calls.indexOf('state-revision:1'));
		expect(harness.calls.indexOf('state-revision:1')).toBeLessThan(harness.calls.indexOf('set-materialized-sidecar'));
		expect(harness.calls.indexOf('set-materialized-sidecar')).toBeLessThan(
			harness.calls.findIndex(call => call.startsWith('materialized-dirty:')),
		);
		expect(harness.calls.findIndex(call => call.startsWith('materialized-dirty:'))).toBeLessThan(
			harness.calls.indexOf('publish-changes'),
		);
		expect(harness.calls.indexOf('publish-changes')).toBeLessThan(
			harness.calls.findIndex(call => call.startsWith('ack:')),
		);
	});

	it('keeps providers physical and leaves queue, acknowledgement, and final authority only in the coordinator', () => {
		const coordinatorSource = fs.readFileSync(path.join(
			process.cwd(), 'src', 'host', 'compatSidecarPersistCoordinator.ts',
		), 'utf8');
		expect(coordinatorSource).toContain('session.queuePersist');
		expect(coordinatorSource).toContain('projection.admitPersist');
		expect(coordinatorSource).toContain('projection.rollbackSupersededSourceEdit');
		expect(coordinatorSource).toContain("type: 'persistDocumentAck'");
		expect(coordinatorSource).toContain('session.completeFinalPersist');
		expect(coordinatorSource).not.toContain("from 'vscode'");
		expect(coordinatorSource).not.toContain('CompatSidecarStore');
		expect(coordinatorSource).not.toContain('setTimeout');
		expect(coordinatorSource).not.toContain('new Map');

		for (const fileName of ['kqlCompatEditorProvider.ts', 'sqlCompatEditorProvider.ts']) {
			const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'host', fileName), 'utf8');
			expect(provider).toContain('CompatSidecarPersistCoordinator');
			expect(provider).toContain('await persistCoordinator.persist(message as CompatSidecarPersistMessage);');
			expect(provider).not.toContain('sidecarSession.queuePersist(');
			expect(provider).not.toContain('sidecarSession.completeFinalPersist(');
			expect(provider).not.toContain('projectionCoordinator.admitPersist(');
			expect(provider).not.toContain('projectionCoordinator.rollbackSupersededSourceEdit(');
			expect(provider).not.toContain("type: 'persistDocumentAck'");
			expect(provider).not.toContain('sidecarSession.markBeforeUnload(');
		}
	});
});