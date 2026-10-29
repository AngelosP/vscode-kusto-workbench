import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	HostWorkbenchToolSessionApplicationHandler,
	type WorkbenchToolSessionOrchestrator,
} from '../../../src/host/workbenchToolSessionApplicationHandler';
import type { KustoConnection } from '../../../src/host/connectionManager';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import {
	MainWebviewStartupGateway,
	MAIN_WEBVIEW_DISPATCHER_READY_TYPE,
} from '../../../src/host/mainWebviewStartupGateway';

type ConnectArgs = Parameters<WorkbenchToolSessionOrchestrator['connect']>;

function createHarness(options?: {
	connections?: KustoConnection[];
	isAvailable?: () => boolean;
	postMessage?: (message: unknown, signal?: AbortSignal, isCurrent?: () => boolean) => boolean | PromiseLike<boolean>;
	activateConnection?: (token: number) => boolean;
	isConnectionCurrent?: (token: number) => boolean;
	closeLifecycle?: { inspectDirty(): Promise<boolean>; save(): Promise<void> };
	reactivate?: () => Promise<boolean>;
	waitForReadReady?: () => Promise<boolean>;
	captureStateAdmission?: () => (() => boolean);
	prepareKustoExecution?: ConnectArgs[11];
	prepareSqlExecution?: ConnectArgs[12];
}) {
	const postMessage = vi.fn(options?.postMessage ?? (() => true));
	const connect = vi.fn((..._args: ConnectArgs) => 73);
	const activateConnection = vi.fn(options?.activateConnection ?? (() => true));
	const disconnectIfOwner = vi.fn();
	const handleKustoExecutionStarted = vi.fn();
	const handleDevelopmentNoteMutationResponse = vi.fn(() => false);
	const handleWebviewResponse = vi.fn();
	const orchestrator = {
		connect,
		activateConnection,
		disconnectIfOwner,
		...(options?.isConnectionCurrent ? { isConnectionCurrent: options.isConnectionCurrent } : {}),
		handleKustoExecutionStarted,
		handleDevelopmentNoteMutationResponse,
		handleWebviewResponse,
	} satisfies WorkbenchToolSessionOrchestrator;
	const getConnectionId = vi.fn((sectionId: string) => `connection:${sectionId}`);
	const getFirstConnectionId = vi.fn(() => 'connection:first');
	const readyOwner = {
		connectionId: 'sql-connection-exact',
		database: 'SqlDatabaseExact',
		ownerToken: 'sql-owner-token-exact',
		generation: 9,
	};
	const getReadyToolOwner = vi.fn(() => readyOwner);
	const getSectionInstanceId = vi.fn<(sectionId: string) => string | undefined>(sectionId => `instance:${sectionId}`);
	const getGeneration = vi.fn(() => readyOwner.generation);
	const reconcileComparisonOwners = vi.fn();
	const schemaResult = {
		schemas: [{
			clusterUrl: 'https://target.kusto.windows.net',
			database: 'DatabaseExact',
			tables: ['TableExact'],
			functions: ['FunctionExact'],
		}],
	};
	const refreshSchemaForTools = vi.fn(async () => schemaResult);
	const handler = new HostWorkbenchToolSessionApplicationHandler({
		getOrchestrator: () => orchestrator,
		postMessage,
		isAvailable: options?.isAvailable ?? (() => true),
		getDocumentUri: () => 'file:///C:/workspace/exact.kqlx',
		getCloseLifecycle: () => options?.closeLifecycle,
		...(options?.reactivate ? { reactivate: options.reactivate } : {}),
		...(options?.waitForReadReady ? { waitForReadReady: options.waitForReadReady } : {}),
		...(options?.captureStateAdmission ? { captureStateAdmission: options.captureStateAdmission } : {}),
		...(options?.prepareKustoExecution ? { prepareKustoExecution: options.prepareKustoExecution } : {}),
		...(options?.prepareSqlExecution ? { prepareSqlExecution: options.prepareSqlExecution } : {}),
		connectionManager: { getConnections: () => options?.connections ?? [] },
		schema: { refreshSchemaForTools },
		sqlLifecycle: {
			getConnectionId,
			getFirstConnectionId,
			getReadyToolOwner,
			getSectionInstanceId,
			getGeneration,
			reconcileComparisonOwners,
		},
	});
	return {
		handler,
		orchestrator,
		postMessage,
		connect,
		activateConnection,
		disconnectIfOwner,
		handleKustoExecutionStarted,
		handleDevelopmentNoteMutationResponse,
		handleWebviewResponse,
		getConnectionId,
		getFirstConnectionId,
		getReadyToolOwner,
		getSectionInstanceId,
		getGeneration,
		reconcileComparisonOwners,
		refreshSchemaForTools,
		schemaResult,
		readyOwner,
	};
}

function getConnectArgs(connect: ReturnType<typeof vi.fn>): ConnectArgs {
	return connect.mock.calls[0] as ConnectArgs;
}

function getLastStateRequest(postMessage: ReturnType<typeof vi.fn>): {
	type: 'requestToolState';
	requestId: string;
	purpose?: 'schema-refresh';
	targetConnectionId?: string;
} {
	return postMessage.mock.calls.at(-1)?.[0] as {
		type: 'requestToolState';
		requestId: string;
		purpose?: 'schema-refresh';
		targetConnectionId?: string;
	};
}

describe('HostWorkbenchToolSessionApplicationHandler', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('connects once, reactivates its exact token, and supplies transport plus lifecycle callbacks', () => {
		const closeLifecycle = {
			inspectDirty: vi.fn(async () => false),
			save: vi.fn(async () => undefined),
		};
		const isCurrent = () => true;
		const captureStateAdmission = vi.fn(() => isCurrent);
		const harness = createHarness({ closeLifecycle, captureStateAdmission });

		harness.handler.activate();

		expect(harness.connect).toHaveBeenCalledOnce();
		const [poster, _stateGetter, _schemaRefresher, documentUri, sqlConnectionResolver, sqlOwnerResolver, connectedCloseLifecycle]
			= getConnectArgs(harness.connect);
		expect(documentUri).toBe('file:///C:/workspace/exact.kqlx');
		const outbound = { type: 'exact-outbound' };
		expect(poster(outbound)).toBe(true);
		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage.mock.calls[0][0]).toBe(outbound);
		expect(getConnectArgs(harness.connect)[10]).toBe(captureStateAdmission);
		expect(poster(outbound, undefined, isCurrent)).toBe(true);
		expect(harness.postMessage).toHaveBeenLastCalledWith(outbound, undefined, isCurrent);

		expect(sqlConnectionResolver?.('  sql-section-exact  ')).toBe('connection:sql-section-exact');
		expect(harness.getConnectionId).toHaveBeenCalledWith('sql-section-exact');
		expect(sqlConnectionResolver?.('   ')).toBe('connection:first');
		expect(sqlConnectionResolver?.()).toBe('connection:first');
		expect(harness.getFirstConnectionId).toHaveBeenCalledTimes(2);
		expect(sqlOwnerResolver?.('  sql-owner-section  ')).toBe(harness.readyOwner);
		expect(harness.getReadyToolOwner).toHaveBeenCalledWith('sql-owner-section');
		expect(sqlOwnerResolver?.('   ')).toBeUndefined();
		expect(connectedCloseLifecycle).toBe(closeLifecycle);

		harness.handler.activate();

		expect(harness.connect).toHaveBeenCalledOnce();
		expect(harness.activateConnection).toHaveBeenCalledOnce();
		expect(harness.activateConnection).toHaveBeenCalledWith(73);
	});

	it('forwards Kusto preparation lazily as the twelfth connection capability without shifting snapshot admission', async () => {
		const isCurrent = () => true;
		const onReady = vi.fn(async () => true);
		const prepareKustoExecution = vi.fn<NonNullable<ConnectArgs[11]>>(async callback => callback(isCurrent));
		const captureStateAdmission = vi.fn(() => () => true);
		const harness = createHarness({ prepareKustoExecution, captureStateAdmission });
		harness.handler.activate();
		harness.handler.activate();
		const args = getConnectArgs(harness.connect);
		expect(args[10]).toBe(captureStateAdmission);
		expect(args[11]).toBe(prepareKustoExecution);
		expect(prepareKustoExecution).not.toHaveBeenCalled();
		await expect(args[11]!(onReady)).resolves.toBe(true);
		expect(prepareKustoExecution).toHaveBeenCalledOnce();
		expect(prepareKustoExecution).toHaveBeenCalledWith(onReady);
		expect(onReady).toHaveBeenCalledExactlyOnceWith(isCurrent);
		harness.handler.dispose();
	});

	it('appends lazy SQL installation as the thirteenth capability without changing previous callbacks', async () => {
		const captureStateAdmission = vi.fn(() => () => true);
		const prepareKustoExecution = vi.fn<NonNullable<ConnectArgs[11]>>(async () => true);
		const prepareSqlExecution = vi.fn(async () => undefined);
		const harness = createHarness({ captureStateAdmission, prepareKustoExecution, prepareSqlExecution });
		harness.handler.activate();
		harness.handler.activate();
		const args = getConnectArgs(harness.connect);
		expect(args).toHaveLength(14);
		expect(args[10]).toBe(captureStateAdmission);
		expect(args[11]).toBe(prepareKustoExecution);
		expect(args[12]).toBe(prepareSqlExecution);
		expect(args[13]).toEqual(expect.any(Function));
		expect(prepareSqlExecution).not.toHaveBeenCalled();
		await expect(args[12]!()).resolves.toBeUndefined();
		expect(prepareSqlExecution).toHaveBeenCalledExactlyOnceWith();
		expect(prepareKustoExecution).not.toHaveBeenCalled();
		harness.handler.dispose();
	});

	it.each([0, 9, Number.MAX_SAFE_INTEGER])('captures SQL section admission at generation %s without a ready-owner dependency', generation => {
		const harness = createHarness();
		harness.getGeneration.mockReturnValue(generation);
		harness.handler.activate();
		expect(harness.getSectionInstanceId).not.toHaveBeenCalled();
		expect(harness.getGeneration).not.toHaveBeenCalled();
		const capture = getConnectArgs(harness.connect)[13]!;
		const isCurrent = capture('  sql-pending  ');
		expect(harness.getSectionInstanceId).toHaveBeenCalledExactlyOnceWith('sql-pending');
		expect(harness.getGeneration).toHaveBeenCalledExactlyOnceWith('sql-pending');
		expect(isCurrent()).toBe(true);
		expect(harness.getReadyToolOwner).not.toHaveBeenCalled();
		harness.getSectionInstanceId.mockReturnValue('replacement-instance');
		expect(isCurrent()).toBe(false);
		const replacementCurrent = capture('sql-pending');
		expect(replacementCurrent()).toBe(true);
		harness.getGeneration.mockReturnValue(generation === 0 ? 1 : 0);
		expect(replacementCurrent()).toBe(false);
		const beforeDisposal = capture('sql-pending');
		expect(beforeDisposal()).toBe(true);
		harness.handler.dispose();
		expect(beforeDisposal()).toBe(false);
	});

	it.each(['missing instance', 'empty instance', 'blank section', 'negative generation', 'fractional generation',
		'nonfinite generation', 'unsafe generation'])(
		'permanently rejects SQL section admission captured with %s', invalid => {
		const harness = createHarness();
		if (invalid === 'missing instance') harness.getSectionInstanceId.mockReturnValue(undefined);
		if (invalid === 'empty instance') harness.getSectionInstanceId.mockReturnValue('');
		if (invalid === 'negative generation') harness.getGeneration.mockReturnValue(-1);
		if (invalid === 'fractional generation') harness.getGeneration.mockReturnValue(0.5);
		if (invalid === 'nonfinite generation') harness.getGeneration.mockReturnValue(Number.NaN);
		if (invalid === 'unsafe generation') harness.getGeneration.mockReturnValue(Number.MAX_SAFE_INTEGER + 1);
		harness.handler.activate();
		const capture = getConnectArgs(harness.connect)[13]!;
		const isCurrent = capture(invalid === 'blank section' ? '   ' : 'sql-pending');
		expect(isCurrent()).toBe(false);
		harness.getSectionInstanceId.mockReturnValue('later-instance');
		harness.getGeneration.mockReturnValue(0);
		expect(isCurrent()).toBe(false);
		expect(harness.getSectionInstanceId).toHaveBeenCalledTimes(1);
		expect(harness.getGeneration).toHaveBeenCalledTimes(1);
		expect(capture('sql-pending')()).toBe(true);
		harness.handler.dispose();
	});

	it('supplies exact-panel recovery to explicit activation without starting it during visibility activation', async () => {
		const reactivate = vi.fn(async () => false);
		const harness = createHarness({ reactivate });
		harness.handler.activate();
		harness.handler.activate();
		expect(reactivate).not.toHaveBeenCalled();
		const connectedRecovery = (getConnectArgs(harness.connect) as any)[8];
		expect(connectedRecovery).toBe(reactivate);
		await expect(connectedRecovery()).resolves.toBe(false);
		expect(reactivate).toHaveBeenCalledOnce();
		harness.handler.dispose();
	});

	it('reconnects when reactivation finds that its cached bridge token was lost', () => {
		const harness = createHarness({ activateConnection: () => false });

		harness.handler.activate();
		harness.handler.activate();

		expect(harness.activateConnection).toHaveBeenCalledOnce();
		expect(harness.activateConnection).toHaveBeenCalledWith(73);
		expect(harness.connect).toHaveBeenCalledTimes(2);
		expect(harness.disconnectIfOwner).toHaveBeenCalledWith(73);
	});

	it('publishes exact state requests, correlates responses, and reconciles SQL owners', async () => {
		const harness = createHarness();
		harness.handler.activate();
		const [, stateGetter] = getConnectArgs(harness.connect);

		const defaultRequest = stateGetter();
		const defaultMessage = getLastStateRequest(harness.postMessage);
		expect(defaultMessage).toEqual({
			type: 'requestToolState',
			requestId: defaultMessage.requestId,
		});
		expect(defaultMessage.requestId).toMatch(/^state_\d+_[a-z0-9]+$/);
		const defaultSections = [{ id: 'default-section-exact', type: 'query' }];
		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: defaultMessage.requestId,
			sections: defaultSections,
		} satisfies IncomingWebviewMessage);
		const resolvedDefaultSections = await defaultRequest;
		expect(resolvedDefaultSections).toEqual(defaultSections);
		expect(resolvedDefaultSections).not.toBe(defaultSections);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledOnce();
		expect(harness.reconcileComparisonOwners.mock.calls[0][0]).toBe(resolvedDefaultSections);

		const targetedRequest = harness.handler.requestSectionsFromWebview(
			'schema-refresh',
			'connection-target-exact',
		);
		const targetedMessage = getLastStateRequest(harness.postMessage);
		expect(targetedMessage).toEqual({
			type: 'requestToolState',
			requestId: targetedMessage.requestId,
			purpose: 'schema-refresh',
			targetConnectionId: 'connection-target-exact',
		});
		const targetedSections: unknown[] = [];
		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: targetedMessage.requestId,
			sections: targetedSections,
		} satisfies IncomingWebviewMessage);
		const resolvedTargetedSections = await targetedRequest;
		expect(resolvedTargetedSections).toEqual(targetedSections);
		expect(resolvedTargetedSections).not.toBe(targetedSections);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledTimes(2);
		expect(harness.reconcileComparisonOwners.mock.calls[1][0]).toBe(resolvedTargetedSections);
	});

	it('keeps the exact state waiter live after a matching malformed response', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const pending = harness.handler.requestSectionsFromWebview();
		const request = getLastStateRequest(harness.postMessage);
		let settled = false;
		void pending.finally(() => { settled = true; });

		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: request.requestId,
			sections: {},
		} as unknown as IncomingWebviewMessage);
		await vi.advanceTimersByTimeAsync(4999);

		expect(settled).toBe(false);
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();

		const sections = [{ id: 'canonical-section', type: 'query' }];
		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: request.requestId,
			sections,
		} satisfies IncomingWebviewMessage);

		const resolvedSections = await pending;
		expect(resolvedSections).toEqual(sections);
		expect(resolvedSections).not.toBe(sections);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledOnce();
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledWith(resolvedSections);
	});

	it('keeps the exact state waiter live after an oversized matching response', async () => {
		vi.useFakeTimers();
		const harness = createHarness();
		const pending = harness.handler.requestSectionsFromWebview();
		const request = getLastStateRequest(harness.postMessage);
		let settled = false;
		void pending.finally(() => { settled = true; });
		const oversizedValues = Array.from({ length: 10_001 }, (_, index) => index);

		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: request.requestId,
			sections: [{ type: 'query', id: 'oversized-section', oversizedValues }],
		} as unknown as IncomingWebviewMessage);
		await vi.advanceTimersByTimeAsync(4999);

		expect(settled).toBe(false);
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();

		const sections = [{ id: 'canonical-after-oversized', type: 'query' }];
		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: request.requestId, sections,
		} satisfies IncomingWebviewMessage);

		await expect(pending).resolves.toEqual(sections);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledOnce();
	});

	it('correlates concurrent state requests through reversed, unmatched, and late responses', async () => {
		const harness = createHarness();
		const first = harness.handler.requestSectionsFromWebview();
		const firstRequest = getLastStateRequest(harness.postMessage);
		const second = harness.handler.requestSectionsFromWebview('schema-refresh', 'connection-second');
		const secondRequest = getLastStateRequest(harness.postMessage);
		const firstSections = [{ id: 'first-section', type: 'query' }];
		const secondSections = [{ id: 'second-section', type: 'query' }];
		let firstSettled = false;
		void first.finally(() => { firstSettled = true; });

		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: 'unmatched-request',
			sections: [{ id: 'unmatched-section', type: 'query' }],
		} satisfies IncomingWebviewMessage);
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();

		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: secondRequest.requestId, sections: secondSections,
		} satisfies IncomingWebviewMessage);
		await expect(second).resolves.toEqual(secondSections);
		expect(firstSettled).toBe(false);

		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: firstRequest.requestId, sections: firstSections,
		} satisfies IncomingWebviewMessage);
		await expect(first).resolves.toEqual(firstSections);
		expect(harness.reconcileComparisonOwners.mock.calls.map(call => call[0]))
			.toEqual([secondSections, firstSections]);

		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: secondRequest.requestId,
			sections: [{ id: 'late-section', type: 'query' }],
		} satisfies IncomingWebviewMessage);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledTimes(2);
	});

	it('settles state timeout, response error, unavailable, and publication failure as undefined', async () => {
		vi.useFakeTimers();
		const harness = createHarness();

		const timedOut = harness.handler.requestSectionsFromWebview();
		let timeoutSettled = false;
		void timedOut.finally(() => { timeoutSettled = true; });
		await vi.advanceTimersByTimeAsync(4999);
		expect(timeoutSettled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(timedOut).resolves.toBeUndefined();

		const failedByResponse = harness.handler.requestSectionsFromWebview();
		const failedRequest = getLastStateRequest(harness.postMessage);
		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: failedRequest.requestId,
			sections: [{ id: 'must-not-apply', type: 'query' }],
			error: 'state unavailable',
		} satisfies IncomingWebviewMessage);
		await expect(failedByResponse).resolves.toBeUndefined();
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();

		const unavailable = createHarness({ isAvailable: () => false });
		await expect(unavailable.handler.requestSectionsFromWebview()).resolves.toBeUndefined();
		expect(unavailable.postMessage).not.toHaveBeenCalled();

		const rejected = createHarness({ postMessage: () => Promise.reject(new Error('transport failed')) });
		await expect(rejected.handler.requestSectionsFromWebview()).resolves.toBeUndefined();
	});

	it('never dispatches an expired snapshot after the cold dispatcher becomes ready', async () => {
		vi.useFakeTimers();
		let receive: ((message: unknown) => unknown) | undefined;
		const posted = vi.fn(() => Promise.resolve(true));
		const gateway = new MainWebviewStartupGateway<IncomingWebviewMessage>({
			panel: {
				webview: {
					postMessage: posted,
					onDidReceiveMessage: (handler: (message: unknown) => unknown) => {
						receive = handler;
						return { dispose() {} };
					},
				},
				onDidDispose: () => ({ dispose() {} }),
			} as never,
			admitInbound: input => input as IncomingWebviewMessage,
		});
		const harness = createHarness({ postMessage: (message, signal) => gateway.postMessage(message, signal) });
		try {
			const readiness = gateway.waitForDispatcherReady();
			const pending = harness.handler.requestSectionsFromWebview('schema-refresh', 'connection-expired');
			const expiredRequest = getLastStateRequest(harness.postMessage);
			let settled = false;
			void pending.then(() => { settled = true; });

			await vi.advanceTimersByTimeAsync(4_999);
			expect(settled).toBe(false);
			expect(posted).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toBeUndefined();
			expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();

			await receive?.({ type: MAIN_WEBVIEW_DISPATCHER_READY_TYPE, runtimeId: 'runtime-after-timeout' });
			await expect(readiness).resolves.toBe(true);
			expect(posted).not.toHaveBeenCalledWith(expiredRequest);
			expect(posted).not.toHaveBeenCalled();

			const fresh = harness.handler.requestSectionsFromWebview();
			const freshRequest = getLastStateRequest(harness.postMessage);
			expect(posted).toHaveBeenCalledExactlyOnceWith(freshRequest);
			await harness.handler.handleMessage({
				type: 'toolStateResponse', requestId: freshRequest.requestId,
				sections: [{ id: 'current-section', type: 'query' }],
			});
			await expect(fresh).resolves.toEqual([{ id: 'current-section', type: 'query' }]);
			expect(harness.reconcileComparisonOwners).toHaveBeenCalledOnce();
		} finally {
			harness.handler.dispose();
			gateway.dispose();
		}
	});

	it('retires prior snapshot authority before reconnecting its registered token', async () => {
		const harness = createHarness({ activateConnection: () => false });
		harness.handler.activate();
		const pending = harness.handler.requestSectionsFromWebview();
		const request = getLastStateRequest(harness.postMessage);

		harness.handler.activate();
		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: request.requestId,
			sections: [{ id: 'retired-owner', type: 'sql' }],
		});

		await expect(pending).resolves.toBeUndefined();
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
		expect(harness.connect).toHaveBeenCalledTimes(2);
		expect(harness.disconnectIfOwner).toHaveBeenCalledWith(73);
		harness.handler.dispose();
	});

	it('rejects an unavailable snapshot owner before SQL reconciliation', async () => {
		let available = true;
		const harness = createHarness({ isAvailable: () => available });
		const pending = harness.handler.requestSectionsFromWebview();
		const request = getLastStateRequest(harness.postMessage);
		available = false;

		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: request.requestId,
			sections: [{ id: 'unavailable-owner', type: 'sql' }],
		});

		await expect(pending).resolves.toBeUndefined();
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
		harness.handler.dispose();
	});

	it('waits for read readiness before starting the unchanged snapshot deadline', async () => {
		vi.useFakeTimers();
		let ready!: (value: boolean) => void;
		const readiness = new Promise<boolean>(resolve => { ready = resolve; });
		const waitForReadReady = vi.fn(() => readiness);
		const harness = createHarness({ waitForReadReady });
		const pending = harness.handler.requestSectionsFromWebview();
		try {
			await vi.advanceTimersByTimeAsync(5_200);
			expect(waitForReadReady).toHaveBeenCalledOnce();
			expect(harness.postMessage).not.toHaveBeenCalled();
			ready(true);
			await vi.advanceTimersByTimeAsync(0);
			const request = getLastStateRequest(harness.postMessage);
			expect(request).toBeTruthy();
			await vi.advanceTimersByTimeAsync(4_999);
			expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
			await harness.handler.handleMessage({ type: 'toolStateResponse', requestId: request.requestId, sections: [] });
			await expect(pending).resolves.toEqual([]);
			expect(harness.reconcileComparisonOwners).toHaveBeenCalledExactlyOnceWith([]);
		} finally {
			ready(false);
			harness.handler.dispose();
		}
	});

	it('checks captured runtime and projection admission before SQL effects', async () => {
		let epoch = 1;
		const harness = createHarness({ captureStateAdmission: () => {
			const captured = epoch;
			return () => epoch === captured;
		} });
		const pending = harness.handler.requestSectionsFromWebview();
		const request = getLastStateRequest(harness.postMessage);
		epoch++;
		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: request.requestId, sections: [{ type: 'sql', id: 'old-runtime' }],
		});
		await expect(pending).resolves.toBeUndefined();
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
		harness.handler.dispose();
	});

	it('rejects a registry-retired snapshot without requiring handler reactivation', async () => {
		let registered = true;
		const isConnectionCurrent = vi.fn(() => registered);
		const harness = createHarness({ isConnectionCurrent });
		harness.handler.activate();
		const pending = harness.handler.requestSectionsFromWebview();
		const request = getLastStateRequest(harness.postMessage);
		const signal = harness.postMessage.mock.calls[0][1];
		registered = false;

		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: request.requestId, sections: [{ type: 'sql', id: 'registry-retired' }],
		});

		await expect(pending).resolves.toBeUndefined();
		expect(isConnectionCurrent).toHaveBeenCalledWith(73);
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
		expect(signal?.aborted).toBe(true);
		harness.handler.dispose();
	});

	it('filters schema refresh targets by query kind and exact Kusto connection resolution', async () => {
		const targetConnection: KustoConnection = {
			id: 'connection-target',
			name: 'Target',
			clusterUrl: 'https://target.kusto.windows.net',
			authorityId: 'organizations',
		};
		const otherConnection: KustoConnection = {
			id: 'connection-other',
			name: 'Other',
			clusterUrl: 'https://target.kusto.windows.net',
			authorityId: 'consumers',
		};
		const harness = createHarness({ connections: [targetConnection, otherConnection] });
		harness.handler.activate();
		const [, , schemaRefresher] = getConnectArgs(harness.connect);

		const refresh = schemaRefresher(targetConnection.clusterUrl, targetConnection.id);
		const stateRequest = getLastStateRequest(harness.postMessage);
		expect(stateRequest).toEqual({
			type: 'requestToolState',
			requestId: stateRequest.requestId,
			purpose: 'schema-refresh',
			targetConnectionId: targetConnection.id,
		});
		const sections = [
			{
				id: 'query-exact',
				type: 'query',
				connectionId: targetConnection.id,
				clusterUrl: targetConnection.clusterUrl,
				database: 'DatabaseExact',
				schemaRequestToken: 'schema-token-exact',
				sectionInstanceId: 'section-instance-exact',
				targetGeneration: 11,
			},
			{
				id: 'query-legacy-exact',
				type: 'copilotQuery',
				clusterUrl: targetConnection.clusterUrl,
				authorityId: targetConnection.authorityId,
				connectionIdHint: targetConnection.id,
				database: 'LegacyDatabaseExact',
			},
			{
				id: 'query-wrong-runtime-owner',
				type: 'query',
				connectionId: otherConnection.id,
				clusterUrl: otherConnection.clusterUrl,
				database: 'WrongDatabase',
			},
			{
				id: 'query-mismatched-cluster',
				type: 'query',
				connectionId: targetConnection.id,
				clusterUrl: 'https://different.kusto.windows.net',
				database: 'WrongClusterDatabase',
			},
			{ id: 'markdown-ignored', type: 'markdown', database: 'Ignored' },
			{ id: 'query-missing-database', type: 'query', connectionId: targetConnection.id },
		];
		await harness.handler.handleMessage({
			type: 'toolStateResponse',
			requestId: stateRequest.requestId,
			sections,
		} satisfies IncomingWebviewMessage);

		await expect(refresh).resolves.toBe(harness.schemaResult);
		expect(harness.refreshSchemaForTools).toHaveBeenCalledOnce();
		expect(harness.refreshSchemaForTools).toHaveBeenCalledWith(
			targetConnection.clusterUrl,
			targetConnection.id,
			[
				{
					boxId: 'query-exact',
					database: 'DatabaseExact',
					requestToken: 'schema-token-exact',
					sectionInstanceId: 'section-instance-exact',
					targetGeneration: 11,
				},
				{
					boxId: 'query-legacy-exact',
					database: 'LegacyDatabaseExact',
					requestToken: undefined,
				},
			],
		);
	});

	it('routes all three exact messages and declines unrelated traffic synchronously', async () => {
		const harness = createHarness();
		const owner = {
			engine: 'kusto',
			boxId: 'tool-box-exact',
			sectionInstanceId: 'tool-section-exact',
			targetGeneration: 4,
			executionId: 'tool-execution-exact',
			connectionId: 'tool-connection-exact',
			database: 'ToolDatabaseExact',
			producer: 'tool',
		} as const;
		const result = { success: true };
		const unrelated = { type: 'showInfo', message: 'unrelated' } satisfies IncomingWebviewMessage;
		const mutationResponse = {
			type: 'toolResponse', requestId: 'tool-development-note-exact', result: { success: true },
		} satisfies IncomingWebviewMessage;

		expect(harness.handler.handleMessage(unrelated)).toBeUndefined();
		expect(harness.handler.handleDevelopmentNoteMutationResponse(mutationResponse)).toBe(false);
		expect(harness.handleDevelopmentNoteMutationResponse).toHaveBeenCalledOnce();
		expect(harness.handleDevelopmentNoteMutationResponse).toHaveBeenCalledWith(mutationResponse);
		await harness.handler.handleMessage({
			type: 'toolExecutionStarted', requestId: 'tool-start-exact', owner,
		} satisfies IncomingWebviewMessage);
		expect(harness.handleKustoExecutionStarted).toHaveBeenCalledOnce();
		expect(harness.handleKustoExecutionStarted).toHaveBeenCalledWith('tool-start-exact', owner);

		const response = {
			type: 'toolResponse', requestId: 'tool-response-exact', result, error: 'tool-error-exact',
		} satisfies IncomingWebviewMessage;
		await harness.handler.handleMessage(response);
		expect(harness.handleWebviewResponse).toHaveBeenCalledOnce();
		expect(harness.handleWebviewResponse).toHaveBeenCalledWith(
			'tool-response-exact', result, 'tool-error-exact',
		);

		const state = harness.handler.requestSectionsFromWebview();
		const stateRequest = getLastStateRequest(harness.postMessage);
		const sections = [{ id: 'route-state-exact', type: 'query' }];
		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: stateRequest.requestId, sections,
		} satisfies IncomingWebviewMessage);
		await expect(state).resolves.toEqual(sections);
	});

	it('settles pending state, disconnects once, and suppresses later work on disposal', async () => {
		const harness = createHarness();
		harness.handler.activate();
		const pending = harness.handler.requestSectionsFromWebview();
		const request = getLastStateRequest(harness.postMessage);

		harness.handler.dispose();
		harness.handler.dispose();

		await expect(pending).resolves.toBeUndefined();
		expect(harness.disconnectIfOwner).toHaveBeenCalledOnce();
		expect(harness.disconnectIfOwner).toHaveBeenCalledWith(73);
		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
		expect(harness.activateConnection).not.toHaveBeenCalled();

		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: request.requestId,
			sections: [{ id: 'late-state', type: 'query' }],
		} satisfies IncomingWebviewMessage);
		await harness.handler.handleMessage({
			type: 'toolResponse', requestId: 'late-tool', result: { success: true },
		} satisfies IncomingWebviewMessage);
		await expect(harness.handler.requestSectionsFromWebview()).resolves.toBeUndefined();
		harness.handler.activate();

		expect(harness.reconcileComparisonOwners).not.toHaveBeenCalled();
		expect(harness.handleWebviewResponse).not.toHaveBeenCalled();
		expect(harness.connect).toHaveBeenCalledOnce();
		expect(harness.activateConnection).not.toHaveBeenCalled();
	});
});
