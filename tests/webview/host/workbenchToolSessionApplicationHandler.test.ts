import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	HostWorkbenchToolSessionApplicationHandler,
	type WorkbenchToolSessionOrchestrator,
} from '../../../src/host/workbenchToolSessionApplicationHandler';
import type { KustoConnection } from '../../../src/host/connectionManager';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

type ConnectArgs = Parameters<WorkbenchToolSessionOrchestrator['connect']>;

function createHarness(options?: {
	connections?: KustoConnection[];
	isAvailable?: () => boolean;
	postMessage?: (message: unknown) => boolean | PromiseLike<boolean>;
}) {
	const postMessage = vi.fn(options?.postMessage ?? (() => true));
	const connect = vi.fn((..._args: ConnectArgs) => 73);
	const activateConnection = vi.fn();
	const disconnectIfOwner = vi.fn();
	const handleKustoExecutionStarted = vi.fn();
	const handleDevelopmentNoteMutationResponse = vi.fn(() => false);
	const handleWebviewResponse = vi.fn();
	const orchestrator = {
		connect,
		activateConnection,
		disconnectIfOwner,
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
		connectionManager: { getConnections: () => options?.connections ?? [] },
		schema: { refreshSchemaForTools },
		sqlLifecycle: {
			getConnectionId,
			getFirstConnectionId,
			getReadyToolOwner,
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

	it('connects once, reactivates its exact token, and supplies transport plus SQL callbacks', () => {
		const harness = createHarness();

		harness.handler.activate();

		expect(harness.connect).toHaveBeenCalledOnce();
		const [poster, _stateGetter, _schemaRefresher, documentUri, sqlConnectionResolver, sqlOwnerResolver]
			= getConnectArgs(harness.connect);
		expect(documentUri).toBe('file:///C:/workspace/exact.kqlx');
		const outbound = { type: 'exact-outbound' };
		expect(poster(outbound)).toBe(true);
		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage.mock.calls[0][0]).toBe(outbound);

		expect(sqlConnectionResolver?.('  sql-section-exact  ')).toBe('connection:sql-section-exact');
		expect(harness.getConnectionId).toHaveBeenCalledWith('sql-section-exact');
		expect(sqlConnectionResolver?.('   ')).toBe('connection:first');
		expect(sqlConnectionResolver?.()).toBe('connection:first');
		expect(harness.getFirstConnectionId).toHaveBeenCalledTimes(2);
		expect(sqlOwnerResolver?.('  sql-owner-section  ')).toBe(harness.readyOwner);
		expect(harness.getReadyToolOwner).toHaveBeenCalledWith('sql-owner-section');
		expect(sqlOwnerResolver?.('   ')).toBeUndefined();

		harness.handler.activate();

		expect(harness.connect).toHaveBeenCalledOnce();
		expect(harness.activateConnection).toHaveBeenCalledOnce();
		expect(harness.activateConnection).toHaveBeenCalledWith(73);
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
		await expect(defaultRequest).resolves.toBe(defaultSections);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledOnce();
		expect(harness.reconcileComparisonOwners.mock.calls[0][0]).toBe(defaultSections);

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
		await expect(targetedRequest).resolves.toBe(targetedSections);
		expect(harness.reconcileComparisonOwners).toHaveBeenCalledTimes(2);
		expect(harness.reconcileComparisonOwners.mock.calls[1][0]).toBe(targetedSections);
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
		await expect(second).resolves.toBe(secondSections);
		expect(firstSettled).toBe(false);

		await harness.handler.handleMessage({
			type: 'toolStateResponse', requestId: firstRequest.requestId, sections: firstSections,
		} satisfies IncomingWebviewMessage);
		await expect(first).resolves.toBe(firstSections);
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
		await expect(state).resolves.toBe(sections);
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
