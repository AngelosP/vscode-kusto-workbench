import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HostArtifactCsvSaveApplicationHandler } from '../../../src/host/artifactCsvSaveApplicationHandler';
import { HostDevelopmentNoteMutationApplicationHandler } from '../../../src/host/developmentNoteMutationApplicationHandler';
import {
	isMainWebviewCorrelatedReply,
	MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
	MainWebviewStartupGateway,
} from '../../../src/host/mainWebviewStartupGateway';
import {
	admitDevelopmentNoteMutationWebviewMessage,
	createDevelopmentNoteMutationWebviewMessage,
	type DevelopmentNoteMutationHostMessage,
} from '../../../src/shared/developmentNoteMutationProtocol';
import { admitArtifactCsvSaveWebviewMessage } from '../../../src/shared/artifactCsvSaveProtocol';

type TestMessage = { type: string; sequence?: number; [key: string]: unknown };

function createPanelHarness() {
	let receive: ((message: unknown) => unknown) | undefined;
	const disposalHandlers: Array<() => unknown> = [];
	const registrationOrder: string[] = [];
	const posted: unknown[] = [];
	const panel = {
		webview: {
			onDidReceiveMessage: vi.fn((handler: (message: unknown) => unknown) => {
				registrationOrder.push('receive');
				receive = handler;
				return { dispose: vi.fn() };
			}),
			postMessage: vi.fn(async (message: unknown) => {
				posted.push(message);
				return true;
			}),
		},
		onDidDispose: vi.fn((handler: () => unknown) => {
			registrationOrder.push('dispose');
			disposalHandlers.push(handler);
			return { dispose: vi.fn() };
		}),
	} as any;

	return {
		panel,
		posted,
		registrationOrder,
		receive: (message: unknown) => {
			if (!receive) throw new Error('The panel receiver was not installed.');
			return receive(message);
		},
		disposePanel: () => {
			for (const handler of disposalHandlers) handler();
		},
	};
}

function admitTestMessage(input: unknown): TestMessage | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
	const message = input as TestMessage;
	return typeof message.type === 'string' ? message : undefined;
}

describe('MainWebviewStartupGateway', () => {
	it('recognizes every identity-shaped waiter reply and all SQL comparison phases', () => {
		const replies: TestMessage[] = [
			{
				type: 'artifactCsvSaveData', requestId: 'csv-1', boxId: 'query-1',
				artifactId: 'artifact-1', accepted: false,
			},
			{ type: 'comparisonBoxEnsured', requestId: 'comparison-1' },
			{ type: 'documentReloadResult', requestId: 'reload-1' },
			{ type: 'markdownDocumentCommandBarrierResult', requestId: 'barrier-1' },
			{ type: 'publishToPowerBIAck', requestId: 'publish-1', accepted: true },
			{ type: 'toolExecutionStarted', requestId: 'tool-start-1' },
			{ type: 'toolResponse', requestId: 'tool-1' },
			{ type: 'toolStateResponse', requestId: 'state-1', sections: [] },
			{
				type: 'kustoExecutionStartedAck', boxId: 'query-1', executionId: 'execution-1',
				sectionInstanceId: 'section-1', targetGeneration: 1, accepted: true,
			},
			{ type: 'kustoPublicationAck', publicationId: 'publication-1', phase: 'staged', accepted: true },
			{ type: 'kustoPublicationAck', publicationId: 'publication-1', phase: 'applied', accepted: false },
			...['staged', 'committed', 'finalized', 'completed', 'rolledBack'].map(phase => ({
				type: 'sqlComparisonAdmissionAck', requestId: `sql-${phase}`,
				sourceBoxId: 'sql-source', comparisonBoxId: 'sql-comparison', phase,
			})),
		];

		for (const reply of replies) expect(isMainWebviewCorrelatedReply(reply)).toBe(true);
		expect(isMainWebviewCorrelatedReply({ type: 'persistDocument' })).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'artifactCsvSaveData', requestId: 'csv-1', boxId: ['query-1'],
			artifactId: 'artifact-1', accepted: true, csv: 'forged',
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({ type: 'persistDocument', flushRequestId: 'flush-1' })).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'publishToPowerBIAck', requestId: 'publish-1', accepted: 'yes',
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({ type: 'toolResponse', requestId: '' })).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'toolStateResponse', requestId: 'state-1', sections: {},
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'kustoPublicationAck', publicationId: 'publication-1', phase: 'applied',
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'sqlComparisonAdmissionAck', requestId: 'sql-invalid', sourceBoxId: 'source',
			comparisonBoxId: 'comparison', phase: 'invalid',
		})).toBe(false);
	});

	it('rejects malformed Power BI traffic before startup queueing, reentrancy, or delivery', async () => {
		const harness = createPanelHarness();
		const received: TestMessage[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});

		void harness.receive({
			type: 'publishToPowerBIAck', requestId: 'publish-1', accepted: 'yes',
		});
		await gateway.setInboundHandler(message => { received.push(message); });
		expect(received).toEqual([]);

		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		await expect(gateway.postMessage({
			type: 'publishToPowerBIResult', requestId: 'publish-1', boxId: 'html-1', ok: true,
			reportUrl: 'https://app.powerbi.com/report', scheduleConfigured: 'yes',
			initialRefreshTriggered: false, dataMode: 'import', semanticModelId: 'model-1',
			reportId: 'report-1', workspaceId: 'workspace-1', reportName: 'Operations',
		})).resolves.toBe(false);
		expect(harness.posted).toEqual([]);

		await harness.receive({
			type: 'publishToPowerBIAck', requestId: 'publish-1', accepted: true,
		});
		expect(received).toEqual([{
			type: 'publishToPowerBIAck', requestId: 'publish-1', accepted: true,
		}]);
	});

	it('rejects malformed Kusto publication traffic before startup queueing and delivery', async () => {
		const harness = createPanelHarness();
		const received: TestMessage[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		const malformedAck = Object.assign(Object.create({ inherited: true }), {
			type: 'kustoPublicationAck', publicationId: 'publication-current',
			phase: 'applied', accepted: true,
		});

		void harness.receive(malformedAck);
		await gateway.setInboundHandler(message => { received.push(message); });
		expect(received).toEqual([]);

		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		const malformedStage = Object.assign(Object.create({ inherited: true }), {
			type: 'kustoPublicationStage', publicationId: 'publication-current',
			publicationDeadline: Date.now() + 1_000, payload: { type: 'snapshot' },
		});
		await expect(gateway.postMessage(malformedStage)).resolves.toBe(false);
		expect(harness.posted).toEqual([]);
	});

	it('snapshots artifact CSV replies before startup queueing and reentrancy checks', async () => {
		const harness = createPanelHarness();
		const received: TestMessage[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		const reply: TestMessage = {
			type: 'artifactCsvSaveData', requestId: 'csv-1', boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true, csv: 'canonical',
		};

		void harness.receive(reply);
		reply.boxId = ['query-1'];
		reply.csv = 'forged';
		await gateway.setInboundHandler(message => { received.push(message); });

		expect(received).toEqual([{
			type: 'artifactCsvSaveData', requestId: 'csv-1', boxId: 'query-1',
			artifactId: 'artifact-1', accepted: true, csv: 'canonical',
		}]);
		expect(received[0]).not.toBe(reply);
	});

	it('does not consume a live artifact transfer after dropping a non-enumerable field', async () => {
		vi.useFakeTimers();
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const informationSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const harness = createPanelHarness();
		const posted: any[] = [];
		const artifactHandler = new HostArtifactCsvSaveApplicationHandler({
			postMessage: async message => {
				posted.push(message);
				return true;
			},
			isDisposed: () => false,
			showSaveDialog: async () => vscode.Uri.file('C:/Users/test/Downloads/gateway.csv'),
		}) as HostArtifactCsvSaveApplicationHandler & Record<string, any>;
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});

		try {
			await artifactHandler.handleMessage({
				type: 'requestArtifactCsvSave', requestId: 'gateway-export',
				boxId: 'query-1', artifactId: 'artifact-1',
			} as any);
			const challenge = posted.find(message => message.type === 'requestArtifactCsvSaveData');
			if (!challenge) throw new Error('Expected an artifact CSV transfer challenge.');
			const pending = artifactHandler.pendingArtifactCsvSaves.get(challenge.requestId);
			if (!pending) throw new Error('Expected a live artifact CSV transfer.');
			const initialTimerCount = vi.getTimerCount();
			await gateway.setInboundHandler(message => artifactHandler.handleMessage(message as any));

			const malformed: Record<string, unknown> = {
				type: 'artifactCsvSaveData', requestId: challenge.requestId,
				boxId: 'query-1', artifactId: 'artifact-1', accepted: false,
			};
			Object.defineProperty(malformed, 'csv', {
				enumerable: false,
				value: 'must remain invalid',
			});
			const directAdmission = admitArtifactCsvSaveWebviewMessage(malformed);
			expect(directAdmission).toMatchObject({ recognized: true, parsed: { ok: false } });

			await Promise.resolve(harness.receive(malformed));
			expect(artifactHandler.pendingArtifactCsvSaves.get(challenge.requestId)).toBe(pending);
			expect(artifactHandler.pendingArtifactCsvSaves.get(challenge.requestId).timer).toBe(pending.timer);
			expect(artifactHandler.pendingArtifactCsvIntentIds.has('gateway-export')).toBe(true);
			expect(artifactHandler.completedArtifactCsvIntentIds.size).toBe(0);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(informationSpy).not.toHaveBeenCalled();

			await Promise.resolve(harness.receive({
				type: 'artifactCsvSaveData', requestId: challenge.requestId,
				boxId: 'query-1', artifactId: 'artifact-1', accepted: false,
			}));
			expect(artifactHandler.pendingArtifactCsvSaves.size).toBe(0);
			expect(artifactHandler.pendingArtifactCsvIntentIds.has('gateway-export')).toBe(false);
			expect(artifactHandler.completedArtifactCsvIntentIds.has('gateway-export')).toBe(true);
			expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
			expect(informationSpy).toHaveBeenCalledWith('Results are no longer available for CSV export.');
		} finally {
			artifactHandler.dispose();
			gateway.dispose();
			clearTimeoutSpy.mockRestore();
			informationSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('installs listener first and drains both directions exactly once in order', async () => {
		const harness = createPanelHarness();
		const inbound: number[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});

		expect(harness.registrationOrder).toEqual(['receive', 'dispose']);
		void harness.receive({ type: 'request', sequence: 1 });
		void harness.receive({ type: 'request', sequence: 2 });
		const firstDelivery = gateway.postMessage({ type: 'projection', sequence: 1 });
		const secondDelivery = gateway.postMessage({ type: 'projection', sequence: 2 });
		expect(harness.posted).toEqual([]);

		await gateway.setInboundHandler(message => {
			inbound.push(message.sequence ?? -1);
		});
		expect(inbound).toEqual([1, 2]);

		await Promise.resolve(harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE }));
		expect(await Promise.all([firstDelivery, secondDelivery])).toEqual([true, true]);
		expect(harness.posted).toEqual([
			{ type: 'projection', sequence: 1 },
			{ type: 'projection', sequence: 2 },
		]);

		await Promise.resolve(harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE }));
		expect(harness.posted).toHaveLength(2);
		expect(await gateway.postMessage({ type: 'projection', sequence: 3 })).toBe(true);
		expect(harness.posted).toHaveLength(3);
	});

	it('rejects retired traffic while preserving an explicitly admitted final message', async () => {
		const harness = createPanelHarness();
		const inbound: string[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowRetiredInbound: message => message.type === 'finalPersist',
		});
		await gateway.setInboundHandler(message => { inbound.push(message.type); });
		const queuedDelivery = gateway.postMessage({ type: 'projection', sequence: 1 });

		harness.disposePanel();
		expect(await queuedDelivery).toBe(false);
		await Promise.resolve(harness.receive({ type: 'ordinary' }));
		await Promise.resolve(harness.receive({ type: 'finalPersist' }));
		expect(inbound).toEqual(['finalPersist']);
		expect(await gateway.postMessage({ type: 'projection', sequence: 2 })).toBe(false);
		expect(harness.posted).toEqual([]);
	});

	it('continues draining when the final delivery continuation enqueues more outbound work', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});
		const firstDelivery = gateway.postMessage({ type: 'projection', sequence: 1 });
		const chainedDelivery = firstDelivery.then(() =>
			gateway.postMessage({ type: 'projection', sequence: 2 }),
		);

		await Promise.resolve(harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE }));
		expect(await chainedDelivery).toBe(true);
		expect(harness.posted).toEqual([
			{ type: 'projection', sequence: 1 },
			{ type: 'projection', sequence: 2 },
		]);
	});

	it('keeps ordinary handoff traffic ordered while allowing an explicit correlated reply', async () => {
		const harness = createPanelHarness();
		const events: string[] = [];
		let markFirstStarted!: () => void;
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		void harness.receive({ type: 'request', sequence: 1 });

		const drain = gateway.setInboundHandler(async message => {
			const label = message.type === 'toolStateResponse' ? 'reply' : `request:${message.sequence}`;
			events.push(`start:${label}`);
			if (message.type === 'request' && message.sequence === 1) {
				markFirstStarted();
				await firstGate;
			}
			if (message.type === 'toolStateResponse') releaseFirst();
			events.push(`end:${label}`);
		});
		await firstStarted;

		void harness.receive({ type: 'request', sequence: 2 });
		expect(events).toEqual(['start:request:1']);
		await Promise.resolve(harness.receive({
			type: 'toolStateResponse', requestId: 'state-reply', sections: {},
		}));
		expect(events).toEqual(['start:request:1']);
		await Promise.resolve(harness.receive({
			type: 'toolStateResponse', requestId: 'state-reply', sections: [],
		}));
		await drain;

		expect(events).toEqual([
			'start:request:1',
			'start:reply',
			'end:reply',
			'end:request:1',
			'start:request:2',
			'end:request:2',
		]);
	});

	it('admits only a canonical execution-start acknowledgement during blocked startup', async () => {
		vi.useFakeTimers();
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const harness = createPanelHarness();
		const events: string[] = [];
		let markFirstStarted!: () => void;
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		const waiterTimer = setTimeout(() => undefined, 5_000);
		const timerCount = vi.getTimerCount();
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		void harness.receive({ type: 'request', sequence: 1 });
		const drain = gateway.setInboundHandler(async message => {
			if (message.type === 'request') {
				events.push('request:start');
				markFirstStarted();
				await firstGate;
				events.push('request:end');
				return;
			}
			events.push('ack');
			clearTimeout(waiterTimer);
			releaseFirst();
		});

		await firstStarted;
		const identity = {
			type: 'kustoExecutionStartedAck',
			boxId: 'query-1',
			executionId: 'execution-1',
			sectionInstanceId: 'instance-1',
			targetGeneration: 1,
		};
		await Promise.resolve(harness.receive({ ...identity, accepted: 'yes' }));
		expect(events).toEqual(['request:start']);
		expect(vi.getTimerCount()).toBe(timerCount);
		expect(clearTimeoutSpy).not.toHaveBeenCalled();

		await Promise.resolve(harness.receive({ ...identity, accepted: true }));
		await drain;
		expect(events).toEqual(['request:start', 'ack', 'request:end']);
		expect(clearTimeoutSpy).toHaveBeenCalledOnce();
	});

	it('rejects a captured proxied execution-start acknowledgement before reentrancy or routing', async () => {
		const harness = createPanelHarness();
		const received: TestMessage[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		await gateway.setInboundHandler(message => { received.push(message); });
		const acknowledgement = new Proxy({
			type: 'kustoExecutionStartedAck',
			boxId: 'query-1',
			executionId: 'execution-1',
			sectionInstanceId: 'instance-1',
			targetGeneration: 1,
			accepted: true,
		}, {});

		await Promise.resolve(harness.receive(acknowledgement));

		expect(received).toEqual([]);
	});

	it('rejects malformed execution starts before startup transport', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		const start = {
			type: 'kustoExecutionStarted',
			engine: 'kusto',
			boxId: 'query-1',
			executionId: 'execution-1',
			sectionInstanceId: 'instance-1',
			targetGeneration: 1,
			connectionId: 'connection-1',
			database: 'Samples',
			producer: 'copilot',
			reservationSequence: 1,
			query: 'print Value=1',
		};

		await expect(gateway.postMessage({ ...start, query: ['forged'] })).resolves.toBe(false);
		expect(harness.posted).toEqual([]);
		await expect(gateway.postMessage(start)).resolves.toBe(true);
		expect(harness.posted).toEqual([start]);
		expect(harness.posted[0]).not.toBe(start);
	});

	it('keeps an accessor-backed mutation response from consuming work during a blocked startup drain', async () => {
		vi.useFakeTimers();
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const harness = createPanelHarness();
		let outbound: DevelopmentNoteMutationHostMessage | undefined;
		const mutationHandler = new HostDevelopmentNoteMutationApplicationHandler({
			isAvailable: () => true,
			postMessage: message => {
				outbound = message;
				return true;
			},
		});
		let mutationSettled = false;
		const mutation = mutationHandler.updateDevelopmentNotes({ action: 'remove', noteId: 'note-1' });
		void mutation.then(() => { mutationSettled = true; });
		const requestId = outbound?.requestId;
		if (!requestId) throw new Error('Expected a development-note mutation request.');
		const initialTimerCount = vi.getTimerCount();

		let markFirstStarted!: () => void;
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		let genericResponses = 0;
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		void harness.receive({ type: 'request', sequence: 1 });
		const drain = gateway.setInboundHandler(async message => {
			if (message.type === 'request') {
				markFirstStarted();
				await firstGate;
				return;
			}
			const admission = admitDevelopmentNoteMutationWebviewMessage(message);
			const claimed = mutationHandler.handleResponseAdmission(admission)
				|| (admission.recognized && !admission.parsed.ok
					&& !admission.requestId && mutationHandler.hasPendingResponse());
			if (!claimed) genericResponses++;
			if (admission.recognized && admission.parsed.ok
				&& admission.parsed.value.requestId === requestId) releaseFirst();
		});

		try {
			await firstStarted;
			let getterCalls = 0;
			const malformed: Record<string, unknown> = {
				type: 'toolResponse',
				result: { success: 'yes' },
			};
			Object.defineProperty(malformed, 'requestId', {
				configurable: true,
				enumerable: true,
				get() {
					getterCalls++;
					Object.defineProperties(malformed, {
						requestId: { configurable: true, enumerable: true, value: requestId },
						result: { configurable: true, enumerable: true, value: { success: true } },
					});
					return requestId;
				},
			});

			await Promise.resolve(harness.receive(malformed));
			expect(getterCalls).toBe(0);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			let typeGetCalls = 0;
			const proxyTarget: Record<string, unknown> = {
				type: 'toolResponse',
				requestId,
				result: { success: 'yes' },
			};
			const typeMutatingProxy = new Proxy(proxyTarget, {
				get(target, key, receiver) {
					if (key === 'type') {
						typeGetCalls++;
						target.result = { success: true };
					}
					return Reflect.get(target, key, receiver);
				},
			});
			await Promise.resolve(harness.receive(typeMutatingProxy));
			expect(typeGetCalls).toBe(0);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			let resultDescriptorCalls = 0;
			const descriptorTarget: Record<string, unknown> = {
				type: 'toolResponse',
				requestId,
				result: { success: 'yes' },
			};
			const descriptorMutatingProxy = new Proxy(descriptorTarget, {
				getOwnPropertyDescriptor(target, key) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
					if (key === 'result' && ++resultDescriptorCalls === 1) {
						target.result = { success: true };
					}
					return descriptor;
				},
			});
			await Promise.resolve(harness.receive(descriptorMutatingProxy));
			expect(resultDescriptorCalls).toBe(1);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			let nestedDescriptorCalls = 0;
			const nestedDescriptorTarget: Record<string, unknown> = { success: 'yes' };
			const nestedDescriptorProxy = new Proxy(nestedDescriptorTarget, {
				getOwnPropertyDescriptor(target, key) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
					if (key === 'success' && ++nestedDescriptorCalls === 1) target.success = true;
					return descriptor;
				},
			});
			await Promise.resolve(harness.receive({
				type: 'toolResponse', requestId, result: nestedDescriptorProxy,
			}));
			expect(nestedDescriptorCalls).toBe(0);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			let nestedPrototypeCalls = 0;
			const nestedPrototypeProxy = new Proxy({ success: true }, {
				getPrototypeOf() {
					nestedPrototypeCalls++;
					return nestedPrototypeCalls === 1 ? { custom: true } : Object.prototype;
				},
			});
			await Promise.resolve(harness.receive({
				type: 'toolResponse', requestId, result: nestedPrototypeProxy,
			}));
			expect(nestedPrototypeCalls).toBe(0);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			let topLevelPrototypeCalls = 0;
			const inheritedRequestPrototype = { requestId };
			const topLevelPrototypeProxy = new Proxy({
				type: 'toolResponse', result: { success: 'yes' },
			}, {
				getPrototypeOf() {
					topLevelPrototypeCalls++;
					return topLevelPrototypeCalls === 1
						? inheritedRequestPrototype
						: Object.prototype;
				},
			});
			await Promise.resolve(harness.receive(topLevelPrototypeProxy));
			expect(topLevelPrototypeCalls).toBe(1);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			let aliasedOwnKeysCalls = 0;
			const aliasedTarget: Record<string, unknown> = {
				type: 'toolResponse', requestId, success: true,
			};
			let aliasedResponse!: Record<string, unknown>;
			aliasedResponse = new Proxy(aliasedTarget, {
				ownKeys() {
					aliasedOwnKeysCalls++;
					return aliasedOwnKeysCalls === 1
						? ['type', 'requestId', 'result']
						: ['success'];
				},
				getOwnPropertyDescriptor(target, key) {
					if (key === 'result') {
						return { configurable: true, enumerable: true, writable: true, value: aliasedResponse };
					}
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			});
			await Promise.resolve(harness.receive(aliasedResponse));
			expect(aliasedOwnKeysCalls).toBe(1);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			let wrappedOwnKeysCalls = 0;
			const wrappedTarget: Record<string, unknown> = {
				type: 'toolResponse', requestId, success: true,
			};
			let shapeVaryingResponse!: Record<string, unknown>;
			let wrappedResponse!: Record<string, unknown>;
			shapeVaryingResponse = new Proxy(wrappedTarget, {
				ownKeys() {
					wrappedOwnKeysCalls++;
					return wrappedOwnKeysCalls === 1
						? ['type', 'requestId', 'result']
						: ['success'];
				},
				getOwnPropertyDescriptor(target, key) {
					if (key === 'result') {
						return { configurable: true, enumerable: true, writable: true, value: wrappedResponse };
					}
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			});
			wrappedResponse = new Proxy(shapeVaryingResponse, {});
			await Promise.resolve(harness.receive(shapeVaryingResponse));
			expect(wrappedOwnKeysCalls).toBe(1);
			expect(mutationHandler.hasPendingResponse()).toBe(true);
			expect(mutationSettled).toBe(false);
			expect(vi.getTimerCount()).toBe(initialTimerCount);
			expect(clearTimeoutSpy).not.toHaveBeenCalled();
			expect(genericResponses).toBe(0);

			await Promise.resolve(harness.receive(
				createDevelopmentNoteMutationWebviewMessage(requestId, true),
			));
			await drain;
			await expect(mutation).resolves.toEqual({ success: true });
			expect(mutationHandler.hasPendingResponse()).toBe(false);
			expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
			expect(genericResponses).toBe(0);
		} finally {
			releaseFirst();
			mutationHandler.dispose();
			gateway.dispose();
			clearTimeoutSpy.mockRestore();
			vi.useRealTimers();
		}
	});

	it('queues synchronous ordinary reentry behind the complete startup queue', async () => {
		const harness = createPanelHarness();
		const events: number[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});
		void harness.receive({ type: 'request', sequence: 1 });
		void harness.receive({ type: 'request', sequence: 2 });

		await gateway.setInboundHandler(message => {
			events.push(message.sequence ?? -1);
			if (message.sequence === 1) void harness.receive({ type: 'request', sequence: 3 });
		});

		expect(events).toEqual([1, 2, 3]);
	});

	it('continues the startup drain after one queued handler rejects', async () => {
		const harness = createPanelHarness();
		const events: number[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});
		void harness.receive({ type: 'request', sequence: 1 });
		void harness.receive({ type: 'request', sequence: 2 });

		await gateway.setInboundHandler(message => {
			events.push(message.sequence ?? -1);
			if (message.sequence === 1) throw new Error('expected startup failure');
		});
		await Promise.resolve(harness.receive({ type: 'request', sequence: 3 }));

		expect(events).toEqual([1, 2, 3]);
	});

	it('drains only allowed final inbound traffic when retirement precedes handler installation', async () => {
		const harness = createPanelHarness();
		const inbound: string[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowRetiredInbound: message => message.type === 'finalPersist',
		});
		void harness.receive({ type: 'ordinary' });
		harness.disposePanel();
		void harness.receive({ type: 'finalPersist' });

		await gateway.setInboundHandler(message => { inbound.push(message.type); });
		expect(inbound).toEqual(['finalPersist']);
	});

	it('retains close-critical admission captured during grace while an older handler is blocked', async () => {
		const harness = createPanelHarness();
		const inbound: string[] = [];
		let graceOpen = true;
		let markFirstStarted!: () => void;
		let releaseFirst!: () => void;
		const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowRetiredInbound: message => graceOpen && message.type === 'finalPersist',
		});
		void harness.receive({ type: 'request', sequence: 1 });
		const drain = gateway.setInboundHandler(async message => {
			inbound.push(message.type);
			if (message.type === 'request') {
				markFirstStarted();
				await firstGate;
			}
		});
		await firstStarted;
		harness.disposePanel();
		void harness.receive({ type: 'finalPersist' });
		graceOpen = false;
		releaseFirst();
		await drain;

		expect(inbound).toEqual(['request', 'finalPersist']);
	});

	it('orders retained and late retired traffic and continues after one handler rejects', async () => {
		const harness = createPanelHarness();
		const events: number[] = [];
		let markOrdinaryStarted!: () => void;
		let releaseOrdinary!: () => void;
		const ordinaryStarted = new Promise<void>(resolve => { markOrdinaryStarted = resolve; });
		const ordinaryGate = new Promise<void>(resolve => { releaseOrdinary = resolve; });
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowRetiredInbound: message => message.type === 'finalPersist',
		});
		void harness.receive({ type: 'request', sequence: 0 });
		const startupDrain = gateway.setInboundHandler(async message => {
			if (message.type === 'request') {
				markOrdinaryStarted();
				await ordinaryGate;
				return;
			}
			events.push(message.sequence ?? -1);
			if (message.sequence === 1) throw new Error('expected retained failure');
		});
		await ordinaryStarted;
		void harness.receive({ type: 'finalPersist', sequence: 1 });
		void harness.receive({ type: 'finalPersist', sequence: 2 });
		harness.disposePanel();
		await Promise.resolve(harness.receive({ type: 'finalPersist', sequence: 3 }));
		releaseOrdinary();
		await startupDrain;

		expect(events).toEqual([1, 2, 3]);
	});

	it('closes retired admission atomically and waits the existing chain to settle', async () => {
		const harness = createPanelHarness();
		const events: number[] = [];
		let markStarted!: () => void;
		let release!: () => void;
		const started = new Promise<void>(resolve => { markStarted = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowRetiredInbound: message => message.type === 'finalPersist',
		});
		await gateway.setInboundHandler(async message => {
			events.push(message.sequence ?? -1);
			markStarted();
			await gate;
		});
		harness.disposePanel();
		void harness.receive({ type: 'finalPersist', sequence: 1 });
		await started;
		let closeSettled = false;
		const closing = gateway.closeRetiredInboundAdmission().then(() => { closeSettled = true; });
		void harness.receive({ type: 'finalPersist', sequence: 2 });
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		release();
		await closing;

		expect(events).toEqual([1]);
	});

	it('keeps a retired predecessor isolated from a ready successor panel', async () => {
		const predecessor = createPanelHarness();
		const successor = createPanelHarness();
		const predecessorGateway = new MainWebviewStartupGateway<TestMessage>({
			panel: predecessor.panel,
			admitInbound: admitTestMessage,
		});
		const successorGateway = new MainWebviewStartupGateway<TestMessage>({
			panel: successor.panel,
			admitInbound: admitTestMessage,
		});
		const predecessorInbound = vi.fn();
		const successorInbound = vi.fn();
		await predecessorGateway.setInboundHandler(predecessorInbound);
		await successorGateway.setInboundHandler(successorInbound);

		predecessor.disposePanel();
		await Promise.resolve(successor.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE }));
		await Promise.resolve(predecessor.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE }));
		await Promise.resolve(predecessor.receive({ type: 'request', sequence: 1 }));
		await Promise.resolve(successor.receive({ type: 'request', sequence: 2 }));

		expect(await predecessorGateway.postMessage({ type: 'projection', sequence: 1 })).toBe(false);
		expect(await successorGateway.postMessage({ type: 'projection', sequence: 2 })).toBe(true);
		expect(predecessorInbound).not.toHaveBeenCalled();
		expect(successorInbound).toHaveBeenCalledWith({ type: 'request', sequence: 2 });
		expect(predecessor.posted).toEqual([]);
		expect(successor.posted).toEqual([{ type: 'projection', sequence: 2 }]);
	});
});
