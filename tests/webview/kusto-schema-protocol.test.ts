import { describe, expect, it } from 'vitest';

import {
	isKustoSchemaHostMessageType,
	isKustoSchemaWebviewMessageType,
	parseKustoSchemaHostMessage,
	parseKustoSchemaWebviewMessage,
} from '../../src/shared/kustoSchemaProtocol.js';

const schema = {
	tables: ['Events'],
	columnTypesByTable: { Events: { Timestamp: 'datetime' } },
	functions: [{ name: 'Latest', parameters: [{ name: 'count', type: 'long', defaultValue: 10 }] }],
	rawSchemaJson: { opaque: { future: true } },
};

const webviewMessages = [
	{
		type: 'prefetchSchema', connectionId: 'connection-1', database: 'Samples', boxId: 'query-1',
		forceRefresh: true, requestToken: 'schema-1', cacheOnly: false, silent: false, reason: 'refresh',
		sectionInstanceId: 'instance-1', targetGeneration: 2,
	},
	{
		type: 'requestCrossClusterSchema', clusterName: 'remote', database: 'Telemetry', boxId: 'query-1',
		requestToken: 'supplemental-1', requestSource: 'autocomplete', traceId: 'trace-1',
	},
] as const;

const hostMessages = [
	{
		type: 'schemaData', boxId: 'query-1', connectionId: 'connection-1', database: 'Samples',
		clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'account-1', requestToken: 'schema-1',
		sectionInstanceId: 'instance-1', targetGeneration: 2, schema,
		schemaMeta: { tablesCount: 1, columnsCount: 1, fromCache: true, cacheAgeMs: 10, refreshState: 'none' },
	},
	{
		type: 'schemaError', boxId: 'query-1', connectionId: 'connection-1', database: 'Samples',
		requestToken: 'schema-1', silent: true, isBackgroundRefresh: true, refreshState: 'failed',
		hasUsableFallback: true, error: 'refresh failed',
	},
	{
		type: 'crossClusterSchemaData', clusterName: 'remote', clusterUrl: 'https://remote.kusto.windows.net',
		connectionId: 'connection-2', accountPartition: 'account-2', database: 'Telemetry', boxId: 'query-1',
		requestToken: 'supplemental-1', requestSource: 'background', deliverySource: 'disk-cache-fresh',
		cacheAgeMs: 20, rawSchemaJson: schema.rawSchemaJson,
	},
	{
		type: 'crossClusterSchemaError', clusterName: 'remote', database: 'Telemetry', boxId: 'query-1',
		requestToken: 'supplemental-1', requestSource: 'background', failureKind: 'auth-required', error: 'sign in',
	},
] as const;

describe('Kusto schema protocol', () => {
	it('owns and parses the two webview request discriminators without cloning', () => {
		for (const message of webviewMessages) {
			expect(isKustoSchemaWebviewMessageType(message)).toBe(true);
			const parsed = parseKustoSchemaWebviewMessage(message);
			expect(parsed).toEqual({ ok: true, value: message });
			if (parsed.ok) expect(parsed.value).toBe(message);
		}
		expect(isKustoSchemaWebviewMessageType({ type: 'schemaData' })).toBe(false);
	});

	it('owns and parses the four host delivery discriminators without cloning opaque schema data', () => {
		for (const message of hostMessages) {
			expect(isKustoSchemaHostMessageType(message)).toBe(true);
			const parsed = parseKustoSchemaHostMessage(message);
			expect(parsed).toEqual({ ok: true, value: message });
			if (parsed.ok) expect(parsed.value).toBe(message);
		}
		const primary = parseKustoSchemaHostMessage(hostMessages[0]);
		const supplemental = parseKustoSchemaHostMessage(hostMessages[2]);
		if (!primary.ok || primary.value.type !== 'schemaData') throw new Error('Expected schemaData.');
		if (!supplemental.ok || supplemental.value.type !== 'crossClusterSchemaData') {
			throw new Error('Expected crossClusterSchemaData.');
		}
		expect(primary.value.schema.rawSchemaJson).toBe(schema.rawSchemaJson);
		expect(supplemental.value.rawSchemaJson).toBe(schema.rawSchemaJson);
		expect(isKustoSchemaHostMessageType({ type: 'prefetchSchema' })).toBe(false);
	});

	it('preserves partial legacy lifecycle identity while validating fields that are present', () => {
		const partial = { ...webviewMessages[0], targetGeneration: undefined };
		expect(parseKustoSchemaWebviewMessage(partial)).toEqual({ ok: true, value: partial });
		expect(parseKustoSchemaWebviewMessage({ ...partial, targetGeneration: '2' })).toMatchObject({ ok: false });
	});

	it('accepts finite negative cache ages produced by backward clock adjustments', () => {
		expect(parseKustoSchemaHostMessage({
			...hostMessages[0], schemaMeta: { ...hostMessages[0].schemaMeta, cacheAgeMs: -10 },
		})).toMatchObject({ ok: true });
		expect(parseKustoSchemaHostMessage({ ...hostMessages[2], cacheAgeMs: -10 })).toMatchObject({ ok: true });
	});

	it('preserves legacy string function entries accepted by current schema caches', () => {
		const functions = ['LegacyFunction'];
		const message = {
			...hostMessages[0],
			schema: { ...hostMessages[0].schema, functions },
		};
		const parsed = parseKustoSchemaHostMessage(message);

		expect(parsed).toEqual({ ok: true, value: message });
		if (!parsed.ok || parsed.value.type !== 'schemaData') throw new Error('Expected schemaData.');
		expect(parsed.value.schema.functions).toBe(functions);
	});

	it.each([
		{ ...webviewMessages[0], forceRefresh: 'yes' },
		{ ...webviewMessages[0], requestToken: 1 },
		{ ...webviewMessages[0], targetGeneration: -1 },
		{ ...webviewMessages[1], requestSource: 'manual' },
		{ ...webviewMessages[1], traceId: 1 },
	])('rejects malformed recognized webview requests: %o', message => {
		expect(isKustoSchemaWebviewMessageType(message)).toBe(true);
		expect(parseKustoSchemaWebviewMessage(message)).toMatchObject({ ok: false });
	});

	it.each([
		{ ...hostMessages[0], schema: { tables: 'Events', columnTypesByTable: {} } },
		{ ...hostMessages[0], schemaMeta: { cacheAgeMs: 'fresh' } },
		{ ...hostMessages[0], schemaMeta: { refreshState: ['completed'] } },
		{ ...hostMessages[0], schemaMeta: { deliveryKind: ['fresh'] } },
		{ ...hostMessages[0], schemaMeta: { cacheState: ['fresh'] } },
		{ ...hostMessages[0], schemaMeta: { cacheAgeMs: Number.POSITIVE_INFINITY } },
		{ ...hostMessages[0], targetGeneration: 1.5 },
		{ ...hostMessages[1], error: { message: 'failed' } },
		{ ...hostMessages[2], requestSource: 'manual' },
		{ ...hostMessages[2], cacheAgeMs: 'fresh' },
		{ ...hostMessages[2], cacheAgeMs: Number.NaN },
		{ ...hostMessages[2], rawSchemaJson: undefined },
		{ ...hostMessages[3], failureKind: 'timeout' },
	])('rejects malformed recognized host deliveries: %o', message => {
		expect(isKustoSchemaHostMessageType(message)).toBe(true);
		expect(parseKustoSchemaHostMessage(message)).toMatchObject({ ok: false });
	});

	it('rejects unknown discriminators and non-object traffic', () => {
		expect(parseKustoSchemaWebviewMessage({ type: 'schemaData' })).toMatchObject({ ok: false });
		expect(parseKustoSchemaHostMessage({ type: 'prefetchSchema' })).toMatchObject({ ok: false });
		expect(parseKustoSchemaWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseKustoSchemaHostMessage([])).toMatchObject({ ok: false });
	});
});
