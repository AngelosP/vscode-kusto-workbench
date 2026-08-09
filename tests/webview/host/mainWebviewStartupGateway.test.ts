import { describe, expect, it, vi } from 'vitest';

import {
	isMainWebviewCorrelatedReply,
	MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
	MainWebviewStartupGateway,
} from '../../../src/host/mainWebviewStartupGateway';

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
			{ type: 'artifactCsvSaveData', requestId: 'csv-1' },
			{ type: 'comparisonBoxEnsured', requestId: 'comparison-1' },
			{ type: 'documentReloadResult', requestId: 'reload-1' },
			{ type: 'markdownDocumentCommandBarrierResult', requestId: 'barrier-1' },
			{ type: 'publishToPowerBIAck', requestId: 'publish-1' },
			{ type: 'toolExecutionStarted', requestId: 'tool-start-1' },
			{ type: 'toolResponse', requestId: 'tool-1' },
			{ type: 'toolStateResponse', requestId: 'state-1' },
			{
				type: 'kustoExecutionStartedAck', boxId: 'query-1', executionId: 'execution-1',
				sectionInstanceId: 'section-1', targetGeneration: 1,
			},
			{ type: 'kustoPublicationAck', publicationId: 'publication-1', phase: 'staged' },
			{ type: 'kustoPublicationAck', publicationId: 'publication-1', phase: 'applied' },
			...['staged', 'committed', 'finalized', 'completed', 'rolledBack'].map(phase => ({
				type: 'sqlComparisonAdmissionAck', requestId: `sql-${phase}`,
				sourceBoxId: 'sql-source', comparisonBoxId: 'sql-comparison', phase,
			})),
		];

		for (const reply of replies) expect(isMainWebviewCorrelatedReply(reply)).toBe(true);
		expect(isMainWebviewCorrelatedReply({ type: 'persistDocument' })).toBe(false);
		expect(isMainWebviewCorrelatedReply({ type: 'persistDocument', flushRequestId: 'flush-1' })).toBe(false);
		expect(isMainWebviewCorrelatedReply({ type: 'toolResponse', requestId: '' })).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'sqlComparisonAdmissionAck', requestId: 'sql-invalid', sourceBoxId: 'source',
			comparisonBoxId: 'comparison', phase: 'invalid',
		})).toBe(false);
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
		await Promise.resolve(harness.receive({ type: 'toolStateResponse', requestId: 'state-reply' }));
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
