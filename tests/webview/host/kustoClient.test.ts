import { describe, it, expect, vi } from 'vitest';
import { KustoQueryClient, QueryCancelledError, QueryExecutionError, parseKustoTimespan, normalizeClusterEndpoint } from '../../../src/host/kustoClient';
import type { KustoConnection } from '../../../src/host/connectionManager';

const TEST_CONNECTION: KustoConnection = {
	id: 'conn-1',
	name: 'Test cluster',
	clusterUrl: 'https://example.kusto.windows.net',
};

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function createKustoResult(clientActivityId: string = 'KW.execute_query;server') {
	return {
		primaryResults: [{
			columns: [{ name: 'x', type: 'long' }],
			rows: function* rows() {
				yield { x: 42 };
			},
		}],
		statusTable: {
			_rows: [{}],
			rows: function* rows() {
				yield { ClientRequestId: clientActivityId };
			},
		},
	};
}

function createCancelableClientHarness() {
	const kustoClient = new KustoQueryClient();
	const fakeSdkClient = {
		execute: vi.fn(async () => createKustoResult()),
		close: vi.fn(),
	};
	const createRequestProperties = vi.fn(async (activityPrefix: string, _clientTimeoutMs?: number, clientRequestId?: string) => ({
		clientRequestId: clientRequestId || `KW.${activityPrefix};generated`,
		application: 'KustoWorkbench',
		setClientTimeout: vi.fn(),
	}));
	const getOrCreateCancelableClient = vi.fn(async () => fakeSdkClient);
	const executeWithAuthRetry = vi.fn(async (_connection: KustoConnection, operation: (client: any) => Promise<unknown>) => operation(fakeSdkClient));
	const cancelQueryByClientActivityId = vi.fn(async () => undefined);
	(kustoClient as any).createRequestProperties = createRequestProperties;
	(kustoClient as any).getOrCreateCancelableClient = getOrCreateCancelableClient;
	(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;
	(kustoClient as any).cancelQueryByClientActivityId = cancelQueryByClientActivityId;
	return { kustoClient, fakeSdkClient, createRequestProperties, getOrCreateCancelableClient, executeWithAuthRetry, cancelQueryByClientActivityId };
}

// ── parseKustoTimespan ────────────────────────────────────────────────────────

describe('parseKustoTimespan', () => {
	it('parses standard hh:mm:ss format', () => {
		expect(parseKustoTimespan('00:00:01')).toBe(1000);
	});

	it('parses hh:mm:ss.fraction format', () => {
		expect(parseKustoTimespan('00:00:01.5000000')).toBe(1500);
	});

	it('parses hours and minutes', () => {
		expect(parseKustoTimespan('01:30:00')).toBe(5400000); // 1h30m = 5400s
	});

	it('parses days.hh:mm:ss format', () => {
		expect(parseKustoTimespan('1.00:00:00')).toBe(86400000); // 1 day
	});

	it('parses days.hh:mm:ss.fraction format', () => {
		expect(parseKustoTimespan('2.12:30:45.5')).toBe(
			(2 * 86400 + 12 * 3600 + 30 * 60 + 45.5) * 1000
		);
	});

	it('parses fractional seconds with many digits', () => {
		expect(parseKustoTimespan('00:00:00.1406250')).toBeCloseTo(140.625, 1);
	});

	it('parses zero timespan', () => {
		expect(parseKustoTimespan('00:00:00')).toBe(0);
	});

	it('parses zero with fraction', () => {
		expect(parseKustoTimespan('00:00:00.0000000')).toBe(0);
	});

	it('returns undefined for undefined input', () => {
		expect(parseKustoTimespan(undefined)).toBeUndefined();
	});

	it('returns undefined for empty string', () => {
		expect(parseKustoTimespan('')).toBeUndefined();
	});

	it('returns undefined for non-string input', () => {
		expect(parseKustoTimespan(42 as any)).toBeUndefined();
	});

	it('returns undefined for malformed string', () => {
		expect(parseKustoTimespan('not-a-timespan')).toBeUndefined();
	});

	it('returns undefined for partial format', () => {
		expect(parseKustoTimespan('12:34')).toBeUndefined();
	});

	it('handles large day values', () => {
		expect(parseKustoTimespan('365.00:00:00')).toBe(365 * 86400000);
	});

	it('handles typical CPU time from Kusto response', () => {
		// Real-world example: "00:00:00.1406250"
		const ms = parseKustoTimespan('00:00:00.1406250');
		expect(ms).toBeDefined();
		expect(ms!).toBeCloseTo(140.625, 1);
	});
});

// ── normalizeClusterEndpoint ──────────────────────────────────────────────────

describe('normalizeClusterEndpoint', () => {
	it('normalizes full URL with scheme', () => {
		expect(normalizeClusterEndpoint('https://mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('adds https:// to bare hostname', () => {
		expect(normalizeClusterEndpoint('mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('expands short name without .kusto. domain', () => {
		expect(normalizeClusterEndpoint('help'))
			.toBe('https://help.kusto.windows.net');
	});

	it('expands regional short name', () => {
		expect(normalizeClusterEndpoint('mycluster.westus'))
			.toBe('https://mycluster.westus.kusto.windows.net');
	});

	it('preserves http:// scheme', () => {
		const result = normalizeClusterEndpoint('http://mycluster.kusto.windows.net');
		expect(result).toBe('http://mycluster.kusto.windows.net');
	});

	it('strips trailing slashes', () => {
		const result = normalizeClusterEndpoint('https://mycluster.kusto.windows.net/');
		// URL normalization removes trailing path
		expect(result).toBe('https://mycluster.kusto.windows.net');
	});

	it('strips leading slashes from bare hostname', () => {
		expect(normalizeClusterEndpoint('///help'))
			.toBe('https://help.kusto.windows.net');
	});

	it('trims whitespace', () => {
		expect(normalizeClusterEndpoint('  help  '))
			.toBe('https://help.kusto.windows.net');
	});

	it('returns empty string for empty input', () => {
		expect(normalizeClusterEndpoint('')).toBe('');
	});

	it('returns empty string for null-ish input', () => {
		expect(normalizeClusterEndpoint(null as any)).toBe('');
		expect(normalizeClusterEndpoint(undefined as any)).toBe('');
	});

	it('does not expand URLs that already contain .kusto.', () => {
		expect(normalizeClusterEndpoint('https://myspecial.kusto.data.microsoft.com'))
			.toBe('https://myspecial.kusto.data.microsoft.com');
	});

	it('handles https://help correctly', () => {
		expect(normalizeClusterEndpoint('https://help'))
			.toBe('https://help.kusto.windows.net');
	});

	it('handles real cluster URL with port', () => {
		// Ports are stripped by URL normalization (standard https port)
		const result = normalizeClusterEndpoint('https://mycluster.kusto.windows.net:443');
		expect(result).toBe('https://mycluster.kusto.windows.net');
	});
});

// ── executeQueryCancelable ───────────────────────────────────────────────────

describe('executeQueryCancelable', () => {
	it('returns a precomputed client activity id and uses it for the Kusto request', async () => {
		const { kustoClient, createRequestProperties } = createCancelableClientHarness();

		const handle = kustoClient.executeQueryCancelable(TEST_CONNECTION, 'Samples', 'print x=42', 'box::conn');
		const result = await handle.promise;

		expect(handle.clientActivityId).toMatch(/^KW\.execute_query;[0-9a-f-]{36}$/i);
		expect(createRequestProperties).toHaveBeenCalledWith('execute_query', undefined, handle.clientActivityId);
		expect(result.metadata.clientActivityId).toBe('KW.execute_query;server');
		expect(result.rows[0][0]).toEqual({ display: '42', full: '42' });
	});

	it('cancels before client acquisition without executing or issuing server cancel', async () => {
		const { kustoClient, fakeSdkClient, getOrCreateCancelableClient, cancelQueryByClientActivityId } = createCancelableClientHarness();
		const clientDeferred = deferred<any>();
		getOrCreateCancelableClient.mockReturnValueOnce(clientDeferred.promise);

		const handle = kustoClient.executeQueryCancelable(TEST_CONNECTION, 'Samples', 'print x=42', 'box::conn');
		const rejection = expect(handle.promise).rejects.toBeInstanceOf(QueryCancelledError);

		handle.cancel();
		await rejection;

		clientDeferred.resolve(fakeSdkClient);
		await flushPromises();
		expect(fakeSdkClient.execute).not.toHaveBeenCalled();
		expect(fakeSdkClient.close).toHaveBeenCalledTimes(1);
		expect(cancelQueryByClientActivityId).not.toHaveBeenCalled();
	});

	it('cancels during request property creation without submitting the query', async () => {
		const { kustoClient, fakeSdkClient, createRequestProperties, executeWithAuthRetry, cancelQueryByClientActivityId } = createCancelableClientHarness();
		const propsDeferred = deferred<any>();
		createRequestProperties.mockReturnValueOnce(propsDeferred.promise);

		const handle = kustoClient.executeQueryCancelable(TEST_CONNECTION, 'Samples', 'print x=42', 'box::conn');
		await flushPromises();

		const rejection = expect(handle.promise).rejects.toBeInstanceOf(QueryCancelledError);
		handle.cancel();
		propsDeferred.resolve({ clientRequestId: handle.clientActivityId });
		await rejection;
		await flushPromises();

		expect(executeWithAuthRetry).not.toHaveBeenCalled();
		expect(fakeSdkClient.execute).not.toHaveBeenCalled();
		expect(cancelQueryByClientActivityId).not.toHaveBeenCalled();
	});

	it('cancels while auth retry is preparing the client without submitting the query', async () => {
		const { kustoClient, fakeSdkClient, executeWithAuthRetry, cancelQueryByClientActivityId } = createCancelableClientHarness();
		const authRetryDeferred = deferred<void>();
		executeWithAuthRetry.mockImplementationOnce(async (_connection: KustoConnection, operation: (client: any) => Promise<unknown>) => {
			await authRetryDeferred.promise;
			return operation(fakeSdkClient);
		});

		const handle = kustoClient.executeQueryCancelable(TEST_CONNECTION, 'Samples', 'print x=42', 'box::conn');
		await flushPromises();
		expect(executeWithAuthRetry).toHaveBeenCalledTimes(1);

		const rejection = expect(handle.promise).rejects.toBeInstanceOf(QueryCancelledError);
		handle.cancel();
		await rejection;
		authRetryDeferred.resolve();
		await flushPromises();

		expect(fakeSdkClient.execute).not.toHaveBeenCalled();
		expect(cancelQueryByClientActivityId).not.toHaveBeenCalled();
	});

	it('cancels after submission immediately, closes the client, and issues one server cancel', async () => {
		const { kustoClient, fakeSdkClient, cancelQueryByClientActivityId } = createCancelableClientHarness();
		const executeDeferred = deferred<unknown>();
		fakeSdkClient.execute.mockReturnValueOnce(executeDeferred.promise as any);

		const handle = kustoClient.executeQueryCancelable(TEST_CONNECTION, 'Samples', 'range x from 1 to 1000000 step 1', 'box::conn');
		await flushPromises();
		expect(fakeSdkClient.execute).toHaveBeenCalledTimes(1);

		const rejection = expect(handle.promise).rejects.toBeInstanceOf(QueryCancelledError);
		handle.cancel();
		handle.cancel();
		await rejection;
		await flushPromises();

		expect(fakeSdkClient.close).toHaveBeenCalledTimes(1);
		expect(cancelQueryByClientActivityId).toHaveBeenCalledTimes(1);
		expect(cancelQueryByClientActivityId).toHaveBeenCalledWith(TEST_CONNECTION, 'Samples', handle.clientActivityId);
	});

	it('keeps local cancellation successful when server cancellation fails', async () => {
		const { kustoClient, fakeSdkClient, cancelQueryByClientActivityId } = createCancelableClientHarness();
		fakeSdkClient.execute.mockReturnValueOnce(deferred<unknown>().promise as any);
		cancelQueryByClientActivityId.mockRejectedValueOnce(new Error('server cancel unavailable'));

		const handle = kustoClient.executeQueryCancelable(TEST_CONNECTION, 'Samples', 'range x from 1 to 1000000 step 1', 'box::conn');
		await flushPromises();

		const rejection = expect(handle.promise).rejects.toBeInstanceOf(QueryCancelledError);
		handle.cancel();
		await rejection;
		await flushPromises();

		expect(cancelQueryByClientActivityId).toHaveBeenCalledTimes(1);
	});

	it('attaches the generated client activity id to non-cancel query errors', async () => {
		const { kustoClient, fakeSdkClient } = createCancelableClientHarness();
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* expected error path */ });
		fakeSdkClient.execute.mockRejectedValueOnce(new Error('boom'));

		try {
			const handle = kustoClient.executeQueryCancelable(TEST_CONNECTION, 'Samples', 'print x=42', 'box::conn');

			await handle.promise.then(
				() => { throw new Error('expected query to fail'); },
				(error) => {
					expect(error).toBeInstanceOf(QueryExecutionError);
					expect(error.clientActivityId).toBe(handle.clientActivityId);
					expect(error.message).toContain('boom');
				}
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('builds a non-interactive .cancel query command with escaped literals', async () => {
		const kustoClient = new KustoQueryClient();
		const createRequestProperties = vi.fn(async () => ({ clientRequestId: 'KW.cancel_query;1' }));
		const execute = vi.fn(async () => undefined);
		const executeWithAuthRetry = vi.fn(async (_connection: KustoConnection, operation: (client: any) => Promise<unknown>, _options?: unknown) => {
			return operation({ execute });
		});
		(kustoClient as any).createRequestProperties = createRequestProperties;
		(kustoClient as any).executeWithAuthRetry = executeWithAuthRetry;

		await (kustoClient as any).cancelQueryByClientActivityId(
			TEST_CONNECTION,
			'Samples',
			'KW.execute_query;abc"def',
			'User clicked "Cancel"'
		);

		expect(createRequestProperties).toHaveBeenCalledWith('cancel_query');
		expect(executeWithAuthRetry).toHaveBeenCalledWith(TEST_CONNECTION, expect.any(Function), { allowInteractive: false });
		expect(execute).toHaveBeenCalledWith(
			'Samples',
			'.cancel query "KW.execute_query;abc\\"def" with (reason = "User clicked \\"Cancel\\"")',
			{ clientRequestId: 'KW.cancel_query;1' }
		);
	});

	it('honors non-interactive auth during the first executeWithAuthRetry client acquisition', async () => {
		const kustoClient = new KustoQueryClient();
		const client = { execute: vi.fn(async () => 'ok') };
		const getOrCreateClient = vi.fn(async () => client);
		(kustoClient as any).getOrCreateClient = getOrCreateClient;

		const result = await (kustoClient as any).executeWithAuthRetry(
			TEST_CONNECTION,
			(c: typeof client) => c.execute(),
			{ allowInteractive: false }
		);

		expect(result).toBe('ok');
		expect(getOrCreateClient).toHaveBeenCalledWith(TEST_CONNECTION, { interactiveIfNeeded: false });
		expect(client.execute).toHaveBeenCalledTimes(1);
	});
});
