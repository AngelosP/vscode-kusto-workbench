import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
	CompatSidecarCloseCoordinator,
	type CompatSidecarCloseDraft,
	type CompatSidecarCloseFinalization,
} from '../../../src/host/compatSidecarCloseCoordinator';
import { CompatSidecarSession } from '../../../src/host/compatSidecarSession';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(settle => { resolve = settle; });
	return { promise, resolve };
}

function draft(marker: string): CompatSidecarCloseDraft {
	return {
		uri: { fsPath: `C:\\tmp\\${marker}.json` } as any,
		state: { sections: [{ id: 'markdown_1', type: 'markdown', text: marker }] },
		displayName: `${marker}.json`,
	};
}

function finalization(
	closeDraft: CompatSidecarCloseDraft | undefined,
	overrides: Partial<CompatSidecarCloseFinalization> = {},
): CompatSidecarCloseFinalization {
	return {
		gateway: { closeRetiredInboundAdmission: vi.fn(async () => undefined) },
		subscriptions: [],
		captureDraft: vi.fn(() => closeDraft),
		promptSave: vi.fn(async () => 'Save'),
		saveDraft: vi.fn(async () => undefined),
		recoverDraft: vi.fn(async value => value.uri),
		notifyRecovered: vi.fn(),
		notifySaveFailed: vi.fn(),
		repair: vi.fn(async () => undefined),
		drainStore: vi.fn(async () => undefined),
		...overrides,
	};
}

describe('CompatSidecarCloseCoordinator', () => {
	it('defers early disposal until configured and starts exactly once', async () => {
		const session = new CompatSidecarSession(false, 'KQL');
		const closeDraft = draft('latest');
		const dispose = vi.fn();
		const yieldTurn = vi.fn(async () => undefined);
		const persistGate = deferred<void>();
		const coordinator = new CompatSidecarCloseCoordinator({ session, yieldTurn });
		session.markDirty('baseline');
		const admittedPersist = session.enqueueAfterPersists(async () => { await persistGate.promise; });
		const options = finalization(closeDraft, { subscriptions: [{ dispose }] });

		const first = coordinator.disposePanel();
		const second = coordinator.disposePanel();
		expect(options.captureDraft).not.toHaveBeenCalled();
		coordinator.configure(options);
		coordinator.configure(options);
		await Promise.resolve();
		expect(options.captureDraft).not.toHaveBeenCalled();
		persistGate.resolve();
		await admittedPersist;
		await Promise.all([first, second]);

		expect(yieldTurn).toHaveBeenCalledOnce();
		expect(options.gateway.closeRetiredInboundAdmission).toHaveBeenCalledOnce();
		expect(options.promptSave).toHaveBeenCalledWith('latest.json');
		expect(options.saveDraft).toHaveBeenCalledOnce();
		expect(options.saveDraft).toHaveBeenCalledWith(closeDraft);
		expect(options.repair).toHaveBeenCalledOnce();
		expect(options.drainStore).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(session.isClosing).toBe(true);
	});

	it('settles disposal when provider initialization fails before full configuration', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		const coordinator = new CompatSidecarCloseCoordinator({ session });
		const closeRetiredInboundAdmission = vi.fn(async () => undefined);
		const dispose = vi.fn();

		const disposal = coordinator.disposePanel();
		const failure = coordinator.failInitialization({
			gateway: { closeRetiredInboundAdmission },
			subscriptions: [{ dispose }],
		});
		await Promise.all([disposal, failure, coordinator.failInitialization({
			gateway: { closeRetiredInboundAdmission },
			subscriptions: [{ dispose }],
		})]);

		expect(closeRetiredInboundAdmission).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(session.isClosing).toBe(true);
		expect(coordinator.allowRetiredInbound({ type: 'persistDocument', reason: 'beforeunload' })).toBe(false);
	});

	it('repairs and drains a dirty draft after Discard without saving or recovering it', async () => {
		const session = new CompatSidecarSession(false, 'KQL');
		const coordinator = new CompatSidecarCloseCoordinator({
			session,
			yieldTurn: async () => undefined,
		});
		session.markDirty('baseline');
		const options = finalization(draft('discarded'), {
			promptSave: vi.fn(async () => 'Discard'),
		});
		coordinator.configure(options);

		await coordinator.disposePanel();

		expect(options.promptSave).toHaveBeenCalledOnce();
		expect(options.saveDraft).not.toHaveBeenCalled();
		expect(options.recoverDraft).not.toHaveBeenCalled();
		expect(options.repair).toHaveBeenCalledOnce();
		expect(options.drainStore).toHaveBeenCalledOnce();
		expect(session.isClosing).toBe(true);
	});

	it.each([
		['dismissal', async () => undefined],
		['prompt rejection', async () => { throw new Error('prompt failed'); }],
	] as const)('recovers the exact dirty draft after %s', async (_label, promptSave) => {
		const session = new CompatSidecarSession(false, 'KQL');
		const closeDraft = draft('prompt-recovery');
		const coordinator = new CompatSidecarCloseCoordinator({
			session,
			yieldTurn: async () => undefined,
		});
		session.markDirty('baseline');
		const options = finalization(closeDraft, { promptSave });
		coordinator.configure(options);

		await coordinator.disposePanel();

		expect(options.saveDraft).not.toHaveBeenCalled();
		expect(options.recoverDraft).toHaveBeenCalledOnce();
		expect(options.recoverDraft).toHaveBeenCalledWith(closeDraft);
		expect(options.notifyRecovered).toHaveBeenCalledWith(closeDraft.uri);
		expect(options.repair).toHaveBeenCalledOnce();
		expect(options.drainStore).toHaveBeenCalledOnce();
	});

	it('admits only delayed beforeunload and correlated final replies until stable closure', async () => {
		const session = new CompatSidecarSession(true, 'SQL');
		let requestId = '';
		const finalPersist = session.requestFinalPersist(message => {
			requestId = String((message as Record<string, unknown>).requestId || '');
			return true;
		}, 'hidden', 10_000);
		await vi.waitFor(() => expect(requestId).not.toBe(''));
		const events: string[] = [];
		const coordinator = new CompatSidecarCloseCoordinator({ session });
		const options = finalization(undefined, {
			gateway: { closeRetiredInboundAdmission: vi.fn(async () => { events.push('admission-closed'); }) },
		});
		coordinator.configure(options);

		expect(coordinator.allowRetiredInbound({ type: 'persistDocument', reason: 'beforeunload' })).toBe(true);
		expect(coordinator.allowRetiredInbound({ type: 'persistDocument' })).toBe(false);
		expect(coordinator.allowRetiredInbound({ type: 'persistDocument', flushRequestId: 'other' })).toBe(false);
		expect(coordinator.allowRetiredInbound({ type: 'persistDocument', flushRequestId: requestId })).toBe(true);
		expect(coordinator.isPendingFinalPersistReply({ type: 'persistDocument', flushRequestId: requestId })).toBe(true);

		const close = coordinator.disposePanel();
		session.markBeforeUnload('beforeunload');
		events.push('beforeunload');
		session.completeFinalPersist(requestId);
		events.push('final-persist');
		await finalPersist;
		await close;

		expect(events).toEqual(['beforeunload', 'final-persist', 'admission-closed']);
		expect(coordinator.allowRetiredInbound({ type: 'persistDocument', reason: 'beforeunload' })).toBe(false);
		expect(coordinator.allowRetiredInbound({ type: 'persistDocument', flushRequestId: requestId })).toBe(false);
	});

	it('recovers the exact attempted draft and drains the store when repair fails', async () => {
		const session = new CompatSidecarSession(false, 'SQL');
		const closeDraft = draft('recover-me');
		const recovered: CompatSidecarCloseDraft[] = [];
		const drainStore = vi.fn(async () => undefined);
		const notifyRecovered = vi.fn(() => { throw new Error('notification failed'); });
		const coordinator = new CompatSidecarCloseCoordinator({
			session,
			yieldTurn: async () => undefined,
		});
		session.markDirty('baseline');
		const options = finalization(closeDraft, {
			saveDraft: vi.fn(async () => { throw new Error('CAS conflict'); }),
			recoverDraft: vi.fn(async value => {
				recovered.push(value);
				return value.uri;
			}),
			notifyRecovered,
			repair: vi.fn(async () => { throw new Error('repair unavailable'); }),
			drainStore,
		});
		coordinator.configure(options);

		await coordinator.disposePanel();

		expect(options.saveDraft).toHaveBeenCalledWith(closeDraft);
		expect(recovered).toEqual([closeDraft]);
		expect(options.notifySaveFailed).not.toHaveBeenCalled();
		expect(notifyRecovered).toHaveBeenCalledOnce();
		expect(drainStore).toHaveBeenCalledOnce();
		expect(session.isClosing).toBe(true);
	});

	it('keeps close transaction authority out of both compatibility providers', () => {
		for (const fileName of ['kqlCompatEditorProvider.ts', 'sqlCompatEditorProvider.ts']) {
			const source = fs.readFileSync(path.join(process.cwd(), 'src', 'host', fileName), 'utf8');
			expect(source).toContain('closeCoordinator.configure(closeFinalization)');
			expect(source).toContain('projectionCoordinatorFactory');
			expect(source).not.toContain('waitForFinalPersists()');
			expect(source).not.toContain('closeRetiredInboundAdmission()');
			expect(source).not.toContain('delayedBeforeUnloadAdmissionOpen');
			expect(source).not.toContain('sidecarSession.beginClose()');
			expect(source).not.toContain('sidecarSession.settleClose()');
		}
		const closeSource = fs.readFileSync(path.join(process.cwd(), 'src', 'host', 'compatSidecarCloseCoordinator.ts'), 'utf8');
		expect(closeSource).not.toContain('CompatSidecarProjectionCoordinator');
		expect(closeSource).not.toContain('sourceGeneration');
	});
});
