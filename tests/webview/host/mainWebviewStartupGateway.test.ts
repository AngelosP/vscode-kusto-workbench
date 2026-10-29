import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HostArtifactCsvSaveApplicationHandler } from '../../../src/host/artifactCsvSaveApplicationHandler';
import { HostDevelopmentNoteMutationApplicationHandler } from '../../../src/host/developmentNoteMutationApplicationHandler';
import {
	isMainWebviewCorrelatedReply,
	MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
	MainWebviewStartupGateway,
	waitForRetainedStartupInitialization,
} from '../../../src/host/mainWebviewStartupGateway';
import {
	admitDevelopmentNoteMutationWebviewMessage,
	createDevelopmentNoteMutationWebviewMessage,
	type DevelopmentNoteMutationHostMessage,
} from '../../../src/shared/developmentNoteMutationProtocol';
import { admitArtifactCsvSaveWebviewMessage } from '../../../src/shared/artifactCsvSaveProtocol';
import { decodeMainWebviewHostMessage, encodeMainWebviewHostMessage, SCHEMA_DATA_BYTES_CODEC } from '../../../src/shared/mainWebviewMessageTransport';

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
	it('decodes schema bytes without bypassing the canonical message boundary', () => {
		const schema = { type: 'schemaData', requestToken: 'request_1', schema: { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: {} } } };
		expect(decodeMainWebviewHostMessage(encodeMainWebviewHostMessage(schema, true))).toEqual(schema);
		expect(decodeMainWebviewHostMessage(schema)).toBe(schema);
		for (const payload of ['not bytes', new Uint8Array([255]), new TextEncoder().encode('broken'), new TextEncoder().encode('[]'), new TextEncoder().encode('{"type":"documentData"}'), new TextEncoder().encode('{"type":"serializedSchemaData"}')]) {
			expect(decodeMainWebviewHostMessage({ type: 'serializedSchemaData', payload })).toBeUndefined();
		}
		let accessorReads = 0;
		const accessor = Object.defineProperty({ type: 'serializedSchemaData' }, 'payload', {
			enumerable: true, get: () => { accessorReads++; return new Uint8Array(); },
		});
		expect(decodeMainWebviewHostMessage(accessor)).toBeUndefined();
		expect(accessorReads).toBe(0);
	});

	it('shares immutable schema bytes without sharing per-request metadata', () => {
		const schema = { tables: ['Events'], columnTypesByTable: {}, rawSchemaJson: { Databases: {} } };
		const first = { type: 'schemaData', schema, requestToken: 'request_a', accountPartition: 'account_a', targetGeneration: 1, schemaMeta: { schemaSignature: 'signature_1' } };
		const second = { ...first, requestToken: 'request_b', accountPartition: 'account_b', targetGeneration: 2 };
		const firstEncoded = encodeMainWebviewHostMessage(first, true) as { payload: Uint8Array };
		const secondEncoded = encodeMainWebviewHostMessage(second, true) as { payload: Uint8Array };
		expect(secondEncoded.payload).toBe(firstEncoded.payload);
		expect(decodeMainWebviewHostMessage(firstEncoded)).toEqual(first);
		expect(decodeMainWebviewHostMessage(secondEncoded)).toEqual(second);
		const revised = encodeMainWebviewHostMessage({ ...first, schemaMeta: { schemaSignature: 'signature_2' } }, true) as { payload: Uint8Array };
		expect(revised.payload).not.toBe(firstEncoded.payload);
		const recreated = encodeMainWebviewHostMessage({ ...first, schema: { ...schema } }, true) as { payload: Uint8Array };
		expect(recreated.payload).not.toBe(firstEncoded.payload);
		const unsigned = { type: 'schemaData', schema };
		expect((encodeMainWebviewHostMessage(unsigned, true) as { payload: Uint8Array }).payload)
			.not.toBe((encodeMainWebviewHostMessage(unsigned, true) as { payload: Uint8Array }).payload);
	});

	it('reuses an immutable decoded schema only for exact bytes and keeps each request header', () => {
		const schema = { tables: ['SharedDecodeEvents'], columnTypesByTable: { SharedDecodeEvents: { Value: 'long' } }, rawSchemaJson: { Databases: {} } };
		const payload = new TextEncoder().encode(JSON.stringify(schema));
		const retainedBytes = payload.slice();
		const message = (bytes: Uint8Array, requestToken: string) => ({
			type: 'serializedSchemaData', payload: bytes,
			metadata: { type: 'schemaData', requestToken, accountPartition: requestToken, schemaMeta: { schemaSignature: 'same-signature' } },
		});
		const parse = vi.spyOn(JSON, 'parse');
		try {
			const first = decodeMainWebviewHostMessage(message(payload, 'first')) as any;
			payload.fill(0);
			const second = decodeMainWebviewHostMessage(message(retainedBytes.slice(), 'second')) as any;
			expect(parse).toHaveBeenCalledTimes(1);
			expect(second).not.toBe(first);
			expect(second.schema).toBe(first.schema);
			expect(second.requestToken).toBe('second');
			expect(second.accountPartition).toBe('second');
			expect(Object.hasOwn(second, 'schema')).toBe(true);
			expect(Object.isFrozen(second.schema.rawSchemaJson.Databases)).toBe(true);
			expect(() => second.schema.tables.push('Mutation')).toThrow();
			const revisedBytes = new TextEncoder().encode(JSON.stringify({ ...schema, tables: ['ChangedDecodeEvents'] }));
			const revised = decodeMainWebviewHostMessage(message(revisedBytes, 'third')) as any;
			expect(parse).toHaveBeenCalledTimes(2);
			expect(revised.schema.tables).toEqual(['ChangedDecodeEvents']);
			expect(first.schema).toEqual(schema);
		} finally {
			parse.mockRestore();
		}
	});

	it('revalidates headers on decoded cache hits and compares only the active byte view', () => {
		const payload = new TextEncoder().encode('{"tables":["OffsetDecodeEvents"]}');
		const padded = new Uint8Array(payload.length + 4);
		padded.set(payload, 2);
		const metadata = { type: 'schemaData', requestToken: 'offset' };
		const first = decodeMainWebviewHostMessage({ type: 'serializedSchemaData', metadata, payload }) as any;
		const second = decodeMainWebviewHostMessage({ type: 'serializedSchemaData', metadata, payload: new DataView(padded.buffer, 2, payload.length) }) as any;
		expect(second.schema).toBe(first.schema);
		for (const malformed of [{ type: 'documentData' }, { type: 'schemaData', schema: {} }, Object.create(metadata), [], null]) {
			expect(decodeMainWebviewHostMessage({ type: 'serializedSchemaData', metadata: malformed, payload })).toBeUndefined();
		}
		expect(decodeMainWebviewHostMessage({ type: 'serializedSchemaData', metadata, payload: padded })).toBeUndefined();
	});

	it('does not retain shared-backed or oversized decoded payloads', () => {
		const payload = new TextEncoder().encode('{"tables":["SharedBufferDecodeEvents"]}');
		const shared = new Uint8Array(new SharedArrayBuffer(payload.length));
		shared.set(payload);
		const metadata = { type: 'schemaData', requestToken: 'uncached' };
		const message = { type: 'serializedSchemaData', metadata, payload: shared };
		const first = decodeMainWebviewHostMessage(message) as any;
		const second = decodeMainWebviewHostMessage(message) as any;
		expect(second.schema).toEqual(first.schema);
		expect(second.schema).not.toBe(first.schema);
		const oversized = new TextEncoder().encode('{"padding":"' + 'x'.repeat(64 * 1024 * 1024) + '"}');
		const largeMessage = { type: 'serializedSchemaData', metadata, payload: oversized };
		const largeFirst = decodeMainWebviewHostMessage(largeMessage) as any;
		const largeSecond = decodeMainWebviewHostMessage(largeMessage) as any;
		expect(largeFirst.schema.padding.length).toBe(64 * 1024 * 1024);
		expect(largeSecond.schema).not.toBe(largeFirst.schema);
	});

	it('rejects malformed split schema envelopes before reconstruction', () => {
		const payload = new TextEncoder().encode('{"tables":[]}');
		for (const metadata of [{ type: 'documentData' }, { type: 'schemaData', schema: {} }, [], null, new (class { type = 'schemaData'; })()]) {
			expect(decodeMainWebviewHostMessage({ type: 'serializedSchemaData', metadata, payload })).toBeUndefined();
		}
		for (const text of ['[]', 'null', 'false', '1', '"schema"']) {
			expect(decodeMainWebviewHostMessage({ type: 'serializedSchemaData', metadata: { type: 'schemaData' }, payload: new TextEncoder().encode(text) })).toBeUndefined();
		}
		let reads = 0;
		const accessor = Object.defineProperty({ type: 'serializedSchemaData', payload }, 'metadata', { enumerable: true, get: () => { reads++; return { type: 'schemaData' }; } });
		expect(decodeMainWebviewHostMessage(accessor)).toBeUndefined();
		expect(reads).toBe(0);
	});

	it('encodes prepared schemas on the exact negotiated runtime and rejects serialization failures', async () => {
		const harness = createPanelHarness();
		const schema = { type: 'schemaData', schema: { tables: ['Events'] } };
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel, admitInbound: admitTestMessage,
			prepareOutbound: message => (message as TestMessage).type === 'schemaData' ? { ...(message as TestMessage), requestToken: 'prepared' } : message,
		});
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'legacy' });
		await gateway.postMessage(schema);
		expect(harness.posted[0]).toEqual({ ...schema, requestToken: 'prepared' });
		gateway.beginDispatcherRevalidation();
		const probe = harness.posted.at(-1) as { type: string; probeId: string };
		expect(probe.type).toBe('mainWebviewDispatcherProbe');
		const pending = gateway.postMessage(schema);
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'modern', probeId: probe.probeId, transportCodecs: [SCHEMA_DATA_BYTES_CODEC] });
		await expect(pending).resolves.toBe(true);
		expect(decodeMainWebviewHostMessage(harness.posted.at(-1))).toEqual({ ...schema, requestToken: 'prepared' });
		const count = harness.posted.length;
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(gateway.postMessage({ type: 'schemaData', schema: circular })).resolves.toBe(false);
		await expect(gateway.postMessage({ type: 'schemaData', schema: { value: BigInt(1) } })).resolves.toBe(false);
		expect(harness.posted).toHaveLength(count);
		gateway.dispose();
	});

	it('does not inspect accessor-valued schema fields or capability-array proxies', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		let reads = 0;
		const proxy = new Proxy([SCHEMA_DATA_BYTES_CODEC], { get: () => { reads++; throw new Error('trap'); } });
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'invalid', transportCodecs: proxy });
		expect(reads).toBe(0);
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'modern', transportCodecs: [SCHEMA_DATA_BYTES_CODEC] });
		const accessor = Object.defineProperty({ type: 'schemaData' }, 'schema', { enumerable: true, get: () => { reads++; return {}; } });
		await expect(gateway.postMessage(accessor)).resolves.toBe(false);
		expect(reads).toBe(0);
		expect(harness.posted).toEqual([]);
		gateway.dispose();
	});

	it('uses a negotiated binary schema payload without changing its data or other messages', async () => {
		const harness = createPanelHarness();
		const schema = {
			type: 'schemaData', boxId: 'query_1', connectionId: 'connection_1', database: 'Samples',
			clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'account_1',
			requestToken: 'request_1', sectionInstanceId: 'instance_1', targetGeneration: 2,
			schema: { tables: ['Events'], columnTypesByTable: { Events: { Value: 'long' } }, rawSchemaJson: { Databases: { Samples: { Tables: { Events: { OrderedColumns: [{ Name: 'Value', CslType: 'long' }] } } } } } },
			schemaMeta: { schemaSignature: 'schema_1' },
		};
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		const delivery = gateway.postMessage(schema);
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime_1', transportCodecs: [SCHEMA_DATA_BYTES_CODEC] });
		await expect(delivery).resolves.toBe(true);
		const encoded = harness.posted[0] as { type: string; payload: Uint8Array };
		expect(encoded.type).toBe('serializedSchemaData');
		expect(encoded.payload).toBeInstanceOf(Uint8Array);
		expect(JSON.parse(new TextDecoder().decode(encoded.payload))).toEqual(schema.schema);
		expect(decodeMainWebviewHostMessage(encoded)).toEqual(schema);
		const other = { type: 'requestMarkdownCommandBarrier', requestId: 'save_1', sourceGeneration: 2 };
		await gateway.postMessage(other);
		expect(harness.posted[1]).toBe(other);
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'legacy_runtime', transportCodecs: ['schemaDataBytes/1'] });
		await gateway.postMessage(schema);
		expect(harness.posted[2]).toBe(schema);
		gateway.dispose();
	});

	it('settles retained startup on completion or a bounded timeout', async () => {
		vi.useFakeTimers();
		try {
			const completed = Promise.withResolvers<string>();
			const completion = waitForRetainedStartupInitialization(completed.promise, 2_000);
			completed.resolve('ready');
			await expect(completion).resolves.toEqual({ settled: true, value: 'ready' });
			expect(vi.getTimerCount()).toBe(0);

			const pending = new Promise<string>(() => undefined);
			const timeout = waitForRetainedStartupInitialization(pending, 2_000);
			await vi.advanceTimersByTimeAsync(1_999);
			let timedOut = false;
			void timeout.then(() => { timedOut = true; });
			await Promise.resolve();
			expect(timedOut).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(timeout).resolves.toEqual({ settled: false });
		} finally {
			vi.useRealTimers();
		}
	});

	it('recognizes every identity-shaped waiter reply and all SQL comparison phases', () => {
		const replies: TestMessage[] = [
			{
				type: 'artifactCsvSaveData', requestId: 'csv-1', boxId: 'query-1',
				artifactId: 'artifact-1', accepted: false,
			},
			{ type: 'comparisonBoxEnsured', requestId: 'comparison-1' },
			{ type: 'documentReloadResult', requestId: 'reload-1' },
			{ type: 'embeddedTutorialViewerShown', requestId: 'embedded-1' },
			{ type: 'markdownDocumentCommandBarrierResult', requestId: 'barrier-1' },
			{ type: 'publishToPowerBIAck', requestId: 'publish-1', accepted: true },
			{ type: 'toolExecutionStarted', requestId: 'tool-start-1' },
			{ type: 'toolResponse', requestId: 'tool-1' },
			{ type: 'toolStateResponse', requestId: 'state-1', sections: [] },
			{
				type: 'kustoExecutionStartedAck', boxId: 'query-1', executionId: 'execution-1',
				sectionInstanceId: 'section-1', targetGeneration: 1, accepted: true,
			},
			{
				type: 'copilotWriteQueryExecutionAck', boxId: 'sql-1',
				executionId: 'sql-execution-1', accepted: true,
			},
			{
				type: 'persistDocument', snapshotId: 'snapshot-1', sourceGeneration: 1,
				editRevision: 2, state: { sections: [] },
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
		expect(isMainWebviewCorrelatedReply({ type: 'embeddedTutorialViewerShown', requestId: '' })).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'copilotWriteQueryExecutionAck', boxId: 'sql-1',
			executionId: 'sql-execution-1', accepted: 'yes',
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'copilotWriteQueryExecutionAck', boxId: ['sql-1'],
			executionId: ['sql-execution-1'], accepted: true,
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'copilotWriteQueryExecutionAck', boxId: ' sql-1 ',
			executionId: 'sql-execution-1', accepted: true,
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply(new Proxy({
			type: 'copilotWriteQueryExecutionAck', boxId: 'sql-1',
			executionId: 'sql-execution-1', accepted: true,
		}, {}))).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'persistDocument', snapshotId: 'snapshot-1', sourceGeneration: 1,
			editRevision: 2,
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'persistDocument', snapshotId: 'snapshot-1', sourceGeneration: '1',
			editRevision: 2, state: { sections: [] },
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'persistDocument', snapshotId: ['snapshot-1'], sourceGeneration: 1,
			editRevision: '2', state: { sections: [] },
		})).toBe(false);
		expect(isMainWebviewCorrelatedReply(new Proxy({
			type: 'persistDocument', snapshotId: 'snapshot-1', sourceGeneration: 1,
			editRevision: 2, state: { sections: [] },
		}, {}))).toBe(false);
		expect(isMainWebviewCorrelatedReply({
			type: 'persistDocument', snapshotId: 'snapshot-1', sourceGeneration: 1,
			editRevision: 2, state: {},
		})).toBe(false);
		let accessorReads = 0;
		const accessorState = Object.defineProperty({}, 'sections', {
			enumerable: true,
			get: () => { accessorReads++; return []; },
		});
		expect(isMainWebviewCorrelatedReply({
			type: 'persistDocument', snapshotId: 'snapshot-1', sourceGeneration: 1,
			editRevision: 2, state: accessorState,
		})).toBe(false);
		expect(accessorReads).toBe(0);
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

	it('prepares an idle ready document projection synchronously and allows a transport-reentrant reply', async () => {
		const harness = createPanelHarness();
		const events: string[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel, admitInbound: admitTestMessage,
			prepareOutbound: message => { events.push(`prepare:${(message as TestMessage).type}`); return message; },
		});
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		vi.mocked(harness.panel.webview.postMessage).mockImplementation(async (message: TestMessage) => {
			events.push(`send:${message.type}`);
			harness.posted.push(message);
			if (message.type === 'documentData') await gateway.postMessage({ type: 'commandResult' });
			return true;
		});
		const delivery = gateway.postDocumentProjection({
			preflight: () => { events.push('preflight'); return true; },
			prepare: () => { events.push('factory'); return { message: { type: 'documentData' } }; },
		});
		expect(events).toEqual([
			'preflight', 'factory', 'prepare:documentData', 'send:documentData',
			'prepare:commandResult', 'send:commandResult',
		]);
		await expect(delivery).resolves.toBe(true);
		gateway.dispose();
	});

	it.each(['retirement', 'disposal', 'readiness ABA', 'runtime replacement', 'revalidation expiry'] as const)(
		'cancels a document projection during async preflight on %s without reviving its factory', async transition => {
			vi.useFakeTimers();
			try {
				const harness = createPanelHarness();
				const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
				await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
				const preflight = Promise.withResolvers<boolean>();
				const prepare = vi.fn(() => ({ message: { type: 'documentData' } }));
				const delivery = gateway.postDocumentProjection({ preflight: () => preflight.promise, prepare });
				const following = gateway.postMessage({ type: 'following' });
				let revalidation: Promise<boolean> | undefined;
				if (transition === 'retirement') harness.disposePanel();
				else if (transition === 'disposal') gateway.dispose();
				else if (transition === 'runtime replacement') {
					void harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2' });
				}
				else {
					revalidation = gateway.beginDispatcherRevalidation();
					const probe = harness.posted.at(-1) as TestMessage;
					if (transition === 'readiness ABA') {
						void harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
					} else {
						await vi.advanceTimersByTimeAsync(4_000);
						await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
					}
				}
				await expect(delivery).resolves.toBe(false);
				await expect(following).resolves.toBe(transition === 'readiness ABA' || transition === 'runtime replacement');
				if (revalidation) await expect(revalidation).resolves.toBe(transition === 'readiness ABA');
				preflight.resolve(true);
				await vi.advanceTimersByTimeAsync(0);
				expect(prepare).not.toHaveBeenCalled();
				expect(harness.posted).not.toContainEqual({ type: 'documentData' });
				gateway.dispose();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it('reserves an async preflight head before reentrant ordinary admission and preserves its snapshot', async () => {
		const harness = createPanelHarness();
		const preflight = Promise.withResolvers<boolean>();
		const ordinary = { type: 'following', sequence: 1 };
		let following: Promise<boolean> | undefined;
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel, admitInbound: admitTestMessage,
			prepareOutbound: message => ({ ...(message as TestMessage) }),
		});
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		const prepare = vi.fn(() => ({ message: { type: 'documentData' } }));
		const check = vi.fn(() => {
			following = gateway.postMessage(ordinary);
			return preflight.promise;
		});
		const delivery = gateway.postDocumentProjection({ preflight: check, prepare });
		ordinary.sequence = 2;
		expect(gateway.postMessageFireAndForget({ type: 'fireAndForget' })).toBe(true);
		expect(harness.posted).toEqual([]);
		expect(prepare).not.toHaveBeenCalled();
		preflight.resolve(true);
		await expect(delivery).resolves.toBe(true);
		await expect(following).resolves.toBe(true);
		await vi.waitFor(() => expect(harness.posted).toEqual([
			{ type: 'documentData' }, { type: 'following', sequence: 1 }, { type: 'fireAndForget' },
		]));
		expect(check).toHaveBeenCalledTimes(1);
		expect(prepare).toHaveBeenCalledTimes(1);
		gateway.dispose();
	});

	it('observes a rejected async preflight even when it disposes the gateway during invocation', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		const preflight = Promise.withResolvers<boolean>();
		const prepare = vi.fn(() => ({ message: { type: 'documentData' } }));
		const delivery = gateway.postDocumentProjection({
			preflight: () => { gateway.dispose(); return preflight.promise; }, prepare,
		});
		await expect(delivery).resolves.toBe(false);
		preflight.reject(new Error('Retired source preflight failed.'));
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		expect(prepare).not.toHaveBeenCalled();
		expect(harness.posted).toEqual([]);
	});

	it.each(['cold', 'established'] as const)('never invokes a queued document factory after %s readiness expires', async startup => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
			if (startup === 'established') await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
			const readiness = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as TestMessage;
			const preflight = vi.fn(() => true);
			const prepare = vi.fn(() => ({ message: { type: 'documentData' } }));
			const delivery = gateway.postDocumentProjection({ preflight, prepare });
			await vi.advanceTimersByTimeAsync(startup === 'cold' ? 30_000 : 4_000);
			await expect(readiness).resolves.toBe(false);
			await expect(delivery).resolves.toBe(false);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
			await expect(gateway.waitForDispatcherReady()).resolves.toBe(false);
			expect(preflight).not.toHaveBeenCalled();
			expect(prepare).not.toHaveBeenCalled();
			expect(harness.posted).not.toContainEqual({ type: 'documentData' });
			gateway.dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		'preflight false', 'preflight throw', 'preflight reject', 'factory undefined', 'factory throw',
		'invalid execution', 'invalid tool snapshot', 'invalid publication', 'invalid Power BI',
		'outbound undefined', 'outbound throw', 'transport false', 'transport throw',
	] as const)('rejects %s once and continues the existing outbound drain', async failure => {
		const harness = createPanelHarness();
		const preparedTypes: string[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel, admitInbound: admitTestMessage,
			prepareOutbound: message => {
				const type = (message as TestMessage).type;
				preparedTypes.push(type);
				if (type === 'documentData' && failure === 'outbound undefined') return undefined;
				if (type === 'documentData' && failure === 'outbound throw') throw new Error('Invalid outbound preparation.');
				return message;
			},
		});
		vi.mocked(harness.panel.webview.postMessage).mockImplementation(async (message: TestMessage) => {
			if (message.type === 'documentData' && failure === 'transport throw') throw new Error('Transport failed.');
			harness.posted.push(message);
			return message.type !== 'documentData' || failure !== 'transport false';
		});
		const preflight = vi.fn(() => {
			if (failure === 'preflight throw') throw new Error('Source preflight failed.');
			if (failure === 'preflight reject') return Promise.reject(new Error('Source preflight rejected.'));
			return failure !== 'preflight false';
		});
		const prepare = vi.fn(() => {
			if (failure === 'factory undefined') return undefined;
			if (failure === 'factory throw') throw new Error('Projection preparation failed.');
			const type = failure === 'invalid execution' ? 'kustoExecutionStarted'
				: failure === 'invalid tool snapshot' ? 'requestToolState'
					: failure === 'invalid publication' ? 'kustoPublicationStage'
						: failure === 'invalid Power BI' ? 'publishToPowerBIResult' : 'documentData';
			return { message: { type } };
		});
		const onPreparationRejected = vi.fn();
		const projection = { preflight, prepare, onPreparationRejected };
		const delivery = gateway.postDocumentProjection(projection);
		const following = gateway.postMessage({ type: 'following' });
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		await expect(delivery).resolves.toBe(false);
		await expect(following).resolves.toBe(true);
		expect(preflight).toHaveBeenCalledTimes(1);
		expect(prepare).toHaveBeenCalledTimes(failure.startsWith('preflight') ? 0 : 1);
		expect(onPreparationRejected).toHaveBeenCalledTimes(failure.startsWith('preflight') || failure.startsWith('transport') ? 0 : 1);
		expect(preparedTypes).toEqual(failure.startsWith('outbound') || failure.startsWith('transport')
			? ['following', 'documentData'] : ['following']);
		expect(harness.posted.at(-1)).toEqual({ type: 'following' });
		gateway.dispose();
	});

	it('admits its issued recovery after READY without unblocking unrelated inbound work', async () => {
		const harness = createPanelHarness();
		let release!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		const handled: string[] = [];
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel, admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		harness.receive({ type: 'heldInbound' });
		const drain = gateway.setInboundHandler(async message => {
			handled.push(message.type);
			if (message.type === 'heldInbound') await held;
		});
		try {
			await Promise.resolve();
			const readiness = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as { probeId: string };
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'recovered-runtime', probeId: probe.probeId });
			await expect(readiness).resolves.toBe(true);
			const recovery = { type: 'requestDocument', requestId: `dispatcher-document-${probe.probeId}` };
			await harness.receive(recovery);
			await harness.receive(recovery);
			harness.receive({ type: 'ordinaryFollowing' });

			expect(handled).toEqual(['heldInbound', 'requestDocument']);
			release();
			await drain;
			expect(handled).toEqual(['heldInbound', 'requestDocument', 'ordinaryFollowing']);
		} finally {
			release();
			await drain;
			gateway.dispose();
		}
	});

	it('never routes unissued or expired dispatcher recovery into the document provider', async () => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const handled = vi.fn();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			await gateway.setInboundHandler(handled);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'original-runtime' });
			await harness.receive({ type: 'requestDocument', requestId: 'dispatcher-document-unissued' });
			expect(handled).not.toHaveBeenCalled();

			const readiness = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as { probeId: string };
			await vi.advanceTimersByTimeAsync(4_000);
			await expect(readiness).resolves.toBe(false);
			await harness.receive({ type: 'requestDocument', requestId: `dispatcher-document-${probe.probeId}` });
			expect(handled).not.toHaveBeenCalled();
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('withdraws only the canceled queued message and cleans its abort listener', async () => {
		const harness = createPanelHarness();
		const prepared = vi.fn(message => message);
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel, admitInbound: admitTestMessage, prepareOutbound: prepared,
		});
		const canceled = new AbortController();
		const retained = new AbortController();
		const remove = vi.spyOn(canceled.signal, 'removeEventListener');
		const first = gateway.postMessage({ type: 'canceled-queued' }, canceled.signal);
		const second = gateway.postMessage({ type: 'retained-queued' }, retained.signal);
		canceled.abort();
		await expect(first).resolves.toBe(false);
		expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		await expect(second).resolves.toBe(true);
		expect(harness.posted).toEqual([{ type: 'retained-queued' }]);
		retained.abort();
		gateway.dispose();
	});

	it.each(['invalidated', 'current', 'throwing'] as const)(
		'outbound currentness checks a %s capture at physical queue delivery', async state => {
			const harness = createPanelHarness();
			const held = Promise.withResolvers<boolean>();
			const headMessage = { type: 'physical-head' };
			const protectedMessage = { type: 'requestToolState', requestId: 'protected-tool' };
			const followingMessage = { type: 'following-control' };
			vi.mocked(harness.panel.webview.postMessage).mockImplementation((message: TestMessage) => {
				harness.posted.push(message);
				return message === headMessage ? held.promise : Promise.resolve(true);
			});
			const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
			const first = gateway.postMessage(headMessage);
			const ready = Promise.resolve(harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE }));
			try {
				expect(harness.posted).toEqual([headMessage]);
				let currentGeneration = 1;
				const capturedGeneration = currentGeneration;
				let throwOnCheck = false;
				const isCurrent = () => {
					if (throwOnCheck) throw new Error('Currentness unavailable');
					return currentGeneration === capturedGeneration;
				};
				const protectedDelivery = Reflect.apply(gateway.postMessage, gateway, [
					protectedMessage, undefined, isCurrent,
				]) as Promise<boolean>;
				if (state === 'invalidated') currentGeneration++;
				if (state === 'throwing') throwOnCheck = true;
				const following = gateway.postMessage(followingMessage);
				expect(harness.posted).toEqual([headMessage]);

				held.resolve(true);
				await ready;
				await expect(first).resolves.toBe(true);
				await expect(following).resolves.toBe(true);
				expect(harness.posted.filter(message => message === followingMessage)).toEqual([followingMessage]);
				await expect.soft(protectedDelivery).resolves.toBe(state === 'current');
				expect(harness.posted).toEqual(state === 'current'
					? [headMessage, protectedMessage, followingMessage]
					: [headMessage, followingMessage]);
			} finally {
				held.resolve(true);
				gateway.dispose();
			}
		},
	);

	it('outbound currentness rejects an immediately stale capture before physical delivery', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
			const delivery = Reflect.apply(gateway.postMessage, gateway, [
				{ type: 'requestToolState', requestId: 'immediately-stale-tool' }, undefined, () => false,
			]) as Promise<boolean>;
			await expect.soft(delivery).resolves.toBe(false);
			expect(harness.posted).toEqual([]);
		} finally {
			gateway.dispose();
		}
	});

	it('rejects pre-aborted and preparation-aborted sends before physical submission', async () => {
		const harness = createPanelHarness();
		const controller = new AbortController();
		const prepared = vi.fn(message => { controller.abort(); return message; });
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel, admitInbound: admitTestMessage, prepareOutbound: prepared,
		});
		await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE });
		await expect(gateway.postMessage({ type: 'preparing' }, controller.signal)).resolves.toBe(false);
		expect(prepared).toHaveBeenCalledOnce();
		await expect(gateway.postMessage({ type: 'already-aborted' }, controller.signal)).resolves.toBe(false);
		expect(prepared).toHaveBeenCalledOnce();
		expect(harness.posted).toEqual([]);
		gateway.dispose();
	});

	it('does not release the physical drain when a submitted message is aborted', async () => {
		const harness = createPanelHarness();
		let release!: (value: boolean) => void;
		const held = new Promise<boolean>(resolve => { release = resolve; });
		vi.mocked(harness.panel.webview.postMessage).mockImplementation((message: TestMessage) => {
			harness.posted.push(message);
			return message.type === 'physical-head' ? held : Promise.resolve(true);
		});
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		const controller = new AbortController();
		const first = gateway.postMessage({ type: 'physical-head' }, controller.signal);
		const ready = Promise.resolve(harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE }));
		const following = gateway.postMessage({ type: 'following-head' });
		let settled = false;
		void first.then(() => { settled = true; });
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(harness.posted).toEqual([{ type: 'physical-head' }]);
		release(true);
		await expect(first).resolves.toBe(true);
		await expect(following).resolves.toBe(true);
		await ready;
		gateway.dispose();
	});

	it('holds reactivation traffic until the current dispatcher answers a direct probe', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});
		await Promise.resolve(harness.receive({
			type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1',
		}));
		await expect(gateway.postMessage({ type: 'projection', sequence: 1 })).resolves.toBe(true);

		gateway.beginDispatcherRevalidation();
		const probe = harness.posted.at(-1) as TestMessage;
		expect(probe).toMatchObject({ type: 'mainWebviewDispatcherProbe' });
		expect(probe.probeId).toEqual(expect.any(String));
		const pending = gateway.postMessage({ type: 'projection', sequence: 2 });
		let settled = false;
		void pending.then(() => { settled = true; });
		await Promise.resolve();

		expect(harness.posted).toEqual([
			{ type: 'projection', sequence: 1 },
			probe,
		]);
		expect(settled).toBe(false);

		await Promise.resolve(harness.receive({
			type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
			runtimeId: 'runtime-1', probeId: 'stale-probe',
		}));
		await Promise.resolve();
		expect(settled).toBe(false);

		await Promise.resolve(harness.receive({
			type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
			runtimeId: 'runtime-1', probeId: probe.probeId,
		}));
		await expect(pending).resolves.toBe(true);
		expect(harness.posted).toEqual([
			{ type: 'projection', sequence: 1 },
			probe,
			{ type: 'projection', sequence: 2 },
		]);
	});

	it('retries the same dispatcher challenge when the first probe is lost during resume', async () => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel,
				admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100,
				dispatcherRevalidationRetryMs: 20,
			});
			await Promise.resolve(harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1',
			}));
			gateway.beginDispatcherRevalidation();
			const firstProbe = harness.posted.at(-1) as TestMessage;
			const pending = gateway.postMessage({ type: 'mutation', sequence: 1 });

			await vi.advanceTimersByTimeAsync(20);
			const retryProbe = harness.posted.at(-1) as TestMessage;
			expect(retryProbe).toEqual(firstProbe);
			expect(harness.posted.filter(message =>
				(message as TestMessage).type === 'mainWebviewDispatcherProbe')).toHaveLength(2);

			await Promise.resolve(harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
				runtimeId: 'runtime-1', probeId: retryProbe.probeId,
			}));
			await expect(pending).resolves.toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears the retry timer when probe delivery receives a synchronous acknowledgement', async () => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel,
				admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100,
				dispatcherRevalidationRetryMs: 20,
			});
			await Promise.resolve(harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1',
			}));
			const postMessage = vi.mocked(harness.panel.webview.postMessage);
			postMessage.mockImplementation(async (message: TestMessage) => {
				harness.posted.push(message);
				if (message.type === 'mainWebviewDispatcherProbe') {
					await Promise.resolve(harness.receive({
						type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
						runtimeId: 'runtime-1', probeId: message.probeId,
					}));
				}
				return true;
			});

			gateway.beginDispatcherRevalidation();
			await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
			await expect(gateway.postMessage({ type: 'mutation', sequence: 1 })).resolves.toBe(true);
			await vi.advanceTimersByTimeAsync(100);
			expect(harness.posted.filter(message =>
				(message as TestMessage).type === 'mainWebviewDispatcherProbe')).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears dispatcher probe retries and rejects queued traffic on disposal', async () => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel,
				admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100,
				dispatcherRevalidationRetryMs: 20,
			});
			await Promise.resolve(harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1',
			}));
			gateway.beginDispatcherRevalidation();
			const pending = gateway.postMessage({ type: 'mutation', sequence: 1 });

			harness.disposePanel();

			await expect(pending).resolves.toBe(false);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(100);
			expect(harness.posted.filter(message =>
				(message as TestMessage).type === 'mainWebviewDispatcherProbe')).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('requires the current challenge even from a runtime that started during revalidation', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});
		await Promise.resolve(harness.receive({
			type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-old',
		}));
		gateway.beginDispatcherRevalidation();
		const pending = gateway.postMessage({ type: 'projection', sequence: 1 });

		await Promise.resolve(harness.receive({
			type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-new',
		}));
		let settled = false;
		void pending.then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);

		const probe = harness.posted.find(message =>
			(message as TestMessage).type === 'mainWebviewDispatcherProbe') as TestMessage;
		await Promise.resolve(harness.receive({
			type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
			runtimeId: 'runtime-new', probeId: probe.probeId,
		}));

		await expect(pending).resolves.toBe(true);
		expect(harness.posted.at(-1)).toEqual({ type: 'projection', sequence: 1 });
	});

	it('rejects queued traffic when dispatcher revalidation expires', async () => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel,
				admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100,
			});
			await Promise.resolve(harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1',
			}));
			gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as TestMessage;
			const pending = gateway.postMessage({ type: 'mutation', sequence: 1 });

			await vi.advanceTimersByTimeAsync(100);

			await expect(pending).resolves.toBe(false);
			expect(harness.posted).not.toContainEqual({ type: 'mutation', sequence: 1 });
			await expect(gateway.postMessage({ type: 'mutation', sequence: 2 })).resolves.toBe(false);

			gateway.beginDispatcherRevalidation();
			const retryProbe = harness.posted.at(-1) as TestMessage;
			expect(retryProbe).toMatchObject({ type: 'mainWebviewDispatcherProbe' });
			expect(retryProbe.probeId).not.toBe(probe.probeId);
			await Promise.resolve(harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
				runtimeId: 'runtime-1', probeId: retryProbe.probeId,
			}));
			await expect(gateway.postMessage({ type: 'mutation', sequence: 3 })).resolves.toBe(true);
			expect(harness.posted).toContainEqual({ type: 'mutation', sequence: 3 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps an expired matching acknowledgement from reopening request admission', async () => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel, admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100, dispatcherRevalidationRetryMs: 20,
			});
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
			const expired = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as TestMessage;
			const mutation = gateway.postMessage({ type: 'mutation', sequence: 1 });
			await vi.advanceTimersByTimeAsync(100);
			await expect(expired).resolves.toBe(false);
			await expect(mutation).resolves.toBe(false);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId,
			});
			await expect(gateway.postMessage({ type: 'requestToolState', requestId: 'after-expired-ack' })).resolves.toBe(false);
			expect(harness.posted).not.toContainEqual({ type: 'mutation', sequence: 1 });
			expect(harness.posted).not.toContainEqual({ type: 'requestToolState', requestId: 'after-expired-ack' });
			gateway.dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([true, false])('bounds exact activation while its initial dispatcher is still starting (acknowledged=%s)', async acknowledged => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel, admitInbound: admitTestMessage,
				dispatcherColdStartTimeoutMs: 100,
				dispatcherRevalidationTimeoutMs: 100, dispatcherRevalidationRetryMs: 20,
			});
			const ready = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as TestMessage;
			expect(probe).toMatchObject({ type: 'mainWebviewDispatcherProbe', probeId: expect.any(String) });
			const snapshot = gateway.postMessage({ type: 'requestToolState', requestId: 'initial-activation' });
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'initial-runtime' });
			expect(harness.posted).not.toContainEqual({ type: 'requestToolState', requestId: 'initial-activation' });
			if (acknowledged) {
				await harness.receive({
					type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'initial-runtime', probeId: probe.probeId,
				});
			} else {
				await vi.advanceTimersByTimeAsync(100);
			}
			await expect(ready).resolves.toBe(acknowledged);
			await expect(snapshot).resolves.toBe(acknowledged);
			gateway.dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([true, false])('shares the current bounded revalidation result across activation callers (acknowledged=%s)', async acknowledged => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel,
				admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100,
				dispatcherRevalidationRetryMs: 20,
			});
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
			const first = gateway.beginDispatcherRevalidation();
			expect(first).toBeInstanceOf(Promise);
			const probe = harness.posted.at(-1) as TestMessage;
			await vi.advanceTimersByTimeAsync(95);
			const second = gateway.beginDispatcherRevalidation();
			expect(second).toBe(first);
			if (acknowledged) {
				await harness.receive({
					type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId,
				});
			} else {
				await vi.advanceTimersByTimeAsync(5);
			}
			await expect(first).resolves.toBe(acknowledged);
			await expect(second).resolves.toBe(acknowledged);
			expect(vi.getTimerCount()).toBe(0);
			gateway.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([true, false])('shares the original read deadline without retiring a ready same-runtime epoch (acknowledged=%s)', async acknowledged => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const handled = vi.fn();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			await gateway.setInboundHandler(handled);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
			const epoch = gateway.readinessIdentity;
			const first = gateway.waitForReadDispatcherReady();
			const probe = harness.posted.at(-1) as TestMessage;
			let settled = false;
			void first.then(() => { settled = true; });
			expect(gateway.isDispatcherReady).toBe(true);
			expect(gateway.readinessIdentity).toBe(epoch);
			await vi.advanceTimersByTimeAsync(249);
			expect(harness.posted).toEqual([probe]);
			await vi.advanceTimersByTimeAsync(1);
			expect(harness.posted).toEqual([probe, probe]);
			await vi.advanceTimersByTimeAsync(3_749);
			const second = gateway.waitForReadDispatcherReady();
			expect(second).toBe(first);
			expect(settled).toBe(false);
			if (acknowledged) {
				await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
			} else await vi.advanceTimersByTimeAsync(1);
			await expect(first).resolves.toBe(acknowledged);
			await expect(second).resolves.toBe(acknowledged);
			expect(gateway.isDispatcherReady).toBe(acknowledged);
			expect(gateway.readinessIdentity).toBe(epoch + (acknowledged ? 0 : 1));
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
			const recovery = { type: 'requestDocument', requestId: `dispatcher-document-${probe.probeId}` };
			await harness.receive(recovery);
			await harness.receive(recovery);
			expect(handled).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
			if (!acknowledged) await expect(gateway.postMessage({ type: 'mutation' })).resolves.toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it.each(['read then force', 'force then read'] as const)('keeps forced readiness revocation and the original shared deadline for %s', async order => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
			const epoch = gateway.readinessIdentity;
			const first = order === 'read then force' ? gateway.waitForReadDispatcherReady() : gateway.beginDispatcherRevalidation();
			await vi.advanceTimersByTimeAsync(3_999);
			const second = order === 'read then force' ? gateway.beginDispatcherRevalidation() : gateway.waitForReadDispatcherReady();
			expect(second).toBe(first);
			expect(gateway.isDispatcherReady).toBe(false);
			expect(gateway.readinessIdentity).toBe(epoch + 1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(first).resolves.toBe(false);
			await expect(second).resolves.toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('ignores stale scoped runtime acknowledgements during ready read validation', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
			const prior = gateway.beginDispatcherRevalidation();
			const priorProbe = harness.posted.at(-1) as TestMessage;
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: priorProbe.probeId });
			await expect(prior).resolves.toBe(true);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2' });
			const epoch = gateway.readinessIdentity;
			const current = gateway.waitForReadDispatcherReady();
			const currentProbe = harness.posted.at(-1) as TestMessage;
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: priorProbe.probeId });
			expect(gateway.readinessIdentity).toBe(epoch);
			expect(gateway.isDispatcherReady).toBe(true);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2', probeId: currentProbe.probeId });
			await expect(current).resolves.toBe(true);
			expect(gateway.readinessIdentity).toBe(epoch);
		} finally {
			gateway.dispose();
		}
	});

	it('fences prepared projections on an unscoped runtime replacement before a read challenge is answered', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		let release!: (fresh: boolean) => void;
		const preflight = new Promise<boolean>(resolve => { release = resolve; });
		const prepare = vi.fn(() => ({ message: { type: 'documentData' } }));
		try {
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' });
			const epoch = gateway.readinessIdentity;
			const projection = gateway.postDocumentProjection({ preflight: () => preflight, prepare });
			const readiness = gateway.waitForReadDispatcherReady();
			const probe = harness.posted.at(-1) as TestMessage;
			const following = gateway.postMessage({ type: 'following' });
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2' });
			expect(gateway.readinessIdentity).toBe(epoch + 1);
			expect(gateway.isDispatcherReady).toBe(false);
			await expect(projection).resolves.toBe(false);
			release(true);
			expect(prepare).not.toHaveBeenCalled();
			expect(harness.posted).not.toContainEqual({ type: 'following' });
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-2', probeId: probe.probeId });
			await expect(readiness).resolves.toBe(true);
			await expect(following).resolves.toBe(true);
			expect(prepare).not.toHaveBeenCalled();
		} finally {
			release(false);
			gateway.dispose();
		}
	});

	it('expires a read challenge without releasing a submitted physical head or replaying an unsent mutation', async () => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		let release!: (delivered: boolean) => void;
		const held = new Promise<boolean>(resolve => { release = resolve; });
		vi.mocked(harness.panel.webview.postMessage).mockImplementation((message: TestMessage) => {
			harness.posted.push(message);
			return message.type === 'physical-head' ? held : Promise.resolve(true);
		});
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			const controller = new AbortController();
			const physical = gateway.postMessage({ type: 'physical-head' }, controller.signal);
			const initialReady = Promise.resolve(harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1' }));
			let physicalSettled = false;
			void physical.then(() => { physicalSettled = true; });
			const readReady = gateway.waitForReadDispatcherReady();
			const probe = harness.posted.at(-1) as TestMessage;
			const mutation = gateway.postMessage({ type: 'mutation', sequence: 1 });
			controller.abort();
			await vi.advanceTimersByTimeAsync(4_000);
			await expect(readReady).resolves.toBe(false);
			await expect(mutation).resolves.toBe(false);
			expect(physicalSettled).toBe(false);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: probe.probeId });
			await expect(gateway.postMessage({ type: 'requestToolState', requestId: 'expired-read' })).resolves.toBe(false);
			const recovery = gateway.waitForReadDispatcherReady();
			const recoveryProbe = harness.posted.at(-1) as TestMessage;
			expect(recoveryProbe.probeId).not.toBe(probe.probeId);
			void harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-1', probeId: recoveryProbe.probeId });
			await expect(recovery).resolves.toBe(true);
			const current = gateway.postMessage({ type: 'requestToolState', requestId: 'current-read' });
			expect(physicalSettled).toBe(false);
			expect(harness.posted).not.toContainEqual({ type: 'requestToolState', requestId: 'current-read' });
			release(true);
			await expect(physical).resolves.toBe(true);
			await initialReady;
			await expect(current).resolves.toBe(true);
			expect(harness.posted).not.toContainEqual({ type: 'mutation', sequence: 1 });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release(false);
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('starts a fresh bounded challenge when a new runtime appears after expired revalidation', async () => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel,
				admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100,
				dispatcherRevalidationRetryMs: 20,
			});
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-old' });
			gateway.beginDispatcherRevalidation();
			const expiredProbe = harness.posted.at(-1) as TestMessage;
			const expiredMutation = gateway.postMessage({ type: 'mutation', sequence: 1 });
			await vi.advanceTimersByTimeAsync(100);
			await expect(expiredMutation).resolves.toBe(false);

			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-new' });
			const recoveryProbe = harness.posted.at(-1) as TestMessage;
			expect(recoveryProbe.type).toBe('mainWebviewDispatcherProbe');
			expect(recoveryProbe.probeId).not.toBe(expiredProbe.probeId);
			const snapshot = gateway.postMessage({ type: 'requestToolState', requestId: 'recovered-state' });
			let settled = false;
			void snapshot.then(() => { settled = true; });
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-old', probeId: expiredProbe.probeId,
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-new', probeId: recoveryProbe.probeId,
			});
			await expect(snapshot).resolves.toBe(true);
			expect(harness.posted).toContainEqual({ type: 'requestToolState', requestId: 'recovered-state' });
			expect(harness.posted).not.toContainEqual({ type: 'mutation', sequence: 1 });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not renew failed recovery from duplicate startup announcements', async () => {
		vi.useFakeTimers();
		try {
			const harness = createPanelHarness();
			const gateway = new MainWebviewStartupGateway<TestMessage>({
				panel: harness.panel,
				admitInbound: admitTestMessage,
				dispatcherRevalidationTimeoutMs: 100,
				dispatcherRevalidationRetryMs: 20,
			});
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-old' });
			gateway.beginDispatcherRevalidation();
			await vi.advanceTimersByTimeAsync(100);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-new' });
			const pending = gateway.postMessage({ type: 'mutation', sequence: 2 });
			await vi.advanceTimersByTimeAsync(90);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-new' });
			await vi.advanceTimersByTimeAsync(10);
			await expect(pending).resolves.toBe(false);
			const probeCount = harness.posted.length;
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-new' });
			expect(harness.posted).toHaveLength(probeCount);
			expect(vi.getTimerCount()).toBe(0);
			gateway.dispose();
		} finally {
			vi.useRealTimers();
		}
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

	it('routes an embedded tutorial acknowledgement during a blocked startup drain', async () => {
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
			if (message.type === 'request') {
				events.push('request:start');
				markFirstStarted();
				await firstGate;
				events.push('request:end');
				return;
			}
			const correlated = String(message.requestId || '').trim().length > 0;
			events.push(correlated ? 'embedded:ack' : 'embedded:queued-malformed');
			if (correlated) releaseFirst();
		});

		await firstStarted;
		await Promise.resolve(harness.receive({ type: 'embeddedTutorialViewerShown', requestId: '' }));
		expect(events).toEqual(['request:start']);
		await Promise.resolve(harness.receive({
			type: 'embeddedTutorialViewerShown', requestId: 'embedded-1',
		}));
		await drain;
		expect(events).toEqual([
			'request:start', 'embedded:ack', 'request:end', 'embedded:queued-malformed',
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

	it('admits nested persistence and SQL start acknowledgement during blocked startup', async () => {
		const harness = createPanelHarness();
		const events: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
			allowReentrantInbound: isMainWebviewCorrelatedReply,
		});
		void harness.receive({ type: 'request', sequence: 1 });
		const drain = gateway.setInboundHandler(async message => {
			if (message.type === 'request') {
				events.push('request:start');
				await firstGate;
				events.push('request:end');
				return;
			}
			events.push(message.type);
			if (message.type === 'copilotWriteQueryExecutionAck') releaseFirst();
		});

		await vi.waitFor(() => expect(events).toEqual(['request:start']));
		await Promise.resolve(harness.receive({
			type: 'persistDocument', snapshotId: ['snapshot-1'], sourceGeneration: '1',
			editRevision: '2', state: { sections: [] },
		}));
		await Promise.resolve(harness.receive({
			type: 'copilotWriteQueryExecutionAck', boxId: ['sql-1'],
			executionId: ['sql-execution-1'], accepted: true,
		}));
		await Promise.resolve(harness.receive(new Proxy({
			type: 'persistDocument', snapshotId: 'snapshot-proxy', sourceGeneration: 1,
			editRevision: 2, state: { sections: [] },
		}, {})));
		await Promise.resolve(harness.receive(new Proxy({
			type: 'copilotWriteQueryExecutionAck', boxId: 'sql-1',
			executionId: 'sql-execution-1', accepted: true,
		}, {})));
		expect(events).toEqual(['request:start']);
		await Promise.resolve(harness.receive({
			type: 'persistDocument', snapshotId: 'snapshot-1', sourceGeneration: 1,
			editRevision: 2, state: { sections: [] },
		}));
		await Promise.resolve(harness.receive({
			type: 'copilotWriteQueryExecutionAck', boxId: 'sql-1',
			executionId: 'sql-execution-1', accepted: true,
		}));
		await drain;

		expect(events).toEqual([
			'request:start', 'persistDocument', 'copilotWriteQueryExecutionAck', 'request:end',
		]);
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

	it('keeps first cold activation pending until an exact 5200 ms dispatcher acknowledgement', async () => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({
			panel: harness.panel,
			admitInbound: admitTestMessage,
		});
		try {
			const readiness = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as TestMessage;
			expect(probe).toMatchObject({ type: 'mainWebviewDispatcherProbe', probeId: expect.any(String) });
			const projection = { type: 'projection', sequence: 1 };
			const delivery = gateway.postMessage(projection);
			const settlements: boolean[] = [];
			void readiness.then(ready => { settlements.push(ready); });

			await vi.advanceTimersByTimeAsync(5_200);
			expect(settlements).toEqual([]);
			expect(harness.posted).not.toContainEqual(projection);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'cold-runtime' });
			expect(settlements).toEqual([]);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
				runtimeId: 'cold-runtime', probeId: probe.probeId,
			});

			await expect(readiness).resolves.toBe(true);
			await expect(delivery).resolves.toBe(true);
			expect(harness.posted.filter(message => (message as TestMessage).type === 'projection')).toEqual([projection]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('coalesces cold activation at 29999 ms and rejects expired queued work at 30000 ms', async () => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			const first = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as TestMessage;
			const mutation = { type: 'mutation', sequence: 1 };
			const delivery = gateway.postMessage(mutation);
			const settlements: boolean[] = [];
			void first.then(ready => { settlements.push(ready); });
			await vi.advanceTimersByTimeAsync(29_999);
			expect(settlements).toEqual([]);
			expect(gateway.beginDispatcherRevalidation()).toBe(first);
			expect(gateway.waitForDispatcherReady()).toBe(first);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'cold-replacement' });
			await vi.advanceTimersByTimeAsync(1);

			await expect(first).resolves.toBe(false);
			await expect(delivery).resolves.toBe(false);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
				runtimeId: 'cold-replacement', probeId: probe.probeId,
			});
			await expect(gateway.waitForDispatcherReady()).resolves.toBe(false);
			await expect(gateway.postMessage({ type: 'mutation', sequence: 2 })).resolves.toBe(false);
			expect(harness.posted).not.toContainEqual(mutation);
			expect(harness.posted.every(message => (message as TestMessage).probeId === probe.probeId)).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('keeps an unchallenged cold wait on its original deadline when activation joins', async () => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			const first = gateway.waitForDispatcherReady();
			expect(gateway.waitForDispatcherReady()).toBe(first);
			expect(harness.posted).toEqual([]);
			const settlements: boolean[] = [];
			void first.then(ready => { settlements.push(ready); });
			await vi.advanceTimersByTimeAsync(29_999);
			expect(settlements).toEqual([]);
			expect(gateway.beginDispatcherRevalidation()).toBe(first);
			const probe = harness.posted.at(-1) as TestMessage;
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'first-runtime' });
			expect(settlements).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			await expect(first).resolves.toBe(false);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
				runtimeId: 'first-runtime', probeId: probe.probeId,
			});
			await expect(gateway.waitForDispatcherReady()).resolves.toBe(false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('admits only an initial unprobed READY during an unchallenged cold wait', async () => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			const readiness = gateway.waitForDispatcherReady();
			const projection = { type: 'projection', sequence: 1 };
			const delivery = gateway.postMessage(projection);
			const settlements: boolean[] = [];
			void readiness.then(ready => { settlements.push(ready); });
			await vi.advanceTimersByTimeAsync(5_200);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'first-runtime', probeId: 'unsolicited-probe',
			});
			expect(settlements).toEqual([]);
			expect(harness.posted).toEqual([]);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'first-runtime' });
			await expect(readiness).resolves.toBe(true);
			await expect(delivery).resolves.toBe(true);
			await expect(gateway.waitForDispatcherReady()).resolves.toBe(true);
			expect(harness.posted).toEqual([projection]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it.each(['same-runtime', 'replacement-runtime'])('keeps established %s revalidation bounded at 3999 and 4000 ms', async runtimeId => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'same-runtime' });
			const readiness = gateway.beginDispatcherRevalidation();
			const probe = harness.posted.at(-1) as TestMessage;
			const mutation = { type: 'mutation', sequence: 1 };
			const delivery = gateway.postMessage(mutation);
			const settlements: boolean[] = [];
			void readiness.then(ready => { settlements.push(ready); });
			await vi.advanceTimersByTimeAsync(3_999);
			expect(settlements).toEqual([]);
			expect(gateway.beginDispatcherRevalidation()).toBe(readiness);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId });
			await vi.advanceTimersByTimeAsync(1);
			await expect(readiness).resolves.toBe(false);
			await expect(delivery).resolves.toBe(false);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId, probeId: probe.probeId });
			await expect(gateway.waitForDispatcherReady()).resolves.toBe(false);
			expect(harness.posted).not.toContainEqual(mutation);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it.each(['caller', 'replacement runtime'])('does not renew the consumed cold allowance for a later %s', async recovery => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			const cold = gateway.beginDispatcherRevalidation();
			const expiredProbe = harness.posted.at(-1) as TestMessage;
			const rejectedMutation = { type: 'mutation', sequence: 1 };
			const rejectedDelivery = gateway.postMessage(rejectedMutation);
			await vi.advanceTimersByTimeAsync(30_000);
			await expect(cold).resolves.toBe(false);
			await expect(rejectedDelivery).resolves.toBe(false);
			if (recovery === 'replacement runtime') {
				await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'replacement-runtime' });
			} else {
				gateway.beginDispatcherRevalidation();
			}
			const readiness = gateway.waitForDispatcherReady();
			const probe = harness.posted.at(-1) as TestMessage;
			expect(probe.probeId).not.toBe(expiredProbe.probeId);
			const settlements: boolean[] = [];
			void readiness.then(ready => { settlements.push(ready); });
			await vi.advanceTimersByTimeAsync(3_999);
			expect(settlements).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			await expect(readiness).resolves.toBe(false);
			await harness.receive({
				type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
				runtimeId: 'replacement-runtime', probeId: probe.probeId,
			});
			await expect(gateway.postMessage({ type: 'mutation', sequence: 2 })).resolves.toBe(false);
			expect(harness.posted).not.toContainEqual(rejectedMutation);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('settles cold readiness and queued work on disposal without late replay', async () => {
		vi.useFakeTimers();
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		try {
			const readiness = gateway.waitForDispatcherReady();
			const mutation = gateway.postMessage({ type: 'mutation', sequence: 1 });
			harness.disposePanel();
			await expect(readiness).resolves.toBe(false);
			await expect(mutation).resolves.toBe(false);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'late-runtime' });
			await expect(gateway.waitForDispatcherReady()).resolves.toBe(false);
			await expect(gateway.beginDispatcherRevalidation()).resolves.toBe(false);
			expect(harness.posted).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			gateway.dispose();
			vi.useRealTimers();
		}
	});

	it('handles READY control before an ordinary startup drain waiting for cold readiness', async () => {
		const harness = createPanelHarness();
		const gateway = new MainWebviewStartupGateway<TestMessage>({ panel: harness.panel, admitInbound: admitTestMessage });
		const events: number[] = [];
		try {
			void harness.receive({ type: 'request', sequence: 1 });
			void harness.receive({ type: 'request', sequence: 2 });
			const drain = gateway.setInboundHandler(async message => {
				if (message.sequence === 1) expect(await gateway.waitForDispatcherReady()).toBe(true);
				events.push(message.sequence ?? -1);
			});
			await Promise.resolve();
			expect(events).toEqual([]);
			await harness.receive({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'first-runtime' });
			await drain;
			expect(events).toEqual([1, 2]);
		} finally {
			gateway.dispose();
		}
	});
});
