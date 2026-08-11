import { describe, expect, it, vi } from 'vitest';

import { HostKustoSchemaRequestApplicationHandler } from '../../../src/host/kustoSchemaRequestApplicationHandler';
import type { SchemaService } from '../../../src/host/queryEditorSchema';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
	return { promise, resolve };
}

function createSchema() {
	return {
		prefetchSchema: vi.fn(async () => undefined),
		handleCrossClusterSchemaRequest: vi.fn(async () => undefined),
	};
}

function createHandler(schema = createSchema()) {
	const handler = new HostKustoSchemaRequestApplicationHandler({
		schema: schema as unknown as Pick<SchemaService,
			'prefetchSchema' | 'handleCrossClusterSchemaRequest'>,
	});
	return { handler, schema };
}

function prefetchMessage(overrides: Partial<Extract<IncomingWebviewMessage, { type: 'prefetchSchema' }>> = {}) {
	return {
		type: 'prefetchSchema',
		connectionId: 'connection-exact',
		database: 'ExactDb',
		boxId: 'query-box-exact',
		requestToken: 'request-token-exact',
		...overrides,
	} satisfies IncomingWebviewMessage;
}

function crossClusterMessage() {
	return {
		type: 'requestCrossClusterSchema',
		clusterName: 'https://exact.kusto.windows.net',
		database: 'SupplementalDb',
		boxId: 'query-box-exact',
		requestToken: 'cross-request-exact',
		requestSource: 'autocomplete',
		traceId: 'trace-exact',
	} as const satisfies IncomingWebviewMessage;
}

describe('HostKustoSchemaRequestApplicationHandler', () => {
	it('declines unrelated traffic synchronously without schema effects', () => {
		const { handler, schema } = createHandler();

		expect(handler.handleMessage({ type: 'showInfo', message: 'unrelated' })).toBeUndefined();
		expect(schema.prefetchSchema).not.toHaveBeenCalled();
		expect(schema.handleCrossClusterSchemaRequest).not.toHaveBeenCalled();
	});

	it.each([
		{ ...prefetchMessage(), forceRefresh: 'yes' },
		{ ...prefetchMessage(), targetGeneration: '17' },
		{ ...crossClusterMessage(), requestSource: 'manual' },
	])('claims and drops malformed recognized requests before schema effects: %o', async message => {
		const { handler, schema } = createHandler();

		await expect(handler.handleMessage(message as unknown as IncomingWebviewMessage)).resolves.toBeUndefined();

		expect(schema.prefetchSchema).not.toHaveBeenCalled();
		expect(schema.handleCrossClusterSchemaRequest).not.toHaveBeenCalled();
	});

	it('shapes prefetch flags and includes only a complete lifecycle identity', async () => {
		const { handler, schema } = createHandler();
		const complete = prefetchMessage({
			forceRefresh: true,
			cacheOnly: true,
			silent: true,
			reason: 'explicit-refresh',
			sectionInstanceId: 'section-instance-exact',
			targetGeneration: 17,
		});
		const partial = prefetchMessage({
			requestToken: undefined,
			sectionInstanceId: 'partial-section-instance',
		});

		await expect(handler.handleMessage(complete)).resolves.toBeUndefined();
		await expect(handler.handleMessage(partial)).resolves.toBeUndefined();

		expect(schema.prefetchSchema).toHaveBeenNthCalledWith(
			1,
			'connection-exact',
			'ExactDb',
			'query-box-exact',
			true,
			'request-token-exact',
			{ cacheOnly: true, silent: true, reason: 'explicit-refresh' },
			{ sectionInstanceId: 'section-instance-exact', targetGeneration: 17 },
		);
		expect(schema.prefetchSchema).toHaveBeenNthCalledWith(
			2,
			'connection-exact',
			'ExactDb',
			'query-box-exact',
			false,
			undefined,
			{ cacheOnly: false, silent: false, reason: undefined },
			undefined,
		);
	});

	it('forwards every cross-cluster field exactly', async () => {
		const { handler, schema } = createHandler();
		const message = crossClusterMessage();

		await expect(handler.handleMessage(message)).resolves.toBeUndefined();

		expect(schema.handleCrossClusterSchemaRequest).toHaveBeenCalledWith(
			message.clusterName,
			message.database,
			message.boxId,
			message.requestToken,
			message.requestSource,
			message.traceId,
		);
		expect(schema.prefetchSchema).not.toHaveBeenCalled();
	});

	it('propagates the exact schema rejection', async () => {
		const schema = createSchema();
		const failure = new Error('Kusto schema request failed');
		schema.prefetchSchema.mockRejectedValueOnce(failure);
		const { handler } = createHandler(schema);

		await expect(handler.handleMessage(prefetchMessage())).rejects.toBe(failure);
	});

	it('preserves accepted settlement across disposal and suppresses later recognized requests', async () => {
		const schema = createSchema();
		const settlement = deferred<void>();
		schema.handleCrossClusterSchemaRequest.mockImplementationOnce(() => settlement.promise);
		const { handler } = createHandler(schema);
		const activeRequest = handler.handleMessage(crossClusterMessage());

		handler.dispose();
		handler.dispose();
		await expect(handler.handleMessage(prefetchMessage())).resolves.toBeUndefined();
		await expect(handler.handleMessage(crossClusterMessage())).resolves.toBeUndefined();

		expect(schema.prefetchSchema).not.toHaveBeenCalled();
		expect(schema.handleCrossClusterSchemaRequest).toHaveBeenCalledOnce();

		settlement.resolve();
		await expect(activeRequest).resolves.toBeUndefined();
	});
});
