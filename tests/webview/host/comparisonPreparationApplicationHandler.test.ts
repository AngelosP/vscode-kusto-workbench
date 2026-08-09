import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import {
	HostComparisonPreparationApplicationHandler,
	type ComparisonPreparationApplicationHandlerOptions,
} from '../../../src/host/comparisonPreparationApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type {
	KustoCopilotRequestIdentity,
	KustoSectionExecutionTarget,
} from '../../../src/shared/kustoExecution';
import type {
	SqlComparisonOwner,
	SqlEditorTarget,
} from '../../../src/host/sql/sqlEditorSessionRegistry';

class TestSqlLifecycle {
	private readonly sectionInstances = new Map<string, string>();
	private readonly targets = new Map<string, SqlEditorTarget>();
	private readonly comparisonOwners = new Map<string, SqlComparisonOwner>();

	openSection(boxId: string, sectionInstanceId: string): void {
		this.sectionInstances.set(boxId, sectionInstanceId);
	}

	setTarget(boxId: string, connectionId: string, database: string, generation: number): void {
		this.targets.set(boxId, { boxId, connectionId, database, generation });
	}

	getConnectionId(boxId: string): string | undefined {
		return this.targets.get(boxId)?.connectionId;
	}

	getSectionInstanceId(boxId: string): string | undefined {
		return this.sectionInstances.get(boxId);
	}

	getGeneration(boxId: string): number {
		return this.targets.get(boxId)?.generation ?? 0;
	}

	getTarget(boxId: string): SqlEditorTarget | undefined {
		return this.targets.get(boxId);
	}

	isSectionCurrent(boxId: string, sectionInstanceId: string): boolean {
		return this.sectionInstances.get(boxId) === sectionInstanceId;
	}

	getComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		return this.comparisonOwners.get(boxId);
	}

	setComparisonOwner(boxId: string, owner: SqlComparisonOwner): void {
		this.comparisonOwners.set(boxId, owner);
	}

	removeComparisonOwner(boxId: string): SqlComparisonOwner | undefined {
		const owner = this.comparisonOwners.get(boxId);
		this.comparisonOwners.delete(boxId);
		return owner;
	}
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createCancellation(initiallyCanceled = false) {
	let isCancellationRequested = initiallyCanceled;
	const listeners = new Set<() => void>();
	const token = {
		get isCancellationRequested() { return isCancellationRequested; },
		onCancellationRequested: (listener: () => void) => {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
	} as vscode.CancellationToken;
	return {
		token,
		cancel: () => {
			if (isCancellationRequested) return;
			isCancellationRequested = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(sqlSource = true) {
	const lifecycle = new TestSqlLifecycle();
	if (sqlSource) {
		lifecycle.openSection('source', 'source-instance');
		lifecycle.setTarget('source', 'sql-connection', 'Database', 3);
	}
	const postMessage = vi.fn(async (_message: unknown) => true);
	const sqlExecutionBroker = { supersede: vi.fn(() => 1) };
	const sqlWorkbench = { assertSqlConnectionAllowed: vi.fn(async () => undefined) };
	const kustoExecutionCoordinator = {
		openSection: vi.fn(() => true),
		adoptTarget: vi.fn(() => true),
		getActive: vi.fn(),
		cancelExpected: vi.fn(() => false),
	};
	const cancelCopilotQueryTarget = vi.fn();
	const cancelCopilotWriteQuery = vi.fn();
	let hasWebview = true;
	let requestSequence = 0;
	const options: ComparisonPreparationApplicationHandlerOptions = {
		sqlLifecycle: lifecycle,
		sqlExecutionBroker,
		sqlWorkbench,
		kustoExecutionCoordinator,
		postMessage,
		hasWebview: () => hasWebview,
		cancelCopilotQueryTarget,
		cancelCopilotWriteQuery,
		createRequestId: () => `request-${++requestSequence}`,
	};
	const handler = new HostComparisonPreparationApplicationHandler(options);
	return {
		handler,
		lifecycle,
		postMessage,
		sqlExecutionBroker,
		sqlWorkbench,
		kustoExecutionCoordinator,
		cancelCopilotQueryTarget,
		cancelCopilotWriteQuery,
		setHasWebview: (value: boolean) => { hasWebview = value; },
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function postedMessage(harness: Harness, type: string): Record<string, unknown> {
	const call = harness.postMessage.mock.calls.find(([message]) =>
		(message as { type?: string } | undefined)?.type === type);
	if (!call) throw new Error(`Expected ${type} to be posted.`);
	return call[0] as Record<string, unknown>;
}

function sqlComparisonEnsured(requestId: string): IncomingWebviewMessage {
	return {
		type: 'comparisonBoxEnsured',
		engine: 'sql',
		requestId,
		sourceBoxId: 'source',
		comparisonBoxId: 'comparison',
		sourceSectionInstanceId: 'source-instance',
		sourceTargetGeneration: 3,
		comparisonSectionInstanceId: 'comparison-instance',
		comparisonTargetGeneration: 7,
		comparisonConnectionId: 'sql-connection',
		comparisonDatabase: 'Database',
	};
}

function sqlAck(
	requestId: string,
	phase: 'staged' | 'committed' | 'finalized' | 'completed' | 'rolledBack',
	accepted = true,
): IncomingWebviewMessage {
	return {
		type: 'sqlComparisonAdmissionAck',
		phase,
		requestId,
		sourceBoxId: 'source',
		comparisonBoxId: 'comparison',
		accepted,
	};
}

function automaticallyAcknowledgeRollback(harness: Harness): void {
	harness.postMessage.mockImplementation(async (message: unknown) => {
		const candidate = message as Record<string, unknown>;
		if (candidate.type === 'sqlComparisonAdmissionRollback') {
			queueMicrotask(() => {
				void harness.handler.handleMessage(sqlAck(String(candidate.requestId), 'rolledBack'));
			});
		}
		return true;
	});
}

describe('HostComparisonPreparationApplicationHandler', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('declines unrelated traffic synchronously and rejects unavailable or canceled preparation', async () => {
		const harness = createHarness(false);
		expect(harness.handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
		harness.setHasWebview(false);
		await expect(harness.handler.ensureComparisonBoxInWebview(
			'source', 'print 1', createCancellation().token,
		)).rejects.toThrow('Webview panel is not available');
		harness.setHasWebview(true);
		await expect(harness.handler.ensureComparisonBoxInWebview(
			'source', 'print 1', createCancellation(true).token,
		)).rejects.toThrow('Canceled');
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('prepares and removes an exact Kusto comparison owner', async () => {
		const harness = createHarness(false);
		const cancellation = createCancellation();
		const request: KustoCopilotRequestIdentity = {
			boxId: 'source',
			sectionInstanceId: 'source-instance',
			targetGeneration: 5,
			copilotRequestId: 'copilot-request',
		};
		const target: KustoSectionExecutionTarget = {
			engine: 'kusto',
			boxId: 'comparison',
			sectionInstanceId: 'comparison-instance',
			targetGeneration: 9,
			connectionId: 'kusto-connection',
			database: 'Samples',
		};
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'StormEvents | count', cancellation.token, 17, request,
		);
		await flushPromises();
		const outbound = postedMessage(harness, 'ensureComparisonBox');
		expect(outbound).toMatchObject({
			requestId: 'request-1',
			boxId: 'source',
			query: 'StormEvents | count',
			engine: 'kusto',
			...request,
		});

		await harness.handler.handleMessage({
			type: 'comparisonBoxEnsured',
			engine: 'kusto',
			requestId: 'request-1',
			sourceBoxId: 'source',
			comparisonBoxId: 'comparison',
			kustoTarget: target,
			...request,
		});
		await expect(preparation).resolves.toEqual({ boxId: 'comparison', kustoTarget: target });
		expect(harness.kustoExecutionCoordinator.openSection)
			.toHaveBeenCalledWith('comparison', 'comparison-instance');
		expect(harness.kustoExecutionCoordinator.adoptTarget).toHaveBeenCalledWith(target);

		const active = {
			boxId: 'comparison',
			executionId: 'comparison-execution',
			sectionInstanceId: 'comparison-instance',
			targetGeneration: 9,
			reservationSequence: 1,
		};
		harness.kustoExecutionCoordinator.getActive.mockReturnValue(active);
		await harness.handler.handleMessage({
			type: 'sqlComparisonRemoved', boxId: 'comparison', sourceBoxId: 'source',
		});
		expect(harness.kustoExecutionCoordinator.cancelExpected).toHaveBeenCalledWith(active);
		expect(harness.cancelCopilotQueryTarget).toHaveBeenCalledWith('source', 'comparison', 17);
		expect(harness.cancelCopilotWriteQuery).toHaveBeenCalledWith('source', 17);
	});

	it('ignores a stale Kusto ensured identity until exact cancellation settles it', async () => {
		const harness = createHarness(false);
		const cancellation = createCancellation();
		const request: KustoCopilotRequestIdentity = {
			boxId: 'source', sectionInstanceId: 'source-instance',
			targetGeneration: 5, copilotRequestId: 'copilot-request',
		};
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'print 1', cancellation.token, undefined, request,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		await harness.handler.handleMessage({
			type: 'comparisonBoxEnsured', requestId: 'request-1', sourceBoxId: 'source',
			comparisonBoxId: 'comparison', boxId: 'source', sectionInstanceId: 'stale-instance',
			targetGeneration: 5, copilotRequestId: 'copilot-request',
		});
		expect(harness.kustoExecutionCoordinator.openSection).not.toHaveBeenCalled();
		cancellation.cancel();
		await expect(preparation).rejects.toThrow('Canceled');
	});

	it('requires exact acknowledgements through all four forward SQL phases', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token, 23,
		);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		const ensured = harness.handler.handleMessage(sqlComparisonEnsured(requestId));
		await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmission', requestId, accepted: true,
		})));
		expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();

		await harness.handler.handleMessage({
			...sqlAck(requestId, 'staged'), sourceBoxId: 'wrong-source',
		});
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmissionCommit', requestId,
		}));

		for (const [phase, outboundType] of [
			['staged', 'sqlComparisonAdmissionCommit'],
			['committed', 'sqlComparisonAdmissionFinalize'],
			['finalized', 'sqlComparisonAdmissionComplete'],
		] as const) {
			await harness.handler.handleMessage(sqlAck(requestId, phase));
			await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith({
				type: outboundType,
				requestId,
				sourceBoxId: 'source',
				comparisonBoxId: 'comparison',
			}));
			expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();
		}
		await harness.handler.handleMessage(sqlAck(requestId, 'completed'));
		await ensured;

		await expect(preparation).resolves.toEqual({ boxId: 'comparison' });
		expect(harness.lifecycle.getComparisonOwner('comparison')).toEqual({
			sourceBoxId: 'source',
			connectionId: 'sql-connection',
			copilotSequence: 23,
			comparisonRequestId: requestId,
		});
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRelease',
			outcome: 'completed',
			requestId,
			sourceBoxId: 'source',
			comparisonBoxId: 'comparison',
		});
	});

	it('rolls back a failed SQL commit only after the exact rolledBack acknowledgement', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		let handler!: HostComparisonPreparationApplicationHandler;
		harness.postMessage.mockImplementation(async (message: unknown) => {
			const candidate = message as Record<string, unknown>;
			if (candidate.type === 'sqlComparisonAdmissionRollback') {
				queueMicrotask(() => {
					void handler.handleMessage(sqlAck(String(candidate.requestId), 'rolledBack'));
				});
			}
			return candidate.type !== 'sqlComparisonAdmissionCommit';
		});
		handler = harness.handler;
		const preparation = handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		const ensured = handler.handleMessage(sqlComparisonEnsured(requestId));
		await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmission', requestId,
		})));
		await handler.handleMessage(sqlAck(requestId, 'staged'));
		await ensured;

		await expect(preparation).rejects.toThrow('commit was not applied');
		expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRelease',
			outcome: 'rolledBack',
			requestId,
			sourceBoxId: 'source',
			comparisonBoxId: 'comparison',
		});
	});

	it('retries rollback after three failed acknowledgement deliveries', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		let rollbackAttempts = 0;
		harness.postMessage.mockImplementation(async (message: unknown) => {
			const candidate = message as Record<string, unknown>;
			if (candidate.type === 'sqlComparisonAdmission') return false;
			if (candidate.type === 'sqlComparisonAdmissionRollback') {
				rollbackAttempts += 1;
				if (rollbackAttempts === 4) {
					queueMicrotask(() => {
						void harness.handler.handleMessage(sqlAck(String(candidate.requestId), 'rolledBack'));
					});
					return true;
				}
				return false;
			}
			return true;
		});
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		await harness.handler.handleMessage(sqlComparisonEnsured(requestId));
		await flushPromises();
		expect(rollbackAttempts).toBe(3);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(preparation).rejects.toThrow('admission was not applied');
		expect(rollbackAttempts).toBe(4);
	});

	it('revalidates SQL source and comparison targets after deferred policy admission', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		const policy = deferred<void>();
		harness.sqlWorkbench.assertSqlConnectionAllowed
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(() => policy.promise);
		automaticallyAcknowledgeRollback(harness);
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		const ensured = harness.handler.handleMessage(sqlComparisonEnsured(requestId));
		await vi.waitFor(() => expect(harness.sqlWorkbench.assertSqlConnectionAllowed).toHaveBeenCalledTimes(2));
		harness.lifecycle.setTarget('comparison', 'sql-other', 'OtherDatabase', 8);
		policy.resolve();
		await ensured;

		await expect(preparation).rejects.toThrow('changed during policy admission');
		expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();
	});

	it('cancels pending SQL preparation and exact Copilot work when comparison removal wins', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		const policy = deferred<void>();
		harness.sqlWorkbench.assertSqlConnectionAllowed
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(() => policy.promise);
		automaticallyAcknowledgeRollback(harness);
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token, 31,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		const ensured = harness.handler.handleMessage(sqlComparisonEnsured(requestId));
		await vi.waitFor(() => expect(harness.sqlWorkbench.assertSqlConnectionAllowed).toHaveBeenCalledTimes(2));

		await harness.handler.handleMessage({
			type: 'sqlComparisonRemoved', boxId: 'comparison', sourceBoxId: 'source',
		});
		await expect(preparation).rejects.toThrow('Canceled');
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRollback', requestId,
			sourceBoxId: 'source', comparisonBoxId: 'comparison',
		});
		expect(harness.sqlExecutionBroker.supersede).not.toHaveBeenCalled();
		expect(harness.cancelCopilotQueryTarget).toHaveBeenCalledWith('source', 'comparison', 31);
		expect(harness.cancelCopilotWriteQuery).toHaveBeenCalledWith('source', 31);

		policy.resolve();
		await ensured;
		expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();
	});

	it('keeps committed removal on the exact acknowledged rollback path', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		automaticallyAcknowledgeRollback(harness);
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token, 35,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		const ensured = harness.handler.handleMessage(sqlComparisonEnsured(requestId));
		await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'sqlComparisonAdmission', requestId }),
		));
		await harness.handler.handleMessage(sqlAck(requestId, 'staged'));
		await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'sqlComparisonAdmissionCommit', requestId }),
		));
		await harness.handler.handleMessage(sqlAck(requestId, 'committed'));
		await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'sqlComparisonAdmissionFinalize', requestId }),
		));

		await harness.handler.handleMessage({
			type: 'sqlComparisonRemoved', boxId: 'comparison', sourceBoxId: 'source',
		});
		await ensured;
		await expect(preparation).rejects.toThrow('Canceled');
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlComparisonAdmissionRollback', requestId,
			sourceBoxId: 'source', comparisonBoxId: 'comparison',
		});
		expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();
	});

	it('settles removal after finalization when completion can no longer be acknowledged', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token, 37,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		const ensured = harness.handler.handleMessage(sqlComparisonEnsured(requestId));

		for (const [phase, outboundType] of [
			['staged', 'sqlComparisonAdmissionCommit'],
			['committed', 'sqlComparisonAdmissionFinalize'],
			['finalized', 'sqlComparisonAdmissionComplete'],
		] as const) {
			const expectedType = phase === 'staged'
				? 'sqlComparisonAdmission'
				: phase === 'committed'
					? 'sqlComparisonAdmissionCommit'
					: 'sqlComparisonAdmissionFinalize';
			await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: expectedType, requestId }),
			));
			await harness.handler.handleMessage(sqlAck(requestId, phase));
			await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: outboundType, requestId }),
			));
		}

		await harness.handler.handleMessage({
			type: 'sqlComparisonRemoved', boxId: 'comparison', sourceBoxId: 'source',
		});
		await harness.handler.handleMessage(sqlAck(requestId, 'completed', false));
		await ensured;

		await expect(preparation).rejects.toThrow('Canceled');
		expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmissionRollback', requestId,
		}));
		expect(harness.cancelCopilotQueryTarget).toHaveBeenCalledWith('source', 'comparison', 37);
		expect(harness.cancelCopilotWriteQuery).toHaveBeenCalledWith('source', 37);
	});

	it('makes finalized acknowledgement atomic with immediate removal', async () => {
		const harness = createHarness();
		harness.lifecycle.openSection('comparison', 'comparison-instance');
		harness.lifecycle.setTarget('comparison', 'sql-connection', 'Database', 7);
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token, 39,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		const requestId = String(postedMessage(harness, 'ensureComparisonBox').requestId);
		const ensured = harness.handler.handleMessage(sqlComparisonEnsured(requestId));
		for (const [phase, outboundType] of [
			['staged', 'sqlComparisonAdmission'],
			['committed', 'sqlComparisonAdmissionCommit'],
			['finalized', 'sqlComparisonAdmissionFinalize'],
		] as const) {
			await vi.waitFor(() => expect(harness.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: outboundType, requestId }),
			));
			if (phase === 'finalized') break;
			await harness.handler.handleMessage(sqlAck(requestId, phase));
		}

		const finalized = harness.handler.handleMessage(sqlAck(requestId, 'finalized'));
		const removed = harness.handler.handleMessage({
			type: 'sqlComparisonRemoved', boxId: 'comparison', sourceBoxId: 'source',
		});
		await Promise.all([finalized, removed, ensured]);

		await expect(preparation).rejects.toThrow('Canceled');
		expect(harness.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlComparisonAdmissionRollback', requestId,
		}));
		expect(harness.lifecycle.getComparisonOwner('comparison')).toBeUndefined();
		expect(harness.cancelCopilotQueryTarget).toHaveBeenCalledWith('source', 'comparison', 39);
	});

	it('rejects nested SQL sources and lifecycle-invalid SQL sources before mutation', async () => {
		const harness = createHarness();
		harness.lifecycle.setComparisonOwner('source', {
			sourceBoxId: 'root', connectionId: 'sql-connection',
		});
		await expect(harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token,
		)).rejects.toThrow('cannot be used as another comparison source');
		harness.lifecycle.removeComparisonOwner('source');
		harness.lifecycle.setTarget('source', 'sql-connection', '', 4);
		await expect(harness.handler.ensureComparisonBoxInWebview(
			'source', 'SELECT 2', createCancellation().token,
		)).rejects.toThrow('lifecycle identity is unavailable');
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('settles the 20-second preparation deadline and explicit lifecycle rejection', async () => {
		vi.useFakeTimers();
		const harness = createHarness(false);
		const first = harness.handler.ensureComparisonBoxInWebview(
			'source-a', 'print 1', createCancellation().token,
		);
		const second = harness.handler.ensureComparisonBoxInWebview(
			'source-b', 'print 2', createCancellation().token,
		);
		void first.catch(() => undefined);
		void second.catch(() => undefined);
		await flushPromises();
		harness.handler.rejectPendingComparisonEnsures('source-a');
		await expect(first).rejects.toThrow('Canceled');

		await vi.advanceTimersByTimeAsync(20_000);
		await expect(second).rejects.toThrow('Timed out while preparing comparison editor');
	});

	it('settles disposal, ignores late acknowledgements, suppresses later work, and is idempotent', async () => {
		const harness = createHarness(false);
		const preparation = harness.handler.ensureComparisonBoxInWebview(
			'source', 'print 1', createCancellation().token,
		);
		void preparation.catch(() => undefined);
		await flushPromises();
		harness.handler.dispose();
		harness.handler.dispose();
		await expect(preparation).rejects.toThrow('Canceled');

		await expect(harness.handler.handleMessage(sqlAck('request-1', 'staged'))).resolves.toBeUndefined();
		await expect(harness.handler.handleMessage({
			type: 'sqlComparisonRemoved', boxId: 'comparison', sourceBoxId: 'source',
		})).resolves.toBeUndefined();
		await expect(harness.handler.ensureComparisonBoxInWebview(
			'source', 'print 2', createCancellation().token,
		)).rejects.toThrow('Canceled');
		expect(harness.postMessage).toHaveBeenCalledTimes(1);
	});
});
